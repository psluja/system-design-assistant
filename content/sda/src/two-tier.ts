// @algorithm Two-tier transient evaluation (propose cheap, prove exact — over time)
// @problem A multi-cycle season is far too long to simulate arrival-by-arrival, yet the mean-load steady answer
//   hides the daily peak: the ambient transient question needs a cheap whole-season scan AND an exact proof at the
//   one instant that matters — without a play button, and without blurring which basis produced which number.
// @approach TIER 1 — the analytic quasi-static sweep (time-sweep.ts) scans the ρ-envelope over the auto-derived
//   span and returns the worst window (basis analytic). TIER 2 — a targeted transient DES (engine/sim/transient.ts)
//   zooms ONLY that worst window over a cap-fit neighbourhood, playing each origin's real λ(t), and reads the
//   survival verdict — does it drain, how fast, where the backlog piled, what the tail cost (basis measured).
// @complexity Tier 1 O(windows × evaluate); Tier 2 one bounded DES over the worst-window neighbourhood.
// @citations "propose/prove" (an analytic screen, then simulate the survivor); Welch's warm-up for the transient.
// @invariants The two labelled bases are never blurred; silent (undefined) with no shaped generator; the DES
//   truncates LOUDLY under the event cap (a PARTIAL window, never scaled); deterministic for the seed.
// @where-tested content/sda/src/two-tier.e2e.test.ts

// THE TWO-TIER EVALUATION (doc: load-stages §10) — the load-bearing composition. Tier 1 (the analytic time-sweep,
// time-sweep.ts) is the cheap PROPOSAL: it sweeps the M/M/c response across the whole season and returns the ρ
// envelope, the worst window, the cost integral and the %-in-violation — basis `analytic (quasi-static)`. Tier 2
// is the expensive PROOF: on the one worst window Tier 1 found, it runs the untouched transient DES
// (engine/sim/src/transient.ts) over a NEIGHBOURHOOD sized to fit the 5M-event cap at the peak rate (half of it
// warm-up so the queue is not cold at the peak — Welch's method, §16.2 D), and reads THE SURVIVAL VERDICT (does
// the worst window drain, how fast, where the backlog peaked, what the tail cost) — basis `measured (transient)`.
//
// This is where the global stress probe's valuable work lives on: the survival verdict FORM
// (`StressVerdict`) and the whole windowed-metrics machinery are reused AS-IS, only re-aimed from a synthetic
// multiply-all-origins spike to the design's OWN declared cycles played at their worst instant (doc §8). Two
// labelled bases, never blurred — the tool must not lie.
//
// The neighbourhood plays the REAL λ(t) of each shaped origin (Σ_gens level · Π cycles(t)) over the window as a
// baseline-anchored RateProfile (the ×m̄ compensation, §9) — the multi-cycle product is nearly linear over a
// narrow window (§5 honest limit), so a fine linear sample of it is accurate. A flat/disabled origin keeps its
// constant rate. The 5M-event cap and its loud truncation are the engine's own (transient.ts), reused as-is.

import type { Graph } from '@sda/engine-core';
import {
  backlogGrowingAtEnd,
  drainTimeS,
  estimateTransientEvents,
  profileMean,
  simulate,
  TRANSIENT_EVENT_CAP,
  type ArrivalSource,
  type QueueingNetwork,
  type RateProfile,
  type RateProfilePoint,
  type TransientMetrics,
  type TransientWindow,
} from '@sda/engine-sim';
import { LOAD_STAGES_DEFAULTS, generatorRate } from './load-stages';
import { timeSweep, shapedOriginsOf, type ShapedOrigin, type TimeSweep } from './time-sweep';
import type { EvaluateGraph } from './scenario';
import { toQueueingNetwork } from './sim';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The re-homed SURVIVAL VERDICT (doc: load-stages §2.2 — the answer form "stays") — moved here verbatim from the
// deleted global stress probe (content/sda/src/stress.ts), its only change the basis label: the input is now the
// design's OWN cycles at the worst window, not a synthetic global spike, so the honest basis is `measured
// (transient)`. Not a `sim` suffix — Tier 1 is the analytic tier, so "transient" already means the measured one.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every Tier-2 number is a measurement from the seeded transient DES run over the worst window — the one basis. */
export const TRANSIENT_BASIS = 'measured (transient)' as const;

