import type { Size } from '../layout';
import type { PortLike } from '../edge-routing';
import type { LayoutDesign, Placement } from '../layout-model';
import { sizeOf } from '../layout-model';
import { LAYOUT_TERMS, type LayoutScore, type LayoutTerm, scoreLayout } from '../layout-objective';
import { designPorts } from '../layout-model';
import type { BatchScorer } from '../layout-optimize';
import { type ProxyModel, buildProxyModel, packCenters, proxyScoreBatchFp32, proxyScoreOne, centersOf } from './proxy';

// @algorithm GPU-proposer survivor selection (top-k by fp32 rank, CPU-proven survivors)
// @problem A cheap fp32 ranking may misorder candidates near the top; the seam must let the proxy
//   prune large batches without ever letting fp32 decide the applied layout or perturb small runs.
// @approach Three-layer discipline behind the search's BatchScorer seam: rank the batch with the
//   deviceless fp32 twin, keep the top DEFAULT_SURVIVORS (256, deterministic ties by index), score
//   ONLY survivors with the exact routed CPU objective; pruned candidates get an infeasible
//   sentinel so they can never enter the beam; batches at or under the cap bypass pruning entirely
//   (byte-identical to the CPU-only scorer).
// @complexity O(count) proxy scores + O(count log count) top-k sort above the cap; below it, exactly
//   the CPU scorer's cost.
// @citations None (selection discipline; the numeric core is ./proxy).
// @invariants fp32-never-final (asserted by fp32IsNeverFinal); GPU-on vs GPU-off layouts are
//   byte-identical on every committed example (under-cap bypass); winner is always CPU-proven twice
//   (batch + final result()).
// @where-tested app/presenter/src/layout-gpu/proxy.test.ts (ranking + never-final),
//   app/presenter/src/layout-gpu/device.test.ts

// THE IDEAL LAYOUT — the GPU PROPOSER seam. This binds the fp32 proxy
// (./proxy) into the search's {@link BatchScorer} seam under the THREE-LAYER discipline: the GPU (its exact numeric
// path, the deviceless twin — device-identical, differential-proven) PROPOSES a ranking of the whole candidate
// batch; the CPU PROVES the survivors by re-routing and re-scoring each EXACTLY on the real objective (the router is
// the arbiter); fp32 never decides the applied layout. Two honest facts make this safe and reproducible:
//
//   • fp32-NEVER-FINAL by construction. A survivor's beam score is the CPU's EXACT LayoutScore (routed), not the
//     proxy — the proxy only chooses WHICH candidates pay the ~2ms route+score. A pruned candidate gets an
//     infeasible sentinel, so it can never enter the beam or win. The winner is therefore always CPU-proven; the
//     search's own `result()` re-proves it once more (belt and braces). {@link fp32IsNeverFinal} asserts the seam
//     upholds this.
//   • BYTE-IDENTICAL fallback. When the batch is ≤ the survivor cap (every committed design's per-slice batch is —
//     see DEFAULT_SURVIVORS), NO candidate is pruned: the scorer returns the CPU-exact score for ALL candidates, so
//     it is byte-for-byte the default CPU BatchScorer. GPU-on and GPU-off thus produce identical layouts (asserted
//     on the examples). Above the cap (large synthetic batches, the 50+-node growth axis) the proxy prunes to keep
//     the search within budget — where the GPU earns its keep — and fp32-never-final still holds.
//
// WHY THE PER-SLICE PATH USES THE TWIN, NOT A DEVICE DISPATCH. The BatchScorer seam is SYNCHRONOUS (the beam steps
// per animation frame); a WebGPU dispatch is asynchronous (buffer upload + mapAsync readback), and its fixed
// overhead dwarfs the compute for a per-slice batch of a few dozen candidates (the GPU wins only on LARGE batches —
// measured it flat in batch size). So the product path ranks with the deviceless twin, which computes
// BIT-FOR-BIT what the WGSL kernel computes (the device differential pins this). A real card is the proven-
// equivalent accelerator for large offline batches (the perf benchmark + the device arm of the differential); it
// never changes the RESULT, only the speed of the proposal — and the proposal never decides the applied layout.

/** Per-slice survivor cap: at most this many candidates are re-scored EXACTLY on the CPU per batch. Chosen well
 *  above every committed design's per-slice batch (beamWidth × movesPerCandidate ≈ 36) so the examples are never
 *  pruned (byte-identical to CPU-only). Larger batches (the 50+-node growth axis) prune to the top-k by fp32 rank. */
