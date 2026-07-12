// @algorithm Hanan-grid A* orthogonal edge router (route, separate, justify)
// @problem Draw right-angle wires that avoid every node/group box, share doors and corridors legibly,
//   and carry no needless bends — the draw.io / libavoid capability, without shipping LGPL code in an
//   MIT project.
// @approach Per edge, a Hanan-grid A*: candidate turning lines one clearance outside every obstacle
//   plus the edge's own stubs; states are (grid point, heading) with a per-90-degree bend penalty and
//   a total-ordered priority queue. Then two whole-design passes: separateEdges staggers shared doors
//   and nudges corridor tracks; justifyBends re-tries every non-canonical bend against final geometry
//   and keeps it only if an obstacle or shared corridor forces it (the R6 law, audited).
// @complexity Per edge O(G log G) for G = O(n^2) Hanan grid vertices (x 4 headings) over n obstacles;
//   separation/justification are near-linear in routed segments.
// @citations Hart, Nilsson & Raphael 1968 (A*); Hanan 1966 (the Hanan grid); libavoid /
//   draw.io orthogonal routing as the reference capability (re-implemented, no code reuse).
// @invariants Deterministic (fixed neighbor order, total-ordered queue, no randomness); every shipped
//   segment clears obstacle interiors at clearance; an edge's own endpoints/groups are never its
//   obstacles; every shipped bend is justified (obstacle- or corridor-forced) per auditNeedlessBends.
// @where-tested app/presenter/src/edge-routing.test.ts, app/presenter/src/layout-benchmark.test.ts
//   (the benchmark gate audits needless bends on every committed example)

// Orthogonal edge routing ("smart edges") — a dependency-free, deterministic A* connector router that draws
// right-angle wires which AVOID node (and tidied-group) bounding boxes, the way draw.io / C4 tools and React
// Flow Pro's paid "avoid-nodes" example do. RF Pro's example wraps libavoid (LGPL C++→WASM); we cannot ship
// LGPL in an MIT project, so this is the SAME CAPABILITY re-implemented in pure TypeScript — no new dependency,
// no WASM, no license entanglement, and shell-agnostic so both shells (web + VS Code webview) route identically.
//
// PURITY: this module imports nothing but ONE pure local function — `portAnchorOffset` from layout-model, the
// shared port-anchor geometry (itself dependency-free: assigned offset when the R5 slide set one, else the
// fraction), so the router, the renderer and the layout family anchor wires from the SAME formula and can never
// drift (R5 port-centric alignment + port sliding). That keeps it (a) unit-testable in isolation, (b)
// runnable by Node's type-stripping for the offline SVG previews, and (c) shareable by every shell via the
// presenter, so a wire is routed the same everywhere (web-is-a-dumb-renderer / anti-drift).
//
// ALGORITHM: a Hanan-grid A*. For each edge we consider only the O(nodes) candidate turning coordinates — the
// lines a clearance-margin OUTSIDE every obstacle, plus the edge's own exit/entry stubs — and search that small
// grid for the fewest-bend orthogonal path whose every segment clears all obstacle interiors. Deterministic
// (fixed neighbour order + total-ordered priority queue; no randomness). The edge's own endpoints (and any group
// that contains an endpoint) are excluded from its obstacle set, because a wire MUST be allowed to leave its
// source and enter its target (and cross its own group's boundary).
//
// THREE STAGES, one law. 1) ROUTE each wire independently (canonical fast path, else grid A*). 2) SEPARATE the
// shared doors and corridors ({@link separateEdges} — late-merge/early-split staggering + track nudging).
// 3) JUSTIFY every bend ({@link justifyBends} — R6, the owner's LAW): a shipped bend exists only because an
// OBSTACLE blocks the canonical shape or because a SHARED CORRIDOR needs distinct tracks; any other deviation
// from the canonical straight/Z/L is re-tried against the final geometry and replaced. {@link auditNeedlessBends}
// re-checks the same predicate, so the router's output is auditable — and audited, by the benchmark gate, on
// every committed example.

import { portAnchorOffset, type NodePortOffsets } from './layout-model';

export type Pos = { readonly x: number; readonly y: number };
/** An axis-aligned box in flow (canvas) coordinates: top-left corner + size. */
export type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
/** Which side of a node an anchor leaves/enters from. Our nodes emit on the RIGHT (out ports) and accept on the
 *  LEFT (in ports); the router supports all four so it stays general if the node model ever gains top/bottom. */
export type Side = 'left' | 'right' | 'top' | 'bottom';
/** A routed endpoint: the exact point on a node's boundary + the side it faces (so the stub leaves outward). */
export type Anchor = Pos & { readonly side: Side };

/** One edge to route: its id, the two boundary anchors, and the obstacle ids to IGNORE for this edge (its own
 *  endpoints + any group boxes containing them). */
export type RouteRequest = {
  readonly id: string;
  readonly a: Anchor;
  readonly b: Anchor;
  readonly avoid: readonly string[];
};

/** Router knobs. All optional; the defaults are tuned for our 160px nodes. */
export type RouteOptions = {
  /** Empty gap kept around every obstacle (px). Also the grid-line offset. Default 14. */
  readonly clearance?: number;
  /** How far the wire runs straight out of a port before it may turn (px). Default 18. */
  readonly stub?: number;
  /** Cost added per 90° turn, so the search prefers few bends (a clean look). Default 30. */
  readonly bendPenalty?: number;
  /** Port-alignment snap tolerance (px): two facing ports within this Δ are treated as aligned and joined by ONE
   *  straight segment (no gratuitous 1–4px Z). Also the max jog collapsed by the A*-result tidier. Default 4. */
  readonly align?: number;
  /** Max length (px) of a staircase jog the A*-result post-processor will straighten away when the merged run
   *  stays obstacle-free. Kills the 1–8px steps two nearby grid lines otherwise leave behind. Default 10. */
  readonly jog?: number;
  /** Parallel-track separation gap (px): the SEPARATION pass ({@link separateEdges}) keeps wires that share a
   *  corridor at least this far apart, and staggers a fan-in/fan-out bundle by this pitch so its members converge
   *  only at the shared stub (the owner's "as late as possible"). Default 12. */
  readonly gap?: number;
};

const DEFAULTS = { clearance: 14, stub: 18, bendPenalty: 30, align: 4, jog: 10, gap: 12 } as const;

type Obstacle = { readonly id: string; readonly box: Box };

