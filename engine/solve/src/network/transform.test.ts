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

// Port TRANSFORMS act on FLOW-flagged keys at the edge-contribution seam.
// These tests pin the three properties the design promises: (1) IDENTITY — a transform-free graph computes
// exactly as before; (2) RATIO COMPOSITION — ratios multiply along a chain; (3) PER-EDGE INDEPENDENCE — a
// fan-out applies each out-edge's transform independently. `flow` marks the key transforms act on; a plain
// key with no `flow` is untouched (the compatibility invariant).

const tput = Key('throughput'); // the flow key
const cap = Key('cap'); // a plain (non-flow) capacity input

// throughput: flow, bottlenecks DOWN a path (min), offered loads SUM at a fan-in.
const registry = registryOf([
  { key: tput, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'min', fanIn: 'sum', onAsyncEdge: 'carry', flow: true }, kind: 'derived' },
  { key: cap, unit: Unit('req/s'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry' }, kind: 'input' },
] satisfies KeyDef[]);

const fixed = (key: Key, value: number) => ({ kind: 'input', key, value: { kind: 'fixed', quantity: { value, unit: Unit('req/s') } } }) as const;
/** A source node emitting `rps` on its out port `id.out` (capacity huge so it emits the full offered rate). */
const source = (id: string, rps: number): Node => ({ id: NodeId(id), ports: [PortId(`${id}.out`)], cells: [fixed(tput, rps)] });
/** A relay/sink with capacity `capValue`: throughput = min(capacity, inflow). */
const relay = (id: string, capValue: number, hasOut = false): Node => ({
  id: NodeId(id),
  ports: hasOut ? [PortId(`${id}.in`), PortId(`${id}.out`)] : [PortId(`${id}.in`)],
  cells: [fixed(cap, capValue), { kind: 'derived', key: tput, relation: { produces: tput, reads: [cap], expr: 'min(cap, inflow(throughput))' } }],
});

function evalGraph(nodes: Node[], ports: Port[], edges: Edge[]): (id: string) => number | undefined {
  const g = buildGraph({ nodes, ports, edges });
  if (!g.ok) throw new Error(JSON.stringify(g.error));
  const net = buildNetwork(g.value, registry);
  if (!net.ok) throw new Error(net.error.join('; '));
  const r = solve(net.value.system);
  expect(r.converged).toBe(true);
  return (id: string) => r.values.get(net.value.out(NodeId(id), tput));
}

describe('port transforms — identity is today, bit for bit', () => {
  // Build a random chain of relays with LARGE capacities (so throughput = the propagated rate, transforms aside)
  // and assert: a graph with NO transforms equals the same graph — the default port has no transform field.
  it('a transform-free chain evaluates identically to plain per-node relay (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 5 }), (rps, chain) => {
        const nodes: Node[] = [source('src', rps)];
        const ports: Port[] = [{ id: PortId('src.out'), node: NodeId('src'), dir: 'out' }];
        const edges: Edge[] = [];
        let prev = 'src';
        chain.forEach((_, i) => {
          const id = `r${i}`;
          const last = i === chain.length - 1;
          nodes.push(relay(id, 1e9, !last));
          ports.push({ id: PortId(`${id}.in`), node: NodeId(id), dir: 'in' });
          if (!last) ports.push({ id: PortId(`${id}.out`), node: NodeId(id), dir: 'out' });
          edges.push({ id: EdgeId(`e${i}`), from: PortId(`${prev}.out`), to: PortId(`${id}.in`), semantics: 'sync' });
          prev = id;
        });
        const value = evalGraph(nodes, ports, edges);
        // no transform anywhere ⇒ the rate propagates unchanged (capacities are huge)
        expect(value(`r${chain.length - 1}`)).toBeCloseTo(rps, 6);
      }),
      { numRuns: 40 },
    );
  });
});

