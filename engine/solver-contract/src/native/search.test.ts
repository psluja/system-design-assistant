import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { runExplain, runOptimize, runRepair } from './search';
import { corpusObjective, corpusRegistry, corpusTunable, feasibleDesign, infeasibleDesign, violatedDesign, SVC } from '../conformance/corpus';
import { generateNumeric, generatedRegistry, THROUGHPUT, type NumericInstance } from '../harness/generator';

// THE NATIVE SEARCH's own tests — PURE: they exercise the CPU search directly with NO MiniZinc
// and NO clingo, so they are fast and run everywhere. The heavy DIFFERENTIAL proof (native must MATCH the
// incumbent oracle on a generated batch) lives in ./index.test.ts, which wires the real solvers. Here we pin the
// algorithm against the hand-checked corpus, the generated regimes (SAT ⇒ solved, UNSAT ⇒ infeasible), the
// honesty states, determinism, and the interactive-grade per-instance budget.

describe('native search — exactness on the hand-checked corpus (docs §4)', () => {
  it('optimize picks the known cheapest feasible capacity (300 ⇒ cost 30)', () => {
    const r = runOptimize(corpusRegistry, { graph: feasibleDesign(), tunables: [corpusTunable], objective: corpusObjective });
    expect(r.kind).toBe('solved');
    if (r.kind !== 'solved') return;
    expect(r.value.assignments[0]?.value).toBeCloseTo(300, 4);
    expect(r.value.value(SVC, corpusObjective.key)).toBeCloseTo(30, 4);
  });

  it('optimize proves a floor above the max capacity `infeasible` (not did-not-converge)', () => {
    const r = runOptimize(corpusRegistry, { graph: infeasibleDesign(), tunables: [corpusTunable], objective: corpusObjective });
    expect(r.kind).toBe('infeasible');
  });

  it('repair returns the minimal single edit (raise 500 → 800, delta 300)', () => {
    const r = runRepair(corpusRegistry, { graph: violatedDesign(), tunables: [corpusTunable] });
    expect(r.kind).toBe('solved');
    if (r.kind !== 'solved') return;
    expect(r.value).toHaveLength(1);
    expect(r.value[0]?.from).toBe(500);
    expect(r.value[0]?.to).toBeCloseTo(800, 4);
    expect(r.value[0]?.delta).toBeCloseTo(300, 4);
  });

  it('repair on an already-feasible design is an empty edit set', () => {
    const r = runRepair(corpusRegistry, { graph: feasibleDesign(), tunables: [corpusTunable] });
    expect(r.kind).toBe('solved');
    if (r.kind === 'solved') expect(r.value).toEqual([]);
  });

  it('explainInfeasible reports the exact floor shortfall (short by 200)', () => {
    const r = runExplain(corpusRegistry, { graph: infeasibleDesign(), tunables: [corpusTunable] });
    expect(r.kind).toBe('solved');
    if (r.kind !== 'solved') return;
    expect(r.value).toHaveLength(1);
    expect(r.value[0]?.bound).toBe('floor');
    expect(r.value[0]?.amount).toBeCloseTo(200, 4);
  });

  it('explainInfeasible on a feasible design reports no shortfall', () => {
    const r = runExplain(corpusRegistry, { graph: feasibleDesign(), tunables: [corpusTunable] });
    expect(r.kind).toBe('solved');
    if (r.kind === 'solved') expect(r.value).toEqual([]);
  });
});

