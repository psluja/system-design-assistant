// CAPABILITY: Repair — the minimal edit. Given a design that
// violates its SLOs, find the SMALLEST change to the tunables that makes every band hold. ASYNCHRONOUS.
// Distilled from the facade's `repair` + the MiniZinc `repairModel` (L1-minimizing MIP)
// (engine/solve/src/facade.ts, minizinc/search.ts).
//
// Same repeated template as every capability module: types, request, result/domain models, interface,
// two-implementations note (owner rule 2026-07-03: code as if machine-generated).

import type { Graph, Key, NodeId } from '@sda/engine-core';
import type { Cancellable, SearchResult } from '../honesty';
import type { Headroom, RequestClass, SystemBand, Tunable } from './optimize';

/**
 * One tunable edit: raise or lower `key` at `node` from `from` to `to`, a distance of `delta = |to − from|`.
 * Shape-identical to today's `Change` (engine/solve/src/facade.ts).
 */
export interface Change {
  readonly node: NodeId;
  readonly key: Key;
  readonly from: number;
  readonly to: number;
  readonly delta: number;
}

/**
 * The input to a repair search. Registry bound at construction (see EvaluateRequest); graph, freed tunables
 * and optional headroom travel per call. `signal` is the optional best-effort cancellation channel.
 */
export interface RepairRequest extends Cancellable {
  readonly graph: Graph;
  readonly tunables: readonly Tunable[];
  readonly headroom?: Headroom;
  /** The declared request classes. Absent/empty ⇒ the single implicit river. */
  readonly classes?: readonly RequestClass[];
  /** The declared SYSTEM bands (whole-graph sum constraints — see OptimizeRequest.systemBands). A repair must
   *  land INSIDE the declared system ceiling too, or decline honestly (`budget-coupling` ⇒ the reference MIP). */
  readonly systemBands?: readonly SystemBand[];
}

/**
 * Given a design that violates its SLOs, find the SMALLEST change to the tunables that makes every band hold
 * (minimize Σ|new − current|). This answers "what is the least edit that fixes this", not "what is the
 * cheapest design". Same async triad as Optimize; a `solved` carrying an EMPTY change list means the design
 * already holds — no edit needed.
 *
 * Two implementations justify this interface:
 *   (1) `repairModel` (the L1-minimizing MIP, engine/solve/src/minizinc/search.ts);
 * (2) the domain solver's local-search repair.
 */
export interface Repair {
  (req: RepairRequest): Promise<SearchResult<readonly Change[]>>;
}
