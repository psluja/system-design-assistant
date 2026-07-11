import { describe, expect, it } from 'vitest';
import type { LayoutDesign, Placement } from './layout-model';
import { designPorts, nodeGeoms, portAnchorOffset, portFraction, portOffsetKey } from './layout-model';
import { MIN_PORT_GAP, PORT_EDGE_PAD, assignPortOffsets, minAssignedPortGap, slidePositions } from './layout-ports';
import { semanticLayout } from './layout-semantic';
import { routeDesignEdges, type PortLike } from './edge-routing';

// THE PORT SLIDE (R5, port-position assignment). Three layers of proof, innermost out:
//   1. the ISOTONIC unit (slidePositions): order preserved, min gap enforced, pad band clamped, weighted pooling,
//      determinism, honest undefined when the band cannot hold the ports;
//   2. the ASSIGNMENT (assignPortOffsets): wired ports land exactly opposite their peers, unwired ports keep their
//      fraction, manifest order survives, pinned-by-hand nodes still slide;
//   3. the OLD BUG CLASS, pinned shut end-to-end: the MULTI-OUT JOG — layout deriving ports from WIRES while the
//      canvas renders MANIFEST handles put api.db 29.7px off its rendered anchor (the owner's api.db→pg.in case);
//      with catalog ports threaded (designPorts) AND the slide assigned, the router ships ONE straight segment.

// ── 1 · the isotonic unit ────────────────────────────────────────────────────────────────────────────────────

describe('slidePositions — the weighted bounded isotonic projection (PAVA + shifted-bound clamp)', () => {
  it('feasible targets in order pass through untouched', () => {
    const out = slidePositions([{ target: 30, weight: 1 }, { target: 60, weight: 1 }, { target: 100, weight: 1 }], 160);
    expect(out).toEqual([30, 60, 100]);
  });

  it('preserves order: reversed targets pool to their weighted mean, never swap', () => {
    const out = slidePositions([{ target: 90, weight: 1 }, { target: 30, weight: 1 }], 160)!;
    expect(out[0]!).toBeLessThanOrEqual(out[1]! - MIN_PORT_GAP);
    // the pooled pair straddles the weighted mean of the shifted targets, symmetric about (90+30−gap)/2 + gap/2
    expect((out[0]! + out[1]!) / 2).toBeCloseTo(60, 9);
  });

  it('enforces the minimum gap between neighbours', () => {
    const out = slidePositions([{ target: 50, weight: 1 }, { target: 52, weight: 1 }, { target: 54, weight: 1 }], 200)!;
    for (let i = 1; i < out.length; i++) expect(out[i]! - out[i - 1]!).toBeGreaterThanOrEqual(MIN_PORT_GAP - 1e-9);
  });

  it('a heavier (wired) target wins the contested y — the lighter neighbour yields', () => {
    // Both want y=80; the isotonic pool puts the pair's weighted mean near the heavy one's target.
    const out = slidePositions([{ target: 80, weight: 8 }, { target: 80, weight: 1 }], 200)!;
    expect(out[0]!).toBeGreaterThan(80 - MIN_PORT_GAP / 2 - 1e-9); // heavy port stays close to 80
    expect(Math.abs(out[0]! - 80)).toBeLessThan(Math.abs(out[1]! - 80)); // the light one moved farther
    expect(out[1]! - out[0]!).toBeGreaterThanOrEqual(MIN_PORT_GAP - 1e-9);
  });

  it('clamps into the pad band and keeps the gap at the clamp (the shifted-bound law)', () => {
    const h = 100;
    const out = slidePositions([{ target: -50, weight: 1 }, { target: -40, weight: 1 }, { target: 500, weight: 1 }], h)!;
    expect(out[0]!).toBeGreaterThanOrEqual(PORT_EDGE_PAD);
    expect(out[2]!).toBeLessThanOrEqual(h - PORT_EDGE_PAD);
    for (let i = 1; i < out.length; i++) expect(out[i]! - out[i - 1]!).toBeGreaterThanOrEqual(MIN_PORT_GAP - 1e-9);
  });

  it('returns undefined when the band cannot hold the ports at the gap (fraction fallback, never a squeezed lie)', () => {
    // 4 ports need 3×18 = 54px of band; a 60px node has 60 − 2×16 = 28px.
    expect(slidePositions([{ target: 10, weight: 1 }, { target: 20, weight: 1 }, { target: 30, weight: 1 }, { target: 40, weight: 1 }], 60)).toBeUndefined();
    expect(slidePositions([], 60)).toEqual([]);
  });

  it('is deterministic: identical input → identical output', () => {
    const targets = [{ target: 77.3, weight: 4 }, { target: 12.9, weight: 1 }, { target: 130.4, weight: 8 }];
    expect(slidePositions(targets, 170)).toEqual(slidePositions(targets, 170));
  });
});

