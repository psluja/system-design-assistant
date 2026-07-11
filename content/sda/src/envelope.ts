// @algorithm Envelope inversion (max demand s.t. SLOs) with exponential-search + bisection referee
// @problem With no declared demand the tool must still answer: how much sustained load can each
//   origin carry with every SLO green, what breaks first as load grows, and where is the queueing
//   knee?
// @approach Per-origin maxRps by solver INVERSION — free the origin's demand key (legal: it is a
//   fact-assumption) and maximize it subject to the SLOs via the injected Optimize capability; the
//   breaking order / joint edge / knee come from a generalized load sweep — exponential search for a
//   bracketing factor, then bisection (40 halvings, ~1e-12) against forward evaluations; the sweep
//   is also the honest fallback when the solver declines the inversion.
// @complexity O(origins) injected optimize calls + O(origins * (log2(FACTOR_CAP) + 40)) forward
//   evaluations for the sweep arms.
// @citations Bisection / exponential search (folklore); the inversion is the no-cheating rule run
//   backwards (docs/design/assumption-model.html §3).
// @invariants Pure and deterministic aside from the injected solver (no clock, no randomness, fixed
//   iteration counts); honest states — no origin => no envelope, broken at zero => maxRps 0, solver
//   decline => sweep fallback, never a guess; native inversion and brute-force edge agree
//   (differential-tested).
// @where-tested content/sda/src/envelope.test.ts, content/sda/src/envelope-des.e2e.test.ts

// @feature Capacity envelope
// @story With no declared demand, see the maximum sustained load each traffic origin can carry with
//   every SLO still green — plus what breaks first, the joint edge and the queueing knee.
// @surfaces mcp (envelope tool, app/mcp/src/assumptions.ts), web (System panel, app/web/src/app.tsx),
//   presenter (app/presenter/src/envelope-view.ts)
// @algorithms content/sda/src/envelope.ts, engine/solver-contract/src/native/search.ts,
//   content/sda/src/queueing.ts
// @docs docs/design/assumption-model.html
// @e2e content/sda/src/envelope-des.e2e.test.ts
// @status shipped

import type { Graph, Key, Registry } from '@sda/engine-core';
import { NodeId } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import type { Optimize } from '@sda/solver-contract';
import { keys } from './registry';
import { instantiate, type Instance, type Manifest, type Wire } from './manifest';
import { nodeQueues } from './queueing';
import { TARGET_UTILIZATION } from './behaviors';
import { NO_ORIGIN_REASON } from './system';
import { originNodes, scaledInstances, type OriginNode } from './sweep';

// THE CAPACITY ENVELOPE (doc: assumption-model §3) — the DEFAULT answer, needing NO declared demand: the maximum
// sustained load each traffic origin can carry with EVERY SLO still green, WHAT breaks first as load grows, and the
// queueing KNEE. It is the boundary of the assumption space along the demand axes, so the simulated surfaces are
// never empty-and-mute.
//
// TWO MECHANISMS, exactly as the doc prescribes:
//   • per-origin maxRps  — the native solver's INVERSION: free the origin's demand (role=fact-assumption, so freeing
//     it is legal — the INVERSE of the no-cheating rule, which fixes demand) and MAXIMISE it subject to the SLOs.
//     `max-demand-s.t.-SLOs` IS `optimize` with the demand key freed and direction:'max'. Bound via the SAME
//     `Optimize` capability the app's Improve uses (injected — content stays solver-agnostic). Because the native
//     model reads the SCALAR forward pass, this is the CAPACITY-limited edge (ρ→1 / a scalar SLO), not the queueing
//     knee (which is separate, below).
//   • breaking order + joint + knee — a generalised LOAD SWEEP (reusing sweep.ts's origin detection + scaling): the
//     first band to flip to `violation` as load grows is the FIRST BREAK; scaling all origins at the current ratio
//     gives the JOINT edge; the offered load where the busiest node's utilisation ρ reaches the headroom line
//     (TARGET_UTILIZATION) is the KNEE — the honest "reality bites here", below the capacity edge.
//
// HONEST STATES (never a guess): no traffic origin ⇒ no envelope (say so — NO_ORIGIN_REASON); a design that
// violates even at zero load ⇒ maxRps 0 (naming the always-broken band); the solver declining the inversion
// (non-monotone / coupled) ⇒ fall back to the sweep, or an honest `unknown` when even the sweep finds no monotone
// edge. PURE + DETERMINISTIC aside from the injected solver: no clock, no randomness, fixed iteration counts.

