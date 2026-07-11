import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  routeOrthogonalEdges,
  routeDesignEdges,
  canonicalRoute,
  auditDesignEdges,
  auditNeedlessBends,
  justifyBends,
  orthogonalPathD,
  pointAlongPolyline,
  simplifyOrthogonal,
  type Box,
  type Pos,
  type Anchor,
  type NodeGeom,
  type PortLike,
  type RouteRequest,
} from './edge-routing';

// A segment (orthogonal) passes through a box INTERIOR? (raw box, strict — the property the router must never violate.)
function segHitsInterior(p: Pos, q: Pos, b: Box): boolean {
  const L = b.x, R = b.x + b.w, T = b.y, B = b.y + b.h;
  if (p.y === q.y) { const y = p.y; if (!(y > T && y < B)) return false; const s = Math.min(p.x, q.x), e = Math.max(p.x, q.x); return s < R && L < e; }
  if (p.x === q.x) { const x = p.x; if (!(x > L && x < R)) return false; const s = Math.min(p.y, q.y), e = Math.max(p.y, q.y); return s < B && T < e; }
  // sample diagonals defensively (routed paths are orthogonal, so this should never trigger)
  for (let t = 0; t <= 1; t += 0.02) { const x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t; if (x > L && x < R && y > T && y < B) return true; }
  return false;
}
function pathHitsBox(points: readonly Pos[], b: Box): boolean {
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1];
    const q = points[i];
    if (p !== undefined && q !== undefined && segHitsInterior(p, q, b)) return true;
  }
  return false;
}
const isOrthogonal = (points: readonly Pos[]): boolean => {
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1];
    const q = points[i];
    if (p !== undefined && q !== undefined && p.x !== q.x && p.y !== q.y) return false;
  }
  return true;
};
/** Count 90° turns in a polyline. */
const bendCount = (points: readonly Pos[]): number => {
  let n = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = points[i - 1]!, p = points[i]!, p1 = points[i + 1]!;
    if (Math.sign(p.x - p0.x) !== Math.sign(p1.x - p.x) || Math.sign(p.y - p0.y) !== Math.sign(p1.y - p.y)) n++;
  }
  return n;
};
/** Shortest segment length (px) of a polyline. */
const minSegment = (points: readonly Pos[]): number => {
  let m = Infinity;
  for (let i = 1; i < points.length; i++) m = Math.min(m, Math.abs(points[i]!.x - points[i - 1]!.x) + Math.abs(points[i]!.y - points[i - 1]!.y));
  return m === Infinity ? 0 : m;
};

const port = (name: string, dir: 'in' | 'out' | 'bi') => ({ name, dir });

