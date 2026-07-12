// @algorithm Differential + property grading of a candidate solver (the oracle harness runner)
// @problem A second solver must be proven equivalent to the incumbent across a generated corpus —
//   by the CONTRACT's equivalence, not knob-for-knob identity — plus laws no pair of agreeing-but-
//   wrong solvers could fake.
// @approach Two layers: differential — per capability, compare candidate vs certified oracle answer
//   (optimize: same kind + float-tolerant objective + SLO satisfaction; repair: same total L1
//   distance; explain: same shortfall set; enumerate: exact order-independent selection set); and
//   properties — determinism under seed, monotonicity, per-instance budget; a separate
//   declines-honestly section asserts the candidate returns did-not-converge on the declined class
//   while the oracle still solves; the incumbent grading itself is the sanity gate.
// @complexity O(corpus size) instances, each one candidate call + comparisons.
// @citations Differential testing (McKeeman 1998); metamorphic/property lineage (Claessen & Hughes
// 2000); equivalence rules are the contract's own.
// @invariants Seed offsets reproduce byte-identical corpora (SDA_HARNESS_SEED); any divergence
//   carries its repro seed; equivalence never accepts a wrong KIND, and a decline is only honest
//   where the oracle solves.
// @where-tested engine/solver-contract/src/harness/harness.test.ts (incumbent as its own candidate),
//   engine/solver-contract/src/native/index.test.ts (the native candidate)

// THE ORACLE HARNESS — the RUNNER. Where the
// conformance suite (../conformance) grades an adapter on a handful of HAND-CHECKED designs, the oracle harness
// grades it on a GENERATED batch (./generator) whose answers are CERTIFIED by the incumbent referee (./oracle).
// `oracleHarnessOf(candidate, opts)` returns a describe-block — the exact shape `conformanceOf` returns — that
// the adapter's own test file invokes. Running the INCUMBENT as its own candidate is the sanity gate: the
// oracle must pass its own harness (a solver that cannot match itself has a non-deterministic answer, a bug).
//
// EQUIVALENCE IS THE CONTRACT'S (docs §5, owner ruling 2026-07-03): a candidate matches the oracle on
//  - optimize:  same honesty KIND, and — when both solved — the same OBJECTIVE VALUE (float-tolerant) AND the
//               same SLO-satisfaction fact (NOT the knob vector — two optima may differ within ε yet both hold);
//  - repair:    same kind, and — when solved — a change set of the same TOTAL L1 distance (the minimal-edit
//               MEASURE; two equally-minimal repairs may pick different knobs, exactly as two optima may);
//  - explain:   same kind, and — when solved — the same SHORTFALL SET (which SLO, which side, how far);
//  - enumerate: same kind, and — when enumerated — the EXACT selection set (order-independent).
//
// TWO EXTRA SECTIONS (phase-3 hardening):
//  - `declinesHonestlyOf` — the DECLINED class (point bands / a floor↔ceiling coupling): the candidate must
//    return `did-not-converge` (never a guess) while the ORACLE still SOLVES, proving the oracle covers what the
//    native solver honestly declines. Kept SEPARATE from the differential (equivalence would fail by design there).
//  - The DEEP + SEED lanes are the night-loop distiller's knobs, read by the CALLER (a .test.ts) and passed in as
//    corpus options — the harness core stays free of process.env:
//      · SDA_HARNESS_SEED — offsets the corpus base seed to roam DISJOINT instance regions; same value ⇒ a
//        byte-identical corpus (reproducibility), a different value ⇒ a fresh region. The caller adds its offset
//        to `corpus.baseSeed`; a divergence's repro therefore requires the SAME SDA_HARNESS_SEED.
//      · SDA_HARNESS_DEEP=1 — the slow lane: the caller raises `corpus.perCell`/`perAxis` (e.g. perCell 10+),
//        so a night run explores far more instances. Expected wall-time is documented at the caller (native/
//        index.test.ts). The two knobs COMBINE (a deep run of a roamed region).
//    A divergence prints a full one-paste REPRODUCTION command (the caller's `reproEnv` + the failing instance's
//    seed/shape), so a night-loop hit is reproduced by pasting one line — the whole point of a distiller.
//
// THE HARNESS CORE IS ENGINE-CORE-PURE (hard rule): it imports vitest (a describe/it factory, dev-only, exactly
// as ../conformance does) plus the contract's own modules — NEVER ../incumbent and NEVER @sda/engine-solve. The
// ORACLE adapter (which does wrap the solvers) is INJECTED by the caller, so the heavy deps stay behind the one
// ./incumbent entry the caller reaches. The harness only compares two `SolverBindings` — it runs no solver of
// its own.

