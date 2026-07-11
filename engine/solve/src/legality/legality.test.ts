import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  buildGraph,
  EdgeId,
  NodeId,
  PortId,
  ProtocolId,
  type Direction,
  type Edge,
  type Graph,
  type Port,
} from '@sda/engine-core';
import { illegalEdges, whatFits, type Candidate, type Compat } from './legality';

const n = NodeId('n');
// A single-protocol port in the flat-list model: consumers accept it, producers speak it.
const port = (id: string, dir: Direction, proto: string): Port => ({
  id: PortId(id),
  node: n,
  dir,
  ...(dir === 'in' || dir === 'bi' ? { accepts: [ProtocolId(proto)] } : {}),
  ...(dir === 'out' || dir === 'bi' ? { speaks: [ProtocolId(proto)] } : {}),
});

function graphOf(ports: Port[], edges: Edge[]): Graph {
  const g = buildGraph({ nodes: [{ id: n, ports: ports.map((p) => p.id), cells: [] }], ports, edges });
  if (!g.ok) throw new Error('invalid graph');
  return g.value;
}

describe('relational legality (DataScript)', () => {
  it('flags only the protocol-incompatible edges', () => {
    const ports = [port('out1', 'out', 'http'), port('in1', 'in', 'http'), port('in2', 'in', 'grpc')];
    const edges: Edge[] = [
      { id: EdgeId('e1'), from: PortId('out1'), to: PortId('in1'), semantics: 'sync' }, // http→http: ok
      { id: EdgeId('e2'), from: PortId('out1'), to: PortId('in2'), semantics: 'sync' }, // http→grpc: illegal
    ];
    const illegal = illegalEdges(graphOf(ports, edges), []);
    expect(illegal.map((x) => x.edge)).toEqual([EdgeId('e2')]);
    expect(illegal[0]?.fromProtocol).toBe(ProtocolId('http'));
    expect(illegal[0]?.toProtocol).toBe(ProtocolId('grpc'));
  });

  it('honors a declared cross-protocol compatibility', () => {
    const ports = [port('out1', 'out', 'http'), port('in2', 'in', 'grpc')];
    const edges: Edge[] = [{ id: EdgeId('e2'), from: PortId('out1'), to: PortId('in2'), semantics: 'sync' }];
    const compat: Compat[] = [{ out: ProtocolId('http'), in: ProtocolId('grpc') }];
    expect(illegalEdges(graphOf(ports, edges), compat)).toEqual([]);
  });

  it('whatFits suggests producer candidates an open consumer port accepts', () => {
    const ports = [port('in1', 'in', 'http')];
    const g = graphOf(ports, []);
    const catalog: Candidate[] = [
      { component: 'A', dir: 'out', speaks: [ProtocolId('http')] },
      { component: 'B', dir: 'out', speaks: [ProtocolId('grpc')] },
      { component: 'C', dir: 'in', accepts: [ProtocolId('http')] }, // wrong direction
    ];
    expect(whatFits(g, PortId('in1'), catalog, []).map((c) => c.component)).toEqual(['A']);
    // a cross-protocol compat opens up B too
    expect(
      whatFits(g, PortId('in1'), catalog, [{ out: ProtocolId('grpc'), in: ProtocolId('http') }]).map((c) => c.component),
    ).toEqual(['A', 'B']);
  });
});

// Differential: the Datalog query must agree with a straightforward reference predicate on random
// graphs — that is how we trust the relational engine (doc-4 §5).
const PROTOS = ['A', 'B', 'C'] as const;

function refIllegal(graph: Graph, compat: readonly Compat[]): Set<string> {
  const ok = new Set(compat.map((c) => `${c.out}${c.in}`));
  const compatible = (o: string, i: string): boolean => o === i || ok.has(`${o}${i}`);
  const s = new Set<string>();
  for (const e of graph.edges.values()) {
    const f = graph.ports.get(e.from)?.speaks?.[0];
    const t = graph.ports.get(e.to)?.accepts?.[0];
    if (f !== undefined && t !== undefined && !compatible(f, t)) s.add(e.id);
  }
  return s;
}

describe('legality differential (DataScript vs reference predicate)', () => {
  it('agrees on random graphs', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ dir: fc.constantFrom('in', 'out') as fc.Arbitrary<Direction>, proto: fc.constantFrom(...PROTOS) }), {
          minLength: 2,
          maxLength: 6,
        }),
        fc.array(fc.tuple(fc.constantFrom(...PROTOS), fc.constantFrom(...PROTOS)), { maxLength: 4 }),
        fc.array(fc.tuple(fc.nat(5), fc.nat(5)), { maxLength: 6 }),
        (specs, compatPairs, edgePairs) => {
          const ports: Port[] = specs.map((s, i) => port(`p${i}`, s.dir, s.proto));
          const outs = ports.filter((p) => p.dir === 'out');
          const ins = ports.filter((p) => p.dir === 'in');
          const edges: Edge[] = [];
          edgePairs.forEach(([a, b], k) => {
            if (outs.length === 0 || ins.length === 0) return;
            edges.push({ id: EdgeId(`e${k}`), from: (outs[a % outs.length] as Port).id, to: (ins[b % ins.length] as Port).id, semantics: 'sync' });
          });
          const compat: Compat[] = compatPairs.map(([o, i]) => ({ out: ProtocolId(o), in: ProtocolId(i) }));
          const g = buildGraph({ nodes: [{ id: n, ports: ports.map((p) => p.id), cells: [] }], ports, edges });
          if (!g.ok) return true;
          const got = new Set(illegalEdges(g.value, compat).map((x) => x.edge as string));
          const want = refIllegal(g.value, compat);
          return got.size === want.size && [...got].every((x) => want.has(x));
        },
      ),
      { numRuns: 300 },
    );
  });
});
