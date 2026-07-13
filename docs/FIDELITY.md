# SDA Fidelity Report

<!-- GENERATED FILE — do not edit. Source of truth: the capability registry (calibration/src/capabilities.ts), the content registry keys, and the calibration corpus. Regenerate with `pnpm fidelity`; freshness is asserted by calibration/src/fidelity.test.ts. -->

The V&V coverage matrix as a published report. It crosses every engine capability and modeling family with its evidence and prints the **honest** state: green only where a measured calibration residual OR an analytic anchor exists, and every remaining cell UNVALIDATED in plain sight. A visible gap is not a failure; a hidden one is. Regenerate with `pnpm fidelity`.

## Headline — the honest state

The headline is a **vector**, not one blended number: mixing a latency residual with a cost source would be dishonest (doc §7.1, §11.3).

- **Performance fidelity (fitted):** 2.7% over 12 scored points · out-of-sample 8.9%.
- **Cost fidelity:** sourced-only — no measured bill in the corpus (UNVALIDATED; cost is deterministic algebra over a cited unit price, not a fitted residual).
- **Availability fidelity:** sourced-only — no measured DR in the corpus (UNVALIDATED; availability is a series product vs the published SLA, not a fitted residual).
- **Modeling behaviors (8), by evidence nature:** **2 measured-capacity** (validated vs measured systems) · **3 theory-dynamics** (closed-form + DES anchored) · **3 sourced-algebra** (current vs cited quota/price/SLA) — the white-space is the RIGHT evidence per nature, not gaps (breakdown below).
- **Engine capabilities (14 total):** 2 validated · 9 verified (analytic anchor only) · 3 sourced (deterministic algebra over a cited quota/price/SLA) · 0 with **no anchor at all**.
- **Corpus:** 12 architectures.
- **Documented gaps:** 5 permanent structural limits + 4 addressable verification gaps.

> **The honest reading:** of the 8 modeling behaviors, only the 2 **measured-capacity** families can be — and are — validated against real measured systems (~2%). The other 6 are NOT gaps: **theory-dynamics** anchored to a closed form + the DES, and **sourced-algebra** correct against a cited quota / price / SLA — the RIGHT evidence for their nature, not a missing measurement. The two most-used solver capabilities (`evaluate`, `evaluateBatch`) are oracle-graded (`verified`). What the corpus can still broaden is the measured-capacity families; this report shows exactly which white-space is real.

## Modeling behaviors, by evidence nature

The 8 behaviors are three different KINDS of thing, and each deserves a different kind of evidence. "Validated against a measured system" is the right bar for capacity; it is the WRONG bar for deterministic algebra or a time-dynamic with no published curve. Green only where the evidence appropriate to the behavior's nature exists — the white-space below is NOT gaps, it is behaviors whose honest evidence is theory or a cited source.

**Measured-capacity (2)** — a clean measurable number a real benchmark pins; validated against a measured system where one exists. The ONLY nature the corpus can broaden.
- Queueing tail (M/M/c p99) — `validated` · Cassandra — 3-node cluster write ceiling, RF=3 QUORUM (ScyllaDB bake-off benchmark, 2017), DeathStarBench, Kafka — producer write, 3x async replication (Kreps 2014), Kafka — producer write, no replication (Kreps 2014), MongoDB Atlas — sharded cluster, caching workload (uniform), YCSB (benchANT 2023), RabbitMQ — classic queue (single node, AMQP 0.9.1), RabbitMQ — classic queue (single node, AMQP 1.0), Redis — LPUSH (single node, non-pipelined), Redis — SET (single node, non-pipelined), ScyllaDB — 3-node cluster, caching workload (uniform), YCSB (benchANT 2023), TechEmpower 20-query, TechEmpower single-query
- CPU-bound tier — `validated` · TechEmpower 20-query, TechEmpower single-query

**Theory-dynamics (3)** — a time-behavior anchored to a closed form AND differentially tested against the DES — trustworthy for direction and relative magnitude, but not calibratable to one measured system (the curves are rarely published, a single point is degenerate). Honestly `verified`, not a gap.
- Act as a queue (backlog) — `verified`
- Retry storms — `verified`
- Latency composition — `verified`