import { describe, expect, it } from 'vitest';
import { closeEnough, type SolverBindings } from '../bindings';
import type { Change, Shortfall } from '../capability';
import { generateCorpus, generateDeclinedCorpus, type CorpusOptions, type GeneratedInstance, type NumericInstance } from './generator';
import { answerEnumerate, answerNumeric, type EnumerateOracleAnswer, type NumericOracleAnswer } from './oracle';

/**
 * How the oracle harness is tuned per candidate (mirrors ConformanceOptions). The ORACLE — the certified-answer
 * adapter, always the incumbent — is injected because the harness core may not import it. `label` names the
 * candidate in the report; `perInstanceBudgetMs` is the performance budget each capability's per-instance
 * answer must return within (a correct-but-slow candidate FAILS — the owner's requirement); `corpus` overrides
 * the generated batch size/seed (default: the CI-sized ~54-numeric + 6-enumerate corpus).
 */
export interface OracleHarnessOptions {
  readonly label: string;
  /** The certified-answer adapter (the incumbent). Injected — the harness core cannot import ../incumbent. */
  readonly oracle: SolverBindings;
  /** Per-instance time budget (ms). Each candidate answer must return within this or the instance FAILS —
   *  correctness is necessary but not sufficient (a slow solver is unusable on a canvas edit). Chosen with
   *  honest headroom over the incumbent's own measured per-instance time (see the caller's rationale). */
  readonly perInstanceBudgetMs: number;
  /** Override the generated corpus (size/seed). Default keeps the batch CI-sized so the whole run is bounded. */
  readonly corpus?: CorpusOptions;
  /** The night-loop env prefix (e.g. `SDA_HARNESS_SEED=42 SDA_HARNESS_DEEP=1`) the caller ran under, printed
   *  verbatim in a divergence's reproduction command so a night hit is one paste. Omit ⇒ the default region. */
  readonly reproEnv?: string;
}

/** Total L1 distance of a change set — the minimal-edit MEASURE repair minimizes. Two equally-minimal repairs
 *  have the same total distance even if they touch different knobs, so this is the equivalence surface (not the
 *  raw change list), matching optimize's objective-value equivalence (docs §5). */
const totalDistance = (cs: readonly Change[]): number => cs.reduce((s, c) => s + Math.abs(c.delta), 0);

/** A stable, order-independent key for a shortfall set so two explains compare as sets. */
const shortfallKey = (ss: readonly Shortfall[]): string =>
  [...ss].map((s) => `${s.node}|${s.key}|${s.bound}|${s.amount.toFixed(4)}`).sort().join(';');

/** Whether a candidate's numeric answer is EQUIVALENT to the oracle's, per the capability's equivalence rule. */
function numericEquivalent(capability: NumericInstance['capability'], oracle: NumericOracleAnswer, cand: NumericOracleAnswer): boolean {
  if (oracle.kind !== cand.kind) return false;
  if (oracle.kind !== 'solved') return true; // both infeasible or both did-not-converge ⇒ equivalent
  switch (capability) {
    case 'optimize':
      // Same objective value (float-tolerant) AND same SLO-satisfaction fact.
      if (oracle.objectiveValue === undefined || cand.objectiveValue === undefined) return oracle.objectiveValue === cand.objectiveValue;
      return closeEnough(oracle.objectiveValue, cand.objectiveValue) && oracle.sloSatisfied === cand.sloSatisfied;
    case 'repair':
      // Same minimal total edit distance (the MEASURE repair minimizes), float-tolerant.
      return closeEnough(totalDistance(oracle.changes ?? []), totalDistance(cand.changes ?? []));
    case 'explainInfeasible':
      // Same shortfall set (which SLO fails, which side, by how much).
      return shortfallKey(oracle.shortfalls ?? []) === shortfallKey(cand.shortfalls ?? []);
  }
}

/** Whether a candidate's enumerate answer matches the oracle's: same kind, and — when enumerated — the EXACT
 *  selection set (order-independent). */
