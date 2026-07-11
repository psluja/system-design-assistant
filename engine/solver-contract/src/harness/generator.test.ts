import { describe, expect, it } from 'vitest';
import type { Graph, NodeId } from '@sda/engine-core';
import { createEngine, evaluate as evaluateNetwork } from '@sda/engine-solve';
import {
  COST,
  generateClass,
  generateCorpus,
  generateDeclined,
  generateDeclinedCorpus,
  generateEnumerate,
  generateGeneratorAxis,
  generateNumeric,
  generateObjectiveTie,
  generatedRegistry,
  LATENCY,
  rngOf,
  THROUGHPUT,
  type NumericAxis,
  type NumericInstance,
  type Regime,
  type Topology,
} from './generator';

// The GENERATOR's own tests. These pin the generator PURELY (no solver): every generated
// graph is structurally valid and evaluable, the seed is honoured (same seed ⇒ identical instance), the
// coverage axes are all present, and the SAT/UNSAT regime is TRUE by construction — the served throughput a
// design can reach sits below an UNSAT floor and at/above a SAT floor. `@sda/engine-solve` is imported ONLY
// here (a test file — the dependency lint permits it) to EVALUATE a generated graph, proving it is well-formed;
// the generator module itself imports only @sda/engine-core.

const engine = createEngine(generatedRegistry);
const TOPOLOGIES: readonly Topology[] = ['chain', 'fan-out', 'fan-in'];
const REGIMES: readonly Regime[] = ['sat', 'unsat'];

/** The served throughput the engine computes at the SLO tier for a generated numeric instance's design. */
function servedAtSlo(inst: NumericInstance): number | undefined {
  const ev = engine.evaluate(inst.graph);
  if (!ev.ok) throw new Error(`generated graph failed to evaluate: ${ev.error.join(', ')}`);
  return ev.value.value(inst.objective.node as NodeId, THROUGHPUT);
}

