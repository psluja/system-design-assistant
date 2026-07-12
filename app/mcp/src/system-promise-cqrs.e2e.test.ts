import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Studio, deserialize } from '@sda/core';
import { registry, allManifests, keys, localContribution, systemSummary, costPromise } from '@sda/content';
import { NodeId, type Key } from '@sda/engine-core';
import { buildSearchTools } from './search';
import { bindSolvers, referenceSolver } from './composition';

// THE SYSTEM-COST PROMISE ON THE OWNER'S EXACT CASE — BOTH REGIMES (owner ruling: cost is for THE WHOLE SYSTEM;
// this round's commission). The committed 23-node CQRS design gains a WHOLE-SYSTEM cost promise
// (`doc.systemPromises`, never a node band), and the backward search must hold it as the whole-graph SUM band:
//   • REGIME 1 — a GENEROUS ceiling: the native in-process solver SOLVES (the budget machinery routes the sum
//     band: excluded witness, descend, verify at the optimum) — no escalation, a bare native result;
//   • REGIME 2 — a TIGHT ceiling binding AGAINST the objective (fastest): the native solver declines with the
//     machine-labelled budget-coupling class and the surface ESCALATES to the exact reference MIP — the answer
//     rides LABELED (`engine: "reference-mip"`), and the applied design's WHOLE-graph total honours the ceiling
//     (which the pre-existing `rstore.cost ≤ 30000` BRANCH band alone could never enforce — it is blind to every
//     off-branch tier).
// The example file is read-only here (owner live examples untouched): the promise is declared on the in-memory
// Studio only. Requires a native `minizinc` (the reference MIP) — the same environment the sibling escalation
// e2e already requires.

const CQRS_FILE = fileURLToPath(new URL('../../../examples/cqrs-production-large.sda.json', import.meta.url));

function loadCqrs(): Studio {
  const doc = deserialize(readFileSync(CQRS_FILE, 'utf8'));
  if (!doc.ok) throw new Error(`could not load the CQRS example: ${doc.error}`);
  const s = new Studio(registry, allManifests);
  s.load(doc.value);
  return s;
}

/** The WHOLE-graph monthly total, computed TWO independent ways off one evaluation — (a) content's own
 *  `systemSummary` (Σ localContribution, the judge's number) and (b) the cumulative-inversion Σout − Σin the
 *  oracle harness reads a total objective with — asserted equal so the reported figure is hand-verifiable. */
function wholeSystemCost(s: Studio): number {
  const ev = s.evaluate();
  if (!ev.ok) throw new Error(`CQRS must evaluate: ${ev.error.join('; ')}`);
  const proj = s.project();
  const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
  const summary = systemSummary(proj.instances, proj.wires, value).totalCostUsdMonth;
  // Independent derivation: Σ_n out(n, cost) − Σ_{edges p→n} out(p, cost) (fan-safe cumulative inversion).
  let inversion = proj.instances.reduce((acc, i) => acc + (value(i.id, keys.cost) ?? 0), 0);
  for (const w of proj.wires) inversion -= value(w.from[0], keys.cost) ?? 0;
  expect(summary).toBeCloseTo(inversion, 4);
  // And the sum of per-node OWN contributions matches too (the exact cells Objective.total / the sum band read).
  const own = localContribution(value, proj.instances, proj.wires, keys.cost);
  expect(summary).toBeCloseTo(Object.values(own).reduce((a, b) => a + b, 0), 4);
  return summary;
}

