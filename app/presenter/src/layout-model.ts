import type { Pos, Rect, Size } from './layout';
import type { GroupLike, NodeGeom, PortLike } from './edge-routing';

// @algorithm Shared layout geometry kit (mulberry32, FNV-1a hash, longest-path columns, segment/track geometry)
// @problem Every layout stage — objective, router, search, ports — must measure the SAME geometry
//   and derive the SAME structure, or their scores and routes drift apart; the search also needs a
//   platform-independent seed from the design itself.
// @approach One dependency-free toolbox: mulberry32 seeded PRNG (the same generator content's
//   uncertainty uses) + FNV-1a 32-bit content hash for design seeding; longest-path depth columns
//   (the Sugiyama layering, cycle-guarded) and lane/flow decomposition by explicit-stack DFS;
//   orientation-test segment crossing, polyline length/corners, box hits; and the R4 separation
//   geometry (collinear overlap length, parallel track gap) from the connector-routing literature.
// @complexity segmentsProperlyCross O(1); polylinesCross O(|a|*|b|); longestPathDepth O(V*E) worst
//   case; hashes and PRNG O(1) per step.
// @citations mulberry32 (Tommy Ettinger); FNV-1a (Fowler-Noll-Vo); Sugiyama et al. 1981 (layering);
//   Wybrow, Marriott & Stuckey, GD 2009 (libavoid orthogonal routing — the separation measures);
//   Hashimoto & Stevens 1971 (VLSI left-edge channel routing).
// @invariants Pure and deterministic; platform-independent (no Date/Math.random — hash + seed give
//   the same stream everywhere); the one anchor formula shared by router, renderer and layout
//   family (no drift).
// @where-tested app/presenter/src/layout-model.test.ts

// THE IDEAL LAYOUT — shared model + pure geometry (doc: ideal-layout §2, §4). This is the domain-lite structural
// input every layout stage reads, plus the deterministic helpers they all share: node/port geometry, structural
// flow decomposition, the role→tier map, longest-path columns, a content hash for seeding, and the primitive
// geometry (segment crossings, polyline length, corner count) the OBJECTIVE scores on. Pure and dependency-free —
// it imports only local TYPES (layout + edge-routing), never a workspace runtime package, so it stays fast, unit-
// testable in isolation, and runnable by Node's type-stripping for the offline benchmark previews. The engine is
// untouched; this lives in app/presenter, which is allowed to read the design's own semantics (doc §7).

/** A placed component AS THE LAYOUT SEES IT: its id, its component `type` (read for the role→tier heuristic, §4.1),
 *  an optional measured `size` (default {@link DEFAULT_NODE_SIZE}), an optional declared origin rate (a node
 *  with `originRate > 0` is a traffic origin even mid-graph — a migration service, an emitter — exactly as the system
 *  roll-up treats `assumedRps`), and — R5, port-position assignment — the node's CATALOG ports in MANIFEST order
 *  (`ports`), when the shell knows them. The canvas renders one handle per manifest port at the same-side fraction
 *  (i+1)/(n+1), so a layout that derives ports from the WIRES alone anchors wires where no handle exists (the
 *  multi-out jog: a service with `db`+`out`+`cache` out-ports but only `db` wired renders `db` at h/4 while the
 *  wire-derived model put it at h/2). With `ports` present, every stage — anchors, objective, router, slide —
 *  speaks the RENDERED geometry. Absent (older callers, the benchmark's raw loads), the wire-derived ports remain
 *  the honest fallback. Positions are NOT here: a placement is a separate map, so one structure yields many
 *  candidate placements during the search. */
export interface LayoutNode {
  readonly id: string;
  readonly type?: string;
  readonly size?: Size;
  readonly originRate?: number;
  readonly ports?: readonly PortLike[];
}

/** One wire, carrying the SEMANTICS the layout reads: `sync`/`async` (async wants a distinct spur, §2.2) and an
 *  optional request-class membership (`classId`) so lane coherence can keep unlike commodities off one Y-band. */
export interface LayoutWire {
  readonly from: readonly [string, string];
  readonly to: readonly [string, string];
  readonly semantics?: 'sync' | 'async';
  readonly classId?: string;
}

/** An explicit visual group: just its id + member ids (the placement partition — H4, §2.1). The rect is DERIVED
 *  from where the members land (`groupRects`), never stored, so the box always hugs its members. */
