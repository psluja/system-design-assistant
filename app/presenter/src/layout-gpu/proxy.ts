import type { Size } from '../layout';
import type { LayoutDesign, Placement } from '../layout-model';
import { adjacency, sizeOf } from '../layout-model';
import { LAYOUT_WEIGHTS } from '../layout-objective';

// @algorithm fp32 straight-line proxy objective (deviceless twin of the layout WGSL kernel)
// @problem Routing a candidate costs ~2ms, so ranking THOUSANDS of beam candidates on real routes is
//   unaffordable — yet any cheap proxy must be bit-reproducible on GPU and CPU alike so CI can prove
//   the kernel without a device.
// @approach Score four objective terms (crossings, length, alignment, symmetry) on straight
//   center-to-center segments in strict fp32 — every op through Math.fround, single rounding, the
//   exact WGSL f32 discipline — with each term's divergence from the routed truth documented;
//   alignment uses the O(n^2) pairwise guideline question instead of greedy clustering (GPU-friendly).
// @complexity Crossings O(e^2), alignment O(n^2), length O(e), symmetry O(sum fan-out) per candidate.
// @citations WGSL f32 single-rounding semantics (W3C); same fround discipline as
//   engine/solver-contract/src/gpu/fp32.ts; term definitions from the exact objective
//   (app/presenter/src/layout-objective.ts).
// @invariants Bit-identical to the WGSL kernel on the same input (device differential); a PROXY by
//   contract — it only ranks/prunes, the CPU re-routes and re-scores every survivor exactly, so
//   fp32 never decides the applied layout.
// @where-tested app/presenter/src/layout-gpu/proxy.test.ts,
//   app/presenter/src/layout-gpu/device.test.ts (device arm)

// THE IDEAL LAYOUT — the GPU PROPOSER's numeric core (doc: ideal-layout §3.3). This is the fp32
// STRAIGHT-LINE PROXY objective AND its deviceless emulation twin, in one pure module. A WGSL compute kernel
// (./webgpu) replays EXACTLY these ops per candidate on a real card; this JS twin runs the identical fp32 arithmetic
// via `Math.fround` (single-rounding-per-op — the same discipline engine/solver-contract/src/gpu/fp32.ts uses for
// the cell network), so CI exercises the kernel's numeric path with no GPU, and the device differential pins that
// the real card agrees. It is a PROXY, used ONLY to rank/prune beam candidates — the CPU always re-routes and
// re-scores every survivor exactly (the router is the arbiter, §3.4), so fp32 never decides the applied layout.
//
// WHY A PROXY, AND WHERE IT DIVERGES FROM THE ROUTED TRUTH. The real objective (layout-objective.ts) scores on the
// deterministic router's REAL orthogonal polylines. Routing a candidate costs ~2ms; to rank THOUSANDS cheaply the
// proxy scores four §2 terms on STRAIGHT centre-to-centre segments instead. Each term's divergence from the routed
// truth is documented so the ranking's error is understood, not hidden:
//   • crossings — straight segments vs routed polylines. The router can REMOVE a straight crossing (detour around a
//     node) or ADD one (a jog that meets another run). So the proxy over/under-counts where the router reroutes;
//     it correlates strongly (a placement with many straight crossings routes with many) but not exactly — this is
//     the largest single source of proxy↔routed rank disagreement, and precisely why the CPU re-scores.
//   • length — straight Euclidean vs routed orthogonal arc length. Routed length is ALWAYS ≥ straight (right-angle
//     detours), so the proxy systematically UNDER-estimates the magnitude but is monotone in it (longer straight ⇒
//     longer route), preserving rank well.
//   • alignment — reads node CENTRES. The exact term (R5, port-centric alignment) clusters row guidelines on each
//     node's DOMINANT PORT ANCHOR (layout-model `dominantAnchorOffsets`); for single-port nodes anchor == centre,
//     so the proxy stays near-exact there and diverges only on multi-port / uneven-fraction nodes (a fixed per-node
//     y offset the ranking largely absorbs). The other divergence is the clustering approximation: the exact term
//     greedily clusters (transitive within ε); the GPU-friendly proxy asks the O(n²) pairwise question "does this
//     node share an x- or y-guideline with ANY other within ε?". Both gaps are documented, rank-tolerable, and
//     covered by the CPU re-score (fp32 never final).
//   • symmetry — reads centres + fan-out adjacency; routing-independent, so the proxy is EXACT (same formula as §2).
// Two of four terms are routing-independent (alignment, symmetry) → the proxy is a strong ranking signal; the two
// routed terms (crossings, length) are where it can misrank, and the CPU re-score catches exactly those cases.
//
// WHY THE PROXY DELIBERATELY SKIPS THE R4 SEPARATION TERMS (overlap / spacing / merge). Those terms score edge
// TRACEABILITY on the router's REAL corridors and tracks — and the R4 router does not merely route each wire, it
// RE-SHAPES bundles (late-merge fan-ins, early-split fan-outs) and NUDGES shared corridors apart (edge-routing.ts
// `separateEdges`). A straight centre-to-centre segment has no corridors, no tracks, and no bundle re-shaping, so
// there is NO cheap straight-line approximation of separation that would correlate with the routed truth — it is
// the routed-dependent divergence of crossings/length, only MORE so (the reshaping restructures the very polylines
// the proxy straight-lines). So the proxy stays a four-term straight-line ranking of the routing-INDEPENDENT core,
// and separation is proven CPU-only on every survivor (fp32-never-final). The cost is a WEAKER — but still clearly
// positive — rank correlation with the full 14-term objective: measured Spearman ρ fell from the R3 0.76–0.84 to
// 0.39–0.83 (three designs stay ≥ 0.74; the outlier is the fan-in-dense cqrs-production-large at 0.39, where the
// reshaping the proxy cannot see moves the most). This is safe precisely BECAUSE fp32 never decides: on committed
// designs the per-slice batch is below the survivor cap, so NOTHING is pruned and GPU-on == GPU-off byte-for-byte;
// only on large synthetic batches does
// the proxy prune, and there the CPU still re-scores the survivors on the full objective. A weaker pre-filter costs
// a little search efficiency on huge batches; it never costs correctness (proxy.test.ts pins both facts).

