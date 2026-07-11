// @algorithm Monte Carlo over the assumption register (seeded sampling, type-7 quantiles, Pearson tornado)
// @problem Every soft input is a declared range, not a point; conclusions must become reproducible
//   DISTRIBUTIONS — percentiles, histograms, per-SLO confidence, sensitivity — without inventing any
//   distribution the user did not declare.
// @approach Seeded mulberry32 draws per scenario — uniform ranges by affine stretch, triangular by
//   inverse-CDF; N scenarios evaluated through the injected EvaluateBatch capability; roll-ups use
//   the type-7 (linear-interpolation) quantile estimator, fixed-bin histograms, SLO pass-fraction
//   confidence, and a tornado from Pearson correlation on the SAME sample (no extra runs, noise
//   floor ~1/sqrt(N)).
// @complexity O(N) draws + injected evaluations (~1 ms each on the native path); O(N log N) per
//   quantile sort; O(N) per tornado column.
// @citations Metropolis & Ulam 1949 (Monte Carlo); Hyndman & Fan 1996 type 7 (NumPy default
//   quantile); Pearson correlation; inverse-CDF sampling (Devroye 1986).
// @invariants Same (design, n, seed) => byte-identical output on any platform; inputs without a
//   declared range stay FIXED across scenarios (refused, never guessed); silent when nothing is
//   ranged — results are the point answer bit-for-bit.
// @where-tested content/sda/src/uncertainty.test.ts (quantiles vs closed form; tornado laws)

// @feature Assumption uncertainty (Monte Carlo + GPU)
// @story Declare ranges on soft inputs and every conclusion becomes a distribution — percentiles,
//   histograms, SLO confidence and a tornado — reproducibly, with optional WebGPU acceleration.
// @surfaces mcp (uncertainty + set_range/clear_range, app/mcp/src/uncertainty.ts), web
//   (app/web/src/uncertainty-worker.ts gpu|cpu modes + panel), vscode (sda.setRange/clearRange,
//   app/vscode/webview/uncertainty-worker.ts), presenter (app/presenter/src/uncertainty-view.ts)
// @algorithms content/sda/src/uncertainty.ts, engine/solver-contract/src/gpu/compile.ts,
//   engine/solver-contract/src/gpu/fp32.ts, engine/solver-contract/src/gpu/webgpu.ts
// @docs docs/design/uncertainty-monte-carlo.html, docs/design/solver-contract.html
// @e2e none (unit + differential: content/sda/src/uncertainty.test.ts and
//   engine/solver-contract/src/gpu/differential.test.ts)
// @status shipped (GPU backend is preview-grade fp32 with CPU fallback, by design)

import { NodeId, type Cell, type Graph, type Key, type Node } from '@sda/engine-core';
import type { EvaluateBatch, Scenario } from '@sda/solver-contract';
import { keys } from './registry';
import { isTriangularRange, type Instance, type Range, type Wire } from './manifest';
import { systemSummary, type ValueFn } from './system';
import { realAwareVerdicts } from './verdict';
import { nodeQueues } from './queueing';
import { applyScenarioToGraph, type AssumptionScenario } from './scenario';

// ASSUMPTION UNCERTAINTY — Monte Carlo over the assumptions register (doc: uncertainty-monte-carlo §2, §3;
// batch-evaluation seam). Every soft input becomes a declared RANGE; every conclusion becomes a
// DISTRIBUTION. This module is the seam + the math: it SAMPLES N scenarios from the declared ranges, evaluates
// each through the CONTRACT's EvaluateBatch capability (the caller injects the bound `evaluateBatch` — the native
// in-process adapter over the JS forward pass, ~1 ms/eval, so 1k–10k scenarios are interactive-adjacent on CPU),
// and rolls the results into percentiles + histograms + SLO confidence + a tornado (correlation on the SAME
// sample — no extra runs). It is PURE domain math over the solved values, so it lives in content, not the engine.
//
// THE 100% CONTRACT (doc §2), enforced here:
//  - CERTAIN   — seeded mulberry32 sampling + the same deterministic engine per scenario ⇒ byte-reproducible; the
//                seed + N ride on every result. Same (design, n, seed) ⇒ identical output, on any platform.
//  - DECLARED  — a range is DATA on an instance (Instance.ranges); the register knows its provenance.
//  - REFUSED   — no invented distributions. An input WITHOUT a range simply stays FIXED across every scenario, so
//                the feature is SILENT when nothing is ranged (no-filler) and results are today's, bit for bit.
//
// v1 drives the FORWARD pass only (doc §6: no DES under uncertainty — a later, costlier round). The SLO-confidence
// judge is the SAME queueing-aware v2 verdict (`realAwareVerdicts`) every other surface reads, so the human and the
// AI can never see a different confidence than what a single evaluate would show at a scenario's drawn inputs.

