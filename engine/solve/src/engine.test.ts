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
  type Node,
  type Port,
} from '@sda/engine-core';
import { evaluate } from './engine';

describe('evaluate (engine facade)', () => {
  it('evaluates a graph end-to-end: values + verdicts', () => {
    const tput = Key('throughput');
    const conc = Key('concurrency');
    const dur = Key('perRequestDuration');
    const registry = registryOf([
      { key: tput, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'min', onAsyncEdge: 'cut' }, kind: 'derived' },
      { key: conc, unit: Unit('1'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry' }, kind: 'input' },
      { key: dur, unit: Unit('ms'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry' }, kind: 'input' },
    ]);

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
          { kind: 'input', key: tput, value: { kind: 'band', band: { shape: 'minTargetMax', min: 50, target: 400 } } },
        ],
      },
    ];
    const ports: Port[] = [
      { id: reqOut, node: req, dir: 'out' },
      { id: lamIn, node: lam, dir: 'in' },
    ];
    const edges: Edge[] = [{ id: EdgeId('e1'), from: reqOut, to: lamIn, semantics: 'sync' }];

    const g = buildGraph({ nodes, ports, edges });
    expect(g.ok).toBe(true);
    if (!g.ok) return;

    const res = evaluate(g.value, registry);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error.join('; '));

    expect(res.value.converged).toBe(true);
    expect(res.value.value(lam, tput)).toBe(100);
    const v = res.value.verdicts.find((x) => x.scope === lam && x.key === tput);
    expect(v?.status).toBe('warning');
  });

  it('returns an error when a graph references an unregistered key', () => {
    const mystery = Key('mystery');
    const registry = registryOf([]);
    const n = NodeId('n');
    const p = PortId('p');
    const g = buildGraph({
      nodes: [{ id: n, ports: [p], cells: [{ kind: 'input', key: mystery, value: { kind: 'fixed', quantity: { value: 1, unit: Unit('x') } } }] }],
      ports: [{ id: p, node: n, dir: 'out' }],
      edges: [],
    });
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(evaluate(g.value, registry).ok).toBe(false);
  });
});
