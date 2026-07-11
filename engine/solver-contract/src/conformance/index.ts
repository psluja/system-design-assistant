// The CONFORMANCE SUITE — the executable specification (docs/design/solver-contract.html §4). It ships in the
// contract package and every adapter runs it: "adapter X implements capability C" is not a claim in a README,
// it is a green run of this suite. `conformanceOf(bindings, opts)` returns a describe-block the adapter's own
// test file invokes; it is parameterized by the adapter under test so the SAME clauses grade the incumbent
// today and the domain solver tomorrow.
//
// The suite is the operational definition of the interfaces' doc-comments (docs §4): if a clause and a comment
// disagree, that is a contract bug, which is why the suite lives WITH the contract and not with the engine.
// The engine's own tests still test the incumbent IMPLEMENTATION; this suite tests the BOUNDARY.
//
// Vitest is imported here (a describe/it factory) exactly as every test file imports it — this module is
// consumed only from *.test.ts files, so the dependency is dev-only in spirit even though it lives in src/.

import { describe, expect, it } from 'vitest';
import type { SolverBindings } from '../bindings';
import { corpusObjective, corpusTunable, feasibleDesign, infeasibleDesign, selectionProblem, SVC, THROUGHPUT, unsatSelectionProblem, violatedDesign } from './corpus';

/** How the suite is tuned per adapter. Cancellation is skip-marked for adapters that do not yet thread an
 *  AbortSignal to the solver (the incumbent — docs §7 step 4): the clause is written but inactive rather than
 *  pretending. `timeBudgetMs` bounds the never-hang clause; `label` names the adapter in the report. */
export interface ConformanceOptions {
  readonly label: string;
  /** The hard time budget (ms) the never-hang clause allows a search to take before it MUST return. */
  readonly timeBudgetMs: number;
  /** Whether the adapter honours an AbortSignal (best-effort cancellation). Skip-marks the clause when false. */
  readonly supportsCancellation?: boolean;
}

/**
 * The conformance describe-block for one adapter. Invoke it from the adapter's own test file:
 * `conformanceOf(makeIncumbentAdapter({ registry, solveMzn, runAsp }), { label: 'incumbent', timeBudgetMs: 20000 })`.
 * Each clause below is one row of the §4 table; a capability the adapter does not bind is skipped, not failed.
 */