**Sourced-algebra (3)** — deterministic arithmetic whose correctness is a CURRENT cited quota / price / SLA, not a fitted residual — "validation" here means the source is fresh. Honestly `sourced`, not a gap.
- Redundancy / availability — `sourced`
- Documented ceilings (outage caps) — `sourced`
- Realistic cost — `sourced`

Only the measured-capacity families can be broadened by adding real systems to the corpus; the other 6 carry the evidence appropriate to their nature and are as solid as they should be.

## Per-capability coverage

`validated` = anchored AND a measured residual (green). `verified` = an analytic anchor but no measured validation yet. `sourced` = deterministic algebra over a cited quota/price/SLA (a distinct evidence kind, never blended into the fitted %). `UNVALIDATED` = no anchor and no residual.

| Capability | Kind | Anchor (oracle) | Validation | Status |
|---|---|---|---|---|
| Evaluate (forward pass) | solver | differential | UNVALIDATED | `verified` |
| EvaluateBatch (Monte-Carlo) | solver | differential | UNVALIDATED | `verified` |
| Optimize | solver | solver-incumbent | UNVALIDATED | `verified` |
| Repair | solver | solver-incumbent | UNVALIDATED | `verified` |
| ExplainInfeasible | solver | solver-incumbent | UNVALIDATED | `verified` |
| Enumerate | solver | solver-incumbent | UNVALIDATED | `verified` |
| Queueing tail (M/M/c p99) | family | analytic-closed-form, differential | Cassandra — 3-node cluster write ceiling, RF=3 QUORUM (ScyllaDB bake-off benchmark, 2017) 0.6%; DeathStarBench 0.2%; Kafka — producer write, 3x async replication (Kreps 2014) 1.5%; Kafka — producer write, no replication (Kreps 2014) 2.8%; MongoDB Atlas — sharded cluster, caching workload (uniform), YCSB (benchANT 2023) 0.9%; RabbitMQ — classic queue (single node, AMQP 0.9.1) 5.3%; RabbitMQ — classic queue (single node, AMQP 1.0) 6.3%; Redis — LPUSH (single node, non-pipelined) 2.1%; Redis — SET (single node, non-pipelined) 2.3%; ScyllaDB — 3-node cluster, caching workload (uniform), YCSB (benchANT 2023) 1.1%; TechEmpower 20-query 0.7%; TechEmpower single-query 0.5% | `validated` |
| Redundancy / availability | family | algebra | sourced (quota/price/SLA); no measured case | `sourced` |
| Act as a queue (backlog) | family | analytic-closed-form, property | UNVALIDATED | `verified` |
| Documented ceilings (outage caps) | family | algebra | sourced (quota/price/SLA); no measured case | `sourced` |
| Retry storms | family | analytic-closed-form | UNVALIDATED | `verified` |
| Realistic cost | family | algebra | sourced (quota/price/SLA); no measured case | `sourced` |
| Latency composition | family | differential, property | UNVALIDATED | `verified` |
| CPU-bound tier | family | analytic-closed-form | TechEmpower 20-query 0.7%; TechEmpower single-query 0.5% | `validated` |

_Evidence attribution: a family’s listed systems are those whose fit declares one of its tunables; a tunable shared across systems may be inert in some (the CPU tunable binds only TechEmpower single-query, the DB service time binds only the 20-query point — see the corpus notes). The per-system figure is that system’s overall post-fit residual, not an isolated per-knob fit._

_Partial anchors (honest caveats):_
- **Retry storms** — analytic-closed-form: exponential patience only — the production case (a deterministic maxQueueWaitMs timeout) is validated qualitatively, no closed form (doc §2.4)

## Metrics × regimes

The six reported metrics crossed with the three load regimes where a model behaves qualitatively differently (doc §4.1). A model right below the knee can be wrong past saturation, so each is tracked separately.

| Metric | below-knee | at-knee | past-saturation |
|---|---|---|---|
| Throughput ceiling | `verified` | `validated` Cassandra — 3-node cluster write ceiling, RF=3 QUORUM (ScyllaDB bake-off benchmark, 2017) | `verified` |
| p50 / p99 tail | `validated` MongoDB Atlas — sharded cluster, caching workload (uniform), YCSB (benchANT 2023) | `verified` | `verified` |
| Bottleneck / latency share | `validated` DeathStarBench | `verified` | `verified` |
| Cost / bill | `sourced` | `sourced` | `UNVALIDATED` |
| Availability / nines | `sourced` | `UNVALIDATED` | `UNVALIDATED` |
| Transient / peak survival | `verified` | `verified` | `UNVALIDATED` |

