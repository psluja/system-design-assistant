import type { Registry } from '@sda/engine-core';
import type { SolverBindings } from '@sda/solver-contract';

// THE COMPOSITION ROOT — browser twin. The ONE place the web app binds
// a solver adapter to the capabilities; every consumer (Improve, the AI bridge) depends on the resulting
// `SolverBindings`, never on a concrete solver.
//
// BUNDLE SEPARATION (docs §6) lives in this file. Everything that pulls in a WASM solver loader is reached
// ONLY through dynamic `import()`:
//   - `@sda/solver-contract/incumbent` (which imports @sda/engine-solve) and the browser MiniZinc/clingo
//     providers (./mzn, ./clingo) are imported dynamically, so each lands in its own lazy chunk and is never in
//     the entry bundle's static graph;
//   - `@sda/solver-contract/native` is dynamic too — it pulls in the pure-TS cell-network evaluator, no WASM.
// THE PHASE-3 WIN: with `native` as the default (below), ./mzn is imported ONLY in the `incumbent`/`referee`
// branches, so the 17.8 MB MiniZinc WASM is never even reachable — let alone fetched — on the shipped path.
// The bundle-separation lint proves no runtime entry statically reaches a solver loader; this switch proves the
// heavy one is off the default runtime entirely.

/** The runtime mode the browser binds:
 *  - `native`    — the DEFAULT: the numeric capabilities (optimize / repair / explain-infeasible / evaluate /
 *                  evaluateBatch) run IN-PROCESS over the cell network — no MiniZinc WASM fetch. `enumerate`
 *                  stays clingo/ASP (bound from a clingo-only incumbent instance).
 *  - `incumbent` — the ROLLBACK: the incumbent adapter over the browser MiniZinc (HiGHS) + clingo. Only this
 *                  branch imports ./mzn, so it is the only one that can fetch the 17.8 MB WASM.
 *  - `referee`   — a dev configuration: both adapters, trusted = incumbent, and any native divergence is flagged. */
export type BrowserRuntimeMode = 'native' | 'incumbent' | 'referee';

/** Bind the browser solver capabilities. Async because it dynamically imports the chosen adapter(s) and the
 *  browser solver providers (the lazy-chunk discipline that keeps them out of the entry bundle).
 *
 * ROLLBACK: change the ONE default below from `'native'` to `'incumbent'` and the web shell
 *  reverts to the MiniZinc/HiGHS path — one word, no other edit. See the bundle-separation note above. */
export async function bindBrowserSolvers(registry: Registry, mode: BrowserRuntimeMode = 'native'): Promise<SolverBindings> {
  // `enumerate` is clingo/ASP in EVERY mode (native does not implement it — by design), so ./clingo always
  // loads; its WASM still fetches only on the first enumeration. The incumbent adapter provides enumerate from
  // just the ASP runner — no MiniZinc.
  const clingoP = import('./clingo');

  if (mode === 'incumbent') {
    // ROLLBACK path. THIS is the only branch that imports ./mzn, so the 17.8 MB MiniZinc WASM is reachable (and
    // fetched on the first solve) ONLY when the incumbent is bound — never on the native default.
    const [{ makeIncumbentAdapter }, { solveMzn }, { runAsp }] = await Promise.all([import('@sda/solver-contract/incumbent'), import('./mzn'), clingoP]);
    return makeIncumbentAdapter({ registry, solveMzn, runAsp });
  }

  // native (default) + referee both bind the in-process native adapter for the numeric capabilities, plus the
  // incumbent's clingo `enumerate` (no MiniZinc — the ASP runner alone). No ./mzn import ⇒ no MiniZinc fetch.
  // (An incumbent with a `runAsp` always binds `enumerate`; the conditional spread satisfies exactOptionalPropertyTypes.)
  const [{ makeNativeAdapter }, { makeIncumbentAdapter }, { runAsp }] = await Promise.all([import('@sda/solver-contract/native'), import('@sda/solver-contract/incumbent'), clingoP]);
  const enumerate = makeIncumbentAdapter({ registry, runAsp }).enumerate;
  const nativeBindings: SolverBindings = { ...makeNativeAdapter({ registry }), ...(enumerate ? { enumerate } : {}) };
  if (mode === 'native') return nativeBindings;

  // referee (dev only): trusted = incumbent (needs ./mzn), candidate = native — proves the switch in-browser.
  const [{ referee }, { solveMzn }] = await Promise.all([import('@sda/solver-contract'), import('./mzn')]);
  return referee(makeIncumbentAdapter({ registry, solveMzn, runAsp }), nativeBindings);
}
