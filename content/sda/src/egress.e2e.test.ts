import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { instantiate, manifests, registry, keys, systemSummary, type Instance, type Wire } from './index';

// Data-transfer (egress) cost is a SEPARATE bill line from compute/storage `cost`, modelled per node at the
// internet boundary and summed across the design. The API gateway sends 20 KB/response out @ $0.09/GB.
describe('data-transfer (egress) cost', () => {
  const instances: Instance[] = [
    { id: 'client', type: 'client.source', config: { throughput: 1000 } },
    { id: 'gw', type: 'gateway.api' },
    { id: 'compute', type: 'compute.faas', config: { concurrency: 100 } },
    { id: 'db', type: 'db.sql' },
  ];
  const wires: Wire[] = [
    { from: ['client', 'out'], to: ['gw', 'in'] },
    { from: ['gw', 'out'], to: ['compute', 'in'] },
    { from: ['compute', 'out'], to: ['db', 'in'] },
  ];
  const built = instantiate(manifests, instances, wires);
  if (!built.ok) throw new Error('build failed');
  const r = evaluate(built.value, registry);
  if (!r.ok) throw new Error(r.error.join('; '));

  it('computes egressCost = inflow · payload · rate · month / 1e9, separate from compute cost', () => {
    // gw inflow = 1000 req/s · 20,000 B · $0.09/GB · 2,592,000 s / 1e9 = $4,665.6/mo.
    expect(r.value.value(NodeId('gw'), keys.egressCost)).toBeCloseTo(4665.6, 1);
    // it does NOT touch the compute/storage `cost` line (gw cost is still its flat $50/mo).
    expect(r.value.value(NodeId('gw'), keys.cost)).toBe(50);
  });

  it('sums across the design (carried to the terminal); tiers with no payload add nothing', () => {
    // only gw egresses; faas/db have payloadBytes 0, so the cumulative egress at the terminal is gw's alone.
    expect(r.value.value(NodeId('db'), keys.egressCost)).toBeCloseTo(4665.6, 1);
  });

  it('the system roll-up breaks the bill into compute + egress + committed-pricing scenarios', () => {
    const cb = systemSummary(instances, wires, (id, k) => r.value.value(NodeId(id), k)).cost;
    expect(cb.computeUsdMonth).toBe(400); // gw 50 + faas 100·1.5 + db 200
    expect(cb.egressUsdMonth).toBeCloseTo(4665.6, 1);
    expect(cb.totalUsdMonth).toBeCloseTo(5065.6, 1);
    // committable = compute.faas (150) + db.sql (200); gw (gateway.api) is not. Commitment discounts only that.
    expect(cb.committableUsdMonth).toBe(350);
    expect(cb.committed1yrUsdMonth).toBeCloseTo(5065.6 - 350 * 0.4, 1); // −$140
    expect(cb.committed3yrUsdMonth).toBeCloseTo(5065.6 - 350 * 0.6, 1); // −$210
  });
});