function enumerateEquivalent(oracle: EnumerateOracleAnswer, cand: EnumerateOracleAnswer): boolean {
  if (oracle.kind !== cand.kind) return false;
  if (oracle.kind !== 'enumerated') return true;
  const key = (sels: EnumerateOracleAnswer['selections']): string =>
    (sels ?? []).map((s) => Object.keys(s).sort().map((k) => `${k}=${s[k]}`).join('|')).sort().join('\n');
  return key(oracle.selections) === key(cand.selections);
}

/** A human-readable name for an instance so a failing case names its seed + shape (reproducible from the seed).
 *  The AXIS is included so a night-loop hit says WHICH hunt produced it (baseline vs boundary/magnitude/…). */
const instanceName = (i: GeneratedInstance): string =>
  i.kind === 'numeric' ? `${i.capability} · ${i.topology} · ${i.regime} · ${i.axis} · seed=${i.seed}` : `enumerate · ${i.regime} · seed=${i.seed}`;

/** A one-paste REPRODUCTION command for a diverging instance: the night-loop env prefix the run used (so the
 *  SAME region is regenerated) plus a vitest name filter on the failing instance (whose absolute seed pins it).
 *  Printed inside a divergence's assertion message — the whole point of a distiller is a cheap repro. */
const reproCommand = (reproEnv: string | undefined, name: string): string => {
  const env = reproEnv !== undefined && reproEnv.length > 0 ? `${reproEnv} ` : '';
  return `REPRO: ${env}pnpm --filter @sda/solver-contract exec vitest run -t "${name}"`;
};

/**
 * The oracle-harness describe-block for one candidate. Invoke it from the candidate's own test file:
 * `oracleHarnessOf(candidate, { label, oracle: incumbent, perInstanceBudgetMs })`. For every generated
 * instance it computes BOTH the oracle answer (certified) and the candidate answer, asserts the contract's
 * equivalence, and asserts the candidate returned within the per-instance budget. Running the incumbent as its
 * OWN candidate (`candidate === oracle`) is the sanity gate — the oracle must pass its own harness.
 *
 * The corpus is generated ONCE per describe-block (deterministic from its seed), and the oracle answers are
 * computed in-run (nothing cached to disk — owner ruling v1). The batch is CI-sized, so the whole run is time-
 * bounded; each instance additionally asserts its own budget so a single slow answer is caught, not amortized.
 */
