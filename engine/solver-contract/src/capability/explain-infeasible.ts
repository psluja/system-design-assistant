// CAPABILITY: ExplainInfeasible — the exact shortfall (docs/design/solver-contract.html §3.4). Explain WHY
// the SLOs cannot be met: re-encode every band as SOFT and minimize total penalty, so a positive penalty
// names exactly WHICH SLO fails and BY HOW MUCH. ASYNCHRONOUS. Distilled from the facade's
// `explainInfeasible` + the MiniZinc `relaxedModel` (engine/solve/src/facade.ts, minizinc/search.ts).
//
// Same repeated template as every capability module: types, request, result/domain models, interface,
// two-implementations note (owner rule 2026-07-03: code as if machine-generated).

import type { Graph, Key, NodeId } from '@sda/engine-core';
import type { Cancellable, SearchResult } from '../honesty';
import type { RequestClass, Tunable } from './optimize';

/**
 * One SLO that cannot be met, and by how much. `bound` says which side of the band is missed — a `floor`
 * (min), a `ceiling` (max) or an exact `point`; `amount` is how far it is missed (0 ⇒ satisfied).
 * Shape-identical to today's `Shortfall` (engine/solve/src/facade.ts).
 */
export interface Shortfall {
  readonly node: NodeId;
  readonly key: Key;
  readonly bound: 'floor' | 'ceiling' | 'point';
  readonly amount: number;
}

/**
 * The input to an explain search. Registry bound at construction (see EvaluateRequest); graph and the freed
 * tunables travel per call. `signal` is the optional best-effort cancellation channel.
 */
export interface ExplainRequest extends Cancellable {
  readonly graph: Graph;
  readonly tunables: readonly Tunable[];
  /** The declared request classes (doc: request-classes §3). Absent/empty ⇒ the single implicit river. */
  readonly classes?: readonly RequestClass[];
}

/**
 * Explain WHY the SLOs cannot be met: re-encode every band as SOFT and minimize the total penalty. A
 * positive penalty names exactly WHICH SLO fails and BY HOW MUCH — strictly more informative than a boolean
 * UNSAT or an unsat-core. The relaxed model is ALWAYS satisfiable (the soft penalties absorb any shortfall),
 * so the only non-`solved` outcome is `did-not-converge` (a timeout); `infeasible` never arises here. A
 * `solved` carrying an empty shortfall list means the design is feasible — every SLO can be met by tuning.
 *
 * Two implementations justify this interface:
 *   (1) `relaxedModel` (the soft-penalty MIP, engine/solve/src/minizinc/search.ts);
 * (2) the domain solver's slack computation over the same bands.
 */
export interface ExplainInfeasible {
  (req: ExplainRequest): Promise<SearchResult<readonly Shortfall[]>>;
}