_Grid notes:_
- **p50 / p99 tail · below-knee** — scored on the analytic MEAN sojourn at a stated sub-saturation load (meanLatencyMsAtLoad), NOT a p99 curve; the seeded DES corroborates p50/p95/p99 at the same load, report-only (never scored)
- **Cost / bill · past-saturation** — no real bill in the corpus — UNVALIDATED
- **Availability / nines · at-knee** — availability is load-independent — no at-knee cell (n/a)
- **Availability / nines · past-saturation** — no measured DR / end-to-end availability in the corpus — UNVALIDATED
- **Transient / peak survival · past-saturation** — no measured transient in the corpus — UNVALIDATED

## Validation residuals — the fitted corpus

The measured systems SDA is held against, with the residual that remains after the best fit (the structural gap no tunable can remove). Read from the calibration corpus; the full derivation is in `calibration/CALIBRATION-REPORT.md`.

| System | Metric | Measured | Fitted | Residual |
|---|---|--:|--:|--:|
| Cassandra — 3-node cluster write ceiling, RF=3 QUORUM (ScyllaDB bake-off benchmark, 2017) | capacityCeilingRps | 70,771 op/s | 71,207 | +0.6% |
| DeathStarBench — Social Network | latencySharePct | 8.50 % | 8.52 | +0.2% |
| Kafka — producer write, 3x async replication (Kreps 2014) | capacityCeilingRps | 786,980 msg/s | 798,556 | +1.5% |
| Kafka — producer write, no replication (Kreps 2014) | capacityCeilingRps | 821,557 msg/s | 798,556 | -2.8% |
| MongoDB Atlas — sharded cluster, caching workload (uniform), YCSB (benchANT 2023) | meanLatencyMsAtLoad | 14 ms | 14 | -0.9% |
| RabbitMQ — classic queue (single node, AMQP 1.0) | capacityCeilingRps | 99,413 msg/s | 93,188 | -6.3% |
| RabbitMQ — classic queue (single node, AMQP 0.9.1) | capacityCeilingRps | 88,534 msg/s | 93,188 | +5.3% |
| Redis — LPUSH (single node, non-pipelined) | capacityCeilingRps | 188,324 op/s | 184,375 | -2.1% |
| Redis — SET (single node, non-pipelined) | capacityCeilingRps | 180,180 op/s | 184,375 | +2.3% |
| ScyllaDB — 3-node cluster, caching workload (uniform), YCSB (benchANT 2023) | meanLatencyMsAtLoad | 3 ms | 3 | +1.1% |
| TechEmpower — Multiple Queries (20 per request) | capacityCeilingRps | 5,900 req/s | 5,858 | -0.7% |
| TechEmpower — Single Database Query | capacityCeilingRps | 104,000 req/s | 104,538 | +0.5% |

Aggregate post-fit error: **2.7%** over 12 scored points. Out-of-sample (leave-one-out over the constrained entries): **8.9%** — the honest reminder that 12 architectures with mostly-disjoint tunables cannot yet cross-validate each other.

Leave-one-out generalization (the over-fit guard):
- **Cassandra — 3-node cluster write ceiling, RF=3 QUORUM (ScyllaDB bake-off benchmark, 2017)** — capacityCeilingRps -81.9% _(disjoint fallback — predicted at catalog defaults)_.
- **DeathStarBench — Social Network** — latencySharePct +6.5% _(disjoint fallback — predicted at catalog defaults)_.
- **Kafka — producer write, 3x async replication (Kreps 2014)** — capacityCeilingRps +4.2% _(genuine out-of-sample)_.
- **Kafka — producer write, no replication (Kreps 2014)** — capacityCeilingRps -4.1% _(genuine out-of-sample)_.
- **MongoDB Atlas — sharded cluster, caching workload (uniform), YCSB (benchANT 2023)** — meanLatencyMsAtLoad -63.8% _(disjoint fallback — predicted at catalog defaults)_.
- **RabbitMQ — classic queue (single node, AMQP 1.0)** — capacityCeilingRps -10.7% _(genuine out-of-sample)_.
- **RabbitMQ — classic queue (single node, AMQP 0.9.1)** — capacityCeilingRps +12.7% _(genuine out-of-sample)_.
- **Redis — LPUSH (single node, non-pipelined)** — capacityCeilingRps -4.2% _(genuine out-of-sample)_.
- **Redis — SET (single node, non-pipelined)** — capacityCeilingRps +4.5% _(genuine out-of-sample)_.
- **ScyllaDB — 3-node cluster, caching workload (uniform), YCSB (benchANT 2023)** — meanLatencyMsAtLoad n/a _(disjoint fallback — predicted at catalog defaults)_.
- **TechEmpower — Multiple Queries (20 per request)** — capacityCeilingRps -11.4% _(genuine out-of-sample)_.
- **TechEmpower — Single Database Query** — capacityCeilingRps +12.7% _(genuine out-of-sample)_.

