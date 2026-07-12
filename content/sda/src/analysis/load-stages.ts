// @feature Load stages (traffic that changes over time + peak-aware verdicts)
// @story A traffic origin declares a k6/Gatling-style STAGES table wrapped in periodic CYCLES; the engine plays the
//   shape live (a launch spike, a diurnal rhythm, a quarterly season), evaluates the whole auto-derived season in
//   two labelled tiers, and judges every per-node surface at the declared PEAK — so a node calm at the mean but
//   over capacity at its daily peak reads a violation on the canvas ρ chip / Inspector / System ρ rows, not green.
//   Supersedes the deleted one-click spike probe (the net-negative ledger): its survival verdict lives on per-window.
// @surfaces web + vscode (the ⚡ generator + cycles-table editor, the ambient two-tier System block, and the
//   PEAK-AWARE ρ chip / Inspector verdict / System ρ rows — app/presenter/src/peak-view.ts), mcp (via `simulate`)
// @algorithms content/sda/src/analysis/load-stages.ts (the multi-cycle rate product), content/sda/src/analysis/time-sweep.ts (the
//   Tier-1 quasi-static sweep + per-node peak), content/sda/src/analysis/two-tier.ts (propose/prove), content/sda/src/analysis/sim.ts (DES lowering)
// @docs none
// @e2e content/sda/src/analysis/two-tier.e2e.test.ts, content/sda/src/vocabulary/generator.e2e.test.ts, app/web/src/two-tier.e2e.test.ts, app/presenter/src/two-tier-view.test.ts
// @status shipped

// THE LOAD-STAGES HOME — the SINGLE SOURCE OF TRUTH for the two-tier evaluator's
// tunables AND the λ(t) arithmetic that lowers a generator's cycles to an instantaneous rate. Every surface (the
// sweep, the DES lowering, the editor's preview, the generated doc) READS this — never a local literal (§16.3
// one-form rule). It ABSORBS `STRESS_DEFAULTS` (its spike numbers become the `spike` preset; its seed becomes the
// DES seed) — a net consolidation, not a second pile of numbers.
//
// THE MODEL: a generator carries `level` (the BASELINE rate, the `×1` the multipliers
// scale — ratified) and a list of periodic `cycles`. Within a generator the cycles MULTIPLY:
//   λ(t) = level · Π_{c ∈ cycles} m_c(t mod periodS_c)
// where m_c is the piecewise-linear multiplier the cycle's stages describe (k6 ramp-to-target). Across separate
// origin nodes the streams SUM (the existing multi-origin behaviour — behaviors.ts, no new path). The mean (cost)
// and peak (verdicts) are DERIVED from the shape (§7). A flat generator (no cycles, or all `×1`) is byte-identical
// to today's steady `generate(level)` (the sacred pin, §9).

