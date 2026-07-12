import { Key, Unit, registryOf, type KeyDef, type Registry } from '@sda/engine-core';

// The seed PROPERTY REGISTRY: the canonical keys a credible design tool reasons about, each
// with its unit and the algebra by which it composes along a request path. This is content — the
// engine knows only that keys exist and how their declared `aggregate` combines them.

export const keys = {
  throughput: Key('throughput'),
  latency: Key('latency'),
  // the TAIL (p99) of latency — a SEPARATE SLO key from the mean `latency`, so an architect can require BOTH a
  // mean and a p99 target at once (they no longer overwrite each other). It carries no forward value; it is
  // verified ONLY against the simulated DES tail (checkTailBands). Node-local: it never flows across edges.
  tailLatency: Key('tailLatency'),
  // how a node combines the RESPONSE latencies of its SYNCHRONOUS downstream calls: 0 = sequential
  // (sum), 1 = parallel/scatter-gather (max, the critical path), 2 = fastest/hedged (min). A per-node DESIGN
  // choice; node-local, never flows. Read by the `responseLatency` projector; default 0 (the conservative bound).
  latencyComposition: Key('latencyComposition'),
  availability: Key('availability'),
  cost: Key('cost'),
  concurrency: Key('concurrency'),
  perRequestDuration: Key('perRequestDuration'),
  // DOCUMENTED LIMITS (task-72) — account/service ceilings that cause real outages, modelled as DATA.
  // Lambda ACCOUNT concurrency: a serverless fleet is throttled not only by its own per-function knob but by
  // the Region-wide concurrent-executions quota (default 1,000, soft). `accountConcurrency` is that ceiling
  // (a node-local config); `concurrencyNeeded` is the concurrency the OFFERED load implies (Little's law:
  // arrivalRate × service-time); `concurrencyOverflow` = max(0, needed − ceiling) — the throttled excess.
  accountConcurrency: Key('accountConcurrency'),
  concurrencyNeeded: Key('concurrencyNeeded'),
  concurrencyOverflow: Key('concurrencyOverflow'),
  // DynamoDB (and SQS/SNS) documented PAYLOAD ceiling: item/message max size in bytes. `maxItemBytes` is the
  // documented limit (a node-local config); `payloadOverflow` = max(0, payloadBytes − maxItemBytes) — how far
  // an over-size item/message exceeds the ceiling (a reject, not a throttle). Informational unless the architect
  // sets `payloadBytes` (the real item/message size) on the node; 0 by default ⇒ the limit is never falsely breached.
  maxItemBytes: Key('maxItemBytes'),
  payloadOverflow: Key('payloadOverflow'),
  // CONNECTION POOL (a proxy that multiplexes clients onto a fixed set of backend connections — RDS Proxy,
  // pgbouncer). `connectionPool` is the pooled-connection budget (config, ceiling); `connectionHeldMs` is how
  // long ONE request holds a pooled connection (~ the backend's per-query time; config); `poolConnectionsNeeded`
  // is what the OFFERED load implies (Little: inflow × heldMs/1000); `poolOverflow` = max(0, needed − pool),
  // banded ≤ 0. Deliberately NOT the `concurrency` key: the pool is a pass-through budget, not this node's
  // service parallelism — the DES must keep treating the proxy as a thin fixed-latency hop.
  connectionPool: Key('connectionPool'),
  connectionHeldMs: Key('connectionHeldMs'),
  poolConnectionsNeeded: Key('poolConnectionsNeeded'),
  poolOverflow: Key('poolOverflow'),
  // CPU-BOUND TIER (calibration: TechEmpower single-query, DeathStarBench nginx front-end). A node whose real
  // ceiling is its CPU — a web framework, an nginx/Thrift front-end — not its concurrency pool, connection pool or
  // declared throughput. `cpuCores` is the parallel-execution width it can burn at once (hardware threads / vCPUs);
  // `cpuTimePerRequestMs` is the CPU time ONE request costs. Together they form the THIRD M/M/c queueing STATION a
  // node can declare (c = cpuCores, μ = 1/cpuTimeS ⇒ capacity = cores/cpuTime), so a CPU-bound front-end saturates
  // on CPU at LOW load, before any database. Both node-LOCAL (a downstream store has no "cores") and OPTIONAL:
  // absent EITHER ⇒ no CPU ceiling ⇒ a node byte-identical to one without them (the sacred pin). When a node
  // declares several resource ceilings, its queue station is the BINDING one (lowest capacity = the real
  // bottleneck); the two in-series resources are modelled as the MIN, NOT a tandem queueing network — the DEEP
  // allocator/GC/lock-contention economics stays out of domain (flagged unmodeled). Config only, referenced by the
  // shared `queueStation` (graph-read) — NO branch on component TYPE (the closed-framework invariant).
  cpuCores: Key('cpuCores'),
  cpuTimePerRequestMs: Key('cpuTimePerRequestMs'),
  // STATION WAIT DEADLINE — the longest a request may WAIT AT this node for a
  // contended resource (a pooled connection, an admission slot) before it abandons with an error. GENERIC queueing
  // vocabulary: any resource-waiting component may declare one (a pooling proxy's borrow timeout, a load-shedder's
  // admission deadline). Node-LOCAL config, ms, default 0 = none. It shapes ONLY the DES (a wait deadline is a
  // question about time): `toQueueingNetwork` maps a non-zero value onto this node's station as `maxQueueWaitMs`,
  // so under resource pressure the wait can exceed it and the job renegess (a station-side FAILURE → errorRate +
  // this node's dropped). The scalar pass never reads it. Distinct from the caller's per-attempt `timeoutMs`
  // (which spans a whole attempt across every hop); this is the wait AT one resource for a slot to free.
  maxQueueWaitMs: Key('maxQueueWaitMs'),
  // billing driver for per-vCPU-priced managed services (RDS Proxy charges per target vCPU)
  vcpus: Key('vcpus'),
  durability: Key('durability'),
  replicas: Key('replicas'),
  // AWS deployment mode (0 = single-AZ, 1 = Multi-AZ, 2 = multi-Region) — selects the published-SLA availability
  deploymentMode: Key('deploymentMode'),
  // queue behaviour ("act as queue") — any component can buffer work; these bound how well it copes
  queueMode: Key('queueMode'), // 1 ⇒ this component is used as a queue (else the queue keys are inert)
  arrivalRate: Key('arrivalRate'), // offered ingress (producers), msg/s
  drainRate: Key('drainRate'), // how fast it is consumed, msg/s
  retention: Key('retention'), // how long an unconsumed message survives, s
  maxBacklog: Key('maxBacklog'), // bound on queued messages before it errors/drops
  backlog: Key('backlog'), // derived: net accumulation rate, msg/s (>0 ⇒ growing without bound)
  overflow: Key('overflow'), // derived: load offered beyond capacity, req/s (>0 ⇒ rejected/dropped/throttled)
  // demand-driven sizing (Fargate/ECS etc.): how many units the offered load needs, vs the account ceiling
  maxUnits: Key('maxUnits'), // ceiling on units/tasks (service or account quota)
  requiredUnits: Key('requiredUnits'), // derived: units/tasks needed to serve the offered load
  // the visible BASE cost rate (a config knob) — every priced component's cost relation multiplies it by
  // its own driver (requiredUnits / replicas / throughput / concurrency). The base is never a hidden literal.
  unitCost: Key('unitCost'),
  // data-transfer (egress) cost — the most-missed line on a real bill. A node sending `payloadBytes`
  // per request out of the cloud pays `egressUsdPerGb` per GB; `egressCost` is the resulting monthly $ (a
  // SEPARATE line from compute/storage `cost`, summed across the design).
  payloadBytes: Key('payloadBytes'), // response/message size sent per request, bytes
  egressUsdPerGb: Key('egressUsdPerGb'), // data-transfer price out of the boundary, USD/GB (0 = internal hop)
  egressCost: Key('egressCost'), // derived: monthly data-transfer cost, USD/month
  // UNIVERSAL TRAFFIC ORIGIN — the workload a node ORIGINATES itself (req/s it injects into its outgoing edges),
  // as opposed to the load it merely relays from upstream. This is the universal generalisation of a client's
  // throughput-as-workload: ANY node can be a traffic source (a DB-to-DB migration's source service, a
  // connected service that emits events, a cron worker) by declaring assumedRps > 0 — no `client.*` block
  // required. Default 0 everywhere ⇒ pure relays behave exactly as before. Node-LOCAL: a node's OWN origin
  // never flows across an edge as a value; it is FOLDED into the node's emitted throughput by the universal
  // wrapper (behaviors.ts `withOrigin`), so downstream sees it as ordinary inflow. See the "universal
  // traffic origins" and the flow-model comment on `throughput` above.
  assumedRps: Key('assumedRps'),
  // RETRY POLICY — the caller's per-attempt retry behaviour, as three node-local config
  // knobs on the CALLING node (client / origin service). They shape ONLY the DES: a retry loop is non-monotone
  // feedback (load ↑ → timeouts ↑ → load ↑), a "question about time", so the scalar pass never reads
  // them and `goodputRps`/`errorRate` stay `unknown` off the simulator (the tailLatency pattern). All default 0,
  // which is the pre-retry world bit-for-bit (no deadline ⇒ no reneging, no retries). Node-LOCAL: a policy is a
  // fact of THIS caller's code and rides on the traffic IT originates — it must never flow across an edge.
  timeoutMs: Key('timeoutMs'), // per-attempt deadline (ms); the caller abandons an attempt whose wait exceeds it. 0 ⇒ none
  retryCount: Key('retryCount'), // additional attempts after the first (0 ⇒ fail immediately on a timeout)
  retryBackoffMs: Key('retryBackoffMs'), // fixed delay before re-injecting an abandoned attempt (ms)
  // DES-FED OUTCOME keys — SLO-only, answered ONLY by the simulator (like tailLatency).
  // They carry NO forward value: on the scalar pass they read `unknown` and point at simulate. A throughput SLO
  // on a retrying path is judged against GOODPUT (successful work), not raw completions.
  goodputRps: Key('goodputRps'), // successful completions/s past retries — the useful work the design delivers
  errorRate: Key('errorRate'), // failures/s (retries exhausted) — the honest error metric, absent before
} as const;

