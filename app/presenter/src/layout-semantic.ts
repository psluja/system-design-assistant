import type { Group } from '@sda/core';
import type { Pos, Size } from './layout';
import { tidyLayout } from './layout';
import { snapToAnchors } from './layout-refine';
import {
  type LayoutDesign,
  type Placement,
  COL0,
  COLW,
  DEFAULT_NODE_SIZE,
  ROW0,
  ROW_PITCH,
  designPorts,
  dominantAnchors,
  lanePartition,
  longestPathDepth,
  sizeOf,
  wireAnchorOffsets,
} from './layout-model';

// @algorithm Damped iterative barycenter row smoothing in port-anchor space (the semantic pass)
// @problem Tidy centers each column independently, so chains zig-zag and connected port anchors sit
//   a few px off collinear — alignment a stochastic search would spend its whole budget rediscovering.
// @approach One deterministic pass: keep Tidy's longest-path columns, partition into lanes, then run
//   16 iterations of damped barycenter smoothing where each node's row value is its DOMINANT
//   connected-port anchor Y and each wire pulls its two endpoint anchors collinear; finish with the
//   shared snapToAnchors generator because damped smoothing converges only asymptotically.
// @complexity O(SMOOTH_ITERS * E) per lane (16 fixed iterations over the wires), plus the O(V + E)
//   snap pass.
// @citations Sugiyama, Tagawa & Toda 1981 (barycenter ordering); damped iterative relaxation
//   folklore (Gauss-Seidel style smoothing).
// @invariants Deterministic, no randomness, no GPU; single-port nodes reduce bit-for-bit to center
//   smoothing; lanes (group membership) are never crossed; output only SEEDS the search — the
//   objective accepts or rejects.
// @where-tested app/presenter/src/layout-semantic.test.ts

// THE IDEAL LAYOUT — the SEMANTIC PASS (doc: ideal-layout §3.2, §4). Before any stochastic search, a single
// DETERMINISTIC pass rewrites the Tidy seed using the meaning Tidy ignores: it keeps Tidy's columns (longest-path
// depth = the role/flow gradient left→right, which already reads 0-crossings on the committed DAGs) and REPLACES
// Tidy's independent per-column centering with a shared, laned ROW grid. The result: chains straighten onto one
// horizontal lane, connected PORT ANCHORS snap collinear across each wire (block alignment the router can cash in
// as ONE straight segment), and sibling branches settle symmetric about their fan-out — the alignment/lane/symmetry
// gains that make us best (§2.3), captured with NO randomness and NO GPU. Pure, cheap, reproducible; it seeds the
// search that follows.
//
// PORT-CENTRIC ROWS (R5, owner nuance). Rows used to align node CENTRES, but a wire anchors at PORT fractions of
// its two nodes (layout-model `portFraction` — the same geometry the router routes with), so on variable-height /
// multi-port nodes "aligned" centres still broke lines. The smoother therefore works in ANCHOR space: each node's
// row value is its DOMINANT connected-port anchor Y (layout-model `dominantAnchors` — heaviest wire, first port on
// ties, deterministic), and each wire pulls its two endpoint ANCHORS collinear via the per-wire offsets
// (`wireAnchorOffsets`). A node's row offset is then exactly what makes its dominant port collinear with the
// peer's. For single-port nodes (anchor = centre) this reduces to the old centre smoothing bit-for-bit. And
// because damped smoothing only converges ASYMPTOTICALLY — rows settling a few px off the line, inside the
// objective's ε yet outside the router's 4px snap ("aligned" rows that still break lines) — the pass finishes with
// the shared ANCHOR SNAP generator (layout-refine `snapToAnchors`, ONE snap implementation for the whole family),
// which re-seats each node EXACTLY on the best admissible anchor line wherever the box separation still holds.
//
// GROUPS are honoured as placement bands (H4): each group (and the ungrouped remainder) is one lane, stacked exactly
// as Tidy stacks them, and rows are smoothed WITHIN a lane using its internal wires — a member never drifts out of
// its group's band. Everything is a pure function of the design, so the same design yields the byte-identical shape.

const LANE_GAP = 64;
const SMOOTH_ITERS = 16;

