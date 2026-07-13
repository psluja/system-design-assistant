// THE CAPABILITY REGISTRY — the ONE declared home for the V&V coverage axis. Every question the engine answers (6 solver capabilities) and every modeling family the tool can
// model (the 8 MCP "capabilities you can model") is enumerated here ONCE, with its config-key levers, its
// verification anchor(s), and how its validation is judged (a fitted residual vs a cited source). The coverage
// generator (coverage.ts) walks THIS plus the registry keys and the calibration corpus to emit docs/FIDELITY.md;
// the freshness test (fidelity.test.ts) pins it. Nothing is authored twice: the axis lives here, the evidence is
// read from the code (anchor test paths, freshness-verified to resolve) and the corpus (fitted residuals).
//
// HONESTY RULE (owner mandate: brutal-honesty-over-comfort). A capability is GREEN (`validated`) only when it has
// BOTH an anchor AND a measured calibration residual. An anchor alone is `verified` (amber). Deterministic algebra
// over a cited price/SLA is `sourced` (a DISTINCT evidence kind — never blended into the fitted fidelity %). No
// anchor and no residual is `unvalidated` (a plain gap). This file must never claim an anchor a test does not
// carry: every `test` path is asserted to resolve, and a family is marked calibrated ONLY by the corpus, never
// here. The point of the artifact is that the gaps are VISIBLE — so where the honest state is weak, it stays weak.

// ── Oracles a verification anchor can use ─────────────────────────────────────────────────────────────────────
export type Oracle =
  | 'analytic-closed-form' //  a textbook closed form is the ground truth (M/M/1, Erlang-C, P–K, Erlang-A, fluid limit)
  | 'differential' //          the DES is checked against the analytic twin within tolerance
  | 'algebra' //               a deterministic identity (overflow = max(0, needed−ceiling), availability = series product)
  | 'solver-incumbent' //      the incumbent solver + metamorphic laws (the solver-oracle harness)
  | 'property'; //             a generated fast-check property (byte-identity, robustness — no throw)

/** One verification anchor: the oracle, the test that carries it (repo-relative; asserted to resolve), what it
 *  proves, and an OPTIONAL honest caveat where the anchor is only partial (P–K at SCV=0, Erlang-A exponential
 *  patience only) — the caveat is printed so a partial anchor is never dressed up as a full one. */
export interface Anchor {
  readonly oracle: Oracle;
  readonly test: string;
  readonly proves: string;
  readonly caveat?: string;
}

export type CapabilityKind = 'solver' | 'modeling-family';
/** How a capability's VALIDATION is judged: `fitted` — a corpus residual against a measured system; `sourced` —
 *  deterministic algebra whose correctness rests on a cited, current price/SLA (cost, availability), NOT a fit
 *  (doc §11.3). The two are never averaged into one number. */
export type ValidationKind = 'fitted' | 'sourced';

/** The NATURE of the evidence a modeling family CAN carry — the honest reframe (doc §11.3 generalized). Not every
 *  behavior should be "validated against a measured system"; forcing that bar where it does not fit is itself a lie.
 *  Three natures, each with its OWN appropriate evidence, so the coverage white-space is not misread as "gaps":
 *   - `measured-capacity` — a clean measurable number a real benchmark pins (queue/CPU throughput ceilings). This is
 *      the ONLY nature the corpus can broaden; validate it against measured systems.
 *   - `theory-dynamics` — a time-behavior anchored to a closed form AND differentially tested against the DES
 *      (backlog growth/drain, retry congestion, latency composition). Trustworthy by THEORY, not calibratable to one
 *      measured system: the curves are rarely published and a single point is degenerate. Honestly `verified`, forever.
 *   - `sourced-algebra` — deterministic arithmetic whose correctness is a CURRENT cited quota/price/SLA (cost,
 *      availability, documented ceilings), not a fitted residual. "Validation" means the source is fresh. Honestly `sourced`.
 *  Consistency (asserted by fidelity.test.ts): a family is `sourced-algebra` IFF its `validationKind` is `sourced`. */
export type EvidenceNature = 'measured-capacity' | 'theory-dynamics' | 'sourced-algebra';

/** One capability/family row of the coverage axis. `configKeys` are the registry-key levers it exposes (empty for
 *  a solver capability); the freshness test asserts each is a real `@sda/content` key. */