/** ε (px) within which two node centres count as sharing a guideline — MUST match `ALIGN_EPS` in layout-objective.ts
 *  so the proxy's alignment reads the same lattice the exact term does. */
export const PROXY_ALIGN_EPS = 6;

/** The four proxy terms, in the fixed order the aggregate folds them (crossings, length, alignment, symmetry). */
export const PROXY_TERMS = ['crossings', 'length', 'alignment', 'symmetry'] as const;
export type ProxyTerm = (typeof PROXY_TERMS)[number];

/** The proxy's term weights — the SAME ratified §2 weights (layout-objective `LAYOUT_WEIGHTS`) for these four terms,
 *  renormalised at aggregate time over whichever are active. Using the real weights maximises rank correlation with
 *  the full routed objective (the proxy is only a ranking signal, so exact parity is not required, only monotonicity). */
export const PROXY_WEIGHTS: Readonly<Record<ProxyTerm, number>> = {
  crossings: LAYOUT_WEIGHTS.crossings,
  length: LAYOUT_WEIGHTS.length,
  alignment: LAYOUT_WEIGHTS.alignment,
  symmetry: LAYOUT_WEIGHTS.symmetry,
};

/**
 * The candidate-INVARIANT precompute for a design (built once, scored against a whole batch of candidate placements).
 * Every node is addressed by a dense integer index (into {@link nodeIds}) so the twin and the WGSL kernel address
 * nodes by number, never by string. Wires are index pairs (self-loops dropped — they carry no placement line);
 * `fanout` is a flat encoding of the ≥2-distinct-target fan-out groups the symmetry term folds; `halfW`/`halfH`
 * give each node's half-extent so a candidate's bounding box (hence the length normaliser's diagonal) is derivable
 * from its centres alone.
 */