export const registry: Registry = registryOf([
  // bottlenecked DOWN a path (series 'min': served = min(capacity, offered)), but offered loads SUM at a
  // FAN-IN (two producers into one node add up — fanIn 'sum'). Carries across an async edge: the MESSAGE
  // RATE still flows to the consumer (a queue/worker behind an async hop must serve the producer's rate or
  // back up) — async decouples the caller's WAIT (latency), not the offered load. A node's throughput is SEEDED
  // either by a client (a source whose throughput config is its workload) or by ANY node that ORIGINATES traffic:
  // when a node has NO inbound wire and declares `assumedRps` > 0, `instantiate` makes its throughput emit
  // `min(capacity, assumedRps)` (universal traffic origins — a DB-to-DB migration needs no client). A RELAY keeps
  // throughput = capacity, so cost / queue / the search's ρ-headroom keep reading a true ceiling.
  // `flow: true` marks throughput as THE quantity port transforms act on: a port's
  // ratio/batch/cap/window/prob shapes the throughput it emits/intakes at the edge-contribution seam. It is the
  // ONLY flow-flagged key — every other quantity (latency, cost, availability…) is untouched by transforms.
  { key: keys.throughput, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'min', fanIn: 'sum', onAsyncEdge: 'carry', flow: true }, kind: 'derived' },
  // accumulates on the synchronous path; an async hop cuts the caller's wait
  { key: keys.latency, unit: Unit('ms'), band: 'minTargetMax', aggregate: { series: 'sum', onAsyncEdge: 'cut' }, kind: 'derived' },
  // the p99 tail of latency: SLO-only (no forward value — verified against the DES tail). Node-local so it never
  // flows; its band is a `percentiles` target. Lets a design carry a mean AND a tail latency SLO simultaneously.
  { key: keys.tailLatency, unit: Unit('ms'), band: 'percentiles', aggregate: { series: 'max', onAsyncEdge: 'carry', local: true }, kind: 'derived' },
  // per-node downstream-composition knob for response latency (0 sequential / 1 parallel / 2 fastest); node-local
  // input read by the responseLatency projector. Inert in the cell-network — it selects a fold, not a value.
  { key: keys.latencyComposition, unit: Unit('1'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry', local: true }, kind: 'input' },
  // compounds multiplicatively: every dependency must be up
  { key: keys.availability, unit: Unit('ratio'), band: 'minTargetMax', aggregate: { series: 'product', onAsyncEdge: 'carry' }, kind: 'derived' },
  // sums across the whole design, sync or async
  { key: keys.cost, unit: Unit('USD/month'), band: 'minTargetMax', aggregate: { series: 'sum', onAsyncEdge: 'carry' }, kind: 'derived' },
  // data durability compounds like availability: data is only as safe as every store it must survive
  { key: keys.durability, unit: Unit('ratio'), band: 'minTargetMax', aggregate: { series: 'product', onAsyncEdge: 'carry' }, kind: 'derived' },
  // intrinsic knobs (inputs)
  { key: keys.concurrency, unit: Unit('1'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry' }, kind: 'input' },
  { key: keys.perRequestDuration, unit: Unit('ms'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry' }, kind: 'input' },
  // DOCUMENTED-LIMITS keys (task-72). All node-LOCAL: an account/service ceiling and the demand it caps are
  // about THIS node — they must never flow across edges (a downstream store has no "account concurrency").
  //  accountConcurrency: the Region-wide Lambda concurrency quota (config, ceiling).
  { key: keys.accountConcurrency, unit: Unit('1'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry', local: true }, kind: 'input' },
  //  concurrencyNeeded: concurrency the offered load implies (Little's law) — node-local derived.
  { key: keys.concurrencyNeeded, unit: Unit('1'), band: 'minTargetMax', aggregate: { series: 'max', onAsyncEdge: 'carry', local: true }, kind: 'derived' },
  //  concurrencyOverflow: max(0, needed − ceiling) — the throttled excess; banded ≤ 0 ⇒ within the quota.
  { key: keys.concurrencyOverflow, unit: Unit('1'), band: 'minTargetMax', aggregate: { series: 'max', onAsyncEdge: 'carry', local: true }, kind: 'derived' },
  //  connection-pool keys (see the key comments above): budget + held-time are inputs; needed/overflow derived.
  { key: keys.connectionPool, unit: Unit('1'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry', local: true }, kind: 'input' },
  { key: keys.connectionHeldMs, unit: Unit('ms'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry', local: true }, kind: 'input' },
  { key: keys.poolConnectionsNeeded, unit: Unit('1'), band: 'minTargetMax', aggregate: { series: 'max', onAsyncEdge: 'carry', local: true }, kind: 'derived' },
  { key: keys.poolOverflow, unit: Unit('1'), band: 'minTargetMax', aggregate: { series: 'max', onAsyncEdge: 'carry', local: true }, kind: 'derived' },
  // CPU cores + per-request CPU time: node-LOCAL inputs forming the CPU M/M/c station (see the key comments). Local
  // like the connection-pool primitive — a queueing-station resource that is a fact about THIS node and must never
  // flow across an edge (a downstream store has no cores). Point-band inputs; the station arithmetic (min-binding)
  // lives in graph-read's shared `queueStation`, so the analytic twin and the DES read one definition and cannot drift.
  { key: keys.cpuCores, unit: Unit('1'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry', local: true }, kind: 'input' },
  { key: keys.cpuTimePerRequestMs, unit: Unit('ms'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry', local: true }, kind: 'input' },
  // station wait deadline (see the key comment): a node-LOCAL config, ms. It carries no forward algebra — it is a
  // DES-only knob (the projector reads it onto the station); a point band ⇒ it never flows across edges.
  { key: keys.maxQueueWaitMs, unit: Unit('ms'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry', local: true }, kind: 'input' },
  { key: keys.vcpus, unit: Unit('1'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry', local: true }, kind: 'input' },
  //  maxItemBytes: documented item/message payload ceiling (config); payloadOverflow: excess over it (node-local).
  { key: keys.maxItemBytes, unit: Unit('byte'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry', local: true }, kind: 'input' },
  { key: keys.payloadOverflow, unit: Unit('byte'), band: 'minTargetMax', aggregate: { series: 'max', onAsyncEdge: 'carry', local: true }, kind: 'derived' },
  { key: keys.replicas, unit: Unit('1'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry' }, kind: 'input' }, // horizontal-scale knob
  // deployment mode (0 single-AZ / 1 Multi-AZ / 2 multi-Region): a node-local knob the availability relation reads
  { key: keys.deploymentMode, unit: Unit('1'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry', local: true }, kind: 'input' },
  // queue-behaviour keys: node-local inputs + one derived backlog-growth rate (banded ≤ 0 ⇒ stable)
  { key: keys.queueMode, unit: Unit('1'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry' }, kind: 'input' },
  { key: keys.arrivalRate, unit: Unit('msg/s'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry' }, kind: 'input' },
  { key: keys.drainRate, unit: Unit('msg/s'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry' }, kind: 'input' },
  { key: keys.retention, unit: Unit('s'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry' }, kind: 'input' },
  { key: keys.maxBacklog, unit: Unit('msg'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry' }, kind: 'input' },
  { key: keys.backlog, unit: Unit('msg/s'), band: 'minTargetMax', aggregate: { series: 'sum', onAsyncEdge: 'carry' }, kind: 'derived' },
  // overflow is node-local (offered − capacity); 'max' so a node reports the worst rejection at-or-upstream, never summing
  { key: keys.overflow, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'max', onAsyncEdge: 'carry' }, kind: 'derived' },
  { key: keys.maxUnits, unit: Unit('1'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry' }, kind: 'input' },
  // requiredUnits is NODE-LOCAL sizing ('local'): how many units/tasks THIS node needs to serve its own
  // offered load. It must never flow across edges — a downstream store (S3, a DB) has no "tasks" and must
  // not inherit an upstream fleet's figure. `local` makes a node with no sizing relation report no value.
  { key: keys.requiredUnits, unit: Unit('1'), band: 'minTargetMax', aggregate: { series: 'max', onAsyncEdge: 'carry', local: true }, kind: 'derived' },
  // base cost rate: a node-local config knob (read by the node's own cost relation; never flows across edges)
  { key: keys.unitCost, unit: Unit('USD/month'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry', local: true }, kind: 'input' },
  // data-transfer: payload size + egress price are node-LOCAL knobs; egressCost SUMS across the design (like cost)
  { key: keys.payloadBytes, unit: Unit('byte'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry', local: true }, kind: 'input' },
  { key: keys.egressUsdPerGb, unit: Unit('USD/GB'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry', local: true }, kind: 'input' },
  { key: keys.egressCost, unit: Unit('USD/month'), band: 'minTargetMax', aggregate: { series: 'sum', onAsyncEdge: 'carry' }, kind: 'derived' },
  // assumedRps: the workload a node ORIGINATES. Node-LOCAL (it is this node's own knob — a downstream store has no
  // "origin"; it must never flow across an edge as a value). It is a point-band INPUT; the universal wrapper folds
  // it into the node's emitted `throughput` (which DOES flow), so the origin propagates downstream as ordinary load.
  { key: keys.assumedRps, unit: Unit('req/s'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry', local: true }, kind: 'input' },
  // RETRY-POLICY inputs. Node-LOCAL point knobs on the CALLING node; they never flow and
  // carry no algebra of their own — the DES projector reads them off the caller and attaches an attemptPolicy to
  // the traffic it originates. Default 0 ⇒ pre-retry behaviour, bit-for-bit.
  { key: keys.timeoutMs, unit: Unit('ms'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry', local: true }, kind: 'input' },
  { key: keys.retryCount, unit: Unit('1'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry', local: true }, kind: 'input' },
  { key: keys.retryBackoffMs, unit: Unit('ms'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry', local: true }, kind: 'input' },
  // DES-FED OUTCOME keys: SLO-only, derived + node-LOCAL, with NO forward relation ⇒ the scalar pass computes no
  // value and the band reads `unknown` (pointing at simulate — the exact tailLatency contract). The DES answers
  // them (checkGoodputBands). goodputRps is a FLOOR SLO (min), errorRate a CEILING SLO (max), both minTargetMax.
  { key: keys.goodputRps, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'max', onAsyncEdge: 'carry', local: true }, kind: 'derived' },
  { key: keys.errorRate, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'max', onAsyncEdge: 'carry', local: true }, kind: 'derived' },
] satisfies KeyDef[]);

// ─── THE ROLE AXIS ─────────────────────────────────────────────────────────────────
// One-form-per-kind applied to node quantities: every registry key carries a ROLE — the shared axis on which a
// quantity's KIND is classified, so surfaces render BY it and the difference that matters (a belief about the
// world vs a ceiling the design commits to) is a first-class value, never buried in naming/presentation. It is
// CONTENT data, NOT an engine `KeyDef` field: the engine stays domain-agnostic (it knows only unit/band/aggregate/
// kind); the meta-model classification lives here, keyed by key id. The one mechanical consumer today: a scenario
// (a named world) may override ONLY role=`fact-assumption` keys (the assumption space) — the role draws that
// boundary so it can never drift.
//
//   fact-assumption — a belief about the outside world the design does not control (offered load, a service-time
//                     estimate, a caller's retry policy, a workload's payload size, a market price). The design's
//                     numbers REST on it; a different world changes it. These ARE the assumption space.
//   resource-limit  — a ceiling / sizing choice / mode / documented quota / fixed rate THIS design commits to
//                     (concurrency, replicas, maxUnits, a payload ceiling, a deployment mode). Changing it is a
//                     different DESIGN, not a different WORLD.
//   computed        — a value the engine DERIVES and you read back (throughput served, latency, cost, overflow).
//   promise-target  — a key that carries NO forward value and exists only to be JUDGED against a declared SLO,
//                     answered by the DES (tailLatency, goodputRps, errorRate) — the doc's "promise" role.
//
// The partition is mechanical and cross-checked against the engine `kind` (roles.test.ts): a `kind:'input'` key is
// fact-assumption | resource-limit; a `kind:'derived'` key is computed | promise-target. So classification can
// never contradict the input/derived split the network already enforces.
export type Role = 'fact-assumption' | 'resource-limit' | 'computed' | 'promise-target';

/** Which END of a fact-assumption is UNFAVOURABLE (doc §5.2) — the direction a "pessimistic" world pushes it. Set
 *  ONLY where the direction is honestly unambiguous; absent = undefined = no guess (a world only diverges on an
 *  assumption whose polarity is known). Used by the auto-created trio's range-end picking (a later round); declared
 *  now as reviewable data so the boundary is drawn mechanically, never invented per case. */
export type Polarity = 'higher-is-worse' | 'lower-is-worse';

/** A key's role classification (doc §2) — its role plus, for a fact-assumption whose unfavourable direction is
 *  honestly known, its polarity. Content metadata keyed by key id; the engine never sees it. */
export interface KeyRole {
  readonly role: Role;
  readonly polarity?: Polarity;
}

/**
 * The role of every registry key, keyed by key id. EXHAUSTIVE — roles.test.ts asserts
 * every key in `keys` has an entry, no entry is stale, and the role↔`kind` partition holds. Polarity is present
 * ONLY on the fact-assumptions whose unfavourable direction is unambiguous (offered load / service time / payload
 * size all higher-is-worse); a caller's timeout/retry knobs have a genuinely two-sided cost, so polarity is
 * DELIBERATELY absent there (no guess).
 */
export const roles: Readonly<Record<string, KeyRole>> = {
  // fact-assumption — the assumption space (the only scenario-overridable role)
  assumedRps: { role: 'fact-assumption', polarity: 'higher-is-worse' }, // offered load
  arrivalRate: { role: 'fact-assumption', polarity: 'higher-is-worse' }, // a queue's offered ingress (assumedRps for a queue)
  perRequestDuration: { role: 'fact-assumption', polarity: 'higher-is-worse' }, // a measured/assumed service time
  cpuTimePerRequestMs: { role: 'fact-assumption', polarity: 'higher-is-worse' }, // per-request CPU time — a measured/assumed service time (mirrors perRequestDuration)
  connectionHeldMs: { role: 'fact-assumption', polarity: 'higher-is-worse' }, // ~ the backend's per-query time (a service-time belief)
  payloadBytes: { role: 'fact-assumption', polarity: 'higher-is-worse' }, // the real item/message size (bigger = more egress / closer to a ceiling)
  timeoutMs: { role: 'fact-assumption' }, // a caller assumption; both ends carry cost (shorter → premature abandon, longer → held resources) ⇒ no polarity
  retryCount: { role: 'fact-assumption' }, // more attempts = a retry storm OR more resilience ⇒ two-sided ⇒ no polarity
  retryBackoffMs: { role: 'fact-assumption' }, // two-sided (longer delay reduces storms but lengthens recovery) ⇒ no polarity
  // resource-limit — a ceiling / sizing / mode / quota / price this DESIGN commits to (a design variant, not a world)
  concurrency: { role: 'resource-limit' },
  cpuCores: { role: 'resource-limit' }, // the CPU width (hardware threads / vCPUs) this design commits to — a ceiling, like concurrency
  accountConcurrency: { role: 'resource-limit' },
  connectionPool: { role: 'resource-limit' },
  maxQueueWaitMs: { role: 'resource-limit' },
  vcpus: { role: 'resource-limit' },
  maxItemBytes: { role: 'resource-limit' },
  replicas: { role: 'resource-limit' },
  deploymentMode: { role: 'resource-limit' },
  queueMode: { role: 'resource-limit' },
  drainRate: { role: 'resource-limit' },
  retention: { role: 'resource-limit' },
  maxBacklog: { role: 'resource-limit' },
  maxUnits: { role: 'resource-limit' },
  latencyComposition: { role: 'resource-limit' }, // sequential/parallel/fastest — a design choice
  unitCost: { role: 'resource-limit' }, // a documented rate the design's cost model commits to
  egressUsdPerGb: { role: 'resource-limit' }, // egress price (a documented rate)
  // computed — derived and read back
  throughput: { role: 'computed' }, // served flow
  latency: { role: 'computed' },
  availability: { role: 'computed' },
  cost: { role: 'computed' },
  durability: { role: 'computed' },
  concurrencyNeeded: { role: 'computed' },
  concurrencyOverflow: { role: 'computed' },
  poolConnectionsNeeded: { role: 'computed' },
  poolOverflow: { role: 'computed' },
  payloadOverflow: { role: 'computed' },
  backlog: { role: 'computed' },
  overflow: { role: 'computed' },
  requiredUnits: { role: 'computed' },
  egressCost: { role: 'computed' },
  // promise-target — no forward value; verified against a declared SLO by the DES (the doc's "promise" role)
  tailLatency: { role: 'promise-target' },
  goodputRps: { role: 'promise-target' },
  errorRate: { role: 'promise-target' },
};

/** The role of a key (doc §2), or undefined for an unclassified key (roles.test.ts proves none is unclassified). */
export function roleOf(key: Key): Role | undefined {
  return roles[String(key)]?.role;
}

/** Whether a key is a `fact-assumption` — the ONE mechanical gate the assumption model reads: a scenario (named
 *  world) may override this key iff true (doc §2, §4.1). A limit / computed / promise key is NOT a world belief. */
export function isFactAssumption(key: string): boolean {
  return roles[key]?.role === 'fact-assumption';
}

/** The known unfavourable direction of a fact-assumption (doc §5.2), or undefined when it is not honestly known. */
export function polarityOf(key: Key): Polarity | undefined {
  return roles[String(key)]?.polarity;
}