/** A boxed cap on the freed demand — mirrors the native solver's own BOUND so an unbounded origin (one that meets
 *  no capacity/SLO limit on its path) is detected rather than reported as a meaningless 1e9. */
const BOUND = 1e9;
/** The factor exponential-search ceiling for the brute-force sweep: base·CAP is the largest demand it will probe
 *  before declaring the origin unbounded. */
const FACTOR_CAP = 1e7;
/** Bisection steps for the sweep edge / knee — 40 halvings resolve the factor to ~1e-12 of its range, far tighter
 *  than the integer-rps rounding the result reports. */
const BISECT_STEPS = 40;

const OVERFLOW = String(keys.overflow);

/** A band that gives way at the edge: the node and the key whose SLO first fails as demand grows. */
export interface EnvelopeBreak {
  readonly node: string;
  readonly key: string;
}

/** WHAT the edge is bounded by: `saturation` = the design simply runs out of capacity (the auto overflow≤0 band);
 *  `slo` = a declared SLO fails first (latency/availability/…); `unknown` = the edge could not be computed honestly. */
export type EnvelopeBasis = 'saturation' | 'slo' | 'unknown';

/** One origin's envelope: how far ITS demand can be pushed (others held at base) before an SLO breaks. */
export interface OriginEnvelope {
  readonly node: string;
  /** The demand key scaled — `assumedRps` for a universal source, `throughput` for a client. */
  readonly key: string;
  readonly baseRps: number;
  /** The maximum sustained rps at this origin with every SLO green, or undefined when it cannot be computed honestly. */
  readonly maxRps: number | undefined;
  /** The LOWER edge of the feasible band, present ONLY when a floor SLO (a minimum served rate) makes the design
   *  infeasible below some demand — so the honest envelope is [minRps, maxRps], not [0, maxRps]. Absent = feasible
   *  from zero (the common ceilings-only case). */
  readonly minRps?: number;
  readonly basis: EnvelopeBasis;
  readonly firstBreak: EnvelopeBreak | undefined;
  /** An honest explanation when `maxRps` is undefined or special (unbounded / infeasible / solver declined / a floor
   *  band). */
  readonly note?: string;
}

/** The JOINT envelope: scale ALL origins together at the current ratio — the max TOTAL demand before the first break. */
export interface JointEnvelope {
  readonly origins: readonly string[];
  readonly totalBaseRps: number;
  readonly maxTotalRps: number | undefined;
  /** The lower edge of the joint feasible band (a floor SLO needs load), when one exists. */
  readonly minTotalRps?: number;
  readonly factor: number | undefined;
  readonly basis: EnvelopeBasis;
  readonly firstBreak: EnvelopeBreak | undefined;
}

/** The queueing KNEE: the offered TOTAL load at which the busiest node's utilisation ρ first reaches the headroom
 *  line — where real (queueing) latency starts to run away, below the capacity edge. */
export interface EnvelopeKnee {
  readonly atRps: number;
  readonly node: string;
  readonly utilization: number;
}

/** The whole envelope: per-origin edges, the joint edge (when several origins), and the queueing knee. Empty
 *  (with a `note`) when the design has no traffic origin or does not build — never a fabricated boundary. */
export interface EnvelopeResult {
  readonly perOrigin: readonly OriginEnvelope[];
  readonly joint?: JointEnvelope;
  readonly knee?: EnvelopeKnee;
  readonly note?: string;
}

/** Everything the envelope reads: the design's structure + the registry + the merged catalog — a strict subset of
 *  what any evaluate caller already holds (identical to {@link LoadSweepInput}), plus the injected `optimize`. */
export interface EnvelopeInput {
  readonly instances: readonly Instance[];
  readonly wires: readonly Wire[];
  readonly registry: Registry;
  readonly catalog: Readonly<Record<string, Manifest>>;
}

