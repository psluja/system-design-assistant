import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
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
  type Transform,
} from '@sda/engine-core';
import { buildNetwork } from './build';
import { solve } from '../fixpoint';

// THE GENERATOR SOURCE TERM (doc: load-curves §3) — `generate` at an out/bi port ORIGINATES flow at its node:
// the level enters the node's served out-cell (through-flow + served level, capacity-gated by the key's own
// algebra), never the in-cell (`inflow(k)` stays pure through-flow) and never the edge seam (transformExpr is
// the identity for generate). These tests pin the three engine-level shapes:
//   (1) CONFIG-local: a bare capacity gates the offered flow — out = min(capacity, in + Σ levels);
//   (2) RELATION-local: the node's own relation OWNS the emission — out = local (content authors it as
//       min(capacity, inflow + origin), so the through-flow bound `out ≤ in` no longer silences the origin);
//   (3) NO local: out = through-flow + Σ levels (a pure origin with no declared ceiling).
// Plus the superset law: a generator-free graph is bit-for-bit today (identity property), and the migrated-
// declaration identity (min(C, L) at a source — exactly the historical withOrigin fold).

const tput = Key('throughput');
const registry = registryOf([
  { key: tput, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'min', fanIn: 'sum', onAsyncEdge: 'carry', flow: true }, kind: 'derived' },
] satisfies KeyDef[]);

const fixed = (value: number) => ({ kind: 'input', key: tput, value: { kind: 'fixed', quantity: { value, unit: Unit('req/s') } } }) as const;
const gen = (level: number): Transform => ({ kind: 'generate', level });

function evalGraph(nodes: Node[], ports: Port[], edges: Edge[]): (id: string) => number | undefined {
  const g = buildGraph({ nodes, ports, edges });
  if (!g.ok) throw new Error(JSON.stringify(g.error));
  const net = buildNetwork(g.value, registry);
  if (!net.ok) throw new Error(net.error.join('; '));
  const r = solve(net.value.system);
  expect(r.converged).toBe(true);
  return (id: string) => r.values.get(net.value.out(NodeId(id), tput));
}