// ── The seeded PRNG (mulberry32) ────────────────────────────────────────────────────────────────────────────
// A 32-bit deterministic generator: same seed ⇒ same stream, on any platform. This is the SAME algorithm the
// oracle harness generator uses (engine/solver-contract harness/generator.ts `rngOf`) — replicated here rather
// than imported so content keeps its own randomness and does not reach into the contract's harness internals. A
// property suite that owns its randomness needs no more than this; no Date/Math.random anywhere (seeds are inputs).

/** A deterministic random source seeded by a 32-bit integer; `next()` ∈ [0, 1). */
interface Rng {
  next(): number;
}

/** Build a mulberry32 RNG from an integer seed. Deterministic and platform-independent. */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next(): number {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** One draw from a range. UNIFORM: `lo + u·(hi−lo)`. TRIANGULAR: inverse-CDF sampling — a uniform `u` maps to the
 *  left leg when it falls below the mode's cumulative mass `c`, else the right leg — so the density peaks at `mode`
 *  exactly as a triangular distribution should. A degenerate range (hi == lo) draws its single value. */
function drawRange(rng: Rng, range: Range): number {
  const { lo, hi } = range;
  const span = hi - lo;
  const u = rng.next();
  if (!isTriangularRange(range)) return lo + u * span;
  if (span <= 0) return lo;
  const c = (range.mode - lo) / span; // the mode's cumulative probability (the split point of the two legs)
  return u < c ? lo + Math.sqrt(u * span * (range.mode - lo)) : hi - Math.sqrt((1 - u) * span * (hi - range.mode));
}

// ── Ranged-input extraction ─────────────────────────────────────────────────────────────────────────────────

/** One ranged input drawn each scenario: the node it lives on, its config key, and the declared range. */
export interface RangedInput {
  readonly node: string;
  readonly key: string;
  readonly range: Range;
}

/** Every ranged input across the design, in a DETERMINISTIC order (node then key) so the seed→sample mapping is
 *  reproducible regardless of object insertion order. Empty ⇒ the feature is silent (no scenarios drawn). */
export function rangedInputsOf(instances: readonly Instance[]): RangedInput[] {
  const out: RangedInput[] = [];
  for (const inst of instances) for (const [key, range] of Object.entries(inst.ranges ?? {})) out.push({ node: inst.id, key, range });
  return out.sort((a, b) => (a.node === b.node ? cmp(a.key, b.key) : cmp(a.node, b.node)));
}
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Does the design declare ANY uncertainty range? (The no-filler gate — with none, the whole feature stays silent
 *  and a Monte-Carlo run is a no-op, exactly as `hasLagSlos` gates the lag feature.) */
export function hasRanges(instances: readonly Instance[]): boolean {
  return instances.some((i) => i.ranges !== undefined && Object.keys(i.ranges).length > 0);
}

// ── Sampling ────────────────────────────────────────────────────────────────────────────────────────────────

/** N scenarios drawn from the ranged inputs, plus the per-input DRAW COLUMNS (draws[j][i] = input j's value in
 *  scenario i) the tornado correlates against the outcomes on the SAME sample. Row-major draw order (all inputs of
 *  scenario 0, then scenario 1, …) is fixed so the seed reproduces the sample exactly. */
interface Sample {
  readonly scenarios: Scenario[];
  readonly draws: number[][];
}
function sampleScenarios(inputs: readonly RangedInput[], n: number, seed: number): Sample {
  const rng = mulberry32(seed);
  const draws: number[][] = inputs.map(() => new Array<number>(n));
  const scenarios: Scenario[] = new Array<Scenario>(n);
  for (let i = 0; i < n; i++) {
    const overrides: Record<string, number> = {};
    for (let j = 0; j < inputs.length; j++) {
      const v = drawRange(rng, inputs[j]!.range);
      draws[j]![i] = v;
      // The override key is the `"node|key"` coordinate the contract's EvaluateBatch substitutes onto a fixed
      // input cell (the SAME addressing the native adapter + oracle harness use to pin an assignment).
      overrides[`${inputs[j]!.node}|${inputs[j]!.key}`] = v;
    }
    scenarios[i] = { overrides };
  }
  return { scenarios, draws };
}

// ── Statistics — percentiles, histogram, correlation ───────────────────────────────────────────────────────

/** The distribution summary a metric reads as in the doc: median (p50) with a p5–p95 band. */
export interface Percentiles {
  readonly median: number;
  readonly p5: number;
  readonly p95: number;
}

/** The q-quantile of an ASCENDING array by linear interpolation (the "type-7" / NumPy-default estimator), so a
 *  uniform sample's empirical quantiles converge to the closed-form `A + q·(B−A)` — the property-test anchor. */
function percentile(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0]!;
  const idx = q * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (idx - lo) * (sorted[hi]! - sorted[lo]!);
}