export interface LayoutGroup {
  readonly id: string;
  readonly members: readonly string[];
}

/** The whole design the layout reads — pure structure, no positions, no solved numbers (a layout is beauty, never
 *  truth: §3.5). Built by a shell (or the benchmark) from the project doc + the catalog's ports. */
export interface LayoutDesign {
  readonly nodes: readonly LayoutNode[];
  readonly wires: readonly LayoutWire[];
  readonly groups: readonly LayoutGroup[];
}

/** A candidate layout: each node's TOP-LEFT corner. The same shape Tidy and `doc.layout` use (no schema change,
 *  doc §7) — the optimiser writes exactly this map. */
export type Placement = Readonly<Record<string, Pos>>;

/** The canvas node footprint the layout assumes when a shell supplies no measured size — the fixed CSS node width
 *  and a representative height, shared by Tidy, the router obstacle set and the objective so all three agree. */
export const DEFAULT_NODE_SIZE: Size = { w: 160, h: 120 };

/** Grid constants — shared with Tidy (`layout.ts`) so the seed and the refinement quantise to the SAME lattice
 *  (H3: minimum spacings, §2.1). COLW = column pitch, ROW_PITCH = the vertical lane pitch (node + gap). */
export const COL0 = 60;
export const COLW = 340;
export const ROW0 = 40;
export const ROW_PITCH = 176;

export const sizeOf = (node: LayoutNode): Size => node.size ?? DEFAULT_NODE_SIZE;

/**
 * Derive each node's PORTS purely from the wiring — a port is `out` where a wire leaves it, `in` where a wire
 * enters it, `bi` where both. This is the SAME derivation the router regression test uses, and it keeps the layout
 * dependency-free: it never needs the component catalog to route or score. A node with no wire gets a default in/out
 * pair so it can still be an obstacle/anchor.
 */
export function portsFromWires(design: LayoutDesign): Map<string, PortLike[]> {
  const dir = new Map<string, Map<string, 'in' | 'out' | 'bi'>>();
  const touch = (n: string, p: string, d: 'in' | 'out'): void => {
    const m = dir.get(n) ?? dir.set(n, new Map()).get(n)!;
    const cur = m.get(p);
    m.set(p, cur === undefined ? d : cur === d ? d : 'bi');
  };
  for (const w of design.wires) {
    touch(w.from[0], w.from[1], 'out');
    touch(w.to[0], w.to[1], 'in');
  }
  const out = new Map<string, PortLike[]>();
  for (const node of design.nodes) {
    const m = dir.get(node.id);
    const ports: PortLike[] = m ? [...m.entries()].map(([name, d]) => ({ name, dir: d })) : [];
    if (ports.length === 0) ports.push({ name: 'in', dir: 'in' }, { name: 'out', dir: 'out' });
    out.set(node.id, ports);
  }
  return out;
}

/**
 * THE ports every layout stage reads (R5): a node's declared CATALOG ports (manifest order — exactly the handles
 * the canvas renders), falling back to {@link portsFromWires} for a node that declares none. This is the one
 * derivation the anchors, the objective, the optimiser and the slide all share, so the old bug class — layout
 * aligning WIRE-derived fractions while the canvas renders MANIFEST fractions (the multi-out jog) — cannot recur:
 * whichever list a node carries, every consumer speaks it.
 */
export function designPorts(design: LayoutDesign): Map<string, PortLike[]> {
  const derived = portsFromWires(design);
  const out = new Map<string, PortLike[]>();
  for (const node of design.nodes) {
    out.set(node.id, node.ports !== undefined && node.ports.length > 0 ? [...node.ports] : (derived.get(node.id) ?? []));
  }
  return out;
}

// ── Port-anchor geometry (R5, port-centric alignment) — THE one form the router and the layout family share ──────
//
// OWNER NUANCE (HEAD 3db9e15): row alignment was NODE-based while edges anchor at PORT fractions of variable-height
// nodes, so "aligned" rows still broke lines and the router's straight-line fast path (ports within its 4px snap)
// rarely fired. The fix is to make every stage speak ANCHORS: the row-placement passes make a wire's two port
// anchors collinear, the objective's alignment term clusters anchors, and the router meets them with ONE straight
// segment. That only works if all of them compute the anchor from the SAME geometry — so it lives HERE, in one
// form: {@link portFraction} (the exact formula `routeDesignEdges` anchors wires with), plus the two derived reads
// the layout passes need ({@link wireAnchorOffsets}, {@link dominantAnchors}).

