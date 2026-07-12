// @sda/content — the SDA content pack. All system-design meaning lives here as DATA; the engine stays
// domain-agnostic. The seed property registry, the seed component catalog, and the content→Graph compiler.
export { keys, registry, roles, roleOf, polarityOf, isFactAssumption, type Role, type Polarity, type KeyRole } from './registry';
export {
  computeEnvelope,
  type EnvelopeInput,
  type EnvelopeResult,
  type OriginEnvelope,
  type JointEnvelope,
  type EnvelopeKnee,
  type EnvelopeBreak,
  type EnvelopeBasis,
} from './envelope';
export {
  hasScenarios,
  scenarioProblems,
  overrideRoleProblem,
  isScenarioOverridable,
  toContractScenario,
  applyScenarioToGraph,
  evaluateWorlds,
  evaluateWorldsSync,
  type EvaluateGraph,
  type AssumptionScenario,
  type ScenarioOverride,
  type OverrideProvenance,
  type WorldsInput,
  type WorldsResult,
  type WorldSummary,
  type WorldVerdict,
} from './scenario';
export {
  deriveDefaultScenarios,
  refreshDerivedScenarios,
  mergeDerivedTrio,
  resetScenario,
  DERIVED_DEMAND_FRACTIONS,
  type DeriveInput,
  type DerivedTrioResult,
} from './derived-scenarios';
export {
  categorical,
  guaranteeDimensions,
  dims,
  consistency,
  ordering,
  delivery,
  writerGuarantees,
  replicaGuarantees,
  asyncProjectionGuarantees,
  sqsStandardOut,
  sqsFifoOut,
  fanoutOut,
  rabbitmqOut,
  natsOut,
  kafkaOut,
  dynamodbGuarantees,
  searchGuarantees,
  cacheReadGuarantees,
  catalogGuaranteeContributions,
  claimsFor,
  type GuaranteeClaim,
  type GuaranteeContribution,
} from './guarantees';
export { flowGuarantees, type FlowGuaranteeSummary } from './guarantee-flows';
export {
  guaranteeVerdicts,
  guaranteeVerdictRow,
  hasGuaranteeSlos,
  type GuaranteeSlo,
  type GuaranteeVerdict,
  type GuaranteeRemediation,
} from './guarantee-slo';
export { manifests } from './catalog';
export { voiceManifests } from './voice';
export { commonManifests } from './common';
export { fargateManifests } from './fargate';
export { allManifests } from './all-manifests';
export {
  protocols,
  protocolIds,
  protocolCompat,
  protocolNote,
  referencedProtocols,
  unknownProtocols,
  allCatalogs,
  type Protocol,
} from './protocols';
export { toQueueingNetwork, cyclesToProfile } from './sim';
export {
  LOAD_STAGES_DEFAULTS,
  LOAD_STAGES_SOURCES,
  LOAD_STAGES_PRESETS,
  STRESS_DEFAULTS,
  cycleToProfile,
  cycleMultiplier,
  generatorRate,
  derivedMean,
  derivedPeak,
  combinedCycleProfile,
  observationSpanS,
  slowestPeriodS,
  fastestPeriodS,
  shortestFeatureStageS,
  shapeSeries,
  type LoadStagePreset,
} from './load-stages';
export { timeSweep, shapedOriginsOf, peakLoadByNode, type TimeSweep, type TimeSweepWindow, type TimeSweepInput, type ShapedOrigin, type NodePeak } from './time-sweep';
export {
  twoTierEvaluation,
  tier2Job,
  runTier2,
  TRANSIENT_BASIS,
  type TwoTierResult,
  type TwoTierInput,
  type Tier2Result,
  type Tier2Job,
  type Tier2Window,
  type Tier2Backlog,
  type Tier2Budget,
  type Tier2Phases,
  type StressVerdict,
} from './two-tier';
export { nodeQueues, nodeCapacityRps, realCumulativeLatency, responseLatency, latencyBreakdown, lagLowerBoundMs, type NodeQueue, type LatencyParts } from './queueing';
export {
  lagVerdicts,
  lagVerdictRow,
  hasLagSlos,
  type LagSlo,
  type LagVerdict,
  type LagBasis,
  type LagProvider,
} from './lag-slo';
export { realAwareVerdicts, checkGoodputBands, type SimOutcome } from './verdict';
export {
  SYSTEM_PROMISE_KEYS,
  isSystemPromiseKey,
  hasSystemPromises,
  costPromise,
  systemPromiseVerdicts,
  systemBandsOf,
  type SystemPromise,
  type SystemPromiseVerdict,
  type SystemBandSpec,
} from './system-promise';
export {
  compileClasses,
  hasClasses,
  originByNode,
  classDeclProblems,
  cyclicFlowDiagnosis,
  type RequestClassDecl,
  type WireRef,
  type ClassOrigin,
} from './request-class';
export { provisioningTunables, quantizeKnob, DISCRETE_KNOBS } from './provision';
export { robustRepair, robustOptimize, type RobustInput, type RobustChange, type RobustOutcome } from './robust';
export { TARGET_UTILIZATION, egress } from './behaviors';
export {
  localContribution,
  localOwnAvailability,
  requestFlows,
  systemSummary,
  hasTrafficOrigin,
  NO_ORIGIN_REASON,
  type ValueFn,
  type RequestFlow,
  type FlowMetrics,
  type SystemSummary,
  type CostBreakdown,
} from './system';
export {
  RELIABILITY_SOURCES,
  AVAILABILITY_TIERS,
  DR_TIERS,
  availabilityTier,
  recommendDrTier,
  reliabilityAdvice,
  type AvailabilityTier,
  type DrTier,
  type ReliabilityAdvice,
} from './reliability';
export { generateDesignDoc, renderDesignDocHtml, type DesignDocInput } from './design-doc';
export { simResultForDoc, mergeMeasuredVerdicts, type DocSimResult } from './doc-sim';
export {
  buildDocModel,
  pathAvailabilityFor,
  SCOPE_SENTENCE,
  SCOPE_STATEMENT,
  VERIFIED_SCOPE_HINT,
  type DocModel,
  type DocModelInput,
  type DocGroup,
  type DocAlternative,
  type DocAlternativeSet,
  type DocSweepPoint,
  type Provenance,
  type TransformLevel,
  type AssumptionRow,
  type SectionKey,
  type SummarySection,
  type RequirementRow,
  type EndToEndAvailability,
  type NodeResponsePercentiles,
  type ArchitectureSection,
  type CapacitySection,
  type SimulationSection,
  type ReliabilitySection,
  type GuaranteesSection,
  type GuaranteeReqRow,
  type LagReqRow,
  type CostSection,
  type AlternativesSection,
  type RisksSection,
  type RiskItem,
  type GlossarySection,
  type ChartSeries,
  type DocWorldsInput,
  type ScenariosSection,
  type ScenarioWorldRow,
  type ScenarioOverrideCell,
} from './doc-model';
export { renderHtml, esc } from './render-html';
export { formatMs, formatMsDigits } from './format-ms';
export { buildLoadSweep, originNodes, SWEEP_FACTORS, type LoadSweepInput, type OriginNode } from './sweep';
export { synthesize, type SynthSpec, type SynthSlot, type SynthDeps, type RankedDesign } from './synthesize';
export { familyOf, specForNode, specFromSlots, ARCHETYPES, type SlotReq, type SloReq } from './synth-spec';
export {
  generatorLevelOf,
  generatorsOf,
  instantiate,
  isTriangularRange,
  rangeProblem,
  type ClassContext,
  type ResolvedGenerator,
  type InstantiateError,
  type Instance,
  type Manifest,
  type ManifestBand,
  type ManifestConfig,
  type ManifestPort,
  type ManifestRelation,
  type Range,
  type UniformRange,
  type TriangularRange,
  type Wire,
} from './manifest';
export {
  runUncertainty,
  rangedInputsOf,
  hasRanges,
  DEFAULT_SCENARIOS,
  MAX_SCENARIOS,
  DEFAULT_SEED,
  HISTOGRAM_BINS,
  type UncertaintyInput,
  type UncertaintyResult,
  type MetricDistribution,
  type HistogramBin,
  type Percentiles,
  type SloConfidence,
  type TornadoRow,
  type RangedInput,
  type RangedInputSummary,
} from './uncertainty';
