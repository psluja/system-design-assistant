// @algorithm DES network projection (graph to queueing network, transform means, Little's-law pools)
// @problem The typed-property graph must become the DES's queueing network — arrival sources,
//   M/M/c stations, route edges — with flow transforms and retry policies translated into pure
//   timing terms the simulator understands, staying consistent with the analytic twin.
// @approach Project each node through the SAME capacity/server reads the analytic model uses
//   (graph-read.ts — one definition, differential-consistent); translate per-port/per-wire
//   transforms to mean per-completion multiplicities (ratio k, prob p, batch 1/n; rate ceilings
//   cap/window induce no memoryless route thinning — the forward pass owns them); size connection
//   pools by Little's-law algebra; lower generator cycles to baseline-anchored rate profiles; attach
//   caller retry policies as DES AttemptPolicy.
// @complexity O(V + E) single projection pass.
// @citations Little 1961 (pool sizing); the transform-mean argument is stated inline
//   (docs/design/flow-transformations.html).
// @invariants Analytic and DES read capacity through the one shared definition (they can never
//   drift); timeoutMs = 0 means byte-identical pre-retry behavior; a flat generator (no cycles / all
//   ×1 / disabled) reduces to plain exponential arrivals exactly.
// @where-tested content/sda/src/sim.e2e.test.ts, content/sda/src/queueing.e2e.test.ts,
//   content/sda/src/transform.e2e.test.ts, content/sda/src/generator.e2e.test.ts

// @feature Retry feedback & goodput collapse
// @story Model caller timeouts, retries and backoff so the simulation shows retry amplification and
//   the goodput-collapse death spiral, not a naive steady state.
// @surfaces mcp (simulate reads goodput + amplification), web + vscode (config knobs
//   timeoutMs / retryCount / retryBackoffMs via set_config and the inspectors)
// @algorithms engine/sim/src/des.ts, content/sda/src/sim.ts
// @docs docs/design/retry-feedback.html
// @e2e content/sda/src/retry-feedback.e2e.test.ts
// @status shipped

import { type Cycle, type Graph, type Node, type NodeId, type Transform } from '@sda/engine-core';
import { StationId, isFlatProfile, profileMean, profileValue, type ArrivalSource, type AttemptPolicy, type Distribution, type QueueingNetwork, type RateProfile, type RateProfilePoint, type RouteEdge, type Station } from '@sda/engine-sim';
import { keys } from './registry';
import { cfg, queueStation } from './graph-read';
import { combinedCycleProfile } from './load-stages';

/**
 * The caller-side retry policy declared on a node (doc: retry-feedback), or undefined when it sets no deadline.
 * Reads the three node-local knobs and hands the DES a pure-timing {@link AttemptPolicy}. `timeoutMs = 0` (the
 * default) ⇒ no policy: the DES then behaves exactly as before (no reneging, no retries). SCOPING NOTE (v1): this
 * policy attaches to the arrivals the node ORIGINATES (its `assumedRps` / legacy client throughput). A mid-chain
 * service that both serves upstream traffic AND originates its own only governs the traffic it originates —
 * per-hop / per-wire retry policies are a declared non-goal (doc: retry-feedback §6), revisited with a named case.
 */
function attemptPolicyOf(node: Node): AttemptPolicy | undefined {
  const timeoutMs = cfg(node, keys.timeoutMs) ?? 0;
  if (!(timeoutMs > 0)) return undefined; // no deadline ⇒ no reneging/retries (pre-retry behaviour)
  return {
    timeoutMs,
    retries: Math.max(0, Math.floor(cfg(node, keys.retryCount) ?? 0)),
    backoffMs: Math.max(0, cfg(node, keys.retryBackoffMs) ?? 0),
  };
}

/**
 * The MEAN per-completion multiplicity a flow transform induces on a DES route edge (doc: flow-transformations).
 * ratio(k) and prob(p) map directly to a mean count (k, or a Bernoulli(p)); batch(n) thins 1/n. cap/window are
 * rate CEILINGS whose effect depends on the offered rate — a memoryless per-completion route cannot see that
 * rate, so they induce NO route thinning here (their steady-state effect is the forward-pass throttle + overflow
 * verdict; the DES then simulates the un-thinned stream, which is conservative — it never under-reports load).
 * That is the honest fidelity line: the DES reproduces ratio/batch/prob MEANS exactly and leaves ceilings to the
 * forward pass rather than faking a stateful token bucket in a memoryless edge.
 */
