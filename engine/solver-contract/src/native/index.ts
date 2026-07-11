// THE NATIVE ADAPTER — our own implementation of the solver contract (docs/design/solver-contract.html §3;
//). It is the SECOND implementation behind the same `SolverBindings` the incumbent implements,
// and the whole point of the contract: an app can bind THIS instead of the MiniZinc/COIN-BC incumbent and get
// the same answers with zero WASM, zero process spawn, and interactive-grade latency (the search runs in-process
// over the JS cell-network evaluator — see ./search).
//
// WHICH CAPABILITIES IT BINDS.
//   • evaluate           — the synchronous hot path, bound to the engine's own forward evaluator (already ours;
//                          the incumbent binds the identical function, so this is a pass-through, not a rewrite).
//   • optimize / repair  — the CPU branch-and-bound over the cell network (./search): monotone corner feasibility
//   • explainInfeasible    pruning + per-knob binary-search inversion, exact on the capacity/flow class.
//   • evaluateBatch      — N forward evaluations in one call, a sequential loop over `evaluate` (a WebGPU batch
//                          proposer is a later layer; the sequential loop satisfies the contract today).
//   • enumerate          — NOT bound. Topology enumeration stays the incumbent's clingo/ASP path (out of scope
//                          for the native numeric solver); a consumer that needs it binds the incumbent's.
//
// This module lives under src/native/, the SECOND package location (besides src/incumbent/) permitted to import
// @sda/engine-solve — because, exactly like the incumbent, it is reached only through a dedicated dynamically-
// importable entry (@sda/solver-contract/native), never a static import from a runtime composition root. The
// dependency lint scopes @sda/engine-solve to incumbent/ AND native/ for that reason (dependency.test.ts (B)).
// It pulls in NO WASM: `createEngine`/`evaluate` and the cell network are pure TS, so binding native keeps the
// 17.8 MB MiniZinc bundle out of the graph — the whole reason exists.

import type { Graph, Registry } from '@sda/engine-core';
import { createEngine, evaluate as evaluateNetwork, type RequestClass } from '@sda/engine-solve';
import type { SolverBindings } from '../bindings';
import type { Evaluation, Scenario } from '../capability';
import { runExplain, runOptimize, runRepair } from './search';

/** The dependencies the native adapter needs: only the registry (bound once at construction, exactly as the
 *  incumbent binds it and as the contract's `EvaluateRequest` documents). No MiniZinc solver and no ASP runner —
 *  the native searches need neither, which is the point: a browser with no WASM MIP solver can still optimize. */
export interface NativeDeps {
  readonly registry: Registry;
}

/**
 * Build the native `SolverBindings`. Every capability except `enumerate` is provided (enumerate stays the
 * incumbent's clingo path). The search capabilities are asynchronous to satisfy the contract, but run
 * synchronously in-process — they await nothing, so they return on the next microtask, well inside any canvas
 * frame budget. Their behaviour is pinned by the SAME conformance suite and oracle harness the incumbent passes.
 */
export function makeNativeAdapter(deps: NativeDeps): SolverBindings {
  const engine = createEngine(deps.registry);

  // The synchronous hot path — the engine's forward evaluator, CLASS-AWARE (doc: request-classes §4). It calls the
  // network `evaluate` directly (not the facade's class-blind method) so a request carrying classes folds the flow
  // per class; absent classes ⇒ the single implicit river, byte-for-byte the facade's evaluate. Same shape either
  // way (Result<Evaluation>), so a consumer that never declares a class is unaffected.
  const evaluate: SolverBindings['evaluate'] = (req) => evaluateNetwork(req.graph, deps.registry, req.classes as readonly RequestClass[] | undefined);

  return {
    evaluate,
    optimize: async (req) => runOptimize(deps.registry, req),
    repair: async (req) => runRepair(deps.registry, req),
    explainInfeasible: async (req) => runExplain(deps.registry, req),
    evaluateBatch: async (req) => {
      // Sequential fan: evaluate the SAME design under each scenario's input overrides, in order, honouring the
      // abort signal BETWEEN scenarios (a running evaluation is not interrupted, but no further scenario starts
      // once aborted). A WebGPU batch proposer would replace this loop later; the loop already satisfies the
      // contract (one Evaluation per scenario, in order, seeded/deterministic since `evaluate` is pure).
      const out: Evaluation[] = [];
      for (const scenario of req.scenarios) {
        if (req.signal?.aborted) break; // best-effort cancellation: settle promptly without the remaining work
        const r = engine.evaluate(applyOverrides(req.graph, scenario));
        if (r.ok) out.push(r.value);
      }
      return out;
    },
  };
}

/**
 * Overlay a scenario's numeric overrides onto a design, producing the graph to evaluate for that sample. An
 * override key is a `"node|key"` pair naming a fixed config input to substitute (the same addressing the oracle
 * harness uses to pin a solved assignment). Pure engine-core surgery over the graph maps — no solver, no domain
 * knowledge — so the batch stays domain-agnostic. An override naming a cell that is not a fixed input is ignored
 * (an unknown sample coordinate cannot change a computed value).
 */
function applyOverrides(graph: Graph, scenario: Scenario): Graph {
  const overrides = scenario.overrides;
  if (Object.keys(overrides).length === 0) return graph;
  const nodes = new Map(graph.nodes);
  for (const [id, node] of nodes) {
    let changed = false;
    const cells = node.cells.map((c) => {
      if (c.kind !== 'input' || c.value.kind !== 'fixed') return c;
      const v = overrides[`${id}|${c.key}`];
      if (v === undefined) return c;
      changed = true;
      return { ...c, value: { kind: 'fixed' as const, quantity: { ...c.value.quantity, value: v } } };
    });
    if (changed) nodes.set(id, { ...node, cells });
  }
  return { nodes, ports: graph.ports, edges: graph.edges };
}
