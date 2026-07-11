// @algorithm Seeded coverage-axis instance generation (solver-contract problems)
// @problem The hand-checked conformance corpus pins obvious answers but not the SHAPE space a real
//   solver meets; the differential suite needs many random-but-reproducible problems whose SAT/UNSAT
//   regime is true by construction, aimed at the corners random sampling rarely hits.
// @approach A self-contained mulberry32 PRNG (rngOf — deterministic across Node and browser, seeds
//   are inputs, no Date/Math.random) drives per-coverage-axis planners (boundary, magnitude, depth,
//   multiband, transforms, zero-traffic, latency, class, budget, scale, objective-tie, declined-*):
//   each computes the exact achievable capacity/ceiling analytically so floors land exactly on or
//   off the edge as the axis demands.
// @complexity Per instance linear in tier count (up to ~100 for depth axes); the whole corpus is a
//   fixed seeded batch.
// @citations Property-based generation discipline (QuickCheck lineage, Claessen & Hughes 2000);
//   mulberry32 (Tommy Ettinger, public domain).
// @invariants Same seed => same instance, byte-for-byte; generated regimes (sat/unsat/declined) are
//   correct by construction, not by solver opinion; imports ONLY @sda/engine-core (meta-model
//   portability, dependency.test.ts).
// @where-tested engine/solver-contract/src/harness/generator.test.ts,
//   engine/solver-contract/src/harness/harness.test.ts (consumes the corpus)

// THE ORACLE HARNESS — random-design GENERATOR (docs/design/solver-contract.html §4, §7; TASK-79 phase 1,
// hardened phase 3). A seeded, deterministic instance generator that produces solver-contract-level problems —
// graphs + registries + tunables + objectives + bands — at the ENGINE-CORE level, NOT over cloud content. The
// contract is meta-model-portable (dependency.test.ts (A)): this module imports ONLY @sda/engine-core, so it
// generates opaque typed-property graphs whose meaning is nobody's — exactly what a second solver must handle.
//
// WHY generate at all: the phase-0 conformance CORPUS is a handful of hand-checked designs. That pins the
// obvious answers but not the SHAPE space a real solver meets. Phase 1's generated suite fans the incumbent
// (MiniZinc/COIN-BC + clingo — the referee) across many random topologies and regimes; the oracle certifies
// each answer; the candidate solver (TASK-79 phase 2) must match the oracle everywhere. This file makes the
// PROBLEMS; ./oracle makes the ANSWERS; ./harness grades a candidate against them.
//
// THE HARDENING (phase 3): a distillation process COUNTS ON finding gaps, so the generator gained explicit
// COVERAGE AXES that hunt the corners the random baseline rarely lands on (docs §7, owner directive):
//  - `boundary`     — floors placed EXACTLY on the achievable-capacity edge (an ACTIVE constraint at the optimum,
//                     the ULP straddle two exact solvers must still agree across — where phase 2's near-miss lived);
//  - `magnitude`    — extreme rates (up to hundreds of millions) with sub-cent unit costs (float discipline);
//  - `depth`        — deep chains (dozens of nodes), so a per-knob inversion is swept many times;
//  - `multiband`    — several floor SLOs in ONE design (multiple active constraints, still monotone);
//  - `transforms`   — all five flow transforms (ratio/cap/batch/window/prob), not just the baseline ratio/cap;
//  - `zero-traffic` — a degenerate zero-demand source (the flow algebra at 0);
//  - `latency`      — a per-tier LATENCY contribution that ACCUMULATES down the sync path (series 'sum', async
//                     cut) and a latency CEILING on the SLO tier — the rule the app hands the solver whenever a
//                     mean-latency SLO is present (a summed derived value bounded on `out(node, latency)`),
//                     alongside a reachable throughput floor so the design still has a non-trivial cost optimum.
// Plus an OBJECTIVE-TIE probe (two knobs reach the SAME optimum by different splits — the equivalence rule must
// accept it), and a DECLINED class (point bands / a knob coupling a floor↔ceiling) the native solver must
// decline HONESTLY while the incumbent still solves — see ./harness `declinesHonestlyOf`.
//
// SEEDS ARE INPUTS (owner hard rule): no Date.now / Math.random anywhere. Every instance carries the integer
// seed that produced it, so a divergence is reproduced by re-generating that one instance. The base seed is an
// input too (CorpusOptions.baseSeed): a night-loop distiller offsets it to roam DISJOINT instance regions while
// each region stays byte-reproducible. The PRNG is a tiny self-contained mulberry32 — deterministic,
// dependency-free, and identical across Node and the browser (the contract core stays pure, dependency.test.ts (B)).

import {
  applyTransform,
  buildGraph,
  ClassId,
  EdgeId,
  Key,
  NodeId,
  PortId,
  registryOf,
  Unit,
  type Band,
  type Cell,
  type Cycle,
  type Edge,
  type Graph,
  type KeyDef,
  type Node,
  type Port,
  type Registry,
  type Transform,
} from '@sda/engine-core';
import type { Objective, RequestClass, SystemBand, Tunable } from '../capability/optimize';

// ── The generated vocabulary ────────────────────────────────────────────────────────────────────────────
// One flow key (throughput, min-aggregated, transform-bearing) and one summed cost key — the SAME shape the
// conformance corpus uses, so the incumbent evaluates a generated graph exactly as it evaluates the corpus.
// Kept private constants (not re-exported) so the generated designs share one registry the oracle also binds.

/** The flow key every generated design carries: min-aggregated down the chain (the bottleneck), and FLOW-
 *  flagged so port/edge transforms act on it. Fan-in SUMs offered load (as the corpus registry does). */
export const THROUGHPUT = Key('throughput');
/** The summed cost key: each sizable tier contributes `capacity · unitCost`; the whole-design cost sums them. */
export const COST = Key('cost');
/** The summed LATENCY key — the SAME algebra the app's `latency` key uses (content registry.ts): it ACCUMULATES
 *  down a synchronous path (`series: 'sum'`) and an async hop CUTS the caller's wait (`onAsyncEdge: 'cut'`). Carried
 *  ONLY by the `latency` axis (below), so a design bears a per-tier latency contribution the cell network sums to a
 *  path total the SLO tier then bounds with a ceiling — the rule the app hands the solver whenever a mean-latency
 *  SLO is present (search.ts `bandsOf` hard-constrains it on `out(node, latency)`), now exercised by BOTH solvers. */
export const LATENCY = Key('latency');

/** The generated registry — the ONE registry the oracle binds at construction. Identical algebra to the
 *  conformance corpus (throughput min/flow, cost sum, latency sum/cut) so a generated graph is a superset of the
 *  corpus shape and every rule the app hands the solver is exercisable here. */
export const generatedRegistry: Registry = registryOf([
  { key: THROUGHPUT, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'min', fanIn: 'sum', onAsyncEdge: 'cut', flow: true }, kind: 'derived' },
  { key: COST, unit: Unit('USD'), band: 'minTargetMax', aggregate: { series: 'sum', onAsyncEdge: 'cut' }, kind: 'derived' },
  { key: LATENCY, unit: Unit('ms'), band: 'minTargetMax', aggregate: { series: 'sum', onAsyncEdge: 'cut' }, kind: 'derived' },
] satisfies KeyDef[]);

// ── The seeded PRNG (mulberry32) ────────────────────────────────────────────────────────────────────────
// A 32-bit deterministic generator: same seed ⇒ same stream, on any platform. Small and pure by design — the
// contract core may not pull in a runtime dependency (dependency.test.ts (B)), and a property suite that owns
// its randomness needs no more than this. Exposed as a stateful closure so a generator threads one stream.

/** A deterministic random source seeded by a 32-bit integer. `next()` ∈ [0,1); the rest derive from it. */
export interface Rng {
  /** The next float in [0, 1). */
  next(): number;
  /** A uniform integer in [lo, hi] (inclusive both ends). */
  int(lo: number, hi: number): number;
  /** Pick one element of a non-empty array. */
  pick<T>(xs: readonly T[]): T;
  /** A coin flip true with probability `p` (default 0.5). */
  chance(p?: number): boolean;
}

/** Build a mulberry32 RNG from an integer seed. Deterministic and platform-independent (no Date/Math.random). */
export function rngOf(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (xs) => xs[Math.floor(next() * xs.length)]!,
    chance: (p = 0.5) => next() < p,
  };
}

// ── Coverage axes (the shape space the generator spans) ─────────────────────────────────────────────────

/** The three connectivity families the generator covers (TASK-79 phase-1 coverage axes). A `chain` is a
 *  single path (the bottleneck is the min capacity); a `fan-out` broadcasts one source to many sinks; a
 *  `fan-in` converges many sources onto one sink (where offered loads SUM, exercising the fanIn algebra). */
export type Topology = 'chain' | 'fan-out' | 'fan-in';

/** Which contract capability the instance targets — the generator tags each so the oracle and harness route
 *  it to the right question. `optimize`/`repair`/`explain` are numeric MIP searches; `enumerate` is discrete. */
export type Capability = 'evaluate' | 'optimize' | 'repair' | 'explainInfeasible' | 'enumerate';

/** The regime a numeric instance's band tightness targets — so the suite deliberately covers BOTH sides of
 *  the honesty boundary (a proven-SAT design and a proven-UNSAT one), not just the easy feasible case. */
export type Regime = 'sat' | 'unsat';

/**
 * A numeric-instance COVERAGE AXIS (phase-3 hardening). `baseline` is the original random design; the rest bias
 * the generator toward a specific corner the random draw rarely reaches (see the file header). The three
 * `declined-*`/`objective-tie` labels tag purpose-built structural probes, not random families — carried so a
 * failing instance names WHICH hunt produced it. Every axis except `declined-*` stays INSIDE the monotone
 * capacity/flow class, so the native solver and the incumbent MUST still agree on it; the `declined-*` axes are
 * DELIBERATELY outside it (the honest-decline coverage — ./harness `declinesHonestlyOf`).
 */
export type NumericAxis =
  | 'baseline'
  | 'boundary'
  | 'magnitude'
  | 'depth'
  | 'multiband'
  | 'transforms'
  | 'zero-traffic'
  | 'latency'
  | 'class'
  | 'budget'
  | 'scale'
  | 'total-cost'
  | 'generator'
  | 'system-band'
  | 'objective-tie'
  | 'declined-point'
  | 'declined-coupled';

/**
 * One generated NUMERIC instance: a design over the generated registry plus the search parameters. Carries the
 * SEED that produced it (reproducibility) and enough metadata for the harness to name and route it. The band
 * tightness is chosen against the design's own known bottleneck so `regime` is TRUE by construction, giving the
 * suite guaranteed SAT and UNSAT coverage rather than hoping randomness lands on both.
 */