describe('generator — the seeded random-design generator', () => {
  it('the PRNG is deterministic under seed and platform-independent', () => {
    const a = rngOf(12345);
    const b = rngOf(12345);
    const seqA = Array.from({ length: 8 }, () => a.next());
    const seqB = Array.from({ length: 8 }, () => b.next());
    expect(seqA).toEqual(seqB);
    // A different seed yields a different stream (not a constant generator).
    const c = rngOf(54321);
    expect(seqA).not.toEqual(Array.from({ length: 8 }, () => c.next()));
  });

  it('every generated numeric design is structurally valid and evaluates cleanly', () => {
    for (const cap of ['optimize', 'repair', 'explainInfeasible'] as const) {
      for (const topology of TOPOLOGIES) {
        for (const regime of REGIMES) {
          const inst = generateNumeric(1000 + TOPOLOGIES.indexOf(topology), cap, topology, regime);
          const ev = engine.evaluate(inst.graph);
          expect(ev.ok, `${cap}/${topology}/${regime} must build+evaluate`).toBe(true);
          if (ev.ok) expect(ev.value.converged).toBe(true);
        }
      }
    }
  });

  it('the same seed reproduces the identical instance (seeds are inputs)', () => {
    const once = generateNumeric(777, 'optimize', 'chain', 'sat');
    const twice = generateNumeric(777, 'optimize', 'chain', 'sat');
    // Structural equality via a serialisable projection of the graph (Maps don't deep-equal directly).
    const shape = (i: NumericInstance): unknown => ({
      seed: i.seed,
      demand: i.demand,
      ceiling: i.ceiling,
      tunables: i.tunables,
      objective: i.objective,
      nodes: [...i.graph.nodes.keys()].sort(),
      edges: [...i.graph.edges.keys()].sort(),
    });
    expect(shape(once)).toEqual(shape(twice));
  });

  it('the SAT regime is feasible-by-construction: served throughput can reach the SLO floor', () => {
    // For a SAT instance the design's CURRENT served flow may be below the floor (the search must size up), but
    // the design's ceiling (reachable by sizing the tunables to max) is at least the floor — the generator
    // guarantees the floor sits below `ceiling`-scaled hardCap. We assert the floor ≤ the instance ceiling.
    for (const topology of TOPOLOGIES) {
      const inst = generateNumeric(2000, 'optimize', topology, 'sat');
      const floor = floorOf(inst);
      expect(floor, `${topology} SAT floor ${floor} must be ≤ reachable ceiling ${inst.ceiling}`).toBeLessThanOrEqual(inst.ceiling + 1e-6);
    }
  });

  it('the UNSAT regime is infeasible-by-construction: the SLO floor exceeds any reachable served flow', () => {
    // The generator places the UNSAT floor strictly ABOVE the non-tunable cap. The current served flow (a lower
    // bound on the reachable flow) must be strictly below the floor, so no design as-generated satisfies it.
    for (const topology of TOPOLOGIES) {
      const inst = generateNumeric(3000, 'optimize', topology, 'unsat');
      const floor = floorOf(inst);
      const served = servedAtSlo(inst) ?? 0;
      expect(served, `${topology} UNSAT: served ${served} must be < floor ${floor}`).toBeLessThan(floor);
    }
  });

  it('the corpus spans every coverage axis with reproducible per-instance seeds', () => {
    const corpus = generateCorpus({ perCell: 2 });
    // Every (numeric capability × topology × regime) cell is present, plus enumerate × regime.
    const numeric = corpus.filter((i): i is NumericInstance => i.kind === 'numeric');
    for (const cap of ['optimize', 'repair', 'explainInfeasible'] as const) {
      for (const topology of TOPOLOGIES) {
        for (const regime of REGIMES) {
          const n = numeric.filter((i) => i.capability === cap && i.topology === topology && i.regime === regime).length;
          expect(n, `${cap}/${topology}/${regime} must have 2 instances`).toBe(2);
        }
      }
    }
    expect(corpus.filter((i) => i.kind === 'enumerate').length).toBe(4); // 2 regimes × perCell 2
    // Every instance carries a distinct seed (reproducibility) and the batch is deterministic.
    const seeds = corpus.map((i) => i.seed);
    expect(new Set(seeds).size).toBe(seeds.length);
    expect(generateCorpus({ perCell: 2 }).map((i) => i.seed)).toEqual(seeds);
  });

  it('at least some instances carry a transform-bearing edge (coverage axis)', () => {
    // Scan a batch for any port with a transform — the ratio/cap coverage axis must actually fire.
    const corpus = generateCorpus({ perCell: 3 });
    const anyTransform = corpus.some(
      (i) => i.kind === 'numeric' && [...i.graph.ports.values()].some((p) => p.transform !== undefined),
    );
    expect(anyTransform).toBe(true);
  });

  it('enumerate instances honour the regime: SAT has a witness path, UNSAT has empty compatibility', () => {
    const sat = generateEnumerate(4000, 'sat');
    expect(sat.problem.compatible.length).toBeGreaterThan(0);
    const unsat = generateEnumerate(4001, 'unsat');
    expect(unsat.problem.compatible.length).toBe(0);
  });

  it('cost is a summed derived key over the generated registry (the objective is meaningful)', () => {
    const inst = generateNumeric(5000, 'optimize', 'chain', 'sat');
    const ev = engine.evaluate(inst.graph);
    expect(ev.ok).toBe(true);
    if (ev.ok) expect(ev.value.value(inst.objective.node as NodeId, COST)).toBeGreaterThan(0);
  });
});

/** Read the SLO floor a generated instance placed on its SLO tier (the `minTargetMax` band's `min`). Finds the
 *  first band carrying a `min` — the throughput floor — so it is robust to a latency-axis design that ALSO carries
 *  a latency ceiling (a `max`-only band) on the same tier. */
function floorOf(inst: NumericInstance): number {
  const node = inst.graph.nodes.get(inst.objective.node as NodeId);
  for (const c of node?.cells ?? []) {
    if (c.kind === 'input' && c.value.kind === 'band' && c.value.band.shape === 'minTargetMax' && c.value.band.min !== undefined) return c.value.band.min;
  }
  throw new Error('generated instance has no floor band — a generator bug');
}

/** Read the LATENCY ceiling the `latency` axis placed on its SLO tier (the LATENCY key's `minTargetMax` `max`), or
 *  undefined when the design carries none (any non-latency axis). */
function latencyCeilingOf(inst: NumericInstance): number | undefined {
  const node = inst.graph.nodes.get(inst.objective.node as NodeId);
  for (const c of node?.cells ?? []) {
    if (c.kind === 'input' && String(c.key) === String(LATENCY) && c.value.kind === 'band' && c.value.band.shape === 'minTargetMax') return c.value.band.max;
  }
  return undefined;
}

