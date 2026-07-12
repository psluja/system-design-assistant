// CAPABILITY: EvaluateBatch — N evaluations, one call. Evaluate the
// SAME design under many input scenarios in one call. ASYNCHRONOUS and SEEDED (byte-reproducible). This is
// layer 1 of the domain solver ("GPU proposes") and the engine behind Monte-Carlo uncertainty. Distilled
// from
//
// DECLARED SEAM ONLY: this interface has no implementation to pin yet, so its conformance clauses are written
// but skip-marked until the first backend lands — honouring "no interface without two implementations" by
// marking it not-yet-active rather than pretending (docs §3.6, §8 non-goals).
//
// Same repeated template as every capability module: types, request, result/domain models, interface,
// two-implementations note (owner rule 2026-07-03: code as if machine-generated).

import type { Graph } from '@sda/engine-core';
import type { Cancellable } from '../honesty';
import type { Evaluation } from './evaluate';

/**
 * One scenario: the drawn overrides for a design's ranged config inputs (a single Monte-Carlo sample). Opaque
 * to the contract — a map of the numeric inputs to substitute for this pass; the domain (which keys are
 * ranged, how they are drawn) is content.
 */
export interface Scenario {
  readonly overrides: Readonly<Record<string, number>>;
}

/**
 * The input to a batch evaluation: one graph, many scenarios. Registry bound at adapter construction (see
 * EvaluateRequest); `signal` is the optional best-effort cancellation channel.
 */
export interface EvaluateBatchRequest extends Cancellable {
  readonly graph: Graph;
  readonly scenarios: readonly Scenario[];
}

/**
 * Evaluate the SAME design under many input scenarios in one call, returning one Evaluation per scenario in
 * order. SEEDED and byte-reproducible: the same request run twice yields identical results. Per-scenario
 * honesty states are exactly Evaluate's (`converged`, per-band `unknown`, …).
 *
 * Two implementations justify this interface (declared now, activated when the first backend lands):
 *   (1) a CPU backend — a worker loop over Evaluate off-thread (Monte-Carlo R1);
 * (2) a WebGPU/WGSL batch proposer (layer 1, "GPU proposes").
 */
export interface EvaluateBatch {
  (req: EvaluateBatchRequest): Promise<readonly Evaluation[]>;
}
