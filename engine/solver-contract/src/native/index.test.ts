import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import run from 'clingo-wasm';
import { parseMznCliOutput, type MznSolver } from '@sda/engine-solve';
import { answerSets, type RunAsp } from '@sda/engine-solve/asp';
import { makeIncumbentAdapter } from '../incumbent';
import { makeNativeAdapter } from './index';
import { conformanceOf } from '../conformance';
import { corpusRegistry } from '../conformance/corpus';
import { declinesHonestlyOf, oracleHarnessOf } from '../harness';
import { generateClass, generateGeneratorAxis, generateNumeric, generatedRegistry } from '../harness/generator';
import { closeEnough, referee } from '../bindings';

// THE NATIVE ADAPTER's proof. This is where our own solver is graded against the SAME two
// suites the incumbent passes — the conformance spec (hand-checked designs) and the ORACLE HARNESS (a generated
// differential batch the incumbent certifies) — plus the phase-2 additions: the flipped cancellation clause
// (native CAN cancel), an interactive-grade per-instance budget, and a live referee against the incumbent. A
// green run here IS the claim "native implements the contract, and it is RIGHT" — nothing is asserted in prose.
//
// The incumbent oracle needs the real solvers; they are wired here exactly as the harness/incumbent tests wire
// them (a native MiniZinc CLI + clingo-wasm). Native itself needs NEITHER — that is the whole point — so where
// the incumbent oracle spawns MiniZinc, the native candidate answers in-process.