function transformFactor(t: Transform | undefined): number {
  if (t === undefined) return 1;
  switch (t.kind) {
    case 'ratio':
    case 'prob':
      return t.value;
    case 'batch':
      return 1 / t.value;
    case 'cap':
    case 'window':
      return 1; // a ceiling, not a mean thinning — see the note above
    case 'generate':
      return 1; // a generator ORIGINATES at the node (its arrivals ride the node's ArrivalSource below); the port's route edges relay the served flow untouched — identity, like the scalar seam
  }
}

/**
 * A generator's cycles lowered to the time engine's RateProfile (doc: load-stages §9) — the baseline-anchored
 * product shape (Π cycles), or `undefined` when the generator is flat. Renamed from `curveToProfile`: it now
 * takes cycles and delegates to the ONE cycle-arithmetic home (load-stages `combinedCycleProfile`), so every
 * surface that must read the shape (the DES projection here, the Tier-1 sweep, later editor rounds) lowers it
 * identically. Exported for external consumers (the design-doc, tests).
 */
export function cyclesToProfile(cycles: readonly Cycle[]): RateProfile | undefined {
  return combinedCycleProfile(cycles);
}

/** A generator resolved off a graph port — its baseline `level`, its periodic `cycles`, and the live `disable`. */
interface ResolvedGen {
  readonly level: number;
  readonly cycles?: readonly Cycle[];
  readonly disable?: boolean;
}

/**
 * The DES arrival for a node's generators (doc: load-stages §9) — the total baseline-anchored stream
 * λ(t) = Σ_gens levelᵢ · Π cyclesᵢ(t), lowered to `{ rate, profile }` so the sampler plays exactly λ(t). The
 * profile is the RAW λ shape (its own mean = the mean rate); the sampler divides by that mean and this `rate`
 * multiplies it back, so effective λ(t) = rate · P(t)/mean(P) = P(t) — the ×m̄ BASELINE COMPENSATION (§9),
 * unified for every generator (the two rival level conventions collapse to one). A single shaped generator lowers
 * EXACTLY (scale + offset of its cycle profile); several shaped generators (rare in R1) sum by sampling. FLAT (no
 * cycles / all ×1 / `disable`) ⇒ no profile and `rate = fallbackRate` (Σ levels): byte-for-byte today's
 * exponential stream (the sacred pin).
 */
function generatorArrival(gens: readonly ResolvedGen[], fallbackRate: number): { readonly rate: number; readonly profile?: RateProfile } {
  const shapes = gens
    .filter((g) => g.level > 0)
    .map((g) => ({ level: g.level, shape: g.disable === true ? undefined : combinedCycleProfile(g.cycles) }));
  if (shapes.every((x) => x.shape === undefined)) return { rate: fallbackRate }; // flat: today, byte-for-byte
  const shaped = shapes.filter((x): x is { level: number; shape: RateProfile } => x.shape !== undefined);
  const flatSum = shapes.reduce((sm, x) => sm + (x.shape === undefined ? x.level : 0), 0); // flat gens contribute level·1
  let profile: RateProfile;
  if (shaped.length === 1) {
    // The common case: one shaped generator (+ any flat ones). P(t) = level·shape(t) + Σ flat levels — a scale
    // and offset of the cycle profile, exact over its period.
    const only = shaped[0] as { level: number; shape: RateProfile };
    profile = { periodS: only.shape.periodS, points: only.shape.points.map((p) => ({ t: p.t, m: only.level * p.m + flatSum })) };
  } else {
    // Several shaped generators superpose (Σ across generators — §5): sample the sum over the slowest period.
    const periodS = shaped.reduce((mx, x) => Math.max(mx, x.shape.periodS), 0);
    const count = Math.max(64, ...shaped.map((x) => x.shape.points.length));
    const points: RateProfilePoint[] = [];
    for (let i = 0; i < count; i++) {
      const t = (i * periodS) / count;
      points.push({ t, m: flatSum + shaped.reduce((sm, x) => sm + x.level * profileValue(x.shape, t), 0) });
    }
    profile = { periodS, points };
  }
  return isFlatProfile(profile) ? { rate: fallbackRate } : { rate: profileMean(profile), profile };
}

