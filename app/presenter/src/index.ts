// @sda/presenter — the SHARED VIEW-MODEL layer every SDA shell renders. The web (app/web) and the VS Code
// webview (app/vscode) both consume THESE functions, so the two shells can never drift: one place computes the
// Problems rows, the status figures, the System roll-up, the Inspector model, the tidy layout and the "what fits"
// suggestions. A shell's job shrinks to rendering these view-models (plus its own interaction/chrome).
//
// Purity: no React, no DOM, no shell state. Depends only DOWNWARD — @sda/core (Studio), @sda/content (domain
// roll-ups + registry), @sda/engine-core / @sda/engine-solve. Values are pre-formatted honestly (∞ / '—' / unknown
// preserved — the tool must not lie).

// Pure helpers (moved verbatim from app/web).
export { fmt, formatMs, formatMsDigits, plural, opnd, rate, prettyExpr } from './format';
export { keyInfo, KEY_INFO, KIND_DESC, type KeyInfo } from './meta';
export { tidyLayout, type Pos, type Rect, type Size } from './layout';
// THE IDEAL LAYOUT — semantic placement + a seeded search scored on real routes. The
// PRESENTER-PURE core: the structural model, the objective (the ratified weight vector + the 11 normalised terms,
// scored on the deterministic router's real geometry — the arbiter), the deterministic semantic pass, and the
// seeded beam optimiser (Tidy-floored, pin-aware, GPU-batch-score seam). Shells wire these in a later round.
export {
  type LayoutDesign,
  type LayoutNode,
  type LayoutWire,
  type LayoutGroup,
  type LayoutFlow,
  type Placement,
  type NodePortOffsets,
  type PortOffsets,
  DEFAULT_NODE_SIZE,
  designHash,
  designPorts,
  groupRects,
  layoutFlows,
  portAnchorOffset,
  portOffsetKey,
  roleTier,
} from './layout-model';
// THE PORT SLIDE (R5, port-position assignment) — a port slides along its node edge to sit exactly opposite its
// peer (ELK port-position / yFiles port-optimization class): manifest order kept, ≥MIN_PORT_GAP between handles,
// unwired ports holding their fraction. Assigned once per shipped ✨ layout (also on OptimizeResult.portOffsets);
// Tidy alone keeps fractions.
export { acceptedPortOffsets, assignPortOffsets, minAssignedPortGap, slidePositions, MIN_PORT_GAP, PORT_EDGE_PAD, type SlideTarget } from './layout-ports';
export {
  LAYOUT_TERMS,
  LAYOUT_WEIGHTS,
  TERM_KIND,
  type LayoutTerm,
  type LayoutScore,
  type LayoutGeometry,
  type HardViolation,
  type SeparationMetrics,
  scoreLayout,
  scoreGeometry,
  layoutGeometry,
  hardViolations,
  boxViolations,
  separationMetrics,
} from './layout-objective';
export { semanticLayout } from './layout-semantic';
export { compactColumns, snapToAnchors, symmetrizeFanouts, COMPACT_GUTTERS, DEFAULT_COMPACT_GUTTER, TRACK_GAP, type CompactOptions, type SnapOptions, type SymmetrizeOptions } from './layout-refine';
export { optimizeLayout, createLayoutSearch, detectPins, type BatchScorer, type LayoutSearch, type OptimizeOptions, type OptimizeResult } from './layout-optimize';
// THE RESTING HANDSHAKE — the shell-agnostic '✨ Ideal layout' driver both shells share:
// project → LayoutDesign, plus the latest-wins / idle=zero polisher that runs the resumable search off the critical
// path through an injected scheduler (web rAF · host/test synchronous). One presenter, zero drift.
export {
  toLayoutDesign,
  createPolisher,
  synchronousSchedule,
  type CatalogPorts,
  type LayoutDocView,
  type PolishPhase,
  type PolishJob,
  type PolishHandlers,
  type PolishScheduler,
  type Polisher,
} from './layout-polish';
// THE IDEAL LAYOUT — the GPU PROPOSER. The fp32 straight-line proxy
// batch-scorer that ranks thousands of placement candidates fast; the CPU re-routes + re-scores every survivor and
// the winner EXACTLY (the router is the arbiter — fp32 never decides the applied layout). It lives behind a LAZY
// entry so the WebGPU driver never lands in a shell's static bundle (bundle separation): a shell calls
// `loadLayoutGpu()` once, builds a `BatchScorer` with `makeLayoutBatchScorer`, and injects it as the search's
// `batchScore` option. On a batch within the survivor cap (every committed design's per-slice batch) the scorer is
// byte-for-byte the CPU-exact scorer, so GPU-on and GPU-off produce identical layouts.
export type { LayoutBatchScorer, LayoutBatchScorerOptions, BatchStats, ProxyModel, ProxyTerm } from './layout-gpu/index';
export async function loadLayoutGpu(): Promise<typeof import('./layout-gpu/index')> {
  return import('./layout-gpu/index');
}
// Orthogonal "smart" edge routing — right-angle wires that avoid node + tidied-group boxes (the React-Flow-Pro
// "avoid-nodes" capability, re-implemented in pure TS so no LGPL/WASM dependency enters this MIT project). Both
// shells route via routeDesignEdges so a wire looks identical everywhere.
export {
  routeDesignEdges,
  routeOrthogonalEdges,
  canonicalRoute,
  auditDesignEdges,
  orthogonalPathD,
  pointAlongPolyline,
  simplifyOrthogonal,
  type NeedlessBend,
  type DesignRouteInput,
  type Box,
  type Side,
  type Anchor,
  type RouteRequest,
  type RouteOptions,
  type PortLike,
  type NodeGeom,
  type WireLike,
  type GroupLike,
  type RoutedWire,
} from './edge-routing';
export { buildCandidates, suggestFor, matchingPort, type Suggestion } from './suggest';

