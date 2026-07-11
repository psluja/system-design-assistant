import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  registryOf,
  EdgeId,
  Key,
  NodeId,
  PortId,
  Unit,
  type Band,
  type Edge,
  type Node,
  type Port,
} from '@sda/engine-core';
import { buildNetwork } from '../network';
import { solve } from '../fixpoint';
import { evaluateBands } from './check';

const tput = Key('throughput');
const conc = Key('concurrency');
const dur = Key('perRequestDuration');

const registry = registryOf([
  { key: tput, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'min', onAsyncEdge: 'cut' }, kind: 'derived' },
  { key: conc, unit: Unit('1'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry' }, kind: 'input' },
  { key: dur, unit: Unit('ms'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry' }, kind: 'input' },
]);

// request(400) → Lambda(capacity 100) with a throughput band on Lambda.
function lambdaThroughputVerdict(band: Band): { status: string; value: number } {
  const req = NodeId('req');
  const lam = NodeId('lambda');
  const reqOut = PortId('req.out');
  const lamIn = PortId('lam.in');

  const nodes: Node[] = [
    { id: req, ports: [reqOut], cells: [{ kind: 'input', key: tput, value: { kind: 'fixed', quantity: { value: 400, unit: Unit('req/s') } } }] },
    {
      id: lam,
      ports: [lamIn],
      cells: [
        { kind: 'input', key: conc, value: { kind: 'fixed', quantity: { value: 20, unit: Unit('1') } } },
        { kind: 'input', key: dur, value: { kind: 'fixed', quantity: { value: 200, unit: Unit('ms') } } },
        { kind: 'derived', key: tput, relation: { produces: tput, reads: [conc, dur], expr: 'concurrency / (perRequestDuration / 1000)' } },
        { kind: 'input', key: tput, value: { kind: 'band', band } },
      ],
    },
  ];
  const ports: Port[] = [
    { id: reqOut, node: req, dir: 'out' },
    { id: lamIn, node: lam, dir: 'in' },
  ];
  const edges: Edge[] = [{ id: EdgeId('e1'), from: reqOut, to: lamIn, semantics: 'sync' }];

  const g = buildGraph({ nodes, ports, edges });
  if (!g.ok) throw new Error('invalid graph');
  const net = buildNetwork(g.value, registry);
  if (!net.ok) throw new Error(net.error.join('; '));
  const r = solve(net.value.system);
  const verdicts = evaluateBands(g.value, registry, net.value, r.values);
  const v = verdicts.find((x) => x.key === tput && x.scope === lam);
  if (v === undefined) throw new Error('no verdict for lambda throughput');
  return { status: v.status, value: v.computed.value };
}

describe('evaluateBands', () => {
  it('warns when computed meets the floor but is below target (the doc-2 example)', () => {
    // throughput = min(capacity 100, demand 400) = 100; band [min 50, target 400]
    const r = lambdaThroughputVerdict({ shape: 'minTargetMax', min: 50, target: 400 });
    expect(r.value).toBe(100);
    expect(r.status).toBe('warning');
  });

  it('violates when computed is below the hard floor', () => {
    expect(lambdaThroughputVerdict({ shape: 'minTargetMax', min: 200 }).status).toBe('violation');
  });

  it('passes when computed meets the target', () => {
    expect(lambdaThroughputVerdict({ shape: 'minTargetMax', min: 50, target: 80 }).status).toBe('ok');
  });
});