export interface Capability {
  readonly id: string;
  readonly name: string;
  readonly kind: CapabilityKind;
  readonly summary: string;
  readonly configKeys: readonly string[];
  readonly anchors: readonly Anchor[];
  readonly validationKind: ValidationKind;
  /** For a MODELING FAMILY: the nature of evidence appropriate to it (see {@link EvidenceNature}); the headline
   *  partitions the 8 families by this so white-space is not read as "gaps". Absent for solver capabilities (a
   *  separate axis). Consistency: `sourced-algebra` iff `validationKind === 'sourced'` (fidelity.test.ts pins it). */
  readonly nature?: EvidenceNature;
  readonly grounding: string;
}

// ── The 6 SOLVER capabilities (engine/solver-contract/src/capability/index.ts:6–11) ───────────────────────────
// Backward search is held to the executable specification (the solver-oracle harness). The forward hot path is now
// held too: `evaluate` is oracle-graded by a DIFFERENTIAL against an INDEPENDENT re-derivation of the scalar flow
// algebra (V&V phase-1 P0), and `evaluateBatch` inherits that anchor via a batch-consistency law. Both read
// `verified` (an anchor, no measured residual yet) — never `validated`, because no measured system pins them.
const SOLVERS: readonly Capability[] = [
  {
    id: 'evaluate',
    name: 'Evaluate (forward pass)',
    kind: 'solver',
    summary: 'The hot-path forward evaluation run on every edit; underlies every other capability.',
    configKeys: [],
    anchors: [
      {
        oracle: 'differential',
        test: 'engine/solver-contract/src/native/evaluate.differential.test.ts',
        proves:
          'the forward pass equals an INDEPENDENT re-derivation of the scalar flow algebra (offered = inflow + origin/level; served = min(capacity, offered); the min/sum/max/product series & fan-in aggregations; async cut vs carry; the per-port and per-wire transforms; the processor-sharing split under request classes; the least-fixpoint iteration) per node/key/class over the seeded generated corpus PLUS a widened corpus of the corners the harness generator never reaches (product/max aggregations, async edges, feedback cycles, self()/inflow()/outflow() relations, a localOnly key, multi-in-port fan-in, edge-transform overrides, multi-generator nodes); the oracle is mutation-proven non-vacuous and seed-rotatable (SDA_HARNESS_SEED / _DEEP)',
      },
    ],
    validationKind: 'fitted',
    grounding: 'engine/solver-contract/src/capability/evaluate.ts:55',
  },
  {
    id: 'evaluateBatch',
    name: 'EvaluateBatch (Monte-Carlo)',
    kind: 'solver',
    summary: 'The batched Monte-Carlo forward pass over a sampled assumption register.',
    configKeys: [],
    anchors: [
      {
        oracle: 'differential',
        test: 'engine/solver-contract/src/native/evaluate.differential.test.ts',
        proves:
          'batch consistency — each scenario’s Evaluation equals the single-world evaluate on the correspondingly-overridden design (per node/key), so the Monte-Carlo batch inherits the forward pass’s independent-oracle anchor rather than carrying an unverified path of its own',
      },
    ],
    validationKind: 'fitted',
    grounding: 'engine/solver-contract/src/capability/evaluate-batch.ts:44',
  },
  {
    id: 'optimize',
    name: 'Optimize',
    kind: 'solver',
    summary: 'Minimal sizing of free knobs to meet an SLO objective; graded against the incumbent MIP.',
    configKeys: [],
    anchors: [
      { oracle: 'solver-incumbent', test: 'engine/solver-contract/src/native/index.test.ts', proves: 'objective + SLO satisfaction match the incumbent (native vs COIN-BC) over the seeded differential batch' },
      { oracle: 'solver-incumbent', test: 'engine/solver-contract/src/harness/metamorphic.test.ts', proves: 'scale-equivariance, permutation-invariance and monotone-tightening laws hold on the optimum' },
    ],
    validationKind: 'fitted',
    grounding: 'engine/solver-contract/src/capability/optimize.ts:134',
  },
  {
    id: 'repair',
    name: 'Repair',
    kind: 'solver',
    summary: 'Minimal-change fix of an infeasible design; graded on total L1 distance.',
    configKeys: [],
    anchors: [
      { oracle: 'solver-incumbent', test: 'engine/solver-contract/src/native/index.test.ts', proves: 'repair L1 matches the incumbent and never exceeds the from-scratch optimum distance' },
      { oracle: 'solver-incumbent', test: 'engine/solver-contract/src/harness/metamorphic.test.ts', proves: 'repair coherence — a repair from a feasible point is zero-distance' },
    ],
    validationKind: 'fitted',
    grounding: 'engine/solver-contract/src/capability/repair.ts:50',
  },
  {
    id: 'explainInfeasible',
    name: 'ExplainInfeasible',
    kind: 'solver',
    summary: 'The shortfall set that makes a design infeasible; graded on the exact shortfall set.',
    configKeys: [],
    anchors: [
      { oracle: 'solver-incumbent', test: 'engine/solver-contract/src/native/index.test.ts', proves: 'the shortfall set matches the incumbent explanation' },
    ],
    validationKind: 'fitted',
    grounding: 'engine/solver-contract/src/capability/explain-infeasible.ts:47',
  },
  {
    id: 'enumerate',
    name: 'Enumerate',
    kind: 'solver',
    summary: 'The admissible-completion / selection set; graded on the exact selection set.',
    configKeys: [],
    anchors: [
      { oracle: 'solver-incumbent', test: 'engine/solver-contract/src/native/index.test.ts', proves: 'the selection set matches the incumbent (clingo/ASP) enumeration' },
    ],
    validationKind: 'fitted',
    grounding: 'engine/solver-contract/src/capability/enumerate.ts:79',
  },
];

