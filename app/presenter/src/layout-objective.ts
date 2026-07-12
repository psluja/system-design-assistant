import type { Pos, Rect } from './layout';
import { type PortLike, type NodeGeom, type GroupLike, routeDesignEdges, simplifyOrthogonal } from './edge-routing';
import {
  type LayoutDesign,
  type LayoutFlow,
  type Placement,
  ROW_PITCH,
  COLW,
  MERGE_TOL,
  adjacency,
  boxesOverlap,
  collinearOverlapLength,
  contentBounds,
  designPorts,
  dominantAnchors,
  groupRects,
  layoutFlows,
  nodeGeoms,
  parallelTrackGap,
  polylineHitsBox,
  polylineLength,
  polylinesCross,
  roleTier,
  sizeOf,
  type PortOffsets,
} from './layout-model';

// @algorithm Weighted multi-term layout objective (14 soft terms over routed geometry)
// @problem Rank candidate placements by a single reviewable aesthetic score — crossings, length,
//   alignment, symmetry, semantic tiers, and the R4 wire-separation/traceability terms — without a
//   straight-line lie.
// @approach Hard constraints reject outright; each soft term is normalized to [0,1] and the aggregate
//   is 1 - sum((w_k/W) * p_k) over ACTIVE terms only (subject-less terms score null, honestly
//   excluded); every geometry term is measured on the REAL routed polylines (the router is the
//   arbiter); alignment guidelines come from greedy gap-threshold clustering of sorted anchor values.
// @complexity Crossings O(s^2) pairwise over routed segments; alignment clustering O(n log n);
//   the score is dominated by routing the candidate first.
// @citations Aesthetic-criteria tradition of graph drawing (Purchase 1997; Sugiyama et al. 1981);
//   separation/traceability terms after Wybrow, Marriott & Stuckey, GD 2009 (libavoid).
// @invariants Deterministic; weights are the only place preference lives (LAYOUT_WEIGHTS); a hard
//   violation can never be outscored; N/A terms renormalize rather than counting as zero.
// @where-tested app/presenter/src/layout-objective.test.ts, app/presenter/src/layout-benchmark.test.ts

// THE IDEAL LAYOUT — the OBJECTIVE. A layout is chosen by maximising a score: hard
// constraints a candidate must satisfy to be legal at all (violate one ⇒ rejected, never merely penalised), then
// fourteen weighted soft terms whose renormalised sum is the aesthetic quality. Every soft term is normalised to
// [0,1] so the WEIGHTS are the only place preference lives — `LAYOUT_WEIGHTS`, the single reviewable constant the
// owner ratified. The first three terms are the ones a generic engine (dagre/ELK) also has; then SDA's SEMANTIC
// terms — the moat only a tool that kept the meaning can express (§1); then the R4 SEPARATION terms (overlap /
// spacing / merge) that make edge TRACEABILITY first-class, the owner's field-test requirement (see LAYOUT_WEIGHTS).
//
// THE ROUTER IS THE ARBITER. Every geometry term is measured on the REAL routed polylines the deterministic router
// (edge-routing.ts) produces — the exact wires that ship — never a straight-line estimate. A candidate is routed
// before it is scored; bends and crossings are read off `simplifyOrthogonal` corner counts and proper segment
// intersections on those routes (doc §3.4). Pure and deterministic.
//
// HONESTY (doc §2.3): a term with NO SUBJECT in this design scores N/A (`null`), never a false zero-perfect — a
// design with no groups does not get a free 0 on group compactness; its weight is renormalised away. The aggregate
// is `1 − Σ (wₖ/W)·pₖ` over the ACTIVE terms only, with `W` their weight mass.

/** The fourteen objective terms, in a fixed order (doc §2.2). The last three — overlap/spacing/merge — are the R4
 * SEPARATION terms (owner re-ratification): edge traceability, made first-class. */
export const LAYOUT_TERMS = [
  'crossings',
  'bends',
  'length',
  'alignment',
  'lane',
  'role',
  'symmetry',
  'group',
  'async',
  'area',
  'label',
  'overlap',
  'spacing',
  'merge',
] as const;
export type LayoutTerm = (typeof LAYOUT_TERMS)[number];

/**
 * THE WEIGHT VECTOR — the whole preference, in ONE place (doc §2.2). Because every term is normalised, all of "what
 * SDA finds beautiful" is these numbers; they sum to 1 and are tunable without touching the scorer.
 *
 * R4 OWNER RE-RATIFICATION (field test, HEAD 4e9152f). The owner tested the IDEAL layout against Tidy and
 * ruled it WORSE in practice: "packs tighter AND overlaps lines more, while his explicit aesthetic is: each line
 * traceable by eye from source almost to target; separate corridors; edges may converge only near the shared
 * destination port, AS LATE AS POSSIBLE." The R3 vector had NO edge-separation term, so the R2 compaction was free
 * to collapse corridors for tightness. This re-ratification makes TRACEABILITY out-weigh COMPACTNESS, as ordered:
 *   • three new separation terms carry real weight — overlap (0.12, HEAVY: two wires on one line is the cardinal
 *     sin), merge (0.06, edges must converge late), spacing (0.04, tracks keep a readable gap);
 *   • the traceability family (crossings 0.17 + alignment 0.14 + overlap 0.12 + bends 0.07 + merge 0.06 +
 *     spacing 0.04 = 0.60) now dwarfs the compactness family (length 0.06 + group 0.04 + area 0.03 = 0.13) — a
 *     tighter diagram never again buys a line-on-line overlap;
 *   • the semantic moat (lane/role/symmetry/async) is trimmed proportionally, not dropped — still 0.25 of the mass.
 */
