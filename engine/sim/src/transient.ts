// @algorithm Transient (windowed) DES observation with bounded reservoirs
// @problem Answer "what happens during and after a TEMPORARY overload?" — a steady-state run discards
//   exactly the warm-up transient the question is about, and an overload window can generate unbounded
//   events and samples.
// @approach A time-bounded run over [0, horizonS] with no warm-up discard, bucketed into fixed windows;
//   per-window sojourn percentiles come from a capped uniform reservoir (Vitter's Algorithm R past the
//   cap), backlog is tracked as a per-station per-window max, and a hard event budget stops the run
//   honestly (`truncated`) rather than scaling the workload.
// @complexity O(events * log stations) simulation time (heap-driven DES); memory O(windows *
//   reservoir-cap + stations * windows), bounded regardless of arrival rate.
// @citations Vitter, "Random Sampling with a Reservoir", ACM TOMS 11(1), 1985 (Algorithm R).
// @invariants Counts are attributed to the window where they HAPPEN; the last window is clipped, never
//   stretched; truncation is explicit (endS < horizonS), results cover exactly the observed prefix;
//   empty windows answer NaN, never 0.
// @where-tested engine/sim/src/transient.test.ts

// THE TRANSIENT (WINDOWED) RUN — the time engine's answer to "what happens during and after a TEMPORARY
// overload?" (the spike probe; first client of the load-curves R1 rate profiles). A steady-state run discards the
// very thing a transient question asks about (the warm-up), so this mode is its own contract: the run is
// TIME-bounded ([0, horizonS], no completion budget, no warm-up discard — the pre-disturbance phase IS the
// baseline reference), and the result carries per-window metrics (bucketed percentiles, served/failed counts,
// retry amplification) plus a per-station BACKLOG time series (peak + when). Pure timing math over station ids —
// no domain vocabulary; what a "spike" or a "baseline" means is the caller's (content's) business.
//
// ONE-SHOT PROFILES: a {@link RateProfile} is periodic by definition; a one-shot disturbance needs no new
// mechanism because a transient run HARD-STOPS at `horizonS` — give the profile `periodS = horizonS` and the wrap
// segment is simply never replayed (pinned by test). The profile module stays the single home of curve
// arithmetic; this module adds only the windowed OBSERVATION of a run.
//
// BUDGET HONESTY (the tool must not lie): a transient run's cost is arrivals × hops, unknown until run. The
// caller gets an up-front ESTIMATE ({@link estimateTransientEvents}) to print, and the run enforces a HARD event
// cap: when the budget is exhausted the run STOPS and says so (`truncated`, `endS` < `horizonS`) — results cover
// exactly the observed prefix, never a silently scaled-down or extrapolated window.

import { mean as distributionMean } from './distribution';
import type { QueueingNetwork, StationId } from './network';

/** Opt-in transient mode for `simulate` (doc above). When present the run is TIME-bounded: it measures from t = 0
 *  (no warm-up discard — the pre-disturbance phase is the baseline) and stops at `horizonS` (or at the event cap,
 *  honestly flagged). `warmupCompletions`/`measureCompletions` are then ignored. */
export interface TransientOptions {
  /** The observation window [0, horizonS] in the network's own time unit (seconds). */
  readonly horizonS: number;
  /** Bucket width for the windowed metrics (seconds) — e.g. 10 for 10-second buckets. */
  readonly windowS: number;
  /** Hard cap on processed events (default {@link TRANSIENT_EVENT_CAP}). Exhausting it stops the run HONESTLY:
   *  `truncated: true`, `endS` = the last processed instant — never a silent scaling of the workload. */
  readonly maxEvents?: number;
}

/** Default hard event budget for a transient run — a few seconds of wall clock on any shell, bounded memory. */
export const TRANSIENT_EVENT_CAP = 5_000_000;

/** Cap on each window's sojourn reservoir (Vitter's Algorithm R past it) — per-window percentiles from a bounded
 *  uniform sample, so a high-rate window cannot grow memory past windows × cap. */
export const TRANSIENT_WINDOW_RESERVOIR_CAP = 4096;

/** One time bucket of a transient run. Counts are attributed by the instant they HAPPEN (an arrival by its
 *  arrival time, a completion by its exit time), so a long-lived request arrives in one window and completes in a
 *  later one — exactly the lag a transient question is about. */