export interface NumericInstance {
  readonly kind: 'numeric';
  readonly seed: number;
  readonly capability: Extract<Capability, 'optimize' | 'repair' | 'explainInfeasible'>;
  /** Which coverage axis produced it (descriptive; `baseline` for the original random family). */
  readonly axis: NumericAxis;
  readonly topology: Topology;
  readonly regime: Regime;
  readonly graph: Graph;
  readonly tunables: readonly Tunable[];
  readonly objective: Objective;
  /** The source's fixed offered load (req/s) — the demand the chain must serve. Metadata for readable names. */
  readonly demand: number;
  /** The known bottleneck capacity ceiling: the max throughput the design can serve with tunables at their
   *  max. A floor SLO above this is provably infeasible; at or below it, feasible. This is what makes `regime`
   *  exact. Purely descriptive — the oracle still PROVES the answer with the real solver; this only labels. */
  readonly ceiling: number;
  /** The declared request classes (doc: request-classes §3) — present ONLY on the `class` axis (a multi-commodity
   *  design over a shared sink). Absent for every other axis, so those instances are the single implicit river,
   *  byte-for-byte as before. Threaded by the oracle into BOTH solvers' requests (harness/oracle.ts). */
  readonly classes?: readonly RequestClass[];
  /** The declared SYSTEM bands (whole-graph sum constraints — a total-cost ceiling on Σ local cost) — present
   *  ONLY on the `system-band` axis. Request-level, NOT a graph band cell (the whole point: no node carries the
   *  whole system's promise). Threaded by the oracle into BOTH solvers' requests (harness/oracle.ts), so the
   *  sum-band class is differential-tested exactly as node bands are. */
  readonly systemBands?: readonly SystemBand[];
}

/**
 * One generated ENUMERATE instance: a discrete selection problem (slots × candidates × compatibility), plus a
 * `regime` labelling whether at least one valid chain exists (`sat`) or the compatibility is empty (`unsat`).
 * Domain-agnostic opaque ids, exactly the shape ./oracle hands to the incumbent's clingo enumerate.
 */
export interface EnumerateInstance {
  readonly kind: 'enumerate';
  readonly seed: number;
  readonly capability: 'enumerate';
  readonly regime: Regime;
  readonly problem: {
    readonly slots: readonly { readonly id: string; readonly candidates: readonly string[] }[];
    readonly adjacencies: readonly (readonly [string, string])[];
    readonly compatible: readonly (readonly [string, string])[];
  };
}

/** A generated instance — either a numeric MIP problem or a discrete enumeration problem. */
export type GeneratedInstance = NumericInstance | EnumerateInstance;

// ── Per-axis parameter pools (the baseline pools are the pre-hardening literals, byte-for-byte) ────────────
// Each pool is drawn from with the SAME rng-draw structure regardless of axis, so a `baseline` design is
// bit-identical to the pre-hardening generator (only the pool CONTENTS differ per axis, never the draw order).

/** Baseline pools — the exact literals the pre-hardening generator drew from. */
const BASE_DEMAND = [200, 500, 800, 1000, 1500, 2000] as const;
const BASE_CAPACITY = [300, 500, 700, 900, 1200, 1600] as const;
const BASE_UNIT_COST = [0.05, 0.1, 0.2] as const;
const BASE_TIER_MAX = [1500, 2000, 3000] as const;

/** Magnitude pools — extreme rates with sub-cent unit costs. tierMax stays under the solvers' 1e9 box bound
 *  (search.ts / minizinc search `BOUND`), and above any offered load a chain/fan-out can present (the SLO
 *  tier's tierMax is additionally lifted to `demand·3`), so the SAT regime is reachable by sizing up. */
const MAG_DEMAND = [2_000_000, 10_000_000, 50_000_000, 200_000_000] as const;
const MAG_CAPACITY = [500_000, 1_500_000, 4_000_000, 10_000_000, 30_000_000] as const;
const MAG_UNIT_COST = [0.0001, 0.0005, 0.001] as const;
const MAG_TIER_MAX = [400_000_000, 800_000_000] as const;

/** Per-tier LATENCY contributions (ms) for the `latency` axis — clean integers so the SUMMED path total is exact
 *  (no transform-shaped fractions), which keeps the SAT ceiling (= the exact accumulated total) an ACTIVE
 *  constraint the two solvers must agree on to the bit, and the UNSAT ceiling (strictly below it) provably
 *  infeasible for both. Latency is a FIXED per-tier config here (the ideal service time) exactly as the app's
 *  engine `latency` is: it does not vary with the throughput knobs, so the ceiling's feasibility is a pure fact
 *  of the topology, and the throughput floor alone drives the cost objective. */
const LATENCY_PER_TIER = [10, 20, 30, 50] as const;

/** The demand pool for an axis (the source's fixed offered load). Baseline is byte-identical to today. */
function demandPoolFor(axis: NumericAxis): readonly number[] {
  if (axis === 'magnitude') return MAG_DEMAND;
  if (axis === 'zero-traffic') return [0]; // a degenerate zero-demand source — the flow algebra at 0
  return BASE_DEMAND;
}

/** The per-tier pools for an axis. Baseline is byte-identical to today. */
function poolsFor(axis: NumericAxis): { readonly capacity: readonly number[]; readonly unitCost: readonly number[]; readonly tierMax: readonly number[] } {
  if (axis === 'magnitude') return { capacity: MAG_CAPACITY, unitCost: MAG_UNIT_COST, tierMax: MAG_TIER_MAX };
  return { capacity: BASE_CAPACITY, unitCost: BASE_UNIT_COST, tierMax: BASE_TIER_MAX };
}

/** The SLO-tier tierMax LIFT for an axis: the tier's own capacity must never be the binding constraint (else
 *  "raise the capacity to meet the floor" is itself impossible). Baseline is EXACTLY 6000 (byte-identical:
 *  demand ≤ 2000, fan-in adds ≤ 4800). Magnitude lifts to `demand·3` (still below the 1e9 solver box bound). */
function sloLiftFor(axis: NumericAxis, demand: number): number {
  if (axis === 'magnitude') return demand * 3;
  return 6000;
}

/** Whether an axis emits flow transforms at all. Only `baseline` (ratio/cap) and `transforms` (all five) do —
 *  the other axes keep clean arithmetic so their boundary/magnitude/depth facts are exact. */
function transformsEnabled(axis: NumericAxis): boolean {
  return axis === 'baseline' || axis === 'transforms';
}

/** Build a per-tier transform, or `undefined`. For `baseline` this is the pre-hardening ratio/cap logic,
 *  BYTE-IDENTICAL (same draws in the same order). For `transforms` it exercises all five kinds — each a
 *  MONOTONE reshaper of the flow (ratio/prob scale, batch divides, cap/window ceil), so the design stays inside
 *  the solver's class. When `eligible` is false NO rng is consumed (short-circuit, exactly as before). */
function makeTransform(rng: Rng, axis: NumericAxis, eligible: boolean): Transform | undefined {
  if (!eligible) return undefined;
  if (axis === 'transforms') {
    if (!rng.chance(0.5)) return undefined;
    const kind = rng.pick(['ratio', 'cap', 'batch', 'window', 'prob'] as const);
    switch (kind) {
      case 'ratio':
        return { kind, value: rng.pick([0.5, 0.8]) };
      case 'cap':
        return { kind, value: rng.pick([600, 900]) };
      case 'batch':
        return { kind, value: rng.pick([2, 4]) }; // out = x / value (an n:1 aggregation)
      case 'window':
        return { kind, value: rng.pick([1, 2]) }; // ceiling 1000/value ⇒ 1000 or 500 req/s
      case 'prob':
        return { kind, value: rng.pick([0.5, 0.7, 0.9]) }; // scalar mean = value · x, value ∈ (0,1]
    }
  }
  // baseline: the original ratio/cap logic (a transform on ~1/3 of eligible tiers), byte-for-byte.
  return rng.chance(0.34)
    ? rng.chance(0.5)
      ? { kind: 'ratio', value: rng.pick([0.5, 0.8]) }
      : { kind: 'cap', value: rng.pick([600, 900]) }
    : undefined;
}

// ── Numeric graph construction ──────────────────────────────────────────────────────────────────────────
// A generated numeric graph is a generalization of the conformance corpus's two-node design: a SOURCE with a
// fixed offered load, feeding one or more sizable TIERS. Each tier carries a throughput-capacity input (the
// freed tunable, in [0, tierMax]), a cost relation (cost = throughput · unitCost), and — on exactly one tier —
// a throughput FLOOR band (the SLO the search must satisfy). The served throughput is the min of the source
// load and the tier capacities along the path (the bottleneck), so the design's ceiling is exactly known.

/** Per-tier parameters. `unitCost` prices its capacity; `tierMax` bounds the freed knob. */
interface Tier {
  readonly id: NodeId;
  readonly inPort: PortId;
  readonly outPort: PortId;
  readonly capacity: number;
  readonly unitCost: number;
  readonly tierMax: number;
  /** An optional per-in-port transform (ratio/cap/batch/window/prob) that reshapes flow as it enters this tier
   *  — a transform-bearing edge (coverage axis). Every kind is monotone in the flow, so the design stays inside
   *  the solver's class. */
  readonly transform?: Transform;
  /** An optional fixed LATENCY contribution (ms) for the `latency` axis — this tier's own service time, which the
   *  cell network SUMS down the sync path. Absent for every other axis (so their draw order is byte-identical). */
  readonly latency?: number;
}

/** The whole generated numeric design, ready to hand to buildGraph, plus the derived facts the instance needs. */
interface DesignPlan {
  readonly nodes: Node[];
  readonly ports: Port[];
  readonly edges: Edge[];
  /** The tiers that are ACTUAL sizable nodes in the graph — hence the freed tunables. This is a SUBSET of the
   *  laid-out tiers: in fan-in only the sink is a sizable node (the others became bare fixed sources), so
   *  declaring a tunable for a non-existent node is exactly the phantom-knob degeneracy that makes a MIP spin.
   *  Keeping this the real node set is what makes the fan-in numeric instances converge deterministically. */
  readonly sizableTiers: readonly Tier[];
  readonly demand: number;
  /** The SLO-bearing tier (where the floor band lives) and the served-throughput ceiling at it. */
  readonly sloTier: Tier;
  readonly ceiling: number;
  /** The `latency` axis only: the EXACT latency accumulated along the sync path to the SLO tier — `out(sloTier,
   *  latency)` = Σ own-latency of the tiers on its path (the source contributes 0). Fixed (independent of the
   *  throughput knobs), so it is the precise number the latency ceiling is set relative to (regime by construction). */
  readonly accumulatedLatency?: number;
  /** The NON-tunable served-throughput cap at the SLO tier: no assignment of the freed tunables (≤ tierMax) can
   *  raise served flow above this, because a fixed source demand / summed load / cap transform holds it down. A
   *  floor ABOVE this is provably infeasible — the exact quantity the UNSAT regime places its floor above. */
  readonly hardCap: number;
}

/** The load SOURCE: a node whose OUT port offers a fixed throughput (the demand) onto the chain — exactly the
 *  corpus's `req` node shape. Without this fixed-input cell the demand would never enter the graph. */
const src = (demand: number): { node: Node; out: PortId; outPort: Port; id: NodeId } => {
  const id = NodeId('src');
  const out = PortId('src.out');
  return {
    id,
    out,
    outPort: { id: out, node: id, dir: 'out' },
    node: { id, ports: [out], cells: [{ kind: 'input', key: THROUGHPUT, value: { kind: 'fixed', quantity: { value: demand, unit: Unit('req/s') } } }] },
  };
};