export const LAYOUT_WEIGHTS: Readonly<Record<LayoutTerm, number>> = {
  crossings: 0.17,
  bends: 0.07,
  length: 0.06,
  alignment: 0.14,
  lane: 0.1,
  role: 0.07,
  symmetry: 0.06,
  group: 0.04,
  async: 0.02,
  area: 0.03,
  label: 0.02,
  overlap: 0.12,
  spacing: 0.04,
  merge: 0.06,
};

/** Each term's family, for the benchmark table: `generic` = a term dagre/ELK can also score; `semantic` = SDA's
 *  moat (only a tool that kept the meaning can score it); `layout` = a first-class geometric term (alignment,
 *  separation) or a compactness term (area/label) that is not a semantic differentiator. The separation terms are
 *  `layout`: every serious router (libavoid, ELK, yFiles) scores edge traceability, so it is not SDA's moat — but it
 *  is a FIRST-CLASS geometric quality the R3 objective simply lacked. */
export const TERM_KIND: Readonly<Record<LayoutTerm, 'generic' | 'semantic' | 'layout'>> = {
  crossings: 'generic',
  bends: 'generic',
  length: 'generic',
  alignment: 'layout',
  lane: 'semantic',
  role: 'semantic',
  symmetry: 'semantic',
  group: 'semantic',
  async: 'semantic',
  area: 'layout',
  label: 'layout',
  overlap: 'layout',
  spacing: 'layout',
  merge: 'layout',
};

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);
const ALIGN_EPS = 6; // px within which two node centres count as sharing a guideline (block alignment, §2.2)

// Separation tunables (traceability). MIN_TRACK_GAP = the minimum readable gap between two parallel wires sharing a
// corridor (yFiles' "minimum distance between two edge segments"); a smaller gap is a spacing violation. Anything
// within MERGE_TOL reads as one line (an overlap). CORRIDOR_WINDOW = how close two parallel runs must be to count as
// "sharing a corridor" at all (so a wire on the far side of the canvas is not spuriously a neighbour).
const MIN_TRACK_GAP = 10;
const CORRIDOR_WINDOW = 48;

// ── Per-DESIGN caches (R4d, the polish speed round) — pure functions of the design (and the ports instance) that
// layoutGeometry used to recompute for EVERY candidate the search scores (thousands per polish). Each cache stores
// the IDENTICAL value the plain call returns (same pure function, computed once), keyed by object identity in a
// WeakMap so entries die with the design — so results are byte-for-byte what the uncached pipeline produces, only
// sooner. (The R4d pipeline differential test compares the cached and uncached searches end-to-end.)
const flowsCache = new WeakMap<LayoutDesign, readonly LayoutFlow[]>();
const cachedFlows = (design: LayoutDesign): readonly LayoutFlow[] => {
  const hit = flowsCache.get(design);
  if (hit !== undefined) return hit;
  const flows = layoutFlows(design);
  flowsCache.set(design, flows);
  return flows;
};
const portsCache = new WeakMap<LayoutDesign, Map<string, PortLike[]>>();
const cachedPorts = (design: LayoutDesign): Map<string, PortLike[]> => {
  const hit = portsCache.get(design);
  if (hit !== undefined) return hit;
  const ports = designPorts(design); // manifest ports when declared (R5) — the geometry the canvas renders
  portsCache.set(design, ports);
  return ports;
};
const anchorsCache = new WeakMap<LayoutDesign, WeakMap<Map<string, PortLike[]>, ReadonlyMap<string, { readonly offset: number }>>>();
const cachedAnchors = (design: LayoutDesign, ports: Map<string, PortLike[]>): ReadonlyMap<string, { readonly offset: number }> => {
  const byPorts = anchorsCache.get(design) ?? anchorsCache.set(design, new WeakMap()).get(design)!;
  const hit = byPorts.get(ports);
  if (hit !== undefined) return hit;
  const anchors = dominantAnchors(design, undefined, ports);
  byPorts.set(ports, anchors);
  return anchors;
};

/** The geometry a layout is scored on — computed ONCE per candidate (routing is the expensive step) and shared by
 *  every term. Exposed so unit tests can build it from a hand placement and probe one term at a time. */
export interface LayoutGeometry {
  readonly design: LayoutDesign;
  readonly placement: Placement;
  readonly nodes: readonly NodeGeom[];
  readonly groups: readonly GroupLike[];
  readonly flows: readonly LayoutFlow[];
  /** Routed polyline per wire index (the router's real geometry, or a straight anchor line where it could not
   *  route — never silently dropped, so length/crossings still count that wire). */
  readonly routes: ReadonlyMap<number, readonly Pos[]>;
  readonly bounds: Rect;
  /** Node centre points (id → centre) — the lane/symmetry/role terms read centres, not corners. */
  readonly centers: ReadonlyMap<string, Pos>;
  /** Each node's DOMINANT connected-port anchor Y (id → the row its heaviest wire actually rides — layout-model
   *  `dominantAnchors`, the router's own port geometry). The alignment term clusters row guidelines on THESE
   *  (R5, port-centric alignment): edges anchor at port fractions of variable-height nodes, so centre/top-aligned
   *  rows still broke lines; anchors collinear is what the router draws as ONE straight segment. */
  readonly anchorYs: ReadonlyMap<string, number>;
}

