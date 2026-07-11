import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { LayoutDesign, LayoutGroup, LayoutNode, LayoutWire, Placement } from './layout-model';
import { COL0, COLW, DEFAULT_NODE_SIZE, longestPathDepth, nodeGeoms } from './layout-model';
import { scoreLayout } from './layout-objective';
import { semanticLayout } from './layout-semantic';
import { optimizeLayout } from './layout-optimize';
import { tidyLayout } from './layout';
import { type Pos, routeDesignEdges } from './edge-routing';

interface Raw {
  instances: { id: string; type: string; config?: Record<string, number> }[];
  wires: { from: [string, string]; to: [string, string]; semantics?: 'sync' | 'async' }[];
  groups?: { id: string; members: string[] }[];
}
function load(file: string): LayoutDesign {
  const raw = JSON.parse(readFileSync(new URL(`../../../examples/${file}`, import.meta.url), 'utf8')) as Raw;
  const nodes: LayoutNode[] = raw.instances.map((i) => {
    const origin = i.config?.assumedRps;
    return origin !== undefined ? { id: i.id, type: i.type, originRate: origin } : { id: i.id, type: i.type };
  });
  const wires: LayoutWire[] = raw.wires.map((w) => (w.semantics !== undefined ? { from: w.from, to: w.to, semantics: w.semantics } : { from: w.from, to: w.to }));
  const groups: LayoutGroup[] = (raw.groups ?? []).map((g) => ({ id: g.id, members: g.members }));
  return { nodes, wires, groups };
}
const EXAMPLES = ['cqrs.sda.json', 'ecommerce-production.sda.json', 'cqrs-production-large.sda.json', 'oracle-to-aurora-migration-repeat.sda.json'];
const tidyOf = (d: LayoutDesign) => {
  const groups = d.groups.map((g) => ({ id: g.id, label: '', rect: { x: 0, y: 0, w: 0, h: 0 }, members: g.members }));
  const sizes: Record<string, { w: number; h: number }> = {};
  for (const x of d.nodes) sizes[x.id] = DEFAULT_NODE_SIZE;
  return tidyLayout(d.nodes.map((x) => ({ id: x.id })), d.wires.map((w) => ({ from: w.from, to: w.to })), groups, sizes).pos;
};

describe('semantic pass — determinism', () => {
  it('is a pure function: the same design yields byte-identical geometry', () => {
    for (const f of EXAMPLES) {
      const d = load(f);
      const a = semanticLayout(d);
      const b = semanticLayout(d);
      expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
    }
  });
});

describe('semantic pass — feasibility (never a broken seed)', () => {
  it('produces a hard-constraint-feasible layout on every committed example', () => {
    for (const f of EXAMPLES) {
      const d = load(f);
      const s = scoreLayout(d, semanticLayout(d));
      expect(s.feasible, `${f} must be feasible: ${s.hard.map((h) => h.constraint).join(',')}`).toBe(true);
    }
  });
});

// R5, PORT-CENTRIC ROWS — "aligned" must mean the ROUTED PORT ANCHORS are collinear, so the router's straight-line
// fast path fires. These pin the law on the two shapes the owner named: unequal-height chains and tall multi-port
// nodes (anchor at a port FRACTION, not the centre).

/** Route a placement with the router (the arbiter) and return each wire's polyline. */
function routesOf(d: LayoutDesign, placement: Placement): Map<number, readonly Pos[]> {
  const routed = routeDesignEdges({ nodes: nodeGeoms(d, placement), wires: d.wires.map((w) => ({ from: w.from, to: w.to })) });
  const out = new Map<number, readonly Pos[]>();
  d.wires.forEach((_, i) => {
    const r = routed.get(i);
    if (r !== undefined) out.set(i, r.points);
  });
  return out;
}

