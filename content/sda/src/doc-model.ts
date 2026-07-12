import { applyTransform, Key, type Band, type Transform, type Verdict } from '@sda/engine-core';
import { keys } from './registry';
import {
  localContribution,
  localOwnAvailability,
  requestFlows,
  systemSummary,
  type CostBreakdown,
  type RequestFlow,
  type ValueFn,
} from './system';
import { systemPromiseVerdicts, type SystemPromise } from './system-promise';
import { availabilityTier, RELIABILITY_SOURCES } from './reliability';
import { MULTI_AZ_COST_STANDBY, MULTI_REGION_COST_EXTRA, RDS_PRICING_SOURCE } from './behaviors';
import { claimsFor } from './guarantees';
import type { AssumptionScenario, OverrideProvenance, WorldsResult } from './scenario';
import type { Instance, Manifest, ManifestBand, ManifestConfig, ManifestRelation, Wire } from './manifest';

// THE DOC MODEL — the verified model turned into EXHAUSTIVE TYPED DATA: the sections of
// the section canon (§2), each as plain values, tables and chart SERIES (numeric arrays with labels). It is the
// single anti-drift source both renderers read: the Markdown renderer (kept, for agents + git diffs) and the
// future HTML renderer (R2, for humans). Rendering is NOT this module's job — no strings-with-markup, no SVG, no
// colour: a section carries the DATA a renderer needs and nothing about how it looks.
//
// PURE + DETERMINISTIC: no clock, no randomness. The generation timestamp is an INPUT (`generatedAt`), so the
// same model always builds the same DocModel — golden-testable, identical across every surface.
//
// THE OWNER'S RULING IS ABSOLUTE (§6): the model carries ONLY what SDA computes well — capacity, latency,
// availability, cost and their assumptions. There is NO security / rollout / organizational section in ANY form,
// not even a skeleton. Scope is stated ONCE, honestly, as a sentence in the summary — never an empty template.

// ── the input (an EXTENSION of the Markdown generator's DesignDocInput) ─────────────────────────────────────

/** A visual boundary (a tier / VPC / AZ), as the C4 view groups containers (unchanged from the MD generator). */
export interface DocGroup {
  readonly id: string;
  readonly label: string;
  readonly members: readonly string[];
}

/** One computed alternative for a swappable tier (doc §9 "alternatives considered"). Passed IN by the caller —
 *  never computed inside `buildDocModel`: the solvers (compare_options / clingo / MiniZinc) are async and DI'd,
 *  and this module is a pure synchronous function. Absent input ⇒ the alternatives section is absent (§6: no
 *  padding). The section states its method honestly from `method`. */
export interface DocAlternative {
  /** The candidate component type (e.g. `db.postgres`) offered in place of the tier's current type. */
  readonly type: string;
  /** A human label for the option (the caller's choice — usually the type or a friendly name). */
  readonly label: string;
  /** Monthly cost of this option sized to the SLOs, when the caller computed one. */
  readonly costUsdMonth?: number;
  /** Cost delta vs the current design (negative = cheaper), when known. */
  readonly costDeltaUsdMonth?: number;
  /** Whether this option met every declared SLO in the caller's evaluation. */
  readonly meetsSlos?: boolean;
  /** A one-line honest note the caller supplies (the trade-off; e.g. "single-AZ ⇒ lower availability"). */
  readonly note?: string;
}

/** A group of alternatives for one node, plus the method that produced them (honesty, §6/§9). */
export interface DocAlternativeSet {
  readonly node: string;
  /** How the alternatives were produced, for the honest method statement (e.g. "compare_options (same family,
   *  each sized to the SLOs)"). The caller owns the wording — this module never invents a method it didn't run. */
  readonly method: string;
  readonly options: readonly DocAlternative[];
}

/** One point of the optional load→latency sweep (doc §5): offered load and the resulting end-to-end latency, each
 *  a forward evaluation the caller ran at GENERATION time (never persisted state). Absent ⇒ no sweep chart. */
export interface DocSweepPoint {
  readonly offeredRps: number;
  readonly latencyMs: number;
}

/** Everything `buildDocModel` reads — the design's structure + the engine's solved answer + the catalog (needed
 *  for provenance) + optional async/DI'd extras (sim result, sweep, alternatives). A strict SUPERSET of the
 *  Markdown generator's old `DesignDocInput`, so every existing caller keeps working by adding `catalog`. */