export function oracleHarnessOf(candidate: SolverBindings, opts: OracleHarnessOptions): void {
  const corpus = generateCorpus(opts.corpus ?? {});
  const numeric = corpus.filter((i): i is NumericInstance => i.kind === 'numeric');
  const enumerates = corpus.filter((i): i is Extract<GeneratedInstance, { kind: 'enumerate' }> => i.kind === 'enumerate');

  describe(`solver oracle harness — ${opts.label} (${corpus.length} generated instances)`, () => {
    // ── The differential layer: candidate MUST match the certified oracle answer, per instance ────────────
    describe('differential — candidate matches the certified oracle answer', () => {
      // Numeric capabilities are only exercised when the candidate binds them (interface segregation) — a
      // candidate without optimize is not failed for lacking it, exactly as conformanceOf skips absent ones.
      for (const inst of numeric) {
        const present =
          (inst.capability === 'optimize' && candidate.optimize !== undefined) ||
          (inst.capability === 'repair' && candidate.repair !== undefined) ||
          (inst.capability === 'explainInfeasible' && candidate.explainInfeasible !== undefined);
        (present ? it : it.skip)(instanceName(inst), async () => {
          const oracleAnswer = await answerNumeric(opts.oracle, inst);
          const t = Date.now();
          const candAnswer = await answerNumeric(candidate, inst);
          const elapsed = Date.now() - t;
          const repro = reproCommand(opts.reproEnv, instanceName(inst));
          expect(numericEquivalent(inst.capability, oracleAnswer, candAnswer), `oracle=${JSON.stringify(oracleAnswer)} candidate=${JSON.stringify(candAnswer)}\n${repro}`).toBe(true);
          expect(elapsed, `candidate exceeded the ${opts.perInstanceBudgetMs}ms per-instance budget (${elapsed}ms)\n${repro}`).toBeLessThan(opts.perInstanceBudgetMs);
        });
      }

      for (const inst of enumerates) {
        (candidate.enumerate !== undefined ? it : it.skip)(instanceName(inst), async () => {
          const oracleAnswer = await answerEnumerate(opts.oracle, inst);
          const t = Date.now();
          const candAnswer = await answerEnumerate(candidate, inst);
          const elapsed = Date.now() - t;
          const repro = reproCommand(opts.reproEnv, instanceName(inst));
          expect(enumerateEquivalent(oracleAnswer, candAnswer), `oracle=${JSON.stringify(oracleAnswer)} candidate=${JSON.stringify(candAnswer)}\n${repro}`).toBe(true);
          expect(elapsed, `candidate exceeded the ${opts.perInstanceBudgetMs}ms per-instance budget (${elapsed}ms)\n${repro}`).toBeLessThan(opts.perInstanceBudgetMs);
        });
      }
    });

    // ── The property layer: laws that hold across the whole generated space ───────────────────────────────
    describe('properties — laws over the generated space', () => {
      // DETERMINISM UNDER SEED: the SAME instance answered twice by the candidate is equivalent to itself. This
      // pins the seeds-are-inputs discipline at the candidate boundary (a candidate that reads a clock or an
      // unseeded RNG would flake here). One representative per capability keeps the property fast.
      const sampleByCapability = ['optimize', 'repair', 'explainInfeasible'] as const;
      for (const cap of sampleByCapability) {
        const inst = numeric.find((i) => i.capability === cap);
        const bound =
          (cap === 'optimize' && candidate.optimize !== undefined) ||
          (cap === 'repair' && candidate.repair !== undefined) ||
          (cap === 'explainInfeasible' && candidate.explainInfeasible !== undefined);
        (inst !== undefined && bound ? it : it.skip)(`determinism under seed — ${cap} answered twice is equivalent`, async () => {
          const once = await answerNumeric(candidate, inst!);
          const twice = await answerNumeric(candidate, inst!);
          expect(numericEquivalent(cap, once, twice)).toBe(true);
        });
      }

      // MONOTONICITY: tightening an optimize instance's SLO floor never LOWERS the optimum cost (a stricter SLO
      // is at least as expensive to meet). A spot-check on a feasible chain instance: re-generate it and a
      // strictly-tighter twin (via a higher perCell seed offset is not enough — we tighten the SAME design's
      // floor directly through the generator's regime knob), then assert cost(tight) ≥ cost(loose) − ε.
      const monoInst = numeric.find((i) => i.capability === 'optimize' && i.topology === 'chain' && i.regime === 'sat');
      (monoInst !== undefined && candidate.optimize !== undefined ? it : it.skip)('monotonicity — a tighter SLO never lowers the optimum cost', async () => {
        const loose = await answerNumeric(candidate, monoInst!);
        // A strictly tighter twin: same graph, but the SLO floor raised toward the design's ceiling. We build it
        // by asking the candidate to optimize the design as-is (loose) and a floor-raised variant (tight). The
        // tightened design is produced by the generator helper so the property owns no graph surgery.
        const tight = await answerNumeric(candidate, tightenedTwin(monoInst!));
        if (loose.kind !== 'solved' || tight.kind !== 'solved') return; // only compare when both are feasible
        const lc = loose.objectiveValue ?? 0;
        const tc = tight.objectiveValue ?? 0;
        expect(tc, `tighter cost ${tc} must be ≥ looser cost ${lc}`).toBeGreaterThanOrEqual(lc - 1e-3);
      });
    });
  });
}

/**
 * How the DECLINES-HONESTLY section is tuned. The ORACLE is injected (the incumbent, which SOLVES the declined
 * class). `corpus` sizes/seeds the declined batch (its base seed is a night-loop input, kept distinct from the
 * differential corpus so seeds never collide); `reproEnv` is printed in a failure's reproduction command.
 */
export interface DeclinesHonestlyOptions {
  readonly label: string;
  /** The certified-answer adapter (the incumbent). It must SOLVE the declined class the candidate declines. */
  readonly oracle: SolverBindings;
  /** Size/seed the declined batch. Default keeps it CI-sized. */
  readonly corpus?: Pick<CorpusOptions, 'perCell' | 'baseSeed'>;
  /** The night-loop env prefix printed in a divergence's reproduction command (one-paste repro). */
  readonly reproEnv?: string;
}