describe('native search — the generated regimes and honesty states', () => {
  const TOPOLOGIES = ['chain', 'fan-out', 'fan-in'] as const;

  it('optimize: every SAT instance solves, every UNSAT instance is proven infeasible', () => {
    for (const topology of TOPOLOGIES) {
      const sat = generateNumeric(30_000, 'optimize', topology, 'sat');
      const rs = runOptimize(generatedRegistry, { graph: sat.graph, tunables: sat.tunables, objective: sat.objective });
      expect(rs.kind, `${topology} SAT must solve`).toBe('solved');

      const unsat = generateNumeric(30_001, 'optimize', topology, 'unsat');
      const ru = runOptimize(generatedRegistry, { graph: unsat.graph, tunables: unsat.tunables, objective: unsat.objective });
      expect(ru.kind, `${topology} UNSAT must be infeasible`).toBe('infeasible');
    }
  });

  it('repair: SAT solves (a possibly-empty edit set), UNSAT is infeasible', () => {
    for (const topology of TOPOLOGIES) {
      const sat = generateNumeric(31_000, 'repair', topology, 'sat');
      expect(runRepair(generatedRegistry, { graph: sat.graph, tunables: sat.tunables }).kind).toBe('solved');
      const unsat = generateNumeric(31_001, 'repair', topology, 'unsat');
      expect(runRepair(generatedRegistry, { graph: unsat.graph, tunables: unsat.tunables }).kind).toBe('infeasible');
    }
  });

  it('explainInfeasible: UNSAT reports a positive floor shortfall, SAT reports none', () => {
    for (const topology of TOPOLOGIES) {
      const unsat = generateNumeric(32_000, 'explainInfeasible', topology, 'unsat');
      const ru = runExplain(generatedRegistry, { graph: unsat.graph, tunables: unsat.tunables });
      expect(ru.kind).toBe('solved');
      if (ru.kind === 'solved') {
        expect(ru.value.length).toBeGreaterThan(0);
        expect(ru.value.every((s) => s.bound === 'floor' && s.amount > 0)).toBe(true);
      }
      const sat = generateNumeric(32_001, 'explainInfeasible', topology, 'sat');
      const rsat = runExplain(generatedRegistry, { graph: sat.graph, tunables: sat.tunables });
      expect(rsat.kind).toBe('solved');
      if (rsat.kind === 'solved') expect(rsat.value).toEqual([]);
    }
  });

  it('a solved optimize assignment genuinely satisfies the SLO floor (anti-lie)', () => {
    // Re-read served throughput under the returned assignment: it must sit AT or ABOVE the floor, never below —
    // the property the oracle harness checks via `sloSatisfied` (a floor breach would read as a violation).
    const inst = generateNumeric(33_000, 'optimize', 'chain', 'sat');
    const r = runOptimize(generatedRegistry, { graph: inst.graph, tunables: inst.tunables, objective: inst.objective });
    expect(r.kind).toBe('solved');
    if (r.kind !== 'solved') return;
    const floor = floorOf(inst);
    const served = r.value.value(inst.objective.node as NodeId, THROUGHPUT);
    expect(served).toBeDefined();
    expect(served!).toBeGreaterThanOrEqual(floor - 1e-6);
  });
});

describe('native search — the TOTAL objective (whole-graph sum of local contributions, dogfood F8)', () => {
  it('total-cost on a fan-out drives OFF-PATH priced knobs to their floor; the single-cell objective cannot see them', () => {
    // The same fan-out design solved twice: once with the single-cell objective (out(sloTier, COST) — prices only
    // the SLO tier's own branch) and once with the TOTAL objective (Σ of every tier's own cost). The off-path
    // tiers carry no band, so under the TOTAL objective their knobs must descend to their domain minimum (0 ⇒
    // zero served ⇒ zero cost), while the single-cell objective has no gradient on them and leaves them at the
    // witness corner (their max). This is exactly the F8 gap: "minimize TOTAL system cost" was inexpressible.
    const inst = generateNumeric(36_000, 'optimize', 'fan-out', 'sat', 'total-cost');
    expect(inst.objective.total).toBe(true);
    const offPath = inst.tunables.filter((t) => String(t.node) !== String(inst.objective.node));
    expect(offPath.length).toBeGreaterThan(0); // a fan-out has at least one non-SLO tier

    const total = runOptimize(generatedRegistry, { graph: inst.graph, tunables: inst.tunables, objective: inst.objective });
    expect(total.kind).toBe('solved');
    if (total.kind !== 'solved') return;
    for (const t of offPath) {
      const a = total.value.assignments.find((x) => String(x.node) === String(t.node));
      expect(a?.value, `off-path knob ${String(t.node)} must descend to its min under the TOTAL objective`).toBeCloseTo(t.min, 6);
    }

    const single = runOptimize(generatedRegistry, {
      graph: inst.graph,
      tunables: inst.tunables,
      objective: { node: inst.objective.node, key: inst.objective.key, direction: 'min' },
    });
    expect(single.kind).toBe('solved');
    if (single.kind !== 'solved') return;
    for (const t of offPath) {
      const a = single.value.assignments.find((x) => String(x.node) === String(t.node));
      expect(a?.value, `the single-cell objective has no gradient on ${String(t.node)} — it stays at the witness max`).toBeCloseTo(t.max, 6);
    }
  });

  it('total-cost equals the hand-computed sum of per-node own costs at the optimum (fan-out: Σ out(tier, COST))', () => {
    // On a fan-out from a cost-free source, each tier's cumulative out(COST) IS its own cost, so the whole-design
    // total is the plain sum — a hand-computable check that the descent minimised the SUM, not one branch.
    const inst = generateNumeric(36_100, 'optimize', 'fan-out', 'sat', 'total-cost');
    const r = runOptimize(generatedRegistry, { graph: inst.graph, tunables: inst.tunables, objective: inst.objective });
    expect(r.kind).toBe('solved');
    if (r.kind !== 'solved') return;
    let handTotal = 0;
    for (const t of inst.tunables) handTotal += r.value.value(t.node as NodeId, inst.objective.key) ?? 0;
    // Every off-path tier is at 0 (zero cost) and the SLO tier serves exactly its floor, so the total is the SLO
    // tier's own cost alone — the minimum of the sum.
    const sloCost = r.value.value(inst.objective.node as NodeId, inst.objective.key) ?? Number.NaN;
    expect(handTotal).toBeCloseTo(sloCost, 4);
  });

  it('total-cost on a chain coincides with the terminal cumulative cost (the two objective forms agree where they must)', () => {
    const inst = generateNumeric(36_200, 'optimize', 'chain', 'sat', 'total-cost');
    const total = runOptimize(generatedRegistry, { graph: inst.graph, tunables: inst.tunables, objective: inst.objective });
    const single = runOptimize(generatedRegistry, {
      graph: inst.graph,
      tunables: inst.tunables,
      objective: { node: inst.objective.node, key: inst.objective.key, direction: 'min' },
    });
    expect(total.kind).toBe('solved');
    expect(single.kind).toBe('solved');
    if (total.kind !== 'solved' || single.kind !== 'solved') return;
    // On a chain every node lies on the terminal's path, so Σ locals = the terminal's cumulative out — the same
    // optimum from either form (float-tolerant; both readers go through the same engine evaluator).
    const totalAtTerminal = total.value.value(inst.objective.node as NodeId, inst.objective.key);
    const singleAtTerminal = single.value.value(inst.objective.node as NodeId, inst.objective.key);
    expect(totalAtTerminal).toBeDefined();
    expect(totalAtTerminal!).toBeCloseTo(singleAtTerminal ?? Number.NaN, 4);
  });

  it('a total objective under request classes is declined honestly (never a class-blind sum)', () => {
    const inst = generateNumeric(36_300, 'optimize', 'chain', 'sat', 'class');
    const r = runOptimize(generatedRegistry, {
      graph: inst.graph,
      tunables: inst.tunables,
      objective: { node: inst.objective.node, key: inst.objective.key, direction: 'min', total: true },
      ...(inst.classes !== undefined ? { classes: inst.classes } : {}),
    });
    expect(r.kind).toBe('did-not-converge');
    if (r.kind === 'did-not-converge') expect(r.reason).toContain('request classes');
  });
});

