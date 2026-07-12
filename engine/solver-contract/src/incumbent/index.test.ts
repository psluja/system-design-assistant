import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import run from 'clingo-wasm';
import { parseMznCliOutput, type MznSolver } from '@sda/engine-solve';
import { answerSets, type RunAsp } from '@sda/engine-solve/asp';
import { makeIncumbentAdapter } from './index';
import { conformanceOf } from '../conformance';
import { corpusObjective, corpusRegistry, corpusTunable, feasibleDesign, infeasibleDesign } from '../conformance/corpus';

// The native COIN-BC runner, injected exactly as the facade tests inject it (engine/solve/src/facade.test.ts)
// — the same MiniZinc the differential tests use. Like those tests it does NOT skip when MiniZinc is absent;
// it fails with ENOENT by design (CI installs MiniZinc; see .github/workflows/ci.yml).
const MZN = process.env.MINIZINC ?? 'minizinc';
const solveMzn: MznSolver = async (model) => {
  const dir = mkdtempSync(join(tmpdir(), 'sda-contract-'));
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

// The node ASP runner — the prebuilt clingo-wasm `run` composed with the shared `answerSets` parser, exactly
// as app/mcp/src/clingo-node.ts wires it.
const runAsp: RunAsp = async (program, models) => answerSets(await run(program, models));

const adapter = makeIncumbentAdapter({ registry: corpusRegistry, solveMzn, runAsp });

// THE ZERO-BEHAVIOR-CHANGE PROOF: the incumbent adapter passes the full conformance suite. This is what
// "implements the capability" means operationally (docs §4). Cancellation is skip-marked — the incumbent does
// not yet thread an AbortSignal to the WASM solvers (docs §7 step 4, tracked as a phase-0 follow-up).
conformanceOf(adapter, { label: 'incumbent (MiniZinc/COIN-BC · clingo · JS hot path)', timeBudgetMs: 20_000, supportsCancellation: false });

// Beyond the shared suite: pin the ADAPTATION layer specifically — that the facade's two error STRINGS become
// the contract's two typed KINDS, and the Enumerate honesty gap is closed (a throw becomes did-not-converge).
describe('incumbent adapter — the string→kind adaptation (migration step 3)', () => {
  it('evaluate is a synchronous pass-through of the facade evaluate', () => {
    const r = adapter.evaluate({ graph: feasibleDesign() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.converged).toBe(true);
  });

  it('a proven-infeasible optimize maps the INFEASIBLE string to the `infeasible` kind', async () => {
    const r = await adapter.optimize!({ graph: infeasibleDesign(), tunables: [corpusTunable], objective: corpusObjective });
    expect(r.kind).toBe('infeasible');
  });

  it('the enumerate honesty fix: a clingo ERROR becomes did-not-converge, never a throw', async () => {
    // A RunAsp that throws (as `answerSets` does on a clingo ERROR today) must surface as did-not-converge.
    const throwing: RunAsp = async () => {
      throw new Error('clingo error: simulated');
    };
    const withThrowingAsp = makeIncumbentAdapter({ registry: corpusRegistry, solveMzn, runAsp: throwing });
    const r = await withThrowingAsp.enumerate!({ problem: { slots: [{ id: 's', candidates: ['a'] }], adjacencies: [], compatible: [] } });
    expect(r.kind).toBe('did-not-converge');
  });

  it('capabilities are segregated: no solveMzn ⇒ no search capabilities bound', () => {
    const evalOnly = makeIncumbentAdapter({ registry: corpusRegistry });
    expect(evalOnly.evaluate).toBeDefined();
    expect(evalOnly.optimize).toBeUndefined();
    expect(evalOnly.enumerate).toBeUndefined();
  });
});
