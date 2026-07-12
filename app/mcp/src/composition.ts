import type { Registry } from '@sda/engine-core';
import type { SolverBindings } from '@sda/solver-contract';
import { referee } from '@sda/solver-contract';
import { makeIncumbentAdapter } from '@sda/solver-contract/incumbent';
import { makeNativeAdapter } from '@sda/solver-contract/native';
import { minizincAvailable, nativeSolveMzn } from './mzn-native';
import { nativeRunAsp } from './clingo-node';
import type { ReferenceSolver } from './search';

// THE COMPOSITION ROOT for the node MCP server. This is the ONE place
// that decides which solver adapter answers which capability; every consumer depends on the resulting
// `SolverBindings`, never on a concrete solver. Switching implementations — for one capability or all — is a
// single change here.
//
// This node root imports both adapters STATICALLY: node has no bundle-size budget, so the dynamic-import
// discipline that keeps the heavy solvers extractable from a shipped bundle belongs to the BROWSER composition
// root (app/web/src/composition.ts), not here. The bundle-separation lint proves the web entry never statically
// reaches a solver loader; on node both adapters are always present anyway (the generic MiniZinc/COIN-BC solver
// stays in CI forever as the referee — docs §6).

/** The runtime mode a shell binds:
 *  - `native`     — the DEFAULT: our in-process domain solver answers the numeric capabilities (optimize /
 *                   repair / explain-infeasible / evaluate / evaluateBatch) with zero WASM and zero process
 *                   spawn. Topology `enumerate` is NOT a native capability (it stays clingo/ASP by design), so
 *                   it is bound from a clingo-only incumbent instance.
 *  - `incumbent`  — the ROLLBACK: today's MiniZinc/COIN-BC + clingo path for every capability (see below).
 *  - `referee`    — a CI/dev configuration: binds BOTH adapters, returns the trusted (incumbent) answer and
 *                   flags any divergence (a native answer that disagrees with the MIP is a P0 lie). Never shipped. */
export type RuntimeMode = 'native' | 'incumbent' | 'referee';

/**
 * Bind the solver capabilities for the given mode. Returns the `SolverBindings` record the tools depend on.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * ROLLBACK (owner's call, — "w najgorszym przypadku przełączymy z powrotem"): change the ONE
 * default below from `'native'` to `'incumbent'`. That single word reverts every node shell (the CLI server,
 * the bundled VS Code MCP server, the Improve solver-host, the Alternatives compare-host) to the proven-optimal
 * MiniZinc/COIN-BC path for optimize/repair — no other edit anywhere. The incumbent adapter and its solvers stay
 * in the repo and in CI forever (they referee the native answers), so the rollback is always available.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────
 */
export function bindSolvers(registry: Registry, mode: RuntimeMode = 'native'): SolverBindings {
  // The incumbent adapter over the native MiniZinc (COIN-BC) + clingo providers — today's proven path. Used
  // directly in `incumbent` mode, and as the TRUSTED oracle in `referee` mode.
  const incumbent = (): SolverBindings => makeIncumbentAdapter({ registry, solveMzn: nativeSolveMzn, runAsp: nativeRunAsp });
  // The native adapter over the in-process cell-network search — the DEFAULT for the numeric capabilities. It
  // does not implement `enumerate` (topology enumeration is clingo/ASP, out of scope for a numeric solver), so
  // enumerate is bound from an incumbent instance that needs ONLY the ASP runner — no MiniZinc binary. The
  // consequence is the win: the native runtime never touches the MiniZinc CLI for optimize/repair, yet
  // compare_options/synthesize still enumerate topologies via clingo (unchanged). (An incumbent with a `runAsp`
  // always binds `enumerate`; the conditional spread satisfies exactOptionalPropertyTypes without an assertion.)
  const native = (): SolverBindings => {
    const enumerate = makeIncumbentAdapter({ registry, runAsp: nativeRunAsp }).enumerate;
    return { ...makeNativeAdapter({ registry }), ...(enumerate ? { enumerate } : {}) };
  };
  switch (mode) {
    case 'native':
      return native();
    case 'incumbent':
      return incumbent();
    case 'referee':
      // Trusted = incumbent (proven-optimal MIP), candidate = native (in-process). The referee returns the
      // trusted answer and flags any divergence — the CI/dev gate that proves native still matches (docs §5).
      return referee(incumbent(), native());
  }
}

/**
 * The REFERENCE-MIP escalation target for the node shells (docs: honest escalation, owner ruling 2026-07-04). When
 * the default native solver declines a budget-coupling trade-off, the search tools rerun the SAME request on the
 * incumbent MiniZinc/COIN-BC adapter — the exact optimizer of record we already ship — and return ITS answer
 * labelled. Resolved LAZILY (only on a decline): it probes for a MiniZinc binary via `minizincAvailable()`, so a CLI
 * / VS Code install WITHOUT `$MINIZINC` and without `minizinc` on PATH returns `undefined` and the honest native
 * decline stands (never a dead-end pretending a solver exists, never a lie). The incumbent needs only `solveMzn`
 * here — enumerate/clingo is irrelevant to a numeric escalation.
 */
export function referenceSolver(registry: Registry): ReferenceSolver {
  return {
    resolve: () => Promise.resolve(minizincAvailable() ? makeIncumbentAdapter({ registry, solveMzn: nativeSolveMzn }) : undefined),
  };
}