## Verification gaps — addressable (doc §2.4)

Real, addressable verification holes — named plainly, not hidden. Later waves fill the highest-value ones.

- **P–K verified only at SCV=0** — The M/G/1 formula is differentially simulated only for deterministic service (M/D/1); no DES-vs-P–K test at an intermediate SCV, so general-variance service rests on the reduction identity alone. _(engine/sim/src/des.test.ts (SCV=0 only))_.
- **No Kingman / G/G/c heavy-traffic form** — Non-Markovian arrivals or general-variance multi-server waits have no closed-form oracle at all; where a design is genuinely G/G/c the DES stands alone with no analytic check. _(absent (honest))_.
- **No named Jackson product-form oracle** — Multi-station networks are verified by tandem decomposition (Burke) and end-to-end Little’s law, not against an open-Jackson-network product form — adequate for feed-forward DAGs, unproven for richer routing. _(engine/sim/src/response.test.ts, engine/sim/src/lag.test.ts (Burke-based))_.
- **realCumulativeLatency has no direct DES differential** — The MAX-over-predecessors end-to-end latency the canvas shows is checked per-hop and via responseLatency composition, but the cumulative number itself is not cross-checked against a DES end-to-end measurement. _(content/sda/src/analysis/response-latency.e2e.test.ts (per-hop / composition))_.

## Structural limits — permanent (doc §9)

What SDA deliberately does NOT model. These never turn green; where a design genuinely needs one, the honest output is `unknown`, never a fabricated number.

- **Deep allocator / GC / lock-contention economics** — A tier is an M/M/c station with a service time and a core count; heap pressure, GC pauses, false sharing and lock convoys are outside the queueing abstraction. The fitted per-request CPU time absorbs their average, not their dynamics.
- **Detailed consistency / consensus protocols** — Guarantees propagate as a qualitative token over a lattice — not simulated Raft/Paxos round-trips, quorum read/write latencies or the CAP trade under partition. A guarantee is a type, not a timed protocol.
- **Network-partition dynamics** — Availability is a steady-state series/parallel product, not a partition-and-heal simulation. Split-brain, failover storms and partial-partition behaviour are not modeled.
- **Cache-eviction internals** — A cache is a hit ratio that scales effective service time; LRU/LFU/ARC eviction dynamics, working-set shifts and cold-cache stampedes are not simulated. The hit ratio is an input, not an emergent property.
- **Two in-series resources as a true tandem** — Where a tier binds on the MIN of two stations (DB vs framework CPU) SDA takes the binding minimum, not a full tandem-network interaction — adequate for capacity, not a model of coupled queueing.

## How this is generated

Three walks, one emit (doc §6.2): (1) the claim surface — the capability registry (`calibration/src/capabilities.ts`) crossed with the metrics×regimes grid; (2) the anchors — declared on each capability, their test paths asserted to resolve; (3) the residuals — read from the calibration corpus and the deterministic fit. Every cell status is DERIVED (green only with a residual or an anchor), never authored. The generator is a pure function of the corpus + the deterministic fit (no clock, no RNG); `calibration/src/fidelity.test.ts` asserts this committed file is byte-identical to a fresh `pnpm fidelity`, so a capability added without an anchor-or-flag fails CI rather than passing silently. The fast fit-only gate runs under `pnpm test`; a heavier nightly with DES corroboration mirrors the solver oracle’s DEEP lane (follow-up).