/** Build the scored geometry for a placement: derive ports, route every wire (the arbiter), and precompute centres,
 *  group rects and flows. The single place routing happens, so every term reads the same real wires. `offsets` —
 *  the R5 assigned port positions — thread into the router's anchors when a caller measures the SHIPPED geometry
 *  (the benchmark's with-slide gates); the search itself scores at fractions (the slide is a post-pass on the
 *  winner, not a per-candidate variable). */
export function layoutGeometry(design: LayoutDesign, placement: Placement, ports?: Map<string, PortLike[]>, offsets?: PortOffsets): LayoutGeometry {
  const p = ports ?? cachedPorts(design);
  const nodes = nodeGeoms(design, placement, p, offsets);
  const groups = groupRects(design, placement);
  const routed = routeDesignEdges({ nodes, wires: design.wires.map((w) => ({ from: w.from, to: w.to })), groups });
  const routes = new Map<number, readonly Pos[]>();
  const centers = new Map<string, Pos>();
  const anchorOff = cachedAnchors(design, p); // heights from sizeOf — same as nodeGeoms above
  const anchorYs = new Map<string, number>();
  for (const node of design.nodes) {
    const at = placement[node.id];
    if (at === undefined) continue;
    const s = sizeOf(node);
    centers.set(node.id, { x: at.x + s.w / 2, y: at.y + s.h / 2 });
    anchorYs.set(node.id, at.y + anchorOff.get(node.id)!.offset);
  }
  design.wires.forEach((w, i) => {
    const r = routed.get(i);
    if (r !== undefined) {
      routes.set(i, r.points);
      return;
    }
    // Router found no clear path ⇒ score the straight centre-to-centre line rather than drop the wire (never lie).
    const a = centers.get(w.from[0]);
    const b = centers.get(w.to[0]);
    if (a !== undefined && b !== undefined) routes.set(i, [a, b]);
  });
  return { design, placement, nodes, groups, flows: cachedFlows(design), routes, bounds: contentBounds(design, placement), centers, anchorYs };
}

// ── Hard constraints (doc §2.1) — booleans; a candidate that violates one is discarded before scoring ───────────

/** A hard-constraint violation, named so a caller can report WHY a candidate is infeasible. */
export interface HardViolation {
  readonly constraint: 'H1' | 'H2' | 'H4';
  readonly detail: string;
}

/**
 * The BOX-ONLY hard constraints — H2 (no node overlap) and H4 (group containment) — which read node boxes and group
 * rects alone, NEVER a route. Split out (R4d) so the optimiser can reject a candidate that violates them BEFORE
 * paying the routing bill: any hard violation makes a candidate infeasible regardless of the others, so a positive
 * box verdict is already the final verdict. ONE implementation, composed verbatim into {@link hardViolations}
 * (H2 then H4, identical order and detail strings), so the cheap gate and the full check can never drift.
 */
export function boxViolations(nodes: readonly NodeGeom[], groups: readonly GroupLike[]): HardViolation[] {
  const out: HardViolation[] = [];
  // H2 — no two node boxes overlap (inflated by clearance).
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      if (boxesOverlap(a.box, b.box, 2)) out.push({ constraint: 'H2', detail: `${a.id} overlaps ${b.id}` });
    }
  }
  // H4 — a node that is NOT a member of a group must not sit inside its box (a small inset avoids boundary noise).
  for (const g of groups) {
    const members = new Set(g.members);
    const inset: Rect = { x: g.rect.x + 4, y: g.rect.y + 4, w: Math.max(0, g.rect.w - 8), h: Math.max(0, g.rect.h - 8) };
    for (const n of nodes) {
      if (members.has(n.id)) continue;
      if (boxesOverlap(n.box, inset, 0)) out.push({ constraint: 'H4', detail: `${n.id} intrudes group ${g.id}` });
    }
  }
  return out;
}

/**
 * The hard constraints that guarantee the optimiser can never win the score by cheating geometry (doc §2.1):
 *  • H1 — no wire routes through a NON-endpoint node (the property the router guarantees + the CQRS regression pins);
 *  • H2 — no node overlap (pairwise AABB inflated by the router's clearance);
 *  • H4 — group containment: no NON-member node sits inside a group's derived box.
 * (H3 minimum-spacings is enforced by grid quantisation upstream; H5 pins are enforced by the optimiser removing
 * pinned nodes from the free set — neither is a geometric post-check.) Returns [] when the candidate is legal.
 */
export function hardViolations(geo: LayoutGeometry): HardViolation[] {
  const out: HardViolation[] = [];
  // H1 — a routed wire must not cut through a box that is neither its source nor its target.
  geo.design.wires.forEach((w, i) => {
    const pts = geo.routes.get(i);
    if (pts === undefined) return;
    for (const n of geo.nodes) {
      if (n.id === w.from[0] || n.id === w.to[0]) continue;
      if (polylineHitsBox(pts, n.box)) {
        out.push({ constraint: 'H1', detail: `wire ${w.from[0]}→${w.to[0]} cuts ${n.id}` });
        return;
      }
    }
  });
  out.push(...boxViolations(geo.nodes, geo.groups));
  return out;
}