export interface DocModelInput {
  readonly name: string;
  readonly instances: readonly Instance[];
  readonly wires: readonly Wire[];
  /** The MERGED catalog (shared + project-scoped) — REQUIRED, because provenance is derived by comparing each
   *  instance's config against its manifest DEFAULT and reading the manifest's `source`/`est` data. Available on
   *  every surface via `studio.mergedCatalog()`. */
  readonly catalog: Readonly<Record<string, Manifest>>;
  readonly groups?: readonly DocGroup[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly descriptions?: Readonly<Record<string, string>>;
  /** Canvas positions per node id — carried into the architecture view so the future C4 SVG mirrors the canvas
   *  the architect arranged. Presentation only; absent ⇒ the view has no positions (a renderer may auto-lay-out). */
  readonly layout?: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  /** Real-aware verdicts (run `realAwareVerdicts` first): queueing-aware latency + explicit ρ≥1 saturation. */
  readonly verdicts: readonly Verdict[];
  /** The engine's solved value lookup, `(nodeId, key) => value`. */
  readonly value: ValueFn;
  readonly realLatencyByNode?: Readonly<Record<string, number>> | undefined;
  readonly responseLatencyByNode?: Readonly<Record<string, number>> | undefined;
  readonly saturated?: readonly string[] | undefined;
  readonly tail?: { readonly p50: number; readonly p95: number; readonly p99: number } | undefined;
  readonly retry?: { readonly goodputRps: number; readonly errorRate: number; readonly amplification: number } | undefined;
  /** Optional load→latency sweep points the caller computed at generation time (§5). */
  readonly sweep?: readonly DocSweepPoint[] | undefined;
  /** Optional computed alternatives per swappable tier (§9). Data in, never computed here. */
  readonly alternatives?: readonly DocAlternativeSet[] | undefined;
  /** Per-flow guarantee verdicts — DATA in (the caller runs `guaranteeVerdicts`),
   *  never computed here. Absent/empty ⇒ the guarantees section is omitted (the no-filler rule). */
  readonly guaranteeVerdicts?: readonly GuaranteeReqRow[] | undefined;
  /** Per-flow LAG verdicts — DATA in (the caller runs `lagVerdicts`), never computed
   *  here. Absent/empty ⇒ the propagation-lag block is omitted (no-filler). */
  readonly lagVerdicts?: readonly LagReqRow[] | undefined;
  /** Per-node RESPONSE PERCENTILES (ms) from a DES run — DATA in (the caller reads
   *  `sim.nodeResponse`), never computed here. The model surfaces a table for the REQUIREMENT-BEARING nodes only (a
   *  latency/tailLatency band); a node not in the map, or a design with no sim, yields no table (no-filler). NaN =
   *  the node had no recorded response (honest — rendered as "no data", never a fabricated number). */
  readonly responsePercentilesByNode?: Readonly<Record<string, NodeResponsePercentiles>> | undefined;
  /** The evaluated NAMED WORLDS (assumption-model doc §8) — DATA in (the caller runs `evaluateWorlds` + reads the
   *  scenario declarations), never computed here (the batch evaluator is async and DI'd, this module is pure sync).
   *  Absent, or a result with only the base world (no named worlds), ⇒ the scenario-comparison section is omitted
   *  (the no-filler rule — exactly like `guaranteeVerdicts` / `responsePercentilesByNode`). */
  readonly worlds?: DocWorldsInput | undefined;
  /** The declared SYSTEM-scoped promises (owner ruling: cost is for THE WHOLE SYSTEM) — judged HERE by the shared
   *  `systemPromiseVerdicts` (the one whole-graph judge every surface calls) into `system`-scoped requirement rows.
   *  Absent/empty ⇒ the requirements table renders exactly as before (no-filler, byte-compat goldens). */
  readonly systemPromises?: readonly SystemPromise[] | undefined;
  /** The generation timestamp AS AN INPUT (purity: no clock in the model). ISO string; the caller supplies it. */
  readonly generatedAt?: string | undefined;
}

/** DATA-in for the scenario-comparison section (assumption-model doc §8): the evaluated worlds (the base world plus
 *  every named world, from `evaluateWorlds`) PLUS the world DECLARATIONS (the provenance mix + the key overrides each
 *  world sets — read off `AssumptionScenario.overrides`, which the evaluated `WorldSummary` does not carry). */
export interface DocWorldsInput {
  readonly result: WorldsResult;
  readonly scenarios: readonly AssumptionScenario[];
}

/** One node's simulated response distribution (ms) as plain doc-input data — mean + p50/p95/p99 + backing samples. */
export interface NodeResponsePercentiles {
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly samples: number;
}

// ── provenance (doc §3, the heart) ──────────────────────────────────────────────────────────────────────────

/**
 * The provenance badge of an assumption, derived MECHANICALLY (never guessed):
 *  - `documented` — the manifest config carries a primary-source URL (`ManifestConfig.source`): an AWS quota/SLA
 *    page, the PostgreSQL docs. The badge links it.
 *  - `estimate` — the manifest marks the default an estimate (`ManifestConfig.est`): AWS-typical or
 *    workload-dependent, credible but not a published number (a CDN cache-hit ratio, a per-request duration).
 *  - `architect` — the value was SET BY HAND in this design: an instance config ≠ the manifest default, a
 *    wire/instance/manifest transform, or any SLO / origin / retry / deployment the architect declared.
 *  - `default` — an untouched catalog default (that MATTERS: see the inclusion rule on the register builder).
 */
export type Provenance = 'documented' | 'estimate' | 'architect' | 'default';

/** The LEVEL a flow transform sits at (doc §3 badges the level): a wire split, a per-instance override, or the
 *  manifest port default. All three reach the register — the leftover that manifest-level defaults now surface. */
export type TransformLevel = 'wire' | 'instance' | 'manifest';

/** One row of the assumptions register (§3): an input the numbers rest on, with its provenance and location. */
export interface AssumptionRow {
  /** A human name for the assumption (e.g. "PostgreSQL connection ceiling", "Offered traffic"). */
  readonly label: string;
  /** The value as DATA — a renderer formats it (this module never formats units into strings for display). */
  readonly value: number;
  readonly unit: string;
  readonly provenance: Provenance;
  /** The primary-source URL when `provenance === 'documented'`; a renderer links it. */
  readonly source?: string;
  /** Where it lives: the node id (or "wire a → b"), for the register's "Where" column. */
  readonly where: string;
  /** For a transform row, the level it was set at — so the register shows "(wire-level)" honestly. */
  readonly transformLevel?: TransformLevel;
  /** For a CATEGORICAL assumption (a guarantee contribution — "ordering: none"), the display string the renderer
   *  shows VERBATIM instead of `value + unit`. `value`/`unit` stay set (the token's lattice rank / dimension) so the
   *  numeric contract is intact, but a token is not a quantity — this is how it reads honestly in the register. */
  readonly display?: string;
}

// ── the sections (§2 canon) ─────────────────────────────────────────────────────────────────────────────────

/** §1 Summary — one honest paragraph + the ONE scope sentence (§6: honesty, not a filler section). */
export interface SummarySection {
  readonly name: string;
  readonly componentCount: number;
  readonly flowCount: number;
  /** Offered load of the busiest flow (the headline scale figure), when computed. */
  readonly offeredRps?: number;
  /** True when every declared SLO is met (no warning/violation). */
  readonly meetsAllSlos: boolean;
  readonly slosDeclared: number;
  readonly headlineCostUsdMonth?: number;
  /** THE honest scope sentence — verbatim, so every surface says the same thing (§6 owner ruling). */
  readonly scope: string;
}

/** One requirement row (§2 requirements / SLOs): the declared band vs the computed value vs the verified status. */
export interface RequirementRow {
  readonly node: string;
  readonly key: string;
  readonly band: Band;
  readonly computedValue?: number;
  readonly computedUnit?: string;
  readonly status: Verdict['status'] | 'unstated';
  /** The SCOPE this promise is checked at (F4, availability honesty — extended by the SYSTEM scope, owner ruling:
   *  cost is for THE WHOLE SYSTEM). A node band carries `'node'` — the computed column is the value AT that node
   *  (for cost: the BRANCH's accumulated spend; for availability: the terminal's cumulative — the serial product
   *  over the whole path, so an end-to-end availability promise IS a node band on the terminal). A declared system
   *  promise carries `'system'` — the computed column is the WHOLE-GRAPH total (every component summed, off-path
   *  branches included), and `node` is the literal `'system'` placeholder (the promise belongs to no node —
   *  renderers print "whole system"). */
  readonly scope: 'node' | 'system';
  /** For a NODE-scoped AVAILABILITY promise, the honest end-to-end availability each request flow CROSSING this node
   *  actually delivers at its terminal — surfaced beside the node-local green so "≥ 99.9% ✓ 99.99%" on an edge node
   *  never hides a 99.58% end-to-end path (the CQRS dogfood trap, F4). Only flows where this node is NOT the terminal
   *  appear (a terminal's cumulative IS its node value — no discrepancy). Absent/empty ⇒ nothing to contrast. */
  readonly endToEndAvailability?: readonly EndToEndAvailability[];
}

/** One crossing flow's end-to-end availability for a node-scoped availability promise (F4): the flow the node sits
 *  on and the availability its terminal actually reaches. `belowPromise` is true when that cumulative falls short of
 *  the node's own declared floor/target — the "misleading green" the row must expose. */
export interface EndToEndAvailability {
  readonly source: string;
  readonly terminal: string;
  readonly availability: number;
  readonly belowPromise: boolean;
}

/** §4 Architecture view DATA — nodes (with positions + type), edges (protocol + async + computed rate), groups.
 *  Enough for the future C4 SVG; no geometry beyond positions, no styling. */
export interface ArchNode {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly x?: number;
  readonly y?: number;
}
export interface ArchEdge {
  readonly from: string;
  readonly to: string;
  readonly semantics: 'sync' | 'async';
  /** The natural wire protocol (first `speaks` of the source port), for the edge label — undefined if unknown. */
  readonly protocol?: string;
  /** The computed rate on this edge (req/s) after transforms, when the engine gave one. */
  readonly rateRps?: number;
}
export interface ArchGroup {
  readonly id: string;
  readonly label: string;
  readonly members: readonly string[];
}
export interface ArchitectureSection {
  readonly nodes: readonly ArchNode[];
  readonly edges: readonly ArchEdge[];
  readonly groups: readonly ArchGroup[];
}

/** A named numeric SERIES for a chart — plain arrays, so R2 renders SVG and R1's Markdown renders a table. No
 *  colours, no dimensions: the DATA only. */
export interface ChartSeries {
  readonly label: string;
  readonly unit: string;
  readonly points: readonly { readonly label: string; readonly value: number }[];
}

/** One per-tier capacity row (§5): offered vs capacity vs utilisation (ρ), plus its end-to-end figures. */
export interface CapacityRow {
  readonly node: string;
  readonly offeredRps?: number;
  readonly capacityRps?: number;
  /** utilisation ρ = offered / capacity, when both known; ≥ 1 ⇒ saturated. */
  readonly utilization?: number;
  readonly saturated: boolean;
  readonly overflowRps?: number;
}
/** One end-to-end flow row (§5): the flow's terminal-read metrics. */
export interface FlowRow {
  readonly source: string;
  readonly terminal: string;
  readonly throughputRps?: number;
  /** The MEASURED end-to-end latency (ms) — the discrete-event simulation (seed 7): the flow terminal's response mean
   *  when the run recorded one, else the busiest-flow measured p50 for a single-flow design. Absent ⇒ `no data`
   *  (owner ruling: single-truth measured-or-nothing). This is the ONLY latency a renderer shows. */
  readonly measuredLatencyMs?: number;
  /** REAL (queueing-aware) end-to-end latency; Infinity at a saturated tier. COMPUTED but rendered on NO surface
   *  (owner ruling): kept in the model so the analytic diagnostics (waterfall / sweep) stay available, never shown
   *  as a flow-latency value. */
  readonly realLatencyMs?: number;
  readonly idealLatencyMs?: number;
  readonly availability?: number;
  readonly costUsdMonth?: number;
}
export interface CapacitySection {
  readonly flows: readonly FlowRow[];
  readonly tiers: readonly CapacityRow[];
  /** Utilisation bar series (ρ per tier) — the §5 utilisation-bars chart. */
  readonly utilizationSeries: ChartSeries;
  /** Latency-budget waterfall (per-tier own latency along the busiest flow) — the §5 waterfall chart. */
  readonly latencyWaterfall: ChartSeries;
  /** Optional load→latency sweep points (§5), when the caller supplied them. */
  readonly loadSweep?: ChartSeries;
  /** Active flow-transform rows (a port that does not relay 1:1 — the real downstream pressure). */
  readonly transforms: readonly TransformRow[];
  /** Per-tier response latency, when supplied. */
  readonly responseLatencyByNode?: Readonly<Record<string, number>>;
  /** Declared flow-scoped LAG deadlines + verdicts, when the caller supplies them.
   *  Sits in §5 next to the end-to-end flow table — it IS the end-to-end propagation view (async-inclusive), the
   *  counterpart to the terminal-cumulative latency in `flows`. Absent/empty ⇒ omitted (no-filler). */
  readonly lag?: readonly LagReqRow[];
  /** Per-node SIMULATED response percentiles for the REQUIREMENT-BEARING nodes — the
   *  DES twin of the scalar `responseLatencyByNode`, giving the tail a mean cannot. Present ONLY when a sim ran and
   *  the design has a latency/tailLatency SLO (no-filler). Each row's `samples` backs the percentiles honestly. */
  readonly responsePercentiles?: readonly NodeResponsePercentileRow[];
}

/** One per-node response-percentile row for the capacity section (§5): the node + its mean/p50/p95/p99 (ms) and the
 *  reservoir occupancy backing the percentiles. `NaN` values render as "no data" (the node had no recorded response). */
export interface NodeResponsePercentileRow {
  readonly node: string;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly samples: number;
}

/** One flow-transform row for the capacity section (a non-1:1 port), with the rate ENTERING the transform, the
 *  transform itself, and the rate LEAVING it — the full per-hop propagation the capacity chart shows (owner review
 *  R2: rate entering → transform → rate leaving, for every transformed edge). */
export interface TransformRow {
  readonly from: string;
  readonly to: string;
  readonly transform: Transform;
  /** 'out' = an emission (the source emits ×N), 'in' = a consumption (the target intakes ÷N). */
  readonly side: 'out' | 'in';
  /** The rate ARRIVING at the transform (req/s) before it is applied — the left side of the propagation. */
  readonly enteringRps?: number;
  /** The rate LEAVING the transform (req/s) after it is applied — the right side of the propagation. */
  readonly resultingRps?: number;
}

/** §6 Simulation (DES) — tails always; the retry story ONLY when a retry policy exists (§ retry-feedback). */
export interface SimulationSection {
  readonly tail?: { readonly p50: number; readonly p95: number; readonly p99: number };
  /** Present ONLY when the design declares a retry policy (goodput/errors/amplification are otherwise vacuous). */
  readonly retry?: {
    readonly goodputRps: number;
    readonly errorRate: number;
    readonly amplification: number;
    readonly offeredRps?: number;
    /** The callers that declared the policy, for the honest "the design retries" statement. */
    readonly callers: readonly { readonly node: string; readonly timeoutMs: number; readonly retryCount: number }[];
  };
}

/** One reliability row (§7): a flow's availability, its AWS nines tier, weakest dependency, and the sourced remedy. */
export interface ReliabilityRow {
  readonly source: string;
  readonly terminal: string;
  readonly availability: number;
  /** The AWS availability tier the number meets (nines + max yearly downtime + category), when ≥ 99%. */
  readonly tier?: { readonly availability: number; readonly maxDowntimePerYear: string; readonly applicationCategories: string };
  readonly weakestDependency?: { readonly node: string; readonly availability: number };
  readonly targetAvailability?: number;
  readonly meetsTarget?: boolean;
}
export interface ReliabilitySection {
  readonly flows: readonly ReliabilityRow[];
  /** The AWS Well-Architected availability source (sourced, never opinion). */
  readonly source: string;
}

/** One per-flow qualitative-guarantee row: the requirement, the
 *  computed end-to-end token, the provable root-cause hop, the verdict, and the computed remediation (or the honest
 *  reason none exists). Every field is DATA the caller computed via `guaranteeVerdicts` — the renderer formats only. */
export interface GuaranteeReqRow {
  readonly source: string;
  readonly terminal: string;
  readonly dimension: string;
  readonly required: string;
  readonly computed: string;
  readonly status: Verdict['status'];
  readonly rootCauseNode: string | null;
  /** The computed same-family swap fix ("switch q to queue.sqs.fifo — restores ordering ≥ per-key · …"), when any. */
  readonly remediation?: string;
  /** When violated but no swap restores it: the honest reason (so the doc never implies an uncomputable fix). */
  readonly noRemediationReason?: string;
}

/** §7b Guarantees — the per-flow qualitative promises (consistency/ordering/delivery) as computed verdicts. Present
 *  in the section order ONLY when the design declares a guarantee requirement (the no-filler rule); the declared
 *  per-port CONTRIBUTIONS behind the tokens ride the assumptions register (with their documented/est. badge). */
export interface GuaranteesSection {
  readonly rows: readonly GuaranteeReqRow[];
}

/** One per-flow LAG row — a declared propagation deadline (source→terminal, async
 *  queue waits INCLUDED) and its verdict. `basis` says how it was reached (a DES-measured mean, the scalar lower
 *  bound proving a violation, or `unknown` pending the sim). Every field is DATA the caller computed via
 *  `lagVerdicts` — the renderer formats only; the numbers are ms. */
export interface LagReqRow {
  readonly source: string;
  readonly terminal: string;
  readonly maxMs: number;
  readonly status: Verdict['status'];
  readonly basis: 'measured' | 'lower-bound' | 'unknown';
  /** The scalar queue-free lower bound in ms (∞ at a saturated tier; omitted when there is no path). */
  readonly lowerBoundMs?: number;
  /** The DES-measured async-inclusive mean lag in ms, when a run resolved it. */
  readonly measuredMeanMs?: number;
  /** The one-line computed explanation / what would resolve an `unknown`. */
  readonly note: string;
}

/** The cost MODEL a component bills by (behaviors.ts THE COST MODEL), detected from its `cost` relation so the
 *  register can SHOW the arithmetic instead of a bare figure — the honesty the owner asked for (2026-07-03 §3):
 *   - `flat`         — a fixed monthly price (`flatCost`: `self(unitCost)`).
 *   - `provisioned`  — the reserved capacity CEILING × unit price (`provisionedCost`: `self(throughput) × price`).
 *   - `pay-per-use`  — the OFFERED load × unit price (`payPerUseCost`: `inflow(throughput) × price`).
 *   - `per-unit`     — a local unit COUNT (replicas / requiredUnits / concurrency) × unit price (`costPer`).
 *  Every non-flat model is a `driver × unitPrice` product; `flat` has no driver. Which one is read off the
 *  relation's `expr`/`reads` (never guessed) — see `buildCost`. */
export type CostModelKind = 'flat' | 'provisioned' | 'pay-per-use' | 'per-unit';

/** One per-component cost DERIVATION (2026-07-03 §3): the arithmetic behind its monthly figure, as DATA a renderer
 *  formats inline ("2,000 req/s × $2/(req/s)·mo = $4,000"). Absent driver (`flat`) ⇒ the base IS the figure. A
 *  Multi-AZ / multi-region deployment adds a surcharge FACTOR (`withDeploymentCost`: base × 2 at Multi-AZ) — carried
 *  separately so the renderer can show "… ×2 Multi-AZ" honestly. Every field is a number/label the builder read off
 *  the model; the renderer computes nothing. */
export interface CostDerivation {
  readonly node: string;
  readonly model: CostModelKind;
  /** The driver quantity the base multiplies (offered load, reserved capacity, unit count) — absent for `flat`. */
  readonly driverValue?: number;
  /** A human label for the driver ("offered load", "reserved capacity", "replicas") — absent for `flat`. */
  readonly driverLabel?: string;
  /** The driver's unit ("req/s", "units", "replicas") for the arithmetic's left operand — absent for `flat`. */
  readonly driverUnit?: string;
  /** The base rate per driver unit (`unitCost`), the right operand of the product. */
  readonly unitPrice: number;
  /** The base rate's unit as the catalog documents it (e.g. "USD/(req/s)·month", "USD/conc·month"). */
  readonly unitPriceUnit: string;
  /** The deployment-mode surcharge multiplier (`withDeploymentCost`): 1 = single-AZ, 2 = Multi-AZ, ~2.3 = multi-
   *  region. Present (and > 1) ONLY when the component's cost relation carries the surcharge AND the mode raises it. */
  readonly deploymentFactor?: number;
  /** A human label for the surcharge ("Multi-AZ", "multi-region"), when `deploymentFactor` is present. */
  readonly deploymentLabel?: string;
  /** The resulting monthly cost (driver × unitPrice × deploymentFactor, or the flat base) — the engine's own
   *  `cost` value, so the shown arithmetic and the total can never drift. */
  readonly totalUsdMonth: number;
}

/** §8 Cost — the breakdown totals + a per-component breakdown SERIES for the chart + the per-component DERIVATIONS. */
export interface CostSection {
  readonly breakdown: CostBreakdown;
  /** Per-component own cost (compute/storage) — the §8 breakdown chart series (share of compute). */
  readonly perComponentSeries: ChartSeries;
  /** Per-component cost arithmetic (2026-07-03 §3), largest first, so each row shows HOW its figure was reached.
   *  Empty when no component carries a priced cost model (an honest empty, never padded). */
  readonly derivations: readonly CostDerivation[];
}

/** §9 Alternatives — DATA passed in (never computed here); absent when the caller didn't opt in (§6). */
export interface AlternativesSection {
  readonly sets: readonly DocAlternativeSet[];
}

/** One fact-assumption DELTA a world sets (assumption-model doc §8), as DATA for the world row's "overrides" cell:
 *  the coordinate, the value, and its unit + provenance so the renderer formats it (a time key rounds to whole ms;
 *  a `derived` value carries the "awaits a measurement" badge, §5.3). Base has none. */
export interface ScenarioOverrideCell {
  readonly node: string;
  readonly key: string;
  readonly value: number;
  readonly unit: string;
  /** `derived` (live from the envelope, awaits a measurement) | `architect` (frozen, hand-set) | absent (plain). */
  readonly provenance?: OverrideProvenance;
}

/** One world's row in the scenario-comparison section (assumption-model doc §8): its absolute cost, the verdict
 *  roll-up (incl. WHICH SLOs break), the worst-tier utilisation, and the provenance MIX + key overrides of its
 *  declaration. Every field is DATA read off the evaluated world + its declaration — the renderer formats only. */
export interface ScenarioWorldRow {
  /** The scenario id, or `'base'` for the always-present base world. */
  readonly id: string;
  readonly name: string;
  readonly isBase: boolean;
  readonly costUsdMonth: number;
  readonly feasible: boolean;
  readonly violations: number;
  /** Peak node utilisation ρ (the worst-tier headroom read); undefined when no node queues. */
  readonly peakRho?: number;
  /** The SLOs that break in this world, as "node.key" — the WHICH-breaks honesty. Empty when feasible. */
  readonly brokenSlos: readonly string[];
  /** How many of this world's overrides are live-`derived` vs `architect`/hand-set (base ⇒ 0/0). */
  readonly derivedCount: number;
  readonly architectCount: number;
  /** This world's fact-assumption deltas over the base layer (empty for base). */
  readonly overrides: readonly ScenarioOverrideCell[];
  /** Overrides naming a node/key the design no longer carries — reported + skipped (a soft lens, doc §4.2). */
  readonly staleOverrides: readonly string[];
}

/** §scenarios — the world-comparison table (assumption-model doc §8, "the section we lack"): the base world plus
 *  every named world, side by side — per-world cost, verdicts (incl. which SLO breaks), worst-tier ρ and the
 *  provenance mix. Present ONLY when the design declares a named world (a result with more than the base world) —
 *  the no-filler rule; derived overrides carry the `derived` badge so a reader sees which numbers await a measurement. */
export interface ScenariosSection {
  readonly worlds: readonly ScenarioWorldRow[];
  /** Cost-per-world chart series (the §8 per-world cost bar). */
  readonly costSeries: ChartSeries;
}

/** One risk / open question (§10): a violation, a warning, or an `unknown` with what resolves it. */
export interface RiskItem {
  readonly severity: 'violation' | 'warning' | 'unknown';
  readonly node: string;
  readonly key: string;
  /** The honest description (the verdict's cause, or "computed no value — resolves by …" for an unknown). */
  readonly note: string;
  /** For an `unknown`, WHAT would resolve it (run the simulator, set a value) — honesty about ignorance. */
  readonly resolvedBy?: string;
  /** The top remediation, when the verdict carries one. */
  readonly fix?: string;
}
export interface RisksSection {
  readonly items: readonly RiskItem[];
}

/** §11 Glossary + provenance legend — static definitions the outside reader needs (data, not prose-in-code). */
export interface GlossaryEntry {
  readonly term: string;
  readonly definition: string;
}
export interface ProvenanceLegendEntry {
  readonly badge: Provenance;
  readonly meaning: string;
}
export interface GlossarySection {
  readonly entries: readonly GlossaryEntry[];
  readonly provenanceLegend: readonly ProvenanceLegendEntry[];
}

/**
 * THE DOC MODEL — the whole deliverable as data. `sections` is a discriminated list ONLY of in-domain sections
 * (§6 owner ruling: no security / rollout / org section EVER). A renderer walks the fields; a test asserts the
 * section key list contains no out-of-domain key.
 */
export interface DocModel {
  readonly name: string;
  readonly generatedAt?: string;
  /** The exact ordered list of section keys present — the canon (§2), in-domain only. A renderer + a test both
   *  read this: the test asserts it never contains a security/rollout/org key (the owner ruling, as data). */
  readonly sectionOrder: readonly SectionKey[];
  readonly summary: SummarySection;
  readonly requirements: readonly RequirementRow[];
  readonly assumptions: readonly AssumptionRow[];
  /** Absent (undefined) when the design declares no named world — never a padded empty section (§6 / no-filler). */
  readonly scenarios?: ScenariosSection;
  readonly architecture: ArchitectureSection;
  readonly capacity: CapacitySection;
  readonly simulation: SimulationSection;
  readonly reliability: ReliabilitySection;
  /** Absent (undefined) when the design declares no guarantee requirement — never a padded empty section (§6). */
  readonly guarantees?: GuaranteesSection;
  readonly cost: CostSection;
  /** Absent (undefined) when the caller passed no alternatives — never a padded empty section (§6). */
  readonly alternatives?: AlternativesSection;
  readonly risks: RisksSection;
  readonly glossary: GlossarySection;
}

/** The in-domain section canon (§2). Deliberately CLOSED and out-of-domain-free: there is no `security`,
 *  `rollout`, or `organization` member — the owner ruling encoded in the type, so an out-of-domain section is
 *  UNREPRESENTABLE, not merely policed at runtime. */
export type SectionKey =
  | 'summary'
  | 'requirements'
  | 'assumptions'
  | 'scenarios'
  | 'architecture'
  | 'capacity'
  | 'simulation'
  | 'reliability'
  | 'guarantees'
  | 'cost'
  | 'alternatives'
  | 'risks'
  | 'glossary';

// THE honest scope sentence (§6 owner ruling — verbatim on every surface). Stated once, in the summary; it is
// honesty (what the document covers), never a filler section for what it does not.
export const SCOPE_SENTENCE =
  'This document covers the quantitative envelope of the design: capacity, latency, availability, cost and their assumptions.';

// THE product SCOPE BOUNDARY, shown in the LIVE EDITOR (onboarding, the Verified pill, the help panel) so a user
// learns what SDA verifies — and what it deliberately does NOT — BEFORE trusting a number, not only after exporting
// the doc. Same one source as SCOPE_SENTENCE so the boundary reads identically wherever it appears
// (single-truth-display); the "does not review" half mirrors the doc's "author required" sections (design-doc.ts).
export const SCOPE_STATEMENT =
  'SDA verifies the quantitative envelope of a design — capacity & throughput, latency (incl. the p99 tail), availability, cost, and their flow — live, against your SLOs. It does not review security, operational readiness, or compliance; those stay the architect’s judgment (flagged “author required” in the exported design doc). Every number is sourced or marked “unknown”, never guessed.';
/** The Verified-pill tooltip: what "Verified" actually means, so a staff architect is not misled that a green pill is a full review. */
export const VERIFIED_SCOPE_HINT =
  'Verified against the quantitative envelope — capacity, latency, availability, cost — under your SLOs. Not a security / operations / compliance review. Click to open the Problems list.';

// ── formatting-free helpers (pure DATA; NO display strings) ─────────────────────────────────────────────────

/** The registry unit for a key, for the requirement/assumption unit column — read from the value lookup's
 *  companion is not available here, so we keep the known units small and fall back to '' (a renderer decides). */
const KEY_UNIT: Record<string, string> = {
  [String(keys.throughput)]: 'req/s',
  [String(keys.latency)]: 'ms',
  [String(keys.tailLatency)]: 'ms',
  [String(keys.availability)]: 'ratio',
  [String(keys.durability)]: 'ratio',
  [String(keys.cost)]: 'USD/month',
};

/** Read a config default value (and its declaration) from a manifest for a key, or undefined if not declared. */
function manifestConfig(manifest: Manifest | undefined, key: string): ManifestConfig | undefined {
  return manifest?.config?.find((c) => String(c.key) === key);
}

/**
 * Derive the provenance of ONE config key on an instance (doc §3, mechanical — never a guess):
 *   1. the instance set a value DIFFERENT from the manifest default   ⇒ `architect`
 *   2. the manifest config carries a `source` URL                     ⇒ `documented`
 *   3. the manifest config is marked `est`                            ⇒ `estimate`
 *   4. otherwise                                                      ⇒ `default`
 * The order matters: an architect override wins over the manifest's own badge (the value on THIS design is the
 * architect's, whatever the catalog said). A key the instance set that the manifest does NOT declare is always
 * `architect` (a hand-set knob).
 */
function configProvenance(
  instanceValue: number | undefined,
  def: ManifestConfig | undefined,
): { provenance: Provenance; source?: string } {
  if (def === undefined) return { provenance: 'architect' }; // a knob the manifest never declared — set by hand
  if (instanceValue !== undefined && instanceValue !== def.value) return { provenance: 'architect' };
  if (def.source !== undefined) return { provenance: 'documented', source: def.source };
  if (def.est === true) return { provenance: 'estimate' };
  return { provenance: 'default' };
}

// KEYS whose DEFAULT is worth listing in the register even when untouched. INCLUSION RULE (honest, stated here):
// a `default` row earns its place ONLY if it PARTICIPATES in a verdict or a capacity/cost figure — a documented
// ceiling, a sizing/latency/availability/cost driver — NOT every inert knob (assumedRps 0, retry 0, a queue knob on
// a non-queue). Listing every zero-valued default would pad the register, which the whole product forbids (§3:
// "it lists what IS; it never pads"). Documented/estimate/architect values are ALWAYS listed (their provenance is
// the point); only PLAIN defaults are filtered by this set.
const REGISTER_DEFAULT_KEYS = new Set<string>([
  String(keys.throughput),
  String(keys.latency),
  String(keys.availability),
  String(keys.durability),
  String(keys.concurrency),
  String(keys.perRequestDuration),
  String(keys.accountConcurrency),
  String(keys.connectionPool),
  String(keys.connectionHeldMs),
  String(keys.maxItemBytes),
  String(keys.maxQueueWaitMs),
  String(keys.deploymentMode),
  String(keys.replicas),
  String(keys.maxUnits),
  String(keys.egressUsdPerGb),
]);

/** A human label for a registry key in the register's "Assumption" column (data; a renderer shows it as-is). */
const ASSUMPTION_LABEL: Record<string, string> = {
  [String(keys.throughput)]: 'Throughput ceiling',
  [String(keys.latency)]: 'Service latency',
  [String(keys.availability)]: 'Availability',
  [String(keys.durability)]: 'Durability',
  [String(keys.concurrency)]: 'Concurrency',
  [String(keys.perRequestDuration)]: 'Per-request duration',
  [String(keys.accountConcurrency)]: 'Account concurrency ceiling',
  [String(keys.connectionPool)]: 'Connection-pool budget',
  [String(keys.connectionHeldMs)]: 'Connection hold time',
  [String(keys.maxItemBytes)]: 'Max item/message size',
  [String(keys.maxQueueWaitMs)]: 'Borrow/wait timeout',
  [String(keys.deploymentMode)]: 'Deployment mode',
  [String(keys.replicas)]: 'Replicas',
  [String(keys.maxUnits)]: 'Unit ceiling',
  [String(keys.assumedRps)]: 'Offered traffic',
  [String(keys.timeoutMs)]: 'Call timeout',
  [String(keys.retryCount)]: 'Retry count',
  [String(keys.retryBackoffMs)]: 'Retry backoff',
  [String(keys.egressUsdPerGb)]: 'Egress price',
};
const assumptionLabel = (key: string): string => ASSUMPTION_LABEL[key] ?? key;

/** The natural wire protocol of a source port (first `speaks`), for the architecture edge label. */
function edgeProtocol(catalog: Readonly<Record<string, Manifest>>, inst: Instance | undefined, portName: string): string | undefined {
  const m = inst ? catalog[inst.type] : undefined;
  const port = m?.ports.find((p) => p.name === portName);
  return port?.speaks?.[0];
}

// ── the builder ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Build the DocModel — a PURE function of the verified model. The single source both renderers consume. It
 * computes nothing the engine didn't: every metric is read off `input.value` / the verdicts, and every derived
 * figure reuses content's OWN roll-ups (systemSummary, requestFlows, localContribution) so the document never
 * drifts from the System panel or the MCP evaluate.
 */
export function buildDocModel(input: DocModelInput): DocModel {
  const { instances, wires, verdicts, value, catalog } = input;
  const labels = input.labels ?? {};
  const groups = input.groups ?? [];
  const display = (id: string): string => labels[id] || id;
  const instById = new Map(instances.map((i) => [i.id, i]));

  const sys = systemSummary(instances, wires, value);
  const flows = requestFlows(instances, wires, value);
  const busiest = sys.flows[0];

  // ── §1 summary ──
  const problems = verdicts.filter((v) => v.status === 'warning' || v.status === 'violation');
  const slos = instances.flatMap((i) => (i.bands ?? []).map((b): { node: string; band: ManifestBand } => ({ node: i.id, band: b })));
  // The SYSTEM promises (owner ruling: cost is for THE WHOLE SYSTEM), judged by the ONE shared judge against the
  // whole-graph total — a declared global promise counts as an SLO, and its breach breaks `meetsAllSlos`.
  const sysProms = systemPromiseVerdicts(instances, wires, value, input.systemPromises ?? []);
  const summary: SummarySection = {
    name: input.name,
    componentCount: instances.length,
    flowCount: flows.length,
    ...(busiest?.throughputRps !== undefined ? { offeredRps: busiest.throughputRps } : {}),
    meetsAllSlos:
      problems.length === 0 &&
      sysProms.every((p) => p.status !== 'violation' && p.status !== 'warning'),
    slosDeclared: slos.length + sysProms.length,
    ...(sys.cost.totalUsdMonth !== undefined ? { headlineCostUsdMonth: sys.cost.totalUsdMonth } : {}),
    scope: SCOPE_SENTENCE,
  };

  // ── §2 requirements ──
  const verdictFor = (node: string, key: string): Verdict | undefined =>
    verdicts.find((v) => String(v.scope) === node && String(v.key) === key);
  // SYSTEM-scoped rows FIRST (the global promises lead): the computed column is the whole-graph total — never one
  // branch's accumulated cell — and the renderers label the scope `system` (labelling extended).
  const systemRequirements: RequirementRow[] = sysProms.map((p) => ({
    node: 'system',
    key: p.key,
    band: p.band,
    ...(p.computed !== undefined ? { computedValue: p.computed } : {}),
    ...(p.unit !== undefined ? { computedUnit: p.unit } : {}),
    status: p.status,
    scope: 'system',
  }));
  const nodeRequirements: RequirementRow[] = slos.map(({ node, band }) => {
    const key = String(band.key);
    const v = verdictFor(node, key);
    // AVAILABILITY SCOPE HONESTY (F4): a declared availability band is a NODE-scoped promise — the computed column is
    // the availability AT that node. Beside it, surface the end-to-end availability of every flow that CROSSES the
    // node (the honest cumulative a request actually gets), so a node-local green never hides a lower path figure.
    const e2e = key === String(keys.availability) ? pathAvailabilityFor(node, flows, value, bandHeadline(band.band)) : [];
    return {
      node,
      key,
      band: band.band,
      ...(v?.computed.value !== undefined ? { computedValue: v.computed.value } : {}),
      ...(v?.computed.unit !== undefined ? { computedUnit: v.computed.unit } : {}),
      status: v?.status ?? 'unstated',
      scope: 'node',
      ...(e2e.length > 0 ? { endToEndAvailability: e2e } : {}),
    };
  });
  const requirements: RequirementRow[] = [...systemRequirements, ...nodeRequirements];

  // ── §3 assumptions register ──
  const assumptions = buildAssumptions(input, instById);

  // ── §scenarios (optional; DATA in — the caller runs `evaluateWorlds` + passes the declarations) ──
  const scenarios: ScenariosSection | undefined =
    input.worlds && input.worlds.result.worlds.length > 1 ? buildScenarios(input.worlds, catalog, labels, instById) : undefined;

  // ── §4 architecture ──
  const archNodes: ArchNode[] = instances.map((i) => {
    const pos = input.layout?.[i.id];
    return {
      id: i.id,
      label: display(i.id),
      type: i.type,
      ...(pos ? { x: pos.x, y: pos.y } : {}),
    };
  });
  const archEdges: ArchEdge[] = wires.map((w) => {
    const src = instById.get(w.from[0]);
    const proto = edgeProtocol(catalog, src, w.from[1]);
    // the rate on the edge = the source's served throughput after any transform on the out port / wire.
    const served = value(w.from[0], keys.throughput);
    const t = w.transform ?? src?.transforms?.[w.from[1]] ?? catalog[src?.type ?? '']?.ports.find((p) => p.name === w.from[1])?.transform;
    const rate = served === undefined ? undefined : applyTransform(t, served);
    return {
      from: w.from[0],
      to: w.to[0],
      semantics: w.semantics ?? 'sync',
      ...(proto !== undefined ? { protocol: proto } : {}),
      ...(rate !== undefined ? { rateRps: rate } : {}),
    };
  });
  const architecture: ArchitectureSection = {
    nodes: archNodes,
    edges: archEdges,
    groups: groups.map((g) => ({ id: g.id, label: g.label, members: g.members })),
  };

  // ── §5 capacity ──
  const capacity = buildCapacity(input, sys, flows, busiest);

  // ── §6 simulation ──
  const simulation = buildSimulation(input, instances, sys);

  // ── §7 reliability ──
  const reliability = buildReliability(input, flows, slos);

  // ── §7b guarantees (optional; DATA in — the caller runs `guaranteeVerdicts`) ──
  const guarantees: GuaranteesSection | undefined =
    input.guaranteeVerdicts && input.guaranteeVerdicts.length > 0 ? { rows: input.guaranteeVerdicts } : undefined;

  // ── §8 cost ──
  const ownCost = localContribution(value, instances, wires, keys.cost);
  const perComponentSeries: ChartSeries = {
    label: 'Monthly cost by component',
    unit: 'USD/month',
    points: Object.entries(ownCost)
      .filter(([, c]) => c !== 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id, c]) => ({ label: display(id), value: c })),
  };
  const derivations = buildCostDerivations(input, ownCost, display);
  const cost: CostSection = { breakdown: sys.cost, perComponentSeries, derivations };

  // ── §9 alternatives (optional; DATA in) ──
  const alternatives: AlternativesSection | undefined =
    input.alternatives && input.alternatives.length > 0 ? { sets: input.alternatives } : undefined;

  // ── §10 risks & open questions ──
  const risks = buildRisks(verdicts, display);

  // ── §11 glossary ──
  const glossary = buildGlossary();

  const sectionOrder: SectionKey[] = [
    'summary',
    'requirements',
    'assumptions',
    ...(scenarios ? (['scenarios'] as const) : []),
    'architecture',
    'capacity',
    'simulation',
    'reliability',
    ...(guarantees ? (['guarantees'] as const) : []),
    'cost',
    ...(alternatives ? (['alternatives'] as const) : []),
    'risks',
    'glossary',
  ];

  return {
    name: input.name,
    ...(input.generatedAt !== undefined ? { generatedAt: input.generatedAt } : {}),
    sectionOrder,
    summary,
    requirements,
    assumptions,
    ...(scenarios ? { scenarios } : {}),
    architecture,
    capacity,
    simulation,
    reliability,
    ...(guarantees ? { guarantees } : {}),
    cost,
    ...(alternatives ? { alternatives } : {}),
    risks,
    glossary,
  };
}