describe('routeOrthogonalEdges — obstacle avoidance', () => {
  // S ── (M blocks the straight line) ── T, all on the same row.
  const S: Box = { x: 0, y: 0, w: 160, h: 120 };
  const M: Box = { x: 240, y: 0, w: 160, h: 120 };
  const T: Box = { x: 480, y: 0, w: 160, h: 120 };
  const obstacles = [{ id: 'S', box: S }, { id: 'M', box: M }, { id: 'T', box: T }];
  const req = {
    id: 'e',
    a: { x: 160, y: 60, side: 'right' as const },
    b: { x: 480, y: 60, side: 'left' as const },
    avoid: ['S', 'T'],
  };

  it('routes AROUND a node that sits on the straight line (never through its interior)', () => {
    const routed = routeOrthogonalEdges(obstacles, [req]);
    const pts = routed.get('e');
    expect(pts).toBeDefined();
    expect(pathHitsBox(pts!, M)).toBe(false);
  });

  it('produces a strictly orthogonal polyline', () => {
    const pts = routeOrthogonalEdges(obstacles, [req]).get('e')!;
    expect(isOrthogonal(pts)).toBe(true);
  });

  it('starts at the source right anchor and ends at the target left anchor (port-side aware)', () => {
    const pts = routeOrthogonalEdges(obstacles, [req]).get('e')!;
    expect(pts[0]).toEqual({ x: 160, y: 60 });
    expect(pts[pts.length - 1]).toEqual({ x: 480, y: 60 });
  });

  it('is deterministic — identical input yields byte-identical geometry', () => {
    const a = routeOrthogonalEdges(obstacles, [req]).get('e')!;
    const b = routeOrthogonalEdges(obstacles, [req]).get('e')!;
    expect(a).toEqual(b);
    expect(orthogonalPathD(a)).toEqual(orthogonalPathD(b));
  });

  it('takes the minimal Z-route when nothing blocks (no gratuitous detours)', () => {
    const clear = [{ id: 'S', box: S }, { id: 'T', box: { x: 480, y: 200, w: 160, h: 120 } }];
    const pts = routeOrthogonalEdges(clear, [{ id: 'e', a: { x: 160, y: 60, side: 'right' }, b: { x: 480, y: 260, side: 'left' }, avoid: ['S', 'T'] }]).get('e')!;
    // both ports face horizontally (out=right, in=left); with a vertical offset the minimum is a Z: two bends,
    // four points. Assert we never exceed that (no wandering).
    let bends = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const p0 = pts[i - 1]!, p = pts[i]!, p1 = pts[i + 1]!;
      const dx0 = Math.sign(p.x - p0.x), dy0 = Math.sign(p.y - p0.y);
      const dx1 = Math.sign(p1.x - p.x), dy1 = Math.sign(p1.y - p.y);
      if (dx0 !== dx1 || dy0 !== dy1) bends++;
    }
    expect(bends).toBeLessThanOrEqual(2);
    expect(isOrthogonal(pts)).toBe(true);
  });
});

describe('routeDesignEdges — design-level convenience', () => {
  const nodes: NodeGeom[] = [
    { id: 'S', box: { x: 0, y: 0, w: 160, h: 120 }, ports: [port('out', 'out'), port('in', 'in')] },
    { id: 'M', box: { x: 240, y: 0, w: 160, h: 120 }, ports: [port('in', 'in'), port('out', 'out')] },
    { id: 'T', box: { x: 480, y: 0, w: 160, h: 120 }, ports: [port('in', 'in'), port('out', 'out')] },
  ];
  const wires = [{ from: ['S', 'out'] as const, to: ['T', 'in'] as const }];

  it('avoids the intervening node and returns a ready SVG path + on-wire label anchor', () => {
    const routes = routeDesignEdges({ nodes, wires });
    const r = routes.get(0);
    expect(r).toBeDefined();
    expect(pathHitsBox(r!.points, nodes[1]!.box)).toBe(false);
    expect(r!.d.startsWith('M ')).toBe(true);
    // the label anchor lies on the routed polyline (within a small tolerance), not on the naive straight line
    const onWire = r!.points.some((pt) => Math.abs(r!.label.x - pt.x) + Math.abs(r!.label.y - pt.y) < 300);
    expect(onWire).toBe(true);
  });

  it('spreads two edges leaving the same node across distinct port anchors (port-side aware fan-out)', () => {
    const fan: NodeGeom[] = [
      { id: 'S', box: { x: 0, y: 0, w: 160, h: 120 }, ports: [port('a', 'out'), port('b', 'out')] },
      { id: 'X', box: { x: 400, y: 0, w: 160, h: 120 }, ports: [port('in', 'in')] },
      { id: 'Y', box: { x: 400, y: 200, w: 160, h: 120 }, ports: [port('in', 'in')] },
    ];
    const routes = routeDesignEdges({ nodes: fan, wires: [{ from: ['S', 'a'], to: ['X', 'in'] }, { from: ['S', 'b'], to: ['Y', 'in'] }] });
    const ay = routes.get(0)!.points[0]!.y;
    const by = routes.get(1)!.points[0]!.y;
    expect(ay).not.toEqual(by); // two out ports leave at different heights
  });

  it('treats a real enclosing group as an obstacle but lets a wire ENTER it', () => {
    const g = { id: 'grp', rect: { x: 380, y: -20, w: 200, h: 360 }, members: ['X', 'Y'] };
    const withGroup: NodeGeom[] = [
      { id: 'A', box: { x: 0, y: 300, w: 160, h: 120 }, ports: [port('out', 'out')] },
      { id: 'X', box: { x: 400, y: 0, w: 160, h: 120 }, ports: [port('in', 'in'), port('out', 'out')] },
      { id: 'Y', box: { x: 400, y: 200, w: 160, h: 120 }, ports: [port('in', 'in')] },
    ];
    // A (outside) → Y (inside the group): must reach it (group is in the edge's avoid set), so a route exists.
    const routes = routeDesignEdges({ nodes: withGroup, wires: [{ from: ['A', 'out'], to: ['Y', 'in'] }], groups: [g] });
    expect(routes.get(0)).toBeDefined();
  });
});