/** Read a solved value function for a built graph, or null when it does not build/converge. */
function evalValue(catalog: Readonly<Record<string, Manifest>>, instances: readonly Instance[], wires: readonly Wire[], registry: Registry):
  | { value: (id: string, k: Key) => number | undefined; violated: EnvelopeBreak[] }
  | null {
  const g = instantiate(catalog, instances, wires);
  if (!g.ok) return null;
  const ev = evaluate(g.value, registry);
  if (!ev.ok) return null;
  const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
  // The SCALAR forward verdicts — the SAME bands the native model constrains, so the sweep edge and the native
  // inversion agree (they must, for the differential anchor). Sorted (node, key) so a tie at the boundary is
  // resolved deterministically — the reported first break never flickers between runs.
  const violated = ev.value.verdicts
    .filter((v) => v.status === 'violation')
    .map((v) => ({ node: String(v.scope), key: String(v.key) }))
    .sort((a, b) => (a.node === b.node ? cmp(a.key, b.key) : cmp(a.node, b.node)));
  return { value, violated };
}
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The UPPER edge of the feasible demand band over `scaleOrigins` (others held at base): the largest common scale
 *  `factor` at which EVERY SLO still holds, plus the band that breaks just past it. A brute-force forward sweep — the
 *  honest referee for the native inversion, and the mechanism for the joint edge and the breaking order.
 *
 *  Feasibility need NOT start at zero: a design with a throughput/goodput FLOOR SLO (a MINIMUM served rate) is
 *  infeasible at LOW demand and only becomes feasible once demand meets the floor, so the feasible set is a BAND
 *  [D_min, D_max]. The max sustainable demand is D_max — NOT zero. So we first SEEK a feasible seed (0, else probe
 *  upward), then expand to D_max; when the seed is above zero we also bisect the LOWER edge D_min (`minFactor`) so
 *  the caller can report it honestly ("infeasible below X req/s — a floor SLO needs load"). `factor: undefined` ⇒
 *  unbounded; `factor: 0` with a note ⇒ no demand satisfies every SLO (a broken design, not a floor band). */
function sweepEdge(
  input: EnvelopeInput,
  scaleOrigins: readonly OriginNode[],
): { factor: number | undefined; firstBreak: EnvelopeBreak | undefined; minFactor?: number; note?: string } {
  const { instances, wires, catalog, registry } = input;
  const at = (f: number): EnvelopeBreak[] | null => {
    const scaled = scaledInstances(instances, scaleOrigins, f);
    const r = evalValue(catalog, scaled, wires, registry);
    return r === null ? null : r.violated;
  };
  const feasible = (f: number): boolean => {
    const v = at(f);
    return v !== null && v.length === 0;
  };
  const bisect = (feas: number, inf: number): number => {
    let lo = feas;
    let hi = inf;
    for (let i = 0; i < BISECT_STEPS; i++) {
      const mid = (lo + hi) / 2;
      if (feasible(mid)) lo = mid;
      else hi = mid;
    }
    return lo; // the feasible side of the boundary
  };

  // 1. Locate a feasible seed. Zero first (the common ceilings-only case); else probe upward for the first feasible
  //    factor (a floor SLO that demand satisfies once it is met).
  const feasAtZero = feasible(0);
  let seed: number | undefined = feasAtZero ? 0 : undefined;
  if (seed === undefined) {
    let f = 1;
    while (f <= FACTOR_CAP) {
      if (feasible(f)) { seed = f; break; }
      f *= 2;
    }
  }
  if (seed === undefined) {
    // No demand satisfies every SLO — a genuinely infeasible design (an SLO unmet at every probed load), NOT a
    // floor band. Name the band that fails at a representative low probe.
    const v = at(1) ?? at(0) ?? [];
    return { factor: 0, firstBreak: v[0], note: 'no demand satisfies every SLO — an SLO is unmet at every load (fix the SLO or the design first)' };
  }

  // 2. Expand UP from the feasible seed to the first infeasible factor (the capacity/ceiling edge, D_max).
  let lo = seed;
  let f = seed === 0 ? 1 : seed * 2;
  while (feasible(f)) {
    lo = f;
    f *= 2;
    if (f > FACTOR_CAP) return { factor: undefined, firstBreak: undefined }; // unbounded within the probe cap
  }
  const maxFactor = bisect(lo, f);
  const brk = at(f) ?? []; // the bands violated just past the upper edge

  // 3. When the seed was above zero, the design has a LOWER edge too (a floor SLO needs load) — bisect it so the
  //    caller reports "infeasible below D_min" honestly, rather than pretending the whole [0, D_max] is feasible.
  if (!feasAtZero) {
    const minFactor = bisect(seed, 0); // between the feasible seed and infeasible zero → the lower edge D_min
    return { factor: maxFactor, firstBreak: brk[0], minFactor, note: 'a floor SLO requires minimum load — the design is infeasible below the reported lower edge' };
  }
  return { factor: maxFactor, firstBreak: brk[0] };
}