/**
 * Lay out a numeric design for a topology and axis. Every design has one SOURCE and `tierCount` sizable tiers
 * (up to ~100 for the `depth` axis). The layout differs by topology:
 *  - chain:   src → t0 → t1 → … → t(n-1); bottleneck = min(demand, t0, t1·f1, …) along the single path.
 *  - fan-out: src → t0, src → t1, …; each tier is its own path from the source (independent sinks).
 *  - fan-in:  src0 → t_last, src1 → t_last, …; several sources SUM their load onto the final tier.
 * The SLO floor is placed on the LAST tier (the sink of interest); its served-throughput ceiling is returned.
 * Served throughput uses engine-core `applyTransform` (the single-source transform arithmetic), so the
 * `ceiling`/`hardCap` labels match what the engine computes for EVERY transform kind — the regime stays exact.
 */
function planDesign(rng: Rng, topology: Topology, axis: NumericAxis): DesignPlan {
  const tierCount = axis === 'depth' ? rng.int(60, 100) : rng.int(2, 8); // deep axis: dozens of hops; else 2–8
  const demand = rng.pick(demandPoolFor(axis));
  const pools = poolsFor(axis);
  const canTransform = transformsEnabled(axis);
  const source = src(demand);
  const nodes: Node[] = [];
  const ports: Port[] = [source.outPort];
  const edges: Edge[] = [];

  const tiers: Tier[] = [];

  const makeTier = (i: number, withTransform: boolean): Tier => {
    const id = NodeId(`t${i}`);
    const inPort = PortId(`t${i}.in`);
    const outPort = PortId(`t${i}.out`);
    const rawCapacity = rng.pick(pools.capacity);
    const unitCost = rng.pick(pools.unitCost);
    const tierMax = rng.pick(pools.tierMax);
    // A tier's CURRENT capacity must never exceed its OWN tunable max (the knob's upper bound `tierMax`), else
    // the instance is ILL-POSED: the repair anchor starts OUTSIDE the search box [0, tierMax]. The two solvers
    // then legitimately diverge on an out-of-box start — the incumbent clamps into the box (paying an edit),
    // native leaves the feasible out-of-box current alone (no edit) — a contract UNDER-SPECIFICATION, not a bug
    // in either. Clamping here keeps every generated tunable well-posed (current ∈ [0, tierMax]) so the
    // differential grades only fair problems; the pools alone could draw capacity 1600 above tierMax 1500.
    const capacity = Math.min(rawCapacity, tierMax);
    // A transform-bearing in-port on eligible tiers (coverage axis): ratio/cap (baseline) or all five (transforms).
    const transform: Transform | undefined = makeTransform(rng, axis, withTransform);
    // The `latency` axis draws a fixed per-tier latency LAST (after every baseline draw), so no other axis's rng
    // stream shifts — the latency contribution the cell network will SUM down the path (byte-identical elsewhere).
    const latency: number | undefined = axis === 'latency' ? rng.pick(LATENCY_PER_TIER) : undefined;
    return {
      id,
      inPort,
      outPort,
      capacity,
      unitCost,
      tierMax,
      ...(transform !== undefined ? { transform } : {}),
      ...(latency !== undefined ? { latency } : {}),
    };
  };

  // A sizable tier node: a throughput CAPACITY input (the freed knob) and a linear COST relation. The SLO floor
  // band is NOT added here — finishGraph appends it to the SLO tier so the caller controls its tightness.
  const tierNode = (t: Tier): Node => ({
    id: t.id,
    ports: [t.inPort, t.outPort],
    cells: [
      { kind: 'input', key: THROUGHPUT, value: { kind: 'fixed', quantity: { value: t.capacity, unit: Unit('req/s') } } },
      { kind: 'derived', key: COST, relation: { produces: COST, reads: [THROUGHPUT], expr: `throughput * ${t.unitCost}` } },
      // The `latency` axis: this tier's own fixed latency contribution (a config input), which the network sums
      // down the sync path into `out(tier, latency)`. Omitted for every other axis (no latency cell in play).
      ...(t.latency !== undefined ? [{ kind: 'input' as const, key: LATENCY, value: { kind: 'fixed' as const, quantity: { value: t.latency, unit: Unit('ms') } } }] : []),
    ],
  });

  const tierPorts = (t: Tier): Port[] => [
    t.transform === undefined ? { id: t.inPort, node: t.id, dir: 'in' as const } : { id: t.inPort, node: t.id, dir: 'in' as const, transform: t.transform },
    { id: t.outPort, node: t.id, dir: 'out' as const },
  ];

  for (let i = 0; i < tierCount; i++) tiers.push(makeTier(i, canTransform && i > 0));
  // Lift the SLO tier's tierMax above ANY offered load a topology can present to it (chain/fan-out ≤ demand;
  // fan-in ≤ demand + sources), so its capacity can always be sized to admit the whole arrival. This keeps the
  // SLO tier's own tierMax from ever being the binding constraint — the SAT regime must be reachable by raising
  // the knob, and the UNSAT anchor (`hardCap`) is then a purely NON-tunable arrival cap.
  const sloBase = tiers[tiers.length - 1]!;
  const sloTier: Tier = { ...sloBase, tierMax: Math.max(sloBase.tierMax, sloLiftFor(axis, demand)) };
  tiers[tiers.length - 1] = sloTier;

  // Build the structure per topology and compute two facts:
  //  - `ceiling`   — served throughput at the SLO tier at the design's CURRENT capacities (labels `regime`);
  //  - `hardCap`   — the served flow with every SIZABLE tier's capacity raised to its tierMax, so only the
  //                  NON-tunable constraints (fixed source demand, summed load, cap/ratio transforms) bind.
  //                  A floor above `hardCap` is provably infeasible (no knob reaches it) — the UNSAT anchor.
  // `sizableTiers` is the set of tiers that are real sizable nodes (hence tunable) — a subset in fan-in.
  let ceiling: number;
  let hardCap: number;
  let sizableTiers: readonly Tier[];
  if (topology === 'chain') {
    // src → t0 → t1 → … ; served flow = min over the path of (transform-shaped inflow, capacity). Every tier is
    // sizable. `hardCap` raises each capacity to its tierMax, so only demand + cap/ratio transforms bind.
    let flow = demand;
    let cap = demand;
    let prevOut = source.out;
    tiers.forEach((t, i) => {
      nodes.push(tierNode(t)); // the SLO band is appended later in finishGraph so the caller controls tightness
      ports.push(...tierPorts(t));
      edges.push({ id: EdgeId(`e${i}`), from: prevOut, to: t.inPort, semantics: 'sync' });
      flow = Math.min(applyTransform(t.transform, flow), t.capacity);
      cap = Math.min(applyTransform(t.transform, cap), t.tierMax); // each tier's capacity ≤ its tierMax bounds the cap
      prevOut = t.outPort;
    });
    ceiling = flow;
    hardCap = Math.min(cap, sloTier.tierMax);
    sizableTiers = tiers;
  } else if (topology === 'fan-out') {
    // src → each tier directly; the SLO tier is fed straight from the source (its own path). Every tier sizable.
    tiers.forEach((t, i) => {
      nodes.push(tierNode(t));
      ports.push(...tierPorts(t));
      edges.push({ id: EdgeId(`e${i}`), from: source.out, to: t.inPort, semantics: 'sync' });
    });
    ceiling = Math.min(applyTransform(sloTier.transform, demand), sloTier.capacity);
    hardCap = Math.min(applyTransform(sloTier.transform, demand), sloTier.tierMax); // demand OR the sink tierMax binds
    sizableTiers = tiers;
  } else {
    // fan-in: several fixed SOURCES feed the last tier; their offered loads SUM at its fan-in (fanIn:'sum'). Only
    // the SINK tier is a sizable node — the non-last tiers become bare fixed sources, so the sink is the ONE
    // tunable. The hard cap is the summed offered load (raising the sink capacity cannot exceed what arrives).
    const sinkTier = sloTier;
    nodes.push(tierNode(sinkTier));
    ports.push(...tierPorts(sinkTier));
    edges.push({ id: EdgeId('e0'), from: source.out, to: sinkTier.inPort, semantics: 'sync' });
    // All sources feed the SAME sink in-port, so their offered loads SUM there, and the in-port transform (if
    // any) applies to the TOTAL (the engine transforms the per-port sum — registry note, generatedRegistry).
    let totalOffered = demand;
    for (let i = 0; i < tierCount - 1; i++) {
      const sid = NodeId(`s${i}`);
      const sout = PortId(`s${i}.out`);
      const load = rng.pick([100, 200, 300, 400]);
      nodes.push({ id: sid, ports: [sout], cells: [{ kind: 'input', key: THROUGHPUT, value: { kind: 'fixed', quantity: { value: load, unit: Unit('req/s') } } }] });
      ports.push({ id: sout, node: sid, dir: 'out' });
      edges.push({ id: EdgeId(`e${i + 1}`), from: sout, to: sinkTier.inPort, semantics: 'sync' });
      totalOffered += load;
    }
    const shaped = applyTransform(sinkTier.transform, totalOffered); // in-port transform applied to the summed load
    ceiling = Math.min(shaped, sinkTier.capacity);
    hardCap = Math.min(shaped, sinkTier.tierMax); // the shaped arrival OR the sink tierMax (lifted ≥ arrival) binds
    sizableTiers = [sinkTier];
  }

  nodes.push(source.node);
  // The `latency` axis: the exact accumulated latency at the SLO tier — Σ own-latency along its sync path. A chain
  // sums every tier (the source is 0); a fan-out's SLO tier is fed straight from the source, so only its own
  // latency counts. (The latency axis covers chain + fan-out only, so fan-in never needs this.)
  const accumulatedLatency =
    axis === 'latency'
      ? topology === 'chain'
        ? tiers.reduce((s, t) => s + (t.latency ?? 0), 0)
        : sloTier.latency ?? 0
      : undefined;
  return { nodes, ports, edges, sizableTiers, demand, sloTier, ceiling, hardCap, ...(accumulatedLatency !== undefined ? { accumulatedLatency } : {}) };
}

/**
 * Plan a SCALE-axis design (TASK-86 item 2): a 20–30-node design that MIXES chain + fan-out + fan-in in ONE
 * graph — the shape a real service backbone takes (a chain that fans out to parallel workers which converge on a
 * shared store, then a tail chain), at the node count the CQRS dogfood exposed. Every tier is a sizable knob fed
 * by SOURCE-BOUNDED flow, so the whole design is monotone and separable (the class both solvers prove), and the
 * regime stays exact by construction. No transforms — clean min/sum arithmetic keeps `hardCap` exact.
 *
 *   src → bb0 → … → bb(C-1) ┬─→ br0 ─┐
 *                           ├─→ br1 ─┤ (fan-in SUM onto the sink)
 *                           └─→ brF ─┴─→ sink → tl0 → … → tl(T-1)   [SLO floor on tl(last)]
 *
 * The backbone broadcasts its served flow to EVERY branch (fan-out — each branch sees the full upstream flow);
 * the branches SUM their served flow onto the sink (fan-in); the tail is a plain chain. With every capacity
 * raised, served flow at the SLO tier = F · demand (the fan-in sum), so `hardCap = F · demand` and the sink/tail
 * tierMaxes are lifted above it so only the fan-in sum (a NON-tunable arrival, since the demand is fixed) binds.
 */