/**
 * The fractional Y of a wire's port along its node side, matching the canvas handle placement (top = (i+1)/(n+1)
 * among SAME-side ports — `in`/`bi` on the in side, `out`/`bi` on the out side; an unknown/portless name reads the
 * neutral 0.5). THE port geometry, in one form: the router anchors every routed wire with it (edge-routing
 * `routeDesignEdges`), and the layout family aligns rows / measures alignment with it — so "aligned" always means
 * the ROUTED anchors are collinear and the straight-line fast path actually fires.
 */
export function portFraction(ports: readonly PortLike[], side: 'in' | 'out', portName: string): number {
  const onSide = ports.filter((p) => (side === 'in' ? p.dir === 'in' || p.dir === 'bi' : p.dir === 'out' || p.dir === 'bi'));
  const idx = onSide.findIndex((p) => p.name === portName);
  if (idx < 0 || onSide.length === 0) return 0.5;
  return (idx + 1) / (onSide.length + 1);
}

// ── Port POSITION assignment (R5, port sliding) — the shared offset vocabulary ─────────────────────────────────
//
// A port may SLIDE along its node edge to sit exactly opposite its peer (the ELK port-position / yFiles
// port-optimization class). The slide is computed ONCE per shipped layout (layout-ports `assignPortOffsets`) and
// carried as an OFFSET map: node id → `${side}:${port}` → px from the node's TOP at which that handle sits. The
// map is OPTIONAL everywhere — absent, every consumer falls back to the fraction geometry above (Tidy alone keeps
// fractions; only the ✨ pipeline assigns). {@link portAnchorOffset} is THE one read — the router, the renderer
// and the DOM assertions all resolve a port's y through it, so an assigned handle and its routed anchor can never
// drift apart.

/** One node's assigned port offsets: `${'in'|'out'}:${portName}` → px from the node's top (the handle CENTRE —
 *  both shells' handle/label CSS is translateY(-50%), so `top: <offset>px` centres the handle exactly there,
 *  matching the router's anchor row). A key's absence ⇒ that handle keeps its fraction position. */
export type NodePortOffsets = Readonly<Record<string, number>>;
/** The whole design's assigned offsets: node id → {@link NodePortOffsets}. */
export type PortOffsets = Readonly<Record<string, NodePortOffsets>>;

/** The offset-map key for a port on a side — ONE spelling everywhere (`in:db` / `out:db`; a `bi` port has two
 *  handles, one per side, each with its own key). */
export const portOffsetKey = (side: 'in' | 'out', portName: string): string => `${side}:${portName}`;

/** A port's px offset from its node's TOP — assigned offset when present, else height × {@link portFraction}.
 *  THE one form: the router anchors with it, the renderer places handles with it, the slide records into it. */
export function portAnchorOffset(
  ports: readonly PortLike[],
  side: 'in' | 'out',
  portName: string,
  height: number,
  offsets?: NodePortOffsets,
): number {
  return offsets?.[portOffsetKey(side, portName)] ?? height * portFraction(ports, side, portName);
}

const heightFor = (design: LayoutDesign, sizes: Readonly<Record<string, Size>> | undefined, id: string): number =>
  sizes?.[id]?.h ?? sizeOf(design.nodes.find((n) => n.id === id) ?? { id }).h;

/** One wire's anchor offsets: px from the SOURCE node's top at which the wire leaves it (its out-port anchor) and
 *  px from the TARGET node's top at which it enters (its in-port anchor). */
export interface WireAnchorOffsets {
  readonly source: number;
  readonly target: number;
}

/**
 * Per wire (indexed like `design.wires`): the px offsets from each end-node's TOP at which that wire anchors —
 * height × {@link portFraction}, exactly the anchor Y the router computes in `routeDesignEdges`. The row-placement
 * passes use these to make a wire's two anchors collinear (source top + source offset = target top + target offset
 * ⇒ the router draws ONE straight segment). `sizes` are the shell's measured footprints (defaulting to each node's
 * declared/default size); `ports` the design's ports (defaulting to {@link designPorts} — manifest when declared,
 * wire-derived otherwise).
 */