// ── The 8 MODELING families (app/mcp/src/instructions.ts:144–153 — "capabilities you can model") ──────────────
// Each family's `configKeys` are the exact levers its instructions paragraph names (asserted to be real registry
// keys). Only queueing-tail and CPU-bound are touched by the calibration corpus today; the other six carry an
// analytic anchor but NO measured validation — the matrix must show that plainly.
const FAMILIES: readonly Capability[] = [
  {
    id: 'queueingTail',
    name: 'Queueing tail (M/M/c p99)',
    kind: 'modeling-family',
    summary: 'A tier’s throughput ceiling and p99 come from its M/M/c queueing station — concurrency, a connection pool, or a fixed `throughput` ceiling (a single-threaded store like Redis / Kafka) — never a hand-typed number.',
    // `throughput` is the capacity lever for a FIXED-throughput store (Redis/Kafka): nodeQueues reads the throughput
    // cell for rho, so a ceiling calibration that fits `throughput` (Redis/Kafka corpus) validates THIS family — the
    // same way TechEmpower's ceiling validates it via `perRequestDuration`. It maps to exactly one family (asserted).
    configKeys: ['throughput', 'concurrency', 'perRequestDuration', 'connectionPool', 'connectionHeldMs', 'maxQueueWaitMs'],
    anchors: [
      { oracle: 'analytic-closed-form', test: 'engine/sim/src/des.test.ts', proves: 'the DES reproduces M/M/1 and M/M/c (Erlang-C) ρ, L, W; c=1 reduces to M/M/1 to 10 digits' },
      { oracle: 'differential', test: 'content/sda/src/analysis/queueing.e2e.test.ts', proves: 'the analytic twin the canvas renders agrees with the DES within tolerance for single/pool/datastore stations' },
    ],
    validationKind: 'fitted',
    nature: 'measured-capacity',
    grounding: 'app/mcp/src/instructions.ts:146',
  },
  {
    id: 'redundancy',
    name: 'Redundancy / availability',
    kind: 'modeling-family',
    summary: 'deploymentMode selects the published-SLA availability nines (single-AZ / Multi-AZ / multi-Region).',
    configKeys: ['deploymentMode'],
    anchors: [
      { oracle: 'algebra', test: 'content/sda/src/analysis/reliability.test.ts', proves: 'availability is the series/parallel product of per-tier SLAs with the documented deployment-mode uplifts' },
    ],
    validationKind: 'sourced', // no residual to fit; correctness rests on the vendor SLA being current (doc §11.3)
    nature: 'sourced-algebra',
    grounding: 'app/mcp/src/instructions.ts:147',
  },
  {
    id: 'actAsQueue',
    name: 'Act as a queue (backlog)',
    kind: 'modeling-family',
    summary: 'Any component can buffer work: queueMode + drainRate + retention + maxBacklog compute the backlog.',
    configKeys: ['queueMode', 'arrivalRate', 'drainRate', 'retention', 'maxBacklog'],
    anchors: [
      { oracle: 'analytic-closed-form', test: 'engine/sim/src/transient.test.ts', proves: 'the transient backlog grows/peaks/drains at the fluid-limit (λ−μ) rates under a step overload' },
      { oracle: 'property', test: 'content/sda/src/analysis/queue.e2e.test.ts', proves: 'the scalar backlog (net accumulation) and drop-past-maxBacklog behave as declared' },
    ],
    validationKind: 'fitted',
    nature: 'theory-dynamics',
    grounding: 'app/mcp/src/instructions.ts:148',
  },
  {
    id: 'documentedCeilings',
    name: 'Documented ceilings (outage caps)',
    kind: 'modeling-family',
    summary: 'Real account/service limits fire as a violation the moment load/size crosses them (accountConcurrency, maxItemBytes).',
    configKeys: ['accountConcurrency', 'maxItemBytes'],
    anchors: [
      { oracle: 'algebra', test: 'content/sda/src/analysis/limits.e2e.test.ts', proves: 'concurrency/payload overflow = max(0, demand − documented ceiling) fires at the sourced quota' },
      { oracle: 'algebra', test: 'content/sda/src/analysis/overflow.e2e.test.ts', proves: 'the offered-load / capacity / overflow algebra past saturation' },
    ],
    validationKind: 'sourced', // a documented ceiling is a CITED quota (AWS limit docs), not a fitted residual — sourced-nature (doc §11.3 generalized)
    nature: 'sourced-algebra',
    grounding: 'app/mcp/src/instructions.ts:149',
  },
  {
    id: 'retryStorms',
    name: 'Retry storms',
    kind: 'modeling-family',
    summary: 'A caller’s retry policy (timeoutMs + retryCount + retryBackoffMs) drives amplification, goodput and errorRate under load.',
    configKeys: ['timeoutMs', 'retryCount', 'retryBackoffMs'],
    anchors: [
      { oracle: 'analytic-closed-form', test: 'engine/sim/src/retry.test.ts', proves: 'reneging (abandonment) matches Erlang-A within tolerance; goodput fraction ≈ 1−P_ab', caveat: 'exponential patience only — the production case (a deterministic maxQueueWaitMs timeout) is validated qualitatively, no closed form (doc §2.4)' },
    ],
    validationKind: 'fitted',
    nature: 'theory-dynamics',
    grounding: 'app/mcp/src/instructions.ts:150',
  },
  {
    id: 'realisticCost',
    name: 'Realistic cost',
    kind: 'modeling-family',
    summary: 'cost = driver × sourced unit price, plus the most-missed line, data egress (payloadBytes × egressUsdPerGb).',
    configKeys: ['unitCost', 'payloadBytes', 'egressUsdPerGb', 'vcpus'],
    anchors: [
      { oracle: 'algebra', test: 'content/sda/src/analysis/egress.e2e.test.ts', proves: 'egress cost = payloadBytes × throughput × egressUsdPerGb and sums across the design as a separate line' },
    ],
    validationKind: 'sourced', // deterministic algebra; there is no residual to fit — only a unit price to keep current (doc §11.3)
    nature: 'sourced-algebra',
    grounding: 'app/mcp/src/instructions.ts:151',
  },
  {
    id: 'latencyComposition',
    name: 'Latency composition',
    kind: 'modeling-family',
    summary: 'How a node combines synchronous downstream response times: sequential (sum) / parallel (max) / fastest (min).',
    configKeys: ['latencyComposition'],
    anchors: [
      { oracle: 'differential', test: 'engine/sim/src/response.test.ts', proves: 'per-node response mean tracks its M/M/c sojourn + synchronous downstream (Burke tandem decomposition)' },
      { oracle: 'differential', test: 'engine/sim/src/lag.test.ts', proves: 'flow-scoped lag tracks the forward-transit sum with async inclusion (Burke)' },
      { oracle: 'property', test: 'content/sda/src/analysis/response-latency.e2e.test.ts', proves: 'the sequential/parallel/fastest fold composes the downstream responses as declared' },
    ],
    validationKind: 'fitted',
    nature: 'theory-dynamics',
    grounding: 'app/mcp/src/instructions.ts:152',
  },
  {
    id: 'cpuBoundTier',
    name: 'CPU-bound tier',
    kind: 'modeling-family',
    summary: 'A node’s real ceiling can be its CPU (cpuCores + cpuTimePerRequestMs → an M/M/cores station), binding before any database.',
    configKeys: ['cpuCores', 'cpuTimePerRequestMs'],
    anchors: [
      { oracle: 'analytic-closed-form', test: 'content/sda/src/analysis/cpu-station.e2e.test.ts', proves: 'the CPU M/M/cores station binds as the min-capacity resource; a node with no CPU config is byte-identical to before (300-run property)' },
    ],
    validationKind: 'fitted',
    nature: 'measured-capacity',
    grounding: 'app/mcp/src/instructions.ts:153',
  },
];

