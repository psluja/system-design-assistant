import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { instantiate, commonManifests, registry, keys, type Instance, type Wire } from '../index';

// FAN-IN: offered loads ADD. When two producers feed one shared node (e.g. a control plane and a data
// plane that both hit the same Postgres), that node's offered load is the SUM of the two — not the min.
// This is the bug that connecting the two planes exposed: `throughput` aggregates DOWN a path as `min`
// (the bottleneck) but ACROSS inputs as `sum` (fanIn). The store overflows on the total.
describe('fan-in: offered loads sum at a shared node', () => {
  it('two producers into one Postgres ⇒ it is offered the SUM, and overflows on the total', () => {
    const insts: Instance[] = [
      { id: 'a', type: 'client.web', config: { throughput: 3000 } },
      { id: 'b', type: 'client.web', config: { throughput: 3000 } },
      { id: 'pg', type: 'db.postgres', config: { concurrency: 200 } }, // capacity = 200 / 50 ms = 4000 req/s
    ];
    const wires: Wire[] = [
      { from: ['a', 'out'], to: ['pg', 'in'] },
      { from: ['b', 'out'], to: ['pg', 'in'] },
    ];
    const g = instantiate(commonManifests, insts, wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const r = evaluate(g.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));

    // offered = 3000 + 3000 = 6000 (SUM, not min(3000,3000)=3000); capacity 4000.
    expect(r.value.value(NodeId('pg'), keys.throughput)).toBe(4000); // served = min(capacity, offered)
    expect(r.value.value(NodeId('pg'), keys.overflow)).toBe(2000); // 6000 − 4000 dropped (would be 0 under the old min bug)
  });
});