// ── 2 · the assignment ───────────────────────────────────────────────────────────────────────────────────────

/** A two-column pair: src.out → dst.in, with dst's top offset so the fraction anchors are misaligned by 40px. */
const PAIR: LayoutDesign = {
  nodes: [
    { id: 'src', size: { w: 160, h: 120 } },
    { id: 'dst', size: { w: 160, h: 120 } },
  ],
  wires: [{ from: ['src', 'out'], to: ['dst', 'in'] }],
  groups: [],
};
const PAIR_AT: Placement = { src: { x: 0, y: 0 }, dst: { x: 340, y: 40 } };

describe('assignPortOffsets — wired ports sit exactly opposite their peers', () => {
  it('slides the target in-port onto the source out-anchor row (one exact meet per left→right wire)', () => {
    const offs = assignPortOffsets(PAIR, PAIR_AT);
    const srcOut = PAIR_AT.src!.y + offs.src![portOffsetKey('out', 'out')]!;
    const dstIn = PAIR_AT.dst!.y + offs.dst![portOffsetKey('in', 'in')]!;
    expect(dstIn).toBeCloseTo(srcOut, 9); // exactly opposite — the wire rides ONE row
  });

  it('an unwired port keeps its fraction position', () => {
    const d: LayoutDesign = {
      nodes: [
        { id: 'a', size: { w: 160, h: 120 }, ports: [{ name: 'out', dir: 'out' }] },
        { id: 'b', size: { w: 160, h: 160 }, ports: [{ name: 'in', dir: 'in' }, { name: 'spare', dir: 'in' }] },
      ],
      wires: [{ from: ['a', 'out'], to: ['b', 'in'] }],
      groups: [],
    };
    const at: Placement = { a: { x: 0, y: 0 }, b: { x: 340, y: 10 } };
    const offs = assignPortOffsets(d, at);
    const ports = designPorts(d);
    // `spare` is unwired: it holds its manifest fraction (2/3 of 160) — sliding never disturbs the idle look.
    expect(offs.b![portOffsetKey('in', 'spare')]).toBeCloseTo(160 * portFraction(ports.get('b')!, 'in', 'spare'), 1);
    // while `in` slid to meet a.out exactly:
    expect(at.b!.y + offs.b![portOffsetKey('in', 'in')]!).toBeCloseTo(at.a!.y + offs.a![portOffsetKey('out', 'out')]!, 9);
  });

  it('preserves manifest order and the min gap on a multi-port side', () => {
    const d: LayoutDesign = {
      nodes: [
        { id: 's', size: { w: 160, h: 160 }, ports: [{ name: 'p1', dir: 'out' }, { name: 'p2', dir: 'out' }, { name: 'p3', dir: 'out' }] },
        { id: 't1', size: { w: 160, h: 80 }, ports: [{ name: 'in', dir: 'in' }] },
        { id: 't2', size: { w: 160, h: 80 }, ports: [{ name: 'in', dir: 'in' }] },
        { id: 't3', size: { w: 160, h: 80 }, ports: [{ name: 'in', dir: 'in' }] },
      ],
      // p1..p3 wired to targets stacked in REVERSE vertical order — a naive per-port jump would reorder the side.
      wires: [
        { from: ['s', 'p1'], to: ['t3', 'in'] },
        { from: ['s', 'p2'], to: ['t2', 'in'] },
        { from: ['s', 'p3'], to: ['t1', 'in'] },
      ],
      groups: [],
    };
    const at: Placement = { s: { x: 0, y: 100 }, t1: { x: 340, y: 0 }, t2: { x: 340, y: 140 }, t3: { x: 340, y: 280 } };
    const offs = assignPortOffsets(d, at);
    const ys = ['p1', 'p2', 'p3'].map((p) => offs.s![portOffsetKey('out', p)]!);
    expect(ys[0]!).toBeLessThanOrEqual(ys[1]! - MIN_PORT_GAP + 1e-9); // manifest order held, gap held
    expect(ys[1]!).toBeLessThanOrEqual(ys[2]! - MIN_PORT_GAP + 1e-9);
    expect(minAssignedPortGap(d, offs)).toBeGreaterThanOrEqual(MIN_PORT_GAP - 1e-9);
  });

  it('an unplaced node assigns nothing; a gap-infeasible side falls back to fractions (absent keys)', () => {
    const d: LayoutDesign = {
      nodes: [
        { id: 'tiny', size: { w: 160, h: 50 }, ports: [{ name: 'a', dir: 'out' }, { name: 'b', dir: 'out' }, { name: 'c', dir: 'out' }] },
        { id: 'ghost' },
      ],
      wires: [],
      groups: [],
    };
    const offs = assignPortOffsets(d, { tiny: { x: 0, y: 0 } });
    expect(offs.ghost).toBeUndefined();
    expect(offs.tiny).toBeUndefined(); // 3 ports on a 50px node: the band (50−32=18) < 2×18 — honest fallback
  });

  it('is deterministic and rides the placement: same design + same placement → identical offsets', () => {
    const one = assignPortOffsets(PAIR, PAIR_AT);
    const two = assignPortOffsets(PAIR, PAIR_AT);
    expect(one).toEqual(two);
  });

  it('a hand-pinned node still slides its ports — position is node-level, ports are ours', () => {
    // Same PAIR but pretend dst was hand-dragged: the assignment has no pin concept at all — any placed node
    // slides. This pins the CONTRACT (pins constrain the box search, never the slide).
    const dragged: Placement = { src: { x: 0, y: 0 }, dst: { x: 500, y: 77 } };
    const offs = assignPortOffsets(PAIR, dragged);
    expect(dragged.dst!.y + offs.dst![portOffsetKey('in', 'in')]!).toBeCloseTo(dragged.src!.y + offs.src![portOffsetKey('out', 'out')]!, 9);
  });
});

