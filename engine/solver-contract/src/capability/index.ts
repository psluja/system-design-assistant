// The capability barrel — one small, segregated interface per question the engine can answer about a design.
// No god-interface: an adapter implements only the capabilities it provides, a consumer depends only on the
// capabilities it calls (interface segregation, dependency inversion —, §8).
// Values then `type`-prefixed types, mirroring the engine/solve barrel convention.

export { type Evaluate, type EvaluateRequest, type Evaluation } from './evaluate';
export { type Optimize, type OptimizeRequest, type OptimizeSolution, type Tunable, type Objective, type Headroom, type RequestClass, type SystemBand } from './optimize';
export { type Repair, type RepairRequest, type Change } from './repair';
export { type ExplainInfeasible, type ExplainRequest, type Shortfall } from './explain-infeasible';
export { enumerated, enumerateDidNotConverge, type Enumerate, type EnumerateRequest, type EnumerateResult, type SelectionProblem, type Selection } from './enumerate';
export { type EvaluateBatch, type EvaluateBatchRequest, type Scenario } from './evaluate-batch';
