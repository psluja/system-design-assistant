import type { Pos, Size } from './layout';
import {
  type LayoutDesign,
  type Placement,
  DEFAULT_NODE_SIZE,
  ROW_PITCH,
  designPorts,
  dominantAnchors,
  lanePartition,
  longestPathDepth,
  wireAnchorOffsets,
} from './layout-model';

// @algorithm Deterministic layout refinements (column compaction, Reingold-Tilford centering, anchor snap)
// @problem Close the aggregate-score gap to generic compaction engines (dagre/ELK): Tidy's fixed
//   340px columns waste wire length/area and fan-outs are not straddled symmetrically.
// @approach Three pure candidate GENERATORS the beam scores and floors at Tidy: compactColumns
//   (per-rank X tightening, pitch = widest node + routing gutter, X-only so lanes/groups hold);
//   symmetrizeFanouts (Reingold-Tilford downstream-centering — a parent centers on the mean of its
//   children's per-wire anchor pulls, run per lane so H4 holds); snapToAnchors (re-seat rows exactly
//   on the dominant wire's port-anchor line where separation allows).
// @complexity O(V + E) per generator pass (rank scans + per-wire pulls); no search of its own.
// @citations Reingold & Tilford, "Tidier Drawings of Trees", IEEE TSE 7(2), 1981 (the centering
//   discipline, applied lane-aware to DAG fan-outs).
// @invariants Pure and deterministic; compaction only tightens, never expands, and never moves a
//   pinned column; Y-bands (and thus group boxes) are preserved by compaction; generators only
//   PROPOSE — feasibility and acceptance are the objective's job.
// @where-tested app/presenter/src/layout-refine.test.ts

// THE IDEAL LAYOUT — the R2 DETERMINISTIC REFINEMENTS (doc: ideal-layout §3, R2). R1 proved the honest gap: the
// semantic seed keeps Tidy's WIDE 340px columns and cannot mirror a fan-out, so a generic compaction engine (dagre)
// still edged the aggregate on the ungrouped DAGs (cqrs 0.836 vs 0.860) — losing on wire LENGTH/AREA (Tidy's slack
// columns) and SYMMETRY (fan-outs not straddled). This module closes both, as two PURE candidate generators the
// beam scores on real routes and floors at Tidy (never forced — a transform that would hurt a design is simply not
// kept):
//   • {@link compactColumns} — per-rank X tightening, node-size-aware (each column's pitch = its widest node + a
//     routing gutter, not a fixed 340), so wire length + area fall to the generic engines' level. Compaction only
//     ever TIGHTENS (never expands), respects pins (a column holding a pinned node is immovable), and keeps lanes
//     (it moves X only — every Y-band, and thus every group box, is preserved).
//   • {@link symmetrizeFanouts} — a Reingold–Tilford downstream-centering (a parent centres on the mean of its
//     children's per-WIRE anchor pulls) that makes sibling branches straddle their fan-out (symmetry → 0 on a
//     tree). GROUP-AWARE: it runs PER LANE with only intra-lane edges and re-seats each lane in its own vertical
//     band, so a member never leaves its group (H4) — the feasibility a blind global centering would break.
//   • {@link snapToAnchors} (R5) — the exact port-collinearity pass: re-seats rows onto the dominant wire's PORT
//     anchor line wherever separation allows, so near-aligned rows become the ONE straight segment the router's
//     fast path draws.
//
// All are pure, deterministic, and dependency-free (local types only), exactly like the semantic pass they extend.
// Feasibility is the OBJECTIVE's job: the beam routes and scores every candidate, so an over-tight compaction (H1/H2)
// or a lane-crossing centering is rejected there — these generators only propose.

/** The default horizontal gutter (px) left between one column's widest node and the next column's left edge — the
 *  channel the orthogonal router threads vertical wire runs through. ~100px keeps the column pitch near dagre's
 *  (160 node + 100 ≈ 260) while leaving the router room; the search also tries tighter/looser gutters. */
export const DEFAULT_COMPACT_GUTTER = 100;

/** The gutters the R2 search seeds compacted candidates at (px). A tight pack (60), a dagre-like pitch (100), and a
 *  roomy one (160) — the beam keeps whichever routes best per design (a dense graph needs more channel; a sparse one
 *  compacts hard). Fixed + ordered so the schedule stays a pure function of the design (§5.2). */
export const COMPACT_GUTTERS: readonly number[] = [60, 100, 160];

const widthOf = (id: string, sizeMap: Readonly<Record<string, Size>>): number => sizeMap[id]?.w ?? DEFAULT_NODE_SIZE.w;
const heightOf = (id: string, sizeMap: Readonly<Record<string, Size>>): number => sizeMap[id]?.h ?? DEFAULT_NODE_SIZE.h;

