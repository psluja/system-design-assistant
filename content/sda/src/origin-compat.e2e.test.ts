import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { instantiate, manifests, registry, keys, type Instance, type Wire } from './index';

// LEGACY PINNING (backward compatibility): the universal traffic-origin mechanism must be a PERFECT no-op for
// every design that uses a `client.*` source and no assumedRps. These are the exact golden numbers from
// e2e.test.ts BEFORE the origin change — pinned here so any drift in the origin wrapper is caught immediately.
// A client is still a traffic source; its throughput-as-workload preset (assumedRps defaults to 0) is unchanged.
describe('legacy client design — identical values after the origin change', () => {
  const instances: Instance[] = [
    { id: 'client', type: 'client.source' },
    { id: 'gw', type: 'gateway.api' },
    { id: 'compute', type: 'compute.faas', config: { concurrency: 30 } },
    { id: 'db', type: 'db.sql', bands: [{ key: keys.throughput, band: { shape: 'minTargetMax', target: 1000 } }] },
  ];
  const wires: Wire[] = [
    { from: ['client', 'out'], to: ['gw', 'in'] },
    { from: ['gw', 'out'], to: ['compute', 'in'] },
    { from: ['compute', 'out'], to: ['db', 'in'] },
  ];

  it('the whole chain is byte-for-byte the pre-origin golden', () => {
    const g = instantiate(manifests, instances, wires);
    if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
    const r = evaluate(g.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    const db = NodeId('db');
    expect(r.value.value(db, keys.throughput)).toBe(600); // bottlenecked by the 600 req/s compute tier
    expect(r.value.value(db, keys.latency)).toBe(63); // 0 + 5 + 50 + 8
    expect(r.value.value(db, keys.availability)).toBeCloseTo(0.9989, 3);
    expect(r.value.value(db, keys.cost)).toBe(295); // 50 + 30·1.5 + 200 — provisionedCost still reads capacity
    // the client's assumedRps defaults to 0 and does not perturb the flow (its throughput preset drives it as before)
    expect(r.value.value(NodeId('client'), keys.assumedRps)).toBe(0);
  });
});
