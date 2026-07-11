import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, allManifests } from '@sda/content';
import type { SolverBindings } from '@sda/solver-contract';
import { buildSearchTools } from './search';
import { buildSynthTools } from './synthesize';
import { bindSolvers } from './composition';

// NO-DRIFT SEAM PIN (TASK-79 phase 2.5). The whole point of routing synthesis through the solver CONTRACT is that
// the synthesis tools and the backward-search tools draw their solver capabilities from the SAME `SolverBindings` —
// ONE composition seam, switched in one place, never two that could silently diverge onto different solvers. This
// test proves it observationally: we instrument ONE bindings record's Optimize + Enumerate, hand that SAME record
// to BOTH buildSearchTools and buildSynthTools, run a synthesis tool, and assert the instrumented capabilities
// fired. A second, private solver seam inside buildSynthTools would bypass these spies — so this test fails the
// moment synthesis stops sharing the search tools' bindings. (Runs the native clingo + MiniZinc via bindSolvers,
// exactly like compare-options.test.ts, so it needs $env:MINIZINC set.)

describe('synthesis + search share ONE SolverBindings (no second solver seam)', () => {
  it('compare_options drives Optimize + Enumerate from the SAME bindings the search tools receive', async () => {
    const base = bindSolvers(registry); // the incumbent adapter (native clingo + MiniZinc)
    let optimizeCalls = 0;
    let enumerateCalls = 0;
    // exactOptionalPropertyTypes: spread each wrapper in ONLY when the base actually binds that capability, so we
    // never assign `undefined` to an optional field. The wrappers count invocations then delegate to the real
    // capability — behaviour is unchanged, only observed.
    const solvers: SolverBindings = {
      ...base,
      ...(base.optimize ? { optimize: async (req) => { optimizeCalls += 1; return base.optimize!(req); } } : {}),
      ...(base.enumerate ? { enumerate: async (req) => { enumerateCalls += 1; return base.enumerate!(req); } } : {}),
    };

    const s = new Studio(registry, allManifests);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
    s.dispatch({ kind: 'setConfig', node: 'client', key: 'throughput', value: 3000 });
    s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.faas' });
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['svc', 'in'] });

    // The SAME `solvers` record feeds BOTH tool sets — a second seam would bypass these instrumented capabilities.
    // Both builders take the identical `SolverBindings` (type-checked here, same reference at runtime).
    const search = buildSearchTools(s, solvers);
    const synth = buildSynthTools(s, solvers);
    expect(search.length).toBeGreaterThan(0);

    const compare = synth.find((t) => t.name === 'compare_options');
    expect(compare).toBeDefined();
    const res = await compare!.run({ node: 'svc' });
    expect(res.ok).toBe(true);

    // Enumerate produced the candidate topologies; Optimize sized each — both were read off the shared bindings.
    expect(enumerateCalls).toBeGreaterThan(0);
    expect(optimizeCalls).toBeGreaterThan(0);
  });
});