// ── The eleven soft terms (doc §2.2) — each maps geometry to a penalty p ∈ [0,1] (0 = perfect), or null = inert ──

/** crossings (generic) — routed wire–wire crossing PAIRS over the pair bound X⃗ = E(E−1)/2. Counted on the real
 *  routed polylines, not straight-line estimates. Inert with fewer than 2 wires (no pair can cross). */
export function crossingsPenalty(geo: LayoutGeometry): number | null {
  const idx = [...geo.routes.keys()];
  const e = geo.design.wires.length;
  const bound = (e * (e - 1)) / 2;
  if (bound <= 0) return null;
  let crossing = 0;
  for (let i = 0; i < idx.length; i++) {
    for (let j = i + 1; j < idx.length; j++) {
      const a = geo.routes.get(idx[i]!)!;
      const b = geo.routes.get(idx[j]!)!;
      if (polylinesCross(a, b)) crossing++;
    }
  }
  return clamp01(crossing / bound);
}

/** bends (generic) — total 90° corners over a per-wire budget b·E (b = 4), read off the routed geometry's corner
 *  count (`simplifyOrthogonal`). Inert with no wires. */
export function bendsPenalty(geo: LayoutGeometry): number | null {
  const e = geo.design.wires.length;
  if (e === 0) return null;
  let bends = 0;
  for (const pts of geo.routes.values()) bends += Math.max(0, simplifyOrthogonal(pts).length - 2);
  return clamp01(bends / (4 * e));
}

/** wire length (generic) — total routed arc length over E × the canvas diagonal D (a wire longer than the whole
 *  canvas is the worst case). Inert with no wires. */
export function lengthPenalty(geo: LayoutGeometry): number | null {
  const e = geo.design.wires.length;
  if (e === 0) return null;
  const d = Math.hypot(geo.bounds.w, geo.bounds.h);
  if (d <= 0) return null;
  let total = 0;
  for (const pts of geo.routes.values()) total += polylineLength(pts);
  return clamp01(total / (e * d));
}

/** Greedy clusters of a sorted value list: a new cluster starts where the gap exceeds ε. Returns each value's
 *  cluster size, keyed back to the input index. */
function clusterSizes(values: readonly number[]): number[] {
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const size = new Array<number>(values.length).fill(1);
  let start = 0;
  for (let k = 1; k <= idx.length; k++) {
    if (k === idx.length || idx[k]!.v - idx[k - 1]!.v > ALIGN_EPS) {
      const n = k - start;
      for (let m = start; m < k; m++) size[idx[m]!.i] = n;
      start = k;
    }
  }
  return size;
}

/** block alignment (first-class) — the fraction of nodes NOT snapped (within ε) to a shared guideline used by ≥2
 *  nodes: a vertical guideline through the node CENTRE (column alignment; ports do not move x), or a horizontal
 *  guideline through the node's DOMINANT PORT ANCHOR (`geo.anchorYs`). RE-MEASURED on PORT anchors (R5, owner
 *  nuance): the term used to cluster row guidelines on node geometry (centres), but edges anchor at PORT fractions
 *  of variable-height nodes, so a "row-aligned" pair could still route as a Z — anchors on one line are what the
 *  router draws as ONE straight segment, so THAT is what earns the reward. For single-port nodes anchor = centre,
 *  so this changes nothing there. The R4 re-ratified weight vector is untouched — only the measurement moved.
 *  Inert with <2 nodes. */
export function alignmentPenalty(geo: LayoutGeometry): number | null {
  const ids = [...geo.centers.keys()];
  const n = ids.length;
  if (n < 2) return null;
  const xSize = clusterSizes(ids.map((id) => geo.centers.get(id)!.x));
  const ySize = clusterSizes(ids.map((id) => geo.anchorYs.get(id)!));
  let aligned = 0;
  for (let i = 0; i < n; i++) if ((xSize[i] ?? 1) >= 2 || (ySize[i] ?? 1) >= 2) aligned++;
  return clamp01(1 - aligned / n);
}

const yRange = (geo: LayoutGeometry, ids: readonly string[]): { lo: number; hi: number } | null => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const id of ids) {
    const c = geo.centers.get(id);
    if (c === undefined) continue;
    lo = Math.min(lo, c.y);
    hi = Math.max(hi, c.y);
  }
  return lo === Infinity ? null : { lo, hi };
};

/** lane coherence (semantic) — per flow, the vertical spread of its members beyond a clean single lane, PLUS a
 *  penalty when two flows of different kind share a Y-band. Each flow wants to be one clean horizontal lane. Inert
 *  when there are no flows with a wire to lay out. */
