import { describe, it, expect } from 'vitest';
import type { Pos } from './layout';
import { type LayoutDesign, type Placement, collinearOverlapLength, parallelTrackGap, polylinesCross, segmentsProperlyCross } from './layout-model';
import {
  LAYOUT_TERMS,
  LAYOUT_WEIGHTS,
  layoutGeometry,
  scoreGeometry,
  crossingsPenalty,
  bendsPenalty,
  lengthPenalty,
  alignmentPenalty,
  lanePenalty,
  rolePenalty,
  symmetryPenalty,
  groupPenalty,
  asyncPenalty,
  areaPenalty,
  labelPenalty,
  overlapPenalty,
  spacingPenalty,
  mergePenalty,
  separationMetrics,
  boxViolations,
  hardViolations,
} from './layout-objective';

// Hand geometries — each term is probed on a placement whose value we know, and the doc's HONESTY rule is pinned:
// a term with no SUBJECT in the design scores N/A (null), never a false zero-perfect.

const n = (id: string, type?: string) => (type === undefined ? { id } : { id, type });
const design = (nodes: LayoutDesign['nodes'], wires: LayoutDesign['wires'] = [], groups: LayoutDesign['groups'] = []): LayoutDesign => ({ nodes, wires, groups });
const geo = (d: LayoutDesign, p: Placement) => layoutGeometry(d, p);