// View-models (extracted from app.tsx / the vscode webview — one canonical builder each).
export { problemRows, problemCount, type ProblemRow } from './problems';
export { statusLine, type StatusLine } from './status';
export {
  summarySections,
  systemVerdict,
  responseRows,
  lagRows,
  systemPromiseRows,
  bearsLatencyRequirement,
  formatResponseTail,
  type SystemVerdictInput,
  type SystemVerdictView,
  type SummarySection,
  type SummaryRow,
  type SummaryInput,
  type SimTail,
  type NodeResponseView,
  type PairLagView,
} from './summary';
export { simVerdicts } from './sim-verdicts';
// THE AMBIENT TWO-TIER READ-OUT — the ρ-envelope strip + worst-window callout + cost
// integral + %-in-violation (Tier-1 analytic), plus the survival verdict (Tier-2 measured) when it has run,
// composed ONCE here so the web System panel and the VS Code System tree render the identical block.
export { twoTierSection, backlogSparkline, originShapeGlyph } from './two-tier-view';
export { uncertaintySection, type UncertaintyPresentation, type UncertaintyState } from './uncertainty-view';
// The assumption model — the envelope-by-default headline and the worlds matrix +
// active-lens tagging, composed ONCE here so both shells render the identical block.
export { envelopeSection, type EnvelopePresentation } from './envelope-view';
export {
  worldsMatrix,
  activeLensLabel,
  overrideProvenanceLabel,
  overrideProvenanceBadge,
  type WorldsPresentation,
} from './worlds-view';
// Range TEXT I/O — display + parse + validate for uncertainty ranges, shared so
// the web Inspector affordance and the VS Code native InputBox interpret a range identically.
export { formatRange, formatRangeInput, parseRangeInput, rangeFromFields, RANGE_INPUT_FORMS, type RangeParse } from './range-input';
// SINGLE-TRUTH LATENCY (owner decree) — the measured-or-nothing policy every shell reads: resolve a node's fresh
// DES measurement, its verdict tone, and the canvas p50→p99 range bar. The analytic scalars are engine-internal
// and render on no surface; there is no 'estimate' peer and never two latencies at once.
export { measuredResponseOf, latencyTone, latencyRangeBar, type LatencyTone, type LatencyRangeBar } from './latency';
// RPS — ONE FORM: the shared rate-row view-model both shells render (a source, a pure-delay hop and a capacity-limited
// tier all show the rate in the SAME slot; capacity-bearing tiers additionally get the ρ meter fill).
export { rateRow, type RateRow, type RateQueue, type RateStatus, type RateTone } from './rate-row';
// WORST-CASE PER-NODE LOAD (owner ruling: a peak is just traffic in a given environment) — the ONE composition
// every per-node surface reads so the canvas ρ chip, the Inspector and the System 'Load per tier · ρ' all show the
// WORST load the declared environment produces (worst-window ρ when shaped, steady ρ otherwise), with no 'peak'
// vocabulary; whether that ρ saturates is the one truth the shared verdict list also carries.
export { worstCaseRho, worstCaseUnits } from './peak-view';
export {
  nodeDetail,
  knobGroups,
  knobGroupOf,
  isHiddenKnob,
  HIDDEN_KNOB_KEYS,
  KNOB_GROUP_TITLE,
  SECTION_CAPTIONS,
  PROMISES_TITLE,
  type NodeDetail,
  type NodeDetailInput,
  type KnobRow,
  type KnobGroup,
  type KnobGroupId,
  type VerdictRow,
  type SuggestRow,
} from './node-detail';
// The canonical SLO-band comparator text (`throughput ≥ 5,000 req/s`) — one grammar every shell's Promises rows +
// the SLO Test Explorer + the design doc read, so a promise never renders two ways.
export { bandComparator, num } from './band-text';
export { pickerOptions, mintId, addPickedComponent, type PickerOption } from './picker';

// Edge-rate view-model: per-wire carried rate + transform pills (the engine's own applyTransform on the wire).
export {
  edgeRates,
  resolvePortTransform,
  resolveWireOutTransform,
  type EdgeRate,
  type EdgePill,
  type TransformTone,
  type TransformSource,
  type EdgeRatesInput,
} from './edge-rates';

// Guarantee view-model: per-flow summary lines, the per-edge canvas strip, and the requirement-editor options —
// the qualitative-guarantee (consistency/ordering/delivery) surface every shell renders.
export {
  flowGuaranteeLines,
  guaranteeSummarySections,
  guaranteeStrip,
  requirementOptions,
  tokenLabel,
  type FlowGuaranteeLine,
  type GuaranteeCell,
  type GuaranteeSummaryRow,
  type GuaranteeSummarySection,
  type GuaranteeStrip,
  type StripSegment,
  type StripTone,
  type DimensionOption,
  type TokenOption,
  type GuaranteeViewInput,
} from './guarantee-view';