/** The whole coverage axis: the 6 solver capabilities then the 8 modeling families, in a fixed order. */
export const CAPABILITIES: readonly Capability[] = [...SOLVERS, ...FAMILIES];

// ── The metrics × regimes grid (doc §4.1) — verification anchors per cell ──────────────────────────────────────
// The six reported metrics crossed with the three load regimes where a model behaves qualitatively differently.
// Each cell declares its VERIFICATION anchor (or null — an honest hole) and whether its evidence is `sourced`.
// The generator overlays the corpus (a scored ground-truth point that lands in a cell makes it `validated`); this
// declaration only carries verification, so a cell can never be green here without a corpus residual behind it.
export type GridMetric = 'throughputCeiling' | 'tail' | 'bottleneck' | 'cost' | 'availability' | 'transient';
export type GridRegime = 'below-knee' | 'at-knee' | 'past-saturation';

export interface GridAnchorCell {
  readonly metric: GridMetric;
  readonly regime: GridRegime;
  readonly anchor: Anchor | null; // null ⇒ no verification anchor for this cell (an honest hole)
  readonly sourced?: boolean; //     cost/availability: correctness rests on a cited source, not a fit (doc §11.3)
  readonly note?: string;
}

const A = (oracle: Oracle, test: string, proves: string): Anchor => ({ oracle, test, proves });