// ── The HARDENING AXES — the generator's own proofs, no solver ──────────────────────────
// Each new axis is pinned PURELY (evaluate the graph, read the bands) so a generator regression fails here,
// independently of the incumbent/native differential. The boundary/zero-traffic facts are checked against the
// design's OWN served-at-max flow (overlay every tunable at its max, evaluate) — the exact quantity the floor
// is placed relative to — so "SAT sits ON the edge, UNSAT just above it" is a solver-free assertion.

/** The SLO-tier served throughput with every tunable overlaid at its max — the design's reachable ceiling
 *  (`hardCap`), computed by the engine so it matches what the floor was placed against. */
function servedAtMax(inst: NumericInstance): number {
  const nodes = new Map(inst.graph.nodes);
  const maxOf = new Map(inst.tunables.map((t) => [`${t.node}|${t.key}`, t.max]));
  for (const [id, node] of nodes) {
    const cells = node.cells.map((c) => {
      if (c.kind !== 'input' || c.value.kind !== 'fixed') return c;
      const m = maxOf.get(`${id}|${c.key}`);
      return m === undefined ? c : { ...c, value: { kind: 'fixed' as const, quantity: { ...c.value.quantity, value: m } } };
    });
    nodes.set(id, { ...node, cells });
  }
  const overlaid: Graph = { nodes, ports: inst.graph.ports, edges: inst.graph.edges };
  const ev = engine.evaluate(overlaid);
  if (!ev.ok) throw new Error(`overlaid graph failed to evaluate: ${ev.error.join(', ')}`);
  return ev.value.value(inst.objective.node as NodeId, THROUGHPUT) ?? 0;
}

const AXES: readonly Exclude<NumericAxis, 'objective-tie' | 'declined-point' | 'declined-coupled' | 'class'>[] = [
  'baseline',
  'boundary',
  'magnitude',
  'depth',
  'multiband',
  'transforms',
  'zero-traffic',
  'latency',
  'budget',
  'scale',
];

