import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, commonManifests, keys, provisioningTunables } from '@sda/content';
import { bindSolvers, type RuntimeMode } from './composition';

// — the SWITCH pin. The default runtime is NATIVE (our in-process solver); `'incumbent'` stays
// SELECTABLE as the one-argument rollback. This test proves BOTH modes (and the referee) construct WORKING
// bindings — so the rollback is never a dead code path — and that the DEFAULT is native (it binds
// evaluateBatch, which only the native adapter implements). It exercises the pure hot path (evaluate) in every
// mode, so it needs no MiniZinc; the deep solve correctness lives in search.test.ts and the oracle harness.

function seed(): Studio {
  const s = new Studio(registry, commonManifests);
  s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
  s.dispatch({ kind: 'addComponent', id: 'app', type: 'compute.service' });
  s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['app', 'in'] });
  return s;
}

describe('composition root — the native switch with a selectable incumbent rollback', () => {
  const modes: RuntimeMode[] = ['native', 'incumbent', 'referee'];

  it.each(modes)('mode %s constructs working bindings (evaluate + the search capabilities + clingo enumerate)', (mode) => {
    const solvers = bindSolvers(registry, mode);
    // Every mode binds the hot path, the three async search capabilities, and clingo enumerate.
    expect(typeof solvers.evaluate).toBe('function');
    expect(typeof solvers.optimize).toBe('function');
    expect(typeof solvers.repair).toBe('function');
    expect(typeof solvers.explainInfeasible).toBe('function');
    expect(typeof solvers.enumerate).toBe('function');
    // The hot path is pure (no solver) — prove it actually evaluates in this mode.
    const g = seed().graph();
    expect(g.ok).toBe(true);
    if (g.ok) expect(solvers.evaluate({ graph: g.value }).ok).toBe(true);
  });

  it('the DEFAULT mode is native — it binds evaluateBatch, which only the native adapter implements', () => {
    expect(typeof bindSolvers(registry).evaluateBatch).toBe('function'); // native default
    expect(bindSolvers(registry, 'incumbent').evaluateBatch).toBeUndefined(); // rollback: the incumbent has no batch
  });

  it('native optimize/repair run IN-PROCESS (no MiniZinc): a trivial design repairs to a typed SearchResult', async () => {
    const s = seed();
    s.dispatch({ kind: 'setSLO', node: 'app', key: keys.throughput, band: { shape: 'minTargetMax', min: 1 } });
    const g = s.graph();
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const r = await bindSolvers(registry).repair!({ graph: g.value, tunables: provisioningTunables(g.value) });
    expect(['solved', 'infeasible', 'did-not-converge']).toContain(r.kind);
  });
});