// ── §3 assumptions register builder ─────────────────────────────────────────────────────────────────────────

function buildAssumptions(input: DocModelInput, instById: Map<string, Instance>): AssumptionRow[] {
  const { instances, wires, catalog, value } = input;
  const labels = input.labels ?? {};
  const display = (id: string): string => labels[id] || id;
  const rows: AssumptionRow[] = [];

  for (const inst of instances) {
    const m = catalog[inst.type];
    const cfg = inst.config ?? {};
    // Enumerate every key that either has an instance value OR a manifest default — the union, so both an
    // architect override and an untouched documented default are seen.
    const keySet = new Set<string>([
      ...Object.keys(cfg),
      ...((m?.config ?? []).map((c) => String(c.key))),
    ]);
    for (const key of keySet) {
      const def = manifestConfig(m, key);
      const instVal = cfg[key];
      const effective = instVal ?? def?.value;
      if (effective === undefined) continue;
      const { provenance, source } = configProvenance(instVal, def);
      // INCLUSION RULE: a documented / estimate / architect value is always worth a row (its provenance is the
      // whole point). A PLAIN default earns a row only if it participates in a verdict/capacity figure (the
      // curated REGISTER_DEFAULT_KEYS) — never every inert zero knob.
      if (provenance === 'default' && !REGISTER_DEFAULT_KEYS.has(key)) continue;
      // An ORIGIN of 0 is not an assumption anyone rests on (it means "this node originates nothing") — skip it
      // unless the architect set it; the same for a zeroed retry knob (no policy is not a policy).
      if ((key === String(keys.assumedRps) || key === String(keys.timeoutMs) || key === String(keys.retryCount) || key === String(keys.retryBackoffMs)) && effective === 0 && provenance !== 'architect') continue;
      rows.push({
        label: assumptionLabel(key),
        value: effective,
        unit: def?.unit ?? KEY_UNIT[key] ?? '1',
        provenance,
        ...(source !== undefined ? { source } : {}),
        where: display(inst.id),
      });
    }
    // Origin traffic that IS declared (a source's workload) — always an architect assumption worth naming.
    const origin = value(inst.id, keys.assumedRps);
    if (origin !== undefined && origin > 0 && !rows.some((r) => r.where === display(inst.id) && r.label === assumptionLabel(String(keys.assumedRps)))) {
      rows.push({ label: assumptionLabel(String(keys.assumedRps)), value: origin, unit: 'req/s', provenance: 'architect', where: display(inst.id) });
    }
    // SLO bands the architect declared on this instance — each is an assumption the verdicts rest on.
    for (const b of inst.bands ?? []) {
      const target = bandHeadline(b.band);
      if (target === undefined) continue;
      rows.push({ label: `SLO: ${assumptionLabel(String(b.key))}`, value: target, unit: KEY_UNIT[String(b.key)] ?? '1', provenance: 'architect', where: display(inst.id) });
    }
    // The deployment COST surcharge (task-77): when this node's cost relation carries `withDeploymentCost` AND the
    // mode raises the bill (RDS Multi-AZ standby ≈ 2×, multi-region ≈ 2.3×), the multiplier is a DOCUMENTED cost
    // assumption sourced from the RDS pricing page — a DIFFERENT source than the deploymentMode row's SLA (which the
    // AVAILABILITY derives from). Surfaced as its own `documented` row so the register links where the ≈2× comes from,
    // the same provenance shape `configProvenance` yields for a sourced config. The factor rides `value` (numeric
    // contract) with a verbatim `display` ("×2 (Multi-AZ)"), like the categorical guarantee rows.
    const surcharge = deploymentSurcharge((m?.relations ?? []).find((r) => String(r.key) === String(keys.cost)), value(inst.id, keys.deploymentMode) ?? 0);
    if (surcharge !== undefined) {
      rows.push({
        label: 'Deployment cost surcharge',
        value: surcharge.factor,
        unit: '×',
        display: `×${surcharge.factor} (${surcharge.label})`,
        provenance: 'documented',
        source: RDS_PRICING_SOURCE,
        where: display(inst.id),
      });
    }
  }

  // Flow transforms — every declared transform, at its LEVEL (wire / instance / manifest). The manifest-level
  // default now REACHES the register (the leftover this feature closes: the catalog is in the input).
  for (const w of wires) {
    const [srcNode, srcPort] = w.from;
    const src = instById.get(srcNode);
    const m = src ? catalog[src.type] : undefined;
    const wireT = w.transform;
    const instT = src?.transforms?.[srcPort];
    const manifestT = m?.ports.find((p) => p.name === srcPort)?.transform;
    const [t, level]: [Transform | undefined, TransformLevel] =
      wireT !== undefined ? [wireT, 'wire'] : instT !== undefined ? [instT, 'instance'] : manifestT !== undefined ? [manifestT, 'manifest'] : [undefined, 'manifest'];
    // A GENERATOR is an ORIGIN, not a reshaping: its level already appears in the register
    // as the node's "Offered traffic" row (the reconciled `assumedRps` cell, read below) — a second row here
    // would double-book the same fact under a transform label.
    if (t === undefined || t.kind === 'generate') continue;
    rows.push({
      label: 'Flow transform',
      value: t.value,
      unit: t.kind,
      // a wire/instance transform is the architect's hand; a manifest-default transform is an estimate (a CDN's
      // typical cache-hit ratio, a queue's batch) — badge it accordingly so the register tells the truth.
      provenance: level === 'manifest' ? 'estimate' : 'architect',
      where: `${display(srcNode)} → ${display(w.to[0])}`,
      transformLevel: level,
    });
  }

  // Declared GUARANTEE contributions. Each per-port token is an assumption the guarantee verdicts rest on, with its OWN
  // provenance (a documented `source` URL, or an est. flag) — the badge rides the source/est. data automatically,
  // exactly like a numeric config. Only ports the design actually USES are listed (the no-filler rule).
  for (const inst of instances) {
    const m = catalog[inst.type];
    for (const p of m?.ports ?? []) {
      const claims = claimsFor(p.guarantees);
      if (claims === undefined) continue;
      for (const c of claims) {
        rows.push({
          label: `Guarantee: ${String(c.dimension)}`,
          // The token is categorical, not a quantity — carried in `display`; `value` stays 0 / unit the dimension
          // so the numeric contract holds while the register shows the token verbatim.
          value: 0,
          unit: String(c.dimension),
          display: `${String(c.dimension)}: ${String(c.token)}`,
          provenance: c.source !== undefined ? 'documented' : 'estimate', // documented (has source) vs est. behaviour
          ...(c.source !== undefined ? { source: c.source } : {}),
          where: `${display(inst.id)} · ${p.name} port`,
        });
      }
    }
  }

  return rows;
}