export function wireAnchorOffsets(
  design: LayoutDesign,
  sizes?: Readonly<Record<string, Size>>,
  ports?: Map<string, PortLike[]>,
): WireAnchorOffsets[] {
  const p = ports ?? designPorts(design);
  return design.wires.map((w) => ({
    source: heightFor(design, sizes, w.from[0]) * portFraction(p.get(w.from[0]) ?? [], 'out', w.from[1]),
    target: heightFor(design, sizes, w.to[0]) * portFraction(p.get(w.to[0]) ?? [], 'in', w.to[1]),
  }));
}

/** A node's dominant anchor: the offset (px from its top) of its heaviest connected port, plus WHICH (side, port)
 *  won — `port` is undefined for an unwired node (its anchor is the neutral centre, h/2). */
export interface DominantAnchor {
  readonly offset: number;
  readonly port?: { readonly side: 'in' | 'out'; readonly name: string };
}

/**
 * Each node's DOMINANT connected-port anchor (px from its top + the winning port): the connected (side, port)
 * carrying the MOST wires — the heaviest — with ties broken by FIRST touch in wire order, so a tall/multi-port
 * node picks one reference row deterministically. A node with no wires anchors at its centre (h/2), the neutral
 * row. A node's row offset is chosen to put THIS anchor on the shared guideline (the peer's anchor — the semantic
 * pass snaps a node's row to make its dominant wire exactly collinear), and the objective's alignment term
 * clusters exactly these — port-centric alignment, one definition everywhere.
 */
export function dominantAnchors(
  design: LayoutDesign,
  sizes?: Readonly<Record<string, Size>>,
  ports?: Map<string, PortLike[]>,
): Map<string, DominantAnchor> {
  const p = ports ?? designPorts(design);
  // Tally wires per (node, side, port) in wire order; remember each key's first-touch sequence for the tie-break.
  const tally = new Map<string, Map<string, { count: number; firstSeen: number }>>();
  let seq = 0;
  const touch = (node: string, side: 'in' | 'out', portName: string): void => {
    const m = tally.get(node) ?? tally.set(node, new Map()).get(node)!;
    const key = `${side}:${portName}`;
    const cur = m.get(key);
    if (cur === undefined) m.set(key, { count: 1, firstSeen: seq++ });
    else cur.count++;
  };
  for (const w of design.wires) {
    touch(w.from[0], 'out', w.from[1]);
    touch(w.to[0], 'in', w.to[1]);
  }
  const out = new Map<string, DominantAnchor>();
  for (const node of design.nodes) {
    const h = heightFor(design, sizes, node.id);
    const m = tally.get(node.id);
    if (m === undefined) {
      out.set(node.id, { offset: h / 2 }); // unwired: the neutral centre row
      continue;
    }
    let best: { key: string; count: number; firstSeen: number } | undefined;
    for (const [key, t] of m) {
      if (best === undefined || t.count > best.count || (t.count === best.count && t.firstSeen < best.firstSeen)) {
        best = { key, ...t };
      }
    }
    const sep = best!.key.indexOf(':');
    const side = best!.key.slice(0, sep) as 'in' | 'out';
    const name = best!.key.slice(sep + 1);
    out.set(node.id, { offset: h * portFraction(p.get(node.id) ?? [], side, name), port: { side, name } });
  }
  return out;
}

/** Build the router's obstacle/anchor nodes for a placement: each node's box (corner + size) + its ports
 *  ({@link designPorts} — manifest when declared), plus — when a slide has assigned them — the node's port
 *  OFFSETS, so the router anchors exactly where the handles render. */
export function nodeGeoms(design: LayoutDesign, placement: Placement, ports?: Map<string, PortLike[]>, offsets?: PortOffsets): NodeGeom[] {
  const p = ports ?? designPorts(design);
  const out: NodeGeom[] = [];
  for (const node of design.nodes) {
    const at = placement[node.id];
    if (at === undefined) continue;
    const s = sizeOf(node);
    const off = offsets?.[node.id];
    out.push({ id: node.id, box: { x: at.x, y: at.y, w: s.w, h: s.h }, ports: p.get(node.id) ?? [], ...(off !== undefined ? { portOffsets: off } : {}) });
  }
  return out;
}