/**
 * The semantic layout: Tidy's columns kept, rows re-shaped into aligned lanes (port-anchor collinear, see the
 * header). Deterministic and dependency-free. `sizes` are the shell's measured node footprints (defaulting to each
 * node's declared/{@link DEFAULT_NODE_SIZE} size), passed through to Tidy so the seed matches what ships.
 */
export function semanticLayout(design: LayoutDesign, sizes?: Readonly<Record<string, Size>>): Placement {
  const size = (id: string): Size => sizes?.[id] ?? sizeOf(design.nodes.find((n) => n.id === id) ?? { id });
  const sizeMap: Record<string, Size> = {};
  for (const n of design.nodes) sizeMap[n.id] = size(n.id);

  // Stage 0 seed — Tidy, verbatim (the safety floor). Its x's are the columns we keep; its y's seed the smoother.
  const tidyGroups: Group[] = design.groups.map((g) => ({ id: g.id, label: '', rect: { x: 0, y: 0, w: 0, h: 0 }, members: g.members }));
  const seed = tidyLayout(design.nodes.map((n) => ({ id: n.id })), design.wires.map((w) => ({ from: w.from, to: w.to })), tidyGroups, sizeMap);

  // The shared port-anchor geometry (layout-model, ONE form with the router): each node's dominant-port anchor
  // offset from its top (+ WHICH port won, for the snap sweep); per wire, its source/target anchor offsets. The
  // row variable below is the dominant ANCHOR Y, so top(n) = row(n) − offOf(n) at all times.
  const ports = designPorts(design);
  const anchors = dominantAnchors(design, sizeMap, ports);
  const offOf = (id: string): number => anchors.get(id)!.offset;
  const wireOff = wireAnchorOffsets(design, sizeMap, ports);

  const depth = longestPathDepth(design);
  const anchorY = new Map<string, number>();
  for (const n of design.nodes) {
    const at = seed.pos[n.id];
    if (at !== undefined) anchorY.set(n.id, at.y + offOf(n.id));
  }

  // Internal neighbours per node, restricted to a lane's own members (so smoothing never pulls a node out of its
  // group band). Built per lane below.
  const placement: Record<string, Pos> = {};
  let laneTopY = ROW0;

  for (const laneMembers of lanePartition(design)) {
    const members = laneMembers.filter((m) => anchorY.has(m));
    if (members.length === 0) continue;
    const inLane = new Set(members);
    // A neighbour entry carries the DELTA (in lane units) that makes THIS wire's two anchors collinear: for a wire
    // F→T, top_F + off_F = top_T + off_T ⇔ row_F = row_T + (refOff_F − off_F) − (refOff_T − off_T). delta is that
    // bias difference — 0 whenever the wire rides both nodes' dominant ports (the common single-port case).
    const neighbours = new Map<string, { peer: string; delta: number }[]>();
    for (const id of members) neighbours.set(id, []);
    design.wires.forEach((w, i) => {
      if (w.from[0] === w.to[0]) return;
      if (!inLane.has(w.from[0]) || !inLane.has(w.to[0])) return;
      const biasF = offOf(w.from[0]) - wireOff[i]!.source;
      const biasT = offOf(w.to[0]) - wireOff[i]!.target;
      const d = (biasF - biasT) / ROW_PITCH;
      neighbours.get(w.from[0])!.push({ peer: w.to[0], delta: d });
      neighbours.get(w.to[0])!.push({ peer: w.from[0], delta: -d });
    });

    // Lane value = a real-valued row (the dominant ANCHOR Y in row-pitch units), seeded from the Tidy anchor.
    // Barycenter smoothing straightens chains (a degree-2 node relaxes to the mean of its two per-wire targets ⇒
    // its wires' anchors collinear) and centres fan-outs symmetrically (the parent sits at the mean of its
    // children's pulls ⇒ mirrored branches). Deterministic: a fixed iteration count over a fixed member order.
    const lane0 = new Map<string, number>();
    for (const id of members) lane0.set(id, (anchorY.get(id) ?? 0) / ROW_PITCH);
    let laneVal = lane0;
    for (let iter = 0; iter < SMOOTH_ITERS; iter++) {
      const next = new Map<string, number>();
      for (const id of members) {
        const nb = neighbours.get(id) ?? [];
        if (nb.length === 0) {
          next.set(id, laneVal.get(id) ?? 0);
          continue;
        }
        // Pull toward the mean of the per-wire collinear targets, but keep a little of the current value so an
        // unconstrained tie is stable.
        const nbMean = nb.reduce((s, e) => s + (laneVal.get(e.peer) ?? 0) + e.delta, 0) / nb.length;
        next.set(id, 0.85 * nbMean + 0.15 * (laneVal.get(id) ?? 0));
      }
      laneVal = next;
    }

    // Turn the smoothed lane value into a real anchor-Y, then resolve same-column overlaps with a MEAN-PRESERVING
    // separation: push apart until the BOXES clear (anchor gap = prev's below-anchor extent + this one's above-
    // anchor extent + the row-pitch air), then recenter the column on its original centroid. Mean preservation is
    // what keeps a fan-out's branches STRADDLING their parent (symmetric), instead of a monotonic push that stacks
    // both children below it (lopsided). A chain (constant lane value) keeps one anchor-Y across columns = a clean,
    // grid-aligned lane the router draws as straight segments. Order is preserved, so crossings are not introduced.
    const byCol = new Map<number, string[]>();
    for (const id of members) {
      const col = depth[id] ?? 0;
      (byCol.get(col) ?? byCol.set(col, []).get(col)!).push(id);
    }
    const ay = new Map<string, number>();
    for (const id of members) ay.set(id, (laneVal.get(id) ?? 0) * ROW_PITCH);
    for (const [, colNodes] of byCol) {
      // Separate in TIDY's within-column order (its barycenter order is crossing-free) so the shaping straightens
      // and symmetrises WITHOUT reordering — a reorder is exactly what would introduce a crossing. (Tidy's boxes are
      // disjoint, so ordering by the seed ANCHOR is ordering by the seed box.)
      colNodes.sort((a, b) => (anchorY.get(a) ?? 0) - (anchorY.get(b) ?? 0) || (a < b ? -1 : 1));
      const origMean = colNodes.reduce((s, id) => s + (ay.get(id) ?? 0), 0) / colNodes.length;
      for (let i = 1; i < colNodes.length; i++) {
        const prevId = colNodes[i - 1]!;
        const curId = colNodes[i]!;
        const prev = ay.get(prevId)!;
        const gap = (sizeMap[prevId]!.h - offOf(prevId)) + offOf(curId) + (ROW_PITCH - DEFAULT_NODE_SIZE.h);
        if ((ay.get(curId) ?? 0) - prev < gap) ay.set(curId, prev + gap);
      }
      const newMean = colNodes.reduce((s, id) => s + (ay.get(id) ?? 0), 0) / colNodes.length;
      const shift = origMean - newMean; // recenter on the original centroid ⇒ symmetry preserved
      for (const id of colNodes) ay.set(id, (ay.get(id) ?? 0) + shift);
    }

    // Translate the lane so its topmost box edge sits at the lane's top, and advance to the next lane band.
    let minTop = Number.POSITIVE_INFINITY;
    let maxBot = Number.NEGATIVE_INFINITY;
    for (const id of members) {
      const top = (ay.get(id) ?? 0) - offOf(id);
      minTop = Math.min(minTop, top);
      maxBot = Math.max(maxBot, top + sizeMap[id]!.h);
    }
    if (!Number.isFinite(minTop)) {
      minTop = 0;
      maxBot = ROW_PITCH;
    }
    for (const id of members) {
      const col = depth[id] ?? 0;
      placement[id] = { x: COL0 + col * COLW, y: laneTopY + ((ay.get(id) ?? 0) - offOf(id) - minTop) };
    }
    laneTopY += maxBot - minTop + LANE_GAP;
  }

  // Any node Tidy could not place (no size / unwired isolate) keeps its seed position so nothing is dropped.
  for (const n of design.nodes) {
    if (placement[n.id] === undefined && seed.pos[n.id] !== undefined) placement[n.id] = seed.pos[n.id]!;
  }

  // SNAP (R5): damped smoothing leaves rows a few px OFF the exact anchor line — inside the objective's ε yet
  // outside the router's 4px snap, i.e. "aligned" rows that would still break lines. The shared generator
  // (layout-refine — the family's ONE snap implementation) re-seats each node exactly on the best admissible
  // anchor line, wherever the column's box separation holds. Pure and deterministic, like everything above.
  return snapToAnchors(design, placement, sizeMap);
}