/**
 * The honest end-to-end availability each request flow that CROSSES `node` delivers at its terminal (F4). For a
 * node-scoped availability promise ("≥ 99.9% at the CDN"), a reader must see the cumulative a request actually gets
 * over the whole path — a mid-path node with 99.99% own availability can sit on a flow whose terminal reaches only
 * 99.58%. Returns one entry per crossing flow where the node is NOT the terminal (a terminal's cumulative IS its
 * node value — nothing to contrast); `belowPromise` flags the ones that fall short of the node's own floor/target,
 * so the renderer can expose the "misleading green". Pure: reads the flow terminals' solved availability.
 */
export function pathAvailabilityFor(
  node: string,
  flows: readonly RequestFlow[],
  value: ValueFn,
  promise: number | undefined,
): EndToEndAvailability[] {
  const out: EndToEndAvailability[] = [];
  for (const f of flows) {
    if (f.terminal === node || !f.ids.includes(node)) continue; // the terminal's cumulative IS the node value — skip
    const avail = value(f.terminal, keys.availability);
    if (avail === undefined) continue;
    out.push({ source: f.source, terminal: f.terminal, availability: avail, belowPromise: promise !== undefined && avail < promise - 1e-12 });
  }
  return out;
}

/** The single headline number of a band (a min floor, a point target, a soft target, or the first percentile),
 *  for the assumptions register's value column. undefined for an all-open band (nothing to assume). */