export const DEFAULT_SURVIVORS = 256;

/** The infeasible sentinel a PRUNED candidate scores — never feasible, so it can neither enter the beam nor win.
 *  (Only produced when a batch exceeds the survivor cap; on the examples nothing is pruned.) */
const PRUNED: LayoutScore = {
  score: Number.NEGATIVE_INFINITY,
  feasible: false,
  hard: [],
  penalties: Object.fromEntries(LAYOUT_TERMS.map((t) => [t, null])) as Record<LayoutTerm, number | null>,
  quality: 0,
};

export interface LayoutBatchScorerOptions {
  /** The EXACT objective a survivor is proven on (the arbiter — routes then scores). Injected so a shell/test can
   *  share ONE binding; default = {@link scoreLayout} over the design's ports (manifest when declared — designPorts). */
  readonly exactScore?: (placement: Placement) => LayoutScore;
  /** Measured node footprints (the shell's real sizes); default each node's declared/default size. Feeds the proxy
   *  model's half-extents (the bounding diagonal). */
  readonly sizes?: Readonly<Record<string, Size>>;
  /** Ports for the exact scorer's router; default {@link designPorts} (manifest when declared, wire-derived otherwise). */
  readonly ports?: Map<string, PortLike[]>;
  /** Survivor cap (see {@link DEFAULT_SURVIVORS}). */
  readonly survivors?: number;
}

/** What a batch cost, for the perf report + tests: how many candidates the proxy ranked vs how many the CPU proved. */
export interface BatchStats {
  readonly batches: number;
  readonly proposed: number;
  readonly proven: number;
  readonly pruned: number;
}

export interface LayoutBatchScorer {
  /** The {@link BatchScorer} to inject as `optimizeLayout`/`createLayoutSearch`'s `batchScore` option. */
  readonly batchScore: BatchScorer;
  readonly model: ProxyModel;
  /** Cumulative batch accounting since construction (the perf/pruning evidence). */
  stats(): BatchStats;
}

const sizeMapOf = (design: LayoutDesign, sizes?: Readonly<Record<string, Size>>): Record<string, Size> => {
  const out: Record<string, Size> = {};
  for (const nd of design.nodes) out[nd.id] = sizes?.[nd.id] ?? sizeOf(nd);
  return out;
};

/**
 * Build the GPU-proposer {@link BatchScorer} for a design: the fp32 proxy ranks the batch, the CPU proves the top-k
 * survivors EXACTLY (routed), and any pruned candidate scores the infeasible sentinel. On a batch within the
 * survivor cap this is byte-for-byte the CPU-exact scorer (the examples); above it, it prunes. Pure aside from the
 * proxy arithmetic; deterministic (top-k ties broken by index). Inject the returned `batchScore` into the search.
 */
export function makeLayoutBatchScorer(design: LayoutDesign, opts?: LayoutBatchScorerOptions): LayoutBatchScorer {
  const sizeMap = sizeMapOf(design, opts?.sizes);
  const ports = opts?.ports ?? designPorts(design);
  const model = buildProxyModel(design, sizeMap);
  const exact = opts?.exactScore ?? ((p: Placement): LayoutScore => scoreLayout(design, p, ports));
  const cap = Math.max(1, opts?.survivors ?? DEFAULT_SURVIVORS);

  let batches = 0;
  let proposed = 0;
  let proven = 0;
  let pruned = 0;

  const batchScore: BatchScorer = (candidates) => {
    const count = candidates.length;
    if (count === 0) return [];
    batches++;
    proposed += count;

    // 1 · GPU PROPOSES — rank the whole batch on the fp32 proxy (the kernel's exact numeric path, deviceless twin).
    const proxy = proxyScoreBatchFp32(model, packCenters(model, candidates), count);

    // 2 · pick survivors — all when within the cap (byte-identical to CPU-only), else the top-k by fp32 rank
    //     (ties by index, so the schedule stays a pure function of the design — determinism §5.2).
    let survivors: Set<number> | null = null;
    if (count > cap) {
      const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => proxy[b]! - proxy[a]! || a - b);
      survivors = new Set(order.slice(0, cap));
      pruned += count - cap;
    }

    // 3 · CPU PROVES — every survivor is routed + scored EXACTLY (the arbiter); a pruned candidate gets the sentinel.
    const out: LayoutScore[] = new Array(count);
    for (let i = 0; i < count; i++) {
      if (survivors === null || survivors.has(i)) {
        out[i] = exact(candidates[i]!);
        proven++;
      } else {
        out[i] = PRUNED;
      }
    }
    return out;
  };

  return { batchScore, model, stats: () => ({ batches, proposed, proven, pruned }) };
}