/** A node's box (corner + size) in a placement, or undefined if unplaced. */
export function boxOf(design: LayoutDesign, placement: Placement, id: string): Rect | undefined {
  const at = placement[id];
  if (at === undefined) return undefined;
  const node = design.nodes.find((n) => n.id === id);
  if (node === undefined) return undefined;
  const s = sizeOf(node);
  return { x: at.x, y: at.y, w: s.w, h: s.h };
}

/** The TIGHT bounding box of a set of node boxes (+ optional padding), or undefined if none are placed. */
function bboxOfNodes(design: LayoutDesign, placement: Placement, ids: readonly string[], pad = 0): Rect | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let saw = false;
  for (const id of ids) {
    const b = boxOf(design, placement, id);
    if (b === undefined) continue;
    saw = true;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (!saw) return undefined;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}

/** Group rects DERIVED from where the members land — the box hugs its members (the compactness the objective
 *  rewards). Padding matches Tidy's group padding so the two agree. Empty groups are dropped. */
export function groupRects(design: LayoutDesign, placement: Placement, pad = 26): GroupLike[] {
  const out: GroupLike[] = [];
  for (const g of design.groups) {
    const rect = bboxOfNodes(design, placement, g.members, pad);
    if (rect === undefined) continue;
    out.push({ id: g.id, rect, members: g.members });
  }
  return out;
}

/** The bounding box of the WHOLE placement (all node boxes), or a unit box when empty. */
export function contentBounds(design: LayoutDesign, placement: Placement): Rect {
  return bboxOfNodes(design, placement, design.nodes.map((n) => n.id)) ?? { x: 0, y: 0, w: 1, h: 1 };
}

// ── Semantics: role tiers, columns, structural flows ──────────────────────────────────────────────────────────

/**
 * The role→tier map (doc §4.1): a component's LEFT-TO-RIGHT band read from its `type` prefix. This is CONTENT data
 * the layout may inspect (the presenter is allowed to be domain-aware; the domain-agnostic engine is untouched). It
 * is honest but HEURISTIC — a novel prefix returns `undefined` (a neutral tier, placed by flow depth alone, never
 * mis-placed). The doc's open-question lean is exactly this type-prefix map now, promotable to an explicit registry
 * `tier` field later (§6.3). Half-steps (broker = 2.5) keep queues/topics between compute and stores.
 */
const TIER_BY_PREFIX: Readonly<Record<string, number>> = {
  client: 0,
  cdn: 1,
  apigw: 1,
  gateway: 1,
  lb: 1,
  proxy: 1,
  security: 1,
  compute: 2,
  ai: 2,
  stream: 2.5,
  queue: 2.5,
  topic: 2.5,
  cache: 3,
  db: 3,
  storage: 3,
  search: 3,
};

/** A node's role tier from its type prefix, or `undefined` when the prefix is unmapped (a neutral, un-hinted tier). */
export function roleTier(type: string | undefined): number | undefined {
  if (type === undefined) return undefined;
  const prefix = type.split('.')[0] ?? '';
  return TIER_BY_PREFIX[prefix];
}