function bandHeadline(band: Band): number | undefined {
  if (band.shape === 'point') return band.target;
  if (band.shape === 'percentiles') return [...band.targets][0]?.[1];
  return band.min ?? band.target ?? band.max;
}

// ── §scenarios (assumption-model doc §8) builder ──────────────────────────────────────────────────────────────

/** The unit an override VALUE reads in (for the world row's overrides cell): the manifest config's declared unit, or
 *  the registry's known unit for the key, else '' (a renderer shows the bare number). Read off the catalog — never
 *  guessed. */
function overrideUnit(catalog: Readonly<Record<string, Manifest>>, instById: Map<string, Instance>, node: string, key: string): string {
  const inst = instById.get(node);
  const m = inst ? catalog[inst.type] : undefined;
  const cfg = m?.config?.find((c) => String(c.key) === key);
  return cfg?.unit ?? KEY_UNIT[key] ?? '';
}

/**
 * Build the scenario-comparison section (assumption-model doc §8) from the evaluated worlds + their declarations.
 * Pure: every field is read off the `WorldSummary` (cost / verdicts / peakRho / stale) or the `AssumptionScenario`
 * overrides (the provenance mix + the key deltas the evaluated world does NOT carry). The caller gates on there being
 * a named world (a result with more than the base world), so this always yields a non-trivial table.
 */