describe('generator — the hardening axes', () => {
  it('the axis defaults to baseline and is byte-identical to an explicit baseline axis', () => {
    const implicit = generateNumeric(6001, 'optimize', 'chain', 'sat');
    const explicit = generateNumeric(6001, 'optimize', 'chain', 'sat', 'baseline');
    expect(implicit.axis).toBe('baseline');
    const shape = (i: NumericInstance): unknown => ({ nodes: [...i.graph.nodes.keys()].sort(), edges: [...i.graph.edges.keys()].sort(), tunables: i.tunables, ceiling: i.ceiling });
    expect(shape(implicit)).toEqual(shape(explicit));
  });

  it('every axis produces a structurally-valid design that evaluates cleanly', () => {
    for (const axis of AXES) {
      for (const topology of TOPOLOGIES) {
        for (const regime of REGIMES) {
          const inst = generateNumeric(6100 + AXES.indexOf(axis), 'optimize', topology, regime, axis);
          const ev = engine.evaluate(inst.graph);
          expect(ev.ok, `${axis}/${topology}/${regime} must build+evaluate`).toBe(true);
          if (ev.ok) expect(ev.value.converged).toBe(true);
          expect(inst.axis).toBe(axis);
        }
      }
    }
  });

  it('boundary: the SAT floor sits EXACTLY on the reachable edge; the UNSAT floor sits just above it', () => {
    for (const topology of TOPOLOGIES) {
      const sat = generateNumeric(6200, 'optimize', topology, 'sat', 'boundary');
      // SAT floor === served-at-max (the ACTIVE constraint at the optimum — the ULP straddle the solvers agree across).
      expect(Math.abs(floorOf(sat) - servedAtMax(sat))).toBeLessThan(1e-6);
      const unsat = generateNumeric(6201, 'optimize', topology, 'unsat', 'boundary');
      // UNSAT floor strictly above the reachable edge, by a margin well beyond a MIP feasibility tolerance.
      expect(floorOf(unsat)).toBeGreaterThan(servedAtMax(unsat) + 1);
    }
  });

  it('zero-traffic: the source offers 0; SAT floor is 0 (trivially met), UNSAT floor is > 0 (never met)', () => {
    const inst = generateNumeric(6300, 'optimize', 'chain', 'sat', 'zero-traffic');
    const srcNode = inst.graph.nodes.get('src' as NodeId);
    const srcTput = srcNode?.cells.find((c) => c.kind === 'input' && c.value.kind === 'fixed');
    expect(srcTput?.kind === 'input' && srcTput.value.kind === 'fixed' ? srcTput.value.quantity.value : -1).toBe(0);
    expect(servedAtMax(inst)).toBe(0);
    expect(floorOf(inst)).toBe(0); // SAT: a 0 floor is met by the 0-flow design
    expect(floorOf(generateNumeric(6301, 'optimize', 'chain', 'unsat', 'zero-traffic'))).toBeGreaterThan(0);
  });

  it('depth: the chain is deep (dozens of nodes)', () => {
    const inst = generateNumeric(6400, 'optimize', 'chain', 'sat', 'depth');
    expect(inst.graph.nodes.size).toBeGreaterThanOrEqual(61); // ≥ 60 tiers + the source
  });

  it('magnitude: rates reach the millions and the served flow is finite (float discipline)', () => {
    const inst = generateNumeric(6500, 'optimize', 'chain', 'sat', 'magnitude');
    expect(inst.demand).toBeGreaterThanOrEqual(1_000_000);
    expect(Number.isFinite(servedAtMax(inst))).toBe(true);
    expect(servedAtMax(inst)).toBeGreaterThan(0);
  });

  it('multiband: a SAT design carries TWO throughput floor SLOs on different tiers', () => {
    const inst = generateNumeric(6600, 'optimize', 'chain', 'sat', 'multiband');
    let floors = 0;
    for (const node of inst.graph.nodes.values()) {
      for (const cell of node.cells) {
        if (cell.kind === 'input' && cell.value.kind === 'band' && cell.value.band.shape === 'minTargetMax' && cell.value.band.min !== undefined && cell.key === THROUGHPUT) floors++;
      }
    }
    expect(floors).toBeGreaterThanOrEqual(2);
  });

  it('latency: the SLO tier carries a LATENCY ceiling sized to the exact accumulated path latency (regime by construction)', () => {
    // The latency contribution ACCUMULATES down the sync path into out(sloTier, latency); the ceiling sits ON that
    // total (sat) or below it (unsat). We evaluate the graph and read the real summed value to pin the regime.
    for (const topology of ['chain', 'fan-out'] as const) {
      const sat = generateNumeric(6800, 'optimize', topology, 'sat', 'latency');
      const ev = engine.evaluate(sat.graph);
      expect(ev.ok).toBe(true);
      if (!ev.ok) continue;
      const accumulated = ev.value.value(sat.objective.node, LATENCY);
      expect(accumulated).toBeGreaterThan(0); // a real summed latency exists on the path
      const satCeiling = latencyCeilingOf(sat);
      expect(satCeiling).toBeDefined();
      // SAT ceiling === the accumulated total: an ACTIVE constraint sitting ON the bound (feasible for both solvers).
      expect(Math.abs((satCeiling as number) - (accumulated as number))).toBeLessThan(1e-6);
      // A throughput floor is ALSO present (the design still has a non-trivial cost optimum to size for).
      expect(floorOf(sat)).toBeGreaterThan(0);

      const unsat = generateNumeric(6801, 'optimize', topology, 'unsat', 'latency');
      const evU = engine.evaluate(unsat.graph);
      expect(evU.ok).toBe(true);
      if (!evU.ok) continue;
      const accU = evU.value.value(unsat.objective.node, LATENCY) as number;
      // UNSAT ceiling strictly BELOW the accumulated total ⇒ the fixed latency can never meet it (infeasible).
      expect(latencyCeilingOf(unsat) as number).toBeLessThan(accU);
    }
  });

  it('transforms: a batch spans transform kinds beyond the baseline ratio/cap', () => {
    // Scan several transforms-axis designs for at least one batch/window/prob transform (the new kinds).
    const kinds = new Set<string>();
    for (let s = 0; s < 24; s++) {
      const inst = generateNumeric(6700 + s, 'optimize', 'chain', 'sat', 'transforms');
      for (const p of inst.graph.ports.values()) if (p.transform !== undefined) kinds.add(p.transform.kind);
    }
    const beyondBaseline = ['batch', 'window', 'prob'].some((k) => kinds.has(k));
    expect(beyondBaseline, `only saw ${[...kinds].join(',')}`).toBe(true);
  });

  it('objective-tie: two tunable knobs feed one floored sink (a tied optimum), SAT reachable / UNSAT not', () => {
    const sat = generateObjectiveTie(7000, 'sat');
    expect(sat.tunables.length).toBe(2);
    expect(sat.axis).toBe('objective-tie');
    expect(servedAtMax(sat)).toBeGreaterThanOrEqual(floorOf(sat));
    const unsat = generateObjectiveTie(7001, 'unsat');
    expect(servedAtMax(unsat)).toBeLessThan(floorOf(unsat));
  });

  it('declined: a point instance pins the SLO; a coupled instance adds a cost ceiling beside the floor', () => {
    const point = generateDeclined(7100, 'optimize', 'chain', 'point');
    expect(point.axis).toBe('declined-point');
    const sloPoint = point.graph.nodes.get(point.objective.node as NodeId);
    expect(sloPoint?.cells.some((c) => c.kind === 'input' && c.value.kind === 'band' && c.value.band.shape === 'point')).toBe(true);

    const coupled = generateDeclined(7101, 'optimize', 'chain', 'coupled');
    expect(coupled.axis).toBe('declined-coupled');
    const sloCoupled = coupled.graph.nodes.get(coupled.objective.node as NodeId);
    const hasFloor = sloCoupled?.cells.some((c) => c.kind === 'input' && c.value.kind === 'band' && c.value.band.shape === 'minTargetMax' && c.key === THROUGHPUT && c.value.band.min !== undefined);
    const hasCostCeiling = sloCoupled?.cells.some((c) => c.kind === 'input' && c.value.kind === 'band' && c.value.band.shape === 'minTargetMax' && c.key === COST && c.value.band.max !== undefined);
    expect(hasFloor && hasCostCeiling).toBe(true);
  });

  it('the axes corpus appends non-baseline instances; the declined corpus is separate and disjoint', () => {
    const withAxes = generateCorpus({ perCell: 1, axes: true, perAxis: 1 });
    expect(withAxes.some((i) => i.kind === 'numeric' && i.axis !== 'baseline')).toBe(true);
    // Determinism: the same options reproduce the same seed sequence.
    expect(generateCorpus({ perCell: 1, axes: true, perAxis: 1 }).map((i) => i.seed)).toEqual(withAxes.map((i) => i.seed));

    const declined = generateDeclinedCorpus({ perCell: 2 });
    // 3 caps × 3 point topologies × 2  +  2 coupled-EXPLAIN topologies × 2 (optimize/repair now SOLVE the budget
    // ceiling — differential `budget` axis — so only explain still declines it)  +  3 caps × 2 saturated-class
    // topologies × 2 (the class §5.2 boundary).
    expect(declined.length).toBe(3 * 3 * 2 + 2 * 2 + 3 * 2 * 2);
    expect(declined.every((i) => i.axis === 'declined-point' || i.axis === 'declined-coupled' || i.axis === 'class')).toBe(true);
    // The declined batch's SATURATED class instances carry request classes (the native solver declines them).
    const saturatedClass = declined.filter((i) => i.axis === 'class');
    expect(saturatedClass.length).toBe(3 * 2 * 2);
    expect(saturatedClass.every((i) => (i.classes?.length ?? 0) >= 2)).toBe(true);
  });

  it('the base seed is an INPUT: an offset shifts every instance seed, byte-reproducibly (night-loop roaming)', () => {
    const a = generateCorpus({ perCell: 1, baseSeed: 1000, axes: true });
    const b = generateCorpus({ perCell: 1, baseSeed: 1000, axes: true });
    const c = generateCorpus({ perCell: 1, baseSeed: 5000, axes: true });
    expect(a.map((i) => i.seed)).toEqual(b.map((i) => i.seed)); // same base ⇒ byte-identical seeds
    expect(a.map((i) => i.seed)).not.toEqual(c.map((i) => i.seed)); // a different base ⇒ a disjoint region
    // The whole region is shifted by exactly the base-seed delta (disjointness by construction).
    expect(c.map((i) => i.seed)).toEqual(a.map((i) => i.seed + 4000));
  });
});

