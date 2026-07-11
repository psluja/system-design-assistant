import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Studio, deserialize } from '@sda/core';
import { registry, allManifests, keys, cyclicFlowDiagnosis, type Wire } from '@sda/content';
import type { SolverBindings } from '@sda/solver-contract';
import { didNotConvergeBecause } from '@sda/solver-contract';
import { buildTools } from './tools';
import { buildSearchTools } from './search';
import { bindSolvers } from './composition';

// TASK-86 F1 — the CQRS dogfood at scale + the honest-decline mislabel regression.
//
// The committed 23-node CQRS example carries a total-cost SLO (`rstore.cost ≤ 30000`) — a BUDGET ceiling that the
// naive corner witness misreads as a floor↔ceiling coupling, so the native solver used to DECLINE it in ~0.2s and
// the tool dressed that decline as "did not converge within the time limit". That was two lies at once: the design
// is FEASIBLE (the incumbent MiniZinc solver sizes it with no change needed), and the decline was STRUCTURAL, not a
// timeout. This suite locks both facts: repair/optimize converge on the real file (plain + worlds), and a genuine
// throw / a structural decline are NEVER labelled a time limit.

// A FROZEN copy of the committed 23-node design, checked in beside this test (a byte snapshot of
// `git show HEAD:examples/cqrs-production-large.sda.json` at the time this regression was written). The live
// `examples/…` file is the OWNER'S working canvas — editing its bands there (WIP) must never redden this suite,
// which asserts facts about a SPECIFIC design (cost 20,980 < 30,000, no-change repair). Reading a frozen fixture
// decouples the regression from the owner's live edits; refresh the fixture deliberately if the committed design
// changes (re-run the `git show` above into this file). Path is resolved off the test module so it is portable.
const CQRS_FILE = new URL('./fixtures/cqrs-production-large.frozen.sda.json', import.meta.url);

function loadCqrs(): Studio {
  const doc = deserialize(readFileSync(CQRS_FILE, 'utf8'));
  if (!doc.ok) throw new Error(`could not load the CQRS example: ${doc.error}`);
  const s = new Studio(registry, allManifests);
  s.load(doc.value);
  return s;
}

const tool = (s: Studio, solvers: SolverBindings, name: string) => {
  const t = buildSearchTools(s, solvers).find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
};

describe('TASK-86 F1 — CQRS dogfood: backward search converges on the committed 23-node design', () => {
  it('repair converges (the design is already feasible — a no-change repair, matching the incumbent)', async () => {
    const s = loadCqrs();
    const t0 = performance.now();
    const r = await tool(s, bindSolvers(registry), 'repair').run({});
    const ms = Math.round(performance.now() - t0);
    expect(r.ok, `repair must converge, got: ${r.text}`).toBe(true);
    // The committed design meets every SLO (cost 20,980 < the 30,000 ceiling), so the minimal repair is no change.
    expect(r.text).toContain('already within SLOs');
    expect(ms, `repair took ${ms}ms — must stay interactive-adjacent`).toBeLessThan(2000);
  });

  it('optimize(rstore.cost, min) converges to a sized solution (the budget ceiling no longer forces a decline)', async () => {
    const s = loadCqrs();
    const t0 = performance.now();
    const r = await tool(s, bindSolvers(registry), 'optimize').run({ node: 'rstore', key: String(keys.cost), direction: 'min' });
    const ms = Math.round(performance.now() - t0);
    expect(r.ok, `optimize must converge, got: ${r.text}`).toBe(true);
    const assignments = JSON.parse(r.text) as Array<{ node: string; key: string; value: number }>;
    expect(assignments.length).toBeGreaterThan(0);
    expect(ms, `optimize took ${ms}ms — must stay interactive-adjacent`).toBeLessThan(3000);
  });

  it('repair {worlds:"all"} converges across the design\'s named worlds', async () => {
    const s = loadCqrs();
    const r = await tool(s, bindSolvers(registry), 'repair').run({ worlds: 'all' });
    // The design holds every world (its capacity headroom covers the derived demand), so a robust no-change / a
    // sized robust fix — either way it must NOT be a mislabelled timeout.
    expect(r.text).not.toContain('within the time limit');
    expect(r.ok, `worlds:'all' repair should converge, got: ${r.text}`).toBe(true);
  });
});