function buildScenarios(
  worlds: DocWorldsInput,
  catalog: Readonly<Record<string, Manifest>>,
  labels: Readonly<Record<string, string>>,
  instById: Map<string, Instance>,
): ScenariosSection {
  const declById = new Map(worlds.scenarios.map((s) => [s.id, s]));
  const display = (id: string): string => labels[id] || id;
  const rows: ScenarioWorldRow[] = worlds.result.worlds.map((w): ScenarioWorldRow => {
    const decl = w.id === 'base' ? undefined : declById.get(w.id);
    const overrides: ScenarioOverrideCell[] = (decl?.overrides ?? []).map((o) => ({
      node: o.node,
      key: o.key,
      value: o.value,
      unit: overrideUnit(catalog, instById, o.node, o.key),
      ...(o.provenance !== undefined ? { provenance: o.provenance } : {}),
    }));
    return {
      id: w.id,
      name: w.id === 'base' ? 'Base (as authored)' : w.name ?? display(w.id),
      isBase: w.id === 'base',
      costUsdMonth: w.costUsdMonth,
      feasible: w.feasible,
      violations: w.violations,
      ...(w.peakRho !== undefined ? { peakRho: w.peakRho } : {}),
      // The DISTINCT cells that break (a ρ≥1 saturation verdict and an overflow-band verdict can both key the same
      // cell) — a set, so the row never reads "app.overflow, app.overflow". The `violations` COUNT stays the raw
      // verdict tally (the shared System-panel truth); this is the readable named-set beside it.
      brokenSlos: [...new Set(w.verdicts.filter((v) => v.status === 'violation').map((v) => `${v.scope}.${v.key}`))],
      derivedCount: overrides.filter((o) => o.provenance === 'derived').length,
      architectCount: overrides.filter((o) => o.provenance === 'architect').length,
      overrides,
      staleOverrides: w.staleOverrides,
    };
  });
  const costSeries: ChartSeries = {
    label: 'Monthly cost by world',
    unit: 'USD/month',
    points: rows.map((r) => ({ label: r.name, value: r.costUsdMonth })),
  };
  return { worlds: rows, costSeries };
}

// ── §5 capacity builder ─────────────────────────────────────────────────────────────────────────────────────

function buildCapacity(
  input: DocModelInput,
  sys: ReturnType<typeof systemSummary>,
  flows: ReturnType<typeof requestFlows>,
  busiest: ReturnType<typeof systemSummary>['flows'][number] | undefined,
): CapacitySection {
  const { instances, wires, value } = input;
  const labels = input.labels ?? {};
  const display = (id: string): string => labels[id] || id;
  const saturatedSet = new Set(input.saturated ?? []);

  // The MEASURED flow latency (owner ruling: single-truth measured-or-nothing) — the flow terminal's DES response
  // mean when the run recorded one, else the busiest-flow measured p50 for a single-flow design, else absent (`no
  // data`). NEVER the analytic `realLatencyByNode` (which stays computed below but is shown on no surface).
  const flowCount = sys.flows.length;
  const measuredLatencyMs = (terminal: string): number | undefined => {
    const node = input.responsePercentilesByNode?.[terminal];
    if (node !== undefined && Number.isFinite(node.mean)) return node.mean;
    if (flowCount === 1 && input.tail !== undefined && Number.isFinite(input.tail.p50)) return input.tail.p50;
    return undefined;
  };
  const flowRows: FlowRow[] = sys.flows.map((f) => {
    const measured = measuredLatencyMs(f.terminal);
    return {
      source: f.source,
      terminal: f.terminal,
      ...(f.throughputRps !== undefined ? { throughputRps: f.throughputRps } : {}),
      ...(measured !== undefined ? { measuredLatencyMs: measured } : {}),
      // COMPUTED but rendered nowhere (owner ruling) — kept so the analytic waterfall/sweep diagnostics stay whole.
      ...(input.realLatencyByNode?.[f.terminal] !== undefined ? { realLatencyMs: input.realLatencyByNode[f.terminal] } : {}),
      ...(f.latencyMs !== undefined ? { idealLatencyMs: f.latencyMs } : {}),
      ...(f.availability !== undefined ? { availability: f.availability } : {}),
      ...(f.costUsdMonth !== undefined ? { costUsdMonth: f.costUsdMonth } : {}),
    };
  });

  // per-tier capacity: offered = inflow, capacity = self throughput; ρ = offered/capacity. The inflow MUST be
  // transform-aware — a wire split (prob 0.7), a fan-out (ratio 100) or a CDN's manifest cache ratio reshapes what
  // actually ARRIVES; summing the raw predecessor throughput would report a false ρ (e.g. a 0.3-split tier reading
  // ρ = 3.3 while the queue model — which IS transform-aware — shows it has headroom). We resolve each inbound
  // edge's effective transform (wire > per-instance port > manifest port default), the SAME precedence the
  // architecture edges and the queue model use, so the capacity table's ρ agrees with the saturation state.
  const catalog = input.catalog;
  const instById = new Map(instances.map((i) => [i.id, i]));
  const arrivingRate = (w: Wire): number => {
    const served = value(w.from[0], keys.throughput) ?? 0;
    const src = instById.get(w.from[0]);
    const t = w.transform ?? src?.transforms?.[w.from[1]] ?? catalog[src?.type ?? '']?.ports.find((p) => p.name === w.from[1])?.transform;
    return applyTransform(t, served);
  };
  const inflowOf = (id: string): number => {
    const preds = wires.filter((w) => w.to[0] === id);
    if (preds.length === 0) return value(id, keys.assumedRps) ?? value(id, keys.throughput) ?? 0;
    return preds.reduce((s, w) => s + arrivingRate(w), 0);
  };
  const tiers: CapacityRow[] = instances
    .filter((i) => wires.some((w) => w.to[0] === i.id)) // tiers that RECEIVE work (a pure source has no capacity row)
    .map((i) => {
      const served = value(i.id, keys.throughput);
      const offered = inflowOf(i.id);
      const overflow = value(i.id, keys.overflow);
      const util = served !== undefined && served > 0 ? offered / served : undefined;
      return {
        node: i.id,
        offeredRps: offered,
        ...(served !== undefined ? { capacityRps: served } : {}),
        ...(util !== undefined ? { utilization: util } : {}),
        saturated: saturatedSet.has(i.id),
        ...(overflow !== undefined ? { overflowRps: overflow } : {}),
      };
    });

  const utilizationSeries: ChartSeries = {
    label: 'Utilisation (ρ) by tier',
    unit: 'ratio',
    points: tiers.filter((t) => t.utilization !== undefined).map((t) => ({ label: display(t.node), value: t.utilization as number })),
  };

  // latency waterfall: per-node OWN latency along the busiest flow (ordered source→terminal by the flow's ids).
  const flow = flows.find((f) => f.terminal === busiest?.terminal);
  const waterfallPoints = (flow?.ids ?? [])
    .map((id) => ({ label: display(id), value: ownLatency(value, wires, id) }))
    .filter((p) => p.value !== undefined) as { label: string; value: number }[];
  const latencyWaterfall: ChartSeries = { label: 'Latency budget (per-tier own latency)', unit: 'ms', points: waterfallPoints };

  const loadSweep: ChartSeries | undefined = input.sweep && input.sweep.length > 0
    ? { label: 'End-to-end latency vs offered load', unit: 'ms', points: input.sweep.map((p) => ({ label: `${p.offeredRps}`, value: p.latencyMs })) }
    : undefined;

  const transforms = buildTransformRows(input);

  // Per-node SIMULATED response percentiles — the DES tail, shown for the
  // REQUIREMENT-BEARING nodes only (a latency/tailLatency band): the display commits full percentiles where the
  // architect asked for a latency SLO, matching the canvas chip / Inspector row. A node absent from the run's map is
  // skipped honestly; with no map at all (no sim) the field is omitted and no table renders (the no-filler rule).
  const respPctMap = input.responsePercentilesByNode;
  const respPct: NodeResponsePercentileRow[] = respPctMap
    ? instances
        .filter((i) => (i.bands ?? []).some((b) => String(b.key) === String(keys.latency) || String(b.key) === String(keys.tailLatency)))
        .map((i) => { const r = respPctMap[i.id]; return r === undefined ? undefined : { node: i.id, mean: r.mean, p50: r.p50, p95: r.p95, p99: r.p99, samples: r.samples }; })
        .filter((r): r is NodeResponsePercentileRow => r !== undefined)
    : [];

  return {
    flows: flowRows,
    tiers,
    utilizationSeries,
    latencyWaterfall,
    ...(loadSweep ? { loadSweep } : {}),
    transforms,
    ...(input.responseLatencyByNode ? { responseLatencyByNode: input.responseLatencyByNode } : {}),
    ...(input.lagVerdicts && input.lagVerdicts.length > 0 ? { lag: input.lagVerdicts } : {}),
    ...(respPct.length > 0 ? { responsePercentiles: respPct } : {}),
  };
}