describe('layout objective — weights', () => {
  it('the ratified weight vector has all eleven terms and sums to 1', () => {
    expect(Object.keys(LAYOUT_WEIGHTS).sort()).toEqual([...LAYOUT_TERMS].sort());
    const total = LAYOUT_TERMS.reduce((s, t) => s + LAYOUT_WEIGHTS[t], 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
  });
});

describe('crossings', () => {
  it('segment + polyline crossing detection is proper-interior only (shared endpoints do NOT count)', () => {
    expect(segmentsProperlyCross({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true);
    // share an endpoint — not a crossing
    expect(segmentsProperlyCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 })).toBe(false);
    const a: Pos[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    const b: Pos[] = [{ x: 5, y: -5 }, { x: 5, y: 5 }];
    expect(polylinesCross(a, b)).toBe(true);
  });
  it('is INERT (null) with fewer than two wires — no pair can cross', () => {
    const d = design([n('a'), n('b')], [{ from: ['a', 'out'], to: ['b', 'in'] }]);
    expect(crossingsPenalty(geo(d, { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }))).toBeNull();
  });
  it('scores 0 on a laned layout whose routed wires do not cross', () => {
    const d = design(
      [n('a'), n('b'), n('c'), n('e')],
      [
        { from: ['a', 'out'], to: ['b', 'in'] },
        { from: ['c', 'out'], to: ['e', 'in'] },
      ],
    );
    const p: Placement = { a: { x: 0, y: 0 }, b: { x: 400, y: 0 }, c: { x: 0, y: 300 }, e: { x: 400, y: 300 } };
    expect(crossingsPenalty(geo(d, p))).toBe(0);
  });
});

describe('bends', () => {
  it('is INERT (null) with no wires', () => {
    expect(bendsPenalty(geo(design([n('a')]), { a: { x: 0, y: 0 } }))).toBeNull();
  });
  it('scores 0 for an aligned straight wire and > 0 for an offset (Z) wire', () => {
    const d = design([n('a'), n('b')], [{ from: ['a', 'out'], to: ['b', 'in'] }]);
    const straight = bendsPenalty(geo(d, { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }));
    const zed = bendsPenalty(geo(d, { a: { x: 0, y: 0 }, b: { x: 400, y: 240 } }));
    expect(straight).toBe(0);
    expect(zed).toBeGreaterThan(0);
  });
});

describe('wire length', () => {
  it('is INERT (null) with no wires and in (0,1] otherwise', () => {
    expect(lengthPenalty(geo(design([n('a')]), { a: { x: 0, y: 0 } }))).toBeNull();
    const d = design([n('a'), n('b')], [{ from: ['a', 'out'], to: ['b', 'in'] }]);
    const p = lengthPenalty(geo(d, { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }));
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThan(0);
    expect(p!).toBeLessThanOrEqual(1);
  });
});

describe('block alignment', () => {
  it('is INERT (null) with fewer than two nodes', () => {
    expect(alignmentPenalty(geo(design([n('a')]), { a: { x: 0, y: 0 } }))).toBeNull();
  });
  it('scores 0 when every centre shares a guideline, 1 when none do', () => {
    const stacked = design([n('a'), n('b'), n('c')]);
    const shared: Placement = { a: { x: 0, y: 0 }, b: { x: 0, y: 200 }, c: { x: 0, y: 400 } }; // shared column x
    expect(alignmentPenalty(geo(stacked, shared))).toBe(0);
    const scattered = design([n('a'), n('b')]);
    const none: Placement = { a: { x: 0, y: 0 }, b: { x: 500, y: 300 } };
    expect(alignmentPenalty(geo(scattered, none))).toBe(1);
  });

  // R5 — row guidelines are measured on the DOMINANT PORT ANCHOR, not on node geometry: what earns the alignment
  // reward is exactly what the router draws as one straight line.
  const twoInHub = (): LayoutDesign =>
    design([n('a'), n('c'), n('hub')], [
      { from: ['a', 'out'], to: ['hub', 'p1'] }, // hub's 2 in-ports ⇒ anchors at 1/3 and 2/3 of its height
      { from: ['c', 'out'], to: ['hub', 'p2'] },
    ]);
  it('counts PORT-anchor rows as aligned even where centres disagree (R5)', () => {
    // a's out anchor (y+60) sits EXACTLY on hub.p1's row (hub.y+40): anchors collinear, centres 20px apart. c is
    // parked far off any guideline (x offset 40 breaks the column, y 400 breaks every row) ⇒ 1 of 3 unaligned.
    const p: Placement = { a: { x: 0, y: 0 }, hub: { x: 340, y: 20 }, c: { x: 40, y: 400 } };
    expect(alignmentPenalty(geo(twoInHub(), p))).toBeCloseTo(1 / 3, 9);
  });
  it('no longer pays for centre-aligned rows whose ANCHORS split (the broken-line false positive)', () => {
    // Same design, hub centre-aligned with a (both centres y=60) — the pre-R5 measure called this aligned, yet
    // a→hub.p1 anchors at 60 vs 40: a Z. No shared x, no shared anchor row ⇒ all three unaligned.
    const p: Placement = { a: { x: 0, y: 0 }, hub: { x: 340, y: 0 }, c: { x: 40, y: 400 } };
    expect(alignmentPenalty(geo(twoInHub(), p))).toBe(1);
  });
});

describe('lane coherence', () => {
  it('rewards a chain that is one horizontal lane over a zig-zag', () => {
    const d = design([n('a'), n('b'), n('c')], [
      { from: ['a', 'out'], to: ['b', 'in'] },
      { from: ['b', 'out'], to: ['c', 'in'] },
    ]);
    const flat = lanePenalty(geo(d, { a: { x: 0, y: 100 }, b: { x: 400, y: 100 }, c: { x: 800, y: 100 } }));
    const zig = lanePenalty(geo(d, { a: { x: 0, y: 0 }, b: { x: 400, y: 300 }, c: { x: 800, y: 0 } }));
    expect(flat).not.toBeNull();
    expect(zig).not.toBeNull();
    expect(flat!).toBeLessThan(zig!);
  });
});

describe('role layering', () => {
  it('is INERT (null) when no node carries a mapped role', () => {
    const d = design([n('a', 'weird.thing'), n('b', 'other.thing')], [{ from: ['a', 'out'], to: ['b', 'in'] }]);
    expect(rolePenalty(geo(d, { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }))).toBeNull();
  });
  it('scores 0 when client→compute→store read left-to-right, > 0 when reversed', () => {
    const d = design([n('c', 'client.web'), n('s', 'compute.service'), n('db', 'db.postgres')], [
      { from: ['c', 'out'], to: ['s', 'in'] },
      { from: ['s', 'out'], to: ['db', 'in'] },
    ]);
    const ordered = rolePenalty(geo(d, { c: { x: 0, y: 0 }, s: { x: 400, y: 0 }, db: { x: 800, y: 0 } }));
    const reversed = rolePenalty(geo(d, { c: { x: 800, y: 0 }, s: { x: 400, y: 0 }, db: { x: 0, y: 0 } }));
    expect(ordered).toBe(0);
    expect(reversed!).toBeGreaterThan(0);
  });
});

describe('symmetry', () => {
  it('is INERT (null) with no fan-out of ≥2 branches', () => {
    const d = design([n('a'), n('b')], [{ from: ['a', 'out'], to: ['b', 'in'] }]);
    expect(symmetryPenalty(geo(d, { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }))).toBeNull();
  });
  it('scores 0 for mirrored branches and → high for both on one side', () => {
    const d = design([n('a'), n('b'), n('c')], [
      { from: ['a', 'out'], to: ['b', 'in'] },
      { from: ['a', 'out'], to: ['c', 'in'] },
    ]);
    const mirrored = symmetryPenalty(geo(d, { a: { x: 0, y: 200 }, b: { x: 400, y: 0 }, c: { x: 400, y: 400 } }));
    const lopsided = symmetryPenalty(geo(d, { a: { x: 0, y: 0 }, b: { x: 400, y: 200 }, c: { x: 400, y: 400 } }));
    expect(mirrored).toBe(0);
    expect(lopsided!).toBeGreaterThan(0.5);
  });
});

describe('group compactness', () => {
  it('is INERT (null) when the design declares no groups (honest N/A, not a free zero)', () => {
    const d = design([n('a'), n('b')], [{ from: ['a', 'out'], to: ['b', 'in'] }]);
    expect(groupPenalty(geo(d, { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }))).toBeNull();
  });
  it('penalises a non-member intruding the group box', () => {
    const members = ['a', 'b'];
    const d = design([n('a'), n('b'), n('x')], [], [{ id: 'g', members }]);
    const clean: Placement = { a: { x: 0, y: 0 }, b: { x: 200, y: 0 }, x: { x: 0, y: 900 } };
    const intruded: Placement = { a: { x: 0, y: 0 }, b: { x: 400, y: 400 }, x: { x: 200, y: 200 } };
    const cp = groupPenalty(geo(d, clean));
    const ip = groupPenalty(geo(d, intruded));
    expect(cp).not.toBeNull();
    expect(ip!).toBeGreaterThan(cp!);
  });
});

describe('async offset', () => {
  it('is INERT (null) when no wire is async', () => {
    const d = design([n('a'), n('b')], [{ from: ['a', 'out'], to: ['b', 'in'] }]);
    expect(asyncPenalty(geo(d, { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }))).toBeNull();
  });
  it('scores 1 for an async wire drawn as a plain straight line, 0 when offset onto a distinct spur', () => {
    const d = design([n('a'), n('b')], [{ from: ['a', 'out'], to: ['b', 'in'], semantics: 'async' }]);
    const plain = asyncPenalty(geo(d, { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }));
    const spur = asyncPenalty(geo(d, { a: { x: 0, y: 0 }, b: { x: 400, y: 260 } }));
    expect(plain).toBe(1);
    expect(spur).toBe(0);
  });
});

describe('area / aspect and label clearance', () => {
  it('area is always active and in [0,1]', () => {
    const d = design([n('a'), n('b')], [{ from: ['a', 'out'], to: ['b', 'in'] }]);
    const p = areaPenalty(geo(d, { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }));
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThanOrEqual(0);
    expect(p!).toBeLessThanOrEqual(1);
  });
  it('label clearance is INERT (null) with no wires', () => {
    expect(labelPenalty(geo(design([n('a')]), { a: { x: 0, y: 0 } }))).toBeNull();
  });
});

// ── Separation (R4) — the owner's traceability terms, on the router's real wires ────────────────────────

describe('separation primitives', () => {
  it('collinearOverlapLength is the span intersection of two same-line segments', () => {
    const a0 = { x: 0, y: 0 }, a1 = { x: 100, y: 0 };
    expect(collinearOverlapLength(a0, a1, { x: 40, y: 0 }, { x: 200, y: 0 }, 4)).toBe(60); // [40,100]
    expect(collinearOverlapLength(a0, a1, { x: 40, y: 10 }, { x: 200, y: 10 }, 4)).toBe(0); // offset beyond tol
    expect(collinearOverlapLength(a0, a1, { x: 50, y: -50 }, { x: 50, y: 50 }, 4)).toBe(0); // perpendicular
  });
  it('parallelTrackGap is the perpendicular distance of two parallel, span-overlapping segments', () => {
    expect(parallelTrackGap({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 40, y: 12 }, { x: 200, y: 12 })).toBe(12);
    expect(parallelTrackGap({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 300, y: 0 })).toBeNull(); // spans disjoint
  });
});

describe('separation terms', () => {
  it('overlap is INERT (null) with fewer than two wires', () => {
    const d = design([n('a'), n('b')], [{ from: ['a', 'out'], to: ['b', 'in'] }]);
    expect(overlapPenalty(geo(d, { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }))).toBeNull();
  });
  it('overlap scores 0 on a laned layout whose routed wires never share a line', () => {
    const d = design([n('a'), n('b'), n('c'), n('e')], [
      { from: ['a', 'out'], to: ['b', 'in'] },
      { from: ['c', 'out'], to: ['e', 'in'] },
    ]);
    expect(overlapPenalty(geo(d, { a: { x: 0, y: 0 }, b: { x: 400, y: 0 }, c: { x: 0, y: 300 }, e: { x: 400, y: 300 } }))).toBe(0);
  });
  it('spacing is INERT (null) when no two wires share a corridor', () => {
    const d = design([n('a'), n('b')], [{ from: ['a', 'out'], to: ['b', 'in'] }]);
    expect(spacingPenalty(geo(d, { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }))).toBeNull();
  });
  it('merge is INERT (null) when no target is shared by ≥2 wires (a fan-OUT is not a fan-in)', () => {
    const d = design([n('a'), n('b'), n('c')], [
      { from: ['a', 'out'], to: ['b', 'in'] },
      { from: ['a', 'out'], to: ['c', 'in'] },
    ]);
    expect(mergePenalty(geo(d, { a: { x: 0, y: 200 }, b: { x: 400, y: 0 }, c: { x: 400, y: 400 } }))).toBeNull();
  });
  it('merge is active for a fan-in and stays LOW because the router converges late (near the target)', () => {
    const d = design([n('a'), n('b'), n('t')], [
      { from: ['a', 'out'], to: ['t', 'in'] },
      { from: ['b', 'out'], to: ['t', 'in'] },
    ]);
    const m = mergePenalty(geo(d, { a: { x: 0, y: 0 }, b: { x: 0, y: 300 }, t: { x: 600, y: 150 } }));
    expect(m).not.toBeNull();
    expect(m!).toBeGreaterThanOrEqual(0);
    expect(m!).toBeLessThan(0.5); // late merge ⇒ the shared run is a small fraction of the span
  });
  it('separationMetrics reports overlap / minGap / meanMergeDist in px on the routed geometry', () => {
    const d = design([n('a'), n('b'), n('t')], [
      { from: ['a', 'out'], to: ['t', 'in'] },
      { from: ['b', 'out'], to: ['t', 'in'] },
    ]);
    const s = separationMetrics(geo(d, { a: { x: 0, y: 0 }, b: { x: 0, y: 300 }, t: { x: 600, y: 150 } }));
    expect(s.overlapLen).toBeGreaterThanOrEqual(0);
    expect(s.meanMergeDist).toBeGreaterThanOrEqual(0);
  });
});

describe('scoreGeometry — aggregate + hard constraints', () => {
  it('renormalises away inert terms and yields a quality in [0,1] on a clean layout', () => {
    const d = design([n('a', 'client.web'), n('b', 'db.postgres')], [{ from: ['a', 'out'], to: ['b', 'in'] }]);
    const s = scoreGeometry(geo(d, { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }));
    expect(s.feasible).toBe(true);
    // no-group, single-wire ⇒ crossings + group are inert
    expect(s.penalties.group).toBeNull();
    expect(s.penalties.crossings).toBeNull();
    expect(s.quality).toBeGreaterThanOrEqual(0);
    expect(s.quality).toBeLessThanOrEqual(1);
    expect(s.score).toBe(s.quality);
  });
  it('flags H2 overlap as infeasible with score −∞', () => {
    const d = design([n('a'), n('b')]);
    const overlap: Placement = { a: { x: 0, y: 0 }, b: { x: 10, y: 10 } }; // boxes intersect
    const s = scoreGeometry(geo(d, overlap));
    expect(s.feasible).toBe(false);
    expect(s.hard.some((h) => h.constraint === 'H2')).toBe(true);
    expect(s.score).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('boxViolations — the route-free H2/H4 gate (R4d cheap-reject)', () => {
  // ONE implementation with the full check: hardViolations composes boxViolations verbatim, so the optimiser's
  // pre-route reject and the exact scorer read the SAME verdict — same entries, same order, same detail strings.
  // Drift here would let the search discard a candidate the scorer would have accepted (or vice versa), silently
  // changing the trajectory — this pins the two together.
  it('is EXACTLY the H2/H4 subset of hardViolations, in order, with identical details', () => {
    const d = design(
      [n('a'), n('b'), n('c'), n('d')],
      [{ from: ['a', 'out'], to: ['c', 'in'] }],
      [{ id: 'g', members: ['c'] }],
    );
    // a overlaps b (H2); d intrudes c's derived group box (H4, and an H2 against c as well).
    const p: Placement = { a: { x: 0, y: 0 }, b: { x: 40, y: 30 }, c: { x: 600, y: 0 }, d: { x: 620, y: 20 } };
    const g = geo(d, p);
    const box = boxViolations(g.nodes, g.groups);
    expect(box.some((h) => h.constraint === 'H2')).toBe(true);
    expect(box.some((h) => h.constraint === 'H4')).toBe(true);
    expect(box).toEqual(hardViolations(g).filter((h) => h.constraint !== 'H1'));
  });
  it('is empty on a clean layout — and so is the full check (no route can fake a box violation)', () => {
    const d = design([n('a'), n('b')], [{ from: ['a', 'out'], to: ['b', 'in'] }]);
    const g = geo(d, { a: { x: 0, y: 0 }, b: { x: 500, y: 0 } });
    expect(boxViolations(g.nodes, g.groups)).toEqual([]);
    expect(hardViolations(g)).toEqual([]);
  });
});