describe('native search — the SYSTEM band (whole-graph sum constraint, owner ruling: cost is for THE WHOLE SYSTEM)', () => {
  it('a GENEROUS system-cost ceiling solves natively — the budget machinery routes the sum band, and the optimum honours it', () => {
    // The system-band axis: a throughput floor (node band) + a whole-graph cost ceiling as a REQUEST-level system
    // band. Generous by construction ⇒ the strict witness declines (the sum rises with every knob the floor pushes
    // up), the budget classifier pulls the sum band out, the descent reaches the floor-optimum and the full-band
    // verification passes — a native SOLVE, no escalation needed (regime 1 of the ruling's two).
    const inst = generateNumeric(37_000, 'optimize', 'fan-out', 'sat', 'system-band');
    expect(inst.systemBands).toHaveLength(1);
    const ceiling = inst.systemBands![0]!.ceiling!;
    const r = runOptimize(generatedRegistry, { graph: inst.graph, tunables: inst.tunables, objective: inst.objective, systemBands: inst.systemBands! });
    expect(r.kind).toBe('solved');
    if (r.kind !== 'solved') return;
    // Hand-check the WHOLE-graph total at the optimum: on a fan-out from a cost-free source each tier's cumulative
    // out(COST) IS its own cost, so Σ over tiers is the system total — it must sit inside the declared ceiling.
    let handTotal = 0;
    for (const t of inst.tunables) handTotal += r.value.value(t.node as NodeId, inst.objective.key) ?? 0;
    expect(handTotal).toBeLessThanOrEqual(ceiling + 1e-6);
  });

  it('a TIGHT system-cost ceiling declines with the budget-coupling code — the escalatable class, never a lie', () => {
    // Regime 2: a ceiling below any floor-feasible total. The sizing witness is feasible (the floors alone hold),
    // the descent minimises cost, and the full verification still breaches the system ceiling — the per-knob
    // inversion cannot prove whether a joint trade could save it, so the HONEST answer is the machine-labelled
    // `budget-coupling` decline (the exact class the surfaces escalate to the reference MIP), NEVER a breaching
    // `solved` and NEVER a guessed `infeasible`.
    const inst = generateNumeric(37_100, 'optimize', 'chain', 'sat', 'system-band');
    const r = runOptimize(generatedRegistry, { graph: inst.graph, tunables: inst.tunables, objective: inst.objective, systemBands: [{ key: inst.objective.key, ceiling: 1 }] });
    expect(r.kind).toBe('did-not-converge');
    if (r.kind === 'did-not-converge') expect(r.code).toBe('budget-coupling');
  });

  it('repair honours the two regimes too: generous ⇒ solved inside the ceiling, tight ⇒ budget-coupling decline', () => {
    const inst = generateNumeric(37_200, 'repair', 'chain', 'sat', 'system-band');
    const generous = runRepair(generatedRegistry, { graph: inst.graph, tunables: inst.tunables, systemBands: inst.systemBands! });
    expect(generous.kind).toBe('solved');
    const tight = runRepair(generatedRegistry, { graph: inst.graph, tunables: inst.tunables, systemBands: [{ key: inst.objective.key, ceiling: 1 }] });
    expect(tight.kind).toBe('did-not-converge');
    if (tight.kind === 'did-not-converge') expect(tight.code).toBe('budget-coupling');
  });

  it('an UNSAT floor stays a proven infeasible — a slack system band never dresses infeasibility as a budget decline', () => {
    const inst = generateNumeric(37_300, 'optimize', 'chain', 'unsat', 'system-band');
    const r = runOptimize(generatedRegistry, { graph: inst.graph, tunables: inst.tunables, objective: inst.objective, systemBands: inst.systemBands! });
    expect(r.kind).toBe('infeasible');
  });

  it('a system band under request classes is declined honestly (the class-blind sum rule)', () => {
    const inst = generateNumeric(37_400, 'optimize', 'chain', 'sat', 'class');
    const r = runOptimize(generatedRegistry, {
      graph: inst.graph,
      tunables: inst.tunables,
      objective: inst.objective,
      systemBands: [{ key: inst.objective.key, ceiling: 1_000_000 }],
      ...(inst.classes !== undefined ? { classes: inst.classes } : {}),
    });
    expect(r.kind).toBe('did-not-converge');
    if (r.kind === 'did-not-converge') expect(r.reason).toContain('request classes');
  });
});