export interface TransientWindow {
  readonly startS: number;
  /** Window end (exclusive). The LAST window may be shorter than `windowS`: it is clipped to `horizonS` — or, on
   *  a truncated run, to `endS` (the honest partial window; never silently stretched or dropped). */
  readonly endS: number;
  /** External ORIGINAL arrivals (first attempts only — retries are `attempts`). */
  readonly arrivals: number;
  /** Total attempts injected (first + retries) — `attempts / arrivals` is this window's retry amplification. */
  readonly attempts: number;
  /** Requests that SUCCEEDED (completed within their deadline) in this window. */
  readonly served: number;
  /** Requests that FAILED in this window (retries exhausted, or dropped with none left). */
  readonly failed: number;
  /** Sojourn p50 of the requests COMPLETED in this window, seconds (NaN when none — honest, never 0). */
  readonly p50S: number;
  /** Sojourn p99 of the requests COMPLETED in this window, seconds (NaN when none). */
  readonly p99S: number;
  /** Reservoir occupancy backing the percentiles (≤ {@link TRANSIENT_WINDOW_RESERVOIR_CAP}). */
  readonly samples: number;
  /** attempts ÷ arrivals for THIS window (≥ 1 under any retry policy; NaN when no arrivals — honest). */
  readonly amplification: number;
}

/** One station's BACKLOG (jobs WAITING for a server, in-service excluded) over the run: the maximum observed in
 *  each window, plus the global peak and when it happened. A station that never queued reads all zeros and
 *  `peakAtS: NaN` (it never had a peak — honest, not "peaked at t=0"). */
export interface StationBacklog {
  readonly id: StationId;
  readonly maxPerWindow: readonly number[];
  readonly peak: number;
  readonly peakAtS: number;
}

/** The windowed observation of a transient run (rides on `SimResult.transient` when the mode is on). */
export interface TransientMetrics {
  readonly horizonS: number;
  readonly windowS: number;
  /** The instant the run actually observed up to: `horizonS` normally; earlier only when `truncated`. */
  readonly endS: number;
  readonly windows: readonly TransientWindow[];
  readonly backlog: readonly StationBacklog[];
  /** Events actually processed. */
  readonly eventsProcessed: number;
  /** The up-front estimate ({@link estimateTransientEvents}) — print it beside the cap (budget honesty). */
  readonly estimatedEvents: number;
  /** The hard cap this run enforced. */
  readonly eventCap: number;
  /** True when the event budget ran out before `horizonS` — the windows cover only [0, endS], a PARTIAL
   *  observation the caller must say out loud (never silently scale or extrapolate). */
  readonly truncated: boolean;
}

/**
 * Up-front event-count ESTIMATE for a transient run — the number the caller prints beside the hard cap (budget
 * honesty). Expected external arrivals per source = horizonS / mean interarrival (a rate profile is normalized at
 * read, so the declared rate stays the period MEAN and the count is exact in expectation); each request costs
 * 1 external-arrival event plus 1 departure event per station VISIT (entering a station is a function call, not
 * an event). Visits per request are propagated over the routing edges (each contributes prob × multiplicity) by
 * bounded relaxation — cycles saturate at the sweep cap instead of diverging. An ESTIMATE, not a bound: retry
 * policies add abandon/re-inject events by an amount only the run itself can discover (which is exactly why the
 * run also enforces a hard cap).
 */
export function estimateTransientEvents(network: QueueingNetwork, horizonS: number): number {
  let total = 0;
  for (const src of network.arrivals) {
    const m = distributionMean(src.interarrival);
    if (!(m > 0) || !Number.isFinite(m)) continue;
    const arrivals = horizonS / m;
    total += arrivals * (1 + visitsPerRequest(network, src.at));
  }
  return Math.ceil(total);
}

/** Expected station visits per request injected at `entry`: v[s] = inject[s] + Σ_from v[from]·prob·multiplicity,
 *  relaxed a bounded number of sweeps (a cycle with gain ≥ 1 saturates the clamp — a finite estimate, honestly
 *  rough, never a hang). */