/** One histogram bar over `[lo, hi)` with its scenario count. */
export interface HistogramBin {
  readonly lo: number;
  readonly hi: number;
  readonly count: number;
}

const round6 = (x: number): number => Number(x.toFixed(6));

/** Round a raw bin/tick step to a "nice" 1/2/5×10ⁿ value — the SAME family the doc renderer's `niceTicks` uses
 *  (content/sda render-html.ts), so histogram bin edges line up with a later chart's axis ticks. */
function niceStep(rawStep: number): number {
  if (!(rawStep > 0) || !Number.isFinite(rawStep)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const unit = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return unit * mag;
}

/** A niceTicks-compatible histogram over `[min, max]`: bin WIDTH is a nice 1/2/5×10ⁿ step and edges snap to
 *  multiples of it, so the bars read on a clean axis. A zero-variance metric (max ≤ min) yields ONE bin — the
 *  honest "no spread" answer, never a fabricated distribution. Every scenario lands in exactly one bin (counts
 *  sum to the sample size). */
export const HISTOGRAM_BINS = 20;
function histogram(values: readonly number[], min: number, max: number, targetBins = HISTOGRAM_BINS): HistogramBin[] {
  if (values.length === 0) return [];
  if (!(max > min)) return [{ lo: round6(min), hi: round6(max), count: values.length }];
  const step = niceStep((max - min) / targetBins);
  const start = Math.floor(min / step) * step;
  const counts: number[] = [];
  for (let edge = start; edge < max - step * 1e-9; edge += step) counts.push(0);
  if (counts.length === 0) counts.push(0);
  for (const v of values) {
    let k = Math.floor((v - start) / step);
    if (k < 0) k = 0;
    if (k >= counts.length) k = counts.length - 1;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts.map((count, k) => ({ lo: round6(start + k * step), hi: round6(start + (k + 1) * step), count }));
}

/** Pearson correlation of two aligned columns; 0 when either is constant (a constant input/outcome has no linear
 *  relationship — never a divide-by-zero NaN masquerading as a signal). */
function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const denom = Math.sqrt(sxx * syy);
  return denom > 0 ? sxy / denom : 0;
}

// ── Outputs (doc §3, presenter-ready plain data) ────────────────────────────────────────────────────────────

/** One outcome metric's distribution across the sample: percentiles, the spread, and a histogram series. */
export interface MetricDistribution {
  readonly name: string;
  readonly unit: string;
  readonly median: number;
  readonly p5: number;
  readonly p95: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly histogram: readonly HistogramBin[];
  /** ZERO-VARIANCE (F5): the metric is CONSTANT across every scenario — no declared range moves it, so its
   *  "distribution" is a single point (min == max, median == p5 == p95). A surface must suppress the fake spread
   *  and say so honestly ("no ranged input moves this metric"), never render a flat histogram as a real
   *  distribution. Absent/false ⇒ a genuinely-distributed metric (the common case). */
  readonly constant?: boolean;
}

/** The magnitude below which a Pearson correlation is treated as NOISE, not a driver — the tornado never renders a
 *  share from it (F5). At the sample sizes Monte Carlo runs (N ≥ 1000) the standard error of a zero-true-correlation
 *  estimate is ≈ 1/√N ≤ 0.032, so |r| < 0.05 is indistinguishable from sampling noise (it explains r² < 0.25% of the
 *  outcome's variance). An input below this does not meaningfully drive the outcome, so attributing a share to it
 *  would be false precision — no-filler. Documented + tunable in ONE place. */
export const TORNADO_MIN_CORRELATION = 0.05;

/** The relative spread below which a metric is treated as CONSTANT (zero-variance) — a hair above float noise, so a
 *  metric no ranged input touches (every scenario yields the identical value) is flagged, while a genuinely-narrow
 *  distribution is not. Relative to the magnitude so it scales from sub-cent costs to millions of req/s. */
const CONSTANT_REL_EPS = 1e-9;
const isConstant = (min: number, max: number): boolean => max - min <= CONSTANT_REL_EPS * Math.max(1, Math.abs(min), Math.abs(max));

/** How often a declared SLO held across the sample — the board-room "the latency SLO holds in 97% of scenarios". */
export interface SloConfidence {
  readonly scope: string;
  readonly key: string;
  /** Fraction of scenarios (0..1) in which the band was NOT violated, judged by the SAME queueing-aware v2
   *  verdict every surface reads. DES-only keys (tailLatency/goodput/errorRate) are excluded — v1 does not
   *  drive the tail under uncertainty (doc §6). */
  readonly satisfiedFraction: number;
}

/** One tornado bar: how much of an outcome's spread a ranged input drives, by correlation on the SAME sample. */
export interface TornadoRow {
  readonly metric: string;
  readonly node: string;
  readonly key: string;
  /** Signed Pearson correlation of this input's draws with the outcome (the SIGN = the direction of influence). */
  readonly correlation: number;
  /** This input's share of the outcome's explained variance, `r² / Σ r²` across the ranged inputs (0..1). With a
   *  single ranged input it is ~1.0 — that input owns the whole spread. */
  readonly share: number;
}

/** A ranged input as it appears in the result (for the register/reproducibility line). */
export interface RangedInputSummary {
  readonly node: string;
  readonly key: string;
  readonly kind: 'uniform' | 'triangular';
}

/** The whole Monte-Carlo result — everything the doc/Inspector/MCP render, carrying the seed + N so any reader
 *  can reproduce it exactly. With no ranged inputs it is empty (`scenarios: 0`) — the feature is silent. */
export interface UncertaintyResult {
  readonly seed: number;
  readonly scenarios: number;
  readonly rangedInputs: readonly RangedInputSummary[];
  readonly metrics: readonly MetricDistribution[];
  readonly sloConfidence: readonly SloConfidence[];
  readonly tornado: readonly TornadoRow[];
}

/** Everything a Monte-Carlo run reads: the compiled base graph, the design's instances/wires (for the system
 *  roll-up), and the run knobs. A strict subset of what any evaluate caller already holds. */
export interface UncertaintyInput {
  readonly graph: Graph;
  readonly instances: readonly Instance[];
  readonly wires: readonly Wire[];
  /** Scenario count; default {@link DEFAULT_SCENARIOS}, clamped to `[1, MAX_SCENARIOS]`. */
  readonly n?: number;
  /** The 32-bit sampling seed; default {@link DEFAULT_SEED} (a fixed default keeps an un-seeded run reproducible). */
  readonly seed?: number;
  /** OPTIONAL best-effort cancellation channel, threaded straight to the batch evaluator (ambient loop):
   *  a superseding design terminates the stale run's GPU queue / CPU loop rather than finishing wasted work.
   *  Absent ⇒ the run is uninterruptible, exactly as before (the seam is opt-in — a caller that omits it pays nothing). */
  readonly signal?: AbortSignal;
  /** OPTIONAL ACTIVE WORLD to center the sample on (assumption-model doc §6: "a range is a cloud around a point").
   *  When set, its fact-assumption overrides are overlaid onto the base graph BEFORE sampling, so every draw blurs
   *  the ACTIVE world's point (base + world), not the bare base — the demand/service beliefs the architect is looking
   *  at. The declared ranges still sample as-is (a ranged coordinate the world also fixes is re-drawn each scenario);
   *  a NON-ranged override (a demand belief) persists across every draw, so the distribution centers shift with it.
   *  Absent ⇒ the sample centers on the base design — bit-for-bit today (the overlay is a no-op with no scenario). */
  readonly scenario?: AssumptionScenario;
}

export const DEFAULT_SCENARIOS = 1000;
export const MAX_SCENARIOS = 10000;
/** The default seed an un-seeded run records — a fixed integer, so "run again" reproduces the last run byte-for-byte. */
export const DEFAULT_SEED = 0x5eed;

/** DES-fed SLO keys carry no forward value (they read `unknown` off the scalar pass), so v1 Monte Carlo — which
 *  drives the FORWARD pass only (doc §6) — cannot judge them; they are excluded from SLO confidence. */
const DES_ONLY_KEYS = new Set([String(keys.tailLatency), String(keys.goodputRps), String(keys.errorRate)]);

/**
 * Run Monte-Carlo uncertainty over a design: draw N scenarios from the declared ranges, evaluate each through the
 * injected {@link EvaluateBatch}, and roll the results into per-metric distributions, per-SLO confidence, and a
 * per-input tornado (doc §3). SEEDED and byte-reproducible. With NO ranged input the feature is silent — an empty
 * result, no scenarios drawn (the base evaluate path is untouched). Pure aside from the injected batch evaluator.
 */
export async function runUncertainty(input: UncertaintyInput, evaluateBatch: EvaluateBatch): Promise<UncertaintyResult> {
  const seed = (input.seed ?? DEFAULT_SEED) >>> 0;
  const n = Math.max(1, Math.min(MAX_SCENARIOS, Math.floor(input.n ?? DEFAULT_SCENARIOS)));
  const inputs = rangedInputsOf(input.instances);
  const rangedInputs: RangedInputSummary[] = inputs.map((r) => ({ node: r.node, key: r.key, kind: isTriangularRange(r.range) ? 'triangular' : 'uniform' }));

  // No ranges ⇒ the feature is silent (no-filler): no scenarios, no metrics. The caller's base evaluate is the
  // whole truth — Monte Carlo adds nothing to a design with no declared uncertainty.
  if (inputs.length === 0) return { seed, scenarios: 0, rangedInputs, metrics: [], sloConfidence: [], tornado: [] };

  // The graph the sample blurs AROUND: the ACTIVE world's point (base + its fact-assumption overrides) when one is
  // given, else the bare base graph (bit-for-bit today). Every draw, SLO judge and metric read below uses THIS graph,
  // so the distribution centers on the world the architect is looking at (doc §6 — "a range is a cloud around a point").
  const graph = input.scenario ? applyScenarioToGraph(input.graph, input.scenario) : input.graph;

  const { scenarios, draws } = sampleScenarios(inputs, n, seed);
  const results = await evaluateBatch({ graph, scenarios, ...(input.signal ? { signal: input.signal } : {}) });
  // The base graph builds (the caller passed a compiled graph), and every scenario only substitutes fixed input
  // values on that SAME structure — so each scenario evaluates and the batch returns one result per scenario, in
  // order. If a backend ever returns fewer, we honestly report only the aligned prefix rather than misattribute
  // draws to the wrong scenario (uncertainty is a value, never a lie).
  const m = Math.min(results.length, n);

  // Metric SPECS — the outcomes to distribute (doc §3: cost, per-flow latency, availability). Derived once from a
  // sampled evaluation: the topology is scenario-invariant, so the flow terminals it names are stable, and reading
  // those SAME fixed terminals across every scenario keeps the metric columns aligned with the draws.
  const specs = metricSpecs(input.instances, input.wires, valueOf(results[0]!));
  const columns: number[][] = specs.map(() => []);

  // SLO targets — every declared band the FORWARD+v2 pass can judge (DES-only keys excluded, doc §6). Confidence
  // counts, per target, the scenarios whose queueing-aware verdict is NOT a violation.
  const targets = sloTargetsOf(graph);
  const satisfied = new Map<string, number>();

  for (let i = 0; i < m; i++) {
    const ev = results[i]!;
    const value = valueOf(ev);
    for (let s = 0; s < specs.length; s++) columns[s]!.push(specs[s]!.read(value));

    if (targets.length > 0) {
      // Judge the SLOs on the SCENARIO's overridden graph (its drawn service times/capacities), overlaid on the
      // centered graph (base + active world) — `nodeQueues` reads config off the graph cells, so the queueing verdict
      // must see the drawn values on the active world's point, exactly as a single `evaluate` there would.
      const og = applyOverrides(graph, scenarios[i]!);
      const q = nodeQueues(og, value);
      const verdicts = realAwareVerdicts(ev.verdicts, og, value, q);
      const status = new Map<string, string>();
      for (const v of verdicts) status.set(`${String(v.scope)}|${String(v.key)}`, v.status);
      for (const t of targets) {
        const st = status.get(t.id);
        // "Satisfied" = the hard bound is NOT breached (ok or a soft warning); a violation, unknown or
        // non-convergence does not count. The v2 judge already applied the shared ε tolerance at the bound.
        if (st === 'ok' || st === 'warning') satisfied.set(t.id, (satisfied.get(t.id) ?? 0) + 1);
      }
    }
  }

  const metrics = specs.map((spec, s) => distributionOf(spec, columns[s]!)).filter((d): d is MetricDistribution => d !== null);
  const sloConfidence: SloConfidence[] = targets.map((t) => ({ scope: t.scope, key: t.key, satisfiedFraction: m > 0 ? (satisfied.get(t.id) ?? 0) / m : 0 }));
  const tornado = tornadoOf(metrics, inputs, draws, columns, specs, m);
  return { seed, scenarios: m, rangedInputs, metrics, sloConfidence, tornado };
}

/** Adapt one Evaluation to the string-id `ValueFn` every content projector consumes. */
function valueOf(ev: { value(node: NodeId, key: Key): number | undefined }): ValueFn {
  return (id, k) => ev.value(NodeId(id), k);
}

/** One outcome metric to distribute: its name/unit and how to read it from a solved scenario. */
interface MetricSpec {
  readonly name: string;
  readonly unit: string;
  readonly read: (value: ValueFn) => number;
}

/** The outcome metrics (doc §3): the whole-design cost total, plus each request flow's end-to-end latency and
 *  availability at its terminal. Built from the design's flows so a multi-flow design reports each flow. A metric
 *  whose base read is undefined (not computed for this design) is dropped — no-filler, never a fabricated column. */
function metricSpecs(instances: readonly Instance[], wires: readonly Wire[], baseValue: ValueFn): MetricSpec[] {
  const base = systemSummary(instances, wires, baseValue);
  const specs: MetricSpec[] = [{ name: 'cost', unit: 'USD/month', read: (v) => systemSummary(instances, wires, v).cost.totalUsdMonth }];
  for (const f of base.flows) {
    const scope = `${f.source}→${f.terminal}`;
    if (f.latencyMs !== undefined) specs.push({ name: `latency ${scope}`, unit: 'ms', read: (v) => v(f.terminal, keys.latency) ?? NaN });
    if (f.availability !== undefined) specs.push({ name: `availability ${scope}`, unit: 'ratio', read: (v) => v(f.terminal, keys.availability) ?? NaN });
  }
  return specs;
}

/** Summarise one metric column into its distribution, or `null` if it has no finite values (dropped — no-filler). */
function distributionOf(spec: MetricSpec, column: readonly number[]): MetricDistribution | null {
  const finite = column.filter((x) => Number.isFinite(x));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const mean = finite.reduce((s, x) => s + x, 0) / finite.length;
  return {
    name: spec.name,
    unit: spec.unit,
    median: percentile(sorted, 0.5),
    p5: percentile(sorted, 0.05),
    p95: percentile(sorted, 0.95),
    mean,
    min,
    max,
    histogram: histogram(sorted, min, max),
    ...(isConstant(min, max) ? { constant: true } : {}), // zero-variance ⇒ flag it; a surface suppresses the fake spread
  };
}

/** A declared SLO target: the scope+key of a band the forward+v2 pass can judge, plus a `scope|key` lookup id. */
interface SloTarget {
  readonly scope: string;
  readonly key: string;
  readonly id: string;
}

/** Every band the FORWARD+v2 pass can judge — excluding DES-only keys (tailLatency/goodput/errorRate), which read
 *  `unknown` off the scalar pass and are out of scope for v1 uncertainty (doc §6). Deduplicated by (scope, key). */
function sloTargetsOf(graph: Graph): SloTarget[] {
  const seen = new Set<string>();
  const out: SloTarget[] = [];
  for (const node of graph.nodes.values()) {
    for (const cell of node.cells) {
      if (cell.kind !== 'input' || cell.value.kind !== 'band') continue;
      if (DES_ONLY_KEYS.has(String(cell.key))) continue;
      const id = `${String(node.id)}|${String(cell.key)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ scope: String(node.id), key: String(cell.key), id });
    }
  }
  return out;
}

/** The tornado: per metric, each ranged input's signed correlation with the outcome + its share of the explained
 *  variance (`r² / Σ r²`). Correlation is on the SAME sample as the outcome (doc §2 — no extra runs). Rows are
 *  sorted within a metric by share (the tall bars — what to measure first). A metric with no spread contributes
 *  no rows (nothing to attribute). */
function tornadoOf(
  metrics: readonly MetricDistribution[],
  inputs: readonly RangedInput[],
  draws: readonly number[][],
  columns: readonly number[][],
  specs: readonly MetricSpec[],
  m: number,
): TornadoRow[] {
  const nameToCol = new Map<string, number[]>();
  specs.forEach((spec, s) => nameToCol.set(spec.name, columns[s]!));
  const out: TornadoRow[] = [];
  for (const metric of metrics) {
    if (metric.constant === true) continue; // a zero-variance outcome has NO spread to attribute — no rows (no-filler)
    const outcome = nameToCol.get(metric.name);
    if (outcome === undefined) continue;
    const rs = inputs.map((_, j) => pearson(draws[j]!.slice(0, m), outcome));
    const totalR2 = rs.reduce((s, r) => s + r * r, 0);
    const rows = inputs
      // Only inputs whose correlation clears the noise floor DRIVE the outcome — a ~zero correlation is sampling
      // noise, not a signal, so its share is false precision (F5). Filter BEFORE ranking so the tornado shows only
      // the genuine drivers; the surviving shares still read against Σr² over all inputs (the dropped ones ≈ 0).
      .map((inp, j) => ({ metric: metric.name, node: inp.node, key: inp.key, correlation: rs[j]!, share: totalR2 > 0 ? (rs[j]! * rs[j]!) / totalR2 : 0 }))
      .filter((row) => Math.abs(row.correlation) >= TORNADO_MIN_CORRELATION);
    rows.sort((a, b) => b.share - a.share);
    out.push(...rows);
  }
  return out;
}

/**
 * Overlay a scenario's numeric overrides onto the base graph — the graph to judge SLOs against for that draw. An
 * override key is a `"node|key"` pair naming a fixed config input to substitute. This MIRRORS the native adapter's
 * private overlay (engine/solver-contract native/index.ts): the contract keeps it internal, so content re-derives
 * the same pure engine-core surgery (no solver, no domain knowledge). An override naming a non-fixed cell is
 * ignored (a computed value cannot be a sample coordinate).
 */
function applyOverrides(graph: Graph, scenario: Scenario): Graph {
  const overrides = scenario.overrides;
  if (Object.keys(overrides).length === 0) return graph;
  const nodes = new Map<NodeId, Node>(graph.nodes);
  for (const [id, node] of nodes) {
    let changed = false;
    const cells = node.cells.map((c): Cell => {
      if (c.kind !== 'input' || c.value.kind !== 'fixed') return c;
      const v = overrides[`${String(id)}|${String(c.key)}`];
      if (v === undefined) return c;
      changed = true;
      return { ...c, value: { kind: 'fixed', quantity: { ...c.value.quantity, value: v } } };
    });
    if (changed) nodes.set(id, { ...node, cells });
  }
  return { nodes, ports: graph.ports, edges: graph.edges };
}