// ---------------------------------------------------------------------------------------------------------------
// Geometry helpers (exported: FlowEdge and the offline preview both build the SVG path + label anchor from these).
// ---------------------------------------------------------------------------------------------------------------

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Drop a middle point that lies on the straight run between its neighbours (collinear on x or on y). */
export function simplifyOrthogonal(points: readonly Pos[]): Pos[] {
  if (points.length <= 2) return points.slice();
  const first = points[0];
  if (first === undefined) return points.slice();
  const out: Pos[] = [first];
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = out[out.length - 1];
    const p = points[i];
    const p1 = points[i + 1];
    if (p0 === undefined || p === undefined || p1 === undefined) continue;
    const collinear = (p0.x === p.x && p.x === p1.x) || (p0.y === p.y && p.y === p1.y);
    if (!collinear) out.push(p);
  }
  const last = points[points.length - 1];
  if (last !== undefined) out.push(last);
  return out;
}

/** An SVG path with softly-rounded right-angle corners (radius `r`), matching the getSmoothStepPath look the
 *  canvas used before. Radius is clamped to half of each adjacent segment so short segments stay crisp. */
export function orthogonalPathD(points: readonly Pos[], r = 4): string {
  const pts = simplifyOrthogonal(points);
  const first = pts[0];
  if (first === undefined) return '';
  if (pts.length === 1) return `M ${r2(first.x)} ${r2(first.y)}`;
  let d = `M ${r2(first.x)} ${r2(first.y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1];
    const p = pts[i];
    const p1 = pts[i + 1];
    if (p0 === undefined || p === undefined || p1 === undefined) continue;
    const inLen = Math.hypot(p.x - p0.x, p.y - p0.y);
    const outLen = Math.hypot(p1.x - p.x, p1.y - p.y);
    const rr = Math.max(0, Math.min(r, inLen / 2, outLen / 2));
    if (rr === 0) {
      d += ` L ${r2(p.x)} ${r2(p.y)}`;
      continue;
    }
    const ax = p.x - Math.sign(p.x - p0.x) * rr;
    const ay = p.y - Math.sign(p.y - p0.y) * rr;
    const bx = p.x + Math.sign(p1.x - p.x) * rr;
    const by = p.y + Math.sign(p1.y - p.y) * rr;
    d += ` L ${r2(ax)} ${r2(ay)} Q ${r2(p.x)} ${r2(p.y)} ${r2(bx)} ${r2(by)}`;
  }
  const last = pts[pts.length - 1];
  if (last !== undefined) d += ` L ${r2(last.x)} ${r2(last.y)}`;
  return d;
}

/** The point at fraction `frac` (0..1) of the polyline's arc length — used to anchor a mid-edge label / pill so
 *  it sits ON the routed wire rather than on the naive straight line. */
export function pointAlongPolyline(points: readonly Pos[], frac: number): Pos {
  const first = points[0];
  if (first === undefined) return { x: 0, y: 0 };
  if (points.length === 1) return first;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) continue;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  let target = total * Math.min(1, Math.max(0, frac));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) continue;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg >= target) {
      const t = seg === 0 ? 0 : target / seg;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    target -= seg;
  }
  return points[points.length - 1] ?? first;
}

// ---------------------------------------------------------------------------------------------------------------
// The A* core.
// ---------------------------------------------------------------------------------------------------------------

/** Does the axis-aligned segment (x0,y0)–(x1,y1) pass through the INTERIOR of any obstacle (inflated by `m`)?
 *  Strict inequalities on the perpendicular axis, so a segment running exactly along an inflated boundary — the
 *  whole point of the Hanan grid — is allowed; only a segment that truly enters an obstacle is blocked. */
function segmentBlocked(x0: number, y0: number, x1: number, y1: number, obstacles: readonly Obstacle[], avoid: ReadonlySet<string>, m: number): boolean {
  const horizontal = y0 === y1;
  for (const o of obstacles) {
    if (avoid.has(o.id)) continue;
    const L = o.box.x - m;
    const R = o.box.x + o.box.w + m;
    const T = o.box.y - m;
    const B = o.box.y + o.box.h + m;
    if (horizontal) {
      if (!(y0 > T && y0 < B)) continue;
      const sx = Math.min(x0, x1);
      const ex = Math.max(x0, x1);
      if (sx < R && L < ex) return true;
    } else {
      if (!(x0 > L && x0 < R)) continue;
      const sy = Math.min(y0, y1);
      const ey = Math.max(y0, y1);
      if (sy < B && T < ey) return true;
    }
  }
  return false;
}

/** A stub point: `stub` px outside the anchor along its facing side (the wire always leaves a port straight). */
function stubPoint(a: Anchor, stub: number): Pos {
  switch (a.side) {
    case 'right': return { x: a.x + stub, y: a.y };
    case 'left': return { x: a.x - stub, y: a.y };
    case 'bottom': return { x: a.x, y: a.y + stub };
    case 'top': return { x: a.x, y: a.y - stub };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// FAST PATH — canonical "textbook" routes tried BEFORE the grid A*.
// On a simple diagram a wire wants one of three shapes: a STRAIGHT line (ports aligned), the classic 2-bend Z
// (out-run → vertical at the SYMMETRIC midpoint → in-run), or an L (1 bend, for perpendicular ports). If a
// canonical shape is obstacle-free (with clearance) we draw it directly — no grid, so the bend sits at the clean
// midpoint instead of clustering on a Hanan grid-line. This alone makes the common case read as a C4/draw.io
// diagram. Only when every canonical shape is blocked do we fall back to A*.
// ---------------------------------------------------------------------------------------------------------------

type Vec = readonly [number, number];
/** Outward unit normal of a node side (the direction a wire must leave/approach along). */
function outward(side: Side): Vec {
  switch (side) {
    case 'right': return [1, 0];
    case 'left': return [-1, 0];
    case 'bottom': return [0, 1];
    case 'top': return [0, -1];
  }
}
/** True when the side faces horizontally (a wire leaves/enters it along X). */
const horizontalSide = (side: Side): boolean => side === 'left' || side === 'right';

/** The unit direction of the first (last) non-degenerate segment of a polyline, or undefined if it has none. */
function endDirection(points: readonly Pos[], from: 'start' | 'end'): Vec | undefined {
  if (from === 'start') {
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1];
      const q = points[i];
      if (p === undefined || q === undefined) continue;
      if (p.x !== q.x || p.y !== q.y) return [Math.sign(q.x - p.x), Math.sign(q.y - p.y)];
    }
  } else {
    for (let i = points.length - 1; i >= 1; i--) {
      const p = points[i - 1];
      const q = points[i];
      if (p === undefined || q === undefined) continue;
      if (p.x !== q.x || p.y !== q.y) return [Math.sign(q.x - p.x), Math.sign(q.y - p.y)];
    }
  }
  return undefined;
}

/** Is every segment of `points` axis-aligned AND clear of every (non-avoided) obstacle interior, inflated by `m`? */
function segmentsClear(points: readonly Pos[], obstacles: readonly Obstacle[], avoid: ReadonlySet<string>, m: number): boolean {
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1];
    const q = points[i];
    if (p === undefined || q === undefined) return false;
    if (p.x !== q.x && p.y !== q.y) return false; // not orthogonal — reject
    if (segmentBlocked(p.x, p.y, q.x, q.y, obstacles, avoid, m)) return false;
  }
  return true;
}

/** Try the canonical shapes in priority order (straight → Z → L). Returns the first clear one, or undefined so the
 *  caller falls back to A*. The endpoints leave/enter along their port sides; a near-aligned pair is SNAPPED so it
 *  yields one straight segment rather than a needless hair-thin Z. */
function tryCanonical(req: RouteRequest, obstacles: readonly Obstacle[], opts: Required<RouteOptions>): Pos[] | undefined {
  const { a, b } = req;
  const avoid = new Set(req.avoid);
  const oa = outward(a.side);
  const ob = outward(b.side);
  const wantFirst: Vec = oa; // first segment leaves a along its outward normal
  const wantLast: Vec = [-ob[0], -ob[1]]; // last segment arrives at b from outside (opposite b's normal)
  const aH = horizontalSide(a.side);
  const bH = horizontalSide(b.side);
  const candidates: Pos[][] = [];

  if (aH && bH) {
    // Both ports face horizontally (our client→…→db case): STRAIGHT if aligned, else a Z with a vertical mid-run.
    const dir = Math.sign(b.x - a.x);
    if (Math.abs(a.y - b.y) <= opts.align && dir !== 0 && dir === wantFirst[0] && dir === wantLast[0]) {
      candidates.push([{ x: a.x, y: a.y }, { x: b.x, y: a.y }]); // snap target's Y onto the source row
    }
    const midX = (a.x + b.x) / 2;
    if (Math.sign(midX - a.x) === wantFirst[0] && Math.sign(b.x - midX) === wantLast[0]) {
      candidates.push([{ x: a.x, y: a.y }, { x: midX, y: a.y }, { x: midX, y: b.y }, { x: b.x, y: b.y }]);
    }
  } else if (!aH && !bH) {
    // Both ports face vertically: mirror of the above about the diagonal.
    const dir = Math.sign(b.y - a.y);
    if (Math.abs(a.x - b.x) <= opts.align && dir !== 0 && dir === wantFirst[1] && dir === wantLast[1]) {
      candidates.push([{ x: a.x, y: a.y }, { x: a.x, y: b.y }]); // snap target's X onto the source column
    }
    const midY = (a.y + b.y) / 2;
    if (Math.sign(midY - a.y) === wantFirst[1] && Math.sign(b.y - midY) === wantLast[1]) {
      candidates.push([{ x: a.x, y: a.y }, { x: a.x, y: midY }, { x: b.x, y: midY }, { x: b.x, y: b.y }]);
    }
  } else {
    // Perpendicular ports: the single-corner L. Corner is where the two port axes meet.
    const corner: Pos = aH ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    candidates.push([{ x: a.x, y: a.y }, corner, { x: b.x, y: b.y }]);
  }

  for (const c of candidates) {
    const pts = simplifyOrthogonal(c);
    if (pts.length < 2) continue;
    const fd = endDirection(pts, 'start');
    const ld = endDirection(pts, 'end');
    if (fd === undefined || ld === undefined) continue;
    if (fd[0] !== wantFirst[0] || fd[1] !== wantFirst[1]) continue;
    if (ld[0] !== wantLast[0] || ld[1] !== wantLast[1]) continue;
    if (!segmentsClear(pts, obstacles, avoid, opts.clearance)) continue;
    return pts;
  }
  return undefined;
}

/** Straighten staircase jogs out of an A* polyline: where a short (≤ `jog`) middle segment steps a run sideways
 *  and the merged run stays obstacle-free, collapse it. Endpoints (the real anchors) never move. Deterministic —
 *  scans left-to-right, applies the first legal collapse, repeats to a fixed point. */
function removeJogs(points: readonly Pos[], obstacles: readonly Obstacle[], avoid: ReadonlySet<string>, opts: Required<RouteOptions>): Pos[] {
  let pts = points.slice();
  for (let guard = 0; guard <= pts.length + 4; guard++) {
    let collapsed = false;
    for (let i = 1; i + 2 < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2];
      if (p0 === undefined || p1 === undefined || p2 === undefined || p3 === undefined) continue;
      const midLen = Math.abs(p2.x - p1.x) + Math.abs(p2.y - p1.y);
      if (midLen === 0 || midLen > opts.jog) continue;
      const outerHoriz = p0.y === p1.y && p2.y === p3.y && p1.x === p2.x; // ── │ ── stepping vertically
      const outerVert = p0.x === p1.x && p2.x === p3.x && p1.y === p2.y; // │ ── │ stepping horizontally
      if (!outerHoriz && !outerVert) continue;
      const run1Anchored = i - 1 === 0;
      const run2Anchored = i + 2 === pts.length - 1;
      const trials: Pos[][] = [];
      if (!run2Anchored) {
        // Move the second run onto the first run's level (anchor at p0 stays put).
        const t = pts.slice();
        t[i + 1] = outerHoriz ? { x: p2.x, y: p0.y } : { x: p0.x, y: p2.y };
        t[i + 2] = outerHoriz ? { x: p3.x, y: p0.y } : { x: p0.x, y: p3.y };
        trials.push(t);
      }
      if (!run1Anchored) {
        // Move the first run onto the second run's level (anchor at p3 stays put).
        const t = pts.slice();
        t[i - 1] = outerHoriz ? { x: p0.x, y: p3.y } : { x: p3.x, y: p0.y };
        t[i] = outerHoriz ? { x: p1.x, y: p3.y } : { x: p3.x, y: p1.y };
        trials.push(t);
      }
      for (const t of trials) {
        if (segmentsClear(t, obstacles, avoid, opts.clearance)) {
          pts = simplifyOrthogonal(t);
          collapsed = true;
          break;
        }
      }
      if (collapsed) break;
    }
    if (!collapsed) break;
  }
  return pts;
}

const sortedUnique = (values: readonly number[]): number[] => {
  const s = [...new Set(values.map((v) => Math.round(v * 100) / 100))];
  s.sort((p, q) => p - q);
  return s;
};

/** A binary min-heap over grid-node records, totally ordered by (f, g, seq) so ties break deterministically. */
type HeapItem = { readonly node: number; readonly f: number; readonly g: number; readonly seq: number };
class MinHeap {
  private readonly items: HeapItem[] = [];
  get size(): number { return this.items.length; }
  private less(a: HeapItem, b: HeapItem): boolean { return a.f < b.f || (a.f === b.f && (a.g < b.g || (a.g === b.g && a.seq < b.seq))); }
  push(item: HeapItem): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const ai = a[i];
      const ap = a[parent];
      if (ai !== undefined && ap !== undefined && this.less(ai, ap)) { a[i] = ap; a[parent] = ai; i = parent; } else break;
    }
  }
  pop(): HeapItem | undefined {
    const a = this.items;
    const top = a[0];
    if (top === undefined) return undefined;
    const last = a.pop();
    if (last !== undefined && a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        const as = a[smallest];
        const al = a[l];
        if (al !== undefined && as !== undefined && this.less(al, as)) smallest = l;
        const asSmall = a[smallest];
        const ar = a[r];
        if (ar !== undefined && asSmall !== undefined && this.less(ar, asSmall)) smallest = r;
        if (smallest === i) break;
        const ai = a[i];
        const asm = a[smallest];
        if (ai === undefined || asm === undefined) break;
        a[i] = asm;
        a[smallest] = ai;
        i = smallest;
      }
    }
    return top;
  }
}

/** Route ONE request over its Hanan grid. Returns the full polyline (anchor a … anchor b) or `undefined` if no
 *  clear orthogonal path exists (the caller then falls back to a naive edge, never a lie). */
function routeOne(req: RouteRequest, obstacles: readonly Obstacle[], opts: Required<RouteOptions>): Pos[] | undefined {
  const avoid = new Set(req.avoid);
  // FAST PATH: a clean straight / Z / L, drawn directly if unobstructed — the common simple-diagram case never
  // touches the grid (so its bend lands on the symmetric midpoint, not a Hanan grid-line).
  const canonical = tryCanonical(req, obstacles, opts);
  if (canonical !== undefined) return canonical;

  const sa = stubPoint(req.a, opts.stub);
  const sb = stubPoint(req.b, opts.stub);

  // Candidate turning lines: a clearance outside every obstacle, plus this edge's stub coordinates.
  const xsRaw: number[] = [sa.x, sb.x];
  const ysRaw: number[] = [sa.y, sb.y];
  for (const o of obstacles) {
    if (avoid.has(o.id)) continue;
    xsRaw.push(o.box.x - opts.clearance, o.box.x + o.box.w + opts.clearance);
    ysRaw.push(o.box.y - opts.clearance, o.box.y + o.box.h + opts.clearance);
  }
  const xs = sortedUnique(xsRaw);
  const ys = sortedUnique(ysRaw);
  const nx = xs.length;
  const ny = ys.length;
  const xIndex = new Map(xs.map((v, i) => [v, i] as const));
  const yIndex = new Map(ys.map((v, i) => [v, i] as const));

  const startXi = xIndex.get(Math.round(sa.x * 100) / 100);
  const startYi = yIndex.get(Math.round(sa.y * 100) / 100);
  const goalXi = xIndex.get(Math.round(sb.x * 100) / 100);
  const goalYi = yIndex.get(Math.round(sb.y * 100) / 100);
  if (startXi === undefined || startYi === undefined || goalXi === undefined || goalYi === undefined) return undefined;

  const id = (xi: number, yi: number): number => xi * ny + yi;
  const startId = id(startXi, startYi);
  const goalId = id(goalXi, goalYi);

  const goalX = xs[goalXi];
  const goalY = ys[goalYi];
  const startX = xs[startXi];
  const startY = ys[startYi];
  if (goalX === undefined || goalY === undefined || startX === undefined || startY === undefined) return undefined;

  const gScore = new Float64Array(nx * ny).fill(Infinity);
  const cameFrom = new Int32Array(nx * ny).fill(-1);
  const closed = new Uint8Array(nx * ny);
  gScore[startId] = 0;

  const heuristic = (x: number, y: number): number => Math.abs(x - goalX) + Math.abs(y - goalY);
  const heap = new MinHeap();
  let seq = 0;
  heap.push({ node: startId, f: heuristic(startX, startY), g: 0, seq: seq++ });

  // Neighbour deltas in a FIXED order → deterministic expansion.
  const deltas: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  while (heap.size > 0) {
    const cur = heap.pop();
    if (cur === undefined) break;
    if (closed[cur.node]) continue;
    closed[cur.node] = 1;
    if (cur.node === goalId) break;
    const cxi = Math.floor(cur.node / ny);
    const cyi = cur.node % ny;
    const cx = xs[cxi];
    const cy = ys[cyi];
    if (cx === undefined || cy === undefined) continue;
    const prev = cameFrom[cur.node] ?? -1;
    // Direction we arrived from (to charge a bend when we now turn).
    let inDx = 0;
    let inDy = 0;
    if (prev >= 0) { inDx = Math.sign(cxi - Math.floor(prev / ny)); inDy = Math.sign(cyi - (prev % ny)); }
    for (const [dxi, dyi] of deltas) {
      const nxi = cxi + dxi;
      const nyi = cyi + dyi;
      if (nxi < 0 || nxi >= nx || nyi < 0 || nyi >= ny) continue;
      const nId = id(nxi, nyi);
      if (closed[nId]) continue;
      const nX = xs[nxi];
      const nY = ys[nyi];
      if (nX === undefined || nY === undefined) continue;
      if (segmentBlocked(cx, cy, nX, nY, obstacles, avoid, opts.clearance)) continue;
      const stepLen = Math.abs(nX - cx) + Math.abs(nY - cy);
      const turned = (inDx !== 0 || inDy !== 0) && (Math.sign(dxi) !== inDx || Math.sign(dyi) !== inDy);
      const tentative = cur.g + stepLen + (turned ? opts.bendPenalty : 0);
      if (tentative < (gScore[nId] ?? Infinity)) {
        gScore[nId] = tentative;
        cameFrom[nId] = cur.node;
        heap.push({ node: nId, f: tentative + heuristic(nX, nY), g: tentative, seq: seq++ });
      }
    }
  }

  if ((cameFrom[goalId] ?? -1) < 0 && goalId !== startId) return undefined;
  // Reconstruct grid path start→goal.
  const grid: Pos[] = [];
  let n = goalId;
  const guard = nx * ny + 2;
  for (let i = 0; i <= guard; i++) {
    const xi = Math.floor(n / ny);
    const yi = n % ny;
    const gx = xs[xi];
    const gy = ys[yi];
    if (gx === undefined || gy === undefined) break;
    grid.push({ x: gx, y: gy });
    if (n === startId) break;
    n = cameFrom[n] ?? -1;
    if (n < 0) return undefined;
  }
  grid.reverse();
  // Full wire: the real anchor (as a plain point — the `side` tag stays on the request, not the geometry), the
  // stub run, the routed interior, the target stub, the real anchor. Then TIDY it: merge collinear runs and
  // straighten the 1–8px staircases two nearby grid-lines leave behind (never moving the anchors, never crossing
  // an obstacle — each collapse is re-validated for clearance).
  const raw = simplifyOrthogonal([{ x: req.a.x, y: req.a.y }, ...grid, { x: req.b.x, y: req.b.y }]);
  return removeJogs(raw, obstacles, avoid, opts);
}

/** The FAST PATH in isolation: the canonical straight/Z/L route for one request if one is obstacle-free, else
 *  undefined (meaning the full router would fall back to grid A*). Exposed so tools can measure the fast-path
 *  hit-rate and tests can assert the textbook geometry directly. Pure and deterministic. */
export function canonicalRoute(obstacles: readonly Obstacle[], req: RouteRequest, options?: RouteOptions): Pos[] | undefined {
  return tryCanonical(req, obstacles, { ...DEFAULTS, ...options });
}

// ---------------------------------------------------------------------------------------------------------------
// SEPARATION — "route, then order and nudge apart the connectors in shared segments" (Wybrow, Marriott & Stuckey,
// "Orthogonal Connector Routing", GD 2009 — libavoid's final stage, the LGPL step React-Flow-Pro wraps, here in
// pure TS). The owner field-tested the IDEAL layout and ruled it WORSE than Tidy: it "packs tighter AND overlaps
// lines more," against his aesthetic — "each line traceable by eye from source almost to target; separate
// corridors; edges may converge only near the shared destination port, AS LATE AS POSSIBLE." routeOne() routes each
// wire INDEPENDENTLY, so a fan-in of N wires into one store all take the same canonical Z through the same mid-
// channel and pile onto each other. This pass fixes that with two mechanisms grounded in production routers:
//
//   • LATE-MERGE / EARLY-SPLIT staggering (yFiles bus stubs; the opposite of graphviz `concentrate`). A bundle of
//     wires sharing a TARGET port is re-shaped so each runs on its own source row almost to the target and jogs to
//     the port only within a staggered stub distance — they converge as LATE as possible. A bundle sharing a
//     SOURCE port splits EARLY (mirror). The stagger pitch is `gap`, so members land on distinct tracks.
//   • TRACK ASSIGNMENT for any remaining shared vertical corridor (the left-edge idea, Hashimoto & Stevens 1971;
//     nudged apart by `gap`, the yFiles/ELK minimum edge-edge distance).
//
// SAFETY. Every re-shape / nudge is RE-VALIDATED against the obstacle set (its own endpoints excluded) and KEPT only
// if it stays clear — else the original route stands. So separation can never introduce a node cut (H1) and never
// makes a route worse than the independent one it started from. Anchors never move (a bundle still meets its ports).
// A LONE wire shares no anchor and no corridor ⇒ it is untouched: a straight edge stays ONE straight line. Pure and
// deterministic (bundles built in request order; every tie broken by id).
// ---------------------------------------------------------------------------------------------------------------

const rk = (n: number): number => Math.round(n * 100) / 100;
/** A stagger track index for member `r` centred on 0: 0, then +1,−1 alternating — so a bundle spreads symmetrically
 *  about the un-staggered line rather than drifting to one side. (0,1,2,3 → 0,+1,−1,+2 …) */
const trackOffset = (r: number): number => (r === 0 ? 0 : r % 2 === 1 ? (r + 1) / 2 : -r / 2);

/** True when both anchors face horizontally (out the right, in the left) — the only orientation the staggered-Z
 *  re-shape is defined for (our node model). Perpendicular / vertical-port bundles keep their independent routes. */
const horizontalPair = (a: Anchor, b: Anchor): boolean => horizontalSide(a.side) && horizontalSide(b.side);

/** A single-jog route a → (jx,ay) → (jx,by) → b, simplified. `jx` is where the vertical sits: near the target for a
 *  late fan-in merge, near the source for an early fan-out split. A member whose free end sits within the router's
 *  `align` snap of the shared row needs NO jog to converge — the straight-with-snap (the SAME 4px law the canonical
 *  fast path applies) is tried first, so separation never manufactures the hair-thin two-corner step the canonical
 *  route would not draw (R6, the bend-justification LAW). Returns the polyline or undefined if `jx` leaves no room
 *  to leave the source / reach the target, or the shape would not leave/enter along the port sides. */
function staggeredZ(a: Anchor, b: Anchor, jx: number, obstacles: readonly Obstacle[], avoid: ReadonlySet<string>, opts: Required<RouteOptions>): Pos[] | undefined {
  const wantFirst = outward(a.side);
  const wantLast: Vec = [-outward(b.side)[0], -outward(b.side)[1]];
  const candidates: Pos[][] = [];
  if (Math.abs(a.y - b.y) <= opts.align) candidates.push([{ x: a.x, y: a.y }, { x: b.x, y: a.y }]); // snap: straight
  // jx must sit strictly between the two port stubs so the wire leaves a and enters b along their outward normals.
  if (Math.sign(jx - a.x) === wantFirst[0] && Math.sign(b.x - jx) === wantLast[0]) {
    candidates.push([{ x: a.x, y: a.y }, { x: jx, y: a.y }, { x: jx, y: b.y }, { x: b.x, y: b.y }]);
  }
  for (const c of candidates) {
    const pts = simplifyOrthogonal(c);
    if (pts.length < 2) continue;
    const fd = endDirection(pts, 'start');
    const ld = endDirection(pts, 'end');
    if (fd === undefined || ld === undefined) continue;
    if (fd[0] !== wantFirst[0] || fd[1] !== wantFirst[1]) continue;
    if (ld[0] !== wantLast[0] || ld[1] !== wantLast[1]) continue;
    if (!segmentsClear(pts, obstacles, avoid, opts.clearance)) continue;
    return pts;
  }
  return undefined;
}

/** Group routed request ids by an anchor key (target or source), preserving request order, keeping only bundles of
 *  ≥ 2 that face horizontally (the re-shape's domain). */
function anchorBundles(requests: readonly RouteRequest[], routed: ReadonlyMap<string, Pos[]>, side: 'target' | 'source'): RouteRequest[][] {
  const byKey = new Map<string, RouteRequest[]>();
  for (const req of requests) {
    if (!routed.has(req.id)) continue;
    if (!horizontalPair(req.a, req.b)) continue;
    const anc = side === 'target' ? req.b : req.a;
    const key = `${rk(anc.x)}:${rk(anc.y)}`;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(req);
  }
  return [...byKey.values()].filter((g) => g.length >= 2);
}

/**
 * Re-shape a fan-in (shared target) or fan-out (shared source) bundle so its members occupy DISTINCT tracks and
 * converge only at the shared stub. Members are ranked by how close their free end is to the shared row (the closest
 * merges/splits LAST, with the shortest jog — the least intrusive, crossing-reducing order); rank `r` jogs at a stub
 * of `stub + r·gap` from the shared port, so each member's vertical lands on its own track. A member that ships
 * STRAIGHT consumes no rank (R5): it never jogs, so reserving a stagger slot for it would only push every jogging
 * member's split/merge farther from the shared port — lengthening the shared-run overlap for nothing (measured on
 * the ecommerce fan-out: the slide straightens rank 0 and overlap grew until straights stopped holding slots).
 * Each re-shape is kept only if it validates clear; otherwise that member keeps its independent route (and holds
 * its slot — its unknown geometry must not be shared). Mutates `routes` in place.
 */
function reshapeBundle(bundle: readonly RouteRequest[], shared: 'target' | 'source', routes: Map<string, Pos[]>, obstacles: readonly Obstacle[], opts: Required<RouteOptions>): void {
  const sharedRowY = (r: RouteRequest): number => (shared === 'target' ? r.b.y : r.a.y);
  const freeEndY = (r: RouteRequest): number => (shared === 'target' ? r.a.y : r.b.y);
  const order = bundle
    .map((req) => ({ req, d: Math.abs(freeEndY(req) - sharedRowY(req)) }))
    .sort((p, q) => p.d - q.d || freeEndY(p.req) - freeEndY(q.req) || (p.req.id < q.req.id ? -1 : 1));
  let rank = 0;
  for (const { req } of order) {
    const avoid = new Set(req.avoid);
    // Monotonic stub per rank: the lowest-ranked JOGGING member jogs LAST (shortest stub); farther members jog
    // progressively earlier, so every jogging member's vertical lands on a DISTINCT track `gap` apart near the port.
    const stubDist = opts.stub + rank * opts.gap;
    // Late merge: jog near the TARGET (jx = bx − stub·). Early split: jog near the SOURCE (jx = ax + stub·).
    const jx = shared === 'target' ? req.b.x - Math.sign(req.b.x - req.a.x) * stubDist : req.a.x + Math.sign(req.b.x - req.a.x) * stubDist;
    const shaped = staggeredZ(req.a, req.b, jx, obstacles, avoid, opts);
    if (shaped !== undefined) {
      routes.set(req.id, shaped);
      if (shaped.length > 2) rank++; // straight ⇒ no jog ⇒ no stagger slot consumed
    } else {
      rank++; // kept its independent route — hold the slot, its geometry is not ours to share
    }
  }
}

/** The x of a nudgeable INTERIOR vertical segment of a polyline (both endpoints interior, i.e. not a port anchor),
 *  or an empty list. Segment `i` is points[i]→points[i+1]; interior ⇒ 1 ≤ i and i+1 ≤ last−1. */
function interiorVerticals(pts: readonly Pos[]): { i: number; x: number; yLo: number; yHi: number }[] {
  const out: { i: number; x: number; yLo: number; yHi: number }[] = [];
  const last = pts.length - 1;
  for (let i = 1; i <= last - 2; i++) {
    const p = pts[i]!;
    const q = pts[i + 1]!;
    if (p.x === q.x && p.y !== q.y) out.push({ i, x: p.x, yLo: Math.min(p.y, q.y), yHi: Math.max(p.y, q.y) });
  }
  return out;
}

/**
 * TRACK ASSIGNMENT for residual shared corridors: interior vertical segments from DIFFERENT wires that sit on the
 * same x-line (within `gap`) and overlap in y are nudged onto distinct tracks (`gap` apart, centred), so two wires
 * crossing the same channel no longer draw one line. Each nudge slides only the segment's two shared points in x —
 * its horizontal neighbours follow automatically and stay orthogonal — and is kept only if the whole wire validates
 * clear. Deterministic: corridors and members ordered by (x, y, id). Mutates `routes` in place.
 */
function nudgeCorridors(routes: Map<string, Pos[]>, avoidOf: ReadonlyMap<string, readonly string[]>, obstacles: readonly Obstacle[], opts: Required<RouteOptions>): void {
  interface Seg { readonly id: string; readonly i: number; readonly x: number; readonly yLo: number; readonly yHi: number }
  const segs: Seg[] = [];
  for (const [id, pts] of routes) for (const v of interiorVerticals(pts)) segs.push({ id, ...v });
  segs.sort((a, b) => a.x - b.x || a.yLo - b.yLo || (a.id < b.id ? -1 : a.id > b.id ? 1 : a.i - b.i));

  // Cluster into corridors: consecutive segments whose x is within `gap` share a channel.
  let c = 0;
  while (c < segs.length) {
    let d = c + 1;
    while (d < segs.length && segs[d]!.x - segs[c]!.x <= opts.gap) d++;
    const corridor = segs.slice(c, d);
    c = d;
    // Only members that actually OVERLAP another in y need separating; a lone run keeps its x.
    const overlapping = corridor.filter((s) => corridor.some((o) => o !== s && o.yLo < s.yHi && s.yLo < o.yHi));
    if (overlapping.length < 2) continue;
    const baseX = overlapping.reduce((m, s) => m + s.x, 0) / overlapping.length;
    overlapping.forEach((s, r) => {
      const targetX = baseX + trackOffset(r) * opts.gap;
      if (Math.abs(targetX - s.x) < 0.5) return; // already on its track
      const pts = routes.get(s.id);
      if (pts === undefined) return;
      // Guard against a stale index: an earlier nudge on the SAME wire may have re-simplified its polyline, so verify
      // segment `i` is still the exact vertical we recorded before sliding it (else skip — never corrupt geometry).
      const p0 = pts[s.i];
      const p1 = pts[s.i + 1];
      if (p0 === undefined || p1 === undefined || p0.x !== s.x || p1.x !== s.x || p0.y === p1.y) return;
      const trial = pts.map((p, idx) => (idx === s.i || idx === s.i + 1 ? { x: targetX, y: p.y } : p));
      const simplified = simplifyOrthogonal(trial);
      const avoid = new Set(avoidOf.get(s.id) ?? []);
      if (segmentsClear(simplified, obstacles, avoid, opts.clearance)) routes.set(s.id, simplified);
    });
  }
}

/** Route every request against the shared obstacle set, THEN separate the shared corridors (the owner's
 *  traceability requirement), THEN justify every bend against the final geometry (the owner's LAW — R6). Returns a
 *  Map keyed by request id; a request with no clear path is simply absent (its edge falls back to the default
 *  renderer). Deterministic and side-effect-free. */
export function routeOrthogonalEdges(obstacles: readonly Obstacle[], requests: readonly RouteRequest[], options?: RouteOptions): Map<string, Pos[]> {
  const opts: Required<RouteOptions> = { ...DEFAULTS, ...options };
  const out = new Map<string, Pos[]>();
  for (const req of requests) {
    const path = routeOne(req, obstacles, opts);
    if (path !== undefined) out.set(req.id, path);
  }
  separateEdges(out, requests, obstacles, opts);
  justifyBends(out, requests, obstacles, opts);
  return out;
}

/** SEPARATION PASS (see the block comment above): late-merge fan-ins, early-split fan-outs, then nudge residual
 *  shared corridors — each step re-validated, anchors fixed, lone wires untouched. Mutates `routes` in place. */
export function separateEdges(routes: Map<string, Pos[]>, requests: readonly RouteRequest[], obstacles: readonly Obstacle[], opts: Required<RouteOptions>): void {
  const avoidOf = new Map(requests.map((r) => [r.id, r.avoid] as const));
  const reshaped = new Set<string>();
  for (const bundle of anchorBundles(requests, routes, 'target')) {
    reshapeBundle(bundle, 'target', routes, obstacles, opts);
    for (const req of bundle) reshaped.add(req.id);
  }
  for (const bundle of anchorBundles(requests, routes, 'source')) {
    const fresh = bundle.filter((req) => !reshaped.has(req.id)); // a member already merged into its target is not re-split
    if (fresh.length >= 2) reshapeBundle(fresh, 'source', routes, obstacles, opts);
  }
  nudgeCorridors(routes, avoidOf, obstacles, opts);
}

// ---------------------------------------------------------------------------------------------------------------
// BEND JUSTIFICATION — the LAW (R6, owner ratification: "EVERY BEND MUST BE JUSTIFIED"). A shipped bend is legal
// for exactly two reasons: an OBSTACLE blocks the canonical shape (the route detours), or a SHARED CORRIDOR needs
// distinct tracks (separation staggered/nudged the wire so it stays traceable). After placement and separation,
// each routed wire therefore re-tries its canonical shape (straight with the 4px snap / symmetric Z / L) against
// the FINAL geometry: if the canonical is obstacle-clear, cheaper in bends than the shipped route, and would not
// enter a corridor another wire occupies (within the track gap), the canonical replaces the route. Consequences:
//   • a wire that is ALONE at its source anchor, target anchor and corridor is always drawn canonical — a
//     separation re-shape can never leave a lone wire bent (the owner's clause);
//   • anchors never move (the ≤4px straight snap is the one ratified exception, identical to the fast path's);
//   • every replacement is obstacle-revalidated (the canonical validator) and corridor-guarded (it never re-creates
//     the pile-up separation just resolved).
// Runs to a fixpoint in request order — deterministic and idempotent — so routeOrthogonalEdges' output always
// audits clean under {@link auditNeedlessBends}; the layout benchmark pins that on every committed example.
// ---------------------------------------------------------------------------------------------------------------

/** 90° corners of a polyline after collinear merge — the "bends" the LAW counts. */
const bendsOf = (pts: readonly Pos[]): number => Math.max(0, simplifyOrthogonal(pts).length - 2);

/** Does the candidate polyline run PARALLEL-OVERLAPPING (same axis, closer than `gap`, spans genuinely sharing
 *  ground) with any segment of any OTHER wire's route? That is a shared corridor needing tracks — replacing the
 *  separated shape with this candidate would undo the separation pass's work, so the caller must keep the shape. */
function sharesCorridor(cand: readonly Pos[], ownId: string, routes: ReadonlyMap<string, Pos[]>, gap: number): boolean {
  const EPS = 0.01; // a genuine shared run, not a mere endpoint touch
  for (const [id, other] of routes) {
    if (id === ownId) continue;
    for (let i = 1; i < cand.length; i++) {
      const a0 = cand[i - 1]!;
      const a1 = cand[i]!;
      for (let j = 1; j < other.length; j++) {
        const b0 = other[j - 1]!;
        const b1 = other[j]!;
        if (a0.y === a1.y && b0.y === b1.y && a0.x !== a1.x && b0.x !== b1.x) {
          if (Math.abs(a0.y - b0.y) >= gap) continue;
          if (Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x)) - Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x)) > EPS) return true;
        } else if (a0.x === a1.x && b0.x === b1.x && a0.y !== a1.y && b0.y !== b1.y) {
          if (Math.abs(a0.x - b0.x) >= gap) continue;
          if (Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y)) - Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y)) > EPS) return true;
        }
      }
    }
  }
  return false;
}

/** The canonical replacement for one routed wire when its shipped route is UNJUSTIFIED — canonical obstacle-clear,
 *  cheaper in bends, and corridor-free — or undefined when the route stands. THE single predicate: the
 *  justification pass applies it and the audit re-checks it, so the two can never drift. */
function unjustifiedCanonical(req: RouteRequest, routes: ReadonlyMap<string, Pos[]>, obstacles: readonly Obstacle[], opts: Required<RouteOptions>): Pos[] | undefined {
  const cur = routes.get(req.id);
  if (cur === undefined) return undefined;
  const canon = tryCanonical(req, obstacles, opts);
  if (canon === undefined) return undefined; // canonical blocked ⇒ the detour is OBSTACLE-justified
  if (bendsOf(canon) >= bendsOf(cur)) return undefined; // already canonical-or-better ⇒ every bend accounted for
  if (sharesCorridor(canon, req.id, routes, opts.gap)) return undefined; // corridor needs tracks ⇒ SEPARATION-justified
  return canon;
}

/** THE BEND-JUSTIFICATION PASS (see the block comment above): replace every unjustified route with its canonical
 *  shape, to a fixpoint. A wire is replaced at most once (a canonical route is never cheaper than itself), so the
 *  sweep count is bounded by the request count. Mutates `routes` in place. */
export function justifyBends(routes: Map<string, Pos[]>, requests: readonly RouteRequest[], obstacles: readonly Obstacle[], opts: Required<RouteOptions>): void {
  for (let sweep = 0; sweep <= requests.length; sweep++) {
    let changed = false;
    for (const req of requests) {
      const canon = unjustifiedCanonical(req, routes, obstacles, opts);
      if (canon !== undefined) {
        routes.set(req.id, canon);
        changed = true;
      }
    }
    if (!changed) break;
  }
}

/** One wire the LAW flags: it ships `bends` corners where its clear, corridor-free canonical needs `canonicalBends`. */
export interface NeedlessBend {
  readonly id: string;
  readonly bends: number;
  readonly canonicalBends: number;
}

/** AUDIT the LAW over routed geometry: every wire whose canonical shape is clear at the final geometry, cheaper in
 *  bends, and corridor-free — yet whose shipped route bends more. `routeOrthogonalEdges` runs {@link justifyBends}
 *  to a fixpoint, so its output audits to `[]` by construction; the layout benchmark pins exactly that on every
 *  committed example (the "needless-bend count == 0" gate). Pure and deterministic. */
export function auditNeedlessBends(obstacles: readonly Obstacle[], requests: readonly RouteRequest[], routes: ReadonlyMap<string, Pos[]>, options?: RouteOptions): NeedlessBend[] {
  const opts: Required<RouteOptions> = { ...DEFAULTS, ...options };
  const out: NeedlessBend[] = [];
  for (const req of requests) {
    const canon = unjustifiedCanonical(req, routes, obstacles, opts);
    if (canon === undefined) continue;
    out.push({ id: req.id, bends: bendsOf(routes.get(req.id)!), canonicalBends: bendsOf(canon) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Shell-facing convenience: turn a design (node boxes + ports + wires + tidied groups) into routed geometry.
// Both shells call THIS so their wires route identically; each shell only supplies the boxes it measured.
// ---------------------------------------------------------------------------------------------------------------

export type PortLike = { readonly name: string; readonly dir: 'in' | 'out' | 'bi' };
/** A node as the router sees it: its box, its ports (manifest order — the handles the canvas renders), and — when
 *  the R5 slide assigned them — the node's port OFFSETS (`${side}:${port}` → px from top). With offsets present the
 *  router anchors exactly where the assigned handles sit; absent, at the fraction geometry — the SAME resolution
 *  the renderer uses (layout-model `portAnchorOffset`, one home), so wire and handle can never drift apart. */
export type NodeGeom = { readonly id: string; readonly box: Box; readonly ports: readonly PortLike[]; readonly portOffsets?: NodePortOffsets };
export type WireLike = { readonly from: readonly [string, string]; readonly to: readonly [string, string] };
export type GroupLike = { readonly id: string; readonly rect: Box; readonly members: readonly string[] };
/** The per-wire geometry a shell threads onto its edge `data`: the polyline (anchor→…→anchor) plus a ready SVG
 *  path and the on-wire label/incoming-pill anchors. */
export type RoutedWire = { readonly points: Pos[]; readonly d: string; readonly label: Pos; readonly inPoint: Pos };

// The port-anchor geometry lives in layout-model (`portAnchorOffset`: assigned offset ?? height × fraction) — ONE
// form shared with the renderer, the layout passes and the objective, so a row the layout calls "aligned" is a row
// the router draws as one straight segment, and an assigned handle is exactly where its wire anchors.

/** Keep a group box as an obstacle only when its rect actually ENCLOSES all its member node boxes — i.e. a real
 *  tidied lane, not a placeholder rect. This makes group avoidance kick in automatically after Tidy and stay
 *  inert on hand-placed layouts whose stored group rects are stale. */
function groupEnclosesMembers(rect: Box, members: readonly string[], boxOf: (id: string) => Box | undefined): boolean {
  let sawMember = false;
  for (const m of members) {
    const b = boxOf(m);
    if (b === undefined) continue;
    sawMember = true;
    if (b.x < rect.x || b.y < rect.y || b.x + b.w > rect.x + rect.w || b.y + b.h > rect.y + rect.h) return false;
  }
  return sawMember;
}

/** The design-level routing input both shells (and the audit) speak: measured node boxes + ports, the wires, and
 *  the tidied group boxes. */
export type DesignRouteInput = { readonly nodes: readonly NodeGeom[]; readonly wires: readonly WireLike[]; readonly groups?: readonly GroupLike[] };

/** Build the router PROBLEM for a design: the obstacle set (node boxes + genuinely-enclosing group boxes) and one
 *  {@link RouteRequest} per wire, anchored by the shared port geometry (`portAnchorOffset`). The ONE construction
 *  {@link routeDesignEdges} and {@link auditDesignEdges} share, so what ships and what is audited can never drift. */
function designProblem(input: DesignRouteInput): { obstacles: Obstacle[]; requests: RouteRequest[] } {
  const byId = new Map(input.nodes.map((n) => [n.id, n] as const));
  const boxOf = (id: string): Box | undefined => byId.get(id)?.box;
  const obstacles: Obstacle[] = input.nodes.map((n) => ({ id: n.id, box: n.box }));
  const groupOfNode = new Map<string, string[]>();
  for (const g of input.groups ?? []) {
    if (!groupEnclosesMembers(g.rect, g.members, boxOf)) continue;
    const gid = `grp:${g.id}`;
    obstacles.push({ id: gid, box: g.rect });
    for (const m of g.members) (groupOfNode.get(m) ?? groupOfNode.set(m, []).get(m))?.push(gid);
  }

  const requests: RouteRequest[] = [];
  input.wires.forEach((w, i) => {
    const src = byId.get(w.from[0]);
    const tgt = byId.get(w.to[0]);
    if (src === undefined || tgt === undefined) return;
    const aY = src.box.y + portAnchorOffset(src.ports, 'out', w.from[1], src.box.h, src.portOffsets);
    const bY = tgt.box.y + portAnchorOffset(tgt.ports, 'in', w.to[1], tgt.box.h, tgt.portOffsets);
    const avoid = [src.id, tgt.id, ...(groupOfNode.get(src.id) ?? []), ...(groupOfNode.get(tgt.id) ?? [])];
    requests.push({
      id: `w${i}`,
      a: { x: src.box.x + src.box.w, y: aY, side: 'right' },
      b: { x: tgt.box.x, y: bY, side: 'left' },
      avoid,
    });
  });
  return { obstacles, requests };
}

/** AUDIT a design's shipped routes against the bend-justification LAW (R6): route exactly as
 *  {@link routeDesignEdges} would, then report every wire whose clear, corridor-free canonical is cheaper than the
 *  route that shipped (see {@link auditNeedlessBends}). `[]` = every bend on this design is justified. The
 *  benchmark's needless-bend gate runs THIS on every committed example. */
export function auditDesignEdges(input: DesignRouteInput, options?: RouteOptions): NeedlessBend[] {
  const { obstacles, requests } = designProblem(input);
  const routes = routeOrthogonalEdges(obstacles, requests, options);
  return auditNeedlessBends(obstacles, requests, routes, options);
}

export function routeDesignEdges(
  input: DesignRouteInput,
  options?: RouteOptions & { readonly cornerRadius?: number },
): Map<number, RoutedWire> {
  const { obstacles, requests } = designProblem(input);
  const routed = routeOrthogonalEdges(obstacles, requests, options);
  const radius = options?.cornerRadius ?? 4;
  const out = new Map<number, RoutedWire>();
  input.wires.forEach((_, i) => {
    const points = routed.get(`w${i}`);
    if (points === undefined || points.length < 2) return;
    out.set(i, { points, d: orthogonalPathD(points, radius), label: pointAlongPolyline(points, 0.5), inPoint: pointAlongPolyline(points, 0.8) });
  });
  return out;
}
