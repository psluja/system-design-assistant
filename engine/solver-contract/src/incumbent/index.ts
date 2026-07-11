// The INCUMBENT adapter — the first implementation of the solver contract (docs/design/solver-contract.html
// §3, migration step 3). It wraps today's code: the cell-network `createEngine` (evaluate/optimize/repair/
// explainInfeasible) and `enumerateSelections` over clingo (enumerate), translating their `Result<…>` /
// error-string / throwing shapes into the contract's typed honesty kinds. NO SOLVER LOGIC MOVES here — this
// is pure adaptation, so the incumbent's outputs stay byte-identical to today's (the goldens pin that).
//
// This module is the ONE place that may import @sda/engine-solve (which pulls in the MiniZinc/clingo loaders),
// so it is a SEPARATE package entry (@sda/solver-contract/incumbent) reached only via dynamic import from a
// composition root — never a static top-level import from a runtime entry point (bundle separation, docs §6).
// The contract CORE (everything under src/ except this folder) imports only @sda/engine-core.

import type { Registry } from '@sda/engine-core';
import { createEngine, evaluate as evaluateNetwork, optimizeModel, relaxedModel, repairModel, type MznSolver, type RequestClass } from '@sda/engine-solve';
import { enumerateSelections, type RunAsp } from '@sda/engine-solve/asp';
import type { SolverBindings } from '../bindings';
import type { Change, ExplainRequest, OptimizeRequest, OptimizeSolution, RepairRequest, Shortfall } from '../capability';
import { enumerated, enumerateDidNotConverge, type EnumerateResult } from '../capability/enumerate';
import { didNotConverge, infeasible, solved, type SearchResult } from '../honesty';

// The facade collapses a proven-UNSAT search and a timed-out one into two distinct error strings
// (engine/solve/src/facade.ts lines 13–14). This adapter reads the INFEASIBLE string back into the typed
// `infeasible` kind; every other search failure (the DID_NOT_CONVERGE string included) is honest
// non-convergence — so only the one discriminating substring is matched (migration step 3).
const INFEASIBLE_MARK = 'proven infeasible';

/** Map a facade `Result<T, string[]>` (from optimize/repair) to the contract's `SearchResult`. The facade
 *  returns `INFEASIBLE` when the model proved UNSAT and `DID_NOT_CONVERGE` on a timeout — two distinct facts
 *  the contract must not conflate. Anything else is treated as a timeout (honest ignorance), never a lie. */
function toSearchResult<A, B>(r: { ok: true; value: A } | { ok: false; error: readonly string[] }, map: (a: A) => B): SearchResult<B> {
  if (r.ok) return solved(map(r.value));
  const msg = r.error.join(' ');
  if (msg.includes(INFEASIBLE_MARK)) return infeasible;
  return didNotConverge; // DID_NOT_CONVERGE, or any other search failure — honest non-convergence
}

/** The dependencies the incumbent adapter needs, injected exactly as the facade injects them today: the
 *  registry (bound once), the MiniZinc solver, and the ASP runner. `solveMzn` / `runAsp` are optional — an
 *  adapter without a MiniZinc solver simply omits the search capabilities (interface segregation). */
export interface IncumbentDeps {
  readonly registry: Registry;
  readonly solveMzn?: MznSolver;
  readonly runAsp?: RunAsp;
}

/**
 * Build the incumbent `SolverBindings`. `evaluate` is always provided (the hot path needs no solver);
 * `optimize` / `repair` / `explainInfeasible` are provided only when a `solveMzn` is injected; `enumerate`
 * only when a `runAsp` is injected. Signatures below preserve today's exact behaviour — the goldens prove it.
 */
export function makeIncumbentAdapter(deps: IncumbentDeps): SolverBindings {
  const engine = createEngine(deps.registry, deps.solveMzn ? { solveMzn: deps.solveMzn } : {});

  // The synchronous hot path — always provided; it needs no injected solver. CLASS-AWARE (doc: request-classes
  // §4): it calls the network `evaluate` directly so a request carrying classes folds the flow per class; absent
  // classes ⇒ the single implicit river, byte-for-byte the facade's `engine.evaluate`.
  const evaluate: SolverBindings['evaluate'] = (req) => evaluateNetwork(req.graph, deps.registry, req.classes as readonly RequestClass[] | undefined);

  // The MiniZinc-backed search capabilities — provided only when a `solveMzn` is injected (interface
  // segregation: a browser without a MIP solver binds none of these). `undefined` when absent, so the spread
  // below simply omits them from the record. When a request declares CLASSES the facade cannot carry them (its
  // signature predates classes and it evaluates class-blind), so the class path projects the per-class model
  // DIRECTLY via the emitter (`optimizeModel`/`repairModel`/`relaxedModel` with classes) and runs the injected
  // solver — the same numeric mapping the facade does, class-threaded. The NO-class path stays the facade exactly,
  // so every existing request is byte-for-byte unchanged (the goldens pin it).
  const solveMzn = deps.solveMzn;
  const search: Pick<SolverBindings, 'optimize' | 'repair' | 'explainInfeasible'> | Record<string, never> =
    solveMzn === undefined
      ? {}
      : {
          optimize: async (req) =>
            hasClasses(req) ? optimizeWithClasses(deps.registry, solveMzn, req) : toSearchResult(await engine.optimize(req.graph, req.tunables, req.objective, req.headroom, req.systemBands), (v) => v),
          repair: async (req) => (hasClasses(req) ? repairWithClasses(deps.registry, solveMzn, req) : toSearchResult(await engine.repair(req.graph, req.tunables, req.headroom, req.systemBands), (v) => v)),
          // The relaxed model is always satisfiable, so the facade only ever returns DID_NOT_CONVERGE on
          // failure — there is no `infeasible` outcome to honour here (docs §3.4).
          explainInfeasible: async (req) => {
            if (hasClasses(req)) return explainWithClasses(deps.registry, solveMzn, req);
            const r = await engine.explainInfeasible(req.graph, req.tunables);
            return r.ok ? solved(r.value) : didNotConverge;
          },
        };

  // The clingo-backed enumeration capability — provided only when a `runAsp` is injected.
  const enumerate: Pick<SolverBindings, 'enumerate'> | Record<string, never> =
    deps.runAsp === undefined
      ? {}
      : {
          enumerate: async (req): Promise<EnumerateResult> => {
            // Close the honesty gap (docs §3.5): today `enumerateSelections` throws on a clingo ERROR and has
            // no time bound. Here a throw or a timeout becomes an honest `did-not-converge` — the "search
            // never throws / never hangs" discipline the MiniZinc path already honours. On success, an empty
            // selection list (UNSAT) is an `enumerated` result, never an error.
            try {
              const sels = await enumerateSelections(req.problem, deps.runAsp!, req.limit !== undefined ? { limit: req.limit } : {});
              return enumerated(sels);
            } catch {
              return enumerateDidNotConverge;
            }
          },
        };

  return { evaluate, ...search, ...enumerate };
}

