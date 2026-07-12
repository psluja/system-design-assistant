import type { Graph, Key, NodeId, PortId, Registry, Result, Verdict } from '@sda/engine-core';
import { evaluate, type Evaluation } from './engine';
import { optimizeModel, reachableTunables, relaxedModel, repairModel, type Headroom, type Objective, type SolveOutcome, type SystemBand, type Tunable } from './minizinc';
import { illegalEdges, whatFits, type Candidate, type Compat, type IllegalEdge } from './legality';

/** Runs a MiniZinc model and returns its OUTCOME (solved / infeasible / unknown — never a throw on a
 * no-solution — uncertainty is a value). Injected so engine/solve stays independent of HOW
 *  MiniZinc runs — minizinc-js (WASM) in the browser, the CLI in Node/tests. */
export type MznSolver = (model: string) => Promise<SolveOutcome>;

// The honest error a search returns when the solver could not give an assignment. Infeasible and timeout
// are DIFFERENT facts and must read differently — conflating them (both as "did not converge") is a lie.
const INFEASIBLE = 'no configuration of the tunables can satisfy every SLO (proven infeasible — use explainInfeasible for the exact shortfall)';
const DID_NOT_CONVERGE = 'the search did not converge within the time limit — simplify the design (fewer free knobs) or set the knobs manually';

export interface OptimizeResult {
  /** The chosen value for each freed tunable. */
  readonly assignments: ReadonlyArray<{ node: NodeId; key: Key; value: number }>;
  /** The resulting value of a key at a node under that assignment. */
  value(node: NodeId, key: Key): number | undefined;
}

/** One SLO that cannot be met, and by how much (the soft-constraint penalty). */
export interface Shortfall {
  readonly node: NodeId;
  readonly key: Key;
  readonly bound: 'floor' | 'ceiling' | 'point';
  readonly amount: number;
}

/** The minimal edit to a tunable that helps make the design legal. */
export interface Change {
  readonly node: NodeId;
  readonly key: Key;
  readonly from: number;
  readonly to: number;
  readonly delta: number;
}

/**
 * The engine facade: one object exposing every mode over a fixed registry. The hot,
 * synchronous modes (evaluate / check / legality / suggest) need nothing extra; the search modes
 * (optimize / explainInfeasible) await the injected MiniZinc solver. Tail-latency verdicts live with
 * the DES caller (a domain-aware projection), not here.
 */
export interface Engine {
  evaluate(graph: Graph): Result<Evaluation, readonly string[]>;
  check(graph: Graph): readonly Verdict[];
  illegal(graph: Graph, compat: readonly Compat[]): IllegalEdge[];
  suggest(graph: Graph, openPort: PortId, catalog: readonly Candidate[], compat: readonly Compat[]): Candidate[];
  optimize(graph: Graph, tunables: readonly Tunable[], objective: Objective, headroom?: Headroom, systemBands?: readonly SystemBand[]): Promise<Result<OptimizeResult, readonly string[]>>;
  explainInfeasible(graph: Graph, tunables: readonly Tunable[]): Promise<Result<readonly Shortfall[], readonly string[]>>;
  repair(graph: Graph, tunables: readonly Tunable[], headroom?: Headroom, systemBands?: readonly SystemBand[]): Promise<Result<readonly Change[], readonly string[]>>;
}

export function createEngine(registry: Registry, opts: { readonly solveMzn?: MznSolver } = {}): Engine {
  const solver = (): MznSolver => {
    if (opts.solveMzn === undefined) {
      throw new Error('Engine has no MiniZinc solver — pass opts.solveMzn to use optimize/explainInfeasible');
    }
    return opts.solveMzn;
  };

  return {
    evaluate: (graph) => evaluate(graph, registry),
    check: (graph) => {
      const r = evaluate(graph, registry);
      return r.ok ? r.value.verdicts : [];
    },
    illegal: (graph, compat) => illegalEdges(graph, compat),
    suggest: (graph, openPort, catalog, compat) => whatFits(graph, openPort, catalog, compat),

    optimize: async (graph, tunables, objective, headroom, systemBands) => {
      // Prune to the tunables that can reach the objective OR a currently-violated band — the rest are free
      // MIP variables (no objective gradient, their bands hold with slack) that only make the solver spin.
      // Including the violated bands' reachable knobs keeps it sound on an INFEASIBLE design too: the very
      // knobs that could fix a violation are reachable from that band, so they survive the prune. (This is what
      // makes "scale up, then fix it" fast instead of timing out on graphs of demand-priced / pay-per-use nodes.)
      // A SYSTEM band keeps every knob feeding any of its local cells too — an off-path priced knob is a lever
      // on the sum constraint (it can buy budget headroom), so pruning it would move the optimum.
      const ev = evaluate(graph, registry);
      const violated = ev.ok ? ev.value.verdicts.filter((v) => v.status === 'violation').map((v) => ({ node: v.scope as NodeId, key: v.key })) : [];
      const used = reachableTunables(graph, registry, tunables, objective, violated, systemBands);
      const m = optimizeModel(graph, registry, used, objective, headroom, undefined, systemBands);
      if (!m.ok) return m;
      const outcome = await solver()(m.value.source);
      if (outcome.kind === 'infeasible') return { ok: false, error: [INFEASIBLE] };
      if (outcome.kind === 'unknown') return { ok: false, error: [DID_NOT_CONVERGE] };
      const sol = outcome.values;
      const assignments = m.value.tunables.map((t) => ({ node: t.node, key: t.key, value: sol[t.name] ?? NaN }));
      const value = (node: NodeId, key: Key): number | undefined => {
        const ref = m.value.valueOf(node, key);
        if (ref === null) return undefined;
        return ref.kind === 'var' ? sol[ref.name] : ref.value;
      };
      return { ok: true, value: { assignments, value } };
    },

    explainInfeasible: async (graph, tunables) => {
      const m = relaxedModel(graph, registry, tunables);
      if (!m.ok) return m;
      const outcome = await solver()(m.value.source);
      // The relaxed model is always satisfiable (soft penalties absorb any shortfall), so only a timeout
      // leaves us without a solution — there is no `infeasible` outcome to honour here.
      if (outcome.kind !== 'solved') return { ok: false, error: [DID_NOT_CONVERGE] };
      const sol = outcome.values;
      const shortfalls: Shortfall[] = m.value.penalties
        .filter((p) => (sol[p.name] ?? 0) > 1e-6)
        .map((p) => ({ node: p.node, key: p.key, bound: p.bound, amount: sol[p.name] ?? 0 }));
      return { ok: true, value: shortfalls };
    },

    repair: async (graph, tunables, headroom, systemBands) => {
      const m = repairModel(graph, registry, tunables, headroom, undefined, systemBands);
      if (!m.ok) return m;
      const outcome = await solver()(m.value.source);
      if (outcome.kind === 'infeasible') return { ok: false, error: [INFEASIBLE] };
      if (outcome.kind === 'unknown') return { ok: false, error: [DID_NOT_CONVERGE] };
      const sol = outcome.values;
      const changes: Change[] = m.value.tunables
        .map((t) => ({ node: t.node, key: t.key, from: t.current, to: sol[t.name] ?? NaN }))
        .map((c) => ({ ...c, delta: Math.abs(c.to - c.from) }))
        .filter((c) => c.delta > 1e-6);
      return { ok: true, value: changes };
    },
  };
}
