import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { repairModel } from '@sda/engine-solve';
import { instantiate, manifests, commonManifests, registry, keys, type Instance, type Wire } from './index';

// Headroom is a SOLVER-only sizing target: optimize/repair keep each sizable tier at ρ ≤ factor, so the solved
// design has finite queueing latency (offered < capacity), not the ρ=1 knife-edge. This pins the generated
// MiniZinc model (no native solver needed): with headroom, repair adds an `offered ≤ factor·capacity` constraint
// the plain model doesn't have. The actual solve (that it lands at ρ ≤ 0.8) is verified in the browser/WASM.
describe('capacity headroom in the backward-search model', () => {
  const instances: Instance[] = [
    { id: 'client', type: 'client.source', config: { throughput: 5000 } },
    { id: 'svc', type: 'compute.faas', config: { concurrency: 100, perRequestDuration: 50 } },
  ];
  const wires: Wire[] = [{ from: ['client', 'out'], to: ['svc', 'in'] }];
  const built = instantiate(manifests, instances, wires);
  if (!built.ok) throw new Error('build failed');
  const tun = [{ node: NodeId('svc'), key: keys.concurrency, min: 1, max: 100000 }];

  it('repair WITH headroom adds an offered ≤ factor·capacity constraint the plain model lacks', () => {
    const plain = repairModel(built.value, registry, tun);
    const withH = repairModel(built.value, registry, tun, { key: keys.throughput, factor: 0.8 });
    if (!plain.ok || !withH.ok) throw new Error('model build failed');
    // a new constraint of the form `<= 0.8 * <capacity var>` (the tier's self(throughput)) appears.
    expect(withH.value.source).toMatch(/<=\s*0\.8\s*\*/);
    expect(withH.value.source.length).toBeGreaterThan(plain.value.source.length);
    expect(plain.value.source).not.toMatch(/<=\s*0\.8\s*\*/);
  });

  it('no headroom arg ⇒ the model is unchanged (opt-in, the forward verdicts never see it)', () => {
    const a = repairModel(built.value, registry, tun);
    const b = repairModel(built.value, registry, tun);
    if (!a.ok || !b.ok) throw new Error('model build failed');
    expect(a.value.source).toBe(b.value.source);
  });

  // A DEMAND-SIZED fleet (compute.fargate, scaled by maxUnits, capacity = maxUnits·perUnit) must ALSO earn the
  // headroom constraint — else Compare/Improve size it to exactly meet throughput (ρ=1, ∞ latency). The tunable
  // here is maxUnits (per provisioningTunables), so the constraint is on the sizing-relation capacity.
  it('a maxUnits-sized fleet (fargate) gets the headroom constraint too', () => {
    const inst: Instance[] = [
      { id: 'client', type: 'client.source', config: { throughput: 5000 } },
      { id: 'svc', type: 'compute.fargate' },
    ];
    const w: Wire[] = [{ from: ['client', 'out'], to: ['svc', 'in'] }];
    const g = instantiate({ ...manifests, ...commonManifests }, inst, w);
    if (!g.ok) throw new Error('build failed');
    const tunF = [{ node: NodeId('svc'), key: keys.maxUnits, min: 1, max: 100000 }];
    const withH = repairModel(g.value, registry, tunF, { key: keys.throughput, factor: 0.8 });
    if (!withH.ok) throw new Error('model build failed');
    expect(withH.value.source).toMatch(/<=\s*0\.8\s*\*/); // ρ ≤ 0.8 on the sized fleet's capacity
  });
});
