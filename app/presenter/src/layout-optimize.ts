import type { Group } from '@sda/core';
import type { Pos, Size } from './layout';
import { tidyLayout } from './layout';
import { LAYOUT_TERMS, type HardViolation, type LayoutScore, type LayoutTerm, boxViolations, layoutGeometry, scoreGeometry, scoreLayout, separationMetrics, straightWireCount } from './layout-objective';
import { semanticLayout } from './layout-semantic';
import { COMPACT_GUTTERS, compactColumns, snapToAnchors, symmetrizeFanouts } from './layout-refine';
import { type LayoutDesign, type Placement, type PortOffsets, COLW, ROW_PITCH, designHash, designPorts, dominantAnchors, groupRects, mulberry32, nodeGeoms, sizeOf } from './layout-model';
import { acceptedPortOffsets } from './layout-ports';

// @algorithm Seeded beam search over node placements (the ideal-layout search)
// @problem Find a near-optimal aesthetic placement — row orders, tie-breaks, jog removal — that the
//   deterministic passes cannot decide, within an interactive budget and byte-reproducibly.
// @approach Beam search (default width 6, ~6 mutation moves per candidate) seeded by Tidy, the
//   semantic pass, symmetrize/compact/snap generators; candidates scored by the exact objective on
//   REAL routed wires through an injectable BatchScorer (the GPU fp32 proposer ranks, the CPU always
//   re-proves the winner); an exact-geometry memo plus box-infeasibility fast-reject skip provably
//   result-neutral work; resumable slice scheduler for off-critical-path polish.
// @complexity O(iterations * beam * moves) candidate evaluations, each dominated by routing
//   (Hanan-grid A* per wire); iterations default min(120, max(20, 4n)); wall-clock capped by
//   budgetMs with best-so-far semantics.
// @citations Beam search folklore (Lowerre 1976, HARPY); memoization + dominance pruning standard.
// @invariants Pure function of (seed, design-hash) via mulberry32 — same seed => byte-identical
//   layout when the safety cap does not fire; pinned nodes never move; best-so-far floored at Tidy
//   (any budget returns >= Tidy); cached and uncached pipelines are byte-identical (differential-
//   tested); fp32 never decides the applied layout.
// @where-tested app/presenter/src/layout-optimize.test.ts, app/presenter/src/layout-benchmark.test.ts

// THE IDEAL LAYOUT — the SEARCH (doc: ideal-layout §3, §5). Tidy seeds (the instant floor), the semantic pass shapes
// (§3.2), then a SEEDED beam search polishes what the deterministic pass cannot decide (exact row orders, tie-breaks,
// jog removal) — scored by the objective on REAL routes (§2, the router is the arbiter). Three invariants the round
// owes:
//   • DETERMINISM (§5.2): the whole schedule is a pure function of (seed, design-hash) via mulberry32 — same design +
//     same seed + same iteration budget ⇒ byte-identical layout. (The wall-clock budget is a SAFETY cap that only
//     ends the search early with the best-so-far; the deterministic run passes a generous cap so it never triggers.)
//   • PINS (§5.3, H5): a caller supplies the hand-placed nodes; the optimiser removes them from the free set and lays
//     out only AROUND them — it never fights the architect for a node. `detectPins` infers them (divergence from Tidy).
//   • THE FLOOR (§3.6): the best-so-far is seeded with Tidy and never replaced by anything worse, so ANY budget — even
//     zero iterations — returns a layout at least as good as Tidy. Compute only ever buys beauty; it never loses it.
//
// GPU SEAM (doc §3.3, AC#2): the search scores candidates through an injectable {@link BatchScorer}. The default is
// the exact CPU objective (the arbiter). A GPU proposer (a WGSL fp32 batch scorer behind the gpu-module discipline)
// slots in HERE at R3 to rank thousands of candidates fast; the winner is always re-scored by the CPU objective on
// real routes before it is returned, so fp32 never decides the applied layout (the three-layer discipline).
//
// THE CACHED PIPELINE (R4d, the polish speed round — profiled on the four committed examples + a synthetic 40-node
// design). Routing+scoring candidates is >98% of the polish wall-clock, and the profile showed two kinds of paid-for
// waste, both removable WITHOUT touching the search trajectory (the owner's bar: same seed ⇒ byte-identical layout):
//   • DUPLICATES — 21–71% of proposed candidates are byte-identical placements already scored this run (a stable
//     beam re-proposes the same compaction/snap/nudge). The score is a pure function of the placement, so a memo
//     keyed by the EXACT (full-precision) geometry returns the identical LayoutScore without re-routing.
//   • BOX-INFEASIBLE candidates — 17–46% of candidates violate H2 (node overlap) or H4 (group intrusion), which are
//     BOX facts needing no routes ({@link boxViolations}, one implementation with the full check). Any hard
//     violation makes a candidate infeasible, and an infeasible candidate can never enter the beam, best-so-far or
//     the finalists — so its exact penalty vector is never consumed, and skipping its routing cannot change the
//     result. The synthesised verdict carries the real box violations; it is used only to discard, never surfaced.
// Both levers are result-identical BY CONSTRUCTION; `caching: false` runs the reference (uncached) pipeline and the
// R4d differential test asserts the two produce byte-identical results on every committed example.