describe('system-cost promise on CQRS — BOTH regimes (generous ⇒ native solves; tight ⇒ escalates, labeled)', () => {
  it('REGIME 1 — generous ceiling: cheapest (whole-system) solves NATIVELY under the sum band, inside the ceiling', async () => {
    const s = loadCqrs();
    const baseTotal = wholeSystemCost(s);
    expect(baseTotal).toBeGreaterThan(0);
    // A ceiling far above any reachable total — present (the sum band IS in the solve) but never binding.
    const generous = Math.ceil(baseTotal * 10);
    const r0 = s.dispatch({ kind: 'setSystemPromise', promise: costPromise(generous) });
    expect(r0.ok).toBe(true);

    const tools = buildSearchTools(s, bindSolvers(registry), referenceSolver(registry));
    const optimize = tools.find((t) => t.name === 'optimize')!;
    const apply = tools.find((t) => t.name === 'apply_solution')!;
    const t0 = performance.now();
    const r = await optimize.run({ key: String(keys.cost), direction: 'min', scope: 'system' });
    const ms = Math.round(performance.now() - t0);
    expect(r.ok, `cheapest under a generous system ceiling must SOLVE natively, got: ${r.text}`).toBe(true);
    // A NATIVE solve renders the bare assignments ARRAY — no escalation label (the reference MIP was not needed).
    const out = JSON.parse(r.text) as unknown;
    expect(Array.isArray(out), `expected the bare native array, got: ${r.text.slice(0, 200)}`).toBe(true);
    expect((out as unknown[]).length).toBeGreaterThan(0);
    // Apply and verify against the ONE truth: the whole-graph total (the judge's own number) sits inside the ceiling.
    const applied = await apply.run({});
    expect(applied.ok, applied.text).toBe(true);
    expect(wholeSystemCost(s)).toBeLessThanOrEqual(generous + 1e-3);
    expect(ms, `a native solve must stay interactive-adjacent (took ${ms}ms)`).toBeLessThan(20000);
  });

  it('REGIME 2 — tight ceiling against FASTEST: native declines budget-coupling ⇒ the reference MIP answers, LABELED, and the WHOLE total honours the ceiling', async () => {
    // First find a certainly-FEASIBLE tight ceiling: the cheapest whole-system design's applied total, plus 10%
    // slack (the quantized apply rounds whole-unit knobs UP). Feasible by construction — the cheapest design fits —
    // yet far below what maximizing throughput would spend unconstrained, so it BINDS against the objective.
    const cheapest = loadCqrs();
    {
      const tools = buildSearchTools(cheapest, bindSolvers(registry), referenceSolver(registry));
      const r = await tools.find((t) => t.name === 'optimize')!.run({ key: String(keys.cost), direction: 'min', scope: 'system' });
      expect(r.ok, r.text).toBe(true);
      const applied = await tools.find((t) => t.name === 'apply_solution')!.run({});
      expect(applied.ok, applied.text).toBe(true);
    }
    const tight = Math.ceil(wholeSystemCost(cheapest) * 1.1);

    const s = loadCqrs();
    expect(s.dispatch({ kind: 'setSystemPromise', promise: costPromise(tight) }).ok).toBe(true);
    const tools = buildSearchTools(s, bindSolvers(registry), referenceSolver(registry));
    const optimize = tools.find((t) => t.name === 'optimize')!;
    const apply = tools.find((t) => t.name === 'apply_solution')!;
    const t0 = performance.now();
    const r = await optimize.run({ node: 'query', key: String(keys.throughput), direction: 'max' });
    const ms = Math.round(performance.now() - t0);
    expect(r.ok, `fastest under a tight system ceiling must converge via escalation, got: ${r.text}`).toBe(true);
    const out = JSON.parse(r.text) as { engine?: string; basis?: string; assignments?: Array<{ node: string; value: number }> };
    // (1) THE LABEL — the tight regime escalated to the exact reference MIP (never a silent fallback).
    expect(out.engine).toBe('reference-mip');
    expect(out.basis).toBe('exact (reference MIP)');
    expect(out.assignments?.length ?? 0).toBeGreaterThan(0);
    // (2) THE SUM BAND HELD IN THE MIP: apply the labeled proposal and re-judge the WHOLE-graph total against the
    // declared ceiling — the fact the branch band (rstore only) could not enforce.
    const applied = await apply.run({});
    expect(applied.ok, applied.text).toBe(true);
    expect(wholeSystemCost(s), `the applied design's whole-system total must honour the tight ${tight} ceiling`).toBeLessThanOrEqual(tight + 1e-3);
    expect(ms, `escalated optimize took ${ms}ms — must stay hard-bounded`).toBeLessThan(30000);
  });
});
