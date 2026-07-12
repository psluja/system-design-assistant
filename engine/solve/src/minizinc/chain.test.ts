import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGraph, registryOf, EdgeId, Key, NodeId, PortId, Unit, type Edge, type KeyDef, type Node, type Port } from '@sda/engine-core';
import { solve, type Cell, type CellId } from '../fixpoint';
import type { Expr } from '../relation';
import { chainModel } from './chain';
import { buildNetwork } from '../network';

// Cyclic cell systems are where the two engines must agree on the LEAST fixpoint: the JS solver by
// Kleene iteration from ⊥, MiniZinc by `expr <= cell` + `minimize`. A spurious-fixpoint or off-by-one
// here would silently mis-simulate every feedback/backpressure design — a P0.
const MZN = process.env.MINIZINC ?? 'minizinc';

const ref = (id: string): Expr => ({ kind: 'ref', key: id as unknown as Key });
const num = (value: number): Expr => ({ kind: 'num', value });
const min = (...args: Expr[]): Expr => ({ kind: 'call', fn: 'min', args });
const max = (...args: Expr[]): Expr => ({ kind: 'call', fn: 'max', args });
const add = (left: Expr, right: Expr): Expr => ({ kind: 'binary', op: '+', left, right });

function runChain(system: ReadonlyMap<CellId, Cell>): Map<CellId, number> {
  const model = chainModel(system);
  const out = new Map<CellId, number>(model.constants);
  if (model.source === null) return out;
  const dir = mkdtempSync(join(tmpdir(), 'sda-chain-'));
  try {
    const file = join(dir, 'm.mzn');
    writeFileSync(file, model.source);
    const stdout = execFileSync(MZN, ['--solver', 'gecode', '--output-mode', 'json', file], { encoding: 'utf8' });
    const json = JSON.parse((stdout.split('----------')[0] ?? '').trim()) as Record<string, number>;
    const idOf = new Map([...model.varOf].map(([id, n]) => [n, id]));
    for (const [n, v] of Object.entries(json)) {
      const id = idOf.get(n);
      if (id !== undefined) out.set(id, v);
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cases: ReadonlyArray<{ name: string; system: Map<CellId, Cell>; check: readonly CellId[] }> = [
  {
    name: 'self-referential bottleneck min(C, max(R, t)): C=7,R=3 ⇒ 3',
    system: new Map<CellId, Cell>([
      ['C', { kind: 'input', value: 7 }],
      ['R', { kind: 'input', value: 3 }],
      ['t', { kind: 'derived', expr: min(ref('C'), max(ref('R'), ref('t'))) }],
    ]),
    check: ['t'],
  },
  {
    name: 'self-referential bottleneck min(C, max(R, t)): C=7,R=5 ⇒ 5',
    system: new Map<CellId, Cell>([
      ['C', { kind: 'input', value: 7 }],
      ['R', { kind: 'input', value: 5 }],
      ['t', { kind: 'derived', expr: min(ref('C'), max(ref('R'), ref('t'))) }],
    ]),
    check: ['t'],
  },
  {
    name: 'mutual 2-cycle a=min(8,b), b=min(a+2,9) ⇒ a=8,b=9',
    system: new Map<CellId, Cell>([
      ['a', { kind: 'derived', expr: min(num(8), ref('b')) }],
      ['b', { kind: 'derived', expr: min(add(ref('a'), num(2)), num(9)) }],
    ]),
    check: ['a', 'b'],
  },
];

describe('JS fixpoint <-> MiniZinc chain differential (least fixpoint of cyclic systems)', () => {
  for (const c of cases) {
    it(c.name, () => {
      const js = solve(c.system);
      expect(js.converged).toBe(true);
      const mzn = runChain(c.system);
      for (const id of c.check) {
        expect(mzn.get(id)).toBeCloseTo(js.values.get(id) as number, 6);
      }
    });
  }
});

// A WIRE-LEVEL ratio is baked into the cell-network's inflow expression like any other transform, so the JS hot
// path and MiniZinc must agree on it too. We build a real fan-out graph with a
// per-wire ratio through `buildNetwork`, then differential the JS `solve` against the MiniZinc `chainModel` on the
// SAME system — a disagreement would mean the wire split lies in one engine but not the other (a P0).
describe('JS fixpoint <-> MiniZinc — a per-WIRE ratio agrees end-to-end', () => {
  const tput = Key('throughput');
  const cap = Key('cap');
  const reg = registryOf([
    { key: tput, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'min', fanIn: 'sum', onAsyncEdge: 'carry', flow: true }, kind: 'derived' },
    { key: cap, unit: Unit('req/s'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry' }, kind: 'input' },
  ] satisfies KeyDef[]);
  const fixed = (key: Key, value: number) => ({ kind: 'input', key, value: { kind: 'fixed', quantity: { value, unit: Unit('req/s') } } }) as const;

  it('src ×[wire 0.7 / wire 0.3] → a/b agrees between JS and MiniZinc', () => {
    const nodes: Node[] = [
      { id: NodeId('src'), ports: [PortId('src.out')], cells: [fixed(tput, 2000)] },
      { id: NodeId('a'), ports: [PortId('a.in')], cells: [fixed(cap, 1e9), { kind: 'derived', key: tput, relation: { produces: tput, reads: [cap], expr: 'min(cap, inflow(throughput))' } }] },
      { id: NodeId('b'), ports: [PortId('b.in')], cells: [fixed(cap, 1e9), { kind: 'derived', key: tput, relation: { produces: tput, reads: [cap], expr: 'min(cap, inflow(throughput))' } }] },
    ];
    const ports: Port[] = [
      { id: PortId('src.out'), node: NodeId('src'), dir: 'out' },
      { id: PortId('a.in'), node: NodeId('a'), dir: 'in' },
      { id: PortId('b.in'), node: NodeId('b'), dir: 'in' },
    ];
    const edges: Edge[] = [
      { id: EdgeId('e0'), from: PortId('src.out'), to: PortId('a.in'), semantics: 'sync', transform: { kind: 'ratio', value: 0.7 } },
      { id: EdgeId('e1'), from: PortId('src.out'), to: PortId('b.in'), semantics: 'sync', transform: { kind: 'ratio', value: 0.3 } },
    ];
    const g = buildGraph({ nodes, ports, edges });
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const net = buildNetwork(g.value, reg);
    if (!net.ok) throw new Error(net.error.join('; '));

    const js = solve(net.value.system);
    expect(js.converged).toBe(true);
    const mzn = runChain(net.value.system);
    for (const id of [net.value.out(NodeId('a'), tput), net.value.out(NodeId('b'), tput)]) {
      expect(mzn.get(id)).toBeCloseTo(js.values.get(id) as number, 6);
    }
    // and the JS numbers ARE the split (sanity: a differential can pass on two agreeing wrong answers)
    expect(js.values.get(net.value.out(NodeId('a'), tput))).toBeCloseTo(1400, 6);
    expect(js.values.get(net.value.out(NodeId('b'), tput))).toBeCloseTo(600, 6);
  });
});
