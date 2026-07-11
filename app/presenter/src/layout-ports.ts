import type { Size } from './layout';
import {
  type LayoutDesign,
  type Placement,
  type PortOffsets,
  designPorts,
  portFraction,
  portOffsetKey,
  sizeOf,
} from './layout-model';
import type { PortLike } from './edge-routing';
import { layoutGeometry, separationMetrics, straightWireCount } from './layout-objective';

// @algorithm Port sliding by weighted bounded isotonic regression (PAVA)
// @problem A node is one rigid body, so after row alignment two wires leaving different ports can
//   never both be straight by moving the box — ports must slide along their side to sit opposite
//   their peers while keeping manifest order, a readable gap and the pad band.
// @approach Per node side: nearest-achievable-peer targets (with the elect guard so a shared fan
//   port chases only its nearest peer), then projection onto the ordered-with-min-gap band by
//   weighted isotonic regression — Pool-Adjacent-Violators on gap-shifted values plus the bound
//   clamp; nodes sweep in reading order so left-to-right wires meet final anchors; the result ships
//   only if anchor meets never regress vs. plain fractions.
// @complexity O(p) PAVA per side (p ports on the side); O(N * p + wires) for the sweep + acceptance.
// @citations Ayer et al. 1955 (PAVA); Barlow, Bartholomew, Bremner & Brunk 1972 (isotonic
//   regression); Best & Chakravarti 1990 (linear-time PAVA); ELK/yFiles port-position optimization
//   as the reference capability.
// @invariants Manifest port order preserved; neighbors at least MIN_PORT_GAP apart; offsets inside
//   the PORT_EDGE_PAD band; a side that cannot hold its ports assigns nothing (fraction fallback);
//   anchor-level never-worse law vs. fractions; deterministic sweep (x, then y, then id).
// @where-tested app/presenter/src/layout-ports.test.ts

// THE PORT SLIDE (R5, port-position assignment) — a port may SLIDE along its node edge to sit exactly opposite its
// peer, the ELK port-position / yFiles port-optimization class. The owner's rung after row alignment: rows put the
// ANCHORS as close as node-level moves can, but a node is one rigid body — two wires leaving different ports can
// never both be straight by moving the box alone. Ports are OURS: their order on a side is manifest identity
// (stable — no reorder in v1), but their POSITIONS within the side are free, so the last few px of misalignment
// (and the whole multi-out jog class) close here.
//
// THE MECHANICS, per node and side, deterministic and pure:
//   1. TARGETS — every wired port wants the NEAREST ACHIEVABLE peer anchor: each of its wires proposes the peer's
//      anchor y (in the CURRENT offset state) clamped into this port's own pad band, and the port takes the
//      proposal closest to where it already sits (ties → first wire). Nearest — not the mean — because a port
//      already exactly opposite a peer proposes ZERO motion (an existing straight wire is never broken to chase a
//      compromise row that is straight to nobody), and a fan-in can only ever be straight to ONE peer, so it takes
//      the cheapest one and leaves the rest to the router's separation stagger. An unwired port wants exactly its
//      fraction position (it keeps today's look). THE ELECT GUARD: a SHARED port (≥2 wires — a fan-out's source,
//      a fan-in's sink) can be met by only ONE peer, so only the bundle's ELECT — the member currently nearest the
//      shared anchor — may chase its row; the rest hold. Without this, every member of a fan-out slides onto the
//      one shared row and the wires pile onto each other — exactly the line-on-line overlap the R4 traceability
//      verdict forbids (measured: it happens; the guard keeps overlap at the no-slide baseline).
//   2. MONOTONE PROJECTION — the targets are projected onto the feasible set "manifest order preserved, at least
//      {@link MIN_PORT_GAP} px between neighbours, inside the node's pad band" — a weighted bounded ISOTONIC
//      regression (PAVA + the shifted-bound clamp, which provably preserves both order and gap). Wired ports carry
//      the heavier weight, so when a wired and an unwired port contend for a y, the wire wins.
//   3. SWEEP ORDER — nodes are processed in reading order (x, then y, then id): a node's IN side meets the FINAL
//      out-anchors of the already-processed columns to its left, so every left→right wire gets one exact meet —
//      the straight-wire cascade — while its OUT side pre-slides toward its peers' current anchors.
//   4. ACCEPTANCE — the finished map is kept only if it makes the design's wire anchors MEET at least as often as
//      the fractions did (the anchor-level never-worse law; the optimiser re-checks the same claim on ROUTED
//      geometry). A slide that cannot prove itself ships nothing — fractions, never a regression.
// A side whose band cannot hold its ports at the minimum gap (a tiny node) assigns nothing — the fraction
// fallback, never a squeezed lie. Nodes the architect pinned still slide their ports: position is node-level,
// ports are ours.