// ── 3 · the multi-out jog, pinned shut end-to-end (the owner's api.db→pg.in case) ───────────────────────────

/** The unequal-chain shape from the VS-pixels proof: client → api(compute.service-like) → pg. The api node's
 *  MANIFEST out side is [db, out, cache] with only `db` wired, and its measured height is 118.8 — so the
 *  wire-derived model put db at h/2 = 59.4 while the canvas renders it at h/4 = 29.7: the 29.7px jog. */
const API_H = 118.8;
const CHAIN_PORTS: Readonly<Record<string, readonly PortLike[]>> = {
  client: [{ name: 'out', dir: 'out' }],
  api: [{ name: 'in', dir: 'in' }, { name: 'db', dir: 'out' }, { name: 'out', dir: 'out' }, { name: 'cache', dir: 'out' }],
  pg: [{ name: 'in', dir: 'in' }],
};
const chainDesign = (withPorts: boolean): LayoutDesign => ({
  nodes: [
    { id: 'client', type: 'client.web', size: { w: 160, h: 100 }, ...(withPorts ? { ports: CHAIN_PORTS.client } : {}) },
    { id: 'api', type: 'compute.service', size: { w: 160, h: API_H }, ...(withPorts ? { ports: CHAIN_PORTS.api } : {}) },
    { id: 'pg', type: 'db.postgres', size: { w: 160, h: 140 }, ...(withPorts ? { ports: CHAIN_PORTS.pg } : {}) },
  ],
  wires: [
    { from: ['client', 'out'], to: ['api', 'in'] },
    { from: ['api', 'db'], to: ['pg', 'in'] },
  ],
  groups: [],
});
const CHAIN_SIZES = { client: { w: 160, h: 100 }, api: { w: 160, h: API_H }, pg: { w: 160, h: 140 } };