function planScale(rng: Rng): DesignPlan {
  const backboneCount = rng.int(8, 11); // the chain backbone (8–11 tiers)
  const branchCount = rng.int(6, 9); //    the fan-out breadth (6–9 parallel branches)
  const tailCount = rng.int(5, 7); //      the tail chain after the fan-in sink (5–7 tiers)
  const demand = rng.pick([80, 120, 160, 200]); // small so the fan-in sum F·demand stays inside the tierMax lift
  const arrival = branchCount * demand; // the summed offered load at the sink (each branch broadcasts `demand`)
  const sinkLift = arrival * 2; // lift the sink/tail/SLO tierMaxes above the arrival so only the arrival binds

  const source = src(demand);
  const nodes: Node[] = [source.node];
  const ports: Port[] = [source.outPort];
  const edges: Edge[] = [];
  const sizable: Tier[] = [];
  let edgeNo = 0;

  // A sizable tier node: a throughput CAPACITY input (the freed knob) + a linear COST relation. No transform, no
  // latency (the scale axis keeps clean arithmetic). `tierMax` bounds the knob; `capacity` is its current value.
  const mkTier = (id: string, capacity: number, tierMax: number): Tier => ({ id: NodeId(id), inPort: PortId(`${id}.in`), outPort: PortId(`${id}.out`), capacity: Math.min(capacity, tierMax), unitCost: rng.pick(BASE_UNIT_COST), tierMax });
  const pushTier = (t: Tier): void => {
    nodes.push({
      id: t.id,
      ports: [t.inPort, t.outPort],
      cells: [
        { kind: 'input', key: THROUGHPUT, value: { kind: 'fixed', quantity: { value: t.capacity, unit: Unit('req/s') } } },
        { kind: 'derived', key: COST, relation: { produces: COST, reads: [THROUGHPUT], expr: `throughput * ${t.unitCost}` } },
      ],
    });
    ports.push({ id: t.inPort, node: t.id, dir: 'in' }, { id: t.outPort, node: t.id, dir: 'out' });
    sizable.push(t);
  };
  const wire = (from: PortId, to: PortId): void => {
    edges.push({ id: EdgeId(`e${edgeNo++}`), from, to, semantics: 'sync' });
  };

  // The backbone chain: src → bb0 → … → bb(C-1). Each tier's capacity ≥ demand (pool ≥ 300 > 200), so the
  // backbone carries the full demand and the source alone bounds it.
  let prevOut = source.out;
  for (let i = 0; i < backboneCount; i++) {
    const t = mkTier(`bb${i}`, rng.pick(BASE_CAPACITY), rng.pick(BASE_TIER_MAX));
    pushTier(t);
    wire(prevOut, t.inPort);
    prevOut = t.outPort;
  }
  const hubOut = prevOut; // the last backbone tier's out — broadcast to every branch

  // The fan-out branches: each fed the FULL backbone output (broadcast), each summing onto the sink.
  const sink = mkTier('sink', rng.pick(BASE_CAPACITY), Math.max(...BASE_TIER_MAX, sinkLift));
  for (let i = 0; i < branchCount; i++) {
    const br = mkTier(`br${i}`, rng.pick(BASE_CAPACITY), rng.pick(BASE_TIER_MAX));
    pushTier(br);
    wire(hubOut, br.inPort); // fan-out: the branch sees the full backbone flow
    wire(br.outPort, sink.inPort); // fan-in: branches SUM onto the sink
  }
  pushTier(sink);

  // The tail chain: sink → tl0 → … → tl(T-1). The LAST tail tier carries the SLO floor; its tierMax is lifted so
  // its own capacity is never the binding constraint (the fan-in arrival is).
  prevOut = sink.outPort;
  let sloTier: Tier = sink;
  for (let i = 0; i < tailCount; i++) {
    const last = i === tailCount - 1;
    const t = mkTier(`tl${i}`, rng.pick(BASE_CAPACITY), last ? Math.max(...BASE_TIER_MAX, sinkLift) : rng.pick(BASE_TIER_MAX));
    pushTier(t);
    wire(prevOut, t.inPort);
    prevOut = t.outPort;
    sloTier = t;
  }

  // Served flow: backbone carries `demand`; each branch broadcasts `demand`; the sink sums to `arrival`; the tail
  // carries `arrival`. `hardCap` raises every capacity so only the fixed arrival binds; `ceiling` is the served
  // flow at the CURRENT capacities (the sink/tail may be under-provisioned, so the SLO needs sizing — a real search).
  const branchServedAtMax = demand; // each branch ≤ its cap, and every cap is raised to tierMax ≥ demand
  const hardCap = Math.min(branchCount * branchServedAtMax, sink.tierMax, sloTier.tierMax);
  const sinkServedNow = Math.min(arrival, sink.capacity);
  const ceiling = Math.min(sinkServedNow, ...sizable.filter((t) => t.id !== sink.id && /^tl/.test(String(t.id))).map((t) => t.capacity), sloTier.capacity);

  return { nodes, ports, edges, sizableTiers: sizable, demand, sloTier, ceiling, hardCap };
}

/** A `minTargetMax` FLOOR band (`min` only) — the SLO shape every generated design carries on its SLO tier. */
const floorBand = (min: number): Band => ({ shape: 'minTargetMax', min });

/** A `minTargetMax` CEILING band (`max` only) — the shape a latency SLO takes (`latency ≤ max`), the `latency`
 *  axis's regime driver on the SLO tier. */
const ceilingBand = (max: number): Band => ({ shape: 'minTargetMax', max });

/** Attach one or more SLO bands to the plan's nodes and finish a validated graph. Each band is a `(node, key,
 *  band)` triple; the plan built the nodes WITHOUT bands so the caller controls tightness (the floor's `min`,
 *  a ceiling's `max`, a `point` target). A key may already have a fixed/derived cell on that node — a band cell
 *  is a pure SLO annotation the network ignores for VALUES (network/build.ts), so a THROUGHPUT floor beside the
 *  THROUGHPUT capacity, or a COST ceiling beside the COST relation, are both well-formed. */
function finishGraph(plan: DesignPlan, bands: readonly { readonly node: NodeId; readonly key: Key; readonly band: Band }[]): Graph {
  const byNode = new Map<NodeId, { readonly key: Key; readonly band: Band }[]>();
  for (const b of bands) {
    const arr = byNode.get(b.node) ?? [];
    arr.push({ key: b.key, band: b.band });
    byNode.set(b.node, arr);
  }
  const nodes = plan.nodes.map((n): Node => {
    const extra = byNode.get(n.id);
    if (extra === undefined) return n;
    const bandCells = extra.map((e): Cell => ({ kind: 'input', key: e.key, value: { kind: 'band', band: e.band } }));
    return { ...n, cells: [...n.cells, ...bandCells] };
  });
  const g = buildGraph({ nodes, ports: plan.ports, edges: plan.edges });
  if (!g.ok) throw new Error(`generated graph is invalid (seed bug): ${JSON.stringify(g.error)}`);
  return g.value;
}

/** The tunables of a plan: each SIZABLE tier's throughput capacity, freed in [0, tierMax] (the knob the search
 *  varies). Sources are NOT tunable — the workload is fixed, per the search-tunables-no-cheating rule. Uses
 *  `sizableTiers` (the real graph nodes), NOT every laid-out tier, so no phantom knob makes the MIP spin. */
function tunablesOf(plan: DesignPlan): Tunable[] {
  return plan.sizableTiers.map((t) => ({ node: t.id, key: THROUGHPUT, min: 0, max: t.tierMax }));
}

/**
 * The SLO FLOOR for a (axis, regime), set RELATIVE to the design's `hardCap` — the served throughput reachable
 * by raising every sizable tier's capacity to its max — so the regime is EXACT by construction:
 *  - baseline & the ordinary axes — sat: a fraction of hardCap (reachable); unsat: strictly above hardCap.
 *  - `boundary` — sat: EXACTLY hardCap (an ACTIVE constraint at the optimum: the served flow sits ON the floor,
 *                 the ULP straddle two exact solvers must still agree across). unsat: a small margin ABOVE
 *                 hardCap, chosen well beyond the MIP's feasibility tolerance so BOTH solvers prove infeasible
 *                 (a 1-ULP gap would read SAT inside COIN-BC's tolerance yet UNSAT for native's strict compare —
 *                 a float artifact, not a finding, so the boundary is approached but not to the last bit).
 *  - `zero-traffic` — sat: 0 (trivially met by a 0-flow design); unsat: 1 (never met — served is 0).
 * The baseline branch consumes exactly ONE rng.pick, in the same position as the pre-hardening generator.
 */
function floorFor(axis: NumericAxis, regime: Regime, plan: DesignPlan, rng: Rng): number {
  if (axis === 'zero-traffic') return regime === 'sat' ? 0 : 1;
  if (axis === 'boundary') {
    return regime === 'sat' ? plan.hardCap : plan.hardCap + Math.max(2, Math.ceil(plan.hardCap * 0.01));
  }
  // The `latency` axis: the throughput floor is REACHABLE in BOTH regimes (a fraction of hardCap), so the SLO
  // tier still has a non-trivial cost optimum to size for — the REGIME is driven by the latency ceiling instead
  // (latencyCeilingFor). A single rng.pick keeps its stream position sane; the value never binds infeasibility.
  if (axis === 'latency') return Math.max(1, Math.floor(plan.hardCap * rng.pick([0.4, 0.6, 0.8])));
  return regime === 'sat'
    ? Math.max(1, Math.floor(plan.hardCap * rng.pick([0.4, 0.6, 0.8]))) // feasible: reachable by sizing up
    : Math.ceil(plan.hardCap * rng.pick([1.2, 1.5, 2]) + 1); // infeasible: strictly above the non-tunable cap
}

/**
 * The latency CEILING (ms) for a `latency`-axis instance, set RELATIVE to the design's EXACT accumulated latency
 * so the regime is EXACT by construction (latency is fixed, independent of the throughput knobs):
 *  - sat:   EXACTLY the accumulated total — an ACTIVE constraint sitting ON the bound (Σ own-latency ≤ that Σ),
 *           the boundary two exact solvers must still agree is FEASIBLE.
 *  - unsat: a margin BELOW the total (10%, ≥ 1 ms), so no knob can reach it (latency does not move with capacity)
 *           and BOTH solvers prove INFEASIBLE, well beyond any MIP tolerance.
 */
function latencyCeilingFor(regime: Regime, accumulated: number): number {
  return regime === 'sat' ? accumulated : Math.max(0, accumulated - Math.max(1, Math.ceil(accumulated * 0.1)));
}