/** The batch-score seam: rank a batch of candidate placements. The default is the exact CPU objective; a GPU
 *  proposer implements the same signature (fp32 ranking) at R3. Returns one score per candidate, in order. */
export type BatchScorer = (candidates: readonly Placement[]) => readonly LayoutScore[];

export interface OptimizeOptions {
  /** Extra entropy combined with the design hash (§5.2). Same seed ⇒ same layout; a different seed re-rolls for a
   *  different local optimum. Default 0. */
  readonly seed?: number;
  /** Wall-clock SAFETY cap in ms (§3.6). The search stops at any time and keeps best-so-far. Default 3000. */
  readonly budgetMs?: number;
  /** Deterministic schedule length (search iterations). Default derived from node count. The determinism guarantee
   *  holds when the budget cap does not trigger (pass a large budget for a byte-reproducible run). */
  readonly iterations?: number;
  /** Beam width — how many best candidates survive each step. Default 6. */
  readonly beamWidth?: number;
  /** Neighbour moves proposed per surviving candidate each step. Default 6. */
  readonly movesPerCandidate?: number;
  /** Hand-placed nodes to hold FIXED (H5). The optimiser lays out only around them. Default none. */
  readonly pins?: ReadonlySet<string>;
  /** The fixed coordinates for the pinned nodes (their hand-placed positions, e.g. the current `doc.layout`). Every
   *  candidate holds a pinned node at its anchor, so the winner never moves it. Absent ⇒ pinned nodes are held at
   *  their Tidy position (the fallback anchor). */
  readonly anchors?: Placement;
  /** Measured node footprints (the shell's real sizes); defaults to each node's declared/default size. */
  readonly sizes?: Readonly<Record<string, Size>>;
  /** The batch scorer (the GPU seam). Default = the exact CPU objective on real routes. */
  readonly batchScore?: BatchScorer;
  /** The R4d result-identical levers (see the header): memoise scores by exact placement geometry + reject
   *  box-infeasible candidates (H2/H4) before routing. Default true. Exists as a flag ONLY so the differential
   *  test can run the reference (uncached) pipeline against the cached one — never a quality trade. */
  readonly caching?: boolean;
  /** EARLY TERMINATION (R4d lever, measured and left OFF by default): stop when the best-so-far has not improved
   *  for this many consecutive beam iterations, keeping best-so-far. Profiling showed improvements land LATE in
   *  the schedule (last gains at iteration 41/44, 118/120 on the profiled designs), so any stall window that
   *  provably never fires before the last gain returns ~0 budget — and a smaller window changes the search
   *  trajectory (the finalists, hence possibly the winner). Undefined = never stop early (the default). */
  readonly stallIterations?: number;
}

/** A placement + its score, the unit the beam carries. */
interface Scored {
  readonly placement: Placement;
  readonly score: LayoutScore;
  readonly sig: string;
}