/** The minimum readable gap between two handles on one node side (px) — the port-level sibling of the router's
 *  track gap. The slide never packs handles closer; a side that cannot hold it falls back to fractions. */
export const MIN_PORT_GAP = 18;

/** The pad band (px) a sliding handle keeps from its node's top/bottom edge, so a handle never rides a rounded
 *  corner. Fractions respect it by construction ((i+1)/(n+1) of a ≥3-port-tall node); the slide enforces it. */
export const PORT_EDGE_PAD = 16;

/** One side's slide input: each port's target y (px from node top) + its weight (wired ports outweigh unwired). */
export interface SlideTarget {
  readonly target: number;
  readonly weight: number;
}

/**
 * The weighted bounded ISOTONIC projection (the tiny PAVA pass): positions for one node side that are as close to
 * `targets` as the constraints allow — order preserved (position i stays above position i+1 by ≥ `gap`), all inside
 * [`pad`, `height − pad`]. Returns `undefined` when the band cannot hold the ports at the gap (the caller keeps
 * fractions). Pure, deterministic, O(n) — pool-adjacent-violators on the gap-shifted values, then the shifted-bound
 * clamp (clamp bounds move by exactly `gap` per index, so clamping a gap-feasible solution stays gap-feasible).
 */
export function slidePositions(targets: readonly SlideTarget[], height: number, gap = MIN_PORT_GAP, pad = PORT_EDGE_PAD): number[] | undefined {
  const n = targets.length;
  if (n === 0) return [];
  const lo = pad;
  const hi = height - pad;
  if (hi - lo < (n - 1) * gap) return undefined; // the band cannot hold n ports at the gap — fraction fallback

  // PAVA on the gap-shifted axis: v_i = y_i − i·gap must be non-decreasing ⇔ y monotone with ≥gap between.
  interface Pool {
    sum: number; // Σ w·v of the pooled targets
    weight: number;
    count: number;
  }
  const pools: Pool[] = [];
  for (let i = 0; i < n; i++) {
    const t = targets[i]!;
    pools.push({ sum: (t.target - i * gap) * t.weight, weight: t.weight, count: 1 });
    // merge backwards while the means violate monotonicity
    while (pools.length >= 2) {
      const b = pools[pools.length - 1]!;
      const a = pools[pools.length - 2]!;
      if (a.sum / a.weight <= b.sum / b.weight) break;
      pools.pop();
      pools[pools.length - 1] = { sum: a.sum + b.sum, weight: a.weight + b.weight, count: a.count + b.count };
    }
  }
  const out: number[] = [];
  let idx = 0;
  for (const pool of pools) {
    const mean = pool.sum / pool.weight;
    for (let k = 0; k < pool.count; k++) {
      // Back to the y axis, then the shifted-bound clamp: bounds move by exactly `gap` per index, so the clamp
      // preserves both monotonicity and the gap (clamp_{i+1}(v+gap) = clamp_i(v)+gap).
      const y = mean + idx * gap;
      const loI = lo + idx * gap;
      const hiI = hi - (n - 1 - idx) * gap;
      out.push(Math.min(hiI, Math.max(loI, y)));
      idx++;
    }
  }
  return out;
}

const onSide = (ports: readonly PortLike[], side: 'in' | 'out'): PortLike[] =>
  ports.filter((p) => (side === 'in' ? p.dir === 'in' || p.dir === 'bi' : p.dir === 'out' || p.dir === 'bi'));

/** How much heavier a WIRED port's pull is than an unwired port's fraction hold when the isotonic pass must pool
 *  them: the wire wins the contested y, the unwired port yields (it has no line to straighten). */
const WIRE_WEIGHT = 4;

const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * Assign the PORT OFFSETS for a shipped placement (see the header): node id → `${side}:${port}` → px from node
 * top. Every placed node with a gap-feasible side gets that side's full offset list (wired ports slid opposite
 * their peers, unwired ports holding their fraction unless squeezed); an infeasible side — or an unplaced node —
 * assigns nothing and renders at fractions. `sizes` are the shell's measured footprints (defaulting to declared /
 * default node sizes, the same rule every layout stage uses). Pure and deterministic: one reading-order sweep,
 * offsets rounded to 0.1px.
 */