/** Longest-path depth from the sources (the Sugiyama column, exactly as Tidy computes it) — cycle-guarded. */
export function longestPathDepth(design: LayoutDesign): Record<string, number> {
  const ids = design.nodes.map((n) => n.id);
  const idset = new Set(ids);
  const depth: Record<string, number> = {};
  for (const id of ids) depth[id] = 0;
  const es = design.wires.filter((w) => idset.has(w.from[0]) && idset.has(w.to[0]) && w.from[0] !== w.to[0]);
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const w of es) {
      const nl = (depth[w.from[0]] ?? 0) + 1;
      if (nl > (depth[w.to[0]] ?? 0)) {
        depth[w.to[0]] = nl;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return depth;
}

/** Forward adjacency (source → targets) and reverse adjacency (target → sources) over the wires. */
export function adjacency(design: LayoutDesign): { fwd: Map<string, string[]>; rev: Map<string, string[]> } {
  const fwd = new Map<string, string[]>();
  const rev = new Map<string, string[]>();
  for (const w of design.wires) {
    if (w.from[0] === w.to[0]) continue; // a self-loop is not a placement edge
    (fwd.get(w.from[0]) ?? fwd.set(w.from[0], []).get(w.from[0])!).push(w.to[0]);
    (rev.get(w.to[0]) ?? rev.set(w.to[0], []).get(w.to[0])!).push(w.from[0]);
  }
  return { fwd, rev };
}

/**
 * The LANE partition — one member list per explicit group (declaration order, restricted to nodes that exist),
 * then one final lane for the ungrouped remainder. This is the SAME horizontal-band partition Tidy and the semantic
 * pass use (H4, §2.1): a group is a placement band, so any transform that respects lanes keeps members inside their
 * group box. Shared here so every stage (semantic shaping, the R2 refinements) computes lanes ONE way and can never
 * drift. Empty groups are dropped; a design with no groups yields a single all-nodes lane.
 */
export function lanePartition(design: LayoutDesign): string[][] {
  const idset = new Set(design.nodes.map((n) => n.id));
  const grouped = new Set<string>();
  const lanes: string[][] = [];
  for (const g of design.groups) {
    const members = g.members.filter((m) => idset.has(m));
    if (members.length === 0) continue;
    for (const m of members) grouped.add(m);
    lanes.push(members);
  }
  const ungrouped = design.nodes.map((n) => n.id).filter((id) => !grouped.has(id));
  if (ungrouped.length > 0) lanes.push(ungrouped);
  return lanes;
}

/** One structural request flow: a traffic ORIGIN, the nodes reachable from it, and its deepest TERMINAL. Mirrors
 *  content's `requestFlows` (source → reachable set → terminal) but PURELY STRUCTURALLY — no solved latency needed,
 *  so the layout can decompose lanes before (or without) a solve. */
export interface LayoutFlow {
  readonly source: string;
  readonly terminal: string;
  readonly ids: readonly string[];
}

/**
 * Decompose the design into structural flows — one per traffic ORIGIN (doc §4.1: flows → lanes). An origin is a
 * topological source (no inbound wire), OR a `client.*` node, OR a declared `originRate > 0` emitter. Each origin's
 * flow is everything reachable from it along wire direction; its terminal is the deepest reachable node by
 * longest-path depth (tie-broken by id). A node reached by no origin (a pure cycle) seeds its own flow, so every
 * node is covered — exactly the coverage guarantee content's `requestFlows` gives.
 */
export function layoutFlows(design: LayoutDesign): LayoutFlow[] {
  const { fwd } = adjacency(design);
  const order = new Map(design.nodes.map((n, i) => [n.id, i] as const));
  const depth = longestPathDepth(design);
  const hasIn = new Set(design.wires.filter((w) => w.from[0] !== w.to[0]).map((w) => w.to[0]));
  const isOrigin = (n: LayoutNode): boolean =>
    !hasIn.has(n.id) || (n.type ?? '').startsWith('client') || (n.originRate ?? 0) > 0;
  const reachFrom = (o: string): string[] => {
    const seen = new Set<string>([o]);
    const stack = [o];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const m of fwd.get(cur) ?? []) if (!seen.has(m)) {
        seen.add(m);
        stack.push(m);
      }
    }
    return [...seen].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  };

  const flows: LayoutFlow[] = [];
  const covered = new Set<string>();
  const seed = (id: string): void => {
    const ids = reachFrom(id);
    for (const r of ids) covered.add(r);
    const terminal = ids.reduce((best, cur) => {
      const db = depth[best] ?? 0;
      const dc = depth[cur] ?? 0;
      return dc > db || (dc === db && cur < best) ? cur : best;
    }, ids[0] ?? id);
    flows.push({ source: id, terminal, ids });
  };
  for (const n of design.nodes) if (isOrigin(n)) seed(n.id);
  for (const n of design.nodes) if (!covered.has(n.id)) seed(n.id); // coverage: a pure cycle seeds itself
  return flows;
}

// ── Determinism: content hash ──────────────────────────────────────────────────────────────────────────────────

/**
 * A 32-bit content hash of the design's STRUCTURE (sorted node ids+types, sorted wires, group membership) — the
 * seed the search is a pure function of (doc §5.2: same design + same seed → byte-identical layout). FNV-1a over a
 * canonical string, so it is stable across runs and platforms and independent of object insertion order.
 */