describe('generate at a port — the node-level source term (doc: load-curves §3)', () => {
  it('CONFIG-local source: out = min(capacity, level) — the migrated withOrigin physics, exactly (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 1, max: 5000 }), (capacity, level) => {
        const nodes: Node[] = [{ id: NodeId('g'), ports: [PortId('g.out')], cells: [fixed(capacity)] }];
        const ports: Port[] = [{ id: PortId('g.out'), node: NodeId('g'), dir: 'out', transform: gen(level) }];
        const value = evalGraph(nodes, ports, []);
        expect(value('g')).toBe(Math.min(capacity, level));
      }),
      { numRuns: 60 },
    );
  });

  it('CONFIG-local MID-CHAIN: out = min(capacity, inflow + level) — relay + generate on one node (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2000 }), // upstream demand
        fc.integer({ min: 1, max: 4000 }), // mid capacity
        fc.integer({ min: 1, max: 2000 }), // mid generator level
        (demand, capacity, level) => {
          const nodes: Node[] = [
            { id: NodeId('src'), ports: [PortId('src.out')], cells: [fixed(demand)] },
            { id: NodeId('mid'), ports: [PortId('mid.in'), PortId('mid.out')], cells: [fixed(capacity)] },
            { id: NodeId('sink'), ports: [PortId('sink.in')], cells: [] },
          ];
          const ports: Port[] = [
            { id: PortId('src.out'), node: NodeId('src'), dir: 'out' },
            { id: PortId('mid.in'), node: NodeId('mid'), dir: 'in' },
            { id: PortId('mid.out'), node: NodeId('mid'), dir: 'out', transform: gen(level) },
            { id: PortId('sink.in'), node: NodeId('sink'), dir: 'in' },
          ];
          const edges: Edge[] = [
            { id: EdgeId('e0'), from: PortId('src.out'), to: PortId('mid.in'), semantics: 'sync' },
            { id: EdgeId('e1'), from: PortId('mid.out'), to: PortId('sink.in'), semantics: 'sync' },
          ];
          const value = evalGraph(nodes, ports, edges);
          const served = Math.min(capacity, demand + level);
          expect(value('mid')).toBe(served);
          expect(value('sink')).toBe(served); // the emission crosses the generate port untouched (identity seam)
        },
      ),
      { numRuns: 60 },
    );
  });

  it('NO-local generator: out = through-flow + level (a pure origin with no declared ceiling)', () => {
    // `g` declares no throughput of its own (no ceiling) — its emission is exactly the level; the sink gates it.
    const nodes: Node[] = [
      { id: NodeId('g'), ports: [PortId('g.out')], cells: [] },
      { id: NodeId('sink'), ports: [PortId('sink.in')], cells: [fixed(500)] },
    ];
    const ports: Port[] = [
      { id: PortId('g.out'), node: NodeId('g'), dir: 'out', transform: gen(120) },
      { id: PortId('sink.in'), node: NodeId('sink'), dir: 'in' },
    ];
    const edges: Edge[] = [{ id: EdgeId('e0'), from: PortId('g.out'), to: PortId('sink.in'), semantics: 'sync' }];
    const value = evalGraph(nodes, ports, edges);
    expect(value('g')).toBe(120);
    expect(value('sink')).toBe(120);
  });

  it('RELATION-local generator: the relation OWNS the emission (out = local, not min(local, in))', () => {
    // The content lowering's exact shape: min(capacity, inflow + origin) as the node's own relation. Without the
    // generator rule the out-cell would be min(local, in) = in — the origin silently lost down a relay.
    const nodes: Node[] = [
      { id: NodeId('src'), ports: [PortId('src.out')], cells: [fixed(100)] },
      {
        id: NodeId('mid'),
        ports: [PortId('mid.in'), PortId('mid.out')],
        cells: [{ kind: 'derived', key: tput, relation: { produces: tput, reads: [tput], expr: 'min(500, inflow(throughput) + 80)' } }],
      },
      { id: NodeId('sink'), ports: [PortId('sink.in')], cells: [] },
    ];
    const ports: Port[] = [
      { id: PortId('src.out'), node: NodeId('src'), dir: 'out' },
      { id: PortId('mid.in'), node: NodeId('mid'), dir: 'in' },
      { id: PortId('mid.out'), node: NodeId('mid'), dir: 'out', transform: gen(80) },
      { id: PortId('sink.in'), node: NodeId('sink'), dir: 'in' },
    ];
    const edges: Edge[] = [
      { id: EdgeId('e0'), from: PortId('src.out'), to: PortId('mid.in'), semantics: 'sync' },
      { id: EdgeId('e1'), from: PortId('mid.out'), to: PortId('sink.in'), semantics: 'sync' },
    ];
    const value = evalGraph(nodes, ports, edges);
    expect(value('mid')).toBe(180); // min(500, 100 + 80) — the relation's own arithmetic, emitted as-is
    expect(value('sink')).toBe(180);
  });

  it('a level-0 generator is declared-but-silent: bit-for-bit the generator-free graph (no-filler law)', () => {
    const build = (withGen: boolean): (id: string) => number | undefined => {
      const nodes: Node[] = [
        { id: NodeId('src'), ports: [PortId('src.out')], cells: [fixed(100)] },
        { id: NodeId('mid'), ports: [PortId('mid.in'), PortId('mid.out')], cells: [fixed(300)] },
        { id: NodeId('sink'), ports: [PortId('sink.in')], cells: [] },
      ];
      const ports: Port[] = [
        { id: PortId('src.out'), node: NodeId('src'), dir: 'out' },
        { id: PortId('mid.in'), node: NodeId('mid'), dir: 'in' },
        { id: PortId('mid.out'), node: NodeId('mid'), dir: 'out', ...(withGen ? { transform: gen(0) } : {}) },
        { id: PortId('sink.in'), node: NodeId('sink'), dir: 'in' },
      ];
      const edges: Edge[] = [
        { id: EdgeId('e0'), from: PortId('src.out'), to: PortId('mid.in'), semantics: 'sync' },
        { id: EdgeId('e1'), from: PortId('mid.out'), to: PortId('sink.in'), semantics: 'sync' },
      ];
      return evalGraph(nodes, ports, edges);
    };
    const without = build(false);
    const with0 = build(true);
    for (const id of ['src', 'mid', 'sink']) expect(with0(id)).toBe(without(id));
  });

  it('served flow is MONOTONE non-decreasing in the level (the native solver assumption, engine-level)', () => {
    const served = (level: number): number => {
      const nodes: Node[] = [
        { id: NodeId('g'), ports: [PortId('g.out')], cells: [fixed(1000)] },
        { id: NodeId('t'), ports: [PortId('t.in')], cells: [fixed(700)] },
      ];
      const ports: Port[] = [
        { id: PortId('g.out'), node: NodeId('g'), dir: 'out', transform: gen(level) },
        { id: PortId('t.in'), node: NodeId('t'), dir: 'in' },
      ];
      const edges: Edge[] = [{ id: EdgeId('e0'), from: PortId('g.out'), to: PortId('t.in'), semantics: 'sync' }];
      return evalGraph(nodes, ports, edges)('t') as number;
    };
    let prev = -Infinity;
    for (const level of [1, 50, 200, 650, 700, 900, 1500]) {
      const s = served(level);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
    expect(served(650)).toBe(650); // under the tier: served = level (peak scaling passes through)
    expect(served(900)).toBe(700); // over the tier: capacity-gated
  });
});
