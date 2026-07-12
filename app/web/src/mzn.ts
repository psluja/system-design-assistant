import type { MznSolver } from '@sda/engine-solve';

// In-browser MiniZinc with the HiGHS MIP backend (also gecode/chuffed/coin-bc), vendored under
// public/minizinc and built reproducibly via tools/minizinc-wasm. HiGHS gives an EXACT optimum for the
// backward-search models — unlike Gecode, whose float branch-and-bound optimality proof
// does not terminate. Lazy: the 16 MB wasm is fetched only on the first solve. The page must be
// cross-origin isolated (COOP/COEP) for the solver's worker threads — set in vite dev/preview.

interface MznModel {
  addString(s: string): string;
  solve(cfg: { jsonOutput?: boolean; options: Record<string, unknown> }): Promise<{ solution?: { output?: { json?: Record<string, unknown> } } }>;
}
interface MznApi {
  Model: new () => MznModel;
  solvers(): Promise<Array<{ id?: string; name?: string }>>;
}

let apiP: Promise<MznApi> | undefined;
function loadApi(): Promise<MznApi> {
  // Resolve the vendored module relative to the page (works under any base path). The library then
  // auto-resolves its SIBLING worker + wasm + data — do not pass explicit URLs (that path deadlocks).
  apiP ??= import(/* @vite-ignore */ new URL('minizinc/minizinc.mjs', document.baseURI).href) as Promise<MznApi>;
  return apiP;
}

export const solveMzn: MznSolver = async (model) => {
  const MiniZinc = await loadApi();
  const m = new MiniZinc.Model();
  m.addString(model);
  // `time-limit` (ms) caps the solve so a pathological MIP returns its best-so-far instead of freezing the
  // tab — bounded latency is a correctness requirement for an interactive/agent-driven tool, not a nicety.
  const r = await m.solve({ jsonOutput: true, options: { solver: 'highs', 'time-limit': 10_000 } });
  const json = r.solution?.output?.json ?? {};
  const values: Record<string, number> = {};
  // Keep only numeric assignments — a presolve-aggregated variable can come back as another variable's name
  // (a non-number), which we skip; the values a caller reads back always carry a concrete number.
  for (const [k, v] of Object.entries(json)) if (typeof v === 'number') values[k] = v;
  // An empty solution means minizinc-js returned no values within the time limit (or the model was
  // infeasible). This surface can't tell the two apart, so report `unknown` rather than guess `infeasible`.
  return Object.keys(values).length === 0 ? { kind: 'unknown' } : { kind: 'solved', values };
};