export function designHash(design: LayoutDesign): number {
  const parts: string[] = [];
  for (const n of [...design.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    // Declared CATALOG ports are part of the structure (they move every anchor), so they enter the hash — in
    // manifest order, which is identity-bearing (R5). A node without declared ports hashes exactly as before.
    const ports = n.ports !== undefined && n.ports.length > 0 ? `:${n.ports.map((p) => `${p.name}.${p.dir}`).join('+')}` : '';
    parts.push(`n:${n.id}:${n.type ?? ''}${ports}`);
  }
  const wireKey = (w: LayoutWire): string => `${w.from[0]}.${w.from[1]}>${w.to[0]}.${w.to[1]}:${w.semantics ?? 'sync'}`;
  for (const w of [...design.wires].map(wireKey).sort()) parts.push(`w:${w}`);
  for (const g of [...design.groups].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    parts.push(`g:${g.id}:${[...g.members].sort().join(',')}`);
  }
  return fnv1a(parts.join('|'));
}

/** FNV-1a 32-bit string hash — deterministic, platform-independent, non-cryptographic. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — the SAME seeded PRNG content's uncertainty module uses (doc §5.2). Same seed ⇒ same stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Primitive geometry (the objective scores on these) ───────────────────────────────────────────────────────

/** Do two segments p1p2 and p3p4 PROPERLY cross — intersect at a point interior to BOTH (shared endpoints, the way
 *  wires leaving one node meet, do NOT count)? General orientation test with a strict-interior guard. */
export function segmentsProperlyCross(p1: Pos, p2: Pos, p3: Pos, p4: Pos): boolean {
  const o = (a: Pos, b: Pos, c: Pos): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = o(p3, p4, p1);
  const d2 = o(p3, p4, p2);
  const d3 = o(p1, p2, p3);
  const d4 = o(p1, p2, p4);
  // Strictly opposite signs on both segments ⇒ a proper interior crossing (collinear/touching endpoints excluded).
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Do two polylines cross at any interior point? (Any segment of A properly crosses any segment of B.) */
export function polylinesCross(a: readonly Pos[], b: readonly Pos[]): boolean {
  for (let i = 1; i < a.length; i++) {
    const a0 = a[i - 1];
    const a1 = a[i];
    if (a0 === undefined || a1 === undefined) continue;
    for (let j = 1; j < b.length; j++) {
      const b0 = b[j - 1];
      const b1 = b[j];
      if (b0 === undefined || b1 === undefined) continue;
      if (segmentsProperlyCross(a0, a1, b0, b1)) return true;
    }
  }
  return false;
}

/** Total arc length of a polyline. */
export function polylineLength(points: readonly Pos[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) continue;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** Do two axis-aligned boxes overlap when each is inflated by `m` (H2 no-overlap; strict interiors)? */
export function boxesOverlap(a: Rect, b: Rect, m = 0): boolean {
  return a.x - m < b.x + b.w + m && b.x - m < a.x + a.w + m && a.y - m < b.y + b.h + m && b.y - m < a.y + a.h + m;
}

/** Does an orthogonal/any segment pass through a box interior (strict)? — H1: a wire must never cut a non-endpoint
 *  node. Mirrors the router's own `segmentBlocked` interior test. */
export function segmentHitsBox(p: Pos, q: Pos, b: Rect): boolean {
  const L = b.x;
  const R = b.x + b.w;
  const T = b.y;
  const B = b.y + b.h;
  if (p.y === q.y) {
    if (!(p.y > T && p.y < B)) return false;
    const s = Math.min(p.x, q.x);
    const e = Math.max(p.x, q.x);
    return s < R && L < e;
  }
  if (p.x === q.x) {
    if (!(p.x > L && p.x < R)) return false;
    const s = Math.min(p.y, q.y);
    const e = Math.max(p.y, q.y);
    return s < B && T < e;
  }
  for (let t = 0; t <= 1; t += 0.02) {
    const x = p.x + (q.x - p.x) * t;
    const y = p.y + (q.y - p.y) * t;
    if (x > L && x < R && y > T && y < B) return true;
  }
  return false;
}

/** Does a polyline pass through a box interior? */
export function polylineHitsBox(points: readonly Pos[], b: Rect): boolean {
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1];
    const q = points[i];
    if (p !== undefined && q !== undefined && segmentHitsBox(p, q, b)) return true;
  }
  return false;
}

// ── Edge SEPARATION geometry (traceability) — the primitives the objective's separation terms score on ──────────
//
// OWNER FIELD-TEST (HEAD 4e9152f): the IDEAL layout packed TIGHTER than Tidy yet OVERLAPPED lines MORE. His stated
// aesthetic: "each line traceable by eye from source almost to target; separate corridors; edges may converge only
// near the shared destination port, AS LATE AS POSSIBLE." Traceability is a ROUTED-geometry property — two wires
// laid within a few px of the same axis read as ONE line — so it is measured here on the real routed polylines,
// exactly like crossings/length (the router is the arbiter, §2). This is precisely what production engines score:
//   • libavoid's final stage "orders and NUDGES APART the connectors in shared segments so as to ensure that
//     unnecessary crossings are not introduced" (Wybrow, Marriott & Stuckey, "Orthogonal Connector Routing", GD
//     2009) — the LGPL router React-Flow-Pro wraps; we re-implement its separation in pure TS (edge-routing.ts).
//   • VLSI channel routing assigns overlapping nets to distinct parallel TRACKS (the left-edge algorithm, Hashimoto
//     & Stevens 1971): each segment is an interval, overlapping intervals get different tracks, #tracks = density.
//   • yFiles' EdgeRouter enforces "a preferred minimum distance between any two edge segments"; ELK layered widens
//     the inter-layer channel with the edge count (spacing.edgeEdgeBetweenLayers). graphviz `concentrate` MERGES
//     parallels early — the anti-pattern we reject: we keep corridors apart and merge only at the shared stub.

/** MERGE_TOL — two same-axis segments within this many px of the same line read as ONE wire (a traceability-killing
 *  overlap, not two distinct tracks). Matches the router's default separation gap floor. */
export const MERGE_TOL = 4;

/** A routed segment's axis: 'h' (constant y), 'v' (constant x), or null (degenerate / diagonal — routed wires are
 *  axis-aligned, so a diagonal never occurs, and a zero-length segment is inert). */
export function segmentAxis(p: Pos, q: Pos): 'h' | 'v' | null {
  if (p.x === q.x && p.y === q.y) return null;
  if (p.y === q.y) return 'h';
  if (p.x === q.x) return 'v';
  return null;
}

/** The 1-D overlap of [a0,a1] and [b0,b1] on the real line (0 when they do not overlap). */
function spanOverlap(a0: number, a1: number, b0: number, b1: number): number {
  const lo = Math.max(Math.min(a0, a1), Math.min(b0, b1));
  const hi = Math.min(Math.max(a0, a1), Math.max(b0, b1));
  return Math.max(0, hi - lo);
}

/**
 * The length over which segments a(a0→a1) and b(b0→b1) run COLLINEAR — same axis, their perpendicular offset within
 * `tol` (they read as one line), and their spans overlapping. 0 otherwise. This is the overlap that destroys
 * traceability (two wires drawn on top of each other); the objective's `overlap` term sums it over all edge pairs.
 */
export function collinearOverlapLength(a0: Pos, a1: Pos, b0: Pos, b1: Pos, tol = MERGE_TOL): number {
  const ax = segmentAxis(a0, a1);
  const bx = segmentAxis(b0, b1);
  if (ax === null || bx === null || ax !== bx) return 0;
  if (ax === 'h') return Math.abs(a0.y - b0.y) <= tol ? spanOverlap(a0.x, a1.x, b0.x, b1.x) : 0;
  return Math.abs(a0.x - b0.x) <= tol ? spanOverlap(a0.y, a1.y, b0.y, b1.y) : 0;
}

/**
 * The perpendicular GAP between two PARALLEL same-axis segments whose spans overlap — i.e. two runs sharing a
 * corridor on DISTINCT tracks. Returns null when they are not parallel-overlapping. Used by the `spacing` term to
 * flag tracks packed closer than the minimum readable gap (yFiles' "minimum distance between two edge segments").
 */
export function parallelTrackGap(a0: Pos, a1: Pos, b0: Pos, b1: Pos): number | null {
  const ax = segmentAxis(a0, a1);
  const bx = segmentAxis(b0, b1);
  if (ax === null || bx === null || ax !== bx) return null;
  if (ax === 'h') return spanOverlap(a0.x, a1.x, b0.x, b1.x) > 0 ? Math.abs(a0.y - b0.y) : null;
  return spanOverlap(a0.y, a1.y, b0.y, b1.y) > 0 ? Math.abs(a0.x - b0.x) : null;
}