/**
 * The DECLINES-HONESTLY describe-block (phase-3 hardening). Grade a candidate on the DECLINED class — designs
 * DELIBERATELY OUTSIDE the native solver's monotone class (a `point` band, or a knob coupling a floor↔ceiling).
 * For each, assert TWO facts that together are the anti-lie guarantee:
 *   1. the ORACLE (incumbent) SOLVES it — so the oracle demonstrably COVERS what the candidate steps back from
 *      (a non-`solved` oracle answer would mean the instance was not actually solvable, a generator bug, so it
 *      is asserted, not assumed);
 *   2. the CANDIDATE returns `did-not-converge` — an HONEST decline, never a guessed `solved`/`infeasible`.
 *
 * This is kept SEPARATE from `oracleHarnessOf`'s differential: there the candidate must MATCH the oracle, which
 * would fail by design on the declined class (candidate declines, oracle solves). Invoke with the NATIVE solver
 * as the candidate and the incumbent as the oracle; a divergence prints the same one-paste reproduction command.
 */
export function declinesHonestlyOf(candidate: SolverBindings, opts: DeclinesHonestlyOptions): void {
  const declined = generateDeclinedCorpus(opts.corpus ?? {});

  describe(`solver oracle harness — DECLINES HONESTLY — ${opts.label} (${declined.length} declined-class instances)`, () => {
    for (const inst of declined) {
      // Only exercised where the candidate binds the capability (interface segregation) — a candidate without
      // optimize is not failed for lacking it, exactly as the differential skips absent capabilities.
      const present =
        (inst.capability === 'optimize' && candidate.optimize !== undefined) ||
        (inst.capability === 'repair' && candidate.repair !== undefined) ||
        (inst.capability === 'explainInfeasible' && candidate.explainInfeasible !== undefined);
      (present ? it : it.skip)(instanceName(inst), async () => {
        const oracleAnswer = await answerNumeric(opts.oracle, inst);
        const candAnswer = await answerNumeric(candidate, inst);
        const repro = reproCommand(opts.reproEnv, instanceName(inst));
        expect(oracleAnswer.kind, `the oracle must SOLVE a declined-class instance (got ${oracleAnswer.kind}) ${JSON.stringify(oracleAnswer)}\n${repro}`).toBe('solved');
        expect(candAnswer.kind, `the candidate must DECLINE an out-of-class instance with did-not-converge (got ${candAnswer.kind}) ${JSON.stringify(candAnswer)}\n${repro}`).toBe('did-not-converge');
      });
    }
  });
}

/** Build a strictly-TIGHTER twin of a feasible optimize instance by raising its SLO floor a small amount, while
 *  keeping it feasible — used by the monotonicity property. Pure engine-core surgery (raise the floor band's
 *  `min`), so the harness stays engine-core-pure. Lives here because it is a HARNESS concept (a monotone
 *  perturbation), not a corpus shape.
 *
 *  The increment is +10% of the current floor (at least +1). The generator sets a SAT floor at ≤ 0.8·hardCap
 *  (the reachable served flow), so +10% lands it at ≤ 0.88·hardCap — STRICTLY above the loose floor yet still
 *  below the reachable cap, i.e. a stricter-but-still-satisfiable SLO. That is exactly the perturbation
 *  monotonicity needs: the optimum cost of a tighter (but feasible) SLO can only be ≥ the looser one's. We do
 *  NOT tighten relative to the design's CURRENT served flow (`ceiling`) — that can sit BELOW the SAT floor
 *  (the search is meant to size UP), which would invert loose/tight. */
function tightenedTwin(inst: NumericInstance): NumericInstance {
  const sloId = inst.objective.node;
  const currentFloor = floorOf(inst) ?? 0;
  const tighterFloor = currentFloor + Math.max(1, Math.ceil(currentFloor * 0.1));
  const nodes = new Map(inst.graph.nodes);
  const node = nodes.get(sloId);
  if (node !== undefined) {
    const cells = node.cells.map((c) =>
      c.kind === 'input' && c.value.kind === 'band' && c.value.band.shape === 'minTargetMax'
        ? { ...c, value: { kind: 'band' as const, band: { shape: 'minTargetMax' as const, min: tighterFloor } } }
        : c,
    );
    nodes.set(sloId, { ...node, cells });
  }
  return { ...inst, graph: { nodes, ports: inst.graph.ports, edges: inst.graph.edges } };
}

/** Read the current SLO floor (`minTargetMax` band `min`) at a numeric instance's SLO tier, or undefined. */
function floorOf(inst: NumericInstance): number | undefined {
  const node = inst.graph.nodes.get(inst.objective.node);
  const cell = node?.cells.find((c) => c.kind === 'input' && c.value.kind === 'band');
  if (cell?.kind === 'input' && cell.value.kind === 'band' && cell.value.band.shape === 'minTargetMax') return cell.value.band.min;
  return undefined;
}