export function conformanceOf(bindings: SolverBindings, opts: ConformanceOptions): void {
  const optionalIt = (present: boolean): typeof it | typeof it.skip => (present ? it : it.skip);

  describe(`solver contract conformance — ${opts.label}`, () => {
    // ── CLAUSE: Exactness (the anti-lie clause) ──────────────────────────────────────────────────────────
    // On designs with known answers, the adapter returns the same solution the reference does — the optimum,
    // the repair, the shortfall, the selection set.
    describe('exactness', () => {
      optionalIt(bindings.optimize !== undefined)('optimize returns the known optimum (capacity 300, cost 30) for the feasible design', async () => {
        const r = await bindings.optimize!({ graph: feasibleDesign(), tunables: [corpusTunable], objective: corpusObjective });
        expect(r.kind).toBe('solved');
        if (r.kind !== 'solved') return;
        expect(r.value.assignments[0]?.value).toBeCloseTo(300, 4);
        expect(r.value.value(SVC, corpusObjective.key)).toBeCloseTo(30, 4);
      });

      optionalIt(bindings.repair !== undefined)('repair returns the known minimal change (raise 500 → 800, delta 300)', async () => {
        const r = await bindings.repair!({ graph: violatedDesign(), tunables: [corpusTunable] });
        expect(r.kind).toBe('solved');
        if (r.kind !== 'solved') return;
        expect(r.value).toHaveLength(1);
        expect(r.value[0]?.from).toBe(500);
        expect(r.value[0]?.to).toBeCloseTo(800, 4);
        expect(r.value[0]?.delta).toBeCloseTo(300, 4);
      });

      optionalIt(bindings.explainInfeasible !== undefined)('explainInfeasible returns the known shortfall (floor short by 200)', async () => {
        const r = await bindings.explainInfeasible!({ graph: infeasibleDesign(), tunables: [corpusTunable] });
        expect(r.kind).toBe('solved');
        if (r.kind !== 'solved') return;
        expect(r.value).toHaveLength(1);
        expect(r.value[0]?.key).toBe(THROUGHPUT);
        expect(r.value[0]?.bound).toBe('floor');
        expect(r.value[0]?.amount).toBeCloseTo(200, 4);
      });

      optionalIt(bindings.enumerate !== undefined)('enumerate returns exactly the known valid chains', async () => {
        const r = await bindings.enumerate!({ problem: selectionProblem });
        expect(r.kind).toBe('enumerated');
        if (r.kind !== 'enumerated') return;
        const keyOf = (s: Record<string, string>): string => `${s.ingress}-${s.compute}-${s.store}`;
        expect(r.selections.map(keyOf).sort()).toEqual(['gw-faas-kv', 'gw-faas-sql', 'gw-vm-sql', 'lb-vm-sql']);
      });
    });

    // ── CLAUSE: Honest non-convergence ───────────────────────────────────────────────────────────────────
    // `infeasible` and `did-not-converge` are distinct kinds and never swapped; UNSAT is a VALUE, never a throw.
    describe('honest non-convergence', () => {
      optionalIt(bindings.optimize !== undefined)('a proven-impossible SLO reads `infeasible`, not `did-not-converge`', async () => {
        const r = await bindings.optimize!({ graph: infeasibleDesign(), tunables: [corpusTunable], objective: corpusObjective });
        expect(r.kind).toBe('infeasible');
      });

      optionalIt(bindings.enumerate !== undefined)('an UNSAT selection problem reads an EMPTY enumeration, never an error', async () => {
        const r = await bindings.enumerate!({ problem: unsatSelectionProblem });
        expect(r.kind).toBe('enumerated');
        if (r.kind !== 'enumerated') return;
        expect(r.selections).toEqual([]);
      });

      optionalIt(bindings.enumerate !== undefined)('enumerate never throws on a malformed problem — it returns a value', async () => {
        // A structurally-degenerate problem (a slot with no candidates) must not throw; the adapter returns an
        // honest result (an empty enumeration or did-not-converge), honouring "search never throws".
        const bad = { slots: [{ id: 's', candidates: [] as string[] }], adjacencies: [] as const, compatible: [] as const };
        const r = await bindings.enumerate!({ problem: bad });
        expect(r.kind === 'enumerated' || r.kind === 'did-not-converge').toBe(true);
      });
    });

    // ── CLAUSE: Hard time-bound (never hangs) ────────────────────────────────────────────────────────────
    // A search always RETURNS within the budget — as a solution, best-so-far, or an honest did-not-converge.
    describe('hard time-bound (never hangs)', () => {
      optionalIt(bindings.optimize !== undefined)('optimize returns within the time budget with a defined kind', async () => {
        const t = Date.now();
        const r = await bindings.optimize!({ graph: feasibleDesign(), tunables: [corpusTunable], objective: corpusObjective });
        expect(Date.now() - t).toBeLessThan(opts.timeBudgetMs);
        expect(r.kind).toBeDefined();
      });

      optionalIt(bindings.enumerate !== undefined)('enumerate returns within the time budget with a defined kind', async () => {
        const t = Date.now();
        const r = await bindings.enumerate!({ problem: selectionProblem });
        expect(Date.now() - t).toBeLessThan(opts.timeBudgetMs);
        expect(r.kind).toBeDefined();
      });
    });

    // ── CLAUSE: Determinism under seed ───────────────────────────────────────────────────────────────────
    // Same input ⇒ identical output, run twice. Enumerate additionally returns its canonical order.
    describe('determinism under seed', () => {
      optionalIt(bindings.enumerate !== undefined)('enumerate is byte-reproducible and canonically ordered', async () => {
        const once = await bindings.enumerate!({ problem: selectionProblem });
        const twice = await bindings.enumerate!({ problem: selectionProblem });
        expect(once).toEqual(twice);
        if (once.kind !== 'enumerated') return;
        const canon = [...once.selections].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
        expect(once.selections).toEqual(canon);
      });

      optionalIt(bindings.optimize !== undefined)('optimize is reproducible on the same input', async () => {
        const once = await bindings.optimize!({ graph: feasibleDesign(), tunables: [corpusTunable], objective: corpusObjective });
        const twice = await bindings.optimize!({ graph: feasibleDesign(), tunables: [corpusTunable], objective: corpusObjective });
        expect(once.kind).toBe(twice.kind);
        if (once.kind === 'solved' && twice.kind === 'solved') {
          expect(once.value.value(SVC, corpusObjective.key)).toBeCloseTo(twice.value.value(SVC, corpusObjective.key) ?? NaN, 4);
        }
      });
    });

    // ── CLAUSE: Cancellation (best-effort) ───────────────────────────────────────────────────────────────
    // An already-aborted signal settles promptly WITHOUT producing a stale result. Skip-marked for adapters
    // that do not yet thread the signal to the solver (the incumbent — docs §7 step 4, tracked as follow-up).
    describe('cancellation (best-effort)', () => {
      optionalIt(opts.supportsCancellation === true && bindings.optimize !== undefined)('an already-aborted optimize settles without a stale solution', async () => {
        const c = new AbortController();
        c.abort();
        const r = await bindings.optimize!({ graph: feasibleDesign(), tunables: [corpusTunable], objective: corpusObjective, signal: c.signal });
        // Best-effort: the adapter may return did-not-converge (discarded) — it must NOT return a `solved`
        // result computed after the abort, and it must settle (this test would time out otherwise).
        expect(r.kind).toBe('did-not-converge');
      });
    });
  });

  function keyOf(s: Record<string, string>): string {
    return Object.keys(s).sort().map((k) => `${k}=${s[k]}`).join('|');
  }
}
