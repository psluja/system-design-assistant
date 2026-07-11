// CAPABILITY: Optimize — search a knob against SLOs (docs/design/solver-contract.html §3.2). Run the design
// BACKWARDS: choose values for the freed tunables that make every SLO hold while minimizing/maximizing an
// objective. ASYNCHRONOUS — it awaits a worker. Distilled from the facade's `optimize` + the MiniZinc
// `optimizeModel` (engine/solve/src/facade.ts, minizinc/search.ts).
//
// Same repeated template as every capability module: types, request, result/domain models, interface,
// two-implementations note (owner rule 2026-07-03: code as if machine-generated).

import type { ClassId, EdgeId, Graph, Key, NodeId } from '@sda/engine-core';
import type { Cancellable, SearchResult } from '../honesty';

/** A knob the search may vary: a node's fixed config input, freed within a numeric domain `[min, max]`.
 *  Shape-identical to today's `Tunable` (engine/solve/src/minizinc/search.ts). */
export interface Tunable {
  readonly node: NodeId;
  readonly key: Key;
  readonly min: number;
  readonly max: number;
}

/**
 * A REQUEST CLASS: a named multi-commodity flow (doc: request-classes §3) — its own acyclic wire membership
 * over a shared, possibly cyclic, topology, plus its own per-node origins (the rate it injects into the flow
 * key). OPAQUE ids only, so the contract stays engine-agnostic: `id`/`node`/`edge` mean nothing to the engine.
 * Shape-identical to the engine's `RequestClass` (engine/solve/src/network/build.ts), redeclared here in
 * engine-core terms so the contract core imports no solver package — the two are structurally interchangeable
 * (an adapter passes this straight to `buildNetwork`). Absent from a request ⇒ the single implicit river (today).
 */
export interface RequestClass {
  readonly id: ClassId;
  /** The edges this class traverses — its membership E_C (must be acyclic even where the drawing is a mesh). */
  readonly edges: readonly EdgeId[];
  /** Where THIS class injects load into the flow key(s): a per-node injected rate (its own origin). */
  readonly origins: readonly { readonly node: NodeId; readonly rps: number }[];
}

/** What to optimize: a key at a node, minimized or maximized. Shape-identical to today's `Objective`. With
 *  request classes declared, a NON-flow key (cost/latency) has no class-blind value — it lives per class — so
 *  `class` names WHICH class's value to optimize (doc: request-classes §5.1, §7.1). Absent ⇒ the class-blind
 *  aggregate (a flow total) or the single implicit river.
 *
 *  `total` switches the objective from ONE node's cumulative out-cell to the WHOLE-GRAPH TOTAL of the key: the
 *  sum over every node of its LOCAL contribution `local(node, key)` — for a sum-aggregated key (e.g. a cost)
 *  that is the whole design's own spend, including branches no single out-cell accumulates (a cumulative
 *  out-cell only sums the paths INTO its node; an off-path branch is invisible to it). `node` then serves only
 *  as the read-back anchor. A sum of monotone terms stays monotone, so the native descent covers it exactly as
 *  a single cell; the MIP takes it as one linear objective. Not supported together with request classes (a
 *  per-class local split is not modelled) — both adapters decline that combination honestly. */
export interface Objective {
  readonly node: NodeId;
  readonly key: Key;
  readonly direction: 'min' | 'max';
  readonly class?: ClassId;
  readonly total?: boolean;
}

/**
 * Capacity HEADROOM: keep each sizable tier's inflow(key) ≤ factor·self(key) — utilisation ρ ≤ factor — so
 * the solved design has finite queueing latency (offered load strictly below capacity), not the ρ=1
 * knife-edge that serves the load with an unbounded queue. Generic over the flow `key`; the caller (content)
 * chooses the key and factor, so the contract stays domain-agnostic. Shape-identical to today's `Headroom`.
 */
export interface Headroom {
  readonly key: Key;
  readonly factor: number;
}