/** Route the chain exactly as the shells do — MANIFEST ports on the router geometry — at a placement, with or
 *  without assigned offsets. Returns the routed points of api.db→pg.in (wire 1). */
const routeChainWire = (d: LayoutDesign, at: Placement, offsets?: ReturnType<typeof assignPortOffsets>) => {
  const nodes = d.nodes.map((n) => ({
    id: n.id,
    box: { x: at[n.id]!.x, y: at[n.id]!.y, w: n.size!.w, h: n.size!.h },
    ports: [...CHAIN_PORTS[n.id]!], // the canvas ALWAYS renders manifest handles — both shells feed these
    ...(offsets?.[n.id] !== undefined ? { portOffsets: offsets[n.id]! } : {}),
  }));
  return routeDesignEdges({ nodes, wires: d.wires.map((w) => ({ from: w.from, to: w.to })) });
};

describe('the multi-out jog (api.db→pg.in, 29.7px) — the wire-derived-vs-manifest bug class, pinned', () => {
  it('OLD MODEL (no catalog ports on the design): the layout aligns an anchor that does not exist — 29.7px jog', () => {
    const d = chainDesign(false);
    const at = semanticLayout(d, CHAIN_SIZES);
    // The layout believed api.db sits at h/2 (wire-derived: db is api's only out port); the canvas renders it at
    // h/4 of the MANIFEST out side [db, out, cache]. The residual is exactly h·(1/2 − 1/4) = 29.7px…
    expect(API_H / 2 - API_H / 4).toBeCloseTo(29.7, 9);
    // …so the ROUTED wire (manifest anchors — what both shells feed) cannot be one straight segment.
    const pts = routeChainWire(d, at).get(1)!.points;
    const straight = pts.length === 2 && pts[0]!.y === pts[1]!.y;
    expect(straight, `old model must exhibit the jog: ${JSON.stringify(pts)}`).toBe(false);
  });

  it('NEW MODEL (catalog ports threaded + the slide): api.db→pg.in ships as ONE straight segment — and so does the whole chain', () => {
    const d = chainDesign(true);
    const at = semanticLayout(d, CHAIN_SIZES);
    const offsets = assignPortOffsets(d, at, CHAIN_SIZES);
    const routed = routeChainWire(d, at, offsets);
    d.wires.forEach((_, i) => {
      const pts = routed.get(i)!.points;
      expect(pts.length, `wire ${i} is ONE segment: ${JSON.stringify(pts)}`).toBe(2);
      expect(pts[0]!.y, `wire ${i} rides one row`).toBeCloseTo(pts[1]!.y, 6);
    });
    // and the handles keep the manifest ORDER + the min gap on api's 3-port out side
    expect(minAssignedPortGap(d, offsets)).toBeGreaterThanOrEqual(MIN_PORT_GAP - 1e-9);
    const outs = ['db', 'out', 'cache'].map((p) => offsets.api![portOffsetKey('out', p)]!);
    expect(outs[0]!).toBeLessThan(outs[1]!);
    expect(outs[1]!).toBeLessThan(outs[2]!);
  });

  it('the router and the renderer resolve a port through ONE helper: assigned offset ?? height × fraction', () => {
    const d = chainDesign(true);
    const at = semanticLayout(d, CHAIN_SIZES);
    const offsets = assignPortOffsets(d, at, CHAIN_SIZES);
    const ports = designPorts(d);
    // With offsets: portAnchorOffset returns the assigned value (what the handle renders at)…
    expect(portAnchorOffset(ports.get('api')!, 'out', 'db', API_H, offsets.api)).toBe(offsets.api![portOffsetKey('out', 'db')]);
    // …without: the manifest fraction (db = 1/4 of the [db,out,cache] side).
    expect(portAnchorOffset(ports.get('api')!, 'out', 'db', API_H)).toBeCloseTo(API_H / 4, 9);
    // And nodeGeoms threads the same map onto the router's geometry.
    const geoms = nodeGeoms(d, at, ports, offsets);
    expect(geoms.find((g) => g.id === 'api')!.portOffsets).toEqual(offsets.api);
  });
});
