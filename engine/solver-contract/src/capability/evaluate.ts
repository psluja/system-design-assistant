// CAPABILITY: Evaluate — the synchronous hot path. Forward
// evaluation of a design's typed-property graph to its least fixpoint, judging every declared band. This
// runs on EVERY canvas edit, so it is synchronous and pure — it must never await. Distilled from the
// cell-network `evaluate()` shipping today (engine/solve/src/engine.ts, fixpoint/solve.ts).
//
// Every capability module in this package follows ONE repeated template — types, then the request, then the
// result/domain models, then the interface, then a two-implementations note — so a reader who learns one
// learns them all (owner rule 2026-07-03: code as if machine-generated).

import type { Graph, Key, NodeId, Result, Verdict } from '@sda/engine-core';
import type { RequestClass } from './optimize';

/**
 * The input to a forward evaluation. The registry (which gives every key its unit, band shape and
 * aggregation) is bound once at adapter CONSTRUCTION, not per call (owner ruling: registry-at-construction) — so the request stays light and matches today's facade, which
 * closes over the registry in `createEngine`. Only the graph, which changes on every edit, travels here.
 */
export interface EvaluateRequest {
  readonly graph: Graph;
  /** The declared request classes. Absent/empty ⇒ the single implicit river, so an
   *  existing request evaluates BYTE-FOR-BYTE as today; present ⇒ the forward pass folds the flow per class over
   *  its own wires and contends the shared node's capacity (§4.1). */
  readonly classes?: readonly RequestClass[];
}

/**
 * The result of a forward evaluation: solved values plus an honest verdict per declared band. `converged`
 * is the honesty state — `false` means the least fixpoint did not settle (a did-not-converge / NaN),
 * which callers must not read as a real zero. `value(node, key)` returns the computed number, or
 * `undefined` where the key is absent at that node. Each verdict carries its own status
 * (`ok | warning | violation | unknown | did-not-converge`), so a band no value can decide reads
 * `unknown` rather than a fabricated pass. Shape-identical to today's `Evaluation`
 * (engine/solve/src/engine.ts) so the incumbent adapter is a pass-through.
 */
export interface Evaluation {
  /** True iff the least fixpoint settled with no NaN — otherwise this is an honest did-not-converge. */
  readonly converged: boolean;
  /** The computed value of a key at a node, or `undefined` if that key is absent there. */
  value(node: NodeId, key: Key): number | undefined;
  /** One verdict per declared band: ok | warning | violation | unknown | did-not-converge. */
  readonly verdicts: readonly Verdict[];
}

/**
 * Forward evaluation: solve the design's typed-property graph to its least fixpoint and judge every declared
 * band. SYNCHRONOUS and pure — this runs on every canvas edit, so it must not await. Uncertainty is a VALUE,
 * never a throw: a build problem (an unregistered key, a malformed relation) is a `Result` error; a failure
 * to settle is `converged:false`; a band no value can decide is verdict `unknown`.
 *
 * Two implementations justify this interface (an interface earns its place only when exercised twice):
 *   (1) the cell-network least-fixpoint `evaluate()` shipping today (engine/solve/src/engine.ts);
 * (2) the domain solver's CPU forward pass (layer 2, "CPU proves").
 */
export interface Evaluate {
  (req: EvaluateRequest): Result<Evaluation, readonly string[]>;
}