/**
 * The DES station for a node, forming a FINITE-server M/M/c whenever the node declares a connection POOL (doc:
 * retry-feedback §3; calibration #1). A finite connection pool QUEUES under load BY PHYSICS — independent of any
 * caller deadline — so a fixed-throughput RESOURCE-POOL node (no `concurrency`, so `servers` is PURE_DELAY) whose
 * `connectionPool` + `connectionHeldMs` are set becomes an M/M/c: c = the pool slots, each HELD for
 * `connectionHeldMs` (the per-job service h ⇒ μ = 1/h). Then c·μ = pool/held EQUALS the node's declared throughput
 * ceiling (the SAME Little's-law algebra the scalar `poolOverflow`/`overflow` band uses), so the DES capacity
 * matches the scalar pass — only the TAIL is new: the store's p99 now rises with load instead of the flat pure
 * delay it was, blind to the very saturation the scalar overflow flags.
 *
 * This DROPS the old deadline requirement: the pool used to form only when `maxQueueWaitMs > 0` (a caller borrow
 * timeout), but a finite pool queues whether or not a deadline is armed — the deadline governs RENEGING (a wait
 * past it fails), not whether the queue exists. So the M/M/c forms on the pool alone; the station's `maxQueueWaitMs`
 * (reneging / borrow-timeout) is applied by the caller ON TOP, unchanged. HONEST byte-identity: a node with a pool
 * AND a deadline (the RDS Proxy, which ships a 120 s ConnectionBorrowTimeout) already formed this station, so it is
 * unchanged; a node with NO pool stays a pure delay (the sacred pin). The pool arithmetic lives in graph-read's
 * shared {@link queueStation} — the SAME primitive the analytic twin (queueing.ts) reads — so the DES station and
 * the analytic M/M/c can never drift (a concurrency-bound station keeps its own servers; pure config read, no TYPE
 * branch). This projector just lowers that station to the DES's exponential {@link Distribution}.
 */
function poolStation(node: Node): { readonly service: Distribution; readonly servers: number } {
  const st = queueStation(node); // shared with the analytic nodeQueues: c servers + per-server service ms (held for a pool)
  const rate = 1000 / Math.max(st.serviceMs, 1e-6); // μ per second (ms → 1/s): 1/held for a pool, else 1/service
  return { service: { kind: 'exponential', rate }, servers: st.servers };
}

/**
 * Project a design graph onto a queueing network for the time engine (doc-4 §3b). This is the
 * CONTENT-aware seam: it reads SDA keys (throughput as arrival rate, perRequestDuration/latency as
 * service time, concurrency as server count) and emits the domain-free QueueingNetwork the simulator
 * runs. A node with no incoming edge is a load SOURCE; a node with no concurrency cap is modelled as a
 * pure delay (effectively unbounded servers) so only the capacity-limited tiers can queue.
 */