/**
 * The DECLARED DIFFERENTIAL's raw signal: the fp32 PROXY quality and the exact ROUTED quality for each of a set of
 * candidate placements (aligned by index). A test measures the rank correlation between the two arrays and asserts
 * it clears the documented threshold — the proxy is a faithful RANKING of the routed truth — and that where the
 * proxy misranks, re-scoring on `routed` recovers the true best (so fp32 never decides the winner).
 */
export function layoutProxyRanking(
  design: LayoutDesign,
  placements: readonly Placement[],
  opts?: { readonly sizes?: Readonly<Record<string, Size>>; readonly ports?: Map<string, PortLike[]> },
): { readonly proxy: readonly number[]; readonly routed: readonly number[] } {
  const sizeMap = sizeMapOf(design, opts?.sizes);
  const ports = opts?.ports ?? designPorts(design);
  const model = buildProxyModel(design, sizeMap);
  const proxy = placements.map((p) => proxyScoreOne(model, centersOf(model, p)));
  const routed = placements.map((p) => scoreLayout(design, p, ports).quality);
  return { proxy, routed };
}

/**
 * fp32-NEVER-FINAL, asserted from the seam: score a batch with a survivor cap SMALL enough to force pruning, then
 * confirm (a) every pruned candidate is infeasible (can never win), and (b) every survivor carries the CPU-EXACT
 * routed score (not the fp32 proxy). Returns the evidence a test asserts on. This is the machine-checkable form of
 * "the applied layout is always CPU-proven" (doc §3.4).
 */
export function fp32IsNeverFinal(
  design: LayoutDesign,
  candidates: readonly Placement[],
  survivors: number,
  opts?: { readonly sizes?: Readonly<Record<string, Size>>; readonly ports?: Map<string, PortLike[]> },
): { readonly prunedAllInfeasible: boolean; readonly survivorsMatchExact: boolean; readonly prunedCount: number } {
  const sizeMap = sizeMapOf(design, opts?.sizes);
  const ports = opts?.ports ?? designPorts(design);
  const scorer = makeLayoutBatchScorer(design, { sizes: sizeMap, ports, survivors });
  const scores = scorer.batchScore(candidates);
  let prunedCount = 0;
  let prunedAllInfeasible = true;
  let survivorsMatchExact = true;
  for (let i = 0; i < candidates.length; i++) {
    const s = scores[i]!;
    if (!s.feasible && s.score === Number.NEGATIVE_INFINITY && s === PRUNED) {
      prunedCount++;
      continue;
    }
    // A survivor's score must be the EXACT routed score — recompute and compare the aggregate + feasibility.
    const truth = scoreLayout(design, candidates[i]!, ports);
    if (s.feasible !== truth.feasible || s.score !== truth.score || s.quality !== truth.quality) survivorsMatchExact = false;
  }
  // Any pruned candidate that was NOT the sentinel would break the guarantee; the loop above only counts sentinels.
  prunedAllInfeasible = prunedCount === Math.max(0, candidates.length - survivors);
  return { prunedAllInfeasible, survivorsMatchExact, prunedCount };
}

/** Honest availability probe (async) — is a real WebGPU device obtainable here? Reaches the WebGPU driver ONLY via
 *  dynamic import (bundle separation: the driver never lands in a static graph). Returns false in Node/CI and in the
 *  VS Code host process; true in a Chrome/Edge/webview with a card. The RANKING is identical either way (the twin is
 *  device-faithful) — this probe only tells a shell whether a real dispatch would accelerate large batches. */
export async function probeLayoutGpu(): Promise<boolean> {
  try {
    const mod = await import('./webgpu');
    return (await mod.layoutGpuDevice()) !== null;
  } catch {
    return false;
  }
}

export {
  type ProxyModel,
  type ProxyTerm,
  PROXY_TERMS,
  PROXY_WEIGHTS,
  PROXY_ALIGN_EPS,
  buildProxyModel,
  centersOf,
  packCenters,
  proxyScoreOne,
  proxyScoreBatchFp32,
} from './proxy';
