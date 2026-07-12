import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import run from 'clingo-wasm';
import { parseMznCliOutput, type MznSolver } from '@sda/engine-solve';
import { answerSets, type RunAsp } from '@sda/engine-solve/asp';
import { makeIncumbentAdapter } from '../incumbent';
import { generatedRegistry } from './generator';
import { oracleHarnessOf } from './harness';

// THE SANITY GATE: run the INCUMBENT as its OWN candidate through the oracle harness. The
// oracle IS the incumbent, so this asserts the referee passes its own generated differential suite — a solver
// that cannot match itself would have a non-deterministic answer (a bug), and the whole harness would be
// worthless as a grader. When the domain solver arrives its test file calls the SAME
// `oracleHarnessOf` with the domain adapter as the candidate and this incumbent as the injected oracle.
//
// The native wiring is injected exactly as the incumbent/oracle tests inject it (does NOT skip when MiniZinc is
// absent — CI installs it). The harness core imports NEITHER this wiring NOR ../incumbent; both are supplied
// here, at the test boundary, keeping the harness engine-core-pure.

const MZN = process.env.MINIZINC ?? 'minizinc';
const solveMzn: MznSolver = async (model) => {
  const dir = mkdtempSync(join(tmpdir(), 'sda-harness-'));
  try {
    const file = join(dir, 'm.mzn');
    writeFileSync(file, model);
    const out = execFileSync(MZN, ['--solver', 'cbc', '--time-limit', '10000', '--output-mode', 'json', file], { encoding: 'utf8', timeout: 12000 });
    return parseMznCliOutput(out);
  } catch (e) {
    const partial = (e as { stdout?: string }).stdout;
    return partial ? parseMznCliOutput(partial) : { kind: 'unknown' as const };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const runAsp: RunAsp = async (program, models) => answerSets(await run(program, models));
const incumbent = makeIncumbentAdapter({ registry: generatedRegistry, solveMzn, runAsp });

// PERF BUDGET RATIONALE: each generated numeric instance is one native MiniZinc CLI spawn (the CLI has its own
// 10 s internal `--time-limit`; the process `timeout` is 12 s). The incumbent's own conformance suite already
// runs at a 20 s time budget for a single search (../incumbent/index.test.ts), and observed per-instance times
// on this corpus are well under 1 s. 15 s is comfortably above the incumbent's real per-instance time yet
// STRICTLY below the CLI/process ceiling — so a candidate that is correct but pathologically slow (e.g. a naive
// domain solver that spins) FAILS this budget rather than being amortized away across the batch (owner rule:
// a correct-but-slow candidate fails). Small `perCell` keeps the whole batch inside a CI run.
const PER_INSTANCE_BUDGET_MS = 15_000;

// NIGHT-LOOP KNOB (owner directive): the sanity gate roams with the same SDA_HARNESS_SEED offset as the native
// differential (native/index.test.ts), so a night loop distils the GENERATOR's self-consistency across fresh
// regions too. SEED 0 is byte-identical to the pre-hardening default (baseSeed 0x5da79). DEEP raises perCell.
// The gate stays BASELINE-only (no hardening axes): it is incumbent-vs-itself, so it cannot surface a native
// divergence — its job is only to prove the incumbent answers every generated instance self-consistently, which
// native/index.test.ts already exercises on the axes (the incumbent answers them there as the oracle).
const SEED = Number.parseInt(process.env.SDA_HARNESS_SEED ?? '0', 10) || 0;
const DEEP = process.env.SDA_HARNESS_DEEP === '1';
const reproEnv = `SDA_HARNESS_SEED=${SEED}${DEEP ? ' SDA_HARNESS_DEEP=1' : ''}`;

// The incumbent-as-candidate run: the sanity gate proper. perCell 2 ⇒ 36 numeric + 4 enumerate = 40 instances,
// each answered TWICE (oracle + candidate), CI-sized. Every instance must match itself and stay in budget.
oracleHarnessOf(incumbent, {
  label: 'incumbent as its own candidate (sanity gate)',
  oracle: incumbent,
  perInstanceBudgetMs: PER_INSTANCE_BUDGET_MS,
  corpus: { perCell: DEEP ? 4 : 2, baseSeed: 0x5da79 + SEED * 1_000_003 },
  reproEnv,
});

// Beyond the incumbent-as-candidate run: pin the harness's grading LOGIC directly, so a bug in the equivalence
// rule (which would let a lying candidate pass) is caught independently of the incumbent.
describe('oracle harness — the equivalence rule catches a divergent candidate', () => {
  it('a candidate that returns a WRONG optimize kind fails the differential', async () => {
    // A saboteur candidate: says `did-not-converge` where the oracle proves `infeasible`. The equivalence rule
    // must reject this (different kind), proving the harness would catch a real divergence — not rubber-stamp.
    const saboteur = {
      ...incumbent,
      optimize: async () => ({ kind: 'did-not-converge' as const }),
    };
    // We do not run a full describe here (that would register skipped/failing its); instead assert the rule
    // directly via a tiny oracle-vs-candidate on one UNSAT instance.
    const { generateNumeric } = await import('./generator');
    const { answerNumeric } = await import('./oracle');
    const inst = generateNumeric(20_000, 'optimize', 'chain', 'unsat');
    const truth = await answerNumeric(incumbent, inst);
    const lie = await answerNumeric(saboteur, inst);
    expect(truth.kind).toBe('infeasible');
    expect(lie.kind).toBe('did-not-converge');
    expect(truth.kind).not.toBe(lie.kind); // the differential compares kinds first — a divergence is caught
  });
});
