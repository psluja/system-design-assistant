// The binding record + the referee wrapper. `SolverBindings` is a plain
// record of capabilities: one field per capability, each a concrete adapter's implementation. A consumer
// depends on this record (or on one field of it), never on a concrete solver — so switching an implementation
// is a single change at the composition root, per capability if wanted.
//
// The `referee` wrapper binds TWO adapters at once, returns the TRUSTED (incumbent) answer, and asserts the
// candidate matches — divergence is a P0 bug because it means the tool would lie. Equivalence is compared on
// OBSERVABLE outputs (objective value + SLO satisfaction, float-tolerant), not raw knob vectors: two optima
// can differ within ε yet both be valid (owner ruling 2026-07-03).

import { closeEnough as coreCloseEnough, type NodeId } from '@sda/engine-core';
import type { Enumerate, Evaluate, EvaluateBatch, ExplainInfeasible, Optimize, Repair } from './capability';
import type { OptimizeSolution } from './capability/optimize';
import type { SearchResult } from './honesty';

/**
 * The set of capability implementations an app binds. Every field is optional EXCEPT the ones an app actually
 * needs — an adapter that provides only some capabilities leaves the rest unbound, and a consumer that calls
 * only `evaluate` cares about nothing else (interface segregation). `evaluate` is the one every app binds
 * (the hot path). The composition root is the single place that populates this record.
 */
export interface SolverBindings {
  readonly evaluate: Evaluate;
  readonly optimize?: Optimize;
  readonly repair?: Repair;
  readonly explainInfeasible?: ExplainInfeasible;
  readonly enumerate?: Enumerate;
  readonly evaluateBatch?: EvaluateBatch;
}

/** A sink for a referee divergence (a candidate answer that disagrees with the trusted one). Injected so the
 *  contract stays free of any specific logger — a CI build throws, a dev build logs. */
export type ReportDivergence = (capability: string, detail: string) => void;

/** The default divergence reporter: throw. A referee divergence means the tool would lie, so in the CI/dev
 *  configuration where the referee runs, it must be impossible to miss (docs §5: divergence = P0). */
export const throwOnDivergence: ReportDivergence = (capability, detail) => {
  throw new Error(`solver referee divergence in ${capability}: ${detail}`);
};

/** The contract's canonical float equivalence: relative+absolute tolerance ε (docs §5, §9). This IS the one
 *  shared tolerance `@sda/engine-core`'s `tolerance.ts` defines (ε = 1e-4) — re-exported here so the referee
 *  (here), the oracle harness (harness/harness.ts) and the live verdict judges (engine/solve, content) all
 *  compare at the SAME scale. Two MIP optima may differ within ε yet both be valid; a value within ε of a band
 *  is AT the band. Dependency direction is fine (contract → engine-core). */
export const closeEnough = coreCloseEnough;

/**
 * Whether two `SearchResult<OptimizeSolution>` are EQUIVALENT for referee purposes: same kind, and — when
 * both `solved` — the same objective value read back through `value(node, key)` (float-tolerant). This
 * compares the OBSERVABLE optimum, not the raw assignment vector: a different knob choice achieving the same
 * objective is not a divergence (owner ruling 2026-07-03: equivalence = objective value + SLO satisfaction).
 */
export function equivalentOptimize(objectiveNode: NodeId, objectiveKey: import('@sda/engine-core').Key, a: SearchResult<OptimizeSolution>, b: SearchResult<OptimizeSolution>): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'solved' && b.kind === 'solved') {
    const va = a.value.value(objectiveNode, objectiveKey);
    const vb = b.value.value(objectiveNode, objectiveKey);
    if (va === undefined || vb === undefined) return va === vb;
    return closeEnough(va, vb);
  }
  return true; // both infeasible, or both did-not-converge
}

/**
 * Bind BOTH adapters behind a comparison wrapper: run them side by side, return the trusted answer, and flag
 * any divergence (docs §5). Referee mode is a CI/dev configuration, never the shipped default. Only the
 * async search capabilities are refereed here (that is where a second solver's answer must be proven to
 * match); `evaluate` — the synchronous hot path — is bound to the trusted adapter directly so the referee
 * never adds latency to a canvas edit. The candidate is only measured; the trusted answer is what ships.
 */
export function referee(trusted: SolverBindings, candidate: SolverBindings, report: ReportDivergence = throwOnDivergence): SolverBindings {
  const optimize: Optimize | undefined =
    trusted.optimize && candidate.optimize
      ? async (req) => {
          const t = trusted.optimize!;
          const c = candidate.optimize!;
          const [a, b] = await Promise.all([t(req), c(req)]);
          if (!equivalentOptimize(req.objective.node, req.objective.key, a, b)) {
            report('optimize', `trusted=${a.kind} candidate=${b.kind}`);
          }
          return a;
        }
      : trusted.optimize;

  const enumerate: Enumerate | undefined =
    trusted.enumerate && candidate.enumerate
      ? async (req) => {
          const t = trusted.enumerate!;
          const c = candidate.enumerate!;
          const [a, b] = await Promise.all([t(req), c(req)]);
          if (!equivalentEnumerate(a, b)) report('enumerate', `trusted=${a.kind} candidate=${b.kind}`);
          return a;
        }
      : trusted.enumerate;

  return {
    evaluate: trusted.evaluate,
    ...(optimize ? { optimize } : {}),
    ...(trusted.repair ? { repair: trusted.repair } : {}),
    ...(trusted.explainInfeasible ? { explainInfeasible: trusted.explainInfeasible } : {}),
    ...(enumerate ? { enumerate } : {}),
    ...(trusted.evaluateBatch ? { evaluateBatch: trusted.evaluateBatch } : {}),
  };
}

/** Whether two `EnumerateResult` are equivalent: same kind, and — when both `enumerated` — the same canonical
 *  selection set. Enumerate's order is deterministic, so an exact set compare is right (docs §5: exact for
 *  Enumerate's selection sets). */
function equivalentEnumerate(a: import('./capability').EnumerateResult, b: import('./capability').EnumerateResult): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'enumerated' && b.kind === 'enumerated') {
    const key = (sels: readonly import('./capability').Selection[]): string =>
      sels.map((s) => Object.keys(s).sort().map((k) => `${k}=${s[k]}`).join('|')).join('\n');
    return key(a.selections) === key(b.selections);
  }
  return true;
}