/** Group a placement's nodes into columns keyed by their (rounded) X, returned left-to-right with each column's
 *  member ids. The layout is column-quantised (Tidy/semantic place every node in a longest-path column), so equal
 *  X = same rank. */
function columnsOf(design: LayoutDesign, placement: Placement): { key: number; ids: string[] }[] {
  const byX = new Map<number, string[]>();
  for (const n of design.nodes) {
    const at = placement[n.id];
    if (at === undefined) continue;
    const key = Math.round(at.x);
    (byX.get(key) ?? byX.set(key, []).get(key)!).push(n.id);
  }
  return [...byX.keys()].sort((a, b) => a - b).map((key) => ({ key, ids: byX.get(key)! }));
}

/** The per-track separation gap (px), matched to the router's default so a channel floored at `tracks × gap` holds
 *  exactly the parallel tracks the router will nudge into it. Kept here (not imported) so layout-refine stays
 *  dependency-free on edge-routing. */
export const TRACK_GAP = 12;

export interface CompactOptions {
  /** Horizontal channel (px) between a column's widest node and the next column. Default {@link DEFAULT_COMPACT_GUTTER}. */
  readonly gutter?: number;
  /** Hand-placed nodes (H5): a column that contains one is IMMOVABLE — its X is held and the compaction resumes
   *  from it, so the optimiser never drags a pinned node's rank. */
  readonly pins?: ReadonlySet<string>;
  /** Per-track separation gap for the corridor-width FLOOR (px). Default {@link TRACK_GAP}. */
  readonly gap?: number;
}

/** How many wires cross each inter-column boundary — the number of parallel tracks that channel must hold. Boundary
 *  `k` (between columns k−1 and k) is crossed by a wire whose endpoints sit on opposite sides of it. This is the
 *  corridor DENSITY (VLSI channel routing): the channel needs at least this many tracks, so compaction may not
 *  squeeze it below `density × gap` (the hard floor — tightness never buys a line-on-line overlap). */
function boundaryDensities(design: LayoutDesign, columns: readonly { key: number; ids: string[] }[]): number[] {
  const colOf = new Map<string, number>();
  columns.forEach((c, i) => c.ids.forEach((id) => colOf.set(id, i)));
  const density = new Array<number>(columns.length).fill(0);
  for (const w of design.wires) {
    if (w.from[0] === w.to[0]) continue;
    const s = colOf.get(w.from[0]);
    const t = colOf.get(w.to[0]);
    if (s === undefined || t === undefined) continue;
    const lo = Math.min(s, t);
    const hi = Math.max(s, t);
    for (let k = lo + 1; k <= hi; k++) density[k]!++; // wire spans boundaries (lo, hi]
  }
  return density;
}

/**
 * RANK COMPACTION (doc §2.3, the length/area gap): re-seat every column's X left-to-right so its pitch is the
 * PREVIOUS column's widest node + a routing gutter, instead of Tidy's fixed 340. Node-size-aware (a column of
 * narrow nodes packs tighter than one of wide meters), lane-preserving (Y is untouched, so group bands are intact),
 * pin-respecting (a pinned column is frozen), and TIGHTEN-ONLY (a column is never pushed right of where it already
 * sits — compaction can only shrink the diagram, never inflate it). Pure and deterministic.
 */
export function compactColumns(
  design: LayoutDesign,
  placement: Placement,
  sizeMap: Readonly<Record<string, Size>>,
  opts?: CompactOptions,
): Placement {
  const gutter = opts?.gutter ?? DEFAULT_COMPACT_GUTTER;
  const gap = opts?.gap ?? TRACK_GAP;
  const pins = opts?.pins ?? EMPTY_PINS;
  const columns = columnsOf(design, placement);
  if (columns.length === 0) return placement;
  const density = boundaryDensities(design, columns);

  const newX = new Map<number, number>();
  let cursor = columns[0]!.key; // the leftmost column keeps its origin (compaction anchors on the left margin)
  newX.set(columns[0]!.key, cursor);
  for (let i = 1; i < columns.length; i++) {
    const col = columns[i]!;
    const pinned = col.ids.find((id) => pins.has(id));
    if (pinned !== undefined) {
      cursor = Math.round(placement[pinned]!.x); // an immovable column: hold its X, resume compaction from it
      newX.set(col.key, cursor);
      continue;
    }
    const prevWidth = Math.max(...columns[i - 1]!.ids.map((id) => widthOf(id, sizeMap)));
    // The channel entering column i must hold `density[i]` parallel tracks — a HARD floor (density × gap) compaction
    // may not squeeze below, so tightening never forces the router to overlap wires (traceability > compactness).
    const channel = Math.max(gutter, density[i]! * gap);
    cursor = Math.min(cursor + prevWidth + channel, col.key); // tighten-only: never expand past the original X
    newX.set(col.key, cursor);
  }

  const out: Record<string, Pos> = { ...placement };
  for (const col of columns) {
    const nx = newX.get(col.key)!;
    for (const id of col.ids) out[id] = { x: nx, y: placement[id]!.y };
  }
  return out;
}