export interface OptimizeResult {
  /** The winning placement — the best layout found, GUARANTEED at least as good as Tidy. Same shape as `doc.layout`. */
  readonly placement: Placement;
  /** The R5 PORT SLIDE assigned on the winner (layout-ports `acceptedPortOffsets`): node id → `${side}:${port}`
   *  → px from the node's top. The shell threads these to the renderer's handles AND the router's anchors (one
   *  home — layout-model `portAnchorOffset`), so wired ports sit exactly opposite their peers. ROUTER-ACCEPTED:
   *  kept only when the routed geometry draws ≥ as many straight wires and stays within the Tidy overlap floor;
   *  otherwise {} (fractions). A pure function of the winning placement — deterministic with it. */
  readonly portOffsets: PortOffsets;
  readonly score: LayoutScore;
  readonly tidy: { readonly placement: Placement; readonly score: LayoutScore };
  readonly semantic: { readonly placement: Placement; readonly score: LayoutScore };
  /** Which stage produced the winner — `tidy` (floor), `semantic` (the deterministic pass), or `search` (the beam). */
  readonly source: 'tidy' | 'semantic' | 'search';
  readonly seed: number;
  readonly iterations: number;
  /** Candidate placements proposed + considered (the schedule's compute budget). With the R4d cache a duplicate or
   *  box-infeasible candidate is served without re-routing, but it still counts here — so the cached and reference
   *  pipelines report the SAME number (the differential test compares them field-for-field). */
  readonly evaluated: number;
  readonly elapsedMs: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const signature = (placement: Placement): string =>
  Object.keys(placement)
    .sort()
    .map((id) => `${id}:${round1(placement[id]!.x)},${round1(placement[id]!.y)}`)
    .join('|');

/** Both identity strings of a placement in ONE sorted pass: `sig` — the 0.1px-rounded beam signature (byte-identical
 *  to {@link signature}, the dedupe/tie-break key), and `key` — the EXACT full-precision geometry (the R4d memo
 *  key). The memo must key on exact coordinates: two placements 0.05px apart route differently, and serving one the
 *  other's cached score would be a lying canvas — the rounded sig may only dedupe the beam, never the cache. */
export function placementKeys(placement: Placement): { readonly key: string; readonly sig: string } {
  const ids = Object.keys(placement).sort();
  const keyParts: string[] = [];
  const sigParts: string[] = [];
  for (const id of ids) {
    const at = placement[id]!;
    keyParts.push(`${id}:${at.x}:${at.y}`);
    sigParts.push(`${id}:${round1(at.x)},${round1(at.y)}`);
  }
  return { key: keyParts.join('|'), sig: sigParts.join('|') };
}

/** The all-N/A penalty vector of a synthesised box-reject verdict (shared, frozen — never surfaced downstream). */
const NULL_PENALTIES: Readonly<Record<LayoutTerm, number | null>> = Object.freeze(
  Object.fromEntries(LAYOUT_TERMS.map((t) => [t, null])),
) as Record<LayoutTerm, number | null>;

/** The synthesised verdict of a box-rejected candidate (R4d cheap-reject): infeasible on its REAL H2/H4 violations,
 *  never routed. Sound because an infeasible candidate is discarded before any other field is read (see header). */
const boxRejectScore = (hard: readonly HardViolation[]): LayoutScore => ({
  score: Number.NEGATIVE_INFINITY,
  feasible: false,
  hard,
  penalties: NULL_PENALTIES,
  quality: 0,
});

const sizeMapOf = (design: LayoutDesign, sizes?: Readonly<Record<string, Size>>): Record<string, Size> => {
  const out: Record<string, Size> = {};
  for (const n of design.nodes) out[n.id] = sizes?.[n.id] ?? sizeOf(n);
  return out;
};

const tidyPlacement = (design: LayoutDesign, sizeMap: Record<string, Size>): Placement => {
  const tidyGroups: Group[] = design.groups.map((g) => ({ id: g.id, label: '', rect: { x: 0, y: 0, w: 0, h: 0 }, members: g.members }));
  return tidyLayout(design.nodes.map((n) => ({ id: n.id })), design.wires.map((w) => ({ from: w.from, to: w.to })), tidyGroups, sizeMap).pos;
};

/**
 * Infer the PINS (§5.3): a node whose STORED position diverges from what Tidy of the current topology would produce,
 * beyond ε, is taken to be HAND-PLACED — a hard constraint the optimiser lays out around, never over. No new schema:
 * the divergence IS the signal. Returns the set of pinned node ids. A caller with explicit pins passes them directly
 * instead.
 */
export function detectPins(
  design: LayoutDesign,
  stored: Placement,
  opts?: { readonly sizes?: Readonly<Record<string, Size>>; readonly epsilon?: number },
): Set<string> {
  const sizeMap = sizeMapOf(design, opts?.sizes);
  const tidy = tidyPlacement(design, sizeMap);
  const eps = opts?.epsilon ?? 40;
  const pins = new Set<string>();
  for (const n of design.nodes) {
    const at = stored[n.id];
    const ref = tidy[n.id];
    if (at === undefined || ref === undefined) continue;
    if (Math.hypot(at.x - ref.x, at.y - ref.y) > eps) pins.add(n.id);
  }
  return pins;
}

/** One neighbour move. Two GLOBAL refinement moves (doc §3, R2) fire occasionally: COMPACT all ranks (per-rank X
 *  tightening at a sampled gutter) or SYMMETRISE the fan-outs — so the beam can combine local row work with the
 *  deterministic tighten/mirror passes on an already-evolved candidate, not only seed from them. Otherwise a LOCAL
 *  move: nudge a free node's row, swap two free nodes' rows in a column, or snap a free node's dominant PORT ANCHOR
 *  onto another node's (alignment — the same anchor rows the objective clusters and the router draws straight).
 *  Pinned nodes never move (H5); a global move holds pinned columns/rows. Returns a NEW placement (structural
 *  share). */
function mutate(design: LayoutDesign, placement: Placement, rng: () => number, pins: ReadonlySet<string>, sizeMap: Record<string, Size>, anchorOff: ReadonlyMap<string, { readonly offset: number }>): Placement {
  const roll = rng();
  if (roll < 0.1) {
    const gutter = COMPACT_GUTTERS[Math.floor(rng() * COMPACT_GUTTERS.length) % COMPACT_GUTTERS.length]!;
    return compactColumns(design, placement, sizeMap, { gutter, pins });
  }
  if (roll < 0.16) return symmetrizeFanouts(design, placement, sizeMap, { pins });
  // The R5 global move: SNAP an evolved candidate's rows exactly onto its dominant port-anchor lines — the beam can
  // recover the straight wires its local moves disturb (exact anchors win the alignment/bends terms and feed the
  // winner's straight-wire tie-break).
  if (roll < 0.22) return snapToAnchors(design, placement, sizeMap, { pins });

  const free = design.nodes.map((n) => n.id).filter((id) => !pins.has(id) && placement[id] !== undefined);
  if (free.length === 0) return placement;
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length) % arr.length]!;
  const a = pick(free);
  const at = placement[a]!;
  const move = Math.floor(rng() * 3);
  const next: Record<string, Pos> = { ...placement };

  if (move === 0) {
    // Nudge one lane up or down.
    const dir = rng() < 0.5 ? -1 : 1;
    next[a] = { x: at.x, y: at.y + dir * ROW_PITCH };
  } else if (move === 1) {
    // Row swap with another free node in the SAME column (same x band) — reorders rows without breaking columns.
    const sameCol = free.filter((id) => id !== a && Math.abs(placement[id]!.x - at.x) < COLW / 2);
    if (sameCol.length === 0) {
      next[a] = { x: at.x, y: at.y + (rng() < 0.5 ? -ROW_PITCH : ROW_PITCH) };
    } else {
      const b = pick(sameCol);
      const bt = placement[b]!;
      next[a] = { x: at.x, y: bt.y };
      next[b] = { x: bt.x, y: at.y };
    }
  } else {
    // Snap a's dominant PORT ANCHOR onto another node's (chase a shared anchor guideline — port-centric alignment,
    // R5: collinear anchors are what the alignment term measures and what the router draws as ONE straight line).
    const others = free.filter((id) => id !== a);
    const b = pick(others.length > 0 ? others : free);
    const targetAnchorY = placement[b]!.y + (anchorOff.get(b)?.offset ?? sizeMap[b]!.h / 2);
    next[a] = { x: at.x, y: targetAnchorY - (anchorOff.get(a)?.offset ?? sizeMap[a]!.h / 2) };
  }
  return next;
}