describe('geometry helpers', () => {
  it('simplifyOrthogonal drops collinear midpoints', () => {
    expect(simplifyOrthogonal([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  });
  it('pointAlongPolyline returns the arc-length midpoint', () => {
    const mid = pointAlongPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 0.5);
    expect(mid).toEqual({ x: 10, y: 0 });
  });
  it('orthogonalPathD rounds corners (contains a quadratic segment)', () => {
    const d = orthogonalPathD([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }], 4);
    expect(d).toContain('Q');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// FAST PATH — the textbook canonical routes (straight / symmetric Z / L) drawn before A* touches the grid.
// ---------------------------------------------------------------------------------------------------------------
describe('canonical fast path — textbook geometry', () => {
  const right = (x: number, y: number): Anchor => ({ x, y, side: 'right' });
  const left = (x: number, y: number): Anchor => ({ x, y, side: 'left' });

  it('ALIGNED ports collapse to exactly ONE straight segment (no gratuitous Z)', () => {
    const pts = canonicalRoute([], { id: 'e', a: right(160, 60), b: left(480, 60), avoid: [] });
    expect(pts).toEqual([{ x: 160, y: 60 }, { x: 480, y: 60 }]);
    expect(bendCount(pts!)).toBe(0);
  });

  it('NEAR-aligned ports (≤ 4px) SNAP to one straight segment instead of a hair-thin staircase', () => {
    // The real cqrs client→gw case: 3px offset. Baseline made a 3px double-corner jog; the fast path snaps it flat.
    const pts = canonicalRoute([], { id: 'e', a: right(220, 268.5), b: left(400, 271.5), avoid: [] });
    expect(pts).toEqual([{ x: 220, y: 268.5 }, { x: 400, y: 268.5 }]);
    expect(bendCount(pts!)).toBe(0);
  });

  it('a vertical offset yields a 2-bend Z with the vertical at the SYMMETRIC midpoint x', () => {
    const pts = canonicalRoute([], { id: 'e', a: right(220, 260), b: left(460, 80), avoid: [] })!;
    expect(bendCount(pts)).toBe(2);
    expect(isOrthogonal(pts)).toBe(true);
    // both bends share the midpoint x = (220 + 460) / 2 = 340 (perfectly centered)
    const midX = (220 + 460) / 2;
    expect(pts[1]!.x).toBe(midX);
    expect(pts[2]!.x).toBe(midX);
    // the horizontal run out of the port equals the run into the target — the balanced look
    expect(pts[1]!.x - pts[0]!.x).toBe(pts[3]!.x - pts[2]!.x);
  });

  it('perpendicular ports (right → top) route as a single-bend L at the axis intersection', () => {
    const a: Anchor = { x: 160, y: 60, side: 'right' };
    const b: Anchor = { x: 320, y: 200, side: 'top' };
    const pts = canonicalRoute([], { id: 'e', a, b, avoid: [] })!;
    expect(bendCount(pts)).toBe(1);
    expect(pts).toEqual([{ x: 160, y: 60 }, { x: 320, y: 60 }, { x: 320, y: 200 }]);
  });

  it('returns undefined (defers to A*) when every canonical shape is blocked by an obstacle', () => {
    const M: Box = { x: 240, y: 0, w: 160, h: 120 };
    const blocked = canonicalRoute([{ id: 'M', box: M }], { id: 'e', a: right(160, 60), b: left(480, 60), avoid: [] });
    expect(blocked).toBeUndefined();
    // …but the full router still finds a clear path around M (A* fallback).
    const routed = routeOrthogonalEdges([{ id: 'M', box: M }], [{ id: 'e', a: right(160, 60), b: left(480, 60), avoid: [] }]).get('e')!;
    expect(pathHitsBox(routed, M)).toBe(false);
    expect(isOrthogonal(routed)).toBe(true);
  });

  it('an unblocked pair is drawn with ≤ 2 bends and no segment shorter than 8px', () => {
    const pts = canonicalRoute([], { id: 'e', a: right(220, 260), b: left(460, 80), avoid: [] })!;
    expect(bendCount(pts)).toBeLessThanOrEqual(2);
    expect(minSegment(pts)).toBeGreaterThanOrEqual(8);
  });

  it('is byte-identical across runs (determinism)', () => {
    const req = { id: 'e', a: right(220, 260), b: left(460, 80), avoid: [] };
    const a = canonicalRoute([], req)!;
    const b = canonicalRoute([], req)!;
    expect(a).toEqual(b);
    expect(orthogonalPathD(a)).toEqual(orthogonalPathD(b));
  });
});

describe('A*-result tidier — no staircase jogs', () => {
  it('straightens a 1–3px staircase left by two nearby grid lines (min segment ≥ 8px when a straight run is clear)', () => {
    // Stub (a.x+18) and this obstacle's clearance line (a.x-…) sit only a few px apart; the baseline stepped between
    // them. Force an A* route (blocker on the straight line) whose exit run would otherwise micro-jog, and assert the
    // tidier removed it — every segment is a real run, not a sliver.
    const S: Box = { x: 0, y: 0, w: 160, h: 120 };
    const M: Box = { x: 240, y: 40, w: 160, h: 200 };
    const T: Box = { x: 480, y: 0, w: 160, h: 120 };
    const obstacles = [{ id: 'S', box: S }, { id: 'M', box: M }, { id: 'T', box: T }];
    const pts = routeOrthogonalEdges(obstacles, [{ id: 'e', a: { x: 160, y: 60, side: 'right' }, b: { x: 480, y: 60, side: 'left' }, avoid: ['S', 'T'] }]).get('e')!;
    expect(pathHitsBox(pts, M)).toBe(false);
    expect(isOrthogonal(pts)).toBe(true);
    expect(minSegment(pts)).toBeGreaterThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// SEPARATION (R4, TASK-88) — the owner's traceability requirement: a fan-in onto one port must occupy DISTINCT
// tracks and converge only NEAR the target (as late as possible); a lone/aligned wire stays ONE straight line;
// every re-shape is re-validated so it never cuts a node.
// ---------------------------------------------------------------------------------------------------------------
describe('separation — late-merge fan-in, distinct tracks, lone edge untouched', () => {
  const right = (x: number, y: number): Anchor => ({ x, y, side: 'right' });
  const left = (x: number, y: number): Anchor => ({ x, y, side: 'left' });
  // Three sources fan into ONE target port at y=260; without separation all take the same mid-channel Z and pile up.
  const fanIn = (): Map<string, Pos[]> =>
    routeOrthogonalEdges([], [
      { id: 'w0', a: right(160, 60), b: left(600, 260), avoid: [] },
      { id: 'w1', a: right(160, 260), b: left(600, 260), avoid: [] },
      { id: 'w2', a: right(160, 460), b: left(600, 260), avoid: [] },
    ]);
  /** The x of a route's interior vertical jog (its own track), or null for a straight run. */
  const trackX = (pts: readonly Pos[]): number | null => {
    for (let i = 1; i + 2 < pts.length; i++) if (pts[i]!.x === pts[i + 1]!.x && pts[i]!.y !== pts[i + 1]!.y) return pts[i]!.x;
    return null;
  };

  it('routes the two offset fan-in members on DISTINCT vertical tracks (no line-on-line pile-up)', () => {
    const r = fanIn();
    const x0 = trackX(r.get('w0')!);
    const x2 = trackX(r.get('w2')!);
    expect(x0).not.toBeNull();
    expect(x2).not.toBeNull();
    expect(x0).not.toBe(x2); // each member gets its own track — not one shared line
  });

  it('keeps adjacent tracks at least the min gap apart', () => {
    const r = fanIn();
    expect(Math.abs(trackX(r.get('w0')!)! - trackX(r.get('w2')!)!)).toBeGreaterThanOrEqual(12); // default gap
  });

  it('converges LATE — the fan-in jogs sit near the TARGET, well past the mid-channel', () => {
    const r = fanIn();
    const midX = (160 + 600) / 2; // where the un-separated canonical Z would bend
    expect(trackX(r.get('w0')!)!).toBeGreaterThan(midX);
    expect(trackX(r.get('w2')!)!).toBeGreaterThan(midX);
  });

  it('leaves the ALIGNED member as ONE straight line (never staircased by separation)', () => {
    const r = fanIn();
    expect(r.get('w1')).toEqual([{ x: 160, y: 260 }, { x: 600, y: 260 }]);
  });

  it('leaves a LONE straight edge completely untouched (one segment in, one segment out)', () => {
    const r = routeOrthogonalEdges([], [{ id: 'e', a: right(160, 60), b: left(600, 60), avoid: [] }]);
    expect(r.get('e')).toEqual([{ x: 160, y: 60 }, { x: 600, y: 60 }]);
  });

  it('is deterministic — byte-identical geometry across runs', () => {
    expect(JSON.stringify([...fanIn()])).toEqual(JSON.stringify([...fanIn()]));
  });

  it('never cuts a non-endpoint node after re-shaping (H1 preserved — the re-shape re-validates)', () => {
    const M: Box = { x: 300, y: 200, w: 160, h: 120 }; // straddles the aligned member's row (y=260)
    const r = routeOrthogonalEdges([{ id: 'M', box: M }], [
      { id: 'w0', a: right(160, 60), b: left(600, 260), avoid: [] },
      { id: 'w1', a: right(160, 260), b: left(600, 260), avoid: [] },
      { id: 'w2', a: right(160, 460), b: left(600, 260), avoid: [] },
    ]);
    for (const id of ['w0', 'w1', 'w2']) {
      const pts = r.get(id);
      expect(pts, id).toBeDefined();
      expect(pathHitsBox(pts!, M), `${id} must not cut M`).toBe(false);
      expect(isOrthogonal(pts!), `${id} orthogonal`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// BEND JUSTIFICATION — the LAW (R6, owner ratification): every bend must be justified by obstacle clearance or
// shared-corridor separation. A wire alone at its anchors and corridor is always canonical; separation may only
// re-shape a wire that genuinely shares a door or a channel; the audit re-checks the same predicate the pass
// applies, so routed output always audits clean.
// ---------------------------------------------------------------------------------------------------------------
describe('bend justification — every bend earned (R6, the LAW)', () => {
  const right = (x: number, y: number): Anchor => ({ x, y, side: 'right' });
  const left = (x: number, y: number): Anchor => ({ x, y, side: 'left' });
  const OPTS = { clearance: 14, stub: 18, bendPenalty: 30, align: 4, jog: 10, gap: 12 } as const;

  it('a lone misaligned pair ships EXACTLY its canonical symmetric Z — separation and justification leave it alone (the owner cli_cmd→waf geometry)', () => {
    // The committed cqrs-production-large case at the canvas's measured heights: tops aligned at 58, heights 126 vs
    // 151 ⇒ port anchors 121 vs 133.5 (12.5px apart — outside the 4px snap). The lawful shape is the symmetric Z.
    const req: RouteRequest = { id: 'e', a: right(220, 121), b: left(380, 133.5), avoid: [] };
    const pts = routeOrthogonalEdges([], [req]).get('e')!;
    expect(pts).toEqual(canonicalRoute([], req));
    expect(bendCount(pts)).toBe(2);
    expect(pts[1]!.x).toBe(300); // the symmetric midpoint — not a Hanan grid line, not a separation stub
    expect(pts[2]!.x).toBe(300);
  });

  it('a fan-in member within the 4px snap of the shared row ships ONE straight segment — separation never manufactures a hair-thin step at the door', () => {
    const r = routeOrthogonalEdges([], [
      { id: 'w0', a: right(160, 60), b: left(600, 260), avoid: [] },
      { id: 'w1', a: right(160, 257), b: left(600, 260), avoid: [] }, // 3px off the shared row
    ]);
    expect(r.get('w1')).toEqual([{ x: 160, y: 257 }, { x: 600, y: 257 }]);
    expect(bendCount(r.get('w0')!)).toBe(2); // the offset member still jogs (its bend IS the separation)
  });

  it('replaces an unjustified detour with the canonical when the wire is alone at its corridor', () => {
    // Simulate a future re-shape gone wrong: hand the pass a 2-bend shape for a wire whose straight is clear+lone.
    const req: RouteRequest = { id: 'e', a: right(160, 60), b: left(600, 60), avoid: [] };
    const routes = new Map<string, Pos[]>([['e', [{ x: 160, y: 60 }, { x: 400, y: 60 }, { x: 400, y: 90 }, { x: 500, y: 90 }, { x: 500, y: 60 }, { x: 600, y: 60 }]]]);
    justifyBends(routes, [req], [], OPTS);
    expect(routes.get('e')).toEqual([{ x: 160, y: 60 }, { x: 600, y: 60 }]);
  });

  it('keeps the detour when the canonical would enter a corridor another wire occupies (separation-justified)', () => {
    // The same unjustified-looking shape, but the straight row is occupied by a parallel wire 6px away (< gap):
    // the corridor needs tracks, so the shipped shape stands — the LAW never re-creates a pile-up.
    const req: RouteRequest = { id: 'e', a: right(160, 60), b: left(600, 60), avoid: [] };
    const detour: Pos[] = [{ x: 160, y: 60 }, { x: 400, y: 60 }, { x: 400, y: 90 }, { x: 500, y: 90 }, { x: 500, y: 60 }, { x: 600, y: 60 }];
    const routes = new Map<string, Pos[]>([
      ['e', detour.map((p) => ({ ...p }))],
      ['neighbour', [{ x: 100, y: 66 }, { x: 700, y: 66 }]], // 6px under the straight row, spans overlapping
    ]);
    justifyBends(routes, [req], [], OPTS);
    expect(routes.get('e')).toEqual(detour);
    expect(auditNeedlessBends([], [req], routes)).toEqual([]); // and the audit agrees: that bend is JUSTIFIED
  });

  it('keeps an obstacle detour (canonical blocked ⇒ the bend is obstacle-justified) and audits it clean', () => {
    const M: Box = { x: 240, y: 0, w: 160, h: 120 };
    const req: RouteRequest = { id: 'e', a: right(160, 60), b: left(480, 60), avoid: [] };
    const obstacles = [{ id: 'M', box: M }];
    const routes = routeOrthogonalEdges(obstacles, [req]);
    expect(bendCount(routes.get('e')!)).toBeGreaterThan(0); // it detours
    expect(auditNeedlessBends(obstacles, [req], routes)).toEqual([]);
  });

  it('auditDesignEdges returns [] on routed design output (the pass runs to a fixpoint) — and is deterministic', () => {
    const nodes: NodeGeom[] = [
      { id: 'A', box: { x: 0, y: 0, w: 160, h: 126 }, ports: [port('out', 'out')] },
      { id: 'B', box: { x: 320, y: 0, w: 160, h: 151 }, ports: [port('in', 'in'), port('out', 'out')] },
      { id: 'C', box: { x: 640, y: 0, w: 160, h: 166 }, ports: [port('in', 'in')] },
      { id: 'D', box: { x: 320, y: 300, w: 160, h: 120 }, ports: [port('out', 'out')] },
    ];
    const wires = [
      { from: ['A', 'out'] as const, to: ['B', 'in'] as const },
      { from: ['B', 'out'] as const, to: ['C', 'in'] as const },
      { from: ['D', 'out'] as const, to: ['C', 'in'] as const },
    ];
    expect(auditDesignEdges({ nodes, wires })).toEqual([]);
    const a = routeDesignEdges({ nodes, wires });
    const b = routeDesignEdges({ nodes, wires });
    expect(JSON.stringify([...a])).toEqual(JSON.stringify([...b]));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// REGRESSION — the real CQRS design must route with ZERO node cuts and inside the interactive time budget.
// ---------------------------------------------------------------------------------------------------------------
describe('CQRS regression — 0 crossings, < 50ms', () => {
  type Raw = { instances: { id: string; type: string }[]; wires: { from: [string, string]; to: [string, string] }[]; layout: Record<string, { x: number; y: number }> };
  const raw = JSON.parse(readFileSync(new URL('../../../examples/cqrs.sda.json', import.meta.url), 'utf8')) as Raw;
  const portsOf = (): Map<string, PortLike[]> => {
    const acc = new Map<string, Map<string, 'in' | 'out' | 'bi'>>();
    const touch = (n: string, p: string, d: 'in' | 'out'): void => {
      const m = acc.get(n) ?? acc.set(n, new Map()).get(n)!;
      const cur = m.get(p);
      m.set(p, cur === undefined ? d : cur === d ? d : 'bi');
    };
    for (const w of raw.wires) { touch(w.from[0], w.from[1], 'out'); touch(w.to[0], w.to[1], 'in'); }
    const out = new Map<string, PortLike[]>();
    for (const inst of raw.instances) {
      const m = acc.get(inst.id) ?? new Map<string, 'in' | 'out' | 'bi'>();
      const ports: PortLike[] = [...m.entries()].map(([name, dir]) => ({ name, dir }));
      if (ports.length === 0) ports.push({ name: 'in', dir: 'in' }, { name: 'out', dir: 'out' });
      out.set(inst.id, ports);
    }
    return out;
  };
  const ports = portsOf();
  const nodes: NodeGeom[] = raw.instances
    .filter((i) => raw.layout[i.id] !== undefined)
    .map((i) => ({ id: i.id, box: { x: raw.layout[i.id]!.x, y: raw.layout[i.id]!.y, w: 160, h: 120 }, ports: ports.get(i.id) ?? [] }));
  const boxes = nodes.map((n) => ({ id: n.id, box: n.box }));

  it('routes every wire without cutting through a non-endpoint node, under 50ms', () => {
    const t0 = performance.now();
    const routed = routeDesignEdges({ nodes, wires: raw.wires });
    const ms = performance.now() - t0;
    let cuts = 0;
    raw.wires.forEach((w, i) => {
      const r = routed.get(i);
      if (r === undefined) return;
      for (const { id, box } of boxes) {
        if (id === w.from[0] || id === w.to[0]) continue;
        if (pathHitsBox(r.points, box)) cuts++;
      }
    });
    expect(cuts).toBe(0);
    expect(ms).toBeLessThan(50);
  });
});