const SYMMETRIZE_ITERS = 24;
/** Vertical gap (px) kept between two stacked lanes when symmetrization re-seats them — matches the semantic pass's
 *  lane gap so the two shaping passes quantise to the same vertical rhythm. */
const LANE_GAP = 64;

export interface SymmetrizeOptions {
  /** Hand-placed nodes (H5) held at their current Y — the centering lays out only the free nodes around them. */
  readonly pins?: ReadonlySet<string>;
}

/**
 * FAN-OUT SYMMETRIZATION (doc §2.2 symmetry, §2.3): a Reingold–Tilford-style downstream-centering that makes
 * sibling branches straddle their parent. It sweeps columns RIGHT→LEFT setting each node's row to the MEAN of its
 * child-wires' collinear targets (a fan-out's parent lands exactly between its branches ⇒ mirrored), then resolves
 * each column's overlaps with a MEAN-PRESERVING separation (so the straddle survives). X is untouched.
 *
 * PORT-CENTRIC ROWS (R5, owner nuance — same law as the semantic pass): the row variable is each node's DOMINANT
 * connected-port anchor Y (layout-model `dominantAnchors`), and each parent→child WIRE pulls toward the value
 * that makes ITS two port anchors collinear (`wireAnchorOffsets` — the router's own anchor geometry), so a centred
 * parent's wires leave on rows the router can draw straight. For single-port nodes (anchor = centre, one wire per
 * child) this reduces to the old centre-based centering bit-for-bit.
 *
 * GROUP-AWARE: it runs PER LANE ({@link lanePartition}) using only that lane's internal edges, and re-seats each
 * lane inside its ORIGINAL vertical band (same top edge, same order), so a member never drifts out of its group box
 * (H4) — the feasibility a blind global centering breaks. Pins are held at their current Y. Pure + deterministic.
 */