export interface ProxyModel {
  readonly nodeIds: readonly string[];
  readonly n: number;
  /** Wire endpoints as `[from,to, from,to, …]` node indices (self-loops + dangling endpoints removed). */
  readonly wires: Int32Array;
  readonly e: number;
  /** Fan-out groups, flat: `[srcIdx, k, t0, t1, …, t(k-1)]` repeated, each with k ≥ 2 DISTINCT targets. */
  readonly fanout: Int32Array;
  readonly fanoutCount: number;
  readonly halfW: Float32Array;
  readonly halfH: Float32Array;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// ── fp32 single-rounding arithmetic (mirrors a WGSL `f32` kernel: every op rounds its result once) ───────────────
const f = Math.fround;
const fsub = (a: number, b: number): number => f(a - b);
const fadd = (a: number, b: number): number => f(a + b);
const fmul = (a: number, b: number): number => f(a * b);
const fdiv = (a: number, b: number): number => f(a / b);

/** Build the candidate-invariant proxy model for a design (dense indices, wire pairs, fan-out groups, half-sizes).
 *  Pure + deterministic; mirrors the derivations the exact objective and the router use, so the two never drift. */
export function buildProxyModel(design: LayoutDesign, sizeMap: Readonly<Record<string, Size>>): ProxyModel {
  const nodeIds = design.nodes.map((nd) => nd.id);
  const n = nodeIds.length;
  const index = new Map<string, number>();
  nodeIds.forEach((id, i) => index.set(id, i));

  const wirePairs: number[] = [];
  for (const w of design.wires) {
    if (w.from[0] === w.to[0]) continue; // a self-loop is not a placement segment (self() routes to itself)
    const a = index.get(w.from[0]);
    const b = index.get(w.to[0]);
    if (a === undefined || b === undefined) continue;
    wirePairs.push(a, b);
  }
  const wires = Int32Array.from(wirePairs);
  const e = wires.length / 2;

  // Fan-out groups: exactly the symmetry term's subject — a source with ≥2 DISTINCT targets (layout-objective
  // symmetryPenalty). Encoded flat so the kernel walks them with no nested arrays.
  const { fwd } = adjacency(design);
  const fanoutFlat: number[] = [];
  let fanoutCount = 0;
  for (const [src, targets] of fwd) {
    const s = index.get(src);
    if (s === undefined) continue;
    const distinct = [...new Set(targets)].map((t) => index.get(t)).filter((t): t is number => t !== undefined);
    if (distinct.length < 2) continue;
    fanoutFlat.push(s, distinct.length, ...distinct);
    fanoutCount++;
  }

  const halfW = new Float32Array(n);
  const halfH = new Float32Array(n);
  design.nodes.forEach((nd, i) => {
    const s = sizeMap[nd.id] ?? sizeOf(nd);
    halfW[i] = f(s.w / 2);
    halfH[i] = f(s.h / 2);
  });

  return { nodeIds, n, wires, e, fanout: Int32Array.from(fanoutFlat), fanoutCount, halfW, halfH };
}

/**
 * Project a candidate placement (top-left corners) to the flat centre array the proxy scores — `[cx0,cy0, cx1,cy1,…]`
 * in the model's node-index order (centre = corner + half-size, rounded to fp32 exactly as the kernel receives it).
 * A node the placement omits is parked at the origin (it contributes no meaningful line — the same degenerate the
 * exact objective tolerates by skipping unplaced nodes).
 */
export function centersOf(model: ProxyModel, placement: Placement): Float32Array {
  const out = new Float32Array(model.n * 2);
  for (let i = 0; i < model.n; i++) {
    const at = placement[model.nodeIds[i]!];
    if (at === undefined) continue;
    out[2 * i] = f(at.x + model.halfW[i]!);
    out[2 * i + 1] = f(at.y + model.halfH[i]!);
  }
  return out;
}

// ── the four proxy penalties, in fp32 (each mirrors a WGSL branch; each returns null when its subject is absent) ──

/** Straight-line crossings over the pair bound e(e−1)/2 (inert with <2 wires). */
function proxyCrossings(model: ProxyModel, c: Float32Array): number | null {
  const { wires, e } = model;
  const bound = (e * (e - 1)) / 2;
  if (bound <= 0) return null;
  let crossing = 0;
  for (let i = 0; i < e; i++) {
    const a0 = wires[2 * i]!;
    const a1 = wires[2 * i + 1]!;
    const p1x = c[2 * a0]!, p1y = c[2 * a0 + 1]!, p2x = c[2 * a1]!, p2y = c[2 * a1 + 1]!;
    for (let j = i + 1; j < e; j++) {
      const b0 = wires[2 * j]!;
      const b1 = wires[2 * j + 1]!;
      const p3x = c[2 * b0]!, p3y = c[2 * b0 + 1]!, p4x = c[2 * b1]!, p4y = c[2 * b1 + 1]!;
      if (properCrossFp32(p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y)) crossing++;
    }
  }
  return clamp01(fdiv(crossing, bound));
}

/** Orientation of c about the segment a→b, in fp32 (sign = which side). */
function orientFp32(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return fsub(fmul(fsub(bx, ax), fsub(cy, ay)), fmul(fsub(by, ay), fsub(cx, ax)));
}

/** Do segments p1p2 and p3p4 PROPERLY cross (strict interior, shared endpoints excluded) — fp32 twin of
 *  layout-model `segmentsProperlyCross`. */
function properCrossFp32(p1x: number, p1y: number, p2x: number, p2y: number, p3x: number, p3y: number, p4x: number, p4y: number): boolean {
  const d1 = orientFp32(p3x, p3y, p4x, p4y, p1x, p1y);
  const d2 = orientFp32(p3x, p3y, p4x, p4y, p2x, p2y);
  const d3 = orientFp32(p1x, p1y, p2x, p2y, p3x, p3y);
  const d4 = orientFp32(p1x, p1y, p2x, p2y, p4x, p4y);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Total straight length over e × the candidate's bounding diagonal (inert with no wires or a degenerate box). */
function proxyLength(model: ProxyModel, c: Float32Array, diag: number): number | null {
  const { wires, e } = model;
  if (e === 0 || diag <= 0) return null;
  let total = 0;
  for (let i = 0; i < e; i++) {
    const a = wires[2 * i]!;
    const b = wires[2 * i + 1]!;
    const dx = fsub(c[2 * b]!, c[2 * a]!);
    const dy = fsub(c[2 * b + 1]!, c[2 * a + 1]!);
    total = fadd(total, f(Math.sqrt(fadd(fmul(dx, dx), fmul(dy, dy)))));
  }
  return clamp01(fdiv(total, fmul(e, diag)));
}

/** Fraction of node centres NOT sharing an x- or y-guideline (within ε) with any other node — the pairwise proxy of
 *  the exact greedy clustering (inert with <2 nodes). */
function proxyAlignment(model: ProxyModel, c: Float32Array): number | null {
  const { n } = model;
  if (n < 2) return null;
  let aligned = 0;
  for (let i = 0; i < n; i++) {
    const xi = c[2 * i]!, yi = c[2 * i + 1]!;
    let shares = false;
    for (let j = 0; j < n && !shares; j++) {
      if (j === i) continue;
      if (Math.abs(fsub(xi, c[2 * j]!)) <= PROXY_ALIGN_EPS || Math.abs(fsub(yi, c[2 * j + 1]!)) <= PROXY_ALIGN_EPS) shares = true;
    }
    if (shares) aligned++;
  }
  return clamp01(fsub(1, fdiv(aligned, n)));
}

/** Mean fan-out asymmetry about each source's centre-Y — EXACT twin of §2 symmetry (routing-independent). Inert
 *  when no node fans out to ≥2 distinct targets. */
function proxySymmetry(model: ProxyModel, c: Float32Array): number | null {
  const { fanout, fanoutCount } = model;
  if (fanoutCount === 0) return null;
  let sum = 0;
  let p = 0;
  for (let g = 0; g < fanoutCount; g++) {
    const src = fanout[p++]!;
    const k = fanout[p++]!;
    const py = c[2 * src + 1]!;
    let absSum = 0;
    let signedSum = 0;
    for (let t = 0; t < k; t++) {
      const kid = fanout[p++]!;
      const off = fsub(c[2 * kid + 1]!, py);
      absSum = fadd(absSum, Math.abs(off));
      signedSum = fadd(signedSum, off);
    }
    sum = fadd(sum, absSum > 0 ? fdiv(Math.abs(signedSum), absSum) : 0);
  }
  return clamp01(fdiv(sum, fanoutCount));
}

/** The candidate's bounding diagonal from its centres ± half-sizes, in fp32 (the length normaliser). */
function diagonalFp32(model: ProxyModel, c: Float32Array): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < model.n; i++) {
    const cx = c[2 * i]!, cy = c[2 * i + 1]!;
    const hw = model.halfW[i]!, hh = model.halfH[i]!;
    minX = Math.min(minX, fsub(cx, hw));
    maxX = Math.max(maxX, fadd(cx, hw));
    minY = Math.min(minY, fsub(cy, hh));
    maxY = Math.max(maxY, fadd(cy, hh));
  }
  if (!Number.isFinite(minX)) return 0;
  const w = fsub(maxX, minX);
  const h = fsub(maxY, minY);
  return f(Math.sqrt(fadd(fmul(w, w), fmul(h, h))));
}