export const GRID: readonly GridAnchorCell[] = [
  // throughput ceiling
  { metric: 'throughputCeiling', regime: 'below-knee', anchor: A('analytic-closed-form', 'engine/sim/src/des.test.ts', 'M/M/c ceiling below the knee') },
  { metric: 'throughputCeiling', regime: 'at-knee', anchor: A('analytic-closed-form', 'content/sda/src/analysis/queueing.e2e.test.ts', 'ceiling at ρ→1 (corpus-validated by TechEmpower)') },
  { metric: 'throughputCeiling', regime: 'past-saturation', anchor: A('algebra', 'content/sda/src/analysis/overflow.e2e.test.ts', 'overflow algebra past capacity') },
  // p50 / p99 tail
  { metric: 'tail', regime: 'below-knee', anchor: A('differential', 'engine/sim/src/des.test.ts', 'DES tail corroboration'), note: 'scorable on the analytic MEAN sojourn at a stated sub-saturation load (meanLatencyMsAtLoad), NOT a p99 curve; the seeded DES corroborates p50/p95/p99 at the same load. No measured latency-at-load entry in the corpus yet — the cell is scorable but awaits one' },
  { metric: 'tail', regime: 'at-knee', anchor: A('analytic-closed-form', 'engine/sim/src/response.test.ts', 'M/M/c + Burke tandem at the knee') },
  { metric: 'tail', regime: 'past-saturation', anchor: A('analytic-closed-form', 'engine/sim/src/des.test.ts', 'ρ≥1 ⇒ ∞, never a throw — the honest answer') },
  // bottleneck id / latency share
  { metric: 'bottleneck', regime: 'below-knee', anchor: A('differential', 'content/sda/src/analysis/queueing.e2e.test.ts', 'per-hop sojourn share (corpus-validated by DeathStarBench)') },
  { metric: 'bottleneck', regime: 'at-knee', anchor: A('differential', 'engine/sim/src/response.test.ts', 'binding-tier identification at the knee') },
  { metric: 'bottleneck', regime: 'past-saturation', anchor: A('algebra', 'content/sda/src/analysis/overflow.e2e.test.ts', 'the bottleneck shifts to the binding tier') },
  // cost / bill
  { metric: 'cost', regime: 'below-knee', anchor: A('algebra', 'content/sda/src/analysis/egress.e2e.test.ts', 'cost = driver × sourced unit price'), sourced: true },
  { metric: 'cost', regime: 'at-knee', anchor: A('algebra', 'content/sda/src/analysis/egress.e2e.test.ts', 'cost scales with the sized driver'), sourced: true },
  { metric: 'cost', regime: 'past-saturation', anchor: null, note: 'no real bill in the corpus — UNVALIDATED' },
  // availability / nines
  { metric: 'availability', regime: 'below-knee', anchor: A('algebra', 'content/sda/src/analysis/reliability.test.ts', 'series/parallel product vs the published SLA'), sourced: true },
  { metric: 'availability', regime: 'at-knee', anchor: null, note: 'availability is load-independent — no at-knee cell (n/a)' },
  { metric: 'availability', regime: 'past-saturation', anchor: null, note: 'no measured DR / end-to-end availability in the corpus — UNVALIDATED' },
  // transient / peak survival
  { metric: 'transient', regime: 'below-knee', anchor: A('analytic-closed-form', 'engine/sim/src/transient.test.ts', 'fluid-limit backlog growth/drain') },
  { metric: 'transient', regime: 'at-knee', anchor: A('analytic-closed-form', 'engine/sim/src/transient.test.ts', 'windowed transient at the knee') },
  { metric: 'transient', regime: 'past-saturation', anchor: null, note: 'no measured transient in the corpus — UNVALIDATED' },
];