export function symmetrizeFanouts(
  design: LayoutDesign,
  placement: Placement,
  sizeMap: Readonly<Record<string, Size>>,
  opts?: SymmetrizeOptions,
): Placement {
  const pins = opts?.pins ?? EMPTY_PINS;
  const depth = longestPathDepth(design);
  const out: Record<string, Pos> = { ...placement };

  // The shared port-anchor geometry (layout-model, ONE form with the router): offOf = dominant-port anchor offset
  // per node (top(n) = row(n) − offOf(n)); per parent→child wire, `delta` is the bias difference that makes that
  // wire's two anchors collinear (0 when the wire rides both dominant ports — the common single-port case).
  const ports = designPorts(design);
  const anchors = dominantAnchors(design, sizeMap, ports);
  const offOf = (id: string): number => anchors.get(id)?.offset ?? heightOf(id, sizeMap) / 2;
  const wireOff = wireAnchorOffsets(design, sizeMap, ports);
  const childPulls = new Map<string, { kid: string; delta: number }[]>();
  design.wires.forEach((w, i) => {
    if (w.from[0] === w.to[0]) return;
    const biasF = offOf(w.from[0]) - wireOff[i]!.source;
    const biasT = offOf(w.to[0]) - wireOff[i]!.target;
    (childPulls.get(w.from[0]) ?? childPulls.set(w.from[0], []).get(w.from[0])!).push({ kid: w.to[0], delta: biasF - biasT });
  });

  // Shape each lane independently (downstream-centering + mean-preserving separation), recording its symmetrised
  // anchor-Ys and its local vertical extent + original top (the stacking key).
  interface ShapedLane {
    readonly members: readonly string[];
    readonly ay: ReadonlyMap<string, number>;
    readonly originalTop: number;
    readonly localTop: number;
    readonly localBot: number;
  }
  const shaped: ShapedLane[] = [];
  for (const laneMembers of lanePartition(design)) {
    const members = laneMembers.filter((m) => placement[m] !== undefined);
    if (members.length === 0) continue;
    const inLane = new Set(members);
    const ay = new Map<string, number>();
    let originalTop = Number.POSITIVE_INFINITY;
    for (const id of members) {
      ay.set(id, placement[id]!.y + offOf(id));
      originalTop = Math.min(originalTop, placement[id]!.y);
    }
    const byCol = new Map<number, string[]>();
    for (const id of members) {
      const c = depth[id] ?? 0;
      (byCol.get(c) ?? byCol.set(c, []).get(c)!).push(id);
    }
    const cols = [...byCol.keys()].sort((a, b) => a - b);
    const seedY = new Map(members.map((id) => [id, ay.get(id)!] as const)); // stable within-column order key

    for (let iter = 0; iter < SYMMETRIZE_ITERS; iter++) {
      // Downstream centring, deepest column first: a parent sits at the mean of its child-WIRES' collinear targets
      // (each wire pulls toward the row that makes its two port anchors one straight line).
      for (let ci = cols.length - 1; ci >= 0; ci--) {
        for (const id of byCol.get(cols[ci]!)!) {
          if (pins.has(id)) continue;
          const pulls = (childPulls.get(id) ?? []).filter((p) => inLane.has(p.kid));
          if (pulls.length === 0) continue;
          ay.set(id, pulls.reduce((s, p) => s + ay.get(p.kid)! + p.delta, 0) / pulls.length);
        }
      }
      // Mean-preserving separation within each column (keeps the straddle; never reorders, so no new crossings).
      // The anchor gap clears the BOXES: prev's below-anchor extent + this one's above-anchor extent + pitch air.
      for (const c of cols) {
        const arr = byCol
          .get(c)!
          .slice()
          .sort((a, b) => seedY.get(a)! - seedY.get(b)! || (a < b ? -1 : 1));
        const before = arr.reduce((s, id) => s + ay.get(id)!, 0) / arr.length;
        for (let i = 1; i < arr.length; i++) {
          const prevId = arr[i - 1]!;
          const curId = arr[i]!;
          const gap =
            (heightOf(prevId, sizeMap) - offOf(prevId)) + offOf(curId) + (ROW_PITCH - DEFAULT_NODE_SIZE.h);
          if (ay.get(curId)! - ay.get(prevId)! < gap) ay.set(curId, ay.get(prevId)! + gap);
        }
        const after = arr.reduce((s, id) => s + ay.get(id)!, 0) / arr.length;
        const shift = before - after;
        for (const id of arr) ay.set(id, ay.get(id)! + shift);
      }
    }
    let localTop = Number.POSITIVE_INFINITY;
    let localBot = Number.NEGATIVE_INFINITY;
    for (const id of members) {
      const top = ay.get(id)! - offOf(id);
      localTop = Math.min(localTop, top);
      localBot = Math.max(localBot, top + heightOf(id, sizeMap));
    }
    shaped.push({ members, ay, originalTop, localTop, localBot });
  }

  // RE-STACK the lanes in their original top-to-bottom order (H4 feasibility): symmetrization can grow a lane's
  // height, so a naive "keep the top edge" would let a taller lane overflow into the next one. Stacking each lane
  // below the previous with a fixed gap — exactly as the semantic pass does — guarantees lanes never overlap, so a
  // group band never swallows a foreign node. The whole block keeps its original vertical origin.
  const order = shaped.slice().sort((a, b) => a.originalTop - b.originalTop);
  let cursor = order.reduce((m, l) => Math.min(m, l.originalTop), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(cursor)) cursor = 0;
  for (const lane of order) {
    for (const id of lane.members) {
      if (pins.has(id)) continue; // a pin keeps its stored Y exactly
      out[id] = { x: placement[id]!.x, y: cursor + (lane.ay.get(id)! - offOf(id) - lane.localTop) };
    }
    cursor += lane.localBot - lane.localTop + LANE_GAP;
  }
  return out;
}

export interface SnapOptions {
  /** Hand-placed nodes (H5) held at their current Y — never snapped. */
  readonly pins?: ReadonlySet<string>;
}

/**
 * ANCHOR SNAP (R5, port-centric alignment) — the third pure candidate generator: re-seat each node's Y so a wire's
 * two PORT anchors are EXACTLY collinear (layout-model `dominantAnchors` + `wireAnchorOffsets`, the router's own
 * geometry), wherever the column's vertical order and box separation still hold. Damped smoothing and beam moves
 * leave rows a few px off the anchor line — inside the objective's ε yet outside the router's 4px snap — so
 * "aligned" rows still routed as Zs; this pass turns near-alignment into the exact collinearity the router's
 * straight-line fast path cashes as ONE segment. Each node tries its snap candidates in DETERMINISTIC priority —
 * the wires riding its DOMINANT port first (the heaviest wire / first port), then its remaining wires, all in wire
 * order — and takes the FIRST line the separation guard admits: a node blocked off its primary line (a one-port
 * fan-out's two targets cannot both hold its row) still lands exactly on its next one. X is untouched (columns
 * stay put); lanes (H4) bound the snap partners; a snap that would break a group band is simply an infeasible
 * PROPOSAL the objective rejects. Deterministic: fixed sweeps over columns keyed by X, members in current-Y order.
 */