/**
 * Generate one NUMERIC instance for a (capability, topology, regime, axis). The floor band is set by
 * {@link floorFor} so the regime is EXACT by construction (see there). Every axis except `declined-*` stays
 * inside the monotone capacity/flow class, so the native solver and the incumbent MUST agree on it; the
 * `multiband` axis additionally places a SECOND floor SLO on an upstream sizable tier (multiple active
 * constraints, still monotone). The default `axis` is `baseline`, which reproduces the pre-hardening generator
 * bit-for-bit (same rng draws, same values).
 */
export function generateNumeric(
  seed: number,
  capability: NumericInstance['capability'],
  topology: Topology,
  regime: Regime,
  axis: NumericAxis = 'baseline',
): NumericInstance {
  // The CLASS axis is a multi-commodity design (a shape planDesign's single source cannot express), so it has its
  // own builder — delegated here so the corpus loops (which iterate axes uniformly) need no special case. Its
  // HEADROOM sub-population (shared sink provably unsaturated) is the differential; the SATURATED sub-population
  // (the non-monotone boundary native declines) lives in the DECLINED corpus (generateDeclinedCorpus).
  if (axis === 'class') return generateClass(seed, capability, topology, regime, { saturated: false });
  const rng = rngOf(seed);
  // The SCALE axis (TASK-86 item 2) is a 20–30-node chain+fan-out+fan-in MIX, a shape planDesign's single-family
  // layout cannot express, so it has its own builder. Every other axis uses planDesign.
  const plan = axis === 'scale' ? planScale(rng) : planDesign(rng, topology, axis);
  const floor = floorFor(axis, regime, plan, rng);
  const bands: { readonly node: NodeId; readonly key: Key; readonly band: Band }[] = [{ node: plan.sloTier.id, key: THROUGHPUT, band: floorBand(floor) }];
  if (axis === 'latency') {
    // Add a latency CEILING on the SLO tier — the regime driver. `out(sloTier, latency)` is the network's exact
    // summed path total (`plan.accumulatedLatency`); the ceiling sits ON it (sat) or below it (unsat). Both solvers
    // read the SAME `out(sloTier, latency)` off the SAME cell network, so they must agree on which side it lands.
    bands.push({ node: plan.sloTier.id, key: LATENCY, band: ceilingBand(latencyCeilingFor(regime, plan.accumulatedLatency ?? 0)) });
  }
  if (axis === 'multiband') {
    // A SECOND floor on an upstream sizable tier ⇒ MULTIPLE SLOs in one design. Both are floors ⇒ every knob
    // still only ever wants to go UP, so the design stays monotone and native must still match the incumbent.
    // Placed at 0.3·hardCap: reachable at that tier (whose all-max served ≥ hardCap), keeping the SAT regime
    // feasible; in the UNSAT regime the SLO-tier floor above hardCap makes the design infeasible regardless.
    const extra = plan.sizableTiers.find((t) => t.id !== plan.sloTier.id);
    if (extra !== undefined) bands.push({ node: extra.id, key: THROUGHPUT, band: floorBand(Math.max(1, Math.floor(plan.hardCap * 0.3))) });
  }
  if (axis === 'budget') {
    // A cost CEILING alongside the throughput floor — the TASK-86 F1 shape (a "budget" the naive corner witness
    // misreads as a floor↔ceiling coupling and declines). Cost rises with every capacity knob, so the ceiling is
    // relaxed from the OPPOSITE corner to the floor; the loose bound (max unit cost < 1 ⇒ any feasible cost ≤
    // hardCap·#tiers) never binds at the cost-minimising optimum, so the design is FEASIBLE and native must SOLVE
    // it by descending to the floor-optimum and verifying the budget there — matching the incumbent's MIP exactly.
    bands.push({ node: plan.sloTier.id, key: COST, band: { shape: 'minTargetMax', max: Math.ceil(plan.hardCap * plan.sizableTiers.length) + 1000 } });
  }
  // The SYSTEM-BAND axis (owner ruling: cost is for THE WHOLE SYSTEM): the budget axis's twin, but the cost
  // ceiling is a REQUEST-level SYSTEM band on Σ local cost — the whole-graph sum, off-path branches included —
  // never a node band cell. Slack by construction at ANY assignment (each tier's served ≤ its tierMax and every
  // unit cost < 1 ⇒ total cost < Σ tierMax), so the regime stays the floor's: both solvers must accept the sum
  // constraint, native must route it through the budget machinery (excluded witness, verified at the descended
  // optimum) and still MATCH the incumbent (the headroom lesson: a silently-dropped clause reads green — the
  // ENFORCEMENT of a binding system band is pinned by the native unit tests + the CQRS e2e, where it must bite).
  const systemBands: readonly SystemBand[] | undefined =
    axis === 'system-band'
      ? [{ key: COST, ceiling: Math.ceil(plan.sizableTiers.reduce((s, t) => s + t.tierMax, 0)) + 1000 }]
      : undefined;
  const graph = finishGraph(plan, bands);
  // The TOTAL-COST axis (dogfood F8): the objective is the WHOLE-GRAPH total — the sum of every node's own cost —
  // not one node's cumulative out-cell. On a fan-out this is the distinguishing shape: the SLO tier's out-cell
  // prices only ITS branch, so an off-path tier's knob has no single-cell gradient; the total prices them ALL,
  // and both solvers must drive every priced knob to its floor. Every other axis keeps the single-cell objective.
  const objective: Objective =
    axis === 'total-cost' ? { node: plan.sloTier.id, key: COST, direction: 'min', total: true } : { node: plan.sloTier.id, key: COST, direction: 'min' };
  return {
    kind: 'numeric',
    seed,
    capability,
    axis,
    topology,
    regime,
    graph,
    tunables: tunablesOf(plan),
    objective,
    demand: plan.demand,
    ceiling: plan.ceiling,
    ...(systemBands !== undefined ? { systemBands } : {}),
  };
}

/**
 * Generate an OBJECTIVE-TIE probe (phase-3 hardening). Two sizable tiers `a`, `b` are each fed the full demand
 * and SUM their served flow onto a fixed high-capacity sink carrying a throughput floor `total`; both tiers
 * carry the SAME unit cost. Minimising the summed cost then has a TIE: any split `a+b = total` reaches the same
 * optimum `unit·total`, so two exact solvers legitimately pick DIFFERENT knob vectors while agreeing on the
 * objective VALUE — exactly the equivalence the harness compares on (docs §5: objective value, not the vector).
 *  - sat:   `total ≤ 2·tierMax` (reachable by the two knobs) — a proven-feasible tie;
 *  - unsat: `total > 2·tierMax` (beyond both knobs at max) — proven infeasible.
 * Stays inside the monotone class (both knobs only ever want UP for the floor), so native and the incumbent
 * MUST agree.
 */
export function generateObjectiveTie(seed: number, regime: Regime): NumericInstance {
  const rng = rngOf(seed);
  const demand = 2000; // ample: each tier's served = its capacity (capacity ≤ tierMax ≤ demand)
  const tierMax = 1500;
  const unit = rng.pick([0.05, 0.1, 0.2]); // the SAME unit on both tiers ⇒ a genuine tie
  const total = regime === 'sat' ? rng.pick([800, 1400, 2200, 2800]) : 2 * tierMax + rng.pick([200, 500]);

  const source = src(demand);
  const sink = NodeId('sink');
  const sinkIn = PortId('sink.in');
  const mkArm = (name: string): { tier: Tier; nodes: Node[]; ports: Port[]; edges: Edge[] } => {
    const id = NodeId(name);
    const inPort = PortId(`${name}.in`);
    const outPort = PortId(`${name}.out`);
    const tier: Tier = { id, inPort, outPort, capacity: rng.pick([400, 700, 1000]), unitCost: unit, tierMax };
    return {
      tier,
      nodes: [
        {
          id,
          ports: [inPort, outPort],
          cells: [
            { kind: 'input', key: THROUGHPUT, value: { kind: 'fixed', quantity: { value: tier.capacity, unit: Unit('req/s') } } },
            { kind: 'derived', key: COST, relation: { produces: COST, reads: [THROUGHPUT], expr: `throughput * ${unit}` } },
          ],
        },
      ],
      ports: [
        { id: inPort, node: id, dir: 'in' },
        { id: outPort, node: id, dir: 'out' },
      ],
      edges: [
        { id: EdgeId(`e-${name}-in`), from: source.out, to: inPort, semantics: 'sync' },
        { id: EdgeId(`e-${name}-out`), from: outPort, to: sinkIn, semantics: 'sync' },
      ],
    };
  };
  const a = mkArm('a');
  const b = mkArm('b');

  // The sink: a fixed high capacity (never the binding constraint) plus a zero-cost relation so it HAS a summed
  // COST out value (0 local + a.cost + b.cost), and the throughput FLOOR `total` the two arms must jointly meet.
  const sinkCap = 2 * tierMax + 1000; // ≥ any a+b the two knobs can produce
  const sinkNode: Node = {
    id: sink,
    ports: [sinkIn],
    cells: [
      { kind: 'input', key: THROUGHPUT, value: { kind: 'fixed', quantity: { value: sinkCap, unit: Unit('req/s') } } },
      { kind: 'derived', key: COST, relation: { produces: COST, reads: [THROUGHPUT], expr: 'throughput * 0' } },
      { kind: 'input', key: THROUGHPUT, value: { kind: 'band', band: floorBand(total) } },
    ],
  };

  const g = buildGraph({
    nodes: [source.node, ...a.nodes, ...b.nodes, sinkNode],
    ports: [source.outPort, ...a.ports, ...b.ports, { id: sinkIn, node: sink, dir: 'in' }],
    edges: [...a.edges, ...b.edges],
  });
  if (!g.ok) throw new Error(`objective-tie graph is invalid (seed bug): ${JSON.stringify(g.error)}`);

  return {
    kind: 'numeric',
    seed,
    capability: 'optimize',
    axis: 'objective-tie',
    topology: 'fan-in',
    regime,
    graph: g.value,
    tunables: [
      { node: a.tier.id, key: THROUGHPUT, min: 0, max: tierMax },
      { node: b.tier.id, key: THROUGHPUT, min: 0, max: tierMax },
    ],
    objective: { node: sink, key: COST, direction: 'min' },
    demand,
    ceiling: Math.min(sinkCap, a.tier.capacity + b.tier.capacity),
  };
}

/**
 * Generate a DECLINED-class instance (phase-3 hardening): a design DELIBERATELY OUTSIDE the native solver's
 * monotone class, so native must return `did-not-converge` (never a guessed answer) while the incumbent still
 * SOLVES it — the honest-decline coverage graded by ./harness `declinesHonestlyOf`. Two kinds:
 *  - `point`   — a `point` band pins the SLO throughput to a target from BOTH sides. No single relaxing corner
 *                exists, so native declines; the incumbent solves it with an equality constraint (target
 *                reachable ⇒ served = target).
 *  - `coupled` — a throughput FLOOR and a cost CEILING on the SAME tier. Raising that tier's capacity RELAXES
 *                the floor but TIGHTENS the ceiling (one knob, opposing band pressures), so native cannot pick a
 *                universally-relaxing corner and declines. The ceiling is set loose enough that the incumbent's
 *                floor-optimum stays under it, so the incumbent SOLVES (the decline is STRUCTURAL, not about the
 *                ceiling binding).
 * The floor/point target is 0.5·hardCap (reachable), guaranteeing the incumbent is feasible.
 */