export function lanePenalty(geo: LayoutGeometry): number | null {
  const flows = geo.flows;
  if (flows.length === 0) return null;
  const cy = (id: string): number | undefined => geo.centers.get(id)?.y;
  // Spread part: within each flow, how far its internal wires depart from horizontal (a lane is Δy ≈ 0).
  const perFlow: number[] = [];
  for (const f of flows) {
    const inFlow = new Set(f.ids);
    const dys: number[] = [];
    for (const w of geo.design.wires) {
      if (w.from[0] === w.to[0]) continue;
      if (!inFlow.has(w.from[0]) || !inFlow.has(w.to[0])) continue;
      const a = cy(w.from[0]);
      const b = cy(w.to[0]);
      if (a === undefined || b === undefined) continue;
      dys.push(clamp01(Math.abs(a - b) / ROW_PITCH));
    }
    if (dys.length > 0) perFlow.push(mean(dys));
  }
  // Overlap part: distinct-kind flows should occupy distinct Y-bands (read vs write on their own lanes).
  const kindOf = (f: LayoutFlow): string => {
    const first = geo.design.wires.find((w) => w.from[0] === f.source)?.classId;
    return first ?? f.source; // same request class ⇒ same kind; else keyed by origin
  };
  let overlapping = 0;
  let pairs = 0;
  for (let i = 0; i < flows.length; i++) {
    for (let j = i + 1; j < flows.length; j++) {
      const fi = flows[i]!;
      const fj = flows[j]!;
      if (kindOf(fi) === kindOf(fj)) continue;
      const bi = yRange(geo, fi.ids);
      const bj = yRange(geo, fj.ids);
      if (bi === null || bj === null) continue;
      pairs++;
      if (bi.lo <= bj.hi && bj.lo <= bi.hi) overlapping++;
    }
  }
  const spreadPart = perFlow.length > 0 ? mean(perFlow) : null;
  const overlapPart = pairs > 0 ? overlapping / pairs : null;
  if (spreadPart === null && overlapPart === null) return null;
  if (spreadPart === null) return clamp01(overlapPart!);
  if (overlapPart === null) return clamp01(spreadPart);
  return clamp01(0.6 * spreadPart + 0.4 * overlapPart);
}

/** role layering (semantic) — wires that run BACKWARD in role order (role(target) < role(source)), plus role-typed
 *  node pairs whose left-to-right order violates their tiers. Drives clients left, stores right. Inert when no node
 *  carries a mapped role (a full mesh with no gradient — §4.2). */
export function rolePenalty(geo: LayoutGeometry): number | null {
  const cx = (id: string): number | undefined => geo.centers.get(id)?.x;
  const tierOf = new Map<string, number>();
  for (const n of geo.design.nodes) {
    const t = roleTier(n.type);
    if (t !== undefined) tierOf.set(n.id, t);
  }
  if (tierOf.size === 0) return null;
  let backward = 0;
  let directed = 0;
  for (const w of geo.design.wires) {
    const s = tierOf.get(w.from[0]);
    const t = tierOf.get(w.to[0]);
    if (s === undefined || t === undefined || s === t) continue;
    directed++;
    if (t < s) backward++;
  }
  const typed = [...tierOf.keys()];
  let violations = 0;
  let diffPairs = 0;
  for (let i = 0; i < typed.length; i++) {
    for (let j = i + 1; j < typed.length; j++) {
      const a = typed[i]!;
      const b = typed[j]!;
      const ta = tierOf.get(a)!;
      const tb = tierOf.get(b)!;
      if (ta === tb) continue;
      const xa = cx(a);
      const xb = cx(b);
      if (xa === undefined || xb === undefined) continue;
      diffPairs++;
      // lower tier should sit to the LEFT (smaller x); a violation is the wrong order.
      if ((ta < tb && xa > xb) || (tb < ta && xb > xa)) violations++;
    }
  }
  const parts: number[] = [];
  if (directed > 0) parts.push(backward / directed);
  if (diffPairs > 0) parts.push(violations / diffPairs);
  if (parts.length === 0) return null;
  return clamp01(mean(parts));
}

/** symmetry (semantic) — for each fan-out into sibling branches, the asymmetry of the branch vertical offsets about
 *  the fan-out axis (0 = perfectly mirrored, 1 = all on one side). Parallel branches want to mirror. Inert when no
 *  node fans out to ≥2 distinct targets. */
export function symmetryPenalty(geo: LayoutGeometry): number | null {
  const { fwd } = adjacency(geo.design);
  const asyms: number[] = [];
  for (const [src, targets] of fwd) {
    const distinct = [...new Set(targets)];
    if (distinct.length < 2) continue;
    const parent = geo.centers.get(src);
    if (parent === undefined) continue;
    const offsets: number[] = [];
    for (const t of distinct) {
      const c = geo.centers.get(t);
      if (c !== undefined) offsets.push(c.y - parent.y);
    }
    if (offsets.length < 2) continue;
    const absSum = offsets.reduce((s, o) => s + Math.abs(o), 0);
    const signedSum = Math.abs(offsets.reduce((s, o) => s + o, 0));
    asyms.push(absSum > 0 ? signedSum / absSum : 0);
  }
  if (asyms.length === 0) return null;
  return clamp01(mean(asyms));
}

/** group compactness (semantic) — per group, wasted space in the derived box `(box_area − Σ member_area)/box_area`,
 *  plus a penalty for any non-member intruding. Inert when the design declares no groups (the honest N/A the CQRS
 *  worked score shows — a term with no subject scores nothing, not zero-perfect). */
