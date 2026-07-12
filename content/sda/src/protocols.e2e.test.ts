import { describe, expect, it } from 'vitest';
import { buildGraph, EdgeId, NodeId, PortId, ProtocolId, type Edge, type Node, type Port } from '@sda/engine-core';
import { illegalEdges } from '@sda/engine-solve';
import { allCatalogs, protocolCompat, protocolIds, unknownProtocols } from './index';

describe('protocol catalog', () => {
  it('every shipped manifest references only known protocols', () => {
    expect(unknownProtocols(allCatalogs)).toEqual([]);
  });

  it('declares only catalogued protocols itself', () => {
    for (const c of protocolCompat) {
      expect(protocolIds.has(c.out)).toBe(true);
      expect(protocolIds.has(c.in)).toBe(true);
    }
  });

  it('cross-protocol compatibility turns an otherwise-illegal edge legal (https → http)', () => {
    const n = NodeId('n');
    const ports: Port[] = [
      { id: PortId('edge'), node: n, dir: 'out', speaks: [ProtocolId('https')] },
      { id: PortId('app'), node: n, dir: 'in', accepts: [ProtocolId('http')] },
    ];
    const edges: Edge[] = [{ id: EdgeId('e'), from: PortId('edge'), to: PortId('app'), semantics: 'sync' }];
    const nodes: Node[] = [{ id: n, ports: ports.map((p) => p.id), cells: [] }];
    const g = buildGraph({ nodes, ports, edges });
    if (!g.ok) throw new Error('invalid graph');

    expect(illegalEdges(g.value, []).map((x) => x.edge)).toEqual([EdgeId('e')]); // https ≠ http
    expect(illegalEdges(g.value, protocolCompat)).toEqual([]); // protocolCompat allows it
  });
});