const basisOf = (brk: EnvelopeBreak | undefined): EnvelopeBasis => (brk === undefined ? 'saturation' : brk.key === OVERFLOW ? 'saturation' : 'slo');

/** The ACTUAL total offered load when every origin is scaled by `factor` — the SUM of each origin's rounded rps, the
 *  same integer `scaledInstances` applies (so the reported joint total is the load actually evaluated, never
 *  `round(Σbase · factor)` which drifts by the rounding of each origin). */
const offeredTotal = (origins: readonly OriginNode[], factor: number): number => origins.reduce((s, o) => s + Math.round(o.baseValue * factor), 0);

/** Per-origin max demand via the native INVERSION (doc §3.1): free the origin's demand key, maximise it s.t. the
 *  SLOs. Returns the solved rps, or a kind explaining why not (so the caller can fall back honestly). No headroom is
 *  applied — the envelope is the TRUE edge (ρ→1), not the headroom-safe demand. */
async function nativeMax(graph: Graph, origin: OriginNode, optimize: Optimize): Promise<{ kind: 'solved'; maxRps: number } | { kind: 'unbounded' | 'infeasible' | 'declined' }> {
  const node = NodeId(origin.id);
  const r = await optimize({
    graph,
    tunables: [{ node, key: origin.key, min: 0, max: BOUND }],
    objective: { node, key: origin.key, direction: 'max' },
  });
  if (r.kind === 'infeasible') return { kind: 'infeasible' };
  if (r.kind !== 'solved') return { kind: 'declined' };
  const v = r.value.value(node, origin.key);
  if (v === undefined || !Number.isFinite(v)) return { kind: 'declined' };
  if (v >= BOUND * 0.99) return { kind: 'unbounded' };
  return { kind: 'solved', maxRps: v };
}

/** The queueing knee: bisect the common load factor for the point where the busiest node's ρ reaches the headroom
 *  line (TARGET_UTILIZATION). Monotone (more load ⇒ higher ρ), so the bisection is exact. undefined when no node
 *  ever reaches the line up to the capacity edge (a design with no queueing tier). */
function computeKnee(input: EnvelopeInput, origins: readonly OriginNode[]): EnvelopeKnee | undefined {
  const { instances, wires, catalog, registry } = input;
  const peak = (f: number): { rho: number; node: string } => {
    const scaled = scaledInstances(instances, origins, f);
    const g = instantiate(catalog, scaled, wires);
    if (!g.ok) return { rho: 0, node: '' };
    const ev = evaluate(g.value, registry);
    if (!ev.ok) return { rho: 0, node: '' };
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    let rho = 0;
    let node = '';
    for (const [id, q] of nodeQueues(g.value, value)) {
      if (Number.isFinite(q.rho) && q.rho > rho) {
        rho = q.rho;
        node = id;
      }
    }
    return { rho, node };
  };
  // Exponential search for a factor whose peak ρ reaches the line, then bisect to it.
  let lo = 0;
  let f = 1;
  while (peak(f).rho < TARGET_UTILIZATION) {
    lo = f;
    f *= 2;
    if (f > FACTOR_CAP) return undefined; // no tier ever queues to the headroom line
  }
  let hi = f;
  for (let i = 0; i < BISECT_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (peak(mid).rho < TARGET_UTILIZATION) lo = mid;
    else hi = mid;
  }
  const at = peak(hi);
  if (at.node === '') return undefined;
  return { atRps: offeredTotal(origins, hi), node: at.node, utilization: TARGET_UTILIZATION };
}