export function groupPenalty(geo: LayoutGeometry): number | null {
  if (geo.design.groups.length === 0 || geo.groups.length === 0) return null;
  const boxById = new Map(geo.nodes.map((n) => [n.id, n.box] as const));
  const perGroup: number[] = [];
  for (const g of geo.groups) {
    const boxArea = g.rect.w * g.rect.h;
    let memberArea = 0;
    for (const id of g.members) {
      const b = boxById.get(id);
      if (b !== undefined) memberArea += b.w * b.h;
    }
    const wasted = boxArea > 0 ? clamp01((boxArea - memberArea) / boxArea) : 0;
    const members = new Set(g.members);
    let intruders = 0;
    let nonMembers = 0;
    for (const [id, b] of boxById) {
      if (members.has(id)) continue;
      nonMembers++;
      if (boxesOverlap(b, g.rect, 0)) intruders++;
    }
    const intruderPen = nonMembers > 0 ? intruders / nonMembers : 0;
    perGroup.push(clamp01(0.7 * wasted + 0.3 * intruderPen));
  }
  return perGroup.length === 0 ? null : clamp01(mean(perGroup));
}

/** async offset (semantic) — the fraction of async wires NOT drawn as a visually distinct spur (offset off the sync
 *  spine or bending onto their own run). Async should LOOK async. Inert when no wire is async. */
export function asyncPenalty(geo: LayoutGeometry): number | null {
  const asyncIdx: number[] = [];
  geo.design.wires.forEach((w, i) => {
    if (w.semantics === 'async') asyncIdx.push(i);
  });
  if (asyncIdx.length === 0) return null;
  let distinct = 0;
  for (const i of asyncIdx) {
    const w = geo.design.wires[i]!;
    const a = geo.centers.get(w.from[0]);
    const b = geo.centers.get(w.to[0]);
    const pts = geo.routes.get(i);
    const offset = a !== undefined && b !== undefined && Math.abs(a.y - b.y) > ALIGN_EPS;
    const bends = pts !== undefined && simplifyOrthogonal(pts).length - 2 >= 1;
    if (offset || bends) distinct++;
  }
  return clamp01(1 - distinct / asyncIdx.length);
}

/** area / aspect — compactness against an n-node ideal area plus deviation from a target aspect (16:10). Always
 *  active (every non-empty design has an area). */
export function areaPenalty(geo: LayoutGeometry): number | null {
  const n = geo.design.nodes.length;
  if (n === 0) return null;
  const cell = COLW * ROW_PITCH;
  const area = Math.max(1, geo.bounds.w * geo.bounds.h);
  const areaPart = clamp01(area / (n * cell) - 1); // 0 waste at n cells; 1 at 2×
  const aspect = geo.bounds.w / Math.max(1, geo.bounds.h);
  const target = 16 / 10;
  const aspectPart = clamp01(Math.abs(aspect - target) / target);
  return clamp01(0.5 * areaPart + 0.5 * aspectPart);
}

/** label clearance — the fraction of edge-label boxes (one per wire, at the routed midpoint) that overlap a
 *  non-endpoint node. Labels must be readable, not buried. Inert with no wires. */
export function labelPenalty(geo: LayoutGeometry): number | null {
  const e = geo.design.wires.length;
  if (e === 0) return null;
  const LABEL: { w: number; h: number } = { w: 44, h: 16 };
  let overlapping = 0;
  let labels = 0;
  geo.design.wires.forEach((w, i) => {
    const pts = geo.routes.get(i);
    if (pts === undefined || pts.length === 0) return;
    labels++;
    const mid = pts[Math.floor(pts.length / 2)] ?? pts[0]!;
    const lbl: Rect = { x: mid.x - LABEL.w / 2, y: mid.y - LABEL.h / 2, w: LABEL.w, h: LABEL.h };
    for (const n of geo.nodes) {
      if (n.id === w.from[0] || n.id === w.to[0]) continue;
      if (boxesOverlap(lbl, n.box, 0)) {
        overlapping++;
        break;
      }
    }
  });
  return labels === 0 ? null : clamp01(overlapping / labels);
}

// ── The SEPARATION terms (R4) — edge traceability, scored on the real routed polylines ─────────────────
//
// Each iterates the router's actual wires (the arbiter): a wire two others lie on top of is the traceability sin the
// owner flagged. The router's own nudging pass (edge-routing.ts `separateEdges`) is what these terms REWARD — the
// two are the arbiter/objective pair (libavoid's "route then nudge apart", Wybrow et al. GD 2009): the router
// separates the corridors, the objective scores whether it succeeded so the search prefers placements that leave
// the room to.

/** All routed polylines with ≥2 points, as an array (the terms scan pairs of these). */
function routePolylines(geo: LayoutGeometry): (readonly Pos[])[] {
  const out: (readonly Pos[])[] = [];
  for (const pts of geo.routes.values()) if (pts.length >= 2) out.push(pts);
  return out;
}

/** overlap (separation) — the total length over which DISTINCT wires run collinear (within {@link MERGE_TOL} of the
 *  same axis line), over the total routed length. The fraction of all wire ink drawn on top of another wire — the
 *  HEAVY term, 0 = every line is traceable end-to-end, high = corridors collapsed onto each other. Inert (<2 wires,
 *  no pair) or when the routing is degenerate (zero total length). */