export function toQueueingNetwork(graph: Graph): QueueingNetwork {
  const incoming = new Map<NodeId, NodeId[]>();
  for (const id of graph.nodes.keys()) incoming.set(id, []);
  for (const e of graph.edges.values()) {
    const from = graph.ports.get(e.from)?.node;
    const to = graph.ports.get(e.to)?.node;
    if (from !== undefined && to !== undefined) incoming.get(to)?.push(from);
  }
  const isSource = (id: NodeId): boolean => (incoming.get(id) ?? []).length === 0;
  // The workload a node ORIGINATES itself (universal traffic origin): its own req/s, injected regardless of where
  // it sits in the topology. A client is just the special case where this is the node's whole job; a migration
  // service, a cron worker or ANY node can originate too.
  const origin = (id: NodeId): number => { const n = graph.nodes.get(id); return n ? cfg(n, keys.assumedRps) ?? 0 : 0; };
  // The full req/s a node EMITS into the network: its assumedRps origin, plus — for a legacy topological source with
  // no assumedRps — its throughput-as-workload preset (every saved client design). This is the exact Poisson stream
  // the node injects, whether it is a pure client or a service that also originates.
  const emittedRps = (node: Node): number =>
    origin(node.id) + (isSource(node.id) && origin(node.id) === 0 ? cfg(node, keys.throughput) ?? 0 : 0);
  const hasService = (node: Node): boolean =>
    cfg(node, keys.perRequestDuration) !== undefined || cfg(node, keys.concurrency) !== undefined || cfg(node, keys.cpuCores) !== undefined || (cfg(node, keys.queueMode) ?? 0) >= 1;
  // A node is a STATION (a served, MEASURED tier) unless it does no work at all. It is a station when it either is
  // NOT a topological source (it relays served traffic), OR it SERVES (its own service time / concurrency / queue),
  // OR it ORIGINATES traffic (emits > 0). The last clause is the R1 correction (single-truth latency for origins):
  // a PURE EMITTER — a client, or an origin-only source with no service — is now a ZERO-SERVICE PASSTHROUGH station
  // too. Its arrivals inject AT it (below), so its response reservoir measures the WHOLE journey it originates: by
  // the v2 suffix identity (des.ts §4) the ENTRY node's response IS the request's end-to-end sojourn, so a client
  // finally carries the same measured p50→p99 bar every served tier does. The passthrough is distribution-neutral:
  // its service = its declared `latency` (0 for a client) and, with no concurrency knob, PURE_DELAY (unbounded)
  // servers — so it adds ~0 delay and NEVER queues. An M/M/∞ zero-delay node relays its Poisson input untouched, so
  // every DOWNSTREAM tier sees the exact same arrival PROCESS as before and its sojourn distribution is unchanged
  // (only the byte-exact RNG realisation shifts by one instant hop ⇒ statistical goldens hold within tolerance). A
  // design with no emitter/source adds no station and stays bit-for-bit identical.
  const isStation = (node: Node): boolean => !isSource(node.id) || hasService(node) || emittedRps(node) > 0;

  const stations: Station[] = [];
  const arrivals: ArrivalSource[] = [];
  const routing = new Map<StationId, RouteEdge[]>();

  for (const node of graph.nodes.values()) {
    // ORIGIN + legacy CLIENT arrivals. Every emitter is now a station (see isStation), so it injects the traffic it
    // originates AT ITSELF — the tail then includes its own (zero for a client) service and, via routing, its whole
    // synchronous downstream, so the emitter's response reservoir IS the end-to-end journey. Legacy: a topological
    // source whose throughput CONFIG is its workload and that declares no assumedRps still emits the SAME total rate.
    const emit = emittedRps(node);
    if (emit > 0) {
      // The retry policy is a fact of THIS caller's code (doc: retry-feedback), so it rides on the traffic this
      // node ORIGINATES. Absent (timeoutMs=0) ⇒ no field ⇒ today's DES.
      const attemptPolicy = attemptPolicyOf(node);
      // THE CYCLES (doc: load-stages §9): the node's generators carry the SHAPE; `level` is the BASELINE, so the
      // DES rate is the derived MEAN (level × mean shape) and the raw λ profile rides on top (the ×m̄ baseline
      // compensation — one convention, §9). Read off the GRAPH ports (the generate transform rides the engine
      // Port), so a world-overlaid graph sims its own overridden level under the same shape. Flat/absent/disabled
      // ⇒ no profile and rate = `emit` (the reconciled level) ⇒ today's stream, byte-for-byte (the sacred pin).
      const gens = node.ports
        .map((pid) => graph.ports.get(pid))
        .filter((p) => p !== undefined && p.dir !== 'in' && p.transform?.kind === 'generate')
        .map((p) => p?.transform as ResolvedGen);
      const { rate: genRate, profile: rateProfile } = generatorArrival(gens, emit);
      arrivals.push({
        at: StationId(node.id),
        interarrival: { kind: 'exponential', rate: genRate },
        ...(attemptPolicy !== undefined ? { attemptPolicy } : {}),
        ...(rateProfile !== undefined ? { rateProfile } : {}),
      });
    }
    if (!isStation(node)) continue; // a node that neither relays, serves nor originates does no work ⇒ no station

    // A component acting as a queue drains at `drainRate` (single consumer pipeline) and buffers up to
    // `maxBacklog` messages — beyond that the DES drops them (the real overflow behaviour over time).
    if ((cfg(node, keys.queueMode) ?? 0) >= 1) {
      const drain = Math.max(cfg(node, keys.drainRate) ?? 1, 1e-6);
      const cap = cfg(node, keys.maxBacklog);
      stations.push({
        id: StationId(node.id),
        service: { kind: 'exponential', rate: drain },
        servers: 1,
        ...(cap !== undefined && Number.isFinite(cap) ? { capacity: cap } : {}),
      });
      continue;
    }
    // CONNECTION POOL → FINITE-server M/M/c (doc: retry-feedback §3; calibration #1): a fixed-throughput resource-pool
    // node (no `concurrency` knob — a datastore, the RDS Proxy) whose `connectionPool` + `connectionHeldMs` are set
    // forms an M/M/c whose c·μ = pool/held EQUALS its declared throughput ceiling (the DES capacity matches the scalar
    // pass), so ONLY the tail is new — its p99 rises with load instead of the flat pure delay. `poolStation` (via the
    // shared graph-read `queueStation`) forms it on the pool ALONE (a finite pool queues by physics, deadline or not).
    // The station WAIT DEADLINE below is layered ON TOP, unchanged: `maxQueueWaitMs` (a borrow timeout / admission
    // deadline / DATASTORE QUERY TIMEOUT) makes a wait past it RENEGE — the pool's overflow, now unfolding over time
    // (drops + goodput collapse + errorRate). A node with no pool AND no concurrency stays a pure delay (byte-for-bit).
    const maxQueueWaitMs = cfg(node, keys.maxQueueWaitMs) ?? 0;
    const s = poolStation(node);
    stations.push({ id: StationId(node.id), service: s.service, servers: s.servers, ...(maxQueueWaitMs > 0 ? { maxQueueWaitMs } : {}) });
  }

  // Routing runs between STATIONS (a request that a station serves and forwards). A pure emitter (legacy client,
  // or an origin-only source with no service) is NOT a station: it injects arrivals directly at its targets, so
  // it never appears as a routing SOURCE, and an arrival already sits AT the target — never route INTO a pure
  // emitter either. Origin service-stations (e.g. a migration service) DO route their served flow downstream.
  // FAN-OUT (prob 1 each, NOT a 1/N split): a component feeds the FULL rate to every downstream — a service
  // calling both a cache AND a db sends each request to both. This matches the forward/flow model (which fans
  // out), so the DES and the analytic engine agree (no phantom offload from adding a side branch). Iterating
  // EDGES (not the node adjacency) lets each carry its own TRANSFORMS: the route's `multiplicity` is the OUT-side
  // f_out (wire override > source port default) times the target in-port's f_in (identity 1 when absent ⇒ today's).
  const stationIds = new Set(stations.map((s) => String(s.id)));
  for (const e of graph.edges.values()) {
    const from = graph.ports.get(e.from);
    const to = graph.ports.get(e.to);
    if (from === undefined || to === undefined) continue;
    if (!stationIds.has(String(from.node)) || !stationIds.has(String(to.node))) continue;
    // Same OUT-side resolution as the forward pass (doc: flow-transformations-r2 §5): the WIRE's transform WINS
    // over the source out-port's, so a per-wire routing split (a 70/30 fan-out) thins each route edge by ITS own
    // share. Absent wire transform ⇒ the source port's f_out — the DES stays identical to today for broadcast fan-out.
    const multiplicity = transformFactor(e.transform ?? from.transform) * transformFactor(to.transform);
    // A FIRE-AND-FORGET wire (semantics 'async') marks the route edge async so the DES's per-node RESPONSE
    // sampling CUTS the caller's synchronous subtree at it (doc: latency-semantics-v2 §4) — the caller does not
    // block on the message it dropped on a queue. This is PURE per-node response bookkeeping: it changes NOTHING
    // about the end-to-end sojourn (the forked job still runs and the request still joins on its last fork), so
    // the whole-system tail and every existing metric stay bit-for-bit identical (R1 RouteEdge.async note).
    const async = e.semantics === 'async';
    const list = routing.get(StationId(from.node)) ?? [];
    list.push({ to: StationId(to.node), prob: 1, ...(multiplicity !== 1 ? { multiplicity } : {}), ...(async ? { async: true } : {}) });
    routing.set(StationId(from.node), list);
  }

  return { stations, arrivals, routing };
}