/** A node's OWN latency = cumulative latency − max predecessor cumulative latency (the sum-aggregation inverse
 *  along the critical path). undefined when the engine has no latency for it. */
function ownLatency(value: ValueFn, wires: readonly Wire[], id: string): number | undefined {
  const cum = value(id, keys.latency);
  if (cum === undefined) return undefined;
  const preds = wires.filter((w) => w.to[0] === id);
  const maxPred = preds.reduce((m, w) => Math.max(m, value(w.from[0], keys.latency) ?? 0), 0);
  return Math.max(0, cum - maxPred);
}

function buildTransformRows(input: DocModelInput): TransformRow[] {
  const { instances, wires, catalog, value } = input;
  const instById = new Map(instances.map((i) => [i.id, i]));
  const rows: TransformRow[] = [];
  for (const w of wires) {
    const [srcNode, srcPort] = w.from;
    const [dstNode, dstPort] = w.to;
    const src = instById.get(srcNode);
    const dst = instById.get(dstNode);
    const fOut = w.transform ?? src?.transforms?.[srcPort] ?? catalog[src?.type ?? '']?.ports.find((p) => p.name === srcPort)?.transform;
    const fIn = dst?.transforms?.[dstPort] ?? catalog[dst?.type ?? '']?.ports.find((p) => p.name === dstPort)?.transform;
    const served = value(srcNode, keys.throughput);
    if (fOut !== undefined) {
      // OUT transform: the source's served throughput ENTERS, the transform emits `applyTransform(fOut, served)`.
      const rate = served === undefined ? undefined : applyTransform(fOut, served);
      rows.push({ from: srcNode, to: dstNode, transform: fOut, side: 'out', ...(served !== undefined ? { enteringRps: served } : {}), ...(rate !== undefined ? { resultingRps: rate } : {}) });
    }
    if (fIn !== undefined) {
      // IN transform: what ARRIVES is the post-OUT rate (served folded through any out transform); the in transform
      // then shapes it. So entering = afterOut, leaving = applyTransform(fIn, afterOut).
      const afterOut = served === undefined ? undefined : applyTransform(fOut, served);
      const rate = afterOut === undefined ? undefined : applyTransform(fIn, afterOut);
      rows.push({ from: srcNode, to: dstNode, transform: fIn, side: 'in', ...(afterOut !== undefined ? { enteringRps: afterOut } : {}), ...(rate !== undefined ? { resultingRps: rate } : {}) });
    }
  }
  return rows;
}

// ── §6 simulation builder ───────────────────────────────────────────────────────────────────────────────────

function buildSimulation(input: DocModelInput, instances: readonly Instance[], sys: ReturnType<typeof systemSummary>): SimulationSection {
  const timeoutKey = String(keys.timeoutMs);
  const retryKey = String(keys.retryCount);
  const retryCallers = instances.filter((i) => Number(i.config?.[timeoutKey] ?? 0) > 0);
  const hasPolicy = retryCallers.length > 0;
  const offered = sys.flows.reduce((s, f) => s + (f.throughputRps ?? 0), 0);
  return {
    ...(input.tail ? { tail: input.tail } : {}),
    // The retry story is present ONLY when a policy is declared AND the caller measured an outcome — otherwise
    // goodput/errors/amplification are vacuous (the scalar pass never computes them). No policy ⇒ no story (§6).
    ...(hasPolicy && input.retry
      ? {
          retry: {
            goodputRps: input.retry.goodputRps,
            errorRate: input.retry.errorRate,
            amplification: input.retry.amplification,
            ...(offered > 0 ? { offeredRps: offered } : {}),
            callers: retryCallers.map((i) => ({ node: i.id, timeoutMs: Number(i.config?.[timeoutKey] ?? 0), retryCount: Number(i.config?.[retryKey] ?? 0) })),
          },
        }
      : {}),
  };
}

// ── §7 reliability builder ──────────────────────────────────────────────────────────────────────────────────

function buildReliability(input: DocModelInput, flows: ReturnType<typeof requestFlows>, slos: { node: string; band: ManifestBand }[]): ReliabilitySection {
  const { instances, wires, value } = input;
  const rows: ReliabilityRow[] = [];
  const own = localOwnAvailability(value, instances, wires);
  for (const f of flows) {
    const avail = value(f.terminal, keys.availability);
    if (avail === undefined) continue;
    const tier = availabilityTier(avail);
    // weakest hard dependency = smallest own-availability factor on the flow.
    let weakest: { node: string; availability: number } | undefined;
    for (const id of f.ids) {
      const a = own[id];
      if (a === undefined) continue;
      if (!weakest || a < weakest.availability) weakest = { node: id, availability: a };
    }
    const target = slos.find((s) => s.node === f.terminal && String(s.band.key) === String(keys.availability));
    const tgt = target ? bandHeadline(target.band.band) : undefined;
    rows.push({
      source: f.source,
      terminal: f.terminal,
      availability: avail,
      ...(tier ? { tier: { availability: tier.availability, maxDowntimePerYear: tier.maxDowntimePerYear, applicationCategories: tier.applicationCategories } } : {}),
      ...(weakest ? { weakestDependency: weakest } : {}),
      ...(tgt !== undefined ? { targetAvailability: tgt, meetsTarget: avail >= tgt - 1e-12 } : {}),
    });
  }
  return { flows: rows, source: RELIABILITY_SOURCES.availability };
}

// ── §8 cost-derivation builder (2026-07-03 §3: show the arithmetic behind each figure) ────────────────────────

/**
 * Build one CostDerivation per priced component — the arithmetic behind its monthly figure — so the register can
 * SHOW "driver × unit-price = cost" inline instead of a bare number (the owner's honesty ask, 2026-07-03 §3). The
 * cost MODEL is DETECTED from the component's `cost` relation (behaviors.ts THE COST MODEL), never guessed:
 *   - `self(unitCost)` alone                → `flat`         (the base IS the figure)
 *   - `self(throughput) * self(unitCost)`   → `provisioned`  (reserved capacity ceiling × price)
 *   - `inflow(throughput) * self(unitCost)` → `pay-per-use`  (OFFERED load × price)
 *   - `<driver> * self(unitCost)`           → `per-unit`     (a local unit count × price)
 * The deployment surcharge (`withDeploymentCost` wraps the base in `(…) * (1 + STANDBY·(mode≥1) + …)`) is peeled
 * off and reported as a separate FACTOR, so the row reads "… ×2 Multi-AZ" honestly. Every quantity is READ off the
 * model (`value`, the manifest config) — this function computes no cost the engine didn't; `totalUsdMonth` is the
 * engine's own `cost` value, so the shown arithmetic can never disagree with the total.
 */