export function generateDeclined(
  seed: number,
  capability: NumericInstance['capability'],
  topology: Topology,
  kind: 'point' | 'coupled',
): NumericInstance {
  const rng = rngOf(seed);
  const plan = planDesign(rng, topology, 'baseline'); // baseline-scale structure; the DECLINE comes from the bands
  const target = Math.max(1, Math.floor(plan.hardCap * 0.5)); // reachable ⇒ the incumbent SOLVES it
  const bands: { readonly node: NodeId; readonly key: Key; readonly band: Band }[] =
    kind === 'point'
      ? [{ node: plan.sloTier.id, key: THROUGHPUT, band: { shape: 'point', target } }]
      : [
          { node: plan.sloTier.id, key: THROUGHPUT, band: floorBand(target) },
          // A COST ceiling LOOSE enough to never bind at the floor-optimum (max unit cost < 1 ⇒ any feasible
          // cost ≤ hardCap · #tiers), so the incumbent solves; its mere PRESENCE couples the knob for native.
          { node: plan.sloTier.id, key: COST, band: { shape: 'minTargetMax', max: Math.ceil(plan.hardCap * plan.sizableTiers.length) + 1000 } },
        ];
  const graph = finishGraph(plan, bands);
  return {
    kind: 'numeric',
    seed,
    capability,
    axis: kind === 'point' ? 'declined-point' : 'declined-coupled',
    topology,
    regime: 'sat', // the incumbent finds these feasible (SOLVED); only native declines
    graph,
    tunables: tunablesOf(plan),
    objective: { node: plan.sloTier.id, key: COST, direction: 'min' },
    demand: plan.demand,
    ceiling: plan.ceiling,
  };
}

// ── THE GENERATOR AXIS — generate-driven load at the source (doc: load-stages §4, R1) ────────────────────────
// A design whose DEMAND comes from a GENERATE port function instead of a bare fixed-throughput source: the
// source node carries a finite capacity INPUT plus `generate(level, cycles)` on its out port, so BOTH solvers
// exercise the engine's generator source term (out = min(capacity, through-flow + level) — the config-local
// fold in network/build.ts). The cycles are INERT for the scalar solver (the shape does not cross the scalar
// boundary — load-stages §7), so they only prove the build accepts a shaped generator; the level drives sizing.
// Two lessons ride each seed (load-stages §7 — cost reads the mean, verdicts the peak):
//   • BASELINE (`peak: false`) — the level as declared: the baseline rate drives the sizing;
//   • PEAK (`peak: true`)      — the level × the cycle's peak multiplier k (the derived peak world's arithmetic,
//     baked into the literal here since an engine-level instance has no content cell to override): the worst
//     hour, sustained. Peak scaling is MONOTONE in the level (served = min(cap, in + level) is nondecreasing),
//     so the peak instance's optimal cost can never undercut the baseline's — verified against the native solver
//     in native/index.test.ts, while THIS axis differentials both variants against the incumbent.
// The generator's level is NEVER a tunable (the search-tunables-no-cheating rule extends to generated
// workload): `tunables` covers the sizable tiers only, so no solver can throttle the generated stream.

/** The fixed axis cycle: a daily shape whose PEAK multiplier off the baseline is EXACTLY 1.5 — rational, so
 *  `level × k` stays whole for the even levels the axis draws (exact regimes, no float dust). Inert for the
 *  scalar solver; present only so the build exercises a generator carrying cycles (load-stages §4). */
const GENERATOR_AXIS_CYCLE: Cycle = { periodS: 86_400, stages: [{ durationS: 43_200, multiplier: 1.5 }, { durationS: 43_000, multiplier: 1 }] };
/** The axis's peak multiplier k = 1.5 (the max multiplier off the baseline in the cycle above). */
const GENERATOR_AXIS_PEAK_FACTOR = 1.5;
/** Even levels so `level × 1.5` is whole — the regime anchors stay integer-exact. */
const GENERATOR_LEVELS = [200, 400, 800, 1200] as const;

/** Build a GENERATOR-axis instance (see the section header). `peak` bakes level × k into the generate literal. */
export function generateGeneratorAxis(
  seed: number,
  capability: NumericInstance['capability'],
  topology: Extract<Topology, 'chain' | 'fan-out'>,
  regime: Regime,
  peak: boolean,
): NumericInstance {
  const rng = rngOf(seed);
  const level = rng.pick(GENERATOR_LEVELS);
  const effLevel = peak ? level * GENERATOR_AXIS_PEAK_FACTOR : level; // whole by construction (even level × 1.5)
  const tierCount = rng.int(2, 4);

  // The generator SOURCE: a finite capacity input (config-local — the engine gates the level against it) and the
  // generate port. Capacity 2× the PEAK level, so the full effective level always emits and the tiers alone bind
  // (the capacity is still real: the engine folds min(capacity, level), covered by network/generator.test.ts).
  const genNode = NodeId('gen');
  const genOut = PortId('gen.out');
  const genCapacity = level * GENERATOR_AXIS_PEAK_FACTOR * 2;
  const nodes: Node[] = [
    {
      id: genNode,
      ports: [genOut],
      cells: [{ kind: 'input', key: THROUGHPUT, value: { kind: 'fixed', quantity: { value: genCapacity, unit: Unit('req/s') } } }],
    },
  ];
  const ports: Port[] = [
    { id: genOut, node: genNode, dir: 'out', transform: { kind: 'generate', level: effLevel, cycles: [GENERATOR_AXIS_CYCLE] } },
  ];
  const edges: Edge[] = [];

  // Sizable tiers, baseline pools (no transforms — clean arithmetic keeps hardCap exact). The SLO tier is last;
  // its tierMax is lifted so only the generated arrival binds (the same discipline planDesign uses).
  const tiers: Tier[] = [];
  for (let i = 0; i < tierCount; i++) {
    const id = NodeId(`t${i}`);
    const tierMax = i === tierCount - 1 ? Math.max(...BASE_TIER_MAX, 6000) : rng.pick(BASE_TIER_MAX);
    tiers.push({ id, inPort: PortId(`t${i}.in`), outPort: PortId(`t${i}.out`), capacity: Math.min(rng.pick(BASE_CAPACITY), tierMax), unitCost: rng.pick(BASE_UNIT_COST), tierMax });
  }
  for (const t of tiers) {
    nodes.push({
      id: t.id,
      ports: [t.inPort, t.outPort],
      cells: [
        { kind: 'input', key: THROUGHPUT, value: { kind: 'fixed', quantity: { value: t.capacity, unit: Unit('req/s') } } },
        { kind: 'derived', key: COST, relation: { produces: COST, reads: [THROUGHPUT], expr: `throughput * ${t.unitCost}` } },
      ],
    });
    ports.push({ id: t.inPort, node: t.id, dir: 'in' }, { id: t.outPort, node: t.id, dir: 'out' });
  }
  let ceiling: number;
  let hardCap: number;
  const sloTier = tiers[tiers.length - 1] as Tier;
  if (topology === 'chain') {
    let prevOut = genOut;
    tiers.forEach((t, i) => {
      edges.push({ id: EdgeId(`e${i}`), from: prevOut, to: t.inPort, semantics: 'sync' });
      prevOut = t.outPort;
    });
    ceiling = Math.min(effLevel, ...tiers.map((t) => t.capacity));
    hardCap = Math.min(effLevel, ...tiers.map((t) => t.tierMax));
  } else {
    // fan-out: the generator broadcasts its served level to every tier; the SLO tier sees the full stream.
    tiers.forEach((t, i) => {
      edges.push({ id: EdgeId(`e${i}`), from: genOut, to: t.inPort, semantics: 'sync' });
    });
    ceiling = Math.min(effLevel, sloTier.capacity);
    hardCap = Math.min(effLevel, sloTier.tierMax);
  }
  const floor =
    regime === 'sat'
      ? Math.max(1, Math.floor(hardCap * rng.pick([0.4, 0.6, 0.8]))) // reachable by sizing the tiers up
      : Math.ceil(hardCap * rng.pick([1.2, 1.5, 2]) + 1); // above the generated arrival — no knob reaches it
  const bandCells: Cell[] = [{ kind: 'input', key: THROUGHPUT, value: { kind: 'band', band: floorBand(floor) } }];
  const withBand = nodes.map((nd): Node => (nd.id === sloTier.id ? { ...nd, cells: [...nd.cells, ...bandCells] } : nd));

  const g = buildGraph({ nodes: withBand, ports, edges });
  if (!g.ok) throw new Error(`generator-axis graph is invalid (seed bug): ${JSON.stringify(g.error)}`);

  return {
    kind: 'numeric',
    seed,
    capability,
    axis: 'generator',
    topology,
    regime,
    graph: g.value,
    // The sizable tiers ONLY — the generator's level (and its host capacity) is FROZEN workload, never a knob.
    tunables: tiers.map((t) => ({ node: t.id, key: THROUGHPUT, min: 0, max: t.tierMax })),
    objective: { node: sloTier.id, key: COST, direction: 'min' },
    demand: effLevel,
    ceiling,
  };
}

// ── THE CLASS AXIS — multi-commodity flows over a shared sink (doc: request-classes §5) ──────────────────────
// A multi-class instance: a PRIMARY class flows down a 2-tier chain (its two freed knobs) into a SHARED SINK, and
// 1–2 BACKGROUND classes inject fixed load straight into that same sink. Every class is acyclic on its OWN wires;
// the sink is where they CONTEND for one finite capacity (the processor-sharing split, §4.1). Two sub-populations,
// exactly the two the solver story splits on (§5.2):
//   • HEADROOM   (saturated:false) — the sink's capacity is 3× the total injected load, so it is PROVABLY
//                unsaturated at every reachable assignment. The per-class split is the identity (served = offered),
//                the design is separable and monotone, and BOTH solvers agree — the DIFFERENTIAL. The MIP reads the
//                psSplit linearised to `min(cap, offered)` (search.ts); the JS psSplit gives the same value here.
//   • SATURATED  (saturated:true) — the sink's capacity is BELOW the injected load, so total offered crosses it:
//                the non-monotone boundary. The native solver DECLINES (search.ts saturationDeclines); the incumbent
//                still SOLVES the linearised model — the DECLINES-HONESTLY coverage (generateDeclinedCorpus).
// The SLO is a class-blind flow-total FLOOR on the sink (`out(sink, throughput)` = Σ served — the one honest
// class-blind aggregate, §4.1); the OBJECTIVE is the PRIMARY class's own accumulated cost (`out(sink, cost, c0)`,
// a per-class value since a non-flow key has none class-blind). Integer rates/costs keep the shortfalls exact.

