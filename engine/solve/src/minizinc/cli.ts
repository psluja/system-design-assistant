// Reading a MiniZinc solver's output is its own small contract, and getting it wrong silently throws away
// correct, proven-optimal solutions. This is the ONE place that turns a solver's raw stdout into an
// outcome — shared by every CLI/WASM adapter and every test, so the fragile "JSON.parse the first block"
// pattern lives once, tested, instead of copied per call site.

/**
 * The outcome of solving a MiniZinc model. "No solution" is a first-class VALUE, not an exception
 * (doc-4: uncertainty is a value — `unknown` / `did-not-converge` — never a guess and never a throw).
 * The three kinds are genuinely different and the search modes must NOT conflate them:
 *  - `solved`     — a solution (for an `optimize`, the proven optimum) with its numeric assignments.
 *  - `infeasible` — the solver PROVED no assignment satisfies the constraints (UNSAT). Actionable: explain.
 *  - `unknown`    — it ran but neither found nor disproved a solution (hit the time limit). Try again / simplify.
 */
export type SolveOutcome =
  | { readonly kind: 'solved'; readonly values: Readonly<Record<string, number>> }
  | { readonly kind: 'infeasible' }
  | { readonly kind: 'unknown' };

// A `"name" : <number>` assignment in MiniZinc's JSON output. Deliberately matches ONLY numeric values:
// a presolve-aggregated variable can be serialized as another variable's NAME (`"c26" : c12`), which is
// not valid JSON and would break a whole-blob `JSON.parse`. Those incidental aggregates are skipped — the
// values a caller reads back (the free tunables and the minimized objective) always carry a concrete number.
const NUMERIC_ASSIGN = /"([^"]+)"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/**
 * Parse the stdout of a MiniZinc solve (default output or `--output-mode json`) into a {@link SolveOutcome}.
 * Robust to two real solver behaviours that otherwise corrupt a successful solve:
 *  - aggregated variables serialized as a NAME rather than a number — skipped, not fatal (see above);
 *  - several improving solutions separated by `----------` — the LAST complete block is the best/optimal.
 */
export function parseMznCliOutput(stdout: string): SolveOutcome {
  if (/=====\s*UNSATISFIABLE\s*=====/.test(stdout)) return { kind: 'infeasible' };

  // Solutions are separated by `----------`; a trailing `==========` / `=====UNKNOWN=====` is a status
  // marker, not a solution. Scan from the end for the last block that actually carries a solution object.
  const blocks = stdout.split('----------');
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i] ?? '';
    if (!block.includes('{')) continue;
    const values: Record<string, number> = {};
    let m: RegExpExecArray | null;
    NUMERIC_ASSIGN.lastIndex = 0;
    while ((m = NUMERIC_ASSIGN.exec(block)) !== null) values[m[1] as string] = Number(m[2]);
    return { kind: 'solved', values };
  }
  return { kind: 'unknown' };
}
