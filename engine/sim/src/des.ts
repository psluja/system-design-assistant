// @algorithm Discrete-event queueing-network simulation (event list + reservoir percentiles)
// @problem Produce true time-domain behavior — utilization, drops, retries, response/lag tails — of a
//   queueing network that closed forms cannot cover (fan-out, async hops, deadlines, cold starts),
//   deterministically under a seed and in bounded memory at any arrival rate.
// @approach Classic next-event-time-advance DES: a binary min-heap future-event set drives arrivals,
//   service starts and completions across stations; sojourn/response/lag percentiles are estimated
//   from fixed-size uniform reservoirs (Vitter's Algorithm R once a cap is hit), means stay exact over
//   all observations; warm-up completions are discarded for steady-state runs.
// @complexity O(events * log events) time for the event loop; memory bounded by stations + in-flight
//   jobs + fixed reservoir caps (percentile memory does not grow with run length).
// @citations Law & Kelton, "Simulation Modeling and Analysis" (next-event time advance); Vitter,
//   "Random Sampling with a Reservoir", ACM TOMS 11(1), 1985 (Algorithm R).
// @invariants Fixed seed => byte-identical results (single mulberry32 stream, total event order via
//   sequence tie-break); no-data metrics answer NaN, never 0; validated differentially against the
//   closed forms (M/M/1, M/M/c, Little, P-K) within confidence tolerances.
// @where-tested engine/sim/src/des.test.ts, engine/sim/src/response.test.ts,
//   engine/sim/src/lag.test.ts, engine/sim/src/drops.test.ts, engine/sim/src/retry.test.ts,
//   engine/sim/src/coldstart.test.ts, engine/sim/src/transient.test.ts

import { sample, type Distribution } from './distribution';
import { MinHeap } from './heap';
import type { ArrivalSource, AttemptPolicy, QueueingNetwork, Station, StationId } from './network';
import { nextArrivalDelay } from './profile';
import { mulberry32 } from './rng';
import { mean, percentileSorted } from './stats';
import {
  estimateTransientEvents,
  TRANSIENT_EVENT_CAP,
  TRANSIENT_WINDOW_RESERVOIR_CAP,
  type StationBacklog,
  type TransientMetrics,
  type TransientOptions,
  type TransientWindow,
} from './transient';

export interface SimOptions {
  readonly seed: number;
  /** Completions discarded before measuring, so startup transients decay and stats are steady-state. */
  readonly warmupCompletions: number;
  /** Completions to measure after warm-up; the run stops once this many jobs have left the system. */
  readonly measureCompletions: number;
  /**
   * FLOW-SCOPED LAG pairs to measure (doc: latency-semantics-v2 §3). Each is a (source, terminal) station pair
   * whose LAG — the wall-clock from a job's arrival at `source` to that SAME lineage's arrival at `terminal`,
   * INCLUDING every async queue wait on the way (unlike the response cut) — is sampled from this one run. Bounded
   * by construction: only DECLARED pairs are tracked (a per-pair reservoir), so an undeclared design pays nothing.
   * Absent/empty ⇒ no lag machinery runs and every existing metric is bit-for-bit identical. Domain-free (pure
   * station ids + timing); the CDC/replication meaning ("a change reaches the destination within X") is content.
   */
  readonly lagPairs?: readonly { readonly source: StationId; readonly terminal: StationId }[];
  /**
   * OPT-IN TRANSIENT MODE (transient.ts): the run becomes TIME-bounded — it measures from t = 0 (no warm-up
   * discard: the pre-disturbance phase IS the baseline reference) and stops at `horizonS` or at the hard event
   * cap (honestly flagged as `truncated`). `warmupCompletions`/`measureCompletions` are then IGNORED. The result
   * carries {@link SimResult.transient} — windowed percentiles, per-station backlog series, budget accounting.
   * Absent ⇒ the classic steady-state run, byte-for-byte (every transient touchpoint is gated; the extra RNG
   * stream is disjoint), so the sacred flat-profile identity and every existing metric are untouched.
   */
  readonly transient?: TransientOptions;
}

export interface StationStats {
  readonly id: StationId;
  readonly utilization: number; // ρ = ∫ busy dt / (servers · T)
  readonly meanNumberInSystem: number; // time-average jobs at the station (queue + in service)
  readonly arrivals: number;
  readonly completions: number;
  readonly dropped: number; // jobs LOST here in the measurement window: a full-buffer loss OR a station wait-deadline renege (maxQueueWaitMs)
}

/**
 * One node's RESPONSE from its OWN perspective (doc: latency-semantics-v2 §4): the time from a job's ARRIVAL at
 * the station to the completion of that station's SYNCHRONOUS downstream subtree (an async hop cuts it). Every
 * station reports this from the SAME single run — a node's response is nothing but a SUFFIX of the very journeys
 * the run already produces, so one simulation yields all N perspectives at once (no per-node model, no re-run).
 * The entry node's response is exactly the end-to-end sojourn (its sync subtree is the whole request). Percentiles
 * come from a bounded per-node reservoir (a uniform sample); the mean is exact over every recorded response.
 */
export interface NodeResponse {
  readonly id: StationId;
  readonly mean: number; // exact mean over ALL recorded responses (NaN when none — honest: no data ⇒ no mean)
  readonly p50: number; // median response, from the reservoir (NaN when none)
  readonly p95: number;
  readonly p99: number; // the tail a caller of this node actually feels
  readonly samples: number; // reservoir occupancy backing the percentiles (≤ the cap; equals the total when under it)
}

/**
 * One DECLARED flow's LAG distribution (doc: latency-semantics-v2 §3): the wall-clock from a lineage's arrival at
 * `source` to its arrival at `terminal`, measured over every job of that lineage that actually reached the
 * terminal in the same run. Unlike {@link NodeResponse}, lag INCLUDES async queue waits along the path (the whole
 * point of a CDC/replication SLO is the time a change spends queued). Mean is exact over all recorded lags; the
 * percentiles come from a bounded per-pair reservoir (a uniform sample). NaN/0 samples ⇒ the terminal was never
 * reached from the source in this run — honest `unknown`, never a fabricated number.
 */