/**
 * Compute the capacity envelope of a design (doc: assumption-model §3). PURE aside from the injected `optimize`
 * (the SAME native `Optimize` capability the app binds). With no traffic origin it returns an empty result naming
 * the reason (NO_ORIGIN_REASON) — never a fabricated boundary. Deterministic: the same design always yields the
 * same envelope.
 */
export async function computeEnvelope(input: EnvelopeInput, optimize: Optimize): Promise<EnvelopeResult> {
  const origins = originNodes(input.instances, input.catalog);
  if (origins.length === 0) return { perOrigin: [], note: NO_ORIGIN_REASON };
  const base = instantiate(input.catalog, input.instances, input.wires);
  if (!base.ok) return { perOrigin: [], note: 'design has build errors — resolve those first, then the envelope is computable' };
  const graph = base.value;

  const perOrigin: OriginEnvelope[] = [];
  for (const origin of origins) {
    // The breaking order (and the referee/fallback edge) from the sweep — always computed: it is the source of the
    // FIRST BREAK the native inversion does not report, and the honest fallback when the inversion declines.
    const sweep = sweepEdge(input, [origin]);
    const nm = await nativeMax(graph, origin, optimize);

    let maxRps: number | undefined;
    let minRps: number | undefined;
    let note: string | undefined;
    if (nm.kind === 'solved') {
      maxRps = Math.round(nm.maxRps); // the native inversion is the reported edge (the doc's mechanism)
    } else if (nm.kind === 'unbounded') {
      note = 'unbounded — this origin meets no capacity or SLO limit on its path (wire it to a sized tier to get an edge)';
    } else if (sweep.factor === undefined && sweep.firstBreak === undefined) {
      note = 'unbounded — no capacity or SLO limit binds this origin';
    } else if (sweep.factor === 0 && sweep.note !== undefined) {
      maxRps = 0; // an SLO is unmet at every load (a broken design, not a floor band)
      note = sweep.note;
    } else if (sweep.factor !== undefined) {
      // The solver declined the inversion (a demand knob that both helps a floor and hurts a ceiling is coupled) —
      // fall back to the sweep's honest band edge (D_max), reporting the lower edge when a floor SLO needs load.
      maxRps = Math.round(origin.baseValue * sweep.factor);
      if (sweep.minFactor !== undefined) minRps = Math.round(origin.baseValue * sweep.minFactor);
      note = sweep.note ?? (nm.kind === 'infeasible' ? 'the solver proved the base design infeasible; the sweep edge is reported instead' : 'the solver declined the inversion (non-monotone/coupled); the sweep edge is reported instead');
    } else {
      note = 'the load edge could not be computed honestly (non-monotone) — set the demand manually';
    }

    perOrigin.push({
      node: origin.id,
      key: String(origin.key),
      baseRps: origin.baseValue,
      maxRps,
      ...(minRps !== undefined ? { minRps } : {}),
      basis: maxRps === undefined ? 'unknown' : basisOf(sweep.firstBreak),
      firstBreak: sweep.firstBreak,
      ...(note !== undefined ? { note } : {}),
    });
  }

  const totalBase = origins.reduce((s, o) => s + o.baseValue, 0);
  const result: EnvelopeResult = { perOrigin };

  // The JOINT edge — only meaningful with several origins (with one it is the per-origin edge). Scale them all at the
  // current ratio and find the total demand before the first break.
  let joint: JointEnvelope | undefined;
  if (origins.length > 1) {
    const s = sweepEdge(input, origins);
    joint = {
      origins: origins.map((o) => o.id),
      totalBaseRps: totalBase,
      maxTotalRps: s.factor === undefined ? undefined : offeredTotal(origins, s.factor),
      ...(s.minFactor !== undefined ? { minTotalRps: offeredTotal(origins, s.minFactor) } : {}),
      factor: s.factor,
      basis: s.factor === undefined ? 'unknown' : basisOf(s.firstBreak),
      firstBreak: s.firstBreak,
    };
  }

  const knee = computeKnee(input, origins);
  return {
    ...result,
    ...(joint !== undefined ? { joint } : {}),
    ...(knee !== undefined ? { knee } : {}),
  };
}