/**
 * A SYSTEM band: a floor/ceiling on the WHOLE-GRAPH TOTAL of a sum-aggregated key — Σ over every node of its
 * LOCAL contribution, the exact sum a `total` {@link Objective} optimizes. This is how a system-scoped promise
 * (e.g. "the whole design costs ≤ 30,000 USD/month") enters the search as a HARD constraint: a node band bounds
 * one cumulative out-cell (a BRANCH's accumulated value, blind to off-path branches); a system band bounds Σ of
 * local cells, so an off-path branch's spend counts too. Shape-identical to the engine's `SystemBand`
 * (engine/solve/src/minizinc/search.ts), redeclared here in engine-core terms so the contract core imports no
 * solver package (the RequestClass pattern). Not supported together with request classes — both adapters decline
 * that combination honestly, exactly like a `total` objective.
 */
export interface SystemBand {
  readonly key: Key;
  readonly floor?: number;
  readonly ceiling?: number;
}

/**
 * The input to an optimize search. The registry is bound at adapter construction (see EvaluateRequest); the
 * graph, the freed tunables, the objective and the optional headroom travel per call. `signal` is the
 * optional best-effort cancellation channel (see Cancellable).
 */
export interface OptimizeRequest extends Cancellable {
  readonly graph: Graph;
  readonly tunables: readonly Tunable[];
  readonly objective: Objective;
  readonly headroom?: Headroom;
  /** The declared request classes (doc: request-classes §3). Absent/empty ⇒ the single implicit river, so an
   *  existing request is unchanged; present ⇒ the search is over the per-class cell network (flow cells indexed
   *  by class, the shared-node processor-sharing split — §4.1). */
  readonly classes?: readonly RequestClass[];
  /** The declared SYSTEM bands (whole-graph sum constraints — a system-scoped promise like a total-cost ceiling).
   *  Absent/empty ⇒ an existing request is unchanged. A pure ceiling that only rises with the knobs is the BUDGET
   *  class: the native solver descends with it excluded and verifies it at the optimum, declining `budget-coupling`
   *  when it binds against the objective — the exact reference MIP then answers (honest escalation). */
  readonly systemBands?: readonly SystemBand[];
}

/**
 * A `solved` optimize result: the chosen value for each freed tunable, plus a `value(node, key)` reader that
 * returns any key's value under that assignment (or `undefined` if absent). Shape-identical to today's
 * `OptimizeResult` (engine/solve/src/facade.ts).
 */
export interface OptimizeSolution {
  readonly assignments: readonly { readonly node: NodeId; readonly key: Key; readonly value: number }[];
  /** Read any key's value under that assignment. With request classes declared, pass `cls` to read that class's
   *  own value `out(N,K,C)` — a non-flow key (cost/latency) has no class-blind value under classes. Absent ⇒ the
   *  class-blind cell (a flow total, or today's single river). */
  value(node: NodeId, key: Key, cls?: ClassId): number | undefined;
}

/**
 * Run backwards: choose values for the freed `tunables` that make every SLO hold while minimizing or
 * maximizing `objective`. ASYNCHRONOUS (awaits a worker). The result triad is load-bearing and MUST NOT be
 * conflated: a proven-optimal `solved`, a proven `infeasible` (no assignment can satisfy the SLOs — use
 * ExplainInfeasible for the exact shortfall), or an honest `did-not-converge` (hit the hard time bound —
 * simplify or set the knobs manually).
 *
 * Any pruning the incumbent does (e.g. reachable-tunable pruning, evaluating violated bands first) is an
 * optimization of THAT adapter, below this interface — the contract specifies only the observable behaviour
 * (best objective subject to the SLOs), which the conformance suite pins. A different adapter may prune
 * differently as long as it returns the same optimum.
 *
 * Two implementations justify this interface:
 *   (1) the MiniZinc projection `optimizeModel` + COIN-BC/HiGHS (engine/solve/src/minizinc/search.ts);
 * (2) the domain solver's CPU branch-and-bound over the same cell network.
 */
export interface Optimize {
  (req: OptimizeRequest): Promise<SearchResult<OptimizeSolution>>;
}