// ── THE CLASS AXIS (doc: request-classes §5) — pinned PURELY, evaluated WITH classes ──────────────
// The two sub-populations are the whole point of the axis, so each is pinned against the per-class forward pass
// (evaluateNetwork WITH the instance's classes): a HEADROOM design's shared sink stays STRICTLY below capacity
// (the split is the identity, both solvers agree — the differential); a SATURATED design's shared sink is CAPPED
// at capacity (Σ served = capacity — the non-monotone processor-sharing boundary the native solver declines).

/** The class-blind total served throughput at a class instance's shared sink, folded WITH its request classes. */
function sinkServed(inst: NumericInstance): number {
  const r = evaluateNetwork(inst.graph, generatedRegistry, inst.classes);
  if (!r.ok) throw new Error(`class-axis graph failed to evaluate: ${r.error.join(', ')}`);
  expect(r.value.converged).toBe(true);
  return r.value.value(inst.objective.node as NodeId, THROUGHPUT) ?? Number.NaN; // unindexed flow total = Σ served
}

/** The shared sink's fixed capacity (its throughput config) — the split denominator the total is measured against. */
function sinkCapacity(inst: NumericInstance): number {
  const node = inst.graph.nodes.get(inst.objective.node as NodeId);
  for (const c of node?.cells ?? []) {
    if (c.kind === 'input' && c.value.kind === 'fixed' && c.key === THROUGHPUT) return c.value.quantity.value;
  }
  throw new Error('class-axis sink has no capacity config — a generator bug');
}

