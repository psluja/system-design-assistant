import { describe, expect, it } from 'vitest';
import run from 'clingo-wasm';
import { answerSets, type RunAsp } from '@sda/engine-solve/asp';
import { makeIncumbentAdapter } from '@sda/solver-contract/incumbent';
import { manifests, commonManifests, registry, keys } from './index';
import { synthesize, type SynthSpec } from './synthesize';

// synthesize in FORWARD mode (no tunables ⇒ no MIP needed): the Enumerate capability enumerates the 4 candidate
// architectures, the Evaluate capability judges each AS-CONFIGURED, the SLO band on `store` filters them, and the
// survivors are ranked by monthly cost. The VM compute (cap 800) misses the 1000 req/s band, so only the two
// FaaS designs remain — cheapest first. Deps come from the SAME incumbent adapter production binds: no solveMzn,
// so it exposes Evaluate + Enumerate but no Optimize (forward ranking never sizes) — proving synthesize() runs
// purely on the contract capabilities. The clingo solver is injected (node provider here).
const runAsp: RunAsp = async (program, models) => answerSets(await run(program, models));
const solvers = makeIncumbentAdapter({ registry, runAsp });
const deps = { enumerate: solvers.enumerate!, evaluate: solvers.evaluate };

describe('content pack ⇄ synthesize (forward: clingo → evaluate → rank)', () => {
  const spec: SynthSpec = {
    fixed: [
      { id: 'client', type: 'client.source' },
      { id: 'gw', type: 'gateway.api' },
    ],
    slots: [
      // the SLO is a band on the chosen store, whichever type wins (≥ 1000 req/s)
      { id: 'c', node: 'compute', types: ['compute.faas', 'compute.vm'] },
      { id: 's', node: 'store', types: ['db.sql', 'db.cheap'], bands: [{ key: keys.throughput, band: { shape: 'minTargetMax', min: 1000 } }] },
    ],
    adjacencies: [['c', 's']],
    wires: [
      { from: ['client', 'out'], to: ['gw', 'in'] },
      { from: ['gw', 'out'], to: ['compute', 'in'] },
      { from: ['compute', 'out'], to: ['store', 'in'] },
    ],
    objective: { node: 'store', key: keys.cost },
  };

  it('generates, verifies and ranks candidate architectures', async () => {
    const designs = await synthesize(manifests, spec, deps);

    // only the FaaS designs meet 1000 req/s (the VM caps at 800); cheapest first
    expect(designs.map((d) => `${d.selection.c}+${d.selection.s}`)).toEqual(['compute.faas+db.cheap', 'compute.faas+db.sql']);
    expect(designs[0]?.objective).toBe(290); // gw 50 + faas 150 + cheap 90
    expect(designs[1]?.objective).toBe(400); // gw 50 + faas 150 + sql 200
    expect(designs[0]?.value('store', keys.throughput)).toBe(1000); // SLO met
    expect(designs[0]?.assignments).toEqual([]); // forward mode applies no sizing
  });

  it('returns nothing when the SLO is unreachable', async () => {
    const spec5k: SynthSpec = { ...spec, slots: [spec.slots[0]!, { ...spec.slots[1]!, bands: [{ key: keys.throughput, band: { shape: 'minTargetMax', min: 5000 } }] }] };
    const designs = await synthesize(manifests, spec5k, deps);
    expect(designs).toEqual([]);
  });

  // GENERALITY: any node, any candidates, any objective+direction — here a CACHE choice under a 150k op/s
  // load, no compute and no cost in sight. Single-threaded Redis (100k cap) OVERFLOWS and is rejected; only
  // Memcached (200k) can serve it. Shows both that the mechanism is category-agnostic AND that the universal
  // overflow band correctly filters an infeasible alternative.
  it('chooses among any alternatives (cache); overflow rejects the infeasible one', async () => {
    const cacheSpec: SynthSpec = {
      fixed: [{ id: 'load', type: 'client.web', config: { throughput: 150000 } }],
      slots: [{ id: 'k', node: 'cache', types: ['cache.redis', 'cache.memcached'] }],
      adjacencies: [],
      wires: [{ from: ['load', 'out'], to: ['cache', 'in'] }],
      objective: { node: 'cache', key: keys.throughput, direction: 'max' },
    };
    const designs = await synthesize(commonManifests, cacheSpec, deps);
    expect(designs.map((d) => d.selection.k)).toEqual(['cache.memcached']); // Redis overflows at 150k ⇒ rejected
    expect(designs[0]?.objective).toBe(150000); // Memcached serves the full load
  });
});
