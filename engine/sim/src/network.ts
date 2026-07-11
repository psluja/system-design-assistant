import type { Distribution } from './distribution';
import type { RateProfile } from './profile';

/** A station identifier within a queueing network. */
export type StationId = string & { readonly _: 'StationId' };
export const StationId = (s: string): StationId => s as StationId;

/**
 * A multi-server station: a queue feeding `servers` identical servers, each drawing service times
 * from `service`. `capacity` (number in system, queue + in service) bounds admission; an arrival
 * beyond it is dropped (loss). Omit for an unbounded queue.
 *
 * `maxQueueWaitMs` is a STATION-LEVEL wait deadline (doc: retry-feedback §3 "reneging"): a job that
 * has WAITED in THIS station's FIFO longer than `maxQueueWaitMs` (armed on queue-join here, disarmed
 * on service start) abandons — a FAILURE, counted as a drop at this station. It is distinct from the
 * caller's per-attempt {@link AttemptPolicy} deadline (which spans the whole attempt across every hop):
 * this is the wait AT this resource for a slot to free (a connection-pool borrow timeout, a
 * load-shedder's admission deadline). Pure timing math — no domain vocabulary. Absent (or 0) ⇒ no
 * station deadline: bit-for-bit the pre-deadline behaviour (jobs wait indefinitely for a server).
 * If the job's request ALSO carries an AttemptPolicy, the two deadlines COMPOSE: whichever fires first
 * abandons the attempt, and the caller's retry logic then applies exactly as for any other failed
 * attempt (no special-casing — see des.ts).
 */
export interface Station {
  readonly id: StationId;
  readonly service: Distribution;
  readonly servers: number;
  readonly capacity?: number;
  readonly maxQueueWaitMs?: number;
}

/**
 * A caller's per-attempt retry policy (doc: retry-feedback). Pure timing math — no domain vocabulary. A job
 * whose current attempt (queue-wait + service, accumulated from when the attempt was injected) exceeds
 * `timeoutMs` ABANDONS wherever it currently waits; after `backoffMs` it is re-injected at its ORIGINAL entry
 * station with the attempt counter incremented, while attempts ≤ `retries`; once `retries` is exhausted a
 * further timeout is a FAILURE. `timeoutMs = 0` means no deadline ⇒ no reneging, no retries: bit-for-bit the
 * pre-policy behaviour (the `retries`/`backoffMs` fields are then inert).
 */
export interface AttemptPolicy {
  readonly timeoutMs: number; // per-attempt deadline; 0 ⇒ none (no reneging)
  readonly retries: number; // additional attempts after the first (0 ⇒ fail on first timeout)
  readonly backoffMs: number; // fixed delay before re-injection
}

/**
 * An external (open-network) arrival stream feeding a station. The OPTIONAL `attemptPolicy` is the caller-side
 * retry policy that travels with every job this source injects (doc: retry-feedback §2). It rides on the
 * arrival source — not the station — because a retry policy is a fact of the CALLER's code, and jobs are BORN
 * here: this is also exactly the job's original entry station, so re-injection re-enters `at` with no extra
 * bookkeeping. Absent ⇒ no reneging/retries (today's behaviour, bit-for-bit).
 */