describe('port transforms — ratio composition along a chain', () => {
  it('ratios on successive out ports MULTIPLY (k1·k2·k3·rps at the tail)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.array(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 4 }),
        (rps, ks) => {
          // src -[ratio k0]-> r0 -[ratio k1]-> r1 ... ; each relay has huge capacity so only the ratios shape it.
          const nodes: Node[] = [source('src', rps)];
          const ports: Port[] = [{ id: PortId('src.out'), node: NodeId('src'), dir: 'out', transform: { kind: 'ratio', value: ks[0] as number } }];
          const edges: Edge[] = [];
          let prev = 'src';
          ks.forEach((_, i) => {
            const id = `r${i}`;
            const last = i === ks.length - 1;
            nodes.push(relay(id, 1e12, !last));
            ports.push({ id: PortId(`${id}.in`), node: NodeId(id), dir: 'in' });
            // the out port of this relay carries the NEXT ratio (the last relay is a sink, no out port)
            if (!last) ports.push({ id: PortId(`${id}.out`), node: NodeId(id), dir: 'out', transform: { kind: 'ratio', value: ks[i + 1] as number } });
            edges.push({ id: EdgeId(`e${i}`), from: PortId(`${prev}.out`), to: PortId(`${id}.in`), semantics: 'sync' });
            prev = id;
          });
          const value = evalGraph(nodes, ports, edges);
          const product = ks.reduce((a, b) => a * b, 1);
          expect(value(`r${ks.length - 1}`)).toBeCloseTo(rps * product, 3);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('port transforms — per-edge independence on a fan-out', () => {
  it('each out-edge of a fan-out applies its OWN transform (events 1×, logs 100×)', () => {
    // The design-doc example, in engine terms: gen fans out to `events` (ratio 1) and `logs` (ratio 100).
    const gen = 'gen';
    const nodes: Node[] = [
      { id: NodeId(gen), ports: [PortId('gen.in'), PortId('gen.events'), PortId('gen.logs')], cells: [fixed(cap, 1e9), { kind: 'derived', key: tput, relation: { produces: tput, reads: [cap], expr: 'min(cap, inflow(throughput))' } }] },
      source('client', 1000),
      relay('events', 1e9),
      relay('logs', 1e9),
    ];
    const ports: Port[] = [
      { id: PortId('client.out'), node: NodeId('client'), dir: 'out' },
      { id: PortId('gen.in'), node: NodeId(gen), dir: 'in' },
      { id: PortId('gen.events'), node: NodeId(gen), dir: 'out', transform: { kind: 'ratio', value: 1 } },
      { id: PortId('gen.logs'), node: NodeId(gen), dir: 'out', transform: { kind: 'ratio', value: 100 } },
      { id: PortId('events.in'), node: NodeId('events'), dir: 'in' },
      { id: PortId('logs.in'), node: NodeId('logs'), dir: 'in' },
    ];
    const edges: Edge[] = [
      { id: EdgeId('e0'), from: PortId('client.out'), to: PortId('gen.in'), semantics: 'sync' },
      { id: EdgeId('e1'), from: PortId('gen.events'), to: PortId('events.in'), semantics: 'sync' },
      { id: EdgeId('e2'), from: PortId('gen.logs'), to: PortId('logs.in'), semantics: 'sync' },
    ];
    const value = evalGraph(nodes, ports, edges);
    expect(value('events')).toBeCloseTo(1000, 6); // ratio 1 — the events tier sees 1×
    expect(value('logs')).toBeCloseTo(100_000, 6); // ratio 100 — the log tier's TRUE load, formerly invisible
  });

  it('IN-port batch(n) thins the whole arriving stream 1/n (aggregator)', () => {
    // src -> agg with an IN-port batch(100): 1000 in ⇒ 10 intake.
    const nodes: Node[] = [source('src', 1000), relay('agg', 1e9)];
    const ports: Port[] = [
      { id: PortId('src.out'), node: NodeId('src'), dir: 'out' },
      { id: PortId('agg.in'), node: NodeId('agg'), dir: 'in', transform: { kind: 'batch', value: 100 } },
    ];
    const edges: Edge[] = [{ id: EdgeId('e0'), from: PortId('src.out'), to: PortId('agg.in'), semantics: 'sync' }];
    const value = evalGraph(nodes, ports, edges);
    expect(value('agg')).toBeCloseTo(10, 6);
  });

  it('cap(r) is a steady-state throttle: min(inflow, r)', () => {
    const nodes: Node[] = [source('src', 1000), relay('gate', 1e9)];
    const ports: Port[] = [
      { id: PortId('src.out'), node: NodeId('src'), dir: 'out' },
      { id: PortId('gate.in'), node: NodeId('gate'), dir: 'in', transform: { kind: 'cap', value: 250 } },
    ];
    const edges: Edge[] = [{ id: EdgeId('e0'), from: PortId('src.out'), to: PortId('gate.in'), semantics: 'sync' }];
    const value = evalGraph(nodes, ports, edges);
    expect(value('gate')).toBeCloseTo(250, 6); // min(1000, 250)
  });
});

describe('per-WIRE transform override — the wire wins over the source port', () => {
  // The whole point of a wire override: ONE out port can feed several edges with DIFFERENT shares — a routing split
  // a per-PORT transform cannot express. We fan `src.out` (a port-level ratio) to two sinks, each edge carrying its
  // OWN wire ratio, and assert each sink sees its wire's share (the wire beats the port), summing to the whole.
  it('a fan-out with per-wire ratios routes each share independently (70/30), not the port broadcast', () => {
    const nodes: Node[] = [source('src', 2000), relay('a', 1e12), relay('b', 1e12)];
    const ports: Port[] = [
      // a PORT-level transform on the out port (ratio 9) that BOTH wires would broadcast — the wire override must beat it.
      { id: PortId('src.out'), node: NodeId('src'), dir: 'out', transform: { kind: 'ratio', value: 9 } },
      { id: PortId('a.in'), node: NodeId('a'), dir: 'in' },
      { id: PortId('b.in'), node: NodeId('b'), dir: 'in' },
    ];
    const edges: Edge[] = [
      { id: EdgeId('e0'), from: PortId('src.out'), to: PortId('a.in'), semantics: 'sync', transform: { kind: 'ratio', value: 0.7 } },
      { id: EdgeId('e1'), from: PortId('src.out'), to: PortId('b.in'), semantics: 'sync', transform: { kind: 'ratio', value: 0.3 } },
    ];
    const value = evalGraph(nodes, ports, edges);
    expect(value('a')).toBeCloseTo(1400, 6); // 2000 × 0.7 — the WIRE ratio, not the port's ×9 broadcast
    expect(value('b')).toBeCloseTo(600, 6); //  2000 × 0.3
    expect((value('a') as number) + (value('b') as number)).toBeCloseTo(2000, 6); // the split preserves the whole
  });

  it('property: with both a port ratio and a wire ratio set, the WIRE ratio decides the sink rate', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 20 }), // port ratio (should be IGNORED on this edge)
        fc.integer({ min: 1, max: 20 }), // wire ratio (should WIN)
        (rps, portK, wireK) => {
          const nodes: Node[] = [source('src', rps), relay('sink', 1e12)];
          const ports: Port[] = [
            { id: PortId('src.out'), node: NodeId('src'), dir: 'out', transform: { kind: 'ratio', value: portK } },
            { id: PortId('sink.in'), node: NodeId('sink'), dir: 'in' },
          ];
          const edges: Edge[] = [
            { id: EdgeId('e0'), from: PortId('src.out'), to: PortId('sink.in'), semantics: 'sync', transform: { kind: 'ratio', value: wireK } },
          ];
          const value = evalGraph(nodes, ports, edges);
          expect(value('sink')).toBeCloseTo(rps * wireK, 3); // the wire ratio decides — the port ratio is overridden
        },
      ),
      { numRuns: 60 },
    );
  });

  it('a wire with NO transform falls back to the source port transform (broadcast, bit for bit)', () => {
    // Two wires, only ONE overridden: the un-overridden wire keeps the port's ×5 broadcast; the overridden one uses its own.
    const nodes: Node[] = [source('src', 100), relay('kept', 1e12), relay('split', 1e12)];
    const ports: Port[] = [
      { id: PortId('src.out'), node: NodeId('src'), dir: 'out', transform: { kind: 'ratio', value: 5 } },
      { id: PortId('kept.in'), node: NodeId('kept'), dir: 'in' },
      { id: PortId('split.in'), node: NodeId('split'), dir: 'in' },
    ];
    const edges: Edge[] = [
      { id: EdgeId('e0'), from: PortId('src.out'), to: PortId('kept.in'), semantics: 'sync' }, // no wire transform ⇒ port ×5
      { id: EdgeId('e1'), from: PortId('src.out'), to: PortId('split.in'), semantics: 'sync', transform: { kind: 'ratio', value: 2 } }, // wire ×2 wins
    ];
    const value = evalGraph(nodes, ports, edges);
    expect(value('kept')).toBeCloseTo(500, 6); // 100 × 5 (port default preserved)
    expect(value('split')).toBeCloseTo(200, 6); // 100 × 2 (wire override)
  });
});