/**
 * Score ONE candidate on the fp32 straight-line proxy — the aggregate quality in [0,1] (higher = better), computed
 * with the exact same fold a WGSL `f32` kernel would (single-rounding per op). Inactive terms (no subject in this
 * design) are renormalised away, exactly as the full objective handles N/A — so the proxy's aggregate is comparable
 * to the routed `quality` it approximates. This is the numeric path the kernel replays; ranking a batch calls it
 * per candidate.
 */
export function proxyScoreOne(model: ProxyModel, centers: Float32Array): number {
  const diag = diagonalFp32(model, centers);
  const penalties: Record<ProxyTerm, number | null> = {
    crossings: proxyCrossings(model, centers),
    length: proxyLength(model, centers, diag),
    alignment: proxyAlignment(model, centers),
    symmetry: proxySymmetry(model, centers),
  };
  let weighted = 0;
  let activeWeight = 0;
  for (const term of PROXY_TERMS) {
    const pen = penalties[term];
    if (pen === null) continue;
    weighted = fadd(weighted, fmul(PROXY_WEIGHTS[term], pen));
    activeWeight = fadd(activeWeight, PROXY_WEIGHTS[term]);
  }
  return activeWeight > 0 ? clamp01(fsub(1, fdiv(weighted, activeWeight))) : 1;
}

/**
 * The BATCH numeric path — score `count` candidates whose centres are packed contiguously in `centersFlat`
 * (`[cand][node][x,y]`, so candidate `k` occupies `[k*2n .. (k+1)*2n)`), returning one fp32 quality per candidate.
 * This is the deviceless emulation of the WGSL dispatch (one candidate per invocation); the real kernel (./webgpu)
 * consumes the identical buffer and MUST return the identical values within fp32 tolerance (the device differential).
 */
export function proxyScoreBatchFp32(model: ProxyModel, centersFlat: Float32Array, count: number): Float32Array {
  const stride = model.n * 2;
  const out = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    out[k] = proxyScoreOne(model, centersFlat.subarray(k * stride, (k + 1) * stride));
  }
  return out;
}

/** Pack a batch of candidate placements into the contiguous centre buffer {@link proxyScoreBatchFp32} consumes. */
export function packCenters(model: ProxyModel, candidates: readonly Placement[]): Float32Array {
  const stride = model.n * 2;
  const flat = new Float32Array(candidates.length * stride);
  for (let k = 0; k < candidates.length; k++) flat.set(centersOf(model, candidates[k]!), k * stride);
  return flat;
}