import type { Cycle, Stage } from '@sda/engine-core';
import { isFlatProfile, profileMean, profilePeak, profileValue, type RateProfile, type RateProfilePoint } from '@sda/engine-sim';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// §16.3 — the two-tier evaluator's tunables, each SOURCED and rationale-commented (the RDS_PRICING_SOURCE /
// DERIVED_DEMAND_FRACTIONS idiom). Change any of them in ONE line.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const LOAD_STAGES_DEFAULTS = {
  // A — at-rest fine sweep resolution. ADAPTIVE (points per cycle), never a fixed clock window.
  restPointsPerCycle: 96, //   ⇒ 15-min windows for a diurnal cycle (86400/96 = 900 s). Datadog 288 5-min
  //                            buckets/day & ≤~300 intervals/query; Grafana Auto = span/width; Prometheus rate()
  //                            ≥4 samples/window. 96 = same family, > Nyquist(2) & rate()(4).
  stagePointsFactor: 4, //     A (feature guard) — the window must resolve the shortest STAGE, not only the fastest
  //                            PERIOD: a short spike/burst inside a long period falls between two period-spaced
  //                            samples and VANISHES. windowS ≤ shortestFeatureStage / stagePointsFactor keeps
  //                            ≥ 4 samples across the shortest ramp/hold (a 120 s spike ⇒ ≤ 30 s windows, whatever
  //                            its period). Prometheus rate() ≥4 samples/window; > Nyquist's ≥2 (rateSampleRule).
  minWindowOverServiceS: 10, // A-guard — a window must be ≥ 10× the slowest station's mean service time, else the
  //                            quasi-static M/M/c read is WITHHELD (equilibrium not reached in-window).
  // C — live-vs-rest split (rides the app's fp32-preview / fp64-confirm resting handshake).
  livePointsPerCycle: 24, //   coarse LIVE sweep ⇒ hourly for a day; ρ envelope + worst-window locator only.
  liveWindowTarget: 300, //    hard cap on live windows (Datadog's ≤~300-interval default). If it binds on a long
  //                            span, LIVE resolves the SLOW envelope; the fine locate + DES run at rest.
  // B — observation span = slowest cycle's periodS × spanRepeats.
  spanRepeats: 2, //           AWS predictive scaling trains on up to 14 days = 2 weekly periods for a pattern.
  spanRepeatsFloor: 1, //      …but ≥ 1 full period (AWS's 24 h / one-period minimum) so a one-shot plays once.
  // D — Tier-2 DES neighbourhood = widest window that fits the event budget at the peak rate.
  tier2WarmupFraction: 0.5, // this fraction precedes the peak as WARM-UP (Welch / replication-deletion: discard
  //                            the initial transient before measuring; here it SEEDS the peak). Rest = drain.
  liveTier2Events: 500_000, // the AMBIENT Tier-2 budget — smaller than the engine's one-shot TRANSIENT_EVENT_CAP
  //                            (5M) so the at-rest DES refine lands in seconds off-thread and latest-wins keeps up,
  //                            exactly as the ambient Monte-Carlo runs a reduced N (500) vs the MCP's full-N. It
  //                            SIZES the neighbourhood (a smaller budget ⇒ a narrower window), so the refine stays
  //                            responsive; a one-shot MCP `simulate` omits it and uses the full engine cap.
  desSeed: 7, //               reproducible DES draw — absorbed verbatim from STRESS_DEFAULTS.seed (below).
} as const;

/** Provenance kept beside the values (the RDS_PRICING_SOURCE / RELIABILITY_SOURCES idiom). */
export const LOAD_STAGES_SOURCES = {
  windowResolution: 'https://docs.datadoghq.com/dashboards/functions/rollup/', //            A · Datadog ≤~300 intervals
  rateSampleRule: 'https://www.robustperception.io/what-range-should-i-use-with-rate/', //    A · Prometheus ≥4 samples
  liveWindowTarget: 'https://docs.datadoghq.com/dashboards/functions/rollup/', //             C · Datadog live budget
  spanRepeats: 'https://docs.aws.amazon.com/autoscaling/ec2/userguide/predictive-scaling-policy-overview.html', // B
  tier2Warmup: 'https://rossetti.github.io/RossettiArenaBook/statistical-analysis-techniques-for-warmup-detection.html', // D
} as const;

/**
 * The absorbed stress-spike defaults. The one-shot spike
 * probe's numbers, now the single source for BOTH the transient probe (content/sda/src/stress.ts imports these)
 * AND the `spike` preset below (built from them, so they can never drift). A ×3 spike for 120 s over a 30 s
 * baseline with 5 s ramps, seed 7.
 */
export const STRESS_DEFAULTS = { multiplier: 3, spikeS: 120, rampS: 5, baselineS: 30, seed: 7 } as const;

