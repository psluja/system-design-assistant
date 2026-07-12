import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  registryOf,
  EdgeId,
  Key,
  NodeId,
  PortId,
  Unit,
  type Edge,
  type KeyDef,
  type Node,
  type Port,
} from '@sda/engine-core';
import { buildNetwork } from './build';
import { solve } from '../fixpoint';

// request (offers 400 req/s, 5 ms) → Lambda (capacity 100 req/s, 10 ms processing)
// Expected at Lambda: throughput = min(capacity 100, demand 400) = 100; latency = 10 + 5 = 15.
describe('buildNetwork (topology + aggregation)', () => {
  const tput = Key('throughput');
  const lat = Key('latency');
  const conc = Key('concurrency');
  const dur = Key('perRequestDuration');

  const registry = registryOf([
    { key: tput, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'min', onAsyncEdge: 'cut' }, kind: 'derived' },
    { key: lat, unit: Unit('ms'), band: 'percentiles', aggregate: { series: 'sum', onAsyncEdge: 'cut' }, kind: 'derived' },
    { key: conc, unit: Unit('1'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry' }, kind: 'input' },
    { key: dur, unit: Unit('ms'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry' }, kind: 'input' },
  ] satisfies KeyDef[]);

  const req = NodeId('req');
  const lam = NodeId('lambda');
  const reqOut = PortId('req.out');
  const lamIn = PortId('lam.in');

  const fixed = (key: Key, value: number, unit: string) =>
    ({ kind: 'input', key, value: { kind: 'fixed', quantity: { value, unit: Unit(unit) } } }) as const;

  const nodes: Node[] = [
    { id: req, ports: [reqOut], cells: [fixed(tput, 400, 'req/s'), fixed(lat, 5, 'ms')] },
    {
      id: lam,
      ports: [lamIn],
      cells: [
        fixed(conc, 20, '1'),
        fixed(dur, 200, 'ms'),
        fixed(lat, 10, 'ms'),
        { kind: 'derived', key: tput, relation: { produces: tput, reads: [conc, dur], expr: 'concurrency / (perRequestDuration / 1000)' } },
      ],
    },
  ];
  const ports: Port[] = [
    { id: reqOut, node: req, dir: 'out' },
    { id: lamIn, node: lam, dir: 'in' },
  ];
  const edges: Edge[] = [{ id: EdgeId('e1'), from: reqOut, to: lamIn, semantics: 'sync' }];

  it('computes effective throughput = min(capacity, demand) and accumulates latency', () => {
    const g = buildGraph({ nodes, ports, edges });
    expect(g.ok).toBe(true);
    if (!g.ok) return;

    const net = buildNetwork(g.value, registry);
    expect(net.ok).toBe(true);
    if (!net.ok) throw new Error(net.error.join('; '));

    const r = solve(net.value.system);
    expect(r.converged).toBe(true);

    expect(r.values.get(net.value.out(req, tput))).toBe(400); // source offers 400
    expect(r.values.get(net.value.out(lam, tput))).toBe(100); // bottlenecked to capacity
    expect(r.values.get(net.value.out(lam, lat))).toBe(15); // 10 (local) + 5 (upstream)
  });
});