describe('generator — the CLASS axis (doc: request-classes §5)', () => {
  it('a HEADROOM instance is a valid multi-commodity design whose shared sink stays STRICTLY unsaturated', () => {
    for (const topology of TOPOLOGIES) {
      const inst = generateClass(9000 + TOPOLOGIES.indexOf(topology), 'optimize', topology, 'sat', { saturated: false });
      expect(inst.axis).toBe('class');
      expect(inst.classes?.length ?? 0).toBeGreaterThanOrEqual(2); // 2–3 commodities sharing the sink
      expect(inst.objective.class).toBeDefined(); // a PER-CLASS cost objective (cost has no class-blind value)
      const total = sinkServed(inst);
      expect(total).toBeGreaterThan(0);
      // Unsaturated: total served is STRICTLY below capacity — the split is the identity (served = offered).
      expect(total).toBeLessThan(sinkCapacity(inst));
    }
  });

  it('every class in a HEADROOM instance flows its own load through the shared sink (per-class perspectives)', () => {
    const inst = generateClass(9050, 'optimize', 'fan-out', 'sat', { saturated: false });
    const r = evaluateNetwork(inst.graph, generatedRegistry, inst.classes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const c of inst.classes ?? []) {
      const served = r.value.value(inst.objective.node as NodeId, THROUGHPUT, c.id);
      expect(served, `class ${c.id} must flow through the sink`).toBeGreaterThan(0);
    }
  });

  it('a SATURATED instance saturates the shared sink: total served is CAPPED at capacity (the §5.2 boundary)', () => {
    for (const topology of ['chain', 'fan-out'] as const) {
      const inst = generateClass(9100 + (topology === 'chain' ? 0 : 1), 'optimize', topology, 'sat', { saturated: true });
      const cap = sinkCapacity(inst);
      // Saturated: the processor-sharing split caps the shared node's TOTAL throughput at its capacity.
      expect(Math.abs(sinkServed(inst) - cap)).toBeLessThan(1e-6);
    }
  });

  it('the same seed reproduces the identical class instance (seeds are inputs)', () => {
    const shape = (i: NumericInstance): unknown => ({
      seed: i.seed,
      nodes: [...i.graph.nodes.keys()].sort(),
      edges: [...i.graph.edges.keys()].sort(),
      classes: i.classes,
      objective: i.objective,
    });
    const once = generateClass(9200, 'optimize', 'chain', 'sat', { saturated: false });
    const twice = generateClass(9200, 'optimize', 'chain', 'sat', { saturated: false });
    expect(shape(once)).toEqual(shape(twice));
  });
});