/** Build a CLASS-axis instance (see the section header). `saturated` picks the sub-population. */
export function generateClass(
  seed: number,
  capability: NumericInstance['capability'],
  topology: Topology,
  regime: Regime,
  opts: { readonly saturated: boolean },
): NumericInstance {
  const rng = rngOf(seed);
  const classCount = topology === 'fan-out' ? 3 : 2; // 2–3 commodities sharing one sink (fan-out packs the most)
  const tierMax = 2000; // the freed knob's upper bound — comfortably above any injected load (≤ 500) it must pass
  const rps0 = rng.pick([200, 300, 400, 500]); // the PRIMARY class's injected load
  const u0 = rng.pick([0.05, 0.1, 0.2]); // the two primary tiers' unit costs (the objective's gradient)
  const u1 = rng.pick([0.05, 0.1, 0.2]);
  const primaryInit = Math.max(1, Math.floor(rps0 * 0.5)); // the tiers' CURRENT capacity — the repair anchor (below the floor ⇒ a real edit)
  const bgRps: number[] = [];
  for (let i = 1; i < classCount; i++) bgRps.push(rng.pick([100, 200, 300])); // background classes' fixed injected loads
  const totalOrigin = rps0 + bgRps.reduce((s, r) => s + r, 0);
  // The shared sink capacity: 3× the load ⇒ never saturates (headroom); half the load ⇒ reachably saturated.
  const capK = opts.saturated ? Math.max(1, Math.floor(totalOrigin * 0.5)) : totalOrigin * 3;

  const sink = NodeId('sink');
  const sinkIn = PortId('sink.in');
  const nodes: Node[] = [];
  const ports: Port[] = [];
  const edges: Edge[] = [];
  const classes: RequestClass[] = [];

  // The PRIMARY class: origin at p0, chain p0 → p1 → sink; both tiers are freed knobs carrying a linear cost.
  const p0 = NodeId('p0');
  const p1 = NodeId('p1');
  const p0out = PortId('p0.out');
  const p1in = PortId('p1.in');
  const p1out = PortId('p1.out');
  const primaryTier = (id: NodeId, unit: number, out: PortId, inPort?: PortId): void => {
    nodes.push({
      id,
      ports: inPort !== undefined ? [inPort, out] : [out],
      cells: [
        { kind: 'input', key: THROUGHPUT, value: { kind: 'fixed', quantity: { value: primaryInit, unit: Unit('req/s') } } },
        { kind: 'derived', key: COST, relation: { produces: COST, reads: [THROUGHPUT], expr: `throughput * ${unit}` } },
      ],
    });
    ports.push(...(inPort !== undefined ? [{ id: inPort, node: id, dir: 'in' as const }] : []), { id: out, node: id, dir: 'out' as const });
  };
  primaryTier(p0, u0, p0out);
  primaryTier(p1, u1, p1out, p1in);
  edges.push({ id: EdgeId('ep0'), from: p0out, to: p1in, semantics: 'sync' });
  edges.push({ id: EdgeId('ep1'), from: p1out, to: sinkIn, semantics: 'sync' });
  classes.push({ id: ClassId('c0'), edges: [EdgeId('ep0'), EdgeId('ep1')], origins: [{ node: p0, rps: rps0 }] });

  // The BACKGROUND classes: one fixed tier each, injecting straight into the shared sink (their capacity ≥ their
  // load, so each passes its whole origin — the contention lives at the sink, not here).
  bgRps.forEach((rps, i) => {
    const bid = NodeId(`b${i}`);
    const bout = PortId(`b${i}.out`);
    nodes.push({ id: bid, ports: [bout], cells: [{ kind: 'input', key: THROUGHPUT, value: { kind: 'fixed', quantity: { value: rps, unit: Unit('req/s') } } }] });
    ports.push({ id: bout, node: bid, dir: 'out' });
    edges.push({ id: EdgeId(`eb${i}`), from: bout, to: sinkIn, semantics: 'sync' });
    classes.push({ id: ClassId(`c${i + 1}`), edges: [EdgeId(`eb${i}`)], origins: [{ node: bid, rps }] });
  });

  // The SHARED SINK: one fixed capacity (contended across classes) + the class-blind flow-total FLOOR.
  const floor = classFloor(regime, opts.saturated, rps0, bgRps, totalOrigin, capK, rng);
  nodes.push({
    id: sink,
    ports: [sinkIn],
    cells: [
      { kind: 'input', key: THROUGHPUT, value: { kind: 'fixed', quantity: { value: capK, unit: Unit('req/s') } } },
      { kind: 'input', key: THROUGHPUT, value: { kind: 'band', band: floorBand(floor) } },
    ],
  });
  ports.push({ id: sinkIn, node: sink, dir: 'in' });

  const g = buildGraph({ nodes, ports, edges });
  if (!g.ok) throw new Error(`class-axis graph is invalid (seed bug): ${JSON.stringify(g.error)}`);

  return {
    kind: 'numeric',
    seed,
    capability,
    axis: 'class',
    topology,
    regime,
    graph: g.value,
    tunables: [
      { node: p0, key: THROUGHPUT, min: 0, max: tierMax },
      { node: p1, key: THROUGHPUT, min: 0, max: tierMax },
    ],
    // The primary class's accumulated cost — a per-class value (`class: c0`), since cost has no class-blind cell.
    objective: { node: sink, key: COST, direction: 'min', class: ClassId('c0') },
    demand: totalOrigin,
    ceiling: totalOrigin,
    classes,
  };
}

/**
 * The class-axis SLO floor on the shared sink's total served throughput (`out(sink, throughput)` = Σ served), set so
 * the regime / sub-population is exact by construction:
 *  - HEADROOM sat:   Σ background + a reachable fraction of the primary load ⇒ feasible with a non-trivial primary
 *                    cost optimum (both solvers size the two primary knobs to exactly meet it — a clean differential).
 *  - HEADROOM unsat: just ABOVE the total injected load (the sink never saturates, so max served = total offered) ⇒
 *                    provably infeasible for BOTH solvers.
 *  - SATURATED:      half the linearised reachable maximum (Σ min(cap, offered)) ⇒ the incumbent SOLVES it; native
 *                    DECLINES regardless (saturation), so the floor only needs to keep the incumbent feasible.
 */
function classFloor(regime: Regime, saturated: boolean, rps0: number, bgRps: readonly number[], totalOrigin: number, capK: number, rng: Rng): number {
  if (saturated) {
    const reachableMax = Math.min(capK, rps0) + bgRps.reduce((s, r) => s + Math.min(capK, r), 0);
    return Math.max(1, Math.floor(reachableMax * 0.5));
  }
  const bgSum = bgRps.reduce((s, r) => s + r, 0);
  return regime === 'sat' ? bgSum + Math.max(1, Math.floor(rps0 * rng.pick([0.4, 0.6, 0.8]))) : totalOrigin + 1;
}

// ── Enumerate construction ──────────────────────────────────────────────────────────────────────────────
// A random discrete selection problem: `slotCount` slots, each with a few candidate ids, chained by
// adjacencies, with a random compatibility relation. The `sat` regime guarantees at least one valid chain by
// seeding the compatibility with a witness path; the `unsat` regime empties the compatibility (no chain).

/** Generate one ENUMERATE instance. Opaque `sN`/`cN` ids keep it domain-agnostic (dependency.test.ts (C)). */
export function generateEnumerate(seed: number, regime: Regime): EnumerateInstance {
  const rng = rngOf(seed);
  const slotCount = rng.int(2, 4);
  const slots = Array.from({ length: slotCount }, (_, s) => ({
    id: `s${s}`,
    candidates: Array.from({ length: rng.int(2, 3) }, (_, c) => `s${s}c${c}`),
  }));
  const adjacencies = Array.from({ length: slotCount - 1 }, (_, i) => [`s${i}`, `s${i + 1}`] as const);

  if (regime === 'unsat') {
    return { kind: 'enumerate', seed, capability: 'enumerate', regime, problem: { slots, adjacencies, compatible: [] } };
  }

  // SAT: seed a WITNESS path (one candidate per slot, all adjacent pairs compatible), then add random extra
  // compatible pairs. The witness guarantees ≥1 valid chain, so the enumeration is non-empty by construction.
  const witness = slots.map((sl) => rng.pick(sl.candidates));
  const compatible: [string, string][] = [];
  for (let i = 0; i < slotCount - 1; i++) compatible.push([witness[i]!, witness[i + 1]!]);
  // Random extra pairs across adjacent slots (may or may not extend the valid-chain set — the oracle decides).
  for (let i = 0; i < slotCount - 1; i++) {
    for (const a of slots[i]!.candidates) {
      for (const b of slots[i + 1]!.candidates) {
        if (rng.chance(0.4) && !(a === witness[i] && b === witness[i + 1])) compatible.push([a, b]);
      }
    }
  }
  return { kind: 'enumerate', seed, capability: 'enumerate', regime, problem: { slots, adjacencies, compatible } };
}

// ── The corpus builder — a small, CI-sized, deterministic batch across all axes ─────────────────────────

/** Options for {@link generateCorpus}: how many instances per cell, the base seed the whole batch derives from,
 *  and whether to include the phase-3 hardening AXES. Defaults keep the corpus small enough for CI. The base
 *  seed is an INPUT so a night-loop distiller can roam disjoint regions (same base ⇒ byte-identical corpus). */
export interface CorpusOptions {
  /** Instances per (capability, topology, regime) cell of the BASELINE batch. Default 3 ⇒ optimize alone is
   *  3·3·2 = 18. */
  readonly perCell?: number;
  /** The base seed the whole batch derives from — every instance's own seed is `baseSeed + index`. */
  readonly baseSeed?: number;
  /** Include the phase-3 hardening axes (boundary/magnitude/depth/multiband/transforms/zero-traffic + the
   *  objective-tie probe) beyond the baseline batch. Default false ⇒ the pre-hardening baseline corpus, exactly. */
  readonly axes?: boolean;
  /** Instances per (axis, topology, regime) cell when `axes` is set. Default 1 (CI-fast); the DEEP lane raises
   *  it. Only consulted when `axes` is true. */
  readonly perAxis?: number;
}

const NUMERIC_CAPS: readonly NumericInstance['capability'][] = ['optimize', 'repair', 'explainInfeasible'];
const TOPOLOGIES: readonly Topology[] = ['chain', 'fan-out', 'fan-in'];
const REGIMES: readonly Regime[] = ['sat', 'unsat'];

/** Which topologies each hardening axis covers (curated so each axis lands where it is meaningful and the CI
 *  default stays bounded; the DEEP lane multiplies the COUNT via `perAxis`, not this spread). */
