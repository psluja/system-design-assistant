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
  type Graph,
  type KeyDef,
  type Node,
  type Port,
  type Registry,
} from '@sda/engine-core';
import { evaluate } from './engine';

const tput = Key('throughput');
const lat = Key('latency');

const registry: Registry = registryOf([
  { key: tput, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'min', onAsyncEdge: 'cut' }, kind: 'derived' },
  { key: lat, unit: Unit('ms'), band: 'minTargetMax', aggregate: { series: 'sum', onAsyncEdge: 'cut' }, kind: 'derived' },
] satisfies KeyDef[]);

/** A linear chain of `n` nodes — the worst case for fixpoint propagation (longest path). */
function chain(n: number): Graph {
  const nodes: Node[] = [];
  const ports: Port[] = [];
  const edges: Edge[] = [];
  for (let i = 0; i < n; i++) {
    const id = NodeId(`n${i}`);
    const inP = PortId(`n${i}.in`);
    const outP = PortId(`n${i}.out`);
    nodes.push({
      id,
      ports: [inP, outP],
      cells: [
        { kind: 'input', key: tput, value: { kind: 'fixed', quantity: { value: 1000 - i, unit: Unit('req/s') } } },
        { kind: 'input', key: lat, value: { kind: 'fixed', quantity: { value: 1, unit: Unit('ms') } } },
      ],
    });
    ports.push({ id: inP, node: id, dir: 'in' }, { id: outP, node: id, dir: 'out' });
    if (i > 0) edges.push({ id: EdgeId(`e${i}`), from: PortId(`n${i - 1}.out`), to: inP, semantics: 'sync' });
  }
  const g = buildGraph({ nodes, ports, edges });
  if (!g.ok) throw new Error('invalid chain graph');
  return g.value;
}

describe('hot-path performance', () => {
  it('re-evaluates a 200-node graph well under the 16 ms interactive budget', () => {
    const g = chain(200);

    // warm up (JIT) then take the best of many runs — the floor of what an edit costs
    for (let i = 0; i < 20; i++) evaluate(g, registry);
    let best = Infinity;
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      const r = evaluate(g, registry);
      const dt = performance.now() - t0;
      if (!r.ok) throw new Error('evaluate failed');
      if (dt < best) best = dt;
    }
    // eslint-disable-next-line no-console
    console.info(`hot-path 200-node evaluate: ${best.toFixed(3)} ms`);
    expect(best).toBeLessThan(16);
  });

  it('is deterministic: two evaluations give byte-identical values', () => {
    const g = chain(120);
    const a = evaluate(g, registry);
    const b = evaluate(g, registry);
    if (!a.ok || !b.ok) throw new Error('evaluate failed');
    for (let i = 0; i < 120; i++) {
      const node = NodeId(`n${i}`);
      expect(b.value.value(node, tput)).toBe(a.value.value(node, tput));
      expect(b.value.value(node, lat)).toBe(a.value.value(node, lat));
    }
  });
});
