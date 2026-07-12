import { describe, expect, it } from 'vitest';
import run from 'clingo-wasm';
import { answerSets, type RunAsp } from '@sda/engine-solve/asp';
import { makeIncumbentAdapter } from '@sda/solver-contract/incumbent';
import { synthesize, provisioningTunables, manifests, commonManifests, registry, keys, type SynthSpec } from '@sda/content';
import { nativeSolveMzn } from './mzn-native';

// synthesize in SIZED mode — the "Fargate vs Lambda vs ASG" auto-pick. The Enumerate capability enumerates the
// compute choices; the Optimize capability (MiniZinc/COIN-BC) SIZES EACH candidate to its cheapest config that
// meets the SLO; survivors are ranked by sized monthly cost. This is the fair comparison forward mode can't give
// (Lambda's concurrency is sized down to what the load needs, not priced at its arbitrary default). Deps come from
// the SAME incumbent adapter production binds — clingo-wasm + the native MiniZinc adapter behind the contract.
const runAsp: RunAsp = async (program, models) => answerSets(await run(program, models));
const solvers = makeIncumbentAdapter({ registry, solveMzn: nativeSolveMzn, runAsp });
const catalog = { ...manifests, ...commonManifests };

describe('synthesize SIZED (clingo → MiniZinc-size → rank): choose a compute service', () => {
  it('sizes and ranks Fargate vs Lambda vs ASG by cost for a fixed workload', async () => {
    const spec: SynthSpec = {
      fixed: [{ id: 'client', type: 'client.web', config: { throughput: 12 } }],
      slots: [
        {
          id: 'svc',
          node: 'svc',
          types: ['compute.fargate', 'compute.faas', 'compute.asg'],
          bands: [{ key: keys.overflow, band: { shape: 'minTargetMax', max: 0 } }], // must serve the load (no drops)
        },
      ],
      adjacencies: [],
      wires: [{ from: ['client', 'out'], to: ['svc', 'in'] }],
      objective: { node: 'svc', key: keys.cost, direction: 'min' },
    };

    const designs = await synthesize(catalog, spec, { enumerate: solvers.enumerate!, evaluate: solvers.evaluate, optimize: solvers.optimize!, tunables: provisioningTunables });

    // all three compute choices can be sized to meet the SLO ⇒ three verified, sized designs
    expect(designs.map((d) => d.selection.svc).sort()).toEqual(['compute.asg', 'compute.faas', 'compute.fargate']);
    // every survivor is feasible (overflow ≤ 0) and has a real, demand-driven monthly cost. (NB: a demand-
    // priced fleet has NO cost-affecting knob — its cost tracks the load via requiredUnits, not a tunable — so
    // `assignments` is legitimately empty for it; the optimiser prunes knobs the objective doesn't depend on.)
    for (const d of designs) {
      expect(d.value('svc', keys.overflow) ?? 0).toBeLessThanOrEqual(0.01);
      expect(d.value('svc', keys.cost) ?? 0).toBeGreaterThan(0);
    }
    // ranked cheapest-first
    for (let i = 1; i < designs.length; i++) expect(designs[i]!.objective).toBeGreaterThanOrEqual(designs[i - 1]!.objective);
  });
});