export interface PairLag {
  readonly source: StationId;
  readonly terminal: StationId;
  readonly mean: number; // seconds; exact over ALL recorded lags (NaN when none)
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly samples: number; // reservoir occupancy backing the percentiles
}

export interface SimResult {
  readonly measuredTime: number; // T — the measurement window length
  readonly completions: number; // system exits measured
  readonly departureRate: number; // λ_eff = completions / T
  readonly meanNumberInSystem: number; // L (whole network), time-average
  readonly meanSojourn: number; // W — mean end-to-end time in system
  /** Sojourn percentile, p ∈ [0,1] (nearest-rank) — the true tail (doc-4 §3b). */
  sojournPercentile(p: number): number;
  readonly stations: readonly StationStats[];
  // Retry-feedback outcome accounting (doc: retry-feedback §3). Measured over the same window as everything
  // else. With NO attempt policy anywhere these degenerate to the pre-retry world: goodputRps === departureRate,
  // errorRate === 0, amplification === 1 — so an existing (policy-free) network reads exactly as before.
  readonly goodputRps: number; // SUCCESSFUL request completions / s (retries excluded; the useful work)
  readonly errorRate: number; // request FAILURES / s (retries exhausted, or a full-buffer drop with no retry left)
  readonly amplification: number; // total attempts ÷ original request arrivals (≥ 1; 1 ⇒ no retry traffic)
  /** Every station's response perspective (doc: latency-semantics-v2 §4), from this one run. Empty ⇒ no run yet. */
  readonly nodeResponse: readonly NodeResponse[];
  /**
   * A single station's response percentile, p ∈ [0,1] (nearest-rank) — the DES twin of the scalar response
   * quantity, from the node's own reservoir. NaN when the node is unknown or has no recorded response (⇒ honest
   * `unknown` upstream). At the entry node of a fully-synchronous design this equals {@link sojournPercentile}.
   */
  responsePercentile(node: StationId, p: number): number;
  /** Every DECLARED lag pair's distribution (doc: latency-semantics-v2 §3), from this one run. Empty when
   *  `opts.lagPairs` declared none — the lag machinery is opt-in and adds nothing to an undeclared run. */
  readonly pairLag: readonly PairLag[];
  /**
   * A declared lag pair's percentile, p ∈ [0,1] (nearest-rank), in seconds — the async-INCLUSIVE journey time
   * from `source` to `terminal`. NaN when the pair was not declared or the terminal was never reached from the
   * source in this run (⇒ honest `unknown` upstream, never a guess).
   */
  lagPercentile(source: StationId, terminal: StationId, p: number): number;
  /** The windowed transient observation — present exactly when {@link SimOptions.transient} was set. */
  readonly transient?: TransientMetrics;
}

/** A REQUEST entering the network. It may FORK at a fan-out node (a producer feeding several downstreams, each
 *  receiving the FULL rate — matching the flow model). The request LEAVES the system when its LAST outstanding
 *  fork exits; its end-to-end sojourn is that last exit — the slowest path (a fork-JOIN).
 *
 *  Retry state (doc: retry-feedback) rides on the REQUEST, the caller's unit of work: `policy` is the caller's
 *  per-attempt deadline/backoff/retry-count, `entry` is the station this attempt is (re)injected at, `attempt`
 *  counts attempts made (1 = first try), `deadline` is the ABSOLUTE time this attempt runs out of patience, and
 *  `gen` is a monotone generation stamping the CURRENT attempt. When an attempt ends (success, failure, or is
 *  abandoned) we bump `gen`; any of its forks still in flight (e.g. one in service) then carries a STALE stamp,
 *  so its later completion frees its server but is neither counted nor routed onward — the O(log n)
 *  lazy-cancellation, no queue splicing. */
interface Req {
  readonly systemEntry: number;
  outstanding: number;
  readonly policy: AttemptPolicy | undefined;
  readonly patience: Distribution | undefined; // per-attempt patience clock; defaults to deterministic(timeoutMs)
  readonly entry: StationId;
  attempt: number;
  deadline: number; // absolute time the CURRENT attempt renegess if still waiting; +∞ ⇒ no reneging
  gen: number;
}
interface Job {
  readonly id: number;
  readonly req: Req;
  /** The attempt generation this fork belongs to. A fork whose stamp ≠ its request's current `gen` is STALE
   *  (its attempt already ended) — recognised lazily wherever it surfaces (dequeue or completion). */
  readonly gen: number;
  /** The station whose FIFO this fork currently WAITS in, or undefined once it starts service / leaves. Reneging
   *  (the Erlang-A abandonment) bites only during the WAIT — a job that has reached a server is served to
   *  completion (the standard M/M/c+M model, the theory this primitive is differential-tested against). Set when
   *  the fork joins a queue; cleared on dequeue; the abandon handler uses it to free the exact station's slot. */
  waitingAt: StationState | undefined;
  /** This fork's RESPONSE suffix frame for the station it currently occupies — opened on entry, closed when the
   *  station's synchronous subtree completes (doc: latency-semantics-v2 §4). Overwritten each time the fork
   *  enters a new station; undefined only before its first entry. */
  frame?: Suffix;
  /** FLOW-SCOPED LAG stamps (doc: latency-semantics-v2 §3): source station id → the time THIS lineage arrived at
   *  that source. Set when the fork enters a declared lag SOURCE; read when it enters a declared lag TERMINAL to
   *  record `now − stamp`. Forks INHERIT the parent's map by reference (the same lineage), and a re-stamp is
   *  copy-on-write, so a sibling passing the source again never disturbs another fork's stamp. Undefined until the
   *  lineage first crosses a lag source — and always undefined when no lag pair is declared (the map is never made). */
  lagStamps?: ReadonlyMap<string, number>;
}

/**
 * One node-visit's RESPONSE suffix (doc: latency-semantics-v2 §4): the clock from a job's ARRIVAL at a station to
 * the completion of that station's SYNCHRONOUS subtree. `pending` counts outstanding synchronous work — it starts
 * at 1 (the node's own service) and, when the node completes, becomes the number of SYNC child subtrees still
 * running (an async handoff contributes none, so the caller does not block on it). Each child frame decrements its
 * `parent` when it settles; when `pending` reaches 0 the frame SETTLES: `now − enter` is a completed response
 * sample for `station`, and the settlement cascades one step up its `parent` chain (all at the same instant). A
 * frame whose subtree never completes cleanly (a dropped/reneged fork) simply never settles and is garbage —
 * honest: a failed request yields no response sample. `parent` is undefined for a request root OR the far side of
 * an async cut (a fresh perspective, awaited by no synchronous caller). */