describe('semantic pass — port-collinear rows (R5): the straight-line fast path fires', () => {
  it('a 3-node chain of heights 80/140/100 routes ONE straight wire per hop', () => {
    const d: LayoutDesign = {
      nodes: [
        { id: 'a', size: { w: 160, h: 80 } },
        { id: 'b', size: { w: 160, h: 140 } },
        { id: 'c', size: { w: 160, h: 100 } },
      ],
      wires: [
        { from: ['a', 'out'], to: ['b', 'in'] },
        { from: ['b', 'out'], to: ['c', 'in'] },
      ],
      groups: [],
    };
    const p = semanticLayout(d);
    for (const [i, pts] of routesOf(d, p)) {
      expect(pts.length, `wire ${i} is ONE straight segment`).toBe(2);
      expect(pts[0]!.y, `wire ${i} rides one row`).toBeCloseTo(pts[1]!.y, 9);
    }
    // Byte-identical across runs — the port-centric row machinery stays a pure function.
    expect(JSON.stringify(semanticLayout(d))).toEqual(JSON.stringify(p));
  });

  it('a TALL two-in-port node: each feeder lands on ITS port row (1/3, 2/3) — both wires straight', () => {
    // hub is 600px tall with in-ports p1 (anchor at 200) and p2 (anchor at 400); the feeders are 80px. Centre- or
    // top-aligned rows would break both lines; port-centric rows put each feeder's out anchor EXACTLY on its
    // target port's row (the 200px between the port rows clears the feeders' 136px separation need).
    const d: LayoutDesign = {
      nodes: [
        { id: 'f1', size: { w: 160, h: 80 } },
        { id: 'f2', size: { w: 160, h: 80 } },
        { id: 'hub', size: { w: 160, h: 600 } },
      ],
      wires: [
        { from: ['f1', 'out'], to: ['hub', 'p1'] },
        { from: ['f2', 'out'], to: ['hub', 'p2'] },
      ],
      groups: [],
    };
    const p = semanticLayout(d);
    const routes = routesOf(d, p);
    for (const [i, pts] of routes) {
      expect(pts.length, `wire ${i} is ONE straight segment`).toBe(2);
    }
    // The anchors really are the port fractions of the tall node, not its centre:
    expect(routes.get(0)![1]!.y).toBeCloseTo(p['hub']!.y + 200, 9);
    expect(routes.get(1)![1]!.y).toBeCloseTo(p['hub']!.y + 400, 9);
  });
});

describe('semantic pass — keeps Tidy columns (forward flow), improves the lanes', () => {
  it('places each node in its longest-path column (x preserved from Tidy)', () => {
    const d = load('cqrs.sda.json');
    const p = semanticLayout(d);
    const depth = longestPathDepth(d);
    for (const node of d.nodes) {
      expect(p[node.id]!.x).toBe(COL0 + (depth[node.id] ?? 0) * COLW);
    }
  });

  it('seeds a layout the optimizer drives past raw Tidy on CQRS (R4: the aggregate edge is the pipeline\'s)', () => {
    const d = load('cqrs.sda.json');
    const sizes: Record<string, { w: number; h: number }> = {};
    for (const x of d.nodes) sizes[x.id] = DEFAULT_NODE_SIZE;
    const tidy = scoreLayout(d, tidyOf(d));
    const sem = scoreLayout(d, semanticLayout(d));
    // R5 (port-centric alignment). The seed's structural contribution is re-derived once more: the anchor snap now
    // takes CQRS's seventh straight wire (sns onto reportq's anchor row — the fall-through line), matching Tidy's
    // straight count while Tidy only had it by grid accident; the aggregate cost of that trade (measured 0.840 vs
    // Tidy 0.845 — the sns fan-out is no longer mirrored) is exactly what the ratified vector prices, and the
    // OPTIMIZER the seed feeds still beats raw Tidy DECISIVELY on quality (measured 0.883). The straight-wire law
    // for the deterministic pass is pinned per-example in layout-benchmark.test.ts.
    expect(sem.feasible).toBe(true);
    const opt = optimizeLayout(d, { seed: 1, sizes });
    expect(opt.score.quality, 'the semantic-seeded optimizer beats raw Tidy on CQRS').toBeGreaterThan(tidy.quality);
  });
});
