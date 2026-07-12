import { describe, expect, it } from 'vitest';
import { NodeId, type Key } from '@sda/engine-core';
import { createEngine } from '@sda/engine-solve';
import { instantiate, manifests, registry, type Instance, type Wire } from './index';
import { systemSummary, localContribution } from './system';
import { keys } from './registry';

// The shared system roll-up (used by BOTH the web System panel and the MCP `evaluate`, so human and AI see one
// picture). End-to-end metrics live at the flow TERMINAL (the algebra already summed/multiplied them up the
// path); the total cost is the sum of every node's OWN cost.
const instances: Instance[] = [
  { id: 'client', type: 'client.source' },
  { id: 'gw', type: 'gateway.api' },
  { id: 'fn', type: 'compute.faas' },
  { id: 'db', type: 'db.sql' },
];
const wires: Wire[] = [
  { from: ['client', 'out'], to: ['gw', 'in'] },
  { from: ['gw', 'out'], to: ['fn', 'in'] },
  { from: ['fn', 'out'], to: ['db', 'in'] },
];

describe('systemSummary — the shared end-to-end roll-up', () => {
  it('rolls up one flow at its terminal + the true total cost', () => {
    const g = instantiate(manifests, instances, wires);
    if (!g.ok) throw new Error('build failed');
    const ev = createEngine(registry).evaluate(g.value);
    if (!ev.ok) throw new Error('eval failed');
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const s = systemSummary(instances, wires, value);

    expect(s.flows).toHaveLength(1);
    const f = s.flows[0]!;
    expect(f.source).toBe('client');
    expect(f.terminal).toBe('db'); // deepest sink by cumulative latency
    expect(f.latencyMs).toBeGreaterThan(0); // end-to-end latency (a SUM up the path)
    expect(f.availability ?? 0).toBeGreaterThan(0); // end-to-end availability (a PRODUCT up the path)
    expect(f.availability ?? 1).toBeLessThanOrEqual(1);

    // Total cost = sum of each node's OWN cost; for a linear path that equals the cumulative cost at the terminal.
    expect(s.totalCostUsdMonth).toBeGreaterThan(0);
    const localSum = Object.values(localContribution(value, instances, wires, keys.cost)).reduce((a, b) => a + b, 0);
    expect(s.totalCostUsdMonth).toBeCloseTo(localSum, 6);
    expect(s.totalCostUsdMonth).toBeCloseTo(f.costUsdMonth ?? 0, 6); // linear path ⇒ terminal cumulative = total
  });
});