const MZN = process.env.MINIZINC ?? 'minizinc';
const solveMzn: MznSolver = async (model) => {
  const dir = mkdtempSync(join(tmpdir(), 'sda-native-'));
  try {
    const file = join(dir, 'm.mzn');
    writeFileSync(file, model);
    const out = execFileSync(MZN, ['--solver', 'cbc', '--time-limit', '10000', '--output-mode', 'json', file], { encoding: 'utf8', timeout: 12000 });
    return parseMznCliOutput(out);
  } catch (e) {
    const partial = (e as { stdout?: string }).stdout;
    return partial ? parseMznCliOutput(partial) : { kind: 'unknown' as const };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const runAsp: RunAsp = async (program, models) => answerSets(await run(program, models));

// ── CONFORMANCE: native passes the executable §4 specification ────────────────────────────────────────────────
// Built with the CORPUS registry (the hand-checked fixtures live in it). `supportsCancellation: true` is THE FLIP
// (docs §7 step 4): unlike the incumbent (which cannot yet thread an AbortSignal into a running WASM solve), the
// native search is in-process and honours the signal BETWEEN nodes, so the cancellation clause is ACTIVE here.
const nativeCorpus = makeNativeAdapter({ registry: corpusRegistry });
conformanceOf(nativeCorpus, { label: 'native (CPU cell-network search)', timeBudgetMs: 20_000, supportsCancellation: true });

// ── ORACLE HARNESS: native matches the incumbent-certified answers on the generated batch ─────────────────────
// Built with the GENERATED registry (the random designs live in it), oracle = the incumbent over the SAME
// registry. Enumerate instances are skipped because native does not bind enumerate — that stays the incumbent's
// clingo path, by design.
const nativeGen = makeNativeAdapter({ registry: generatedRegistry });
const incumbentGen = makeIncumbentAdapter({ registry: generatedRegistry, solveMzn, runAsp });

// ── NIGHT-LOOP KNOBS (owner directive) — read HERE (a dev-only test), never in the harness core ───────────────
// The distillation process COUNTS ON finding gaps, so a night loop roams FRESH instance space each round:
//   · SDA_HARNESS_SEED — offsets every base seed by a large stride so each value explores a DISJOINT region; the
//     SAME value reproduces a region byte-for-byte (seeds are inputs). SEED 0 is the pre-hardening default.
//   · SDA_HARNESS_DEEP=1 — the slow lane: multiplies the per-cell / per-axis COUNTS (not the per-instance SIZE),
//     so a night run distils far more instances. It COMBINES with the seed knob (a deep run of a roamed region).
// Both are printed into every divergence's reproduction command, so a night hit is a one-paste repro.
// EXPECTED WALL-TIME (this package, one round): default ~30 s; DEEP ~85 s on the reference machine (measured at
// 707 tests: baseline perCell 10, axes perAxis 3, declined perCell 4; the deepest chain optimize is ~1.3 s). A
// night loop that increments SDA_HARNESS_SEED each round roams a disjoint DEEP region in ~85 s per round.
const SEED = Number.parseInt(process.env.SDA_HARNESS_SEED ?? '0', 10) || 0;
const DEEP = process.env.SDA_HARNESS_DEEP === '1';
const OFFSET = SEED * 1_000_003; // a stride >> any run's instance count ⇒ roamed regions never overlap
const reproEnv = `SDA_HARNESS_SEED=${SEED}${DEEP ? ' SDA_HARNESS_DEEP=1' : ''}`;
// Distinct base seeds so the three batches' seeds never collide within one region (baseline · axes · declined).
const baselineBase = 0x5da79 + OFFSET; // 0x5da79 = the pre-hardening default ⇒ SEED 0 is byte-identical
const axisBase = 0x5da79 + 0x40000 + OFFSET;
const declinedBase = 0xdec11 + OFFSET;

// BASELINE canvas-scale differential (perCell 3 ⇒ 54 numeric instances by default). The per-instance budget is
// far tighter than the incumbent's (15 s) to encode the phase-2 promise that native is FAST on ordinary designs,
// with headroom for CI variance; the crisp interactive-grade proof (< 100 ms) is the dedicated budget test in
// ./search.test.ts. A correct-but-slow candidate still fails this budget.
oracleHarnessOf(nativeGen, {
  label: 'native vs incumbent oracle — baseline',
  oracle: incumbentGen,
  perInstanceBudgetMs: 1_000,
  corpus: { perCell: DEEP ? 10 : 3, baseSeed: baselineBase },
  reproEnv,
});

// The HARDENING AXES differential (phase 3): boundary (the ULP knife-edge) / magnitude / depth / multiband /
// transforms / zero-traffic + the objective-tie probe. A DELIBERATELY generous per-instance budget (5 s): these
// axes stress SIZE, not the canvas case — a deep chain up to ~100 nodes measures ~1.3 s of honest per-knob
// inversion (a distillation FINDING, not a divergence: the answer is correct, just large). The tight 1 s canvas
// promise is the baseline call above; the DEEP lane raises the COUNT (perAxis), never the per-instance size, so
// this budget holds in the slow lane too. `perCell: 0` ⇒ only the axis instances (the baseline batch is above).
oracleHarnessOf(nativeGen, {
  label: 'native vs incumbent oracle — hardening axes',
  oracle: incumbentGen,
  perInstanceBudgetMs: 5_000,
  corpus: { perCell: 0, axes: true, perAxis: DEEP ? 3 : 1, baseSeed: axisBase },
  reproEnv,
});

// The DECLINES-HONESTLY section (phase 3): the DECLINED class (point bands / a floor↔ceiling coupling) is
// DELIBERATELY outside native's monotone class. Native must return `did-not-converge` (never a guess) while the
// incumbent SOLVES it — the un-gameable proof that native never lies outside the class it can prove.
declinesHonestlyOf(nativeGen, {
  label: 'native vs incumbent oracle',
  oracle: incumbentGen,
  corpus: { perCell: DEEP ? 4 : 2, baseSeed: declinedBase },
  reproEnv,
});

// ── PHASE-2 ADDITIONS: capability segregation + the live referee ──────────────────────────────────────────────
describe('native adapter — capability set and the referee against the incumbent', () => {
  it('binds the numeric searches + batch, but NOT enumerate (that stays the incumbent clingo path)', () => {
    expect(nativeGen.evaluate).toBeDefined();
    expect(nativeGen.optimize).toBeDefined();
    expect(nativeGen.repair).toBeDefined();
    expect(nativeGen.explainInfeasible).toBeDefined();
    expect(nativeGen.evaluateBatch).toBeDefined();
    expect(nativeGen.enumerate).toBeUndefined();
  });

  it('evaluateBatch fans one design over many scenarios, one Evaluation per scenario in order', async () => {
    const inst = generateNumeric(70_000, 'optimize', 'chain', 'sat');
    const r = await nativeGen.evaluateBatch!({ graph: inst.graph, scenarios: [{ overrides: {} }, { overrides: {} }, { overrides: {} }] });
    expect(r).toHaveLength(3);
    expect(r.every((ev) => ev.converged)).toBe(true);
  });

  it('request classes: native SOLVES a headroom multi-class design and matches the incumbent optimum', async () => {
    // The shared sink is provably unsaturated (capacity 3× the injected load), so the processor-sharing split is
    // the identity and the design is separable + monotone — the native solver must SOLVE and agree with the MIP.
    const inst = generateClass(80_000, 'optimize', 'chain', 'sat', { saturated: false });
    const req = { graph: inst.graph, tunables: inst.tunables, objective: inst.objective, ...(inst.classes !== undefined ? { classes: inst.classes } : {}) };
    const [nativeR, incR] = await Promise.all([nativeGen.optimize!(req), incumbentGen.optimize!(req)]);
    expect(nativeR.kind, 'native must SOLVE the headroom multi-class design').toBe('solved');
    expect(incR.kind).toBe('solved');
    if (nativeR.kind === 'solved' && incR.kind === 'solved') {
      const nv = nativeR.value.value(inst.objective.node, inst.objective.key, inst.objective.class);
      const iv = incR.value.value(inst.objective.node, inst.objective.key, inst.objective.class);
      expect(nv !== undefined && iv !== undefined && closeEnough(nv, iv), `native cost ${nv} vs incumbent ${iv}`).toBe(true);
    }
  });

  it('request classes: native DECLINES at the shared-saturation boundary while the incumbent SOLVES', async () => {
    // The shared sink capacity is BELOW the injected load, so total offered crosses it — the non-monotone
    // processor-sharing boundary (doc: request-classes §5.2). Native must return did-not-converge (honest), never a
    // guessed answer; the incumbent still solves the linearised model. This is the un-gameable solve-vs-decline split.
    const inst = generateClass(80_001, 'optimize', 'chain', 'sat', { saturated: true });
    const req = { graph: inst.graph, tunables: inst.tunables, objective: inst.objective, ...(inst.classes !== undefined ? { classes: inst.classes } : {}) };
    const [nativeR, incR] = await Promise.all([nativeGen.optimize!(req), incumbentGen.optimize!(req)]);
    expect(nativeR.kind, 'native must DECLINE the shared-saturation design').toBe('did-not-converge');
    expect(incR.kind, 'the incumbent must SOLVE it (proving the oracle covers what native declines)').toBe('solved');
  });

  it('GENERATOR axis (doc: load-curves R1): native solves generate-driven load, matches the incumbent, and PEAK prices ≥ MEAN', async () => {
    // The headroom lesson: the same seed's peak twin (level × k) can never OPTIMIZE CHEAPER than its mean twin —
    // serving a strictly larger generated arrival needs at-least-as-much capacity, because the served flow is
    // MONOTONE in the level (the native solver's core assumption, verified here end-to-end through BOTH solvers).
    for (const seed of [90_000, 90_001]) {
      const costs: number[] = [];
      for (const peakVariant of [false, true]) {
        const inst = generateGeneratorAxis(seed, 'optimize', 'chain', 'sat', peakVariant);
        const req = { graph: inst.graph, tunables: inst.tunables, objective: inst.objective };
        const [nativeR, incR] = await Promise.all([nativeGen.optimize!(req), incumbentGen.optimize!(req)]);
        expect(nativeR.kind, `native must SOLVE the ${inst.demand} req/s generator design (seed ${seed})`).toBe('solved');
        expect(incR.kind).toBe('solved');
        if (nativeR.kind === 'solved' && incR.kind === 'solved') {
          const nv = nativeR.value.value(inst.objective.node, inst.objective.key);
          const iv = incR.value.value(inst.objective.node, inst.objective.key);
          expect(nv !== undefined && iv !== undefined && closeEnough(nv, iv), `native cost ${nv} vs incumbent ${iv} (seed ${seed}, peak ${peakVariant})`).toBe(true);
          costs.push(nv as number);
        }
      }
      // Peak scaling is monotone in the level ⇒ the worst hour can only cost MORE capacity, never less.
      expect(costs[1]!).toBeGreaterThanOrEqual(costs[0]! - 1e-9);
    }
  });

  it('referee: native agrees with the incumbent on a FRESH generated batch — any divergence THROWS (P0)', async () => {
    // referee returns the trusted (incumbent) answer and asserts native matches on the OBSERVABLE optimum
    // (objective value + honesty kind, float-tolerant). The default reporter throws, so this passes ONLY if
    // native and the real MIP agree on every instance — the un-gameable cross-check (docs §5).
    const bound = referee(incumbentGen, nativeGen);
    const cases = [
      ['chain', 'sat'],
      ['fan-out', 'sat'],
      ['fan-in', 'sat'],
      ['chain', 'unsat'],
      ['fan-out', 'unsat'],
      ['fan-in', 'unsat'],
    ] as const;
    let i = 0;
    for (const [topology, regime] of cases) {
      const inst = generateNumeric(71_000 + i++, 'optimize', topology, regime);
      const r = await bound.optimize!({ graph: inst.graph, tunables: inst.tunables, objective: inst.objective });
      expect(r.kind === 'solved' || r.kind === 'infeasible').toBe(true);
    }
  });
});