/** Whether a search request declares request classes (doc: request-classes §3) — routes to the per-class emitter
 *  path below. Absent/empty ⇒ the single implicit river, handled by the facade exactly as today. */
const hasClasses = (req: { readonly classes?: readonly RequestClass[] }): req is { readonly classes: readonly RequestClass[] } & typeof req =>
  req.classes !== undefined && req.classes.length > 0;

/**
 * OPTIMIZE under request classes — project the per-class model directly (`optimizeModel` with classes: the flow
 * cells indexed by class, the processor-sharing split linearised to `min(cap, offered)` for the MIP — §5.3) and run
 * the injected solver. The numeric mapping is the SAME the facade performs (assignments from the solved var names,
 * `value(node,key,class)` through `valueOf`), only class-threaded — so a single-class request would read identically
 * to the facade. A build error (e.g. a cyclic class) is honest non-convergence; the solver's own outcome triad
 * (solved/infeasible/unknown) maps to the contract's.
 */
async function optimizeWithClasses(
  registry: Registry,
  solveMzn: MznSolver,
  req: OptimizeRequest & { readonly classes: readonly RequestClass[] },
): Promise<SearchResult<OptimizeSolution>> {
  const m = optimizeModel(req.graph, registry, req.tunables, req.objective, req.headroom, req.classes, req.systemBands);
  if (!m.ok) return didNotConverge;
  const outcome = await solveMzn(m.value.source);
  if (outcome.kind === 'infeasible') return infeasible;
  if (outcome.kind !== 'solved') return didNotConverge;
  const sol = outcome.values;
  const assignments = m.value.tunables.map((t) => ({ node: t.node, key: t.key, value: sol[t.name] ?? NaN }));
  const value: OptimizeSolution['value'] = (node, key, cls) => {
    const ref = m.value.valueOf(node, key, cls);
    if (ref === null) return undefined;
    return ref.kind === 'var' ? sol[ref.name] : ref.value;
  };
  return solved({ assignments, value });
}

/** REPAIR under request classes — the L1-minimising per-class model (`repairModel` with classes), same delta
 *  mapping as the facade. */
async function repairWithClasses(
  registry: Registry,
  solveMzn: MznSolver,
  req: RepairRequest & { readonly classes: readonly RequestClass[] },
): Promise<SearchResult<readonly Change[]>> {
  const m = repairModel(req.graph, registry, req.tunables, req.headroom, req.classes, req.systemBands);
  if (!m.ok) return didNotConverge;
  const outcome = await solveMzn(m.value.source);
  if (outcome.kind === 'infeasible') return infeasible;
  if (outcome.kind !== 'solved') return didNotConverge;
  const sol = outcome.values;
  const changes: Change[] = m.value.tunables
    .map((t) => ({ node: t.node, key: t.key, from: t.current, to: sol[t.name] ?? NaN }))
    .map((c) => ({ ...c, delta: Math.abs(c.to - c.from) }))
    .filter((c) => c.delta > 1e-6);
  return solved(changes);
}

/** EXPLAIN-INFEASIBLE under request classes — the soft-penalty per-class model (`relaxedModel` with classes), which
 *  is always satisfiable, so the only non-`solved` outcome is honest non-convergence (no `infeasible`). */
async function explainWithClasses(
  registry: Registry,
  solveMzn: MznSolver,
  req: ExplainRequest & { readonly classes: readonly RequestClass[] },
): Promise<SearchResult<readonly Shortfall[]>> {
  const m = relaxedModel(req.graph, registry, req.tunables, req.classes);
  if (!m.ok) return didNotConverge;
  const outcome = await solveMzn(m.value.source);
  if (outcome.kind !== 'solved') return didNotConverge;
  const sol = outcome.values;
  const shortfalls: Shortfall[] = m.value.penalties
    .filter((p) => (sol[p.name] ?? 0) > 1e-6)
    .map((p) => ({ node: p.node, key: p.key, bound: p.bound, amount: sol[p.name] ?? 0 }));
  return solved(shortfalls);
}

export type { MznSolver } from '@sda/engine-solve';
export type { RunAsp } from '@sda/engine-solve/asp';
