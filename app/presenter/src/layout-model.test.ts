import { describe, it, expect } from 'vitest';
import type { LayoutDesign } from './layout-model';
import { designHash, designPorts, dominantAnchors, nodeGeoms, portAnchorOffset, portFraction, portOffsetKey, portsFromWires, wireAnchorOffsets } from './layout-model';
import { routeDesignEdges } from './edge-routing';

// THE SHARED PORT-ANCHOR GEOMETRY (R5, port-centric alignment) — layout-model's `portFraction` /
// `wireAnchorOffsets` / `dominantAnchors` are the ONE form of "where does a wire touch a node" that the router,
// the row-placement passes and the objective's alignment term all read. These units pin the formula itself, the
// deterministic dominant-port choice (heaviest wire, first port on ties), and — the differential that matters —
// that the offsets equal the ROUTER's real anchor endpoints, so "aligned" can never drift from "routes straight".

const port = (name: string, dir: 'in' | 'out' | 'bi') => ({ name, dir });

describe('portFraction — the (i+1)/(n+1) handle formula, one form', () => {
  it('a single same-side port anchors at the middle (0.5)', () => {
    expect(portFraction([port('in', 'in'), port('out', 'out')], 'in', 'in')).toBe(0.5);
    expect(portFraction([port('in', 'in'), port('out', 'out')], 'out', 'out')).toBe(0.5);
  });
  it('two same-side ports anchor at 1/3 and 2/3, in port order', () => {
    const ports = [port('p', 'out'), port('q', 'out'), port('in', 'in')];
    expect(portFraction(ports, 'out', 'p')).toBeCloseTo(1 / 3, 12);
    expect(portFraction(ports, 'out', 'q')).toBeCloseTo(2 / 3, 12);
  });
  it('a bi port counts on BOTH sides', () => {
    const ports = [port('a', 'in'), port('b', 'bi')];
    expect(portFraction(ports, 'in', 'a')).toBeCloseTo(1 / 3, 12); // in side = [a, b]
    expect(portFraction(ports, 'in', 'b')).toBeCloseTo(2 / 3, 12);
    expect(portFraction(ports, 'out', 'b')).toBe(0.5); // out side = [b] alone
  });
  it('an unknown port name reads the neutral 0.5 (never NaN, never a throw)', () => {
    expect(portFraction([port('in', 'in')], 'in', 'nope')).toBe(0.5);
    expect(portFraction([], 'out', 'x')).toBe(0.5);
  });
});

describe('wireAnchorOffsets — the differential: offsets == the router’s real anchor endpoints', () => {
  it('every routed wire starts at sourceTop + source offset and ends at targetTop + target offset', () => {
    // A multi-port, unequal-height design: b fans out on two ports (1/3, 2/3 of h=140) into c and c2. Every pair
    // of anchors is placed > 4px apart on purpose: within 4px the router's fast path deliberately SNAPS the two
    // ends onto ONE row (the very snap port-centric alignment exists to trigger), so the exact-endpoint identity
    // is asserted on the un-snapped routes.
    const d: LayoutDesign = {
      nodes: [
        { id: 'a', size: { w: 160, h: 80 } },
        { id: 'b', size: { w: 160, h: 140 } },
        { id: 'c', size: { w: 160, h: 100 } },
        { id: 'c2', size: { w: 160, h: 100 } },
      ],
      wires: [
        { from: ['a', 'out'], to: ['b', 'in'] },
        { from: ['b', 'p'], to: ['c', 'in'] },
        { from: ['b', 'q'], to: ['c2', 'in'] },
      ],
      groups: [],
    };
    const placement = { a: { x: 0, y: 40 }, b: { x: 400, y: 0 }, c: { x: 800, y: 120 }, c2: { x: 800, y: 340 } };
    const offs = wireAnchorOffsets(d);
    const routed = routeDesignEdges({ nodes: nodeGeoms(d, placement), wires: d.wires.map((w) => ({ from: w.from, to: w.to })) });
    d.wires.forEach((w, i) => {
      const pts = routed.get(i)!.points;
      expect(pts[0]!.y, `${w.from.join('.')} source anchor`).toBeCloseTo(placement[w.from[0] as keyof typeof placement].y + offs[i]!.source, 9);
      expect(pts[pts.length - 1]!.y, `${w.to.join('.')} target anchor`).toBeCloseTo(placement[w.to[0] as keyof typeof placement].y + offs[i]!.target, 9);
    });
    // And the multi-port fractions are the real (i+1)/(n+1) values, not centres:
    expect(offs[1]!.source).toBeCloseTo(140 / 3, 9); // b.p at 1/3 of 140
    expect(offs[2]!.source).toBeCloseTo((2 * 140) / 3, 9); // b.q at 2/3 of 140
    expect(offs[1]!.target).toBe(50); // c single in port at h/2
  });
});