describe('TASK-86 F1 — the mislabel regression: a decline/throw is never dressed as a time limit', () => {
  // A minimal feasible-shaped design with a declared SLO, so the tool reaches the (stubbed) backward solver.
  function seedWithSlo(): Studio {
    const s = new Studio(registry, allManifests);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
    s.dispatch({ kind: 'addComponent', id: 'app', type: 'compute.service' });
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['app', 'in'] });
    s.dispatch({ kind: 'setSLO', node: 'app', key: keys.throughput, band: { shape: 'minTargetMax', min: 1 } });
    return s;
  }
  // A stub bindings whose repair does X; evaluate is a no-op (never reached on this path — repair fails/declines first).
  const stub = (repair: NonNullable<SolverBindings['repair']>): SolverBindings => ({
    evaluate: () => ({ ok: true, value: { converged: true, value: () => undefined, verdicts: [] } as never }),
    repair,
  });

  it('a STRUCTURAL decline names the true cause — never "within the time limit"', async () => {
    const reason = 'an SLO lies outside the in-process solver’s monotone class (a point-target SLO)';
    const s = seedWithSlo();
    const r = await tool(s, stub(async () => didNotConvergeBecause(reason)), 'repair').run({});
    expect(r.ok).toBe(false);
    expect(r.text).toContain(reason); // the true cause is surfaced verbatim
    expect(r.text).not.toContain('within the time limit'); // NEVER the old timeout mislabel
    expect(r.text).not.toContain('in time'); // nor the guarded-wrapper's old "in time" phrasing
  });

  it('a genuine THROW surfaces as an internal error, explicitly NOT a timeout', async () => {
    const s = seedWithSlo();
    const r = await tool(s, stub(async () => { throw new Error('boom-xyz'); }), 'repair').run({});
    expect(r.ok).toBe(false);
    expect(r.text).toContain('internal error');
    expect(r.text).toContain('not a timeout'); // the distinction is asserted explicitly
    expect(r.text).toContain('boom-xyz'); // the real error is not swallowed
    expect(r.text).not.toContain('within the time limit');
  });
});

describe('TASK-86 F7 — a cyclic flow names the cycle and points to request classes (the saga back-edge shape)', () => {
  it('cyclicFlowDiagnosis names the loop and the request-class remedy; ignores acyclic + self-loops', () => {
    // The saga back-edge shape from the dogfood: kafka → saga → kafka (the follow-up commands flow back).
    const cyclic: Wire[] = [
      { from: ['cmd', 'out'], to: ['kafka', 'in'] },
      { from: ['kafka', 'out'], to: ['saga', 'in'] },
      { from: ['saga', 'out'], to: ['kafka', 'in'] }, // the back-edge closes the loop
    ];
    const diag = cyclicFlowDiagnosis(cyclic);
    expect(diag).toBeDefined();
    expect(diag!.cycle).toContain('kafka');
    expect(diag!.cycle).toContain('saga');
    expect(diag!.message).toContain('cyclic flow');
    expect(diag!.message.toLowerCase()).toContain('request class'); // the named remedy
    // The committed (acyclic) CQRS saga writes forward to a store — no cycle, no diagnosis.
    const acyclic: Wire[] = [
      { from: ['cmd', 'out'], to: ['kafka', 'in'] },
      { from: ['kafka', 'out'], to: ['saga', 'in'] },
      { from: ['saga', 'db'], to: ['rds', 'in'] },
    ];
    expect(cyclicFlowDiagnosis(acyclic)).toBeUndefined();
    // A self-loop is the self() primitive, not a multi-node feedback — never flagged.
    expect(cyclicFlowDiagnosis([{ from: ['n', 'out'], to: ['n', 'in'] }])).toBeUndefined();
  });

  it('evaluate on a cyclic design returns the guided diagnosis, not a degenerate fixpoint report', () => {
    const s = new Studio(registry, allManifests);
    s.dispatch({ kind: 'addComponent', id: 'cli', type: 'client.web' });
    s.dispatch({ kind: 'addComponent', id: 'cmd', type: 'compute.service' });
    s.dispatch({ kind: 'addComponent', id: 'kafka', type: 'stream.kafka' });
    s.dispatch({ kind: 'addComponent', id: 'saga', type: 'compute.service' });
    s.dispatch({ kind: 'connect', from: ['cli', 'out'], to: ['cmd', 'in'] });
    s.dispatch({ kind: 'connect', from: ['cmd', 'out'], to: ['kafka', 'in'] });
    s.dispatch({ kind: 'connect', from: ['kafka', 'out'], to: ['saga', 'in'] });
    s.dispatch({ kind: 'connect', from: ['saga', 'out'], to: ['kafka', 'in'] }); // the saga back-edge
    const evaluate = buildTools(s).find((t) => t.name === 'evaluate')!;
    const r = evaluate.run({}) as { ok: boolean; text: string };
    expect(r.ok).toBe(false); // guided, not a degenerate green board
    expect(r.text).toContain('cyclic flow');
    expect(r.text).toContain('kafka');
    expect(r.text.toLowerCase()).toContain('request class');
  });
});