interface Suffix {
  readonly station: StationState;
  readonly enter: number;
  readonly parent: Suffix | undefined;
  pending: number;
}

type SimEvent =
  | { readonly kind: 'externalArrival'; readonly time: number; readonly at: StationId; readonly seq: number }
  | { readonly kind: 'departure'; readonly time: number; readonly at: StationId; readonly job: Job; readonly seq: number }
  // Abandonment (reneging): a job's attempt deadline has arrived. Fires against a specific JOB and the attempt
  // generation it was armed for — a no-op unless that exact fork is STILL WAITING in a queue (see `waiting`).
  | { readonly kind: 'abandon'; readonly time: number; readonly job: Job; readonly seq: number }
  // Station wait-deadline abandonment (doc: retry-feedback §3): a job has waited at THIS station past its
  // `maxQueueWaitMs`. Same teardown as `abandon`, but it is a failure ATTRIBUTED TO THE STATION (its `dropped`
  // count), armed on queue-join here regardless of any caller policy. Composes with the caller deadline: whichever
  // event surfaces first while the fork is still waiting wins; the later one finds a stale fork and is a no-op.
  | { readonly kind: 'abandonAtStation'; readonly time: number; readonly job: Job; readonly at: StationId; readonly seq: number }
  // Re-injection: an abandoned request re-enters its ENTRY station after the backoff, as a fresh attempt.
  | { readonly kind: 'reinject'; readonly time: number; readonly req: Req; readonly gen: number; readonly seq: number };

interface StationState {
  readonly def: Station;
  readonly capacity: number;
  /** Station-level wait deadline in SECONDS (network time units), or +∞ when the station declares none. A job
   *  waiting here longer than this abandons (a station-side failure) — the connection-pool borrow timeout etc. */
  readonly maxWait: number;
  readonly queue: Job[];
  busy: number;
  n: number;
  arrivals: number;
  completions: number;
  dropped: number;
  area: number;
  areaBusy: number;
  // Per-node RESPONSE sampling (doc: latency-semantics-v2 §4). `respReservoir` is a BOUNDED uniform sample of this
  // station's response times (for percentiles); `respSeen` is the true count of responses recorded (drives the
  // reservoir's replacement probability); `respSum` accumulates them for an EXACT mean over every observation.
  readonly respReservoir: number[];
  respSeen: number;
  respSum: number;
}

/**
 * Run a queueing network as a discrete-event simulation and report steady-state metrics. Pure and
 * deterministic: all randomness comes from the seeded RNG and the event set is totally ordered
 * (time, then sequence), so a seed fixes the output byte-for-byte (doc-4 §3c). It answers the
 * time-domain questions the algebraic engine cannot: true tails, transients, non-monotone feedback
 * (retry storms — doc: retry-feedback).
 */
/**
 * Cap on each station's response reservoir — a few thousand samples per node keeps memory trivial for any
 * drawable design (bytes ≈ cap × node-count) while giving the tail (p99 ⇒ top ~1%) enough resolution. Bounded by
 * construction: a run of any length never grows a reservoir past this (Vitter's Algorithm R below).
 */
export const RESPONSE_RESERVOIR_CAP = 8192;