export interface ArrivalSource {
  readonly at: StationId;
  readonly interarrival: Distribution;
  readonly attemptPolicy?: AttemptPolicy;
  /**
   * The per-attempt PATIENCE clock — the random time a caller waits before it renegess this attempt. Queueing
   * theory models patience as a distribution; the natural production case is a fixed client timeout, i.e. the
   * DEGENERATE `deterministic(timeoutMs)`, which is what the DES uses when this is omitted. An explicit override
   * lets patience be non-deterministic — notably EXPONENTIAL, the assumption of the Erlang-A model (M/M/c+M),
   * so the reneging primitive can be differential-tested against that closed form. It has no effect without an
   * active `attemptPolicy` (`timeoutMs > 0`); when present it REPLACES the deterministic deadline. Time is in the
   * network's own units (seconds), matching `service`/`interarrival`.
   */
  readonly patience?: Distribution;
  /**
   * OPTIONAL time-of-period MODULATION of this source's arrival rate (doc: load-curves §6.2) — a periodic,
   * piecewise-linear multiplier profile, pure timing data like `interarrival` itself (no domain vocabulary; what
   * a "day" means is content). Meaningful with an EXPONENTIAL `interarrival` (an open Poisson stream): the DES
   * then generates a non-homogeneous Poisson process with rate λ(t) = interarrival.rate × m(t)/m̄ — the profile is
   * NORMALIZED AT READ (divided by its drawn mean), so the declared rate stays the period's MEAN rate. Sampling is
   * by exact INVERSION, one uniform per arrival (profile.ts — Lewis & Shedler thinning is the documented fallback
   * for non-piecewise-linear profiles), so a FLAT profile (and an absent one) is byte-for-byte today's stream. A
   * non-exponential `interarrival` ignores the profile (a renewal stream has no λ(t) to modulate — honest no-op).
   */
  readonly rateProfile?: RateProfile;
}

/** An onward route a completing job takes with probability `prob`, INDEPENDENTLY of the other edges — so a
 *  job may FAN OUT to several downstreams at once (prob=1 ⇒ a deterministic fan-out).
 *
 *  `multiplicity` (default 1) is the MEAN number of jobs this edge delivers to `to` per upstream completion —
 *  the per-edge traffic transfer of the flow model (doc: flow-transformations). It is realised HONESTLY as a
 *  count: floor(multiplicity) jobs always, plus one more with probability equal to the fractional part, so the
 *  mean is exactly `multiplicity` and the DES sees true integer job counts (no fictitious fractional jobs):
 *   - an AMPLIFYING factor k ≥ 1 ⇒ multiplicity k (k jobs downstream per upstream completion; k=100 ⇒ ~100)
 *   - a THINNING factor f ≤ 1 ⇒ multiplicity f, i.e. a per-completion Bernoulli(f) — true randomness at f < 1.
 *  Fidelity note: a thinning that models a stateful reduction (buffer n then emit one) reproduces the MEAN rate
 *  but not the buffering TIMING — memory over time is a queue, not a memoryless route (that dynamic belongs to a
 *  queueing station, not this edge). `prob` and `multiplicity` compose: the edge fires with `prob`, then
 *  delivers that many jobs. Domain meaning (what a factor represents) is the caller's; this is pure arithmetic.
 *
 *  `async` (default false) marks a FIRE-AND-FORGET hop: the completing job hands work onward but its CALLER does
 *  not block on that work finishing. Pure timing semantics (like `prob`/`multiplicity`), not domain vocabulary —
 *  the difference between waiting for a reply and dropping a message on a queue. It changes NOTHING about the
 *  end-to-end sojourn (a forked job still runs, and the request still joins when its LAST fork exits, so the
 *  whole-system tail still includes the async branch). Its ONE effect is on per-node RESPONSE sampling (below):
 *  an async edge CUTS the caller's synchronous subtree, so the upstream node's response excludes it and the
 *  async target begins a fresh response perspective of its own (doc: latency-semantics-v2 §4). */
export interface RouteEdge {
  readonly to: StationId;
  readonly prob: number;
  readonly multiplicity?: number;
  readonly async?: boolean;
}

/**
 * An open queueing network. `routing[s]` lists the onward edges from station `s`; each edge fires
 * INDEPENDENTLY with its `prob`, so a completing job may fork to several downstreams (each prob=1 edge gets
 * the FULL rate — a fan-out, matching a producer that feeds all its dependencies). A job that fires NO edge
 * leaves the system; a request joins (and its sojourn is recorded) only when its last fork exits. This is the
 * domain-free structure the simulator runs; mapping a content graph onto it is a separate projector.
 */
export interface QueueingNetwork {
  readonly stations: readonly Station[];
  readonly arrivals: readonly ArrivalSource[];
  readonly routing: ReadonlyMap<StationId, readonly RouteEdge[]>;
}
