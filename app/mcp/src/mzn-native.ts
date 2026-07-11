import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMznCliOutput, type MznSolver } from '@sda/engine-solve';

// An OPTIONAL local adapter (never a required backend): shell out to the native MiniZinc CLI for the
// backward-search modes, using the MIP/LP solver COIN-BC. This is the only place the exact float
// optimization runs — the browser's WASM bundle ships only Gecode/Chuffed (no MIP), so the web app's
// Auto-fix uses Gecode-best-effort while this adapter is the proven-optimal path (doc-4 §5).
const MZN = process.env.MINIZINC ?? 'minizinc';
// A HARD ceiling on solve time so a pathological MIP returns its best-so-far rather than hanging (a tool that
// can hang is poison for an AI flow — bounded, predictable latency is a correctness requirement). cbc returns
// the moment it PROVES the optimum, so easy problems stay fast and only genuinely hard ones hit the limit.
// `--time-limit` is the solver-level stop; the `timeout` on the process is a backstop if the solver ignores it.
const SOLVE_LIMIT_MS = (): number => Number(process.env.MZN_TIME_LIMIT_MS ?? 10_000);

/** Whether a MiniZinc binary is actually resolvable on THIS install — probed once and cached. The honest gate for
 *  ESCALATION (docs: honest escalation): a shell with no `$MINIZINC` and no `minizinc` on PATH ships no reference
 *  MIP, so a budget-coupling decline must stay the honest native decline there rather than dead-end pretending a
 *  solver exists. Probed with `--version` (cheap, no model), stderr swallowed, any failure ⇒ not available. */
let mznAvailable: boolean | undefined;
export function minizincAvailable(): boolean {
  if (mznAvailable === undefined) {
    try {
      execFileSync(MZN, ['--version'], { stdio: 'ignore', timeout: 5_000 });
      mznAvailable = true;
    } catch {
      mznAvailable = false;
    }
  }
  return mznAvailable;
}

export const nativeSolveMzn: MznSolver = (model) => {
  const dir = mkdtempSync(join(tmpdir(), 'sda-mzn-'));
  try {
    const file = join(dir, 'm.mzn');
    writeFileSync(file, model);
    const limit = SOLVE_LIMIT_MS();
    try {
      // `--time-limit` asks the solver to stop gracefully (best-so-far); the process `timeout` is the HARD
      // backstop that actually guarantees we return — cbc does not always honour the soft limit. A small
      // margin lets a graceful stop emit its output before the hard kill.
      const out = execFileSync(MZN, ['--solver', 'cbc', '--time-limit', String(limit), '--output-mode', 'json', file], { encoding: 'utf8', timeout: limit + 2_000 });
      return Promise.resolve(parseMznCliOutput(out));
    } catch (e) {
      // A hard process kill (the solver ignored the soft limit) still leaves the best-so-far on stdout; use
      // it if present, else report `unknown` — a no-solution is a VALUE here, never a thrown exception.
      const partial = (e as { stdout?: string }).stdout;
      return Promise.resolve(partial ? parseMznCliOutput(partial) : { kind: 'unknown' as const });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
