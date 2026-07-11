import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { LayoutDesign, LayoutGroup, LayoutNode, LayoutWire, Placement } from './layout-model';
import { sizeOf } from './layout-model';
import { scoreLayout } from './layout-objective';
import { semanticLayout } from './layout-semantic';
import { COMPACT_GUTTERS, compactColumns, snapToAnchors, symmetrizeFanouts } from './layout-refine';
import type { Size } from './layout';

// R2 REFINEMENTS (doc: ideal-layout §3) — the two deterministic candidate generators the beam draws from: rank
// compaction (node-size-aware X tightening, lane/pin-preserving, tighten-only) and fan-out symmetrization
// (group-aware Reingold–Tilford centering). These unit-pin the mechanics the search relies on: widths respect node
// sizes, pins are immovable, feasibility is preserved, and the mirror is real — so a regression here is caught
// before it can quietly erode the aggregate the benchmark gates.

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
const sizeMapOf = (d: LayoutDesign, override?: Record<string, Size>): Record<string, Size> => {
  const s: Record<string, Size> = {};
  for (const n of d.nodes) s[n.id] = override?.[n.id] ?? sizeOf(n);
  return s;
};

describe('compactColumns — node-size-aware pitch (widths respect node sizes)', () => {
  it('sets each column pitch to the previous column widest node + the gutter', () => {
    // A 3-node chain a→b→c, each in its own column, with DISTINCT widths. The pitch to the next column must be the
    // previous column's own width + gutter — a wide node pushes the next column further right than a narrow one.
    const d: LayoutDesign = {
      nodes: [
        { id: 'a', size: { w: 300, h: 100 } },
        { id: 'b', size: { w: 80, h: 100 } },
        { id: 'c', size: { w: 160, h: 100 } },
      ],
      wires: [
        { from: ['a', 'o'], to: ['b', 'i'] },
        { from: ['b', 'o'], to: ['c', 'i'] },
      ],
      groups: [],
    };
    const placement: Placement = { a: { x: 0, y: 0 }, b: { x: 1000, y: 0 }, c: { x: 2000, y: 0 } };
    const gutter = 100;
    const out = compactColumns(d, placement, sizeMapOf(d), { gutter });
    expect(out.a!.x).toBe(0); // leftmost column anchors on the left margin
    expect(out.b!.x).toBe(0 + 300 + gutter); // a is 300 wide → b sits 400 right
    expect(out.c!.x).toBe(out.b!.x + 80 + gutter); // b is only 80 wide → c packs tighter (480), not another 400
  });

  it('is tighten-only: never places a column right of where it already sat', () => {
    for (const f of EXAMPLES) {
      const d = load(f);
      const sem = semanticLayout(d, sizeMapOf(d));
      for (const gutter of COMPACT_GUTTERS) {
        const out = compactColumns(d, sem, sizeMapOf(d), { gutter });
        for (const n of d.nodes) expect(out[n.id]!.x, `${f} g${gutter} ${n.id} tighten-only`).toBeLessThanOrEqual(sem[n.id]!.x + 1e-9);
      }
    }
  });

  it('moves X only — every Y (and thus every group band) is preserved', () => {
    const d = load('ecommerce-production.sda.json');
    const sem = semanticLayout(d, sizeMapOf(d));
    const out = compactColumns(d, sem, sizeMapOf(d), { gutter: 80 });
    for (const n of d.nodes) expect(out[n.id]!.y).toBe(sem[n.id]!.y);
  });
});

describe('compactColumns — pins are immovable (H5)', () => {
  it('holds a pinned node column at its X and never drags it', () => {
    const d = load('cqrs.sda.json');
    const sem = semanticLayout(d, sizeMapOf(d));
    const pinId = d.nodes.find((n) => n.id === 'cmd')!.id;
    const pins = new Set([pinId]);
    const out = compactColumns(d, sem, sizeMapOf(d), { gutter: 60, pins });
    expect(out[pinId]!.x).toBe(sem[pinId]!.x);
    expect(out[pinId]!.y).toBe(sem[pinId]!.y);
  });
});

