---
id: doc-8
title: 08 — Coverage Map (what the engine covers)
type: specification
created_date: '2026-06-29 07:20'
updated_date: '2026-07-04 00:00'
tags:
  - design
  - engine
---
# 08 — Coverage Map: what SDA covers, and why

> Status: living. The honest scope of the tool — which system-design elements/pitfalls SDA addresses,
> by which mechanism, and what is deliberately out of scope. Pairs with doc-4 (Engine Calculus) and
> doc-2 (Property System). "Covered" claims are backed by tests/real cases, cited inline.

## 0. The feasibility rule (the one test for "can we cover it")

An element is coverable **iff** it is expressible as one of five things; otherwise it is out of scope
(covering it would put domain knowledge in the engine or make the tool guess):

1. **A number with a path algebra** (`sum / min / max / product`) → the numeric engine (JS hot path + MiniZinc).
2. **A question about time** (tails, transients, queueing, feedback) → DES.
3. **A relational legality / compatibility fact** → DataScript.
4. **A combinatorial enumeration** (which whole structures are valid) → clingo/ASP.
5. **An optimization** (best / minimal-change config) → MiniZinc.

Everything we cover maps to one of these. If it doesn't, it is §4 (out of scope).

## 1. Covered — the quantitative envelope (the core)

| Element / pitfall it kills | Mechanism (algebra) | Status | Evidence |
|---|---|---|---|
| **Throughput + bottleneck** ("chain runs at min, not the fastest hop") | numeric, `min` + cause-chain | ✅ | every e2e; Voice (Lambda 10), Fargate (1 task), Postgres (max_conn) |
| **Latency, mean** | numeric, `sum` | ✅ | content e2e |
| **Latency, true tail (p50/p99)** ("means hide the tail") | **DES** percentiles | ✅ | `des.test`, `tail.e2e`, Voice |
| **Availability** ("serial deps multiply DOWN; SPOF") | numeric, `product`; per-node `deploymentMode` (0 single-AZ / 1 Multi-AZ / 2 multi-Region) selects the PUBLISHED AWS SLA (RDS 99.5→99.95, EC2 99.5→99.99) | ✅ | Fargate single-task 98.8%; `sensitivity-matrix` (deploymentMode→availability `+`) |
| **Durability** (data "nines") | numeric, `product` | ✅ | `coverage.e2e` (11 nines vs 5 nines) |
| **Cost (flat + pay-per-use + billed redundancy)** | numeric, `sum` + relation `rate × driver`; `deploymentMode` also carries a piecewise COST multiplier — Multi-AZ ×2 (sourced: RDS standby billed double), multi-region ≈ ×2.3 (est.) — folded onto RDS/Aurora only, NOT inherently-replicated DynamoDB/S3 (redundancy is not free, task-77) | ✅ | `coverage.e2e` pay-per-use; synthesize; `sensitivity-matrix` (deploymentMode→cost `+`) |
| **Capacity planning / Little's law** | numeric relation `concurrency / service-time` | ✅ | Lambda, Postgres, Fargate |
| **Horizontal scaling** (capacity = per-replica × replicas) | numeric relation | ✅ | `coverage.e2e` scaling |
| **Connection limits** (Postgres `max_connections`, …) | numeric (concurrency-bound capacity) | ✅ | common stack |
| **Connection POOLING proxy** (RDS Proxy: pool budget, pass-through capacity, per-vCPU price) | numeric (Little's law on the pool: `needed = inflow × heldMs`, banded; capacity = `pool/held`) | ✅ | `rds-proxy.e2e` |
| **SLO verification + cause-chain + remediation** | verdicts (structural attribution) | ✅ | `explain.test`; all cases |
| **Optimize** (cheapest config meeting SLOs) | MiniZinc + COIN-BC | ✅ | `search.test`, `optimize.e2e` |
| **Repair** (minimal change to make it legal) | MiniZinc (L1 from current) | ✅ | `facade.test` repair |
| **UNSAT explained** (which SLO can't be met, by how much) | MiniZinc soft constraints | ✅ | `search.test` relaxed |
| **Synthesize** (generate + rank candidate architectures) | clingo → evaluate → rank | ✅ | `synthesize.e2e` |
| **Cardinality / placement rules** (co-presence / conflicts) | clingo `requires` / `conflicts` | ✅ | `clingo.test` |
| **Legality** (protocol compat, direction) | DataScript + protocol catalog | ✅ | `legality.test`, `protocols.e2e` |
| **Sync vs async coupling / backpressure** | edge semantics + least-fixpoint | ✅ | `solve.test`, aggregation `onAsyncEdge` |
| **Cold starts** (bimodal service, tail penalty) | DES `coldStart` distribution | ✅ | `coldstart.test` |
| **Retry amplification / goodput collapse** ("past saturation retries LOWER useful work") | **DES** reneging + re-injection + outcome accounting (`goodputRps` / `errorRate` / `amplification`), fed to verdicts; caller-side retry policy as DATA (`timeoutMs` / `retryCount` / `retryBackoffMs`) | ✅ | `retry.test` (Erlang-A differential + the hump property + no-policy ≡ today); `retry-feedback.e2e` (hump curve on a 3-tier chain; goodput-floor SLO `unknown`→sim) |
| **Qualitative GUARANTEES — consistency / ordering / delivery, per flow** ("stale read off a replica; order lost at a fan-out; SQS duplicates") | **categorical lattice** — a per-dimension ordered token set with a path MEET ("the weaker hop wins"), the categorical twin of the numeric algebra; verdict + provable root-cause hop + computed same-family swap remediation | ✅ | `lattice.test`, `propagate.test` (monotonicity + DataScript differential); `guarantees.e2e`, `guarantee-slo.e2e` (CQRS story + sqs→fifo remediation with ceiling + cost delta) |
| **Capacity envelope — the DEFAULT answer** ("how far can each origin be pushed before something breaks, and WHAT breaks first — with NO declared demand") | numeric INVERSION (free the demand key, maximise s.t. the SLOs = `optimize`) + a load sweep for breaking-order/joint/knee; the **DES CONFIRMS** the scalar edge is real dynamics-wise | ✅ | `envelope.test` (analytic anchors + brute-force differential); **`envelope-des.e2e`** (DES bounded below the edge, saturated just above — two chains + the CQRS write store) |
| **Named worlds + the derived trio** ("your numbers REST on assumptions; a pessimistic world may break them") | scenario overrides on role=`fact-assumption` keys ONLY (the role axis draws the boundary); base + auto-derived pessimistic/real; each world re-evaluated + compared in one matrix | ✅ | `scenario.test`, `derived-scenarios.test`, web `worlds.e2e` |
| **Assumption uncertainty** ("a soft input is a RANGE, not a point; a conclusion is a DISTRIBUTION") | seeded Monte-Carlo over the assumptions register → percentiles + histogram + SLO-confidence + a tornado; a REAL-TIME **ambient** loop with a **WebGPU batch** backend (CPU fallback, CPU≡GPU differential-tested) | ✅ | `uncertainty.test`, `sweep.test`; `engine/solver-contract` GPU `differential.test` (fp32 tol) |
| **Per-node RESPONSE latency + true percentiles** ("a node's OWN response ≠ the end-to-end sojourn; a mean hides the tail") | DES **suffix bookkeeping** — every station reports its own response (its synchronous downstream subtree; an async hop cuts it) from ONE run, p50/p95/p99 per node | ✅ | `response-latency.e2e`, engine/sim `response.test` |
| **Flow-scoped LAG SLOs** (CDC / replication: "a change reaches the destination within X, INCLUDING async queue waits") | DES per-pair lag reservoir (async-INCLUSIVE, unlike the response cut), fed to a lag verdict | ✅ | `lag-slo.e2e`, engine/sim `lag.test` |
| **Request CLASSES — multi-commodity flows** ("orders and reports share a node but have different SLOs / paths") | per-class flow algebra: load composes PER CLASS along its own wires, capacity is SHARED + contended at the node (proportional split only when saturated), latency/lag/guarantees read per class | ✅ (**data + engine**; per-class DES = R3, frozen) | content `request-class` + `app/mcp/request-classes.test`; the oracle CLASS axis |
| **Universal traffic ORIGINS** (`assumedRps`: ANY node originates load — a migration source, a cron worker — not only a `client.*`) | node-local `assumedRps` folded into the node's emitted `throughput` by the universal wrapper (`withOrigin`); a `fact-assumption` (higher-is-worse) | ✅ | `origin.e2e`, `origin-compat.e2e`, `roles.test` (renamed from `originRps` — one honest name) |
| **Component semantics/limits as data** (anti cargo-cult) | content catalogs | ✅ | AWS / OSS / Voice / Fargate catalogs |
| **Alternatives over first-design bias** | synthesize | ✅ | `synthesize.e2e` |
| **Don't lie**: assumptions ≠ derived; `unknown`; sourced vs estimate | engine + content discipline | ✅ | `unknown` for tails w/o DES; marked content |

### 1a. Documented real-world LIMITS (task-72) — the outage-causing ceilings, as sourced DATA

The account/service quotas a diagram tool never sees, modelled as manifest config + relations + bands, each
with the OFFICIAL AWS docs URL cited at the manifest. All are node-LOCAL (a ceiling is about that node) and
verified on the numeric hot path. Evidence: `limits.e2e.test.ts` (fires the violation on a breaching design,
stays silent within quota); `integrity.test.ts` guards the new registry keys + manifest hygiene.

| Limit (component) | Value + source | How modelled | Status |
|---|---|---|---|
| **Lambda account concurrency** (`compute.faas`, `compute.lambda`) | 1,000 concurrent executions / Region, default, **soft** — [gettingstarted-limits](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html), [lambda-concurrency](https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html) | config `accountConcurrency`=1000 + derived `concurrencyNeeded` = `inflow(throughput)×service-time` (Little's law) + `concurrencyOverflow` = `max(0, needed − quota)`, banded ≤ 0 (violation past quota = the 429/throttle) | ✅ |
| **API Gateway account throttle** (`gateway.api`) | 10,000 rps steady-state / account / Region + 5,000 burst bucket, **soft** (burst set by service) — [apigateway/limits](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html) | `throughput`=10000 ceiling; the universal `overflow` = `max(0, offered − 10000)` flags the rejected excess = the **429 Too Many Requests** | ✅ |
| **DynamoDB item size** (`db.dynamodb`) | 400 KB (409,600 B) max item — [ServiceQuotas](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html) | config `maxItemBytes`=409600 + `payloadOverflow` = `max(0, payloadBytes − maxItemBytes)`, banded ≤ 0. Informational: 0 by default, fires only when the architect sets the real item size | ✅ |
| **SQS message size** (`queue.sqs`, `queue.sqs.fifo`) | 256 KB (262,144 B) max message — [quotas-messages](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html) | same `maxItemBytes`/`payloadOverflow` pattern as DynamoDB (informational unless payload set) | ✅ |
| **SQS FIFO throughput** (`queue.sqs.fifo`) | 300 tps/API action (3,000 batched) — [quotas-fifo](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-fifo.html) | `throughput`=300 ceiling; the universal `overflow` flags load past it (already modelled) | ✅ |
| **RDS Proxy pool + price + borrow timeout** (`proxy.rds`) | overhead 1–3 ms/query — [rds-proxy UserGuide](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html); pool = `MaxConnectionsPercent` × target `max_connections`, `ConnectionBorrowTimeout` default 120 s — [rds-proxy-connections](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-connections.html); $0.015 / target vCPU·h, min 2 vCPU — [rds/proxy/pricing](https://aws.amazon.com/rds/proxy/pricing/) | config `connectionPool` + `connectionHeldMs` (≈ backend query ms); derived `poolConnectionsNeeded` = `inflow×held` (Little), `poolOverflow` banded ≤ 0; **capacity emerges**: `throughput = pool/held`; `cost = vcpus × $10.95/mo`. Deliberately NOT the `concurrency` key (the SCALAR pass keeps the proxy a thin fixed-latency hop, no double-counting the DB's service time). The DES models the pool AS an M/M/c station (c = pool, μ = 1/held ⇒ same `pool/held` capacity) with a `maxQueueWaitMs` = 120 s borrow timeout: past-timeout waits renege (proxy `dropped` + `errorRate`) — see the borrow-timeout "now covered" note below | ✅ |

Honestly **NOT covered** (recorded here rather than faked — "the tool must not lie"):

- **DynamoDB per-PARTITION throughput skew** (3,000 RCU / 1,000 WCU **per partition** — [ServiceQuotas](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html), [bp-partition-key-design](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html)). The manifest has **no partition concept**; a hot-partition ceiling depends on key distribution, not a single node number. Only the **table-level** on-demand throughput + the item-size limit are modelled. Would need a partition/shard modelling primitive (§3-style extension), not a per-case branch.
- **Lambda BURST concurrency ramp** (+500 concurrency / 10 s, or +5,000 rps / 10 s — [scaling-behavior](https://docs.aws.amazon.com/lambda/latest/dg/scaling-behavior.html)) and the **API Gateway 5,000 burst bucket**. These are **transient ramp/token-bucket** behaviours, not steady-state ceilings. The numeric hot path is steady-state (§0.1); a ramp is a **time question → DES** (§0.2). Modelled honestly as the steady-state 429 breach; the transient absorption is deferred to a DES scenario, not guessed on the forward pass.
- **SNS publish limits** (e.g. 30,000 msg/s per account in us-east-1, region-varying — [sns endpoints & quotas](https://docs.aws.amazon.com/general/latest/gr/sns.html)). There is **no SNS component** in the seed content, and task-72 is data-only (no new components). Recorded here so the omission is explicit; a future SNS manifest carries the same `throughput`-ceiling + `overflow` pattern.
- **RDS Proxy connection PINNING** (session state — prepared statements, temp tables — pins a client to a dedicated backend connection, degrading multiplexing — [rds-proxy-pinning](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html)). Workload-dependent (depends on the SQL the app emits); a pinning ratio would be an invented number. The pool math models the UNPINNED ideal; heavy pinning in practice shrinks the effective pool.
- ~~**RDS Proxy borrow-timeout reneging**~~ — **NOW COVERED** (task-77). The proxy's `ConnectionBorrowTimeout` (default 120 s — [rds-proxy-connections](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-connections.html), CreateDBProxy API) is wired onto the DES reneging primitive as a GENERIC STATION WAIT DEADLINE (`maxQueueWaitMs`): the proxy's connection pool projects to an M/M/c station (c = `connectionPool`, μ = 1/`connectionHeldMs`, so its DES capacity `pool/held` matches the scalar `throughput` — the two agree), and a borrow that WAITS past the deadline renegess — a station-side FAILURE (proxy `dropped` + system `errorRate`). Pool pressure now surfaces as a simulated timeout wave, not only the scalar `poolOverflow` violation; both tell the same story at their own time-scale. Evidence: `rds-proxy.e2e` (saturated pool → proxy drops > 0 / errorRate > 0; within pool → zero drops; scalar `poolOverflow` unchanged) + `engine/sim retry.test` (station-deadline behaviour, absent-field ≡ today property, composition with a caller retry policy). The `maxQueueWaitMs` key is deliberately generic — any resource-waiting component (a pool, a load-shedder) may declare one; the engine stays domain-agnostic (it is pure queueing vocabulary).
- **RDS Proxy failover acceleration** (client recovery up to 79% faster on Aurora MySQL, 32% on RDS MySQL — [AWS blog](https://aws.amazon.com/blogs/database/improving-application-availability-with-amazon-rds-proxy/)). A recovery-TIME (RTO) property; folding it into the steady-state availability ratio would be an invented number. Recorded qualitatively; the reliability tool reasons in deployment tiers.

### 1b. Flow transforms — the R3 catalog transform audit (task-74)

Flow transforms (doc: flow-transformations) let a port shape its traffic (`ratio`/`batch`/`cap`/`window`/`prob`)
instead of relaying 1:1. R3 swept **every** component type in every catalog asking one question: *is a
non-identity transform an intrinsic COMPONENT fact?* The owner's ruling sets the bar — fan-outs and log ratios
are facts of the **architect's application**, so they belong to the per-instance knob, **not** a catalog default;
a manifest default is warranted only for a documented or honestly-estimable **component** fact. The default set
stays almost entirely `identity` (today's behaviour, bit for bit); the single exception is the CDN, where
identity is a systematic lie. Every default is visible in `describe_component` and the R2 edge pills (with
provenance) and is overridable per-instance / per-wire.

| Type | Verdict | Source / rationale |
|---|---|---|
| **cdn.cloudfront** | **`ratio(0.1)` default (est.)** on the OUT port | A CDN exists precisely so the origin does **not** see 100% of traffic; identity would size the origin for the full client rate — a systematic lie. `ratio(0.1)` ≈ a 90% cache-hit rate, a credible typical for mostly-static content (~85–95%; AWS recommends ≥80%, ≥90% for cost). **Est.**, not truth — real hit rate is workload/cache-key-dependent; overridable per instance/wire (set `ratio(1)` for an all-dynamic distribution, e.g. a streaming Function URL). [cache-hit-ratio (AWS)](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cache-hit-ratio.html) |
| **cache.redis** | **identity** (no transform) — cache-aside miss ratio belongs on the **service→db wire** | Cache-aside `E[flow] = miss·db_reads` is a per-DESIGN fact (workload + cache size), not a fact of Redis. In this catalog a service has SEPARATE `cache` and `db` out ports, so the cache does not sit between service and DB — a transform on redis's port cannot express cache-aside. **Recommended pattern** (expressible today, task-75): put `ratio(est. miss)` on the service→DB wire (e.g. `ratio(0.2)` for an 80%-hit cache) so the DB tier is sized for the real miss load. Documented in the manifest comment; resurrects parked task-60 as addressed-by-pattern. |
| **queue.sqs / queue.sqs.fifo** | identity; **batch-ceiling hint** in the manifest comment | `ReceiveMessage` returns **≤10** messages/call — a documented ceiling. A batching consumer collapses ≤10:1, modelled by a per-instance `batch(≤10)` on the in-port. No default: the real batch size is the app's choice. [API_ReceiveMessage](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html) |
| **stream.kafka** | identity; **batch-ceiling hint** in the manifest comment | Consumer default `max.poll.records` = **500** — a documented (tunable) default. A batching consumer collapses ≤500:1, modelled by a per-instance `batch(≤500)`. No default: `max.poll.records` is a client config. [consumerconfigs](https://kafka.apache.org/documentation/#consumerconfigs_max.poll.records) |
| **queue.rabbitmq / queue.nats** | identity | Consumer prefetch/batch is a client config choice, not a documented fixed service ceiling — a workload fact, so no default and no hint. |
| **compute.\*** (faas, vm, service, replicated, fargate, cloudrun, k8s, asg, serverless, lambda, lambda-voice) | identity | Fan-out / amplification (1 request → N downstream calls) is a fact of the **app's** call graph, not the compute type. Owner's ruling: the architect's per-instance/per-wire knob owns it. |
| **db.\*** (sql, cheap, postgres, mysql, mongodb, dynamodb, aurora) | identity | A datastore relays its query load 1:1; any amplification (read fan-out, replication) is a design fact, not an intrinsic DB fact. |
| **lb.alb / apigw.rest / gateway.\*** (api, grpc, websocket, graphql) / **proxy.\*** (nginx, rds, haproxy) / **security.waf** | identity | A relay/gateway/proxy passes requests through 1:1 by definition (routing SPLITS are per-wire, task-75, not a component default). |
| **storage.object** | identity | An object store serves its request load 1:1. |
| **ai.\*** (transcribe, bedrock, polly) | identity | A model endpoint relays 1:1; call amplification is the caller's design. |
| **search.elasticsearch** | identity | Query load relays 1:1. |
| **client.\*** (source, web, browser) | identity | A client is a traffic ORIGIN (its `throughput`/`assumedRps` is the workload), not a transformer of an upstream stream. |

Non-goal reaffirmed: transforms are **declared, never guessed** — the engine never infers a ratio. The lone
non-identity default carries an explicit `est.` marker + a cited typical figure, exactly the honesty contract of
doc-8 §5.

### 1c. Guarantee propagation labeling (guarantee-propagation R2) — per-port consistency/ordering/delivery, sourced

Guarantees (doc: guarantee-propagation) are the categorical twin of the numeric envelope: each request FLOW
carries three qualitative promises — **consistency** (read freshness: `strong` → `eventual`), **ordering**
(`total` → `per-key` → `none`) and **delivery** (`clean` → `may-duplicate`) — each a tiny ordered token
lattice whose combining rule along a path is the MEET ("the weaker hop wins"). R2 swept **every** component
type in every catalog asking the certain/declared/refused question: *does official documentation support a
per-port token here?* A token is declared only where it does — **documented** (a primary-doc URL carried as
data) or an honest **est.**; anywhere it would be a guess, the port declares NOTHING = the lattice TOP (a
neutral pass-through). The engine sees only opaque tokens + the meet; the meaning is entirely content, so the
engine grep for any guarantee word stays zero. Every declared contribution rides the design-doc assumptions
register with its badge. Evidence: `guarantee-slo.e2e.test.ts` (labeling integrity: every declared token is a
valid lattice token, every documented claim has a source URL) + `guarantees.e2e.test.ts` (the CQRS story).

**Declared (a real component fact, sourced or est.):**

| Component(s) | Port | Declared token(s) | Provenance |
|---|---|---|---|
| `db.postgres`, `db.mysql`, `db.sql`, `db.cheap`, `db.aurora` (writer endpoint) | in | consistency: **strong** | est. — single-primary read-your-writes (behaviour, not a published SLA) |
| `db.postgres.replica` | in | consistency: **eventual** | documented — [RDS read replicas](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html) (replication lag) |
| async materialised-view projection edge | edge | consistency: **eventual** | est. — an async projection is eventual by construction (the CQRS root cause) |
| `db.dynamodb` | in | consistency: **eventual** | documented — [DynamoDB read consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html) (eventual by default; strong is opt-in per request) |
| `search.elasticsearch` | in | consistency: **eventual** | documented — near-real-time (searchable only after the next refresh) |
| `cache.redis`, `cache.memcached` | in (read) | consistency: **eventual** | est. — a cache with no declared invalidation serves stale after a write (doc §2) |
| `queue.sqs` (standard) | out | ordering: **none** · delivery: **may-duplicate** | documented — [SQS standard queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues.html) (best-effort order, at-least-once) |
| `queue.sqs.fifo` | out | ordering: **per-key** · delivery: **clean** | documented — [SQS FIFO queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues.html) (per message-group order, effective exactly-once) |
| `stream.kafka` | out | ordering: **per-key** · delivery: **may-duplicate** | documented — [Kafka semantics](https://kafka.apache.org/documentation/#semantics) (total order within a partition, at-least-once by default) |
| `queue.rabbitmq` | out | ordering: **per-key** · delivery: **may-duplicate** | documented — [RabbitMQ queues](https://www.rabbitmq.com/docs/queues) (per-queue FIFO for initial deliveries) + [reliability](https://www.rabbitmq.com/docs/reliability) (ack/redelivery ⇒ at-least-once) |
| `queue.nats` (core) | out | ordering: **per-key** | documented — [core NATS](https://docs.nats.io/nats-concepts/core-nats) (in order from a single publisher) |
| generic fan-out topic | out | ordering: **none** | est. — a broadcast fan-out preserves no cross-consumer order |

**Neutral pass-through (declares NOTHING — the lattice TOP, never an invented token):** all sync HTTP relays —
clients (`client.*`), gateways/proxies/LBs (`gateway.*`, `proxy.*`, `apigw.rest`, `lb.alb`, `security.waf`,
`cdn.cloudfront`), all sync compute (`compute.*`), and the managed AI endpoints (`ai.*`). They add no guarantee;
they only pass one through, so a request path is neither strengthened nor weakened crossing them.

**Refused (would be a guess — honestly left unlabelled, per the certain/declared/refused contract):**
`db.mongodb` (read consistency is per-read-preference config — primary strong, secondary eventual — genuinely
ambiguous as a component fact); `storage.object` (S3 is strong read-after-write for NEW objects but eventual for
overwrites/lists — the component-level token is ambiguous); the `db.postgres` OUT (queue-mode via SELECT … FOR
UPDATE SKIP LOCKED, which does not preserve order); core NATS **may-lose** / at-most-once (the v1 delivery
lattice models only DUPLICATION — NATS core does not duplicate, so it makes no delivery claim rather than a
fabricated `may-lose` the lattice cannot represent). A design requiring a guarantee on a refused component reads
an honest `unknown` naming what declaration would resolve it, never a fake green.

**Requirements + remediation (R2):** a per-FLOW requirement (`set_guarantee_slo{source, terminal, dimension,
atLeast}`, stored on the project document keyed by the flow's endpoints — a guarantee is a property of a PATH,
not a node, so it does not ride the numeric `Instance.bands`) is judged with the engine's `judgeGuarantee`
(ok / violation / unknown) and, on a violation, gets a COMPUTED remediation: the cheapest same-family component
swap that (a) drops into the node's exact wiring AND (b) declares a token satisfying the requirement — e.g.
`queue.sqs` → `queue.sqs.fifo`, reported with FIFO's documented 300 msg/s ceiling, whether the flow's served
load fits, and the monthly cost delta (all read off the model, never advised from air). When no swap exists it
says so honestly. Evidence: `guarantee-slo.e2e.test.ts` (the sqs→fifo remediation story).

### 1d. The assumption model — the envelope is the DEFAULT answer (assumption-model)

The reframing the tool was missing: a verified design is not "here is one number" but "here is the number, here is
the assumption it RESTS on, and here is what a different world does to it". Three mechanisms, all content over the
existing engine + solver contract, no domain leak:

- **The capacity envelope (the default answer, needs NO declared demand).** For each traffic ORIGIN, free its demand
  key (role=`fact-assumption`, so freeing it is the legal INVERSE of the no-cheating rule that FIXES demand) and
  MAXIMISE it subject to every SLO — `max-demand-s.t.-SLOs` IS the native `optimize`. That gives the per-origin
  `maxRps`; a generalised load sweep gives the BREAKING ORDER (the first band to flip), the JOINT edge (all origins
  scaled together) and the queueing KNEE (where ρ reaches the headroom line, below the capacity edge). Honest states,
  never a fabricated boundary: no origin ⇒ no envelope (say why); infeasible-at-zero ⇒ `maxRps 0` naming the always-
  broken band; a floor SLO ⇒ a feasible BAND `[minRps, maxRps]`, not `[0, maxRps]`. **The DES confirms the scalar
  edge is real dynamics-wise** (the boundary is not just an arithmetic artefact): at ~90 % of the edge the binding
  tier is comfortably utilised and nothing queues to infinity; just above it the tier pins at ρ≈1, its analytic
  sojourn diverges, and the simulated departure rate falls below the offered load. Evidence: `envelope.test.ts`
  (analytic anchors + a brute-force forward-sweep differential), **`envelope-des.e2e.test.ts`** (two analytic chains +
  the committed CQRS write store, seeded, honest tolerances).
- **Named worlds + the derived trio.** A *world* (scenario) overrides ONLY `fact-assumption` keys — the role axis
  (§1e-adjacent `roleOf`) draws that boundary MECHANICALLY so a world can never silently re-price a design choice.
  Alongside the base world, the tool auto-derives a **pessimistic** and a **real** world from the declared ranges +
  the envelope, and shows all three in one comparison matrix (cost / feasibility / peak ρ / worst violation), with the
  active lens always VISIBLE (never a silent mix). Evidence: `scenario.test.ts`, `derived-scenarios.test.ts`,
  `worlds.e2e` (web).
- **Assumption uncertainty (Monte Carlo).** Every soft input can be a declared RANGE (uniform or triangular, with
  provenance); a seeded run samples N scenarios through the contract's `EvaluateBatch`, rolling up percentiles +
  histogram + per-SLO CONFIDENCE + a tornado (sensitivity on the same sample). It runs as a **real-time ambient loop**
  (a CPU loop with a **WebGPU batch** backend where the device exists; the CPU≡GPU agreement is differential-tested
  within a declared fp32 tolerance). REFUSED by contract: an input without a range stays FIXED (no invented
  distribution), so the feature is silent and bit-identical to today when nothing is ranged. Evidence:
  `uncertainty.test.ts`, `sweep.test.ts`, `engine/solver-contract` GPU `differential.test.ts`.

The classification that makes all of the above safe is the **role axis** (content `roles`, keyed by registry key id):
every quantity is `fact-assumption` (a world belief — the ONLY scenario-overridable role) / `resource-limit` (a
ceiling this design commits to) / `computed` (a derived read-back) / `promise-target` (a DES-answered SLO key). It is
cross-checked against the engine's own input/derived split (`roles.test.ts`), so a derived key can never be
mislabelled overridable. The universal demand key was renamed `originRps` → **`assumedRps`** in the same pass (one
honest name; a `fact-assumption`, higher-is-worse).

### 1e. Latency semantics v2 — a node's own response, and async-inclusive lag (latency-semantics-v2)

The scalar `latency` sums the SYNCHRONOUS path up to a node (an async hop cuts the caller's wait). Two truths that
sum could not tell are now first-class, both answered by the SAME single DES run (no per-node model, no re-run):

- **Per-node RESPONSE percentiles.** Each station reports its own response — the time from a job's arrival to the
  completion of its synchronous downstream subtree, an async hop cutting it — as a SUFFIX of the journeys the run
  already produces. So one simulation yields every node's mean + p50/p95/p99 at once; the entry node's response IS the
  end-to-end sojourn. A per-node latency SLO is now judged against this RESPONSE (what a caller of that node actually
  waits for), not the cumulative path sum. Evidence: engine/sim `response.test`, `response-latency.e2e`.
- **Flow-scoped LAG SLOs.** For a declared (source → terminal) pair, lag is the wall-clock from a lineage's arrival at
  the source to its arrival at the terminal, **INCLUDING every async queue wait** on the way (the whole point of a
  CDC / replication SLO — the time a change spends queued). Bounded per-pair reservoir; declared pairs only, so an
  undeclared design pays nothing. Evidence: engine/sim `lag.test`, `lag-slo.e2e`.
- **Parallel response composition** is the node-local knob `latencyComposition` (0 sequential-SUM / 1 parallel-MAX /
  2 fastest-MIN) read by the `responseLatency` projector — so a service awaiting two dependencies in PARALLEL reads
  the critical path (max), not the pessimistic sum (this closes the §2 "parallel fan-out latency" gap).

### 1f. Request classes — multi-commodity flows, per class (request-classes)

Orders and reports share a node but carry different SLOs and take different paths. A **request class** is opaque data
(a class id + its origin nodes + the wires it may use); the engine gains a per-class INDEX on the flow cells and a
per-class walk — it still knows nothing of orders, reports or AWS (the meaning stays content). The algebra: load
composes PER CLASS along that class's wires; capacity is SHARED and contended at the node (the aggregate ρ drives the
class-blind per-hop wait; a finite capacity splits proportionally ONLY when saturated — unsaturated, the classes are
independent, which is where the search's headroom keeps every candidate); latency / lag / guarantees are read per
class along the class's path. Covered as **DATA** (class declarations, export schema) + **ENGINE** (the per-class
flow algebra + per-class verdicts + the oracle's per-class solver axis). The **per-class DES (R3) is FROZEN** — R1
keeps one service time per node, so the per-hop wait is class-blind; different work per class at a shared node (a
heavier report query) is a refinement to the M/M/c station, deferred (see §4). Evidence: content `request-class`,
`app/mcp/request-classes.test`.

## 2. Partial — covered by a mechanism, deeper content still to author

| Element | Mechanism | Note |
|---|---|---|
| **Circuit breaker / bulkhead / adaptive backoff** | DES (the same reneging/re-injection primitives + more policy DATA) | retry amplification + goodput collapse now COVERED (§1, `retry.test` / `retry-feedback.e2e`); these three richer policies are the declared next layer — "more data, not more engine" (doc: retry-feedback §6) |
| **Transients** (warm-up, ramp) | DES | warm-up exists; richer transient scenarios open |
| **SPOF as an explicit flag** | numeric (availability reveals the drag) | surfaced via availability; no dedicated structural SPOF detector |
| **Goodput collapse past saturation** | DES (feedback territory) | **NOW COVERED (§1, task-76).** The idealization named on 2026-07-02 (served rate FLAT at capacity past ρ≥1 — the honest UPPER bound) is closed: with a caller retry policy the DES computes the real HUMP — goodput falls BELOW capacity as retry work competes for the saturated tier (`retry-feedback.e2e`). The flat cap remains the correct reading only for a policy-FREE design (no retries declared). |
| **Guarantees as SYNTHESIS constraints** (reject a wiring whose propagated meet falls below the requirement) | clingo — the same enumerator that already rejects protocol-illegal completions | R2 ships the lattice + forward propagation the constraint READS + per-flow requirements + verdicts + remediations (§1c); wiring the requirement INTO the ASP model (so `synthesize`/`compare_options` return only guarantee-meeting designs) is R3+ scope (owner-confirmed). Forward evaluation + the computed same-family swap remediation cover the improve-loop today. |
| **Parallel fan-out latency (max-composition)** | per-node `latencyComposition` read by the `responseLatency` projector | **NOW COVERED (§1e).** A node awaiting several SYNCHRONOUS dependencies composes their responses by its declared mode — 0 sequential (SUM), 1 parallel (MAX, the critical path), 2 fastest (MIN, hedged). The old SUM is now only the default (sequential) reading; a parallel fan-out reads the critical path, not the pessimistic sum. Dean's tail-at-scale amplification remains a refinement (the DES already surfaces the true tail per node). The fan-out LOAD side is flow transforms + per-wire splits (task-75). |


### 2a. Holistic fidelity validation (2026-07-02 load-sweep campaign)

The scalar queueing model was swept 20%→150% of a 3-tier system's capacity and compared point-by-point
against independently computed Erlang C: **agreement within 0.1–0.6 ms at every load level** (flat to
ρ≈0.8, knee at 0.9, blow-up at 0.96, ∞ at ρ≥1); DES tails at ρ=0.9 match M/M/c theory (mean 21.5 vs
20+Wq≈21.5; p99 94.6 vs ≈92 from the exponential service tail). Bottleneck localization exact
(utilization 1.0 at the true binding tier); a single root cause is named by every downstream symptom's
remediation. The one collapse-past-saturation divergence this sweep flagged (served rate flat at capacity,
no goodput hump) is now CLOSED by task-76: a declared retry policy makes the DES compute the real hump
(reneging + re-injection + goodput/error/amplification accounting), differential-tested against Erlang-A.
The remaining divergences from live systems are the richer resilience policies (circuit breakers / bulkheads,
§2) plus the exponential service-time default (real distributions are heavier-tailed; distributions are
pluggable content — cold-start bimodal already exists).

### 2b. Coverage cross-check — the sensitivity matrix (task-78)

`sensitivity-matrix.test.ts` is the mechanical cross-check that every knob the model READS for one metric it
does not silently FORGET for another. It declares the WHOLE grid as reviewable DATA — rows = every input knob
(throughput, concurrency, perRequestDuration, latency, deploymentMode, unitCost, connectionPool / heldMs, vcpus,
durability, retry/offered-load), columns = observed outputs (cost, throughput, latency, availability, durability,
overflow, poolOverflow, concurrencyNeeded; goodput/errorRate via the DES) — and each cell is the EXPECTED
monotone direction (`+` / `−` / `0`). The harness bumps each knob on a synthetic engine-level chain and asserts
the MEASURED sign. A cell that declares `+` but MEASURES `0` fails with a NAMED gap — which is exactly how the
`deploymentMode → cost` regression (redundancy free) was caught: the two `deploymentMode` rows went RED until
task-77 landed the billed-redundancy multiplier, then GREEN. It is the coverage counterpart to §2a's numeric
differential (§2a checks the MAGNITUDE against Erlang; the matrix checks the SIGN of every knob×metric response),
and runs in CI as part of the content suite.

## 3. Strong differentiators — feasible, one new pattern needed (worth doing)

| Element | Mechanism | Missing piece |
|---|---|---|
| **Consistency model** (strong / eventual / read-your-writes) | **categorical lattice** — propagate a *categorical label* along the path (the MEET) | **NOW COVERED (§1c, guarantee-propagation R1+R2).** The enabling pattern shipped: an ordered opaque-token lattice with a path meet, differential-tested against an independent DataScript implementation. Consistency is labelled per port (writer strong, replica/DynamoDB/search/cache eventual) and judged per flow. |
| **Delivery semantics / ordering** (Kafka per-partition, SQS FIFO) | **categorical lattice** + content | **NOW COVERED (§1c).** Ordering (total/per-key/none) + delivery (clean/may-duplicate) labelled per port from the docs (SQS standard none/may-dup; FIFO per-key/clean; Kafka per-key/may-dup; RabbitMQ/NATS per docs) and propagated per flow, with the sqs→fifo remediation. |

These are things diagram tools cannot do at all. The single enabling addition — **propagating a categorical
label along a request path** — is now built (§1c): an ordered opaque-token lattice with a path meet, kept
entirely in content (the engine stays domain-agnostic — it composes opaque tokens, never a guarantee word).
The one remaining piece is folding a declared requirement into the clingo SYNTHESIS model (R3+, see §2).

## 4. Out of scope (deliberate — keeps "the engine computes, it does not guess")

- **IAM / deep security; STRIDE-style threat modelling** — a framework-in-a-framework (spoofing / tampering /
  repudiation / disclosure / DoS / elevation is a qualitative security envelope, not a quantitative one); deferred by
  decision (doc-3). The reliability/guarantee lenses cover the availability + consistency/ordering/delivery slices
  that ARE quantitative.
- **Multi-tenancy** (noisy-neighbour isolation, per-tenant quotas/fairness, tenant-scoped capacity) — needs a tenant
  dimension on the flow algebra. The **request-class** axis (§1f) is the nearest primitive (multi-commodity per-class
  flow) but a class is not a tenant (no isolation/fairness semantics); a true tenant model is a named future, not a
  per-case branch.
- **Per-class DES (request-classes R3)** — the time engine runs one aggregate service time per node, so the per-hop
  wait is class-blind (§1f). Per-class service times + per-(node,class) reservoirs are the declared next round; the
  scalar/analytic per-class reads are covered, the per-class TAIL is not yet.
- **A path-availability SLO** — end-to-end availability is COMPUTED per flow (`pathAvailabilityFor`), but a *requirement*
  on a whole PATH's availability (as guarantee/lag SLOs are keyed source→terminal) is deferred; today availability is
  bounded via a per-node band on the terminal, not a path-keyed SLO.
- **Business-logic / data-model correctness** — not a quantitative envelope.
- **Observability / runbooks / operational practice; org factors (Conway).**
- **Exact live cloud pricing** — cost *structure* yes; exact $ is a content-maintenance burden → only as marked `estimate`.
- **The actual code.**

## 5. Honesty contract (cross-cutting)

Every covered number is either an **input assumption**, a **derived value**, or **`unknown`** — never a
guess. Content numbers are **sourced** where possible (CDK config, documented limits like Postgres
`max_connections=100`) and **marked `est.`** otherwise. Percentile SLOs return `unknown` until a DES
run feeds them (doc-4 §3b). Qualitative guarantees follow the SAME contract (§1c): a per-port token is
declared only where documentation supports it (documented / est.), anywhere else the port declares NOTHING
(the lattice TOP — a neutral pass-through), and a requirement on a refused component reads an honest
`unknown`, never a fake green. Overlapping engines are differential-tested to agree (a disagreement is a
P0 — the guarantee meet is checked against an independent DataScript implementation). Redundancy is
**billed, not free**: a `deploymentMode` step that raises availability also raises COST
(Multi-AZ ×2 sourced, multi-region ≈ ×2.3 est.), so no optimizer or human can buy nines for $0 (task-77) —
and the sensitivity matrix (§2b) mechanically guards that EVERY knob moves EVERY metric it should, in the
right direction. Pricing has its own **identity discipline**: every priced component's `unitCost` states, as DATA
alongside the number, WHAT it prices — the OPERATIONAL identity (`managed` = a cloud provider runs + bills it, vs
`self-managed` = you run it on compute you already pay for) AND the RATE BASIS (`est.` / a sourced URL / a `list`
price) — so a cost is never an unlabelled magic number. A new priced component that omits either fails the
`pricing-identity` lint the moment it is added (`catalogs.test.ts`). This is what separates "I drew an architecture"
from "I verified an architecture".