describe('native search — determinism and honest cancellation', () => {
  it('the same request answered twice is identical (no clock, no randomness)', () => {
    const inst = generateNumeric(34_000, 'optimize', 'fan-in', 'sat');
    const once = runOptimize(generatedRegistry, { graph: inst.graph, tunables: inst.tunables, objective: inst.objective });
    const twice = runOptimize(generatedRegistry, { graph: inst.graph, tunables: inst.tunables, objective: inst.objective });
    expect(once.kind).toBe(twice.kind);
    if (once.kind === 'solved' && twice.kind === 'solved') {
      expect(once.value.value(inst.objective.node as NodeId, inst.objective.key)).toBe(twice.value.value(inst.objective.node as NodeId, inst.objective.key));
    }
  });

  it('an already-aborted signal settles as did-not-converge with no stale solution (native CAN cancel)', () => {
    const inst = generateNumeric(35_000, 'optimize', 'chain', 'sat');
    const c = new AbortController();
    c.abort();
    const r = runOptimize(generatedRegistry, { graph: inst.graph, tunables: inst.tunables, objective: inst.objective, signal: c.signal });
    expect(r.kind).toBe('did-not-converge');
  });
});

describe('native search — interactive-grade per-instance budget (owner requirement)', () => {
  it('every generated numeric instance is answered in well under 100 ms (median reported)', () => {
    const times: number[] = [];
    for (let seed = 40_000; seed < 40_030; seed++) {
      const topology = (['chain', 'fan-out', 'fan-in'] as const)[seed % 3]!;
      const regime = seed % 2 === 0 ? 'sat' : 'unsat';
      for (const cap of ['optimize', 'repair', 'explainInfeasible'] as const) {
        const inst = generateNumeric(seed, cap, topology, regime);
        const t = performance.now();
        if (cap === 'optimize') runOptimize(generatedRegistry, { graph: inst.graph, tunables: inst.tunables, objective: inst.objective });
        else if (cap === 'repair') runRepair(generatedRegistry, { graph: inst.graph, tunables: inst.tunables });
        else runExplain(generatedRegistry, { graph: inst.graph, tunables: inst.tunables });
        times.push(performance.now() - t);
      }
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    const max = times[times.length - 1]!;
    // Interactive grade: the SLOWEST native answer stays inside 100 ms (the owner's canvas-edit budget).
    expect(max, `native max per-instance ${max.toFixed(2)}ms (median ${median.toFixed(2)}ms) must be < 100ms`).toBeLessThan(100);
  });
});

/** Read the SLO floor a generated instance placed on its SLO tier. */
function floorOf(inst: NumericInstance): number {
  const node = inst.graph.nodes.get(inst.objective.node as NodeId);
  const band = node?.cells.find((c) => c.kind === 'input' && c.value.kind === 'band');
  if (band?.kind === 'input' && band.value.kind === 'band' && band.value.band.shape === 'minTargetMax') return band.value.band.min ?? 0;
  throw new Error('generated instance has no floor band');
}
