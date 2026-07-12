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
  type KeyDef,
  type Node,
  type Port,
  type Verdict,
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
] satisfies KeyDef[]);

// request(offers `demand`) → Lambda(intrinsic capacity 100 from its relation) with a throughput band.
function lambdaVerdict(band: Band, demand: number): Verdict {
  const req = NodeId('req');
  const lam = NodeId('lambda');
  const reqOut = PortId('req.out');
  const lamIn = PortId('lam.in');

  const nodes: Node[] = [
    { id: req, ports: [reqOut], cells: [{ kind: 'input', key: tput, value: { kind: 'fixed', quantity: { value: demand, unit: Unit('req/s') } } }] },
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
  const v = evaluateBands(g.value, registry, net.value, r.values).find((x) => x.key === tput && x.scope === lam);
  if (v === undefined) throw new Error('no verdict for lambda throughput');
  return v;
}

describe('verdict cause-chain + remediations (structural attribution)', () => {
  it('blames the node’s OWN capacity when it is the bottleneck', () => {
    // capacity 100 < demand 400 ⇒ Lambda itself is the min; floor 200 ⇒ violation.
    const v = lambdaVerdict({ shape: 'minTargetMax', min: 200 }, 400);
    expect(v.status).toBe('violation');
    expect(v.cause.length).toBe(1);
    expect(v.cause[0]?.scope).toBe(NodeId('lambda'));
    expect(v.cause[0]?.note).toContain('origin');
    expect(v.remediations[0]?.rank).toBe(1);
    expect(v.remediations[0]?.action).toContain('Increase'); // below floor ⇒ raise
    expect(v.remediations[0]?.action).toContain('lambda');
    expect(v.remediations[0]?.action).toContain('100');
  });

  it('traces upstream when the bottleneck is the source, not the node', () => {
    // demand 80 < capacity 100 ⇒ the SOURCE is the binding minimum; floor 200 ⇒ violation.
    const v = lambdaVerdict({ shape: 'minTargetMax', min: 200 }, 80);
    expect(v.status).toBe('violation');
    const origin = v.cause[v.cause.length - 1];
    expect(origin?.scope).toBe(NodeId('req')); // chain ends at the source
    expect(v.cause.some((l) => l.scope === NodeId('lambda'))).toBe(true); // passes through Lambda
    expect(v.remediations[0]?.action).toContain('req');
    expect(v.remediations[0]?.action).toContain('80');
  });

  it('leaves cause and remediations empty for an ok verdict', () => {
    const v = lambdaVerdict({ shape: 'minTargetMax', min: 50, target: 80 }, 400);
    expect(v.status).toBe('ok');
    expect(v.cause).toEqual([]);
    expect(v.remediations).toEqual([]);
  });
});
