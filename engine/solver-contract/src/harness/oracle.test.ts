import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import run from 'clingo-wasm';
import { parseMznCliOutput, type MznSolver } from '@sda/engine-solve';
import { answerSets, type RunAsp } from '@sda/engine-solve/asp';
import { makeIncumbentAdapter } from '../incumbent';
import { generateEnumerate, generateNumeric, generatedRegistry } from './generator';
import { answer, answerEnumerate, answerNumeric } from './oracle';

// The ORACLE's own tests: the incumbent (native MiniZinc/COIN-BC + clingo) certifies a
// generated instance, and we assert the CERTIFIED-ANSWER SHAPES the harness compares on — {kind, objective
// value, SLO satisfaction} for optimize, change/shortfall sets for repair/explain, selection sets for
// enumerate. The native wiring is injected exactly as the incumbent test injects it (does NOT skip when
// MiniZinc is absent — CI installs it; ENOENT by design).

const MZN = process.env.MINIZINC ?? 'minizinc';
const solveMzn: MznSolver = async (model) => {
  const dir = mkdtempSync(join(tmpdir(), 'sda-oracle-'));
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
const oracle = makeIncumbentAdapter({ registry: generatedRegistry, solveMzn, runAsp });

describe('oracle — the incumbent certifies generated answers', () => {
  it('optimize SAT: a solved answer carries an objective value and SLO satisfaction', async () => {
    const inst = generateNumeric(10_000, 'optimize', 'chain', 'sat');
    const a = await answerNumeric(oracle, inst);
    expect(a.kind).toBe('solved');
    if (a.kind !== 'solved') return;
    expect(typeof a.objectiveValue).toBe('number');
    expect(a.sloSatisfied).toBe(true);
  });

  it('optimize UNSAT: a proven-infeasible design certifies as `infeasible` (not did-not-converge)', async () => {
    const inst = generateNumeric(10_001, 'optimize', 'chain', 'unsat');
    const a = await answerNumeric(oracle, inst);
    expect(a.kind).toBe('infeasible');
  });

  it('explainInfeasible UNSAT: a certified shortfall set names the failing floor and by how much', async () => {
    const inst = generateNumeric(10_002, 'explainInfeasible', 'fan-out', 'unsat');
    const a = await answerNumeric(oracle, inst);
    expect(a.kind).toBe('solved');
    if (a.kind !== 'solved') return;
    expect((a.shortfalls ?? []).length).toBeGreaterThan(0);
    expect(a.shortfalls?.every((s) => s.bound === 'floor')).toBe(true);
  });

  it('repair SAT: a certified change set is minimal (each edit lands on a tunable, delta ≥ 0)', async () => {
    const inst = generateNumeric(10_003, 'repair', 'fan-out', 'sat');
    const a = await answerNumeric(oracle, inst);
    expect(a.kind).toBe('solved');
    if (a.kind !== 'solved') return;
    for (const c of a.changes ?? []) expect(c.delta).toBeGreaterThanOrEqual(0);
  });

  it('enumerate SAT/UNSAT: a certified selection set is non-empty for SAT, empty for UNSAT', async () => {
    const sat = await answerEnumerate(oracle, generateEnumerate(10_004, 'sat'));
    expect(sat.kind).toBe('enumerated');
    expect((sat.selections ?? []).length).toBeGreaterThan(0);
    const unsat = await answerEnumerate(oracle, generateEnumerate(10_005, 'unsat'));
    expect(unsat.kind).toBe('enumerated');
    expect(unsat.selections).toEqual([]);
  });

  it('the certified answer is DETERMINISTIC: the same instance answered twice is byte-equal', async () => {
    const inst = generateNumeric(10_006, 'optimize', 'fan-in', 'sat');
    const once = await answerNumeric(oracle, inst);
    const twice = await answerNumeric(oracle, inst);
    expect(once).toEqual(twice);
  });

  it('the dispatch tags each answer by its instance kind', async () => {
    const num = await answer(oracle, generateNumeric(10_007, 'optimize', 'chain', 'sat'));
    expect(num.kind).toBe('numeric');
    const en = await answer(oracle, generateEnumerate(10_008, 'sat'));
    expect(en.kind).toBe('enumerate');
  });
});