/** THE SURVIVAL VERDICT — the one answer form for "at the worst window, does the design hold and recover?"
 *  (doc: load-stages §2.2, re-homed unchanged). */
export interface StressVerdict {
  /** Did the design return to its own entry-flank baseline (backlog AND tail) after the worst instant passed? */
  readonly survives: boolean;
  /** Seconds from the worst instant until the first fully-recovered window — null when recovery was not observed. */
  readonly recoversInS: number | null;
  /** The worst queue built anywhere: which node, how many waiting, and when — null when nothing ever queued. */
  readonly peakBacklog: { readonly node: string; readonly value: number; readonly atS: number } | null;
  /** Worst windowed p99 while the load rose to the peak (ms; NaN when nothing completed then — honest, never 0). */
  readonly p99DuringMs: number;
  /** The last measured windowed p99 after the peak passed (ms; NaN when nothing completed after). */
  readonly p99AfterMs: number;
  /** Requests that FAILED over the whole neighbourhood (retries exhausted / dropped with none left). */
  readonly lostRequests: number;
  /** Peak windowed retry amplification over the neighbourhood (×1 = no retry traffic; NaN with no arrivals). */
  readonly amplificationPeak: number;
  /** The honest one-line story — including the death-spiral wording and the partial-window wording. */
  readonly note: string;
  readonly basis: typeof TRANSIENT_BASIS;
}

/** One windowed bucket for the surfaces (times in ms — the shells' unit; the engine keeps seconds). */
export interface Tier2Window {
  readonly startS: number;
  readonly endS: number;
  readonly arrivals: number;
  readonly served: number;
  readonly failed: number;
  readonly p50Ms: number;
  readonly p99Ms: number;
  readonly amplification: number;
}

/** One node's backlog series for the surfaces (the sparkline's data): per-window max + the peak and its time. */
export interface Tier2Backlog {
  readonly node: string;
  readonly perWindow: readonly number[];
  readonly peak: number;
  readonly peakAtS: number;
}

/** Budget honesty, surfaced verbatim: the estimate, what was processed, the cap, and whether it was cut short. */
export interface Tier2Budget {
  readonly estimatedEvents: number;
  readonly eventsProcessed: number;
  readonly eventCap: number;
  readonly truncated: boolean;
  /** The observed end (seconds into the neighbourhood) — < horizonS exactly when truncated. */
  readonly endS: number;
}

/** The resolved Tier-2 neighbourhood timeline (all seconds, LOCAL to the neighbourhood unless suffixed absolute). */
export interface Tier2Phases {
  /** The neighbourhood's absolute start (seconds into the whole span). */
  readonly startAbsS: number;
  /** The worst instant, LOCAL to the neighbourhood (= warm-up length; recovery is measured from here). */
  readonly peakAtS: number;
  /** The neighbourhood width (seconds) = the transient horizon. */
  readonly horizonS: number;
  /** The windowed-metric bucket width (seconds). */
  readonly windowS: number;
}

/** The Tier-2 result: the survival verdict + windowed diagnosis + budget honesty, plus WHERE (the worst instant). */
export interface Tier2Result {
  readonly verdict: StressVerdict;
  readonly windows: readonly Tier2Window[];
  readonly backlog: readonly Tier2Backlog[];
  readonly phases: Tier2Phases;
  readonly budget: Tier2Budget;
  readonly seed: number;
  /** The worst window Tier 1 handed Tier 2: its absolute instant, its ρ and the node that peaked. */
  readonly worst: { readonly atS: number; readonly rho: number; readonly node: string };
}