export function assignPortOffsets(design: LayoutDesign, placement: Placement, sizes?: Readonly<Record<string, Size>>): PortOffsets {
  const ports = designPorts(design);
  const heightOf = (id: string): number => sizes?.[id]?.h ?? sizeOf(design.nodes.find((n) => n.id === id) ?? { id }).h;
  const topOf = (id: string): number | undefined => placement[id]?.y;

  // The CURRENT offset state every target reads — seeded with fractions for every placed node, overwritten as the
  // sweep finalises a side, so an in-port processed later meets the FINAL out-anchor of its left peer.
  const current = new Map<string, Map<string, number>>();
  for (const node of design.nodes) {
    if (topOf(node.id) === undefined) continue;
    const h = heightOf(node.id);
    const mine = new Map<string, number>();
    for (const side of ['in', 'out'] as const) {
      for (const p of onSide(ports.get(node.id) ?? [], side)) {
        mine.set(portOffsetKey(side, p.name), h * portFraction(ports.get(node.id) ?? [], side, p.name));
      }
    }
    current.set(node.id, mine);
  }

  // Peers per (node, side, port): the opposite end's (node, side, port), one entry per wire (a double wire pulls
  // twice — the heavier tie). Wire order — deterministic.
  const peers = new Map<string, { node: string; key: string }[]>();
  const addPeer = (node: string, key: string, peer: { node: string; key: string }): void => {
    const id = `${node}|${key}`;
    (peers.get(id) ?? peers.set(id, []).get(id)!).push(peer);
  };
  for (const w of design.wires) {
    const outKey = portOffsetKey('out', w.from[1]);
    const inKey = portOffsetKey('in', w.to[1]);
    addPeer(w.from[0], outKey, { node: w.to[0], key: inKey });
    addPeer(w.to[0], inKey, { node: w.from[0], key: outKey });
  }

  // Reading-order sweep (x, then y, then id — the column order): the IN side of a node meets the FINAL anchors of
  // the columns already processed to its left; the OUT side pre-slides toward its peers' current anchors.
  const order = design.nodes
    .map((n) => n.id)
    .filter((id) => topOf(id) !== undefined)
    .sort((a, b) => placement[a]!.x - placement[b]!.x || placement[a]!.y - placement[b]!.y || (a < b ? -1 : a > b ? 1 : 0));

  // The CURRENT absolute anchor of a (node, `${side}:${port}`) — reads the evolving state, so a processed node
  // reports its FINAL row and an unprocessed one its fraction.
  const anchorOf = (node: string, key: string): number | undefined => {
    const t = topOf(node);
    const off = current.get(node)?.get(key);
    return t !== undefined && off !== undefined ? t + off : undefined;
  };
  /** THE ELECT GUARD: may `member` (a node+key at one end of a wire) chase the row of `shared` (the other end)?
   *  Always, when `shared` carries one wire; on a ≥2-wire bundle only for the member currently NEAREST the shared
   *  anchor (ties → wire order). One meet per shared port — the rest hold, so a fan-out never piles its members
   *  onto one row. */
  const mayChase = (member: { node: string; key: string }, shared: { node: string; key: string }): boolean => {
    const bundle = peers.get(`${shared.node}|${shared.key}`) ?? [];
    if (bundle.length < 2) return true;
    const sharedY = anchorOf(shared.node, shared.key);
    if (sharedY === undefined) return false;
    let elect: { node: string; key: string } | undefined;
    let electDist = Infinity;
    for (const b of bundle) {
      const y = anchorOf(b.node, b.key);
      if (y === undefined) continue;
      const dist = Math.abs(y - sharedY);
      if (dist < electDist) {
        elect = b;
        electDist = dist;
      }
    }
    return elect !== undefined && elect.node === member.node && elect.key === member.key;
  };

  const out: Record<string, Record<string, number>> = {};
  for (const id of order) {
    const nodePorts = ports.get(id) ?? [];
    const h = heightOf(id);
    const top = topOf(id)!;
    const mine = current.get(id)!;
    for (const side of ['in', 'out'] as const) {
      const list = onSide(nodePorts, side);
      if (list.length === 0) continue;
      const targets: SlideTarget[] = list.map((p) => {
        const key = portOffsetKey(side, p.name);
        const cur = mine.get(key) ?? h * portFraction(nodePorts, side, p.name);
        // Each wire proposes its peer's anchor, clamped into MY band (an unreachable row is chased only to the
        // clamp — never past it) — unless the peer is a SHARED port and this port is not its elect (then the
        // proposal is "stay"). The port takes the NEAREST proposal to where it sits: zero motion when a wire is
        // already straight, the cheapest single meet on a fan-in (ties → first wire, deterministic).
        const proposals = (peers.get(`${id}|${key}`) ?? []).flatMap((peer) => {
          const peerY = anchorOf(peer.node, peer.key);
          if (peerY === undefined) return [];
          if (!mayChase({ node: id, key }, peer)) return [cur]; // not the elect — hold this row
          return [Math.min(h - PORT_EDGE_PAD, Math.max(PORT_EDGE_PAD, peerY - top))];
        });
        if (proposals.length === 0) return { target: h * portFraction(nodePorts, side, p.name), weight: 1 }; // unwired: keep the fraction
        let best = proposals[0]!;
        for (const v of proposals) if (Math.abs(v - cur) < Math.abs(best - cur)) best = v;
        return { target: best, weight: WIRE_WEIGHT * proposals.length };
      });
      const slid = slidePositions(targets, h);
      if (slid === undefined) continue; // the band cannot hold the gap — this side keeps its fractions
      const assigned = (out[id] ?? (out[id] = {}));
      list.forEach((p, i) => {
        const key = portOffsetKey(side, p.name);
        const v = round1(slid[i]!);
        assigned[key] = v;
        mine.set(key, v); // later nodes meet the FINAL anchor
      });
    }
  }

  // ACCEPTANCE — the anchor-level never-worse law: the map ships only if wire anchors now MEET (within the
  // router's exactness) at least as often as the fractions managed. A rejected slide returns {} — fractions,
  // honestly, rather than a "prettier" map that breaks more lines than it straightens.
  const meets = (offsetOf: (node: string, key: string) => number | undefined): number => {
    let n = 0;
    for (const w of design.wires) {
      const aTop = topOf(w.from[0]);
      const bTop = topOf(w.to[0]);
      if (aTop === undefined || bTop === undefined) continue;
      const aPorts = ports.get(w.from[0]) ?? [];
      const bPorts = ports.get(w.to[0]) ?? [];
      const a = aTop + (offsetOf(w.from[0], portOffsetKey('out', w.from[1])) ?? heightOf(w.from[0]) * portFraction(aPorts, 'out', w.from[1]));
      const b = bTop + (offsetOf(w.to[0], portOffsetKey('in', w.to[1])) ?? heightOf(w.to[0]) * portFraction(bPorts, 'in', w.to[1]));
      if (Math.abs(a - b) <= 0.75) n++;
    }
    return n;
  };
  const fractionMeets = meets(() => undefined);
  const slideMeets = meets((node, key) => out[node]?.[key]);
  return slideMeets >= fractionMeets ? out : {};
}