const AXIS_TOPOLOGIES: ReadonlyArray<readonly [Exclude<NumericAxis, 'baseline' | 'objective-tie' | 'declined-point' | 'declined-coupled' | 'budget' | 'scale'>, readonly Topology[]]> = [
  ['boundary', ['chain', 'fan-out', 'fan-in']],
  ['magnitude', ['chain', 'fan-out']],
  ['depth', ['chain']],
  ['multiband', ['chain', 'fan-out']],
  ['transforms', ['chain', 'fan-out', 'fan-in']],
  ['zero-traffic', ['chain', 'fan-out']],
  // The latency axis stays on chain + fan-out (the clean accumulation shapes): a chain sums every tier's latency,
  // a fan-out's SLO tier sums only its own. Fan-in's fanIn-sum of latencies would be a topology-dependent total
  // that adds no distinct coverage of the summed-ceiling rule this axis exists to exercise.
  ['latency', ['chain', 'fan-out']],
  // The CLASS axis (doc: request-classes §5): the HEADROOM sub-population — multi-commodity designs whose shared
  // sink stays provably unsaturated, so the native solver SOLVES and matches the incumbent. `topology` sets the
  // class count (fan-out ⇒ 3 commodities, else 2); its shape is the shared-sink builder, not planDesign. The
  // SATURATED sub-population is graded separately (generateDeclinedCorpus), where native must DECLINE.
  ['class', ['chain', 'fan-out', 'fan-in']],
];

/**
 * Build a deterministic corpus spanning every coverage axis: {optimize, repair, explainInfeasible} × {chain,
 * fan-out, fan-in} × {sat, unsat}, plus enumerate × {sat, unsat}, `perCell` instances each. With `axes` set it
 * ALSO appends the phase-3 hardening axes (boundary/magnitude/depth/multiband/transforms/zero-traffic +
 * objective-tie), `perAxis` each. Every instance's seed is `baseSeed + running-index`, so the WHOLE batch is
 * reproduced from the base seed, and any one instance from its own recorded seed. Small by default (~54 numeric
 * + ~6 enumerate) so the oracle can certify the whole batch inside a CI budget; the DEEP lane raises perCell.
 */
export function generateCorpus(opts: CorpusOptions = {}): GeneratedInstance[] {
  const perCell = opts.perCell ?? 3;
  const baseSeed = opts.baseSeed ?? 0x5da79;
  const out: GeneratedInstance[] = [];
  let index = 0;
  for (const capability of NUMERIC_CAPS) {
    for (const topology of TOPOLOGIES) {
      for (const regime of REGIMES) {
        for (let k = 0; k < perCell; k++) {
          out.push(generateNumeric(baseSeed + index, capability, topology, regime));
          index++;
        }
      }
    }
  }
  for (const regime of REGIMES) {
    for (let k = 0; k < perCell; k++) {
      out.push(generateEnumerate(baseSeed + index, regime));
      index++;
    }
  }
  if (opts.axes === true) {
    const perAxis = opts.perAxis ?? 1;
    for (const capability of NUMERIC_CAPS) {
      for (const [axis, topologies] of AXIS_TOPOLOGIES) {
        for (const topology of topologies) {
          for (const regime of REGIMES) {
            for (let k = 0; k < perAxis; k++) {
              out.push(generateNumeric(baseSeed + index, capability, topology, regime, axis));
              index++;
            }
          }
        }
      }
    }
    // The objective-tie probe is optimize-only (its whole point is a tied OPTIMUM) — both regimes, perAxis each.
    for (const regime of REGIMES) {
      for (let k = 0; k < perAxis; k++) {
        out.push(generateObjectiveTie(baseSeed + index, regime));
        index++;
      }
    }
    // The BUDGET axis (TASK-86 F1): a throughput floor + a LOOSE cost ceiling — a cost-like budget the naive corner
    // witness misreads as a floor↔ceiling coupling. Native must now SOLVE it (descend to the floor-optimum, verify
    // the slack budget there) and MATCH the incumbent's MIP. OPTIMIZE + REPAIR only: ExplainInfeasible's one-corner
    // shortfall model cannot place a budget ceiling, so native declines it (graded in the DECLINED corpus instead).
    for (const capability of ['optimize', 'repair'] as const) {
      for (const topology of ['chain', 'fan-out'] as const) {
        for (const regime of REGIMES) {
          for (let k = 0; k < perAxis; k++) {
            out.push(generateNumeric(baseSeed + index, capability, topology, regime, 'budget'));
            index++;
          }
        }
      }
    }
    // The SCALE axis (TASK-86 item 2): a 20–30-node chain+fan-out+fan-in MIX (the CQRS-scale shape). Both solvers
    // must agree across all three capabilities, so the class of realistically-large designs differentials forever.
    for (const capability of NUMERIC_CAPS) {
      for (const regime of REGIMES) {
        for (let k = 0; k < perAxis; k++) {
          out.push(generateNumeric(baseSeed + index, capability, 'chain', regime, 'scale'));
          index++;
        }
      }
    }
    // The TOTAL-COST axis (dogfood F8): OPTIMIZE with the whole-graph total objective ({ total: true } — Σ of every
    // node's own cost) across all three topologies. Fan-out is the distinguishing shape (an off-path tier's cost is
    // invisible to any single out-cell yet priced by the total); chain proves the total coincides with the terminal's
    // cumulative cost there, so the two objective forms agree where they must. Optimize-only: repair/explain carry no
    // objective. Appended AFTER the existing blocks so every prior instance keeps its exact seed (reproducibility).
    for (const topology of TOPOLOGIES) {
      for (const regime of REGIMES) {
        for (let k = 0; k < perAxis; k++) {
          out.push(generateNumeric(baseSeed + index, 'optimize', topology, regime, 'total-cost'));
          index++;
        }
      }
    }
    // The GENERATOR axis (doc: load-curves §3, R1): generate-driven load at the source, MEAN and PEAK variants
    // per cell (the headroom lesson — the worst hour prices higher, never lower; native's monotone assumption).
    // Optimize crosses both topologies; repair/explain take the chain (the fold arithmetic is identical — the
    // extra topology adds no distinct generator coverage there, and the CI batch stays bounded). Appended AFTER
    // every existing block so every prior instance keeps its exact seed (reproducibility).
    for (const capability of NUMERIC_CAPS) {
      for (const topology of capability === 'optimize' ? (['chain', 'fan-out'] as const) : (['chain'] as const)) {
        for (const regime of REGIMES) {
          for (const peak of [false, true]) {
            for (let k = 0; k < perAxis; k++) {
              out.push(generateGeneratorAxis(baseSeed + index, capability, topology, regime, peak));
              index++;
            }
          }
        }
      }
    }
    // The SYSTEM-BAND axis (owner ruling: cost is for THE WHOLE SYSTEM): the budget axis's twin with the cost
    // ceiling as a REQUEST-level system band on Σ local cost (never a node band cell). OPTIMIZE + REPAIR only,
    // chain + fan-out — the same spread as the budget axis (ExplainInfeasible's request carries no system band).
    // Fan-out is the distinguishing shape: an off-path tier's cost is invisible to any node band yet inside the
    // system sum. Appended AFTER every existing block so every prior instance keeps its exact seed.
    for (const capability of ['optimize', 'repair'] as const) {
      for (const topology of ['chain', 'fan-out'] as const) {
        for (const regime of REGIMES) {
          for (let k = 0; k < perAxis; k++) {
            out.push(generateNumeric(baseSeed + index, capability, topology, regime, 'system-band'));
            index++;
          }
        }
      }
    }
  }
  return out;
}

/** Which (kind, topology) pairs the declined corpus covers with EVERY numeric capability. `point` declines on ANY
 *  topology and for every capability (the point band alone is outside the class), so it is the uniform decline
 *  coverage. The `coupled` (budget-ceiling) case is capability-DEPENDENT — optimize/repair now SOLVE it (graded in
 *  the differential `budget` axis) and only ExplainInfeasible still declines — so it is handled separately below. */
const DECLINED_CASES: ReadonlyArray<readonly ['point', Topology]> = [
  ['point', 'chain'],
  ['point', 'fan-out'],
  ['point', 'fan-in'],
];

/** The topologies the EXPLAIN-only `coupled` (budget-ceiling) decline covers. A throughput floor + a cost ceiling
 *  on the same tier: optimize/repair now solve this (the descent verifies the slack budget at the optimum), but
 *  ExplainInfeasible's single-corner shortfall model cannot place a budget ceiling, so it declines honestly while
 *  the incumbent solves — the coupling-decline coverage preserved for the one capability that still needs it. */
const COUPLED_DECLINE_TOPOLOGIES: readonly Topology[] = ['chain', 'fan-out'];

/** The topologies (⇒ class counts) the SATURATED class sub-population covers in the declined corpus. A shared node
 *  at or over its capacity is the non-monotone processor-sharing boundary (doc: request-classes §5.2): native must
 *  DECLINE while the incumbent still SOLVES the linearised model. chain (2 classes) + fan-out (3) keeps it bounded. */
const CLASS_SATURATED_TOPOLOGIES: readonly Topology[] = ['chain', 'fan-out'];

/**
 * Build the DECLINED corpus (phase-3 hardening): {optimize, repair, explainInfeasible} × the declined cases,
 * `perCell` each. These are graded by ./harness `declinesHonestlyOf`, NOT the differential — the native solver
 * must DECLINE them (`did-not-converge`) while the incumbent SOLVES them, so they must be kept OUT of the
 * equivalence batch. A distinct default base seed keeps their seeds from ever colliding with the differential
 * corpus; the base seed is still an INPUT (night-loop roaming).
 */
export function generateDeclinedCorpus(opts: Pick<CorpusOptions, 'perCell' | 'baseSeed'> = {}): NumericInstance[] {
  const perCell = opts.perCell ?? 2;
  const baseSeed = opts.baseSeed ?? 0xdec11;
  const out: NumericInstance[] = [];
  let index = 0;
  for (const capability of NUMERIC_CAPS) {
    for (const [declinedKind, topology] of DECLINED_CASES) {
      for (let k = 0; k < perCell; k++) {
        out.push(generateDeclined(baseSeed + index, capability, topology, declinedKind));
        index++;
      }
    }
  }
  // The EXPLAIN-only `coupled` (budget-ceiling) decline: optimize/repair now SOLVE a budget ceiling (differential
  // `budget` axis), but ExplainInfeasible still declines it — its one-corner shortfall model cannot place a
  // ceiling relaxed from the opposite corner to the floors. The incumbent solves, so this stays declines-honestly.
  for (const topology of COUPLED_DECLINE_TOPOLOGIES) {
    for (let k = 0; k < perCell; k++) {
      out.push(generateDeclined(baseSeed + 0x20000 + index, 'explainInfeasible', topology, 'coupled'));
      index++;
    }
  }
  // The SATURATED class sub-population (doc: request-classes §5.2): a shared sink at/over capacity — the non-
  // monotone processor-sharing boundary. Native must DECLINE (search.ts saturationDeclines) while the incumbent
  // SOLVES the linearised model, exactly the declines-honestly contract, so these belong here, not in the
  // differential. Distinct seed offset so they never collide with the point/coupled declined seeds above.
  for (const capability of NUMERIC_CAPS) {
    for (const topology of CLASS_SATURATED_TOPOLOGIES) {
      for (let k = 0; k < perCell; k++) {
        out.push(generateClass(baseSeed + 0x30000 + index, capability, topology, 'sat', { saturated: true }));
        index++;
      }
    }
  }
  return out;
}