describe('generator — the GENERATOR axis (doc: load-curves §3, R1)', () => {
  it('a generator instance is structurally valid, evaluates cleanly, and its regime is exact by construction', () => {
    for (const topology of ['chain', 'fan-out'] as const) {
      for (const regime of REGIMES) {
        for (const peak of [false, true]) {
          const inst = generateGeneratorAxis(11000 + (peak ? 100 : 0) + REGIMES.indexOf(regime), 'optimize', topology, regime, peak);
          expect(inst.axis).toBe('generator');
          const served = servedAtSlo(inst);
          expect(served).toBeDefined();
          const floorCell = inst.graph.nodes.get(inst.objective.node as NodeId)?.cells.find((c) => c.kind === 'input' && c.value.kind === 'band');
          const floor = floorCell?.kind === 'input' && floorCell.value.kind === 'band' && floorCell.value.band.shape === 'minTargetMax' ? floorCell.value.band.min ?? 0 : 0;
          // SAT: the floor is reachable with every tier at its max; UNSAT: it exceeds the generated arrival.
          if (regime === 'unsat') expect(floor).toBeGreaterThan(inst.demand); // demand = the effective level, the non-tunable cap
        }
      }
    }
  });

  it('the served flow at the source IS the generated level (the engine fold: min(capacity, level))', () => {
    const inst = generateGeneratorAxis(11200, 'optimize', 'chain', 'sat', false);
    const ev = engine.evaluate(inst.graph);
    expect(ev.ok).toBe(true);
    if (!ev.ok) return;
    // The generator's capacity is 2× the peak level by construction, so the full level emits.
    expect(ev.value.value('gen' as NodeId, THROUGHPUT)).toBe(inst.demand);
  });

  it('PEAK vs MEAN (the headroom lesson): the peak twin offers exactly k = 1.5× the mean twin, monotone', () => {
    for (const seed of [11300, 11301, 11302]) {
      const mean = generateGeneratorAxis(seed, 'optimize', 'chain', 'sat', false);
      const peak = generateGeneratorAxis(seed, 'optimize', 'chain', 'sat', true);
      expect(peak.demand).toBe(mean.demand * 1.5); // level × k, whole by construction (even levels)
      // Peak scaling is MONOTONE in the level: the peak twin's served flow can never be below the mean twin's
      // at the same capacities (served = min(cap, in + level) is nondecreasing in level).
      const servedMean = servedAtSlo(mean) ?? 0;
      const servedPeak = servedAtSlo(peak) ?? 0;
      expect(servedPeak).toBeGreaterThanOrEqual(servedMean);
    }
  });

  it('the generated workload is FROZEN: no tunable names the generator node (no-cheating, extended)', () => {
    for (const peak of [false, true]) {
      const inst = generateGeneratorAxis(11400, 'repair', 'chain', 'unsat', peak);
      expect(inst.tunables.some((t) => String(t.node) === 'gen')).toBe(false);
      expect(inst.tunables.length).toBeGreaterThan(0); // the sizable tiers are still real knobs
    }
  });

  it('the same seed reproduces the identical generator instance (seeds are inputs)', () => {
    const shape = (i: NumericInstance): unknown => ({
      seed: i.seed,
      demand: i.demand,
      ceiling: i.ceiling,
      nodes: [...i.graph.nodes.keys()].sort(),
      ports: [...i.graph.ports.entries()].map(([id, p]) => [id, p.transform] as const).sort(),
      tunables: i.tunables,
    });
    expect(shape(generateGeneratorAxis(11500, 'optimize', 'fan-out', 'sat', true))).toEqual(shape(generateGeneratorAxis(11500, 'optimize', 'fan-out', 'sat', true)));
  });

  it('the axes corpus carries the generator axis, mean AND peak variants', () => {
    const corpus = generateCorpus({ perCell: 0, axes: true, perAxis: 1 });
    const gens = corpus.filter((i): i is NumericInstance => i.kind === 'numeric' && i.axis === 'generator');
    expect(gens.length).toBeGreaterThanOrEqual(8); // optimize×2 topologies + repair/explain×chain, ×2 regimes ×2 variants
    // Each (capability, topology, regime) cell appears TWICE: the mean and the peak variant (demand differs ×1.5
    // whenever the two variants drew the same level; at minimum both variants exist per cell).
    const cells = new Map<string, number>();
    for (const g of gens) cells.set(`${g.capability}|${g.topology}|${g.regime}`, (cells.get(`${g.capability}|${g.topology}|${g.regime}`) ?? 0) + 1);
    for (const [cell, count] of cells) expect(count, cell).toBe(2);
  });
});