function buildCostDerivations(
  input: DocModelInput,
  ownCost: Readonly<Record<string, number>>,
  display: (id: string) => string,
): CostDerivation[] {
  const { instances, wires, catalog, value } = input;
  const instById = new Map(instances.map((i) => [i.id, i]));
  // The OFFERED load into a node = the transform-aware sum of arriving edge rates (the same rule the capacity
  // table's ρ and the queue model use), or the node's own origin/throughput when it is a pure source. Pay-per-use
  // bills on THIS (inflow), so it must match what the capacity section shows arriving.
  const arrivingRate = (w: Wire): number => {
    const served = value(w.from[0], keys.throughput) ?? 0;
    const src = instById.get(w.from[0]);
    const t = w.transform ?? src?.transforms?.[w.from[1]] ?? catalog[src?.type ?? '']?.ports.find((p) => p.name === w.from[1])?.transform;
    return applyTransform(t, served);
  };
  const inflowOf = (id: string): number => {
    const preds = wires.filter((w) => w.to[0] === id);
    if (preds.length === 0) return value(id, keys.assumedRps) ?? value(id, keys.throughput) ?? 0;
    return preds.reduce((s, w) => s + arrivingRate(w), 0);
  };

  const derivations: CostDerivation[] = [];
  for (const inst of instances) {
    const own = ownCost[inst.id];
    if (own === undefined || own === 0) continue; // only priced components earn a derivation row (never a $0 pad)
    const m = catalog[inst.type];
    const rel = (m?.relations ?? []).find((r) => String(r.key) === String(keys.cost));
    if (rel === undefined) continue; // a component with a cost figure but no cost relation is a catalog oddity — skip
    const unitPrice = value(inst.id, keys.unitCost);
    if (unitPrice === undefined) continue; // every priced model reads unitCost; without it there is no arithmetic
    const unitPriceUnit = (m?.config ?? []).find((c) => String(c.key) === String(keys.unitCost))?.unit ?? 'USD/month';

    const { base, deployment } = costModelOf(rel, inst, value, inflowOf);
    derivations.push({
      node: display(inst.id),
      model: base.model,
      ...(base.driverValue !== undefined ? { driverValue: base.driverValue } : {}),
      ...(base.driverLabel !== undefined ? { driverLabel: base.driverLabel } : {}),
      ...(base.driverUnit !== undefined ? { driverUnit: base.driverUnit } : {}),
      unitPrice,
      unitPriceUnit,
      ...(deployment ? { deploymentFactor: deployment.factor, deploymentLabel: deployment.label } : {}),
      totalUsdMonth: own,
    });
  }
  // Largest first, mirroring the cost chart's ordering so the reader scans them the same way.
  return derivations.sort((a, b) => b.totalUsdMonth - a.totalUsdMonth);
}

/**
 * The deployment COST surcharge a node's `cost` relation carries at a given deployment `mode`, or `undefined` when it
 * carries none (single-AZ, or a relation without `withDeploymentCost`). Detects the surcharge by the `deploymentMode`
 * reference `withDeploymentCost` folds in, then reconstructs the SAME step-function factor the relation uses (never
 * re-parsing its arithmetic), reporting it only when the mode actually lifts the cost (mode ≥ 1). Sourced by
 * RDS_PRICING_SOURCE (RDS Multi-AZ ≈ 2× standby, task-77) — the §8 cost derivation and the §3 assumptions register
 * both read this ONE detection so the badged factor + label can never drift between them.
 */
function deploymentSurcharge(rel: ManifestRelation | undefined, mode: number): { factor: number; label: string } | undefined {
  if (rel === undefined || !/deploymentMode/.test(rel.expr)) return undefined;
  const factor = 1 + MULTI_AZ_COST_STANDBY * (mode >= 1 ? 1 : 0) + MULTI_REGION_COST_EXTRA * (mode >= 2 ? 1 : 0);
  return factor > 1 ? { factor, label: mode >= 2 ? 'multi-region' : 'Multi-AZ' } : undefined;
}

/** The parts of a component's cost model, read off its `cost` relation `expr`. `base` is the driver × price shape;
 *  `deployment` is the surcharge factor when the relation carries `withDeploymentCost` AND the mode raises it. */
function costModelOf(
  rel: ManifestRelation,
  inst: Instance,
  value: ValueFn,
  inflowOf: (id: string) => number,
): {
  base: { model: CostModelKind; driverValue?: number; driverLabel?: string; driverUnit?: string };
  deployment?: { factor: number; label: string };
} {
  // Peel the deployment surcharge (the SAME detection the §3 register badges, so the two never drift): report the
  // step-function factor only when the mode actually lifts the cost (mode ≥ 1).
  const deployment = deploymentSurcharge(rel, value(inst.id, keys.deploymentMode) ?? 0);

  // The base shape, matched against behaviors.ts's four cost relations (self/inflow throughput vs a local driver).
  // A `driverValue` that the engine did not compute stays absent (exactOptionalPropertyTypes) — the renderer then
  // shows the model + price without a fabricated left operand rather than a bogus "undefined × price".
  const withDriver = (
    model: CostModelKind,
    driverValue: number | undefined,
    driverLabel: string,
    driverUnit: string,
  ): { model: CostModelKind; driverValue?: number; driverLabel?: string; driverUnit?: string } => ({
    model,
    ...(driverValue !== undefined ? { driverValue } : {}),
    driverLabel,
    driverUnit,
  });
  const base = ((): { model: CostModelKind; driverValue?: number; driverLabel?: string; driverUnit?: string } => {
    if (/self\(throughput\)/.test(rel.expr)) return withDriver('provisioned', value(inst.id, keys.throughput), 'reserved capacity', 'req/s');
    if (/inflow\(throughput\)/.test(rel.expr)) return withDriver('pay-per-use', inflowOf(inst.id), 'offered load', 'req/s');
    // A `<driver> * self(unitCost)` count model (costPer): the driver is the non-unitCost read. Name it from the key.
    const driverKey = rel.reads.map(String).find((k) => k !== String(keys.unitCost));
    if (driverKey !== undefined && new RegExp(`\\b${driverKey}\\b`).test(rel.expr)) {
      return withDriver('per-unit', value(inst.id, Key(driverKey)), driverLabelOf(driverKey), driverUnitOf(driverKey));
    }
    return { model: 'flat' }; // `self(unitCost)` alone — the base is the whole figure, no driver
  })();

  return deployment ? { base, deployment } : { base };
}

/** A human noun for a per-unit cost driver (the count the base multiplies). */
function driverLabelOf(key: string): string {
  if (key === String(keys.replicas)) return 'replicas';
  if (key === String(keys.requiredUnits)) return 'required units';
  if (key === String(keys.concurrency)) return 'concurrency';
  return key;
}
/** The unit for a per-unit cost driver's left operand ("replicas", "units", "conc"). */
function driverUnitOf(key: string): string {
  if (key === String(keys.replicas)) return 'replicas';
  if (key === String(keys.requiredUnits)) return 'units';
  if (key === String(keys.concurrency)) return 'conc';
  return '';
}

// ── §10 risks builder ───────────────────────────────────────────────────────────────────────────────────────

function buildRisks(verdicts: readonly Verdict[], display: (id: string) => string): RisksSection {
  const items: RiskItem[] = [];
  for (const v of verdicts) {
    const node = display(String(v.scope));
    const key = String(v.key);
    if (v.status === 'violation' || v.status === 'warning') {
      const cause = v.cause[v.cause.length - 1] ?? v.cause[0];
      items.push({
        severity: v.status,
        node,
        key,
        note: cause?.note ?? `${key} at ${node} is out of band`,
        ...(v.remediations[0]?.action !== undefined ? { fix: v.remediations[0].action } : {}),
      });
    } else if (v.status === 'unknown' || v.status === 'did-not-converge') {
      // Every `unknown` is a risk WITH what would resolve it (honesty about ignorance — never a silent blank).
      items.push({
        severity: 'unknown',
        node,
        key,
        note: `${key} at ${node} could not be computed on the scalar pass`,
        resolvedBy: resolveHint(key),
      });
    }
  }
  return { items };
}

/** What resolves an `unknown` for a given key — the tail/goodput keys are simulator-only; others need a value. */
function resolveHint(key: string): string {
  if (key === String(keys.tailLatency)) return 'run the simulation (the p99 tail is a DES result, not a scalar)';
  if (key === String(keys.goodputRps) || key === String(keys.errorRate)) return 'run the simulation with the declared retry policy';
  return 'set the missing input or connect the tier so the engine can compute it';
}

// ── §11 glossary (static) ───────────────────────────────────────────────────────────────────────────────────

function buildGlossary(): GlossarySection {
  return {
    entries: [
      { term: 'verified model', definition: 'the canvas design plus everything the engines computed about it — the single source every figure in this document comes from.' },
      { term: 'assumption', definition: 'any input number the computation rests on: an offered load, a timeout, a cache-hit ratio.' },
      { term: 'provenance', definition: 'where a number came from: an official document, an estimate, the architect, or a catalog default.' },
      { term: 'utilisation (ρ)', definition: 'offered load ÷ capacity for a tier; ρ ≥ 1 means the tier is saturated and its queue grows without bound.' },
      // The single most common misreading of the whole document (2026-07-03 §4): the declared traffic is a
      // 24/7 SUSTAINED AVERAGE, not a peak. Every capacity, utilisation and monthly-cost figure follows from it —
      // an architect who typed a peak here is over-provisioning and over-costing, so we spell the contract out.
      { term: 'declared traffic (offered load)', definition: 'the request rate the design is sized for, read as a SUSTAINED 24/7 AVERAGE — not a peak. Monthly volumes and costs follow directly from it: 2,000 req/s ≈ 5.3 billion requests/month. If you meant a peak, scale it down to the average (or size explicitly for the peak and note the headroom).' },
      { term: 'C4 container view', definition: 'C4 is Simon Brown’s standard notation for software architecture at four zoom levels; this is the container level. A container = a separately runnable unit — an application, a database, a message broker.' },
      { term: 'DES / simulation', definition: 'SDA’s discrete-event simulation — replays the system over time for latency percentiles and retry behaviour that averages cannot give.' },
    ],
    provenanceLegend: [
      { badge: 'documented', meaning: 'sourced from an official document (linked).' },
      { badge: 'estimate', meaning: 'marked an estimate in the catalog — credible but not a published number.' },
      { badge: 'architect', meaning: 'set by hand in this design.' },
      { badge: 'default', meaning: 'an untouched catalog default that participates in the numbers.' },
    ],
  };
}