export function overlapPenalty(geo: LayoutGeometry): number | null {
  const polys = routePolylines(geo);
  if (polys.length < 2) return null;
  let total = 0;
  for (const pts of polys) total += polylineLength(pts);
  if (total <= 0) return null;
  let overlap = 0;
  for (let i = 0; i < polys.length; i++) {
    const a = polys[i]!;
    for (let j = i + 1; j < polys.length; j++) {
      const b = polys[j]!;
      for (let s = 1; s < a.length; s++) {
        for (let t = 1; t < b.length; t++) {
          overlap += collinearOverlapLength(a[s - 1]!, a[s]!, b[t - 1]!, b[t]!, MERGE_TOL);
        }
      }
    }
  }
  return clamp01(overlap / total);
}

/** spacing (separation) — of the wire-segment pairs that SHARE A CORRIDOR (parallel, spans overlapping, within
 *  {@link CORRIDOR_WINDOW} px), the fraction packed closer than {@link MIN_TRACK_GAP} (too tight to trace apart, or
 *  overlapping outright). Rewards giving each parallel run its own readable track (yFiles' minimum edge distance).
 *  Inert when no two wires share a corridor. */
export function spacingPenalty(geo: LayoutGeometry): number | null {
  const polys = routePolylines(geo);
  if (polys.length < 2) return null;
  let corridorPairs = 0;
  let tooClose = 0;
  for (let i = 0; i < polys.length; i++) {
    const a = polys[i]!;
    for (let j = i + 1; j < polys.length; j++) {
      const b = polys[j]!;
      for (let s = 1; s < a.length; s++) {
        for (let t = 1; t < b.length; t++) {
          const gap = parallelTrackGap(a[s - 1]!, a[s]!, b[t - 1]!, b[t]!);
          if (gap === null || gap > CORRIDOR_WINDOW) continue;
          corridorPairs++;
          if (gap < MIN_TRACK_GAP) tooClose++;
        }
      }
    }
  }
  return corridorPairs === 0 ? null : clamp01(tooClose / corridorPairs);
}

/** Wires grouped by TARGET node (the fan-in bundles). A bundle of ≥2 wires converges on one destination. */
function targetBundles(geo: LayoutGeometry): number[][] {
  const byTarget = new Map<string, number[]>();
  geo.design.wires.forEach((w, i) => {
    if (!geo.routes.has(i)) return;
    (byTarget.get(w.to[0]) ?? byTarget.set(w.to[0], []).get(w.to[0])!).push(i);
  });
  return [...byTarget.values()].filter((g) => g.length >= 2);
}

/** merge (separation) — for wires sharing a destination, how EARLY they converge: per bundle-pair, the distance from
 *  the target at which the two first become collinear, over the pair's horizontal span. 0 = they stay on separate
 *  corridors and meet only at the port stub (the owner's "as late as possible"); high = they merge back near the
 *  source. Inert when no destination is shared by ≥2 routed wires. */
export function mergePenalty(geo: LayoutGeometry): number | null {
  const bundles = targetBundles(geo);
  if (bundles.length === 0) return null;
  const ratios: number[] = [];
  for (const bundle of bundles) {
    for (let i = 0; i < bundle.length; i++) {
      for (let j = i + 1; j < bundle.length; j++) {
        const a = geo.routes.get(bundle[i]!)!;
        const b = geo.routes.get(bundle[j]!)!;
        const tx = a[a.length - 1]?.x ?? 0; // shared target anchor x (routes end at the target port)
        const span = Math.max(1, Math.abs(tx - Math.min(a[0]?.x ?? tx, b[0]?.x ?? tx)));
        let earliest = 0; // farthest-from-target collinear point ⇒ the merge distance
        for (let s = 1; s < a.length; s++) {
          for (let t = 1; t < b.length; t++) {
            const a0 = a[s - 1]!, a1 = a[s]!, b0 = b[t - 1]!, b1 = b[t]!;
            if (collinearOverlapLength(a0, a1, b0, b1, MERGE_TOL) <= 0) continue;
            // Horizontal fan-in merges on a shared row: the merge point is the LEFT end of the overlap; its distance
            // from the target is tx − that x. (A vertical shared run is measured the same way via y vs the target.)
            if (a0.y === a1.y && b0.y === b1.y) {
              const left = Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x));
              earliest = Math.max(earliest, Math.abs(tx - left));
            }
          }
        }
        ratios.push(clamp01(earliest / span));
      }
    }
  }
  return ratios.length === 0 ? null : clamp01(mean(ratios));
}

/** Raw separation figures for the BENCHMARK table (px, not normalised) — the measured evidence the owner's verdict
 *  is judged on: total line-on-line overlap, the tightest parallel-track gap, and how far from the target shared
 *  destinations merge. `minGap` is Infinity when no two wires share a corridor; `meanMergeDist` is 0 when nothing
 *  fans in. Lower overlap + lower mergeDist + a min gap at/above {@link MIN_TRACK_GAP} = more traceable. */
