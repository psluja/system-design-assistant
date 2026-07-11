// @sda/calibration — the calibration harness (TASK-93). A DATA corpus of measured ground-truth systems plus a
// deterministic fitter that predicts each with SDA's engine, fits the tunable component defaults, and reports the
// residual (the structural gaps no tunable can remove). It READS content and FITS + REPORTS; it NEVER mutates a
// shipped default — applying a recommendation is a separate, owner-reviewed step (Job 3).

export {
  loadCorpus,
  calibrationRoot,
  isFitted,
  tunableId,
  type CalibrationEntry,
  type GroundTruth,
  type LoadedEntry,
  type LoadedModel,
  type MetricKind,
  type Source,
  type Tunable,
  type TunableFit,
  type TunablePinned,
  type TunableRange,
  type TunableSelector,
} from './corpus';
export { predictMetric, desCorroboration, type DesTail, type Regime, type TunableValues } from './predict';
export {
  fit,
  freeVarsOf,
  leaveOneOut,
  objective,
  type EntryResidual,
  type FitResult,
  type FreeVar,
  type LooError,
  type LooResult,
  type PointResidual,
} from './fit';
export { buildReport, renderReport, proposedDefaults, type CalibrationReport } from './report';
export {
  CAPABILITIES,
  GRID,
  CORPUS_METRIC_CELL,
  STRUCTURAL_LIMITS,
  VERIFICATION_GAPS,
  type Anchor,
  type Capability,
  type CapabilityKind,
  type GridAnchorCell,
  type GridMetric,
  type GridRegime,
  type Oracle,
  type StructuralLimit,
  type ValidationKind,
  type VerificationGap,
} from './capabilities';
export {
  buildCoverage,
  renderFidelity,
  type CellStatus,
  type CoverageGridCell,
  type CoverageMatrix,
  type CoverageRow,
  type Headline,
} from './coverage';
export { repoRoot, fidelityPath } from './fidelity';