describe('compactColumns — feasibility preserved', () => {
  it('a compacted semantic layout stays hard-constraint feasible on every example, at every seeded gutter', () => {
    for (const f of EXAMPLES) {
      const d = load(f);
      const sem = semanticLayout(d, sizeMapOf(d));
      expect(scoreLayout(d, sem).feasible, `${f} semantic feasible`).toBe(true);
      for (const gutter of COMPACT_GUTTERS) {
        const s = scoreLayout(d, compactColumns(d, sem, sizeMapOf(d), { gutter }));
        expect(s.feasible, `${f} compacted g${gutter}: ${s.hard.map((h) => h.constraint).join(',')}`).toBe(true);
      }
    }
  });

  it('is a pure function — same input yields byte-identical geometry', () => {
    const d = load('cqrs-production-large.sda.json');
    const sem = semanticLayout(d, sizeMapOf(d));
    const a = compactColumns(d, sem, sizeMapOf(d), { gutter: 100 });
    const b = compactColumns(d, sem, sizeMapOf(d), { gutter: 100 });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

describe('symmetrizeFanouts — mirrors fan-outs (the symmetry win)', () => {
  it('drives the CQRS symmetry penalty to zero (the two 2-way fan-outs straddle their parent)', () => {
    const d = load('cqrs.sda.json');
    const sem = semanticLayout(d, sizeMapOf(d));
    const before = scoreLayout(d, sem).penalties.symmetry!;
    const after = scoreLayout(d, symmetrizeFanouts(d, sem, sizeMapOf(d))).penalties.symmetry!;
    // The precondition pins that the raw seed is still VISIBLY asymmetric, so the mirror below is a real win. R5
    // (port-centric rows + the anchor snap) improved the seed itself: measured 0.395 (was > 0.4 pre-R5), so the
    // bound is re-derived from the measurement — the law is `after`, driven to ~0 regardless of the seed.
    expect(before).toBeGreaterThan(0.35);
    expect(after).toBeLessThan(0.05);
  });

  it('is a pure function — same input yields byte-identical geometry', () => {
    const d = load('cqrs.sda.json');
    const sem = semanticLayout(d, sizeMapOf(d));
    const a = symmetrizeFanouts(d, sem, sizeMapOf(d));
    const b = symmetrizeFanouts(d, sem, sizeMapOf(d));
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

describe('symmetrizeFanouts — group-aware (feasibility preserved on grouped designs)', () => {
  it('stays hard-constraint feasible on the grouped designs (a blind global centering would eject members, H4)', () => {
    for (const f of ['ecommerce-production.sda.json', 'cqrs-production-large.sda.json']) {
      const d = load(f);
      const sem = semanticLayout(d, sizeMapOf(d));
      const s = scoreLayout(d, symmetrizeFanouts(d, sem, sizeMapOf(d)));
      expect(s.feasible, `${f} symmetrized feasible: ${s.hard.map((h) => h.constraint).join(',')}`).toBe(true);
    }
  });
});

describe('symmetrizeFanouts — pins are held at their Y', () => {
  it('never moves a pinned node off its stored Y', () => {
    const d = load('cqrs.sda.json');
    const sem = semanticLayout(d, sizeMapOf(d));
    const pinId = 'sns';
    const out = symmetrizeFanouts(d, sem, sizeMapOf(d), { pins: new Set([pinId]) });
    expect(out[pinId]!.y).toBe(sem[pinId]!.y);
  });
});

// R5 — the ANCHOR SNAP generator: near-aligned rows (inside the objective's ε, outside the router's 4px snap) are
// re-seated EXACTLY onto the dominant wire's port-anchor line, wherever the column's box separation still holds.

describe('snapToAnchors — exact port-collinearity where separation allows (R5)', () => {
  const chain: LayoutDesign = {
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
  const chainSizes: Record<string, Size> = { a: { w: 160, h: 80 }, b: { w: 160, h: 140 }, c: { w: 160, h: 100 } };

  it('closes a few-px residual: the chain nodes land with their anchors EXACTLY collinear', () => {
    // b's anchor (y+70) sits 6px off a's (y+40) and c's is 3px off — "aligned" to the eye, Zs to the router.
    const off: Placement = { a: { x: 60, y: 70 }, b: { x: 400, y: 46 }, c: { x: 740, y: 63 } };
    const out = snapToAnchors(chain, off, chainSizes);
    expect(out['a']!.y + 40).toBeCloseTo(out['b']!.y + 70, 9); // a.out on b.in's row
    expect(out['b']!.y + 70).toBeCloseTo(out['c']!.y + 50, 9); // b.out on c.in's row
    expect(out['a']!.x).toBe(60); // X untouched — columns stay put
  });

  it('refuses a snap that would break the column separation (never a new overlap, never a reorder)', () => {
    // Two feeders in ONE column both chase the same 120px hub's single in-anchor — they cannot both hold it.
    const d: LayoutDesign = {
      nodes: [{ id: 'f1' }, { id: 'f2' }, { id: 'hub' }],
      wires: [
        { from: ['f1', 'out'], to: ['hub', 'in'] },
        { from: ['f2', 'out'], to: ['hub', 'in'] },
      ],
      groups: [],
    };
    const p: Placement = { f1: { x: 0, y: 0 }, f2: { x: 0, y: 176 }, hub: { x: 400, y: 88 } };
    const out = snapToAnchors(d, p, { f1: { w: 160, h: 120 }, f2: { w: 160, h: 120 }, hub: { w: 160, h: 120 } });
    // Order preserved and the 176px anchor pitch kept — one feeder may hold the row, the other must stay clear.
    expect(out['f2']!.y - out['f1']!.y).toBeGreaterThanOrEqual(176);
  });

  it('holds pins and is a pure function (byte-identical across runs)', () => {
    const off: Placement = { a: { x: 60, y: 70 }, b: { x: 400, y: 46 }, c: { x: 740, y: 63 } };
    const pinned = snapToAnchors(chain, off, chainSizes, { pins: new Set(['b']) });
    expect(pinned['b']).toEqual(off['b']);
    expect(JSON.stringify(snapToAnchors(chain, off, chainSizes))).toEqual(JSON.stringify(snapToAnchors(chain, off, chainSizes)));
  });

  it('keeps every committed example hard-constraint feasible when applied to the semantic seed', () => {
    for (const f of EXAMPLES) {
      const d = load(f);
      const s = scoreLayout(d, snapToAnchors(d, semanticLayout(d, sizeMapOf(d)), sizeMapOf(d)));
      expect(s.feasible, `${f} snapped feasible: ${s.hard.map((h) => h.constraint).join(',')}`).toBe(true);
    }
  });
});