/** How a scored corpus ground-truth metric lands in the grid (doc §4.1). A capacity-ceiling measurement is by
 *  definition taken at ρ→1 (the knee); a low-load latency share is below the knee; a mean latency at a stated
 *  sub-saturation load is a below-knee tail point (scored on the analytic MEAN, the seeded DES corroborating the
 *  percentiles — so the `tail` row carries a real mean, never a mislabelled p99). Deterministic and stated so the
 *  validation overlay cannot be nudged. */
export const CORPUS_METRIC_CELL: Readonly<Record<string, { metric: GridMetric; regime: GridRegime }>> = {
  capacityCeilingRps: { metric: 'throughputCeiling', regime: 'at-knee' },
  latencySharePct: { metric: 'bottleneck', regime: 'below-knee' },
  meanLatencyMsAtLoad: { metric: 'tail', regime: 'below-knee' },
};

// ── §2.4 addressable verification gaps (the honest holes that CAN be closed, later waves) ──────────────────────
export interface VerificationGap {
  readonly title: string;
  readonly what: string;
  readonly evidence: string;
}
export const VERIFICATION_GAPS: readonly VerificationGap[] = [
  { title: 'P–K verified only at SCV=0', what: 'The M/G/1 formula is differentially simulated only for deterministic service (M/D/1); no DES-vs-P–K test at an intermediate SCV, so general-variance service rests on the reduction identity alone.', evidence: 'engine/sim/src/des.test.ts (SCV=0 only)' },
  { title: 'No Kingman / G/G/c heavy-traffic form', what: 'Non-Markovian arrivals or general-variance multi-server waits have no closed-form oracle at all; where a design is genuinely G/G/c the DES stands alone with no analytic check.', evidence: 'absent (honest)' },
  { title: 'No named Jackson product-form oracle', what: 'Multi-station networks are verified by tandem decomposition (Burke) and end-to-end Little’s law, not against an open-Jackson-network product form — adequate for feed-forward DAGs, unproven for richer routing.', evidence: 'engine/sim/src/response.test.ts, engine/sim/src/lag.test.ts (Burke-based)' },
  { title: 'realCumulativeLatency has no direct DES differential', what: 'The MAX-over-predecessors end-to-end latency the canvas shows is checked per-hop and via responseLatency composition, but the cumulative number itself is not cross-checked against a DES end-to-end measurement.', evidence: 'content/sda/src/analysis/response-latency.e2e.test.ts (per-hop / composition)' },
];

// ── §9 permanent structural limits (what SDA deliberately does NOT model — never turns green) ─────────────────
export interface StructuralLimit {
  readonly title: string;
  readonly why: string;
}
export const STRUCTURAL_LIMITS: readonly StructuralLimit[] = [
  { title: 'Deep allocator / GC / lock-contention economics', why: 'A tier is an M/M/c station with a service time and a core count; heap pressure, GC pauses, false sharing and lock convoys are outside the queueing abstraction. The fitted per-request CPU time absorbs their average, not their dynamics.' },
  { title: 'Detailed consistency / consensus protocols', why: 'Guarantees propagate as a qualitative token over a lattice — not simulated Raft/Paxos round-trips, quorum read/write latencies or the CAP trade under partition. A guarantee is a type, not a timed protocol.' },
  { title: 'Network-partition dynamics', why: 'Availability is a steady-state series/parallel product, not a partition-and-heal simulation. Split-brain, failover storms and partial-partition behaviour are not modeled.' },
  { title: 'Cache-eviction internals', why: 'A cache is a hit ratio that scales effective service time; LRU/LFU/ARC eviction dynamics, working-set shifts and cold-cache stampedes are not simulated. The hit ratio is an input, not an emergent property.' },
  { title: 'Two in-series resources as a true tandem', why: 'Where a tier binds on the MIN of two stations (DB vs framework CPU) SDA takes the binding minimum, not a full tandem-network interaction — adequate for capacity, not a model of coupled queueing.' },
];