/**
 * The slide the shells and the optimiser SHIP: {@link assignPortOffsets}, then the ROUTED acceptance — the router
 * (the arbiter) re-draws the design with the offsets and the map is kept only if
 *   • it draws at least as many ONE-segment straight wires as the fractions did, AND
 *   • its line-on-line overlap stays within `overlapFloor` (the R4 traceability floor — the optimiser passes
 *     Tidy's overlap, the shells' floor stage defaults to this placement's own fraction overlap).
 * A slide that cannot prove itself on the real routed geometry returns {} — fractions, never a decoration that
 * breaks more lines than it straightens (measured: a fan-out-heavy design can trade overlap for a straight; the
 * owner's R4 verdict ranks traceability above it).
 */
export function acceptedPortOffsets(
  design: LayoutDesign,
  placement: Placement,
  sizes?: Readonly<Record<string, Size>>,
  overlapFloor?: number,
): PortOffsets {
  const offsets = assignPortOffsets(design, placement, sizes);
  if (Object.keys(offsets).length === 0) return offsets;
  const geoNo = layoutGeometry(design, placement);
  const geoSlide = layoutGeometry(design, placement, undefined, offsets);
  const floor = overlapFloor ?? separationMetrics(geoNo).overlapLen;
  if (straightWireCount(geoSlide) < straightWireCount(geoNo)) return {};
  if (separationMetrics(geoSlide).overlapLen > floor + 1e-6) return {};
  return offsets;
}

/** The tightest gap (px) between two ASSIGNED handles sharing a node side — the port-level `minGap` figure the
 *  benchmark gates on (≥ {@link MIN_PORT_GAP} by construction; Infinity when no side holds two assigned ports). */
export function minAssignedPortGap(design: LayoutDesign, offsets: PortOffsets): number {
  const ports = designPorts(design);
  let min = Infinity;
  for (const node of design.nodes) {
    const assigned = offsets[node.id];
    if (assigned === undefined) continue;
    for (const side of ['in', 'out'] as const) {
      const ys = onSide(ports.get(node.id) ?? [], side)
        .map((p) => assigned[portOffsetKey(side, p.name)])
        .filter((v): v is number => v !== undefined);
      for (let i = 1; i < ys.length; i++) min = Math.min(min, ys[i]! - ys[i - 1]!);
    }
  }
  return min;
}