describe('dominantAnchors — heaviest wire, first port on ties, deterministic', () => {
  const d: LayoutDesign = {
    nodes: [
      { id: 'hub', size: { w: 160, h: 120 } },
      { id: 'x', size: { w: 160, h: 120 } },
      { id: 'y', size: { w: 160, h: 120 } },
      { id: 'z', size: { w: 160, h: 120 } },
      { id: 'lone', size: { w: 160, h: 90 } },
    ],
    wires: [
      { from: ['x', 'out'], to: ['hub', 'a'] }, // hub in-port a: first touch…
      { from: ['hub', 'o'], to: ['z', 'in'] }, // hub out-port o: 1 wire · z in-port in: FIRST touch on z
      { from: ['y', 'out'], to: ['hub', 'a'] }, // …and a second wire on a ⇒ a is the HEAVIEST (2 > 1)
      { from: ['z', 'snd'], to: ['y', 'rcv'] }, // z out-port snd: 1 wire ⇒ a 1–1 TIE on z, in:'in' touched first
    ],
    groups: [],
  };
  it('the port with the most wires wins; its offset is height × its fraction', () => {
    const anchors = dominantAnchors(d);
    const hub = anchors.get('hub')!;
    expect(hub.port).toEqual({ side: 'in', name: 'a' });
    // hub's in side = [a] alone ⇒ 0.5 × 120.
    expect(hub.offset).toBe(60);
  });
  it('a count tie is broken by FIRST touch in wire order (z: in:in at wire 1 beats out:snd at wire 3)', () => {
    const anchors = dominantAnchors(d);
    expect(anchors.get('z')!.port).toEqual({ side: 'in', name: 'in' });
  });
  it('an unwired node anchors at its centre with no port', () => {
    const anchors = dominantAnchors(d);
    expect(anchors.get('lone')).toEqual({ offset: 45 });
  });
  it('is deterministic — two derivations are deep-equal', () => {
    const a = dominantAnchors(d, undefined, portsFromWires(d));
    const b = dominantAnchors(d, undefined, portsFromWires(d));
    expect(JSON.stringify([...a])).toEqual(JSON.stringify([...b]));
  });
});

// THE MODEL THREADING (R5) — the old bug class, pinned at the derivation itself: the canvas renders one handle per
// MANIFEST port, so when a design carries the catalog ports, EVERY consumer must read those — a node with a
// partially-wired multi-port side otherwise anchors where no handle exists (the multi-out jog).
describe('designPorts — manifest ports when declared, wire-derived otherwise (the multi-out jog class pinned)', () => {
  const d: LayoutDesign = {
    nodes: [
      // api declares the FULL manifest out side [db,out,cache]; only db is wired.
      { id: 'api', size: { w: 160, h: 120 }, ports: [{ name: 'in', dir: 'in' }, { name: 'db', dir: 'out' }, { name: 'out', dir: 'out' }, { name: 'cache', dir: 'out' }] },
      { id: 'pg', size: { w: 160, h: 120 } }, // declares nothing — wire-derived fallback
    ],
    wires: [{ from: ['api', 'db'], to: ['pg', 'in'] }],
    groups: [],
  };
  it('a declared node reads its manifest list (order kept); an undeclared node keeps the wire derivation', () => {
    const p = designPorts(d);
    expect(p.get('api')!.map((x) => x.name)).toEqual(['in', 'db', 'out', 'cache']);
    expect(p.get('pg')).toEqual(portsFromWires(d).get('pg'));
  });
  it('the anchor moves with the threading: api.db at 1/4 of the manifest out side, not the wire-derived 1/2', () => {
    expect(portFraction(designPorts(d).get('api')!, 'out', 'db')).toBeCloseTo(1 / 4, 12);
    expect(portFraction(portsFromWires(d).get('api')!, 'out', 'db')).toBe(0.5);
  });
  it('declared ports enter the design hash (they move every anchor); an undeclared design hashes as before', () => {
    const bare: LayoutDesign = { nodes: [{ id: 'api' }, { id: 'pg' }], wires: d.wires, groups: [] };
    const bareAgain: LayoutDesign = { nodes: [{ id: 'api' }, { id: 'pg' }], wires: d.wires, groups: [] };
    expect(designHash(bare)).toBe(designHash(bareAgain));
    expect(designHash(d)).not.toBe(designHash({ ...d, nodes: d.nodes.map((n) => ({ id: n.id, ...(n.size !== undefined ? { size: n.size } : {}) })) }));
  });
});

describe('portAnchorOffset — THE one port-y resolution: assigned offset ?? height × fraction', () => {
  const ports = [{ name: 'in', dir: 'in' as const }, { name: 'db', dir: 'out' as const }, { name: 'out', dir: 'out' as const }];
  it('falls back to the fraction geometry without offsets', () => {
    expect(portAnchorOffset(ports, 'out', 'db', 120)).toBeCloseTo(40, 9); // 1/3 of 120
    expect(portAnchorOffset(ports, 'in', 'in', 120)).toBe(60);
  });
  it('an assigned offset wins, keyed per side (a bi port may differ per side)', () => {
    const offsets = { [portOffsetKey('out', 'db')]: 22.5 };
    expect(portAnchorOffset(ports, 'out', 'db', 120, offsets)).toBe(22.5);
    expect(portAnchorOffset(ports, 'out', 'out', 120, offsets)).toBeCloseTo(80, 9); // unassigned key: fraction
  });
  it('the router anchors a wire at the ASSIGNED offset when the NodeGeom carries one', () => {
    const nodes = [
      { id: 's', box: { x: 0, y: 0, w: 160, h: 120 }, ports: [{ name: 'out', dir: 'out' as const }], portOffsets: { [portOffsetKey('out', 'out')]: 37 } },
      { id: 't', box: { x: 400, y: 0, w: 160, h: 120 }, ports: [{ name: 'in', dir: 'in' as const }], portOffsets: { [portOffsetKey('in', 'in')]: 37 } },
    ];
    const routed = routeDesignEdges({ nodes, wires: [{ from: ['s', 'out'], to: ['t', 'in'] }] });
    const pts = routed.get(0)!.points;
    expect(pts.length).toBe(2); // both anchors on one assigned row ⇒ ONE straight segment
    expect(pts[0]!.y).toBe(37);
    expect(pts[1]!.y).toBe(37);
  });
});