// @algorithm Multi-cycle λ(t) generator rate (baseline-anchored piecewise product)
// @problem A generator's demand is not one ramp but SEVERAL periodic shapes at once (a diurnal rhythm times a
//   quarterly-report window), and every surface — the DES arrival stream, the Tier-1 sweep, the editor preview and
//   the derived mean/peak — must read the SAME instantaneous rate, or the DRAWN shape and the EVALUATED shape drift.
// @approach Model each cycle as a k6-style piecewise-linear MULTIPLIER anchored at ×1, and read the generator's
//   instantaneous rate as the scalar product λ(t) = level · Π_cycles m_c(t mod periodS_c). Derive the mean (cost)
//   and peak (verdicts) by sampling that product over one slowest period; lowering to the DES samples the same
//   product to a fine piecewise-linear profile (the ×m̄ baseline compensation, §9), so drawn == evaluated.
// @complexity O(cycles) per instant; O(restPointsPerCycle) samples per slowest period for the mean/peak + profile.
// @citations k6 ramping-arrival-rate stages; Gatling injection profiles; superposition of periodic demand.
// @invariants A FLAT generator (no cycles / all ×1) is byte-identical to steady generate(level) — the sacred pin;
//   the product of piecewise-linear cycles is piecewise-quadratic, so the scalar λ(t) is the exact reader (§5).
// @where-tested content/sda/src/analysis/load-stages.test.ts
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The λ(t) evaluator — ONE home shared by the DES lowering (sim.ts) and the analytic sweep (time-sweep.ts).
// A single cycle is piecewise-linear; the PRODUCT of several is piecewise-quadratic (§5 honest limit), so the
// scalar λ(t) is the exact reader, and lowering a multi-cycle stream to a profile SAMPLES the product (§9).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Lower ONE cycle to the time engine's {@link RateProfile} — the baseline-anchored
 * MULTIPLIER shape: the profile starts at `×1` at t = 0, then a vertex `(Σ durationS ≤ i, multiplierᵢ)` per
 * stage; the wrap segment (last vertex → first vertex + period) holds/returns to the `×1` tail. This is exactly
 * the construction the stress probe already performs for its spike, generalised to any authored cycle. Values are
 * multipliers (mean = the shape's mean), NOT yet scaled by the level.
 */
export function cycleToProfile(cycle: Cycle): RateProfile {
  const points: RateProfilePoint[] = [{ t: 0, m: 1 }]; // the ×1 baseline start (load-stages §4)
  let cum = 0;
  for (const s of cycle.stages) {
    cum += s.durationS;
    // A vertex at exactly periodS collides with the wrap point (0, ×1); the wrap segment then carries the tail,
    // so we keep only vertices strictly inside the period (authored presets keep Σ durationS < periodS).
    if (cum < cycle.periodS) points.push({ t: cum, m: s.multiplier });
  }
  return { periodS: cycle.periodS, points };
}

/** The instantaneous multiplier of ONE cycle at absolute time `t` (piecewise-linear, wraps periodically). */
export function cycleMultiplier(cycle: Cycle, t: number): number {
  return profileValue(cycleToProfile(cycle), t);
}

/**
 * The generator's instantaneous rate λ(t) = level · Π_cycles m_c(t). Empty/absent cycles ⇒ the flat baseline `level` (the sacred identity). The scalar product of a
 * handful of numbers — exact and cheap, which is exactly what the Tier-1 sweep reads per window.
 */
export function generatorRate(level: number, cycles: readonly Cycle[] | undefined, t: number): number {
  if (cycles === undefined || cycles.length === 0) return level;
  let m = 1;
  for (const c of cycles) m *= cycleMultiplier(c, t);
  return level * m;
}

/** The slowest (largest) period among the cycles, or 0 when there are none. */
export function slowestPeriodS(cycles: readonly Cycle[]): number {
  return cycles.reduce((mx, c) => Math.max(mx, c.periodS), 0);
}

/** The fastest (smallest) period among the cycles, or 0 when there are none. */
export function fastestPeriodS(cycles: readonly Cycle[]): number {
  return cycles.reduce((mn, c) => (mn === 0 ? c.periodS : Math.min(mn, c.periodS)), 0);
}

/** A near-instant step (a "hard step" is the shortest representable ramp — doc: load-stages §9, tension 4). It is a
 *  transition EDGE, not a plateau to sample, so the feature-resolution below looks past it. */
const STEP_S = 1;

/**
 * The shortest STAGE the fine sweep must resolve — the smallest ramp/hold `durationS`
 * across all cycles, EXCLUDING the near-instant hard-step edges (`durationS ≤ STEP_S`), which are transitions, not
 * features to sample (the 60 s ON plateau behind a 1 s step is the feature, not the step). This is what stops a
 * short spike/burst inside a long PERIOD from falling between two period-spaced samples: the window is also bounded
 * to `shortestFeatureStageS / stagePointsFactor`. 0 when there are no such stages (no cycles, or all hard steps —
 * then the period resolution alone governs). Pure; deterministic.
 */
export function shortestFeatureStageS(cycles: readonly Cycle[]): number {
  let min = 0;
  for (const c of cycles) {
    for (const stage of c.stages) {
      if (stage.durationS <= STEP_S) continue; // a hard-step edge, not a plateau/ramp feature
      if (min === 0 || stage.durationS < min) min = stage.durationS;
    }
  }
  return min;
}

/**
 * The auto-derived observation span — the slowest cycle's period × `spanRepeats`
 * (floored at `spanRepeatsFloor` full periods so a one-shot still plays once). 0 when there are no cycles.
 */
export function observationSpanS(cycles: readonly Cycle[]): number {
  const slow = slowestPeriodS(cycles);
  if (slow === 0) return 0;
  return slow * Math.max(LOAD_STAGES_DEFAULTS.spanRepeatsFloor, LOAD_STAGES_DEFAULTS.spanRepeats);
}

/** The number of sample points over one slowest period at a given points-per-cycle budget, resolving the fastest
 *  cycle (spacing ≤ fastestPeriod / pointsPerCycle) — the shared window-count arithmetic (§10.2, §16.3 A/C). */
function pointsOverSpan(cycles: readonly Cycle[], pointsPerCycle: number, spanS: number): number {
  const fast = fastestPeriodS(cycles);
  if (fast === 0 || spanS <= 0) return 1;
  const spacing = fast / pointsPerCycle;
  return Math.max(2, Math.ceil(spanS / spacing));
}

/** Sample λ̂(t) = Π_cycles m_c(t) (the shape only, level = 1) over `spanS` at `count` evenly-spaced points. */
function sampleShape(cycles: readonly Cycle[], spanS: number, count: number): number[] {
  const out: number[] = [];
  const dt = spanS / count;
  for (let i = 0; i < count; i++) {
    let m = 1;
    for (const c of cycles) m *= cycleMultiplier(c, i * dt);
    out.push(m);
  }
  return out;
}

/**
 * Sample the generator's baseline-anchored SHAPE — λ̂(t) = Π_cycles m_c(t), level = 1 — over ONE slowest period at
 * `count` evenly-spaced points. The ONE sampler the AUTHORING previews
 * read (the web editor's SVG sparkline, the canvas node-chip glyph), so the DRAWN shape is the EVALUATED shape — the
 * anti-drift discipline the wire pill already follows (§11, "web is a dumb renderer"). A FLAT generator (no cycles,
 * or an all-`×1` shape) ⇒ a flat `×1` series (the sacred identity), so previewing a levelled-but-unshaped generator
 * is a straight line, not a fabricated wiggle. `count` is floored at 1 (a degenerate ask still returns a point).
 */
export function shapeSeries(cycles: readonly Cycle[] | undefined, count: number): number[] {
  const n = Math.max(1, Math.floor(count));
  if (cycles === undefined || cycles.length === 0) return new Array<number>(n).fill(1);
  return sampleShape(cycles, slowestPeriodS(cycles), n);
}

/**
 * The DERIVED MEAN rate over the observation span — `level × mean(Π cycles)`, the honest
 * bill reader (a 120 s spike inside a quarter barely moves it). Exact for ≤ 1 cycle (the profile trapezoid mean);
 * for ≥ 2 cycles the product is piecewise-quadratic (§5), so it is integrated by fine sampling over one slowest
 * period. No cycles ⇒ `level` (flat).
 */
export function derivedMean(level: number, cycles: readonly Cycle[] | undefined): number {
  if (cycles === undefined || cycles.length === 0) return level;
  if (cycles.length === 1) return level * profileMean(cycleToProfile(cycles[0] as Cycle));
  const span = slowestPeriodS(cycles);
  const samples = sampleShape(cycles, span, pointsOverSpan(cycles, LOAD_STAGES_DEFAULTS.restPointsPerCycle, span));
  return level * (samples.reduce((s, x) => s + x, 0) / samples.length);
}

/**
 * The DERIVED PEAK rate over the observation span — `level × peak(Π cycles)`, the worst
 * instant capacity/verdicts are judged at. Exact for ≤ 1 cycle (a piecewise-linear max is at a vertex); for ≥ 2
 * cycles the peaks SUPERIMPOSE where they coincide (§5), captured by fine sampling over one slowest period. No
 * cycles ⇒ `level` (flat).
 */
export function derivedPeak(level: number, cycles: readonly Cycle[] | undefined): number {
  if (cycles === undefined || cycles.length === 0) return level;
  if (cycles.length === 1) return level * profilePeak(cycleToProfile(cycles[0] as Cycle));
  const span = slowestPeriodS(cycles);
  const samples = sampleShape(cycles, span, pointsOverSpan(cycles, LOAD_STAGES_DEFAULTS.restPointsPerCycle, span));
  return level * samples.reduce((mx, x) => Math.max(mx, x), 0);
}

/**
 * The combined baseline-anchored MULTIPLIER shape of ONE generator's cycles (the product Π cycles), as a
 * {@link RateProfile} whose values are multipliers (mean = the shape's mean), or `undefined` when the generator
 * is FLAT (no cycles, or every multiplier `×1`) — the silent default that keeps the DES stream byte-for-byte
 * today's. Exact for a single cycle; for ≥ 2 cycles the piecewise-quadratic product is SAMPLED to a fine
 * piecewise-linear profile over one slowest period.
 */
export function combinedCycleProfile(cycles: readonly Cycle[] | undefined): RateProfile | undefined {
  if (cycles === undefined || cycles.length === 0) return undefined;
  if (cycles.length === 1) {
    const p = cycleToProfile(cycles[0] as Cycle);
    return isFlatProfile(p) ? undefined : p; // an all-×1 cycle IS a flat generator — the silent byte-identity
  }
  const span = slowestPeriodS(cycles);
  const count = pointsOverSpan(cycles, LOAD_STAGES_DEFAULTS.restPointsPerCycle, span);
  const dt = span / count;
  const points: RateProfilePoint[] = [];
  for (let i = 0; i < count; i++) {
    let m = 1;
    for (const c of cycles) m *= cycleMultiplier(c, i * dt);
    points.push({ t: i * dt, m });
  }
  const profile: RateProfile = { periodS: span, points };
  return isFlatProfile(profile) ? undefined : profile;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// §16.3 — the six shipped PRESETS, as pure DATA. A preset pre-fills the cycles table and is fully editable after
// (never a mode, §4). Each is one real tool's canonical scenario, in relative multipliers off the baseline.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The names of the shipped presets. */
export type LoadStagePreset = 'flat' | 'spike' | 'ramp-up' | 'diurnal' | 'on-off-burst' | 'quarterly-report';

const s = (durationS: number, multiplier: number): Stage => ({ durationS, multiplier });

/**
 * A ONE-SHOT shape's natural period — its own total scheduled duration (Σ durationS),
 * so the cycle is SHORT and the auto-derived span (periodS × spanRepeats) stays a FEW MULTIPLES of the shape. The
 * old encoding used a huge non-repeating period (30 days) purely to be "one-shot", which poisoned both the span AND
 * the resolution: windowS = period / restPointsPerCycle then straddled the whole spike, so a 120 s spike fell
 * between two 7.5-hour samples and vanished. A short natural period fixes both — the sweep resolves the spike, and
 * "one repeat" plays it once while spanRepeats shows it recur. A shape ending at the ×1 baseline (spike) wraps
 * losslessly; one ending off-baseline (ramp-up) resolves its final vertex through the baseline-returning wrap.
 */
const oneShotPeriodS = (stages: readonly Stage[]): number => stages.reduce((total, st) => total + st.durationS, 0);

// spike — SDA's shipped STRESS_DEFAULTS {mult 3, spike 120 s, ramp 5 s, base 30 s}, absorbed. k6 spike / Gatling
//   stressPeakUsers heaviside. One-shot: base → ramp → hold ×3 → ramp back to baseline (ends at ×1 ⇒ lossless wrap).
const SPIKE_STAGES: readonly Stage[] = [
  s(STRESS_DEFAULTS.baselineS, 1),
  s(STRESS_DEFAULTS.rampS, STRESS_DEFAULTS.multiplier),
  s(STRESS_DEFAULTS.spikeS, STRESS_DEFAULTS.multiplier),
  s(STRESS_DEFAULTS.rampS, 1),
];
// ramp-up — k6 ramping-arrival-rate canonical example (start → ramp up → hold → ramp down), in relative terms.
const RAMP_UP_STAGES: readonly Stage[] = [s(60, 1), s(120, 2), s(240, 2), s(120, 0.2)];

/**
 * The six presets. `flat` has NO cycles (the ×1 identity — the sacred pin). The `spike`
 * preset is BUILT FROM {@link STRESS_DEFAULTS} so the absorbed numbers can never drift from the transient probe.
 * The two ONE-SHOT presets (spike, ramp-up) take {@link oneShotPeriodS} as their period — a SHORT cycle, so the
 * sweep resolves them; the periodic presets (diurnal, on-off-burst, quarterly-report) keep their real periods.
 */
export const LOAD_STAGES_PRESETS: Readonly<Record<LoadStagePreset, readonly Cycle[]>> = {
  // flat — the ×1 identity; byte-identical to steady generate(level) (§9).
  flat: [],
  spike: [{ periodS: oneShotPeriodS(SPIKE_STAGES), stages: SPIKE_STAGES }],
  'ramp-up': [{ periodS: oneShotPeriodS(RAMP_UP_STAGES), stages: RAMP_UP_STAGES }],
  // diurnal — a looped day (periodS = 86 400): 2–3× peak-to-trough, internet rush hour 18–22 h. Peak ×1.8.
  //   Σ durationS = 82 800 s < 86 400; the wrap segment ramps the late-evening ×0.5 back to the midnight ×1.
  diurnal: [{ periodS: 86_400, stages: [s(18_000, 0.5), s(14_400, 1), s(28_800, 1.8), s(14_400, 1.8), s(7_200, 0.5)] }],
  // on-off-burst — a repeated square wave (periodS = 600): a ×5 burst for ~1 min, then quiet. cron/batch pulse.
  'on-off-burst': [{ periodS: 600, stages: [s(STEP_S, 5), s(59, 5), s(STEP_S, 1), s(500, 1)] }],
  // quarterly-report — a short ×3 report window on a 90-day period, BUILT TO MULTIPLY with `diurnal` (§5, Fig. 2).
  'quarterly-report': [{ periodS: 7_776_000, stages: [s(2_592_000, 1), s(10_800, 3), s(86_400, 3), s(10_800, 1)] }],
};