// A shared list of the closed function set with a small chain, reused by the differential test too.
export const TRANSFORM_CASES: ReadonlyArray<{ name: string; transform: Transform; in: number; out: number }> = [
  { name: 'ratio(3)', transform: { kind: 'ratio', value: 3 }, in: 200, out: 600 },
  { name: 'batch(100)', transform: { kind: 'batch', value: 100 }, in: 1000, out: 10 },
  { name: 'cap(250)', transform: { kind: 'cap', value: 250 }, in: 1000, out: 250 },
  { name: 'window(10)', transform: { kind: 'window', value: 10 }, in: 1000, out: 100 }, // 1000/10 = 100 msg/s
  { name: 'prob(0.1)', transform: { kind: 'prob', value: 0.1 }, in: 1000, out: 100 },
];

describe('port transforms — the closed function set (scalar semantics)', () => {
  for (const c of TRANSFORM_CASES) {
    it(`${c.name}: ${c.in} → ${c.out}`, () => {
      const nodes: Node[] = [source('src', c.in), relay('sink', 1e12)];
      const ports: Port[] = [
        { id: PortId('src.out'), node: NodeId('src'), dir: 'out', transform: c.transform },
        { id: PortId('sink.in'), node: NodeId('sink'), dir: 'in' },
      ];
      const edges: Edge[] = [{ id: EdgeId('e0'), from: PortId('src.out'), to: PortId('sink.in'), semantics: 'sync' }];
      const value = evalGraph(nodes, ports, edges);
      expect(value('sink')).toBeCloseTo(c.out, 6);
    });
  }
});