export function simulate(network: QueueingNetwork, opts: SimOptions): SimResult {
  const rng = mulberry32(opts.seed);
  // A DEDICATED reservoir RNG, seeded off the sim seed so sampling is still deterministic (a fixed seed ⇒
  // identical reservoirs ⇒ identical percentiles), yet DISJOINT from the main stream: response sampling draws
  // here, never from `rng`, so it cannot perturb the event order — the end-to-end sojourn and every existing
  // metric stay byte-identical to a run without the sampler.
  const resRng = mulberry32((opts.seed ^ 0x9e3779b9) >>> 0);
  // A THIRD disjoint stream for FLOW-SCOPED LAG reservoir sampling (doc: latency-semantics-v2 §3), seeded off the
  // sim seed with a DIFFERENT constant than `resRng` so lag sampling is deterministic yet perturbs neither the
  // event order NOR the response reservoirs — declaring a lag pair leaves every other metric bit-for-bit identical.
  const lagRng = mulberry32((opts.seed ^ 0x85ebca6b) >>> 0);

  // FLOW-SCOPED LAG bookkeeping (doc: latency-semantics-v2 §3). Precompute, from the DECLARED pairs only, the set
  // of SOURCE stations to stamp at and, per TERMINAL station, which pairs record there — so the hot enter-path does
  // O(1) lookups and an undeclared design allocates nothing (the whole feature is opt-in). `lagOn` gates every
  // touchpoint below; with it false the run is exactly the pre-lag simulator.
  const lagPairs = opts.lagPairs ?? [];
  const lagOn = lagPairs.length > 0;
  const lagKey = (source: string, terminal: string): string => `${source} ${terminal}`;
  const lagSources = new Set<string>();
  const lagTerminals = new Map<string, { source: string; key: string }[]>(); // terminal id → pairs recording there
  interface LagAgg { readonly source: StationId; readonly terminal: StationId; readonly reservoir: number[]; seen: number; sum: number }
  const lagAgg = new Map<string, LagAgg>(); // pair key → its bounded reservoir + exact mean accumulators
  for (const p of lagPairs) {
    const s = String(p.source);
    const t = String(p.terminal);
    const key = lagKey(s, t);
    if (lagAgg.has(key)) continue; // a pair declared twice is ONE reservoir (idempotent)
    lagSources.add(s);
    const list = lagTerminals.get(t) ?? [];
    list.push({ source: s, key });
    lagTerminals.set(t, list);
    lagAgg.set(key, { source: p.source, terminal: p.terminal, reservoir: [], seen: 0, sum: 0 });
  }
  // Record one completed lag into its pair reservoir (only in the measurement window, exactly like the sojourn and
  // the response reservoirs). Vitter's Algorithm R over `lagRng` keeps the sample uniform past the cap — an unbiased
  // tail — with memory bounded to the cap regardless of run length.
  const recordLag = (key: string, value: number): void => {
    if (!measuring) return;
    const agg = lagAgg.get(key);
    if (agg === undefined) return;
    agg.seen += 1;
    agg.sum += value;
    const res = agg.reservoir;
    if (res.length < RESPONSE_RESERVOIR_CAP) {
      res.push(value);
    } else {
      const j = Math.floor(lagRng.next() * agg.seen);
      if (j < RESPONSE_RESERVOIR_CAP) res[j] = value;
    }
  };

  const states = new Map<StationId, StationState>();
  for (const st of network.stations) {
    states.set(st.id, {
      def: st,
      capacity: st.capacity ?? Number.POSITIVE_INFINITY,
      // ms → s; absent or non-positive ⇒ no station deadline (jobs wait indefinitely for a server, as before).
      maxWait: st.maxQueueWaitMs !== undefined && st.maxQueueWaitMs > 0 ? st.maxQueueWaitMs / 1000 : Number.POSITIVE_INFINITY,
      queue: [],
      busy: 0,
      n: 0,
      arrivals: 0,
      completions: 0,
      dropped: 0,
      area: 0,
      areaBusy: 0,
      respReservoir: [],
      respSeen: 0,
      respSum: 0,
    });
  }
  const sourceOf = new Map<StationId, ArrivalSource>();
  for (const src of network.arrivals) sourceOf.set(src.at, src);

  let seq = 0;
  const events = new MinHeap<SimEvent>((a, b) => a.time < b.time || (a.time === b.time && a.seq < b.seq));

  // TRANSIENT MODE (transient.ts): `tr` gates every touchpoint below — absent, the run is byte-for-byte the
  // classic steady-state simulation (no extra draws on any stream, no extra allocation on the hot path).
  const tr = opts.transient;
  let now = 0;
  let lastTime = 0;
  let inSystem = 0;
  let networkArea = 0;
  // Transient runs measure from t = 0: the pre-disturbance phase is the baseline the windows are judged against,
  // so there is nothing to discard (the classic warm-up flag flips at `warmupCompletions` exits as before).
  let measuring = tr !== undefined;
  let measureStart = 0;
  let exits = 0; // completed OR failed requests (warm-up + measured); the stop clock counts terminal outcomes
  let measuredExits = 0;
  let nextJobId = 0;
  const sojourns: number[] = [];
  // Retry-feedback counters, tallied ONLY inside the measurement window (steady-state, like every other metric).
  let originalArrivals = 0; // distinct requests that entered (first attempts only)
  let attemptsMade = 0; // total attempts across all requests (first + retries) — the numerator of amplification
  let goodput = 0; // requests that SUCCEEDED (completed before their attempt's deadline)
  let failures = 0; // requests that FAILED (retries exhausted, or dropped with no retry left)

  // ── TRANSIENT (windowed) bookkeeping — every structure here exists only when `tr` is set ─────────────────────
  // A FOURTH disjoint RNG stream for the per-window sojourn reservoirs, seeded off the sim seed with its own
  // constant: window sampling is deterministic yet perturbs neither the event order nor the response/lag
  // reservoirs. Only ever drawn in transient mode.
  const trWinRng = mulberry32((opts.seed ^ 0xc2b2ae35) >>> 0);
  const trCap = tr?.maxEvents ?? TRANSIENT_EVENT_CAP;
  const trWindowCount = tr !== undefined ? Math.max(1, Math.ceil(tr.horizonS / tr.windowS)) : 0;
  interface TrWin { arrivals: number; attempts: number; served: number; failed: number; reservoir: number[]; seen: number }
  const trWins: TrWin[] = [];
  const trBacklog = new Map<StationId, number[]>(); // station → per-window MAX backlog (jobs waiting, in-service excluded)
  const trPeak = new Map<StationId, { value: number; atS: number }>();
  if (tr !== undefined) {
    for (let i = 0; i < trWindowCount; i++) trWins.push({ arrivals: 0, attempts: 0, served: 0, failed: 0, reservoir: [], seen: 0 });
    for (const st of network.stations) {
      trBacklog.set(st.id, new Array<number>(trWindowCount).fill(0));
      trPeak.set(st.id, { value: 0, atS: NaN }); // never queued ⇒ peak 0 at NaN (honest: it never had a peak)
    }
  }
  let trCur = 0; // current window index
  let trEvents = 0; // events processed under the transient budget
  let trTruncated = false;
  const trWaiting = (s: StationState): number => s.n - s.busy; // reneged waiters already left `n` — live waiters only
  // Advance the window cursor to the window containing `t`, CARRYING each station's standing backlog into every
  // window crossed: a queue that drains without a single new join still shows (its max in that window is the level
  // it started at). Rolls are rare (once per window), so the per-station sweep is off the hot path.
  const trRoll = (t: number): void => {
    if (tr === undefined) return;
    const idx = Math.min(Math.floor(t / tr.windowS), trWindowCount - 1);
    while (trCur < idx) {
      trCur += 1;
      for (const s of states.values()) {
        const series = trBacklog.get(s.def.id) as number[];
        const w = trWaiting(s);
        if (w > (series[trCur] as number)) series[trCur] = w;
      }
    }
  };
  // A job just JOINED a station's FIFO — the only instant backlog can set a new maximum (it only shrinks between
  // joins, and window rolls carry the standing level), so this single touchpoint captures the exact series.
  const trNoteQueueJoin = (s: StationState): void => {
    const series = trBacklog.get(s.def.id) as number[];
    const w = trWaiting(s);
    if (w > (series[trCur] as number)) series[trCur] = w;
    const pk = trPeak.get(s.def.id) as { value: number; atS: number };
    if (w > pk.value) {
      pk.value = w;
      pk.atS = now;
    }
  };
  // One completed sojourn into the CURRENT window's bounded reservoir (Vitter's Algorithm R over the disjoint
  // window stream — a uniform sample per window, memory capped at windows × cap).
  const trRecordSojourn = (value: number): void => {
    const win = trWins[trCur] as TrWin;
    win.seen += 1;
    if (win.reservoir.length < TRANSIENT_WINDOW_RESERVOIR_CAP) {
      win.reservoir.push(value);
    } else {
      const j = Math.floor(trWinRng.next() * win.seen);
      if (j < TRANSIENT_WINDOW_RESERVOIR_CAP) win.reservoir[j] = value;
    }
  };

  // Integrate the time-average accumulators up to time `t` (only inside the measurement window).
  const integrate = (t: number): void => {
    if (measuring) {
      const dt = t - lastTime;
      if (dt > 0) {
        networkArea += inSystem * dt;
        for (const s of states.values()) {
          s.area += s.n * dt;
          s.areaBusy += s.busy * dt;
        }
      }
    }
    lastTime = t;
  };

  // A RESPONSE suffix has completed: record `now − enter` into its station's reservoir (only inside the
  // measurement window, exactly like the end-to-end sojourn), then cascade one step up its parent chain — a child
  // finishing may be the last synchronous work its caller awaited. Iterative (not recursive) so a deep synchronous
  // chain cannot overflow the stack. Uses `resRng` (the disjoint stream) so the main event order is untouched.
  const settle = (start: Suffix): void => {
    let f: Suffix | undefined = start;
    while (f !== undefined) {
      const frame: Suffix = f;
      if (measuring) {
        const r = now - frame.enter;
        const st = frame.station;
        st.respSeen += 1;
        st.respSum += r;
        const res = st.respReservoir;
        if (res.length < RESPONSE_RESERVOIR_CAP) {
          res.push(r); // still filling ⇒ keep every sample (exact until the cap)
        } else {
          // Vitter's Algorithm R: past the cap, replace a uniformly-chosen slot with probability cap/seen, which
          // keeps the reservoir a UNIFORM sample of the whole (unbounded) response stream — an unbiased tail.
          const j = Math.floor(resRng.next() * st.respSeen);
          if (j < RESPONSE_RESERVOIR_CAP) res[j] = r;
        }
      }
      const up: Suffix | undefined = frame.parent;
      if (up === undefined || --up.pending !== 0) break; // root, or the caller still awaits other sync work
      f = up; // the caller's synchronous subtree just completed too — settle it at this same instant
    }
  };

  const startService = (s: StationState, job: Job): void => {
    job.waitingAt = undefined; // reached a server ⇒ it will be served (no longer eligible to renege)
    s.busy += 1;
    events.push({ kind: 'departure', time: now + sample(s.def.service, rng), at: s.def.id, job, seq: seq++ });
  };

  // A job enters a station: drop on a full buffer (loss), serve immediately if a server is free, else JOIN the
  // FIFO and WAIT. A waiting job is armed to renege at its attempt deadline (the classic queue-wait abandonment).
  // `syncParent` is the frame of the caller that synchronously AWAITS this visit's subtree (undefined ⇒ a request
  // root, or the far side of an async cut — a fresh response perspective).
  const enter = (s: StationState, job: Job, syncParent: Suffix | undefined): void => {
    s.arrivals += 1;
    if (s.n >= s.capacity) {
      if (measuring) s.dropped += 1;
      lose(job); // this fork is lost (full buffer) — may end/abandon/fail the whole request
      return;
    }
    s.n += 1;
    // Open this visit's RESPONSE suffix (doc: latency-semantics-v2 §4): the clock starts now, at arrival here.
    // pending = 1 (its own service is the only outstanding work until it completes and forks onward).
    job.frame = { station: s, enter: now, parent: syncParent, pending: 1 };
    // FLOW-SCOPED LAG (doc: latency-semantics-v2 §3): this job ARRIVED here (admitted — a dropped fork returned
    // above, so it never records: honest). First RECORD a completed lag for every declared pair whose SOURCE this
    // lineage already crossed (`now − stamp`, async queue waits and all); then STAMP this station if it is itself a
    // declared source. Recording only counts in the measurement window (`recordLag` guards); stamping always
    // happens so a job that crossed the source during warm-up still measures once it reaches the terminal.
    if (lagOn) {
      const stamps = job.lagStamps;
      if (stamps !== undefined) {
        const recs = lagTerminals.get(String(s.def.id));
        if (recs !== undefined) {
          for (const r of recs) {
            const t0 = stamps.get(r.source);
            if (t0 !== undefined) recordLag(r.key, now - t0);
          }
        }
      }
      if (lagSources.has(String(s.def.id))) {
        const m = new Map(job.lagStamps); // copy-on-write: re-stamping never disturbs a sibling fork's inherited map
        m.set(String(s.def.id), now);
        job.lagStamps = m;
      }
    }
    if (s.busy < s.def.servers) {
      startService(s, job);
    } else {
      job.waitingAt = s;
      s.queue.push(job);
      if (tr !== undefined) trNoteQueueJoin(s); // the ONE instant backlog can set a new max (see trNoteQueueJoin)
      if (job.req.deadline < Number.POSITIVE_INFINITY) {
        // Arm CALLER reneging for THIS wait (the whole-attempt deadline). Bites only if still waiting at
        // `deadline`; dequeue clears `waitingAt`.
        events.push({ kind: 'abandon', time: job.req.deadline, job, seq: seq++ });
      }
      if (s.maxWait < Number.POSITIVE_INFINITY) {
        // Arm STATION reneging: this job abandons if it is still waiting HERE `maxWait` after joining (the
        // borrow-timeout / admission deadline). Independent of the caller deadline — they compose, first-fires-wins.
        events.push({ kind: 'abandonAtStation', time: now + s.maxWait, job, at: s.def.id, seq: seq++ });
      }
    }
  };

  // Onward FAN-OUT: each edge fires INDEPENDENTLY with its probability, so prob=1 edges are a deterministic
  // fan-out — a producer feeding several downstreams, each receiving the FULL rate (matching the flow model).
  // When an edge fires it delivers `multiplicity` jobs (default 1) — the per-edge traffic TRANSFER: a whole
  // number floor(m) always, plus one more with probability equal to the fractional part, so the mean is exactly
  // m (ratio(k) ⇒ k jobs; a thinning factor f ≤ 1 ⇒ a per-completion Bernoulli(f)). A destination therefore
  // appears in the returned list as many times as jobs go to it. A job that fires no edge leaves the system.
  const spawnCount = (m: number): number => {
    if (!(m > 0)) return 0;
    const whole = Math.floor(m);
    return whole + (rng.next() < m - whole ? 1 : 0);
  };
  const routeAll = (from: StationId): { to: StationId; async: boolean }[] => {
    const edges = network.routing.get(from);
    if (edges === undefined || edges.length === 0) return [];
    const out: { to: StationId; async: boolean }[] = [];
    for (const e of edges) {
      if (!states.has(e.to) || rng.next() >= e.prob) continue;
      const jobs = spawnCount(e.multiplicity ?? 1);
      const async = e.async ?? false; // a fire-and-forget hop cuts the caller's synchronous subtree (response sampling only)
      for (let i = 0; i < jobs; i++) out.push({ to: e.to, async });
    }
    return out;
  };

  // Count a request's terminal outcome exactly once (in the window), and advance the stop clock. A terminal
  // outcome is a SUCCESS (goodput) or a FAILURE (retries exhausted / dropped with none left). Bump the
  // generation so any of the ended attempt's other forks (or its pending abandon timer) go stale on sight.
  const terminate = (req: Req, success: boolean, sojournEnd: number): void => {
    req.gen += 1;
    exits += 1;
    if (measuring) {
      measuredExits += 1;
      if (success) {
        goodput += 1;
        sojourns.push(sojournEnd - req.systemEntry);
        if (tr !== undefined) {
          (trWins[trCur] as { served: number }).served += 1;
          trRecordSojourn(sojournEnd - req.systemEntry);
        }
      } else {
        failures += 1;
        if (tr !== undefined) (trWins[trCur] as { failed: number }).failed += 1;
      }
    } else if (exits === opts.warmupCompletions) {
      measuring = true;
      measureStart = now;
      lastTime = now;
    }
  };

  // Begin one attempt for `req`: it is (re)injected at its entry station. Records the attempt, sets the whole
  // attempt's patience DEADLINE (an absolute time — a single caller timeout spanning every hop of this attempt),
  // and lets a fresh fork enter. `outstanding` is exactly 1 at the start of an attempt (a single job; forks
  // appear only downstream via routing).
  const beginAttempt = (req: Req): void => {
    if (measuring) attemptsMade += 1;
    if (tr !== undefined) (trWins[trCur] as { attempts: number }).attempts += 1;
    inSystem += 1;
    req.outstanding = 1;
    req.deadline =
      req.patience !== undefined ? now + Math.max(0, sample(req.patience, rng)) : Number.POSITIVE_INFINITY;
    enter(states.get(req.entry) as StationState, { id: nextJobId++, req, gen: req.gen, waitingAt: undefined }, undefined);
  };

  // A single fork of a request leaves the system CLEANLY (it fired no onward edge). The request SUCCEEDS when its
  // last outstanding fork leaves. Called only for forks of the CURRENT attempt (staleness is filtered upstream).
  const leave = (job: Job): void => {
    inSystem -= 1;
    if (--job.req.outstanding > 0) return; // other forks of this attempt are still in flight
    terminate(job.req, true, now); // success: the whole attempt completed within its deadline
  };

  // A fork of the CURRENT attempt is LOST at a full buffer (no queue slot). One lost fork dooms the attempt: it
  // cannot join, so the attempt cannot succeed. Treat exactly like an abandonment (retry if budget remains, else
  // fail) — a dropped request that still has retries left will try again, matching a client retrying a 5xx.
  const lose = (job: Job): void => {
    if (job.gen !== job.req.gen) {
      inSystem -= 1; // a stale fork hit a full buffer: just remove it, its attempt already ended
      return;
    }
    inSystem -= 1;
    job.req.outstanding -= 1;
    endAttempt(job.req);
  };

  // End the CURRENT attempt without success (a renege or a drop): retry if the budget allows, else fail. Bumps
  // the generation FIRST so any OTHER still-in-flight forks of this attempt become stale (discarded lazily when
  // they surface, freeing their servers/slots without splicing), and drops them from the in-system count.
  const endAttempt = (req: Req): void => {
    req.gen += 1;
    inSystem -= req.outstanding; // release the abandoned attempt's still-live forks
    req.outstanding = 0;
    const policy = req.policy;
    if (policy !== undefined && req.attempt <= policy.retries) {
      // budget remains (attempt is 1-based; `retries` = additional attempts after the first) ⇒ re-inject after backoff
      req.attempt += 1;
      events.push({ kind: 'reinject', time: now + Math.max(0, policy.backoffMs) / 1000, req, gen: req.gen, seq: seq++ });
    } else {
      terminate(req, false, now); // NOTE: terminate bumps gen again — harmless (idempotent staleness), keeps counting exact
    }
  };

  // The next interarrival delay for a source from absolute time `from`. WITHOUT a rate profile this is exactly
  // today's stationary renewal draw (`sample`), byte-for-byte. WITH one (and an exponential stream — the only
  // shape a λ(t) modulation is defined for), arrivals are a non-homogeneous Poisson process sampled by exact
  // INVERSION (doc: load-curves §6.2; profile.ts cites Lewis & Shedler 1979 thinning as the fallback rationale):
  // ONE uniform per arrival — the very draw the stationary path makes — so the RNG stream stays aligned and a
  // FLAT profile reduces to `-Math.log(1 - u) / rate` literally (the sacred byte-identity, pinned in tests).
  const interarrivalDelay = (src: ArrivalSource, from: number): number =>
    src.rateProfile !== undefined && src.interarrival.kind === 'exponential'
      ? nextArrivalDelay(src.rateProfile, src.interarrival.rate, from, -Math.log(1 - rng.next()))
      : sample(src.interarrival, rng);

  // Seed the first arrival of each source.
  for (const src of network.arrivals) {
    events.push({ kind: 'externalArrival', time: interarrivalDelay(src, 0), at: src.at, seq: seq++ });
  }

  // A transient run has no completion budget — it is TIME-bounded (horizon or event cap) instead.
  const maxExits = tr !== undefined ? Number.POSITIVE_INFINITY : opts.warmupCompletions + opts.measureCompletions;
  while (exits < maxExits) {
    const ev = events.pop();
    if (ev === undefined) {
      // Drained: no more events. A transient run simply idles to its horizon — integrate the quiet stretch and
      // carry the (necessarily empty) backlog through the remaining windows so the observation covers [0, horizon].
      if (tr !== undefined) {
        now = tr.horizonS;
        integrate(now);
        trRoll(now);
      }
      break; // steady-state: stop honestly
    }
    if (tr !== undefined) {
      if (ev.time > tr.horizonS) {
        // The observation window is over (the heap pops in time order, so nothing before the horizon remains).
        // Close the books AT the horizon: time-averages and the window series cover exactly [0, horizonS].
        now = tr.horizonS;
        integrate(now);
        trRoll(now);
        break;
      }
      if (trEvents >= trCap) {
        trTruncated = true; // budget exhausted — stop HONESTLY at the last processed instant, never scale silently
        break;
      }
      trEvents += 1;
    }
    now = ev.time;
    integrate(now);
    if (tr !== undefined) trRoll(now);

    if (ev.kind === 'externalArrival') {
      const src = sourceOf.get(ev.at);
      if (src !== undefined) {
        events.push({ kind: 'externalArrival', time: now + interarrivalDelay(src, now), at: ev.at, seq: seq++ });
      }
      const s = states.get(ev.at);
      if (s === undefined) continue;
      if (measuring) originalArrivals += 1;
      if (tr !== undefined) (trWins[trCur] as { arrivals: number }).arrivals += 1;
      const policy = src?.attemptPolicy;
      const active = policy !== undefined && policy.timeoutMs > 0;
      // The patience clock: deterministic(timeoutMs) unless the source overrides it with an explicit patience
      // distribution (queueing theory models patience as a random time — the Erlang-A anchor assumes it
      // EXPONENTIAL; deterministic is just that distribution's degenerate case, which is a real client timeout).
      const patience: Distribution | undefined = !active
        ? undefined
        : src?.patience ?? { kind: 'deterministic', value: policy.timeoutMs / 1000 };
      const req: Req = {
        systemEntry: now,
        outstanding: 0,
        policy: active ? policy : undefined,
        patience,
        entry: ev.at,
        attempt: 1,
        deadline: Number.POSITIVE_INFINITY,
        gen: 0,
      };
      beginAttempt(req);
      continue;
    }

    if (ev.kind === 'abandon' || ev.kind === 'abandonAtStation') {
      // Renege iff this exact fork is STILL WAITING for its CURRENT attempt (not dequeued, not superseded). The
      // dead entry stays PHYSICALLY in its station's FIFO (skipped when eventually shifted out — O(log n), no
      // splice); we free its occupancy (`n`) here and now, since it will never be served. Both deadline sources
      // (caller attempt vs station wait) share this teardown; a station renege is additionally a DROP at the
      // station (a failure attributed to it, like a full-buffer loss). Whichever timer fires FIRST while the fork
      // waits wins; the other then finds `waitingAt === undefined` (or a bumped gen) and is a harmless no-op.
      const job = ev.job;
      const st = job.waitingAt;
      if (st === undefined || job.gen !== job.req.gen) continue; // dequeued already, or attempt ended: stale timer
      // A station timer is bound to the station that ARMED it: the same Job object can advance (be served, route
      // on, then wait at a DOWNSTREAM station), so a stale upstream station-timer must not renege it there.
      if (ev.kind === 'abandonAtStation' && String(st.def.id) !== String(ev.at)) continue;
      if (ev.kind === 'abandonAtStation' && measuring) st.dropped += 1; // station-side failure (borrow timeout etc.)
      st.n -= 1; // the waiter leaves the station; its stale array slot is skipped at the next dequeue
      job.waitingAt = undefined;
      inSystem -= 1;
      job.req.outstanding -= 1;
      endAttempt(job.req); // compose: if the caller has a retry budget, it re-attempts — no special-casing here
      continue;
    }

    if (ev.kind === 'reinject') {
      if (ev.gen !== ev.req.gen) continue; // stale (should not happen; defensive)
      beginAttempt(ev.req);
      continue;
    }

    // departure
    const s = states.get(ev.at);
    if (s === undefined) continue;
    s.busy -= 1;
    s.n -= 1;
    s.completions += 1;
    // Pull the next live WAITING job into service, skipping any dead stragglers that reneged while queued (the
    // abandon handler cleared their `waitingAt` and already freed their occupancy; only the array slot lingers).
    for (;;) {
      const next: Job | undefined = s.queue.shift();
      if (next === undefined) break;
      if (next.waitingAt === s) {
        startService(s, next); // a live waiter belonging to THIS station's queue
        break;
      }
      // else: a dead straggler (reneged) — its `n` was already reclaimed at abandon; just drop the slot.
    }

    // A STALE completion (its attempt ended while this fork sat in service): free the server (done above) and
    // discard — no goodput, no onward routing. The other lazy half of the O(log n) cancellation.
    if (ev.job.gen !== ev.job.req.gen) continue;

    const dests = routeAll(ev.at);
    // Close this node's RESPONSE suffix (doc: latency-semantics-v2 §4). Its own service is now done, so it stops
    // waiting on itself and starts waiting on its SYNCHRONOUS children: pending (was 1) becomes the count of sync
    // dests. Async dests are fire-and-forget — the caller does not block, so they add nothing and instead begin
    // their OWN perspective. With no sync child the frame settles NOW (this node's response is its own subtree).
    const frame = ev.job.frame;
    if (frame !== undefined) {
      let syncKids = 0;
      for (const d of dests) if (!d.async) syncKids += 1;
      frame.pending += syncKids - 1;
      if (frame.pending === 0) settle(frame);
    }
    if (dests.length === 0) {
      leave(ev.job); // this fork leaves — and completes (succeeds) the attempt if it was the last
    } else {
      // fork to every destination: the job continues to the first, a fresh copy goes to each other (all share the
      // same req + generation, so the attempt joins only when its slowest fork exits). A SYNC child inherits this
      // node's frame as its `parent` (so its completion closes part of this node's response); an ASYNC child gets
      // no parent (the cut) — it opens a fresh response perspective and the request still joins on it downstream.
      ev.job.req.outstanding += dests.length - 1;
      inSystem += dests.length - 1;
      dests.forEach((dest, i) =>
        enter(
          states.get(dest.to) as StationState,
          // A forked child is the SAME lineage: it inherits the parent's lag stamps by reference (doc:
          // latency-semantics-v2 §3), so a source crossed upstream still measures at any terminal this fork reaches.
          // (Spread the stamps in only when present — `exactOptionalPropertyTypes` forbids an explicit `undefined`.)
          i === 0 ? ev.job : { id: nextJobId++, req: ev.job.req, gen: ev.job.gen, waitingAt: undefined, ...(ev.job.lagStamps !== undefined ? { lagStamps: ev.job.lagStamps } : {}) },
          dest.async ? undefined : frame,
        ),
      );
    }
  }

  const T = Math.max(now - measureStart, Number.EPSILON);
  sojourns.sort((a, b) => a - b);

  const stations: StationStats[] = [];
  // Sort each station's response reservoir ONCE (ascending) so both the nodeResponse percentiles and the
  // `responsePercentile` lookup below read nearest-rank off the same prepared sample.
  const respSorted = new Map<StationId, number[]>();
  const nodeResponse: NodeResponse[] = [];
  for (const s of states.values()) {
    stations.push({
      id: s.def.id,
      utilization: s.areaBusy / (s.def.servers * T),
      meanNumberInSystem: s.area / T,
      arrivals: s.arrivals,
      completions: s.completions,
      dropped: s.dropped,
    });
    const res = s.respReservoir.sort((a, b) => a - b);
    respSorted.set(s.def.id, res);
    nodeResponse.push({
      id: s.def.id,
      mean: s.respSeen > 0 ? s.respSum / s.respSeen : NaN, // exact over ALL responses (not just the reservoir)
      p50: percentileSorted(res, 0.5),
      p95: percentileSorted(res, 0.95),
      p99: percentileSorted(res, 0.99),
      samples: res.length,
    });
  }

  // FLOW-SCOPED LAG results (doc: latency-semantics-v2 §3) — one entry per DECLARED pair, its reservoir sorted once
  // so both `pairLag` and the `lagPercentile` lookup read nearest-rank off the same prepared sample. Empty when no
  // pair was declared. Insertion order over `lagAgg` is the declared order (a Map preserves it) — deterministic.
  const lagSorted = new Map<string, number[]>();
  const pairLag: PairLag[] = [];
  for (const [key, agg] of lagAgg) {
    const sorted = agg.reservoir.sort((a, b) => a - b);
    lagSorted.set(key, sorted);
    pairLag.push({
      source: agg.source,
      terminal: agg.terminal,
      mean: agg.seen > 0 ? agg.sum / agg.seen : NaN, // exact over ALL recorded lags
      p50: percentileSorted(sorted, 0.5),
      p95: percentileSorted(sorted, 0.95),
      p99: percentileSorted(sorted, 0.99),
      samples: sorted.length,
    });
  }

  // TRANSIENT assembly (only in transient mode): windows up to the observed end (all of them normally; on a
  // truncated run only those actually reached — the LAST one clipped to `endS`, an honest partial window), each
  // window's reservoir sorted once for nearest-rank percentiles, and the per-station backlog series + peaks.
  let transient: TransientMetrics | undefined;
  if (tr !== undefined) {
    const count = trTruncated ? trCur + 1 : trWindowCount;
    const windows: TransientWindow[] = [];
    for (let w = 0; w < count; w++) {
      const win = trWins[w] as TrWin;
      const sortedWin = win.reservoir.sort((a, b) => a - b);
      const gridEnd = Math.min((w + 1) * tr.windowS, tr.horizonS);
      windows.push({
        startS: w * tr.windowS,
        endS: trTruncated && w === count - 1 ? Math.min(gridEnd, now) : gridEnd,
        arrivals: win.arrivals,
        attempts: win.attempts,
        served: win.served,
        failed: win.failed,
        p50S: percentileSorted(sortedWin, 0.5),
        p99S: percentileSorted(sortedWin, 0.99),
        samples: sortedWin.length,
        amplification: win.arrivals > 0 ? win.attempts / win.arrivals : NaN,
      });
    }
    const backlog: StationBacklog[] = network.stations.map((st) => {
      const pk = trPeak.get(st.id) as { value: number; atS: number };
      return { id: st.id, maxPerWindow: (trBacklog.get(st.id) as number[]).slice(0, count), peak: pk.value, peakAtS: pk.atS };
    });
    transient = {
      horizonS: tr.horizonS,
      windowS: tr.windowS,
      endS: trTruncated ? now : tr.horizonS,
      windows,
      backlog,
      eventsProcessed: trEvents,
      estimatedEvents: estimateTransientEvents(network, tr.horizonS),
      eventCap: trCap,
      truncated: trTruncated,
    };
  }

  return {
    ...(transient !== undefined ? { transient } : {}),
    measuredTime: T,
    completions: measuredExits,
    departureRate: measuredExits / T,
    meanNumberInSystem: networkArea / T,
    meanSojourn: mean(sojourns),
    sojournPercentile: (p) => percentileSorted(sojourns, p),
    stations,
    goodputRps: goodput / T,
    errorRate: failures / T,
    // amplification = attempts ÷ original arrivals. With no retries the two are equal ⇒ 1. Guard the empty window.
    amplification: originalArrivals > 0 ? attemptsMade / originalArrivals : 1,
    nodeResponse,
    responsePercentile: (node, p) => {
      const res = respSorted.get(node);
      return res !== undefined ? percentileSorted(res, p) : NaN; // unknown node ⇒ NaN ⇒ honest `unknown` upstream
    },
    pairLag,
    lagPercentile: (source, terminal, p) => {
      const res = lagSorted.get(lagKey(String(source), String(terminal)));
      return res !== undefined ? percentileSorted(res, p) : NaN; // undeclared pair / never reached ⇒ NaN ⇒ honest `unknown`
    },
  };
}