export function snapToAnchors(
  design: LayoutDesign,
  placement: Placement,
  sizeMap: Readonly<Record<string, Size>>,
  opts?: SnapOptions,
): Placement {
  const pins = opts?.pins ?? EMPTY_PINS;
  const ports = designPorts(design);
  const anchors = dominantAnchors(design, sizeMap, ports);
  const offOf = (id: string): number => anchors.get(id)?.offset ?? heightOf(id, sizeMap) / 2;
  const wireOff = wireAnchorOffsets(design, sizeMap, ports);
  const out: Record<string, Pos> = { ...placement };
  const ay = new Map<string, number>(); // the row variable: each node's dominant ANCHOR Y
  for (const n of design.nodes) {
    const at = placement[n.id];
    if (at !== undefined) ay.set(n.id, at.y + offOf(n.id));
  }

  // Each node's snap CANDIDATES, restricted to partners in the SAME lane (H4 — never chase a node across a group
  // band), in priority order: dominant-port wires first, then the rest (stable sort keeps wire order per class).
  const laneOf = new Map<string, number>();
  lanePartition(design).forEach((lane, i) => lane.forEach((id) => laneOf.set(id, i)));
  const candidates = new Map<string, { peer: string; deltaPx: number; dominant: boolean }[]>();
  const push = (id: string, entry: { peer: string; deltaPx: number; dominant: boolean }): void => {
    (candidates.get(id) ?? candidates.set(id, []).get(id)!).push(entry);
  };
  design.wires.forEach((w, i) => {
    if (w.from[0] === w.to[0]) return;
    if (laneOf.get(w.from[0]) !== laneOf.get(w.to[0])) return;
    if (!ay.has(w.from[0]) || !ay.has(w.to[0])) return;
    const biasF = offOf(w.from[0]) - wireOff[i]!.source;
    const biasT = offOf(w.to[0]) - wireOff[i]!.target;
    const fDom = anchors.get(w.from[0])?.port;
    const tDom = anchors.get(w.to[0])?.port;
    push(w.from[0], { peer: w.to[0], deltaPx: biasF - biasT, dominant: fDom !== undefined && fDom.side === 'out' && fDom.name === w.from[1] });
    push(w.to[0], { peer: w.from[0], deltaPx: biasT - biasF, dominant: tDom !== undefined && tDom.side === 'in' && tDom.name === w.to[1] });
  });
  for (const list of candidates.values()) list.sort((a, b) => Number(b.dominant) - Number(a.dominant));

  // Columns keyed by rounded X (the placement is column-quantised), members in current-Y order; the same box-aware
  // separation guard as the row passes, so a snap never creates an overlap and never reorders a column.
  const columns = columnsOf(design, placement).map((c) =>
    c.ids.filter((id) => ay.has(id)).sort((a, b) => ay.get(a)! - ay.get(b)! || (a < b ? -1 : 1)),
  );
  const gapBetween = (prevId: string, curId: string): number =>
    (heightOf(prevId, sizeMap) - offOf(prevId)) + offOf(curId) + (ROW_PITCH - DEFAULT_NODE_SIZE.h);
  for (let pass = 0; pass < SNAP_SWEEPS; pass++) {
    for (const arr of columns) {
      for (let i = 0; i < arr.length; i++) {
        const id = arr[i]!;
        if (pins.has(id)) continue;
        const prev = i > 0 ? arr[i - 1]! : undefined;
        const next = i + 1 < arr.length ? arr[i + 1]! : undefined;
        for (const s of candidates.get(id) ?? []) {
          const target = ay.get(s.peer)! + s.deltaPx;
          if (prev !== undefined && target - ay.get(prev)! < gapBetween(prev, id)) continue;
          if (next !== undefined && ay.get(next)! - target < gapBetween(id, next)) continue;
          ay.set(id, target);
          break; // first admissible line in priority order wins
        }
      }
    }
  }
  for (const n of design.nodes) {
    const at = placement[n.id];
    if (at === undefined || pins.has(n.id)) continue;
    out[n.id] = { x: at.x, y: ay.get(n.id)! - offOf(n.id) };
  }
  return out;
}

const SNAP_SWEEPS = 4;

const EMPTY_PINS: ReadonlySet<string> = new Set<string>();