function visitsPerRequest(network: QueueingNetwork, entry: StationId): number {
  const CLAMP = 1e9;
  const SWEEPS = 32;
  const ids = network.stations.map((s) => String(s.id));
  const inject = new Map<string, number>(ids.map((id) => [id, 0]));
  if (!inject.has(String(entry))) return 0; // entry is not a station in this network — nothing to visit
  inject.set(String(entry), 1);
  let v = new Map(inject);
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const next = new Map(inject);
    for (const [from, edges] of network.routing) {
      const inflow = v.get(String(from)) ?? 0;
      if (inflow === 0) continue;
      for (const e of edges) {
        const add = inflow * e.prob * (e.multiplicity ?? 1);
        if (!(add > 0)) continue;
        const cur = next.get(String(e.to));
        if (cur === undefined) continue; // routes into a non-station are dropped by the DES too
        next.set(String(e.to), Math.min(cur + add, CLAMP));
      }
    }
    let delta = 0;
    for (const [id, x] of next) delta = Math.max(delta, Math.abs(x - (v.get(id) ?? 0)));
    v = next;
    if (delta < 1e-6) break;
  }
  let sum = 0;
  for (const x of v.values()) sum += x;
  return sum;
}

/** The recovery test for {@link drainTimeS}: when the disturbance ended, what counts as "back to baseline". */
export interface DrainSpec {
  /** The instant the injected disturbance fully ended (recovery is measured FROM here). */
  readonly spikeEndS: number;
  /** The undisturbed reference phase: windows entirely inside [0, baselineEndS) supply the baseline backlog and
   *  p99 (the baseline's own stochastic fluctuation becomes the tolerance — an M/M/1 at ρ=0.5 queues a little
   *  even at rest, and "recovered" must not demand better-than-baseline). */
  readonly baselineEndS: number;
  /** Recovered p99 must be ≤ baseline p99 × this factor (+ `p99SlackS`). */
  readonly p99Tolerance: number;
  /** Small absolute p99 slack in seconds (default 0) — keeps a millisecond-scale baseline from failing on noise. */
  readonly p99SlackS?: number;
}

/**
 * DRAIN TIME: seconds from `spikeEndS` until the system is back to its pre-disturbance baseline — the END of the
 * FIRST window at/after `spikeEndS` whose every station backlog is within the baseline's own maximum AND whose
 * completed-request p99 is within tolerance of the baseline p99. Conservative by construction (the whole window
 * must qualify, and the returned figure is that window's END minus `spikeEndS` — recovery happened within that
 * long). `null` = never within the observed windows (still growing, still draining, or the run was truncated) —
 * the caller words WHY (see {@link backlogGrowingAtEnd}), never this function.
 */
export function drainTimeS(t: TransientMetrics, spec: DrainSpec): number | null {
  const eps = 1e-9;
  const slack = spec.p99SlackS ?? 0;
  const baseIdx: number[] = [];
  t.windows.forEach((w, i) => {
    if (w.endS <= spec.baselineEndS + eps) baseIdx.push(i);
  });
  let refP99 = NaN;
  for (const i of baseIdx) {
    const w = t.windows[i] as TransientWindow;
    if (w.samples > 0 && (Number.isNaN(refP99) || w.p99S > refP99)) refP99 = w.p99S;
  }
  const refBacklog = t.backlog.map((b) => baseIdx.reduce((mx, i) => Math.max(mx, b.maxPerWindow[i] ?? 0), 0));
  for (let i = 0; i < t.windows.length; i++) {
    const w = t.windows[i] as TransientWindow;
    if (w.startS < spec.spikeEndS - eps) continue;
    const backlogOk = t.backlog.every((b, s) => (b.maxPerWindow[i] ?? 0) <= (refBacklog[s] as number));
    // No baseline p99 (nothing completed at rest — a degenerate probe) ⇒ judge on backlog alone; otherwise the
    // window must have completions AND a tail within tolerance (an empty window during recovery is NOT evidence).
    const p99Ok = Number.isNaN(refP99) ? true : w.samples > 0 && w.p99S <= refP99 * spec.p99Tolerance + slack;
    if (backlogOk && p99Ok) return w.endS - spec.spikeEndS;
  }
  return null;
}

/** Is the TOTAL backlog still NOT draining at the end of the observed windows — i.e. the last window's summed
 *  station backlog is nonzero and no lower than the one before it? The signature of a retry death-spiral (or a
 *  simply-overwhelmed tier): the disturbance ended but the queues are not coming down. The caller words the
 *  verdict; this is just the arithmetic. */
export function backlogGrowingAtEnd(t: TransientMetrics): boolean {
  const n = t.windows.length;
  if (n < 2) return false;
  const total = (i: number): number => t.backlog.reduce((s, b) => s + (b.maxPerWindow[i] ?? 0), 0);
  const last = total(n - 1);
  return last > 0 && last >= total(n - 2);
}