/** Keep the best `k` distinct candidates by score (feasible first), tie-broken deterministically by signature. */
function topK(pool: readonly Scored[], k: number): Scored[] {
  const seen = new Set<string>();
  const distinct: Scored[] = [];
  for (const s of pool) {
    if (seen.has(s.sig)) continue;
    seen.add(s.sig);
    distinct.push(s);
  }
  distinct.sort((x, y) => y.score.score - x.score.score || (x.sig < y.sig ? -1 : x.sig > y.sig ? 1 : 0));
  return distinct.slice(0, k);
}

/** A RESUMABLE run of the search (doc §3.6 — the polisher yields between slices so the canvas never blocks). The
 *  shell drives it off the critical path: `runSlice(ms)` advances the beam for a wall-clock slice and returns
 *  whether more iterations remain; the caller re-invokes it next frame/tick until it returns `false`, then reads
 *  `result()`. A synchronous caller (or a test) simply drains it. Slicing changes only WHEN the search stops for
 *  the wall-clock budget, never the iteration sequence — so a fully-run search is byte-identical to `optimizeLayout`. */
export interface LayoutSearch {
  /** Advance up to `sliceMs` of wall-clock (also bounded by the overall budget + iteration count). Returns `true`
   *  while iterations remain (re-invoke to keep polishing), `false` when complete. */
  runSlice(sliceMs: number): boolean;
  /** The best layout so far — CPU-proven on real routes, floored at Tidy. Call once, after `runSlice` returns false
   *  (safe at any time: it returns the best-so-far). */
  result(): OptimizeResult;
}

