// @sda/solver-contract — the heart of the project made explicit (docs/design/solver-contract.html; TASK-79
// phase 0). One small package that is three things at once:
//   (1) the CANONICAL DOCUMENTATION HOME — the abstract domain models and honesty states carry their meaning
//       as doc-comments ON the interfaces themselves; design docs reference the contract, they do not re-state it;
//   (2) the ABSTRACT DOMAIN MODELS — one home for the request/result shapes every solver question is posed in;
//   (3) the EXECUTABLE SPECIFICATION — a conformance suite (see ./conformance) that every adapter must pass.
//
// Domain-agnostic by construction: this core imports ONLY @sda/engine-core types and carries zero cloud or
// product vocabulary (enforced by dependency.test.ts). The incumbent adapter (which wraps the third-party WASM
// solvers and the JS hot path) is a SEPARATE dynamically-imported entry, @sda/solver-contract/incumbent — it
// is not part of this core and never in a runtime bundle's static graph (bundle separation, docs §6).
//
// TWO GRADERS ship alongside the contract, each a SEPARATE dev-only entry (they import vitest as a describe/it
// factory, so they stay out of this runtime barrel):
//   • @sda/solver-contract/conformance — `conformanceOf(adapter)`: the executable §4 specification, grading an
//     adapter on a fixed corpus of HAND-CHECKED designs (exactness, honest non-convergence, hard time-bound,
//     determinism, cancellation). "Adapter X implements capability C" ≡ this suite is green for C.
//   • @sda/solver-contract/harness — `oracleHarnessOf(candidate, { oracle })`: the ORACLE HARNESS (TASK-79
//     phase 1). A seeded random-design GENERATOR fans a candidate across many topologies/regimes; the incumbent
//     referee CERTIFIES each answer; the candidate must match by the contract's equivalence (objective value +
//     SLO satisfaction — not knob vectors; exact sets for enumerate; kind equality for UNSAT). It adds property
//     layers (determinism under seed, monotonicity) and per-instance PERFORMANCE BUDGETS as tests — a
//     correct-but-slow candidate FAILS. Running the incumbent as its own candidate is the sanity gate. This is
//     the generated differential suite the in-house domain solver (phase 2) is built against.

export { solved, infeasible, didNotConverge, didNotConvergeBecause, type SearchResult, type Cancellable, type DidNotConvergeCode } from './honesty';
export * from './capability';
export { referee, throwOnDivergence, equivalentOptimize, type SolverBindings, type ReportDivergence } from './bindings';
// HONEST ESCALATION (owner ruling 2026-07-04) — the surface never dead-ends on a class the shipped reference MIP
// solves; it escalates exactly that class and labels which engine answered (never a silent fallback).
export {
  withBudgetEscalation,
  isBudgetCouplingDecline,
  REFERENCE_MIP_BASIS,
  ESCALATION_TIMEOUT_MS,
  type SearchEngine,
  type Escalation,
} from './escalate';