export interface SeparationMetrics {
  readonly overlapLen: number;
  readonly minGap: number;
  readonly meanMergeDist: number;
}
export function separationMetrics(geo: LayoutGeometry): SeparationMetrics {
  const polys = routePolylines(geo);
  let overlapLen = 0;
  let minGap = Infinity;
  for (let i = 0; i < polys.length; i++) {
    const a = polys[i]!;
    for (let j = i + 1; j < polys.length; j++) {
      const b = polys[j]!;
      for (let s = 1; s < a.length; s++) {
        for (let t = 1; t < b.length; t++) {
          const a0 = a[s - 1]!, a1 = a[s]!, b0 = b[t - 1]!, b1 = b[t]!;
          overlapLen += collinearOverlapLength(a0, a1, b0, b1, MERGE_TOL);
          const gap = parallelTrackGap(a0, a1, b0, b1);
          if (gap !== null && gap > MERGE_TOL && gap <= CORRIDOR_WINDOW) minGap = Math.min(minGap, gap);
        }
      }
    }
  }
  const bundles = targetBundles(geo);
  const dists: number[] = [];
  for (const bundle of bundles) {
    for (let i = 0; i < bundle.length; i++) {
      for (let j = i + 1; j < bundle.length; j++) {
        const a = geo.routes.get(bundle[i]!)!;
        const b = geo.routes.get(bundle[j]!)!;
        const tx = a[a.length - 1]?.x ?? 0;
        let earliest = 0;
        for (let s = 1; s < a.length; s++) {
          for (let t = 1; t < b.length; t++) {
            const a0 = a[s - 1]!, a1 = a[s]!, b0 = b[t - 1]!, b1 = b[t]!;
            if (a0.y === a1.y && b0.y === b1.y && collinearOverlapLength(a0, a1, b0, b1, MERGE_TOL) > 0) {
              earliest = Math.max(earliest, Math.abs(tx - Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x))));
            }
          }
        }
        dists.push(earliest);
      }
    }
  }
  return { overlapLen, minGap, meanMergeDist: dists.length === 0 ? 0 : mean(dists) };
}

/** How many routed wires are ONE straight axis-aligned segment — the router's straight-line fast path made real
 *  (a 2-point polyline; the diagonal fallback a router miss leaves is not counted). The R5 winner TIE-BREAK reads
 *  this: port-centric alignment must CASH as straight wires in the shipped layout, not merely score as aligned
 *  rows — among equal-quality finalists the optimiser ships the straighter one (layout-optimize `result()`), and
 *  the benchmark pins that the deterministic semantic pass never draws fewer straight wires than Tidy. */
export function straightWireCount(geo: LayoutGeometry): number {
  let n = 0;
  for (const pts of geo.routes.values()) {
    if (pts.length !== 2) continue;
    const a = pts[0]!;
    const b = pts[1]!;
    if (a.x === b.x || a.y === b.y) n++;
  }
  return n;
}

const TERM_FN: Readonly<Record<LayoutTerm, (geo: LayoutGeometry) => number | null>> = {
  crossings: crossingsPenalty,
  bends: bendsPenalty,
  length: lengthPenalty,
  alignment: alignmentPenalty,
  lane: lanePenalty,
  role: rolePenalty,
  symmetry: symmetryPenalty,
  group: groupPenalty,
  async: asyncPenalty,
  area: areaPenalty,
  label: labelPenalty,
  overlap: overlapPenalty,
  spacing: spacingPenalty,
  merge: mergePenalty,
};

/** The scored result of a candidate layout: the aggregate quality, feasibility, and the per-term penalties (a term
 *  with no subject is `null` — N/A, renormalised away, never a false zero). */
export interface LayoutScore {
  /** Aggregate quality in [0,1] (1 = ideal) when feasible; `-Infinity` when a hard constraint is violated (so the
   *  search ranks any legal layout above every illegal one). */
  readonly score: number;
  readonly feasible: boolean;
  readonly hard: readonly HardViolation[];
  readonly penalties: Readonly<Record<LayoutTerm, number | null>>;
  /** The renormalised quality (1 − Σ (wₖ/W)·pₖ) over the active terms, regardless of feasibility (for diagnostics
   *  / the benchmark table, which reports quality even on the rare infeasible dagre/ELK output). */
  readonly quality: number;
}

/** Score a prepared geometry: the eleven penalties, the renormalised quality, and the hard-constraint verdict. */
export function scoreGeometry(geo: LayoutGeometry): LayoutScore {
  const penalties = {} as Record<LayoutTerm, number | null>;
  let weighted = 0;
  let activeWeight = 0;
  for (const term of LAYOUT_TERMS) {
    const p = TERM_FN[term](geo);
    penalties[term] = p;
    if (p === null) continue;
    weighted += LAYOUT_WEIGHTS[term] * p;
    activeWeight += LAYOUT_WEIGHTS[term];
  }
  const quality = activeWeight > 0 ? clamp01(1 - weighted / activeWeight) : 1;
  const hard = hardViolations(geo);
  const feasible = hard.length === 0;
  return { score: feasible ? quality : Number.NEGATIVE_INFINITY, feasible, hard, penalties, quality };
}

/** Score a placement end-to-end: route it (the arbiter), then evaluate the objective. The one call the optimiser and
 *  the benchmark use. */
export function scoreLayout(design: LayoutDesign, placement: Placement, ports?: Map<string, PortLike[]>): LayoutScore {
  return scoreGeometry(layoutGeometry(design, placement, ports));
}