/**
 * Optimise a design's layout: Tidy seeds, the semantic pass shapes, the R2 refinements (compaction + fan-out
 * symmetrization) seed, then a seeded beam polishes — all scored on real routes, floored at Tidy. Pure aside from
 * the wall-clock read (which only bounds effort, never the RESULT for a given iteration budget). Runs to completion
 * (budget-bounded) and returns the winner + the seed stages + provenance. For a non-blocking run, drive
 * {@link createLayoutSearch} in slices instead.
 */
export function optimizeLayout(design: LayoutDesign, options?: OptimizeOptions): OptimizeResult {
  const search = createLayoutSearch(design, options);
  while (search.runSlice(Number.POSITIVE_INFINITY)) {
    /* run to completion in one slice (the overall budget still bounds it) */
  }
  return search.result();
}

/**
 * Build a RESUMABLE search (the primitive behind {@link optimizeLayout} and the shells' background polisher). Sets
 * up the deterministic seeds + beam once; `runSlice` then advances the beam a wall-clock slice at a time so a shell
 * can polish across animation frames without dropping one (doc §3.6, the resting handshake). Same seeds, same
 * schedule, same floor as `optimizeLayout`.
 */
export function createLayoutSearch(design: LayoutDesign, options?: OptimizeOptions): LayoutSearch {
  const started = Date.now();
  const sizeMap = sizeMapOf(design, options?.sizes);
  const ports = designPorts(design); // manifest ports when declared (R5) — anchor where the canvas renders

  const anchorOff = dominantAnchors(design, sizeMap, ports); // the shared port-anchor rows the align move snaps to
  const pins = options?.pins ?? new Set<string>();
  const seed = (options?.seed ?? 0) >>> 0;
  const budgetMs = options?.budgetMs ?? 3000;
  const beamWidth = Math.max(1, options?.beamWidth ?? 6);
  const movesPerCandidate = Math.max(1, options?.movesPerCandidate ?? 6);
  const iterations = options?.iterations ?? Math.min(120, Math.max(20, design.nodes.length * 4));
  const batchScore: BatchScorer = options?.batchScore ?? ((cands) => cands.map((p) => scoreLayout(design, p, ports)));
  const stall = options?.stallIterations;
  /** The R4d memo: EXACT placement geometry → its LayoutScore (null = the reference/uncached pipeline). A score is
   *  a pure function of the placement (design/ports/sizes fixed for the whole search), so a hit returns the
   *  identical verdict the uncached pipeline would recompute — never an approximation. */
  const memo = (options?.caching ?? true) ? new Map<string, LayoutScore>() : null;

  // Hold every pinned node at its anchor (its hand-placed position, or its Tidy position when no anchor is given), in
  // EVERY candidate — the optimiser lays out only around a pin (§5.3, H5), it never fights the architect for it.
  const tidyPos = tidyPlacement(design, sizeMap);
  const anchorOf = (id: string): Pos | undefined => options?.anchors?.[id] ?? tidyPos[id];
  const withAnchors = (placement: Placement): Placement => {
    if (pins.size === 0) return placement;
    const out: Record<string, Pos> = { ...placement };
    for (const id of pins) {
      const a = anchorOf(id);
      if (a !== undefined) out[id] = a;
    }
    return out;
  };
  const scoreOne = (placement: Placement): Scored => {
    const anchored = withAnchors(placement);
    if (memo === null) return { placement: anchored, score: scoreLayout(design, anchored, ports), sig: signature(anchored) };
    // Seeds are ALWAYS scored exactly (their qualities are surfaced in the result); the memo only skips a repeat.
    const { key, sig } = placementKeys(anchored);
    let score = memo.get(key);
    if (score === undefined) {
      score = scoreLayout(design, anchored, ports);
      memo.set(key, score);
    }
    return { placement: anchored, score, sig };
  };

  /** Score one beam batch. Reference pipeline (memo === null): every candidate goes through `batchScore`, exactly
   *  the pre-R4d code path. Cached pipeline: memo hits and box-infeasible candidates (H2/H4 — {@link boxViolations},
   *  no routes needed) are resolved without routing, in-batch duplicates collapse onto one routing, and only fresh
   *  box-feasible geometries reach `batchScore`. The per-candidate SCORES are identical either way (see header), so
   *  the beam, the best-so-far and the finalists — and therefore the returned layout — are byte-identical. */
  const scoreCandidates = (candidates: readonly Placement[]): Scored[] => {
    if (memo === null) {
      const scores = batchScore(candidates);
      return candidates.map((placement, i) => ({ placement, score: scores[i]!, sig: signature(placement) }));
    }
    const keyed = candidates.map((placement) => ({ placement, ...placementKeys(placement) }));
    const out: (Scored | undefined)[] = new Array(keyed.length);
    const pendingByKey = new Map<string, number[]>(); // first index routes; in-batch duplicates share its score
    const missIdx: number[] = [];
    keyed.forEach((k, i) => {
      const hit = memo.get(k.key);
      if (hit !== undefined) {
        out[i] = { placement: k.placement, score: hit, sig: k.sig };
        return;
      }
      const pending = pendingByKey.get(k.key);
      if (pending !== undefined) {
        pending.push(i);
        return;
      }
      const box = boxViolations(nodeGeoms(design, k.placement, ports), groupRects(design, k.placement));
      if (box.length > 0) {
        const s = boxRejectScore(box);
        memo.set(k.key, s);
        out[i] = { placement: k.placement, score: s, sig: k.sig };
        return;
      }
      pendingByKey.set(k.key, [i]);
      missIdx.push(i);
    });
    const scores = missIdx.length > 0 ? batchScore(missIdx.map((i) => keyed[i]!.placement)) : [];
    missIdx.forEach((i, j) => {
      const k = keyed[i]!;
      const s = scores[j]!;
      memo.set(k.key, s);
      for (const dup of pendingByKey.get(k.key)!) out[dup] = { placement: keyed[dup]!.placement, score: s, sig: keyed[dup]!.sig };
    });
    return out as Scored[];
  };

  // Stage 0 + 1 — the deterministic seeds. Tidy is the FLOOR; the semantic pass shapes; then the R2 refinements
  // (doc §3): SYMMETRISE the fan-outs of the semantic seed, and COMPACT both the semantic and the symmetrised seed
  // at each candidate gutter (§layout-refine). The beam starts from the best of these, then polishes — so the
  // length/area/symmetry gains R1 could not reach are on the table from iteration zero, and a refinement that would
  // hurt a given design is simply never the best-scoring seed (never forced).
  const semanticPos = withAnchors(semanticLayout(design, sizeMap));
  const symmetricPos = withAnchors(symmetrizeFanouts(design, semanticPos, sizeMap, { pins }));
  const refinementSeeds: Placement[] = [];
  // R5: TIDY joins the compaction bases — compaction moves X only, so a compacted Tidy keeps every straight wire
  // Tidy's grid coincidences produce while shedding its slack columns: a strong contender on designs where the
  // smoothed rows cannot reproduce a coincidence (a one-port fan-out's two targets cannot both sit on its single
  // anchor row).
  for (const base of [tidyPos, semanticPos, symmetricPos]) {
    for (const gutter of COMPACT_GUTTERS) refinementSeeds.push(compactColumns(design, base, sizeMap, { gutter, pins }));
  }
  // R5: the shaped seeds also enter SNAPPED onto their dominant port-anchor lines — candidates whose wires the
  // router draws straight from iteration zero, feeding both the quality race and the straight-wire tie-break.
  for (const base of [tidyPos, symmetricPos, ...refinementSeeds.slice()]) {
    refinementSeeds.push(withAnchors(snapToAnchors(design, base, sizeMap, { pins })));
  }

  const tidy = scoreOne(tidyPos);
  const semantic = scoreOne(semanticPos);
  const seeds = [tidy, semantic, scoreOne(symmetricPos), ...refinementSeeds.map(scoreOne)];
  let evaluated = seeds.length;

  let best: Scored = tidy;
  const consider = (s: Scored): void => {
    if (s.score.feasible && s.score.score > best.score.score) best = s;
  };
  for (const s of seeds) consider(s);

  // Beam init: the feasible seeds, best first.
  let beam = topK(seeds.filter((s) => s.score.feasible), beamWidth);
  if (beam.length === 0) beam = [tidy]; // Tidy is the guaranteed fallback even if it somehow scores infeasible

  const rng = mulberry32(designHash(design) ^ seed);
  let iter = 0;
  let sinceImprove = 0; // beam iterations since best-so-far last improved (the stallIterations lever reads this)

  const runSlice = (sliceMs: number): boolean => {
    const sliceStart = Date.now();
    while (iter < iterations) {
      const now = Date.now();
      if (now - started >= budgetMs) {
        iter = iterations; // the wall-clock SAFETY cap: stop and keep best-so-far (doc §3.6)
        break;
      }
      if (now - sliceStart >= sliceMs) return true; // yield to the caller; more iterations remain
      const candidates: Placement[] = [];
      for (const parent of beam) {
        for (let m = 0; m < movesPerCandidate; m++) candidates.push(mutate(design, parent.placement, rng, pins, sizeMap, anchorOff));
      }
      const scored = scoreCandidates(candidates);
      evaluated += candidates.length;
      const feasible = scored.filter((s) => s.score.feasible);
      const bestBefore = best;
      for (const s of feasible) consider(s);
      beam = topK([...beam, ...feasible], beamWidth);
      if (beam.length === 0) beam = [best];
      iter++;
      if (stall !== undefined) {
        sinceImprove = best === bestBefore ? sinceImprove + 1 : 0;
        if (sinceImprove >= stall) {
          iter = iterations; // early rest: the search has stalled — finish with best-so-far (opt-in lever, R4d)
          break;
        }
      }
    }
    return iter < iterations;
  };

  const result = (): OptimizeResult => {
    // CPU PROVES (doc §3.4, the three-layer discipline): re-score the FINALISTS — the final beam plus the best-so-far
    // and the two seeds — EXACTLY on the CPU (the arbiter, on real routes), and return the exact best, floored at
    // Tidy. A GPU `batchScore` only PROPOSES the fp32 ranking during the search; the APPLIED layout is always
    // CPU-proven, so fp32 never decides what the architect sees. With the default (CPU-exact) batchScore this is a
    // confirming no-op.
    //
    // THE TRACEABILITY FLOOR (R4, owner verdict). The owner field-tested the ideal layout and ruled it WORSE
    // than Tidy because it "overlaps lines more" — traceability must be ≥ Tidy, and (his words) "slower is acceptable
    // only if better." At the low overlap the separation pass now achieves, the weighted overlap TERM barely
    // discriminates 78px from 90px, so a best-quality placement can still edge just past Tidy. So the winner is
    // chosen as the best-QUALITY finalist whose line-on-line OVERLAP does not exceed Tidy's — a near-lexicographic
    // floor at the Tidy baseline. It is ALWAYS satisfiable (Tidy is a finalist, overlap == Tidy's), so the winner is
    // still ≥ Tidy on quality AND ≥ Tidy on traceability — never one at the other's expense.
    //
    // THE STRAIGHT-WIRE TIE-BREAK (R5, port-centric alignment). Port-collinear rows only matter if they CASH as
    // straight wires in the layout that ships, so among EQUAL-quality finalists the winner is the one the router
    // draws with more one-segment wires (`straightWireCount`, on the same routed geometry as the scores). It is a
    // TIE-BREAK, deliberately NOT a floor: the ratified weight vector stays the sole arbiter of quality — on
    // designs like CQRS the vector genuinely prefers a mirrored fan-out over Tidy's accidental extra straight (a
    // one-port fan-out's two targets cannot both hold its anchor row), and a straights floor at Tidy would force
    // that uglier trade and break the ratified ≥-feasible-dagre benchmark gate. The cascade still lands through
    // QUALITY: exact anchor rows (the snap seeds/move) win the re-measured alignment term and the bends term
    // wherever straightness and beauty agree — which is the chain / unequal-height case the owner named.
    //
    // Finalists: the classic set (tidy, semantic, best-so-far, the beam) PLUS every deterministic seed — the
    // beam's quality-ranked topK can evict a marginal-quality seed that carries every straight wire (a compacted
    // Tidy), and a tie-break can only choose among the finalists it is shown. De-duplicated by signature so no
    // placement is routed twice.
    const anchored: Placement[] = [];
    const seen = new Set<string>();
    for (const s of [tidy, semantic, best, ...beam, ...seeds]) {
      const p = withAnchors(s.placement);
      const sig = signature(p);
      if (seen.has(sig)) continue;
      seen.add(sig);
      anchored.push(p);
    }
    const tidyGeo = layoutGeometry(design, tidy.placement, ports);
    const tidyOverlap = separationMetrics(tidyGeo).overlapLen + 1e-6;
    let winner: Scored = tidy;
    let winnerStraights = straightWireCount(tidyGeo);
    for (const p of anchored) {
      const geo = layoutGeometry(design, p, ports); // routed ONCE per finalist; score, floor and tie-break share it
      const s: Scored = { placement: p, score: scoreGeometry(geo), sig: signature(p) };
      evaluated++;
      if (!s.score.feasible) continue;
      if (separationMetrics(geo).overlapLen > tidyOverlap) continue;
      const straights = straightWireCount(geo);
      const better =
        s.score.score > winner.score.score ||
        (s.score.score === winner.score.score &&
          (straights > winnerStraights || (straights === winnerStraights && s.sig < winner.sig)));
      if (!better) continue;
      winner = s;
      winnerStraights = straights;
    }
    const source: OptimizeResult['source'] = winner.sig === tidy.sig ? 'tidy' : winner.sig === semantic.sig ? 'semantic' : 'search';
    return {
      placement: winner.placement,
      // The R5 slide, assigned ON the winner (a pure post-pass — the search itself is untouched, so every prior
      // determinism/differential pin holds; the offsets are as deterministic as the placement they derive from)
      // and ACCEPTED only if the routed geometry proves it: straights ≥ the winner's own, overlap within the SAME
      // Tidy traceability floor the winner was chosen under. Rejected ⇒ {} — the canvas keeps fractions.
      portOffsets: acceptedPortOffsets(design, winner.placement, sizeMap, tidyOverlap),
      score: winner.score,
      tidy: { placement: tidy.placement, score: tidy.score },
      semantic: { placement: semantic.placement, score: semantic.score },
      source,
      seed,
      iterations,
      evaluated,
      elapsedMs: Date.now() - started,
    };
  };

  return { runSlice, result };
}