/** The pure, structured-clonable job a worker runs: the windowed network + the transient options + the resolved
 *  phases. Built on the main thread ({@link tier2Job}); {@link runTier2} does the heavy DES off-thread. */
export interface Tier2Job {
  readonly net: QueueingNetwork;
  readonly transient: { readonly horizonS: number; readonly windowS: number; readonly maxEvents: number };
  readonly phases: Tier2Phases;
  readonly seed: number;
  readonly worst: { readonly atS: number; readonly rho: number; readonly node: string };
}

/** The composed two-tier result — two LABELLED bases, honest (doc: load-stages §10). Tier 2 is absent for a
 *  design whose worst window is degenerate (no station queued at all) — the no-filler rule. */
export interface TwoTierResult {
  readonly tier1: TimeSweep;
  readonly tier2?: Tier2Result;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Tier 2 — the targeted transient (doc: load-stages §10.3).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Recovery tolerance (re-homed from the probe): a window counts as recovered when its p99 is within ×1.5 of the
 *  entry-flank window p99 (+5 ms absolute slack) AND every backlog is within the entry-flank max. */
const P99_TOLERANCE = 1.5;
const P99_SLACK_S = 0.005;

/** Sample count for a shaped origin's windowed λ profile — fine enough that the piecewise-quadratic product (§5)
 *  is accurately linearised over the narrow neighbourhood. */
const WINDOW_PROFILE_SAMPLES = 256;

/** Target windowed-metric bucket count over the neighbourhood — enough to resolve build/drain slopes and to feed
 *  a compact backlog sparkline, whatever the neighbourhood's absolute scale (seconds to hours). */
const TIER2_BUCKETS = 60;

/** Leave headroom under the hard event cap so a well-sized neighbourhood does not routinely truncate; if the
 *  estimate is off and the run still binds, the transient runner truncates LOUDLY (budget honesty), never scaled. */
const CAP_SAFETY = 0.85;

/** The instantaneous total λ a shaped origin offers at absolute time `t` (Σ over its generators). */
function originRateAt(origin: ShapedOrigin, t: number): number {
  return origin.gens.reduce((s, g) => s + generatorRate(g.level, g.cycles, t), 0);
}

/** A shaped origin's windowed λ(t) lowered to a baseline-anchored one-shot RateProfile over the neighbourhood
 *  [startAbsS, startAbsS + horizonS] (the ×m̄ compensation, §9: rate = the profile mean, so effective λ = P(t)). */
function windowProfile(origin: ShapedOrigin, startAbsS: number, horizonS: number): { readonly rate: number; readonly profile: RateProfile } {
  const points: RateProfilePoint[] = [];
  for (let j = 0; j < WINDOW_PROFILE_SAMPLES; j++) {
    const localT = (j / WINDOW_PROFILE_SAMPLES) * horizonS;
    points.push({ t: localT, m: Math.max(0, originRateAt(origin, startAbsS + localT)) });
  }
  const profile: RateProfile = { periodS: horizonS, points };
  return { rate: profileMean(profile), profile };
}

/**
 * Build the Tier-2 DES job for the worst window a Tier-1 {@link TimeSweep} found (doc: load-stages §10.3). Returns
 * `undefined` when the design has no shaped origin or no station could ever queue. The neighbourhood is the widest
 * window around the worst instant that fits the 5M-event cap at the peak rate, with `tier2WarmupFraction` of it
 * preceding the peak as warm-up. Each shaped origin's arrival carries the REAL windowed λ(t); flat origins keep
 * their constant rate; retry policies ride through (the death-spiral must still be measurable).
 */
export function tier2Job(graph: Graph, sweep: TimeSweep, maxEvents: number = TRANSIENT_EVENT_CAP): Tier2Job | undefined {
  const origins = shapedOriginsOf(graph);
  if (origins.length === 0) return undefined;
  const baseNet = toQueueingNetwork(graph);
  if (baseNet.arrivals.length === 0 || baseNet.stations.length === 0) return undefined;
  const originByNode = new Map(origins.map((o) => [o.nodeId, o] as const));

  const worstWindow = sweep.windows[sweep.worstWindowIndex];
  if (worstWindow === undefined) return undefined;
  const peakAbsS = worstWindow.tStartS + sweep.windowS / 2; // the window's mid-instant — the same read Tier 1 took
  // The node that peaked at the worst window (argmax ρ), named in the verdict.
  let worstNode = '';
  for (const [id, rho] of Object.entries(worstWindow.rhoByNode)) if (rho >= (worstWindow.rhoByNode[worstNode] ?? -1)) worstNode = id;

  // Size the neighbourhood to fit the cap at the PEAK rate: estimate events/second at the mean, scale by the
  // peak-to-mean ratio, and take the width that fits CAP_SAFETY × the cap. Floored at one Tier-1 window, capped by
  // the whole span (nothing to observe beyond it).
  let meanTotal = 0;
  let peakTotal = 0;
  for (const src of baseNet.arrivals) {
    const rate = src.interarrival.kind === 'exponential' ? src.interarrival.rate : 0;
    meanTotal += rate;
    const origin = originByNode.get(String(src.at));
    peakTotal += origin ? originRateAt(origin, peakAbsS) : rate;
  }
  const peakFactor = meanTotal > 0 ? Math.max(1, peakTotal / meanTotal) : 1;
  const eventsPerSecPeak = Math.max(1, estimateTransientEvents(baseNet, 1) * peakFactor);
  // The widest window that fits the budget at the peak rate, clamped by the whole span. NOT floored above the
  // budget: flooring at a Tier-1 window would let a high-rate peak overrun the cap and truncate — instead the width
  // shrinks with the rate (hours at a few-hundred rps, seconds at multi-thousand — doc §10.3), and the loud
  // truncation stays the honest backstop only when the estimate is off, not a designed-in overshoot.
  const horizonS = Math.min(sweep.spanS, (maxEvents * CAP_SAFETY) / eventsPerSecPeak);

  const startAbsS = Math.max(0, peakAbsS - LOAD_STAGES_DEFAULTS.tier2WarmupFraction * horizonS);
  const peakAtS = peakAbsS - startAbsS; // the worst instant, local to the neighbourhood
  const windowS = Math.max(1, Math.round(horizonS / TIER2_BUCKETS));

  // Replace each shaped origin's arrival with the windowed λ(t); flat/non-Poisson arrivals are unchanged.
  const arrivals: ArrivalSource[] = baseNet.arrivals.map((src) => {
    const origin = originByNode.get(String(src.at));
    if (origin === undefined || src.interarrival.kind !== 'exponential') return src;
    const { rate, profile } = windowProfile(origin, startAbsS, horizonS);
    return { ...src, interarrival: { kind: 'exponential' as const, rate }, rateProfile: profile };
  });

  return {
    net: { ...baseNet, arrivals },
    transient: { horizonS, windowS, maxEvents },
    phases: { startAbsS, peakAtS, horizonS, windowS },
    seed: LOAD_STAGES_DEFAULTS.desSeed,
    worst: { atS: peakAbsS, rho: worstWindow.rhoMax, node: worstNode },
  };
}

/** Round for the note's prose — whole numbers read honestly for seconds/counts at this scale. */
const whole = (n: number): number => Math.round(n);

/** The per-window TOTAL station backlog series (Σ over stations of each window's max) — the divergence signal. */
function backlogTotals(t: TransientMetrics): number[] {
  return t.windows.map((_, i) => t.backlog.reduce((s, b) => s + (b.maxPerWindow[i] ?? 0), 0));
}

/**
 * Is the backlog DIVERGING over the neighbourhood — the ρ≥1 sustained-overload signature? At a cyclic worst window
 * the load is a broad plateau (a diurnal peak is hours wide), so a cap-bounded neighbourhood sees CONSTANT load,
 * not a spike that returns to a cold baseline: the honest survival question is "is the queue BOUNDED or growing?".
 * A robust two-halves trend test (after a warm-up quarter) beats the single-step {@link backlogGrowingAtEnd} noise:
 * a stable ρ<1 queue fluctuates around a flat mean (halves equal ⇒ bounded); a ρ≥1 queue climbs (last half ≫ first).
 */
function backlogDiverging(t: TransientMetrics): boolean {
  const totals = backlogTotals(t);
  const n = totals.length;
  if (n < 4) return backlogGrowingAtEnd(t);
  const skip = Math.floor(n * 0.25); // discard the initial warm-up transient (Welch) before trending
  const mid = Math.floor((skip + n) / 2);
  const mean = (from: number, to: number): number => {
    let s = 0;
    for (let i = from; i < to; i++) s += totals[i] as number;
    return to > from ? s / (to - from) : 0;
  };
  const firstHalf = mean(skip, mid);
  const lastHalf = mean(mid, n);
  return (totals[n - 1] ?? 0) > 0 && lastHalf > Math.max(1, firstHalf) * 1.5;
}

/** Compute THE SURVIVAL VERDICT from the engine's windowed observation of the neighbourhood (the one reading). */
function transientVerdict(t: TransientMetrics, phases: Tier2Phases, worstNode: string): StressVerdict {
  const diverging = backlogDiverging(t);
  // A genuine transient (a rise-then-fall neighbourhood, e.g. an on-off burst) can DRAIN back to its entry flank;
  // measured from the worst instant against the entry-flank first bucket. Null for a flat plateau (nothing to drain
  // from) — then survival rests on the divergence test, not on a return-to-cold-baseline that does not apply.
  const recoversInS = diverging
    ? null
    : drainTimeS(t, { spikeEndS: phases.peakAtS, baselineEndS: phases.windowS, p99Tolerance: P99_TOLERANCE, p99SlackS: P99_SLACK_S });

  let peakBacklog: StressVerdict['peakBacklog'] = null;
  for (const b of t.backlog) {
    if (b.peak > 0 && (peakBacklog === null || b.peak > peakBacklog.value)) {
      peakBacklog = { node: String(b.id), value: b.peak, atS: b.peakAtS };
    }
  }

  // p99 DURING = worst windowed p99 while the load rose to the peak; p99 AFTER = the last post-peak window that
  // measured anything. NaN stays NaN — honest "no data", never 0.
  const during = t.windows.filter((w) => w.endS > phases.windowS && w.startS < phases.peakAtS && w.samples > 0);
  const p99DuringMs = during.length > 0 ? Math.max(...during.map((w) => w.p99S)) * 1000 : NaN;
  const after = t.windows.filter((w) => w.startS >= phases.peakAtS && w.samples > 0);
  const lastAfter: TransientWindow | undefined = after[after.length - 1];
  const p99AfterMs = lastAfter !== undefined ? lastAfter.p99S * 1000 : NaN;

  const lostRequests = t.windows.reduce((s, w) => s + w.failed, 0);
  const storm = t.windows.filter((w) => Number.isFinite(w.amplification));
  const amplificationPeak = storm.length > 0 ? Math.max(...storm.map((w) => w.amplification)) : NaN;

  const survives = !diverging;
  const lost = lostRequests > 0 ? `, but ${lostRequests} requests were lost` : ', no requests lost';
  const where = peakBacklog !== null ? ` (${peakBacklog.value} waiting at ${peakBacklog.node})` : worstNode !== '' ? ` (at ${worstNode})` : '';
  let note: string;
  if (diverging) {
    note = `does not recover: backlog still growing at the worst window${where}`;
  } else if (recoversInS !== null) {
    note = `worst window recovers within ~${whole(recoversInS)}s of the peak${lost}`;
  } else {
    note = `holds through the busy period — the queue stays bounded at the peak${lost}`;
  }
  if (t.truncated) {
    note += ` · event budget exhausted: ${t.eventsProcessed.toLocaleString('en-US')} of ~${t.estimatedEvents.toLocaleString('en-US')} estimated events (cap ${t.eventCap.toLocaleString('en-US')}) — results cover only [0, ${whole(t.endS)}s], a PARTIAL window (never scaled)`;
  }

  return { survives, recoversInS, peakBacklog, p99DuringMs, p99AfterMs, lostRequests, amplificationPeak, note, basis: TRANSIENT_BASIS };
}

/**
 * Run the Tier-2 DES for a prepared {@link Tier2Job} (doc: load-stages §10.3) — the seeded transient over the
 * worst-window neighbourhood, read into the survival verdict + windowed diagnosis + budget honesty. Pure of the
 * graph (it takes the structured-clonable job), so a worker can run it off-thread; deterministic for the seed.
 */
export function runTier2(job: Tier2Job): Tier2Result {
  const sim = simulate(job.net, {
    seed: job.seed,
    warmupCompletions: 0, // ignored in transient mode — time-bounded, measured from t = 0
    measureCompletions: 0,
    transient: job.transient,
  });
  const t = sim.transient as TransientMetrics; // present by construction (the transient option was set)
  const verdict = transientVerdict(t, job.phases, job.worst.node);
  return {
    verdict,
    windows: t.windows.map((w) => ({
      startS: w.startS,
      endS: w.endS,
      arrivals: w.arrivals,
      served: w.served,
      failed: w.failed,
      p50Ms: w.p50S * 1000,
      p99Ms: w.p99S * 1000,
      amplification: w.amplification,
    })),
    backlog: t.backlog.map((b) => ({ node: String(b.id), perWindow: [...b.maxPerWindow], peak: b.peak, peakAtS: b.peakAtS })),
    phases: job.phases,
    budget: { estimatedEvents: t.estimatedEvents, eventsProcessed: t.eventsProcessed, eventCap: t.eventCap, truncated: t.truncated, endS: t.endS },
    seed: job.seed,
    worst: job.worst,
  };
}

/** The input to {@link twoTierEvaluation} — a graph + the injected forward evaluator, plus the optional sweep
 *  resolution (the LIVE ambient pass passes the coarse live points; MCP/at-rest omits it for the fine sweep). */
export interface TwoTierInput {
  readonly graph: Graph;
  readonly evaluate: EvaluateGraph;
  readonly pointsPerCycle?: number;
  readonly maxWindows?: number;
  /** Tier-2 event budget (default the engine's {@link TRANSIENT_EVENT_CAP}). Also SIZES the neighbourhood (the
   *  widest window that fits it at the peak rate), so a smaller budget yields a narrower, faster refine — the
   *  knob the ambient shells and the tests turn down for snappiness. */
  readonly maxEvents?: number;
}

/**
 * The SYNC two-tier evaluation (doc: load-stages §10) — Tier-1 sweep then Tier-2 DES on its worst window, both in
 * process. Returns `undefined` when the design declares no shaped generator (silent — the no-filler rule). Used by
 * MCP `simulate` (native, sync) and the tests; the ambient shells sequence the same three seams off-thread (the
 * Tier-1 preview, then the Tier-2 confirm — the resting handshake).
 */
export function twoTierEvaluation(input: TwoTierInput): TwoTierResult | undefined {
  const tier1 = timeSweep({
    graph: input.graph,
    evaluate: input.evaluate,
    ...(input.pointsPerCycle !== undefined ? { pointsPerCycle: input.pointsPerCycle } : {}),
    ...(input.maxWindows !== undefined ? { maxWindows: input.maxWindows } : {}),
  });
  if (tier1 === undefined) return undefined;
  const job = tier2Job(input.graph, tier1, input.maxEvents);
  const tier2 = job !== undefined ? runTier2(job) : undefined;
  return { tier1, ...(tier2 !== undefined ? { tier2 } : {}) };
}
