import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Studio, deserialize } from '@sda/core';
import { registry, allManifests, keys } from '@sda/content';
import { NodeId } from '@sda/engine-core';
import type { SolverBindings } from '@sda/solver-contract';
import { didNotConvergeBecause, solved } from '@sda/solver-contract';
import { buildSearchTools, type ReferenceSolver } from './search';
import { bindSolvers, referenceSolver } from './composition';

// HONEST ESCALATION on the OWNER'S EXACT CASE (owner ruling 2026-07-04; docs: honest escalation). The committed
// 23-node CQRS design carries a total-cost SLO (`rstore.cost ≤ 30000`) — a BUDGET ceiling. When Improve runs an
// objective that RAISES cost (fastest = maximize throughput; or minimize a class-blind cost the budget couples to),
// the native in-process solver honestly DECLINES with the budget-coupling class: a joint knob trade-off outside its
// monotone class. We SHIP the exact optimizer that resolves exactly this class — the incumbent MiniZinc/COIN-BC MIP
// — so the surface must ESCALATE to it rather than dead-end ("set the knobs manually"). This suite locks the fix:
// escalate to the reference MIP and LABEL it; keep the honest extended guidance when no MIP is installed; and never
// escalate any OTHER decline class.

const CQRS_FILE = 'C:/git/SystemDesignAssistant/examples/cqrs-production-large.sda.json';

function loadCqrs(): Studio {
  const doc = deserialize(readFileSync(CQRS_FILE, 'utf8'));
  if (!doc.ok) throw new Error(`could not load the CQRS example: ${doc.error}`);
  const s = new Studio(registry, allManifests);
  s.load(doc.value);
  return s;
}

const tool = (s: Studio, solvers: SolverBindings, name: string, reference?: ReferenceSolver) => {
  const t = buildSearchTools(s, solvers, reference).find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
};

// The owner's exact case over MCP: "fastest under SLOs" is `optimize(<sink>.throughput, max)`. On the query sink it
// declines natively (the read store's cost ceiling binds against maximizing throughput) — so this is the escalation.
const FASTEST = { node: 'query', key: String(keys.throughput), direction: 'max' } as const;

describe('TASK — honest escalation: the CQRS budget-coupling case escalates to the reference MIP (labeled)', () => {
  it('optimize(query.throughput, max): native declines budget-coupling → the reference MIP solves it, labeled', async () => {
    const s = loadCqrs();
    // ONE toolset so `optimize` and `apply_solution` share the proposal store (as the live MCP server holds it).
    const tools = buildSearchTools(s, bindSolvers(registry), referenceSolver(registry));
    const optimize = tools.find((t) => t.name === 'optimize')!;
    const apply = tools.find((t) => t.name === 'apply_solution')!;
    const t0 = performance.now();
    const r = await optimize.run(FASTEST);
    const ms = Math.round(performance.now() - t0);
    expect(r.ok, `optimize must converge via escalation, got: ${r.text}`).toBe(true);
    const out = JSON.parse(r.text) as { engine: string; basis: string; note: string; assignments: Array<{ node: string; key: string; value: number; solution: string }> };
    // (1) THE LABEL — which engine answered (never a silent fallback).
    expect(out.engine).toBe('reference-mip');
    expect(out.basis).toBe('exact (reference MIP)');
    expect(out.note).toContain('reference MIP');
    // (2) A REAL knob assignment (not the trivial empty answer) that the exact MIP proved satisfies every band.
    expect(out.assignments.length).toBeGreaterThan(0);
    expect(out.assignments.every((a) => Number.isFinite(a.value))).toBe(true);
    // (3) The 30k CEILING holds on the sized design: apply the proposal, then read the read-store cost back.
    const applied = await apply.run({});
    expect(applied.ok, applied.text).toBe(true);
    const ev = s.evaluate();
    expect(ev.ok).toBe(true);
    const cost = ev.ok ? ev.value.value(NodeId('rstore'), keys.cost) : undefined;
    expect(cost, 'rstore.cost must be defined on the sized design').toBeDefined();
    expect(cost!, `rstore.cost ${cost} must satisfy the 30000 budget ceiling`).toBeLessThanOrEqual(30000 + 1e-3);
    // Bounded, interactive-adjacent even with the reference-MIP escalation (a longer solve, but still seconds).
    expect(ms, `escalated optimize took ${ms}ms — must stay hard-bounded`).toBeLessThan(20000);
  });

  it('the native decline is NEVER dressed as a timeout, and the escalated answer never says "did not converge"', async () => {
    const s = loadCqrs();
    const r = await tool(s, bindSolvers(registry), 'optimize', referenceSolver(registry)).run(FASTEST);
    expect(r.text).not.toContain('within the time limit');
    expect(r.text).not.toContain('did not converge');
  });

  it('no MIP installed: the SAME case keeps the honest decline EXTENDED with the loosen-the-ceiling hint (no dead end silence)', async () => {
    const s = loadCqrs();
    // A reference that resolves to NOTHING models a shell with no minizinc binary (a VS Code without $MINIZINC).
    const noBinary: ReferenceSolver = { resolve: () => Promise.resolve(undefined) };
    const r = await tool(s, bindSolvers(registry), 'optimize', noBinary).run(FASTEST);
    expect(r.ok).toBe(false);
    // The honest cause survives...
    expect(r.text.toLowerCase()).toContain('budget');
    // ...and it is EXTENDED with the actionable loosen-the-ceiling hint (the new guidance, not a bare dead end).
    expect(r.text).toContain('loosen or remove the budget');
    expect(r.text).toContain('true minimal cost');
    expect(r.text).not.toContain('within the time limit');
  });

  it('the reason-class GATE: a NON-budget decline (a point-band coupling) does NOT consult the reference MIP', async () => {
    const s = loadCqrs();
    // A stub native solver that declines with the `coupled` class (NOT budget-coupling), and a reference whose
    // optimize WOULD "solve" — the gate must keep the reference untouched, so the native decline stands verbatim.
    const stubNative: SolverBindings = {
      evaluate: () => ({ ok: true, value: { converged: true, value: () => undefined, verdicts: [] } as never }),
      optimize: async () => didNotConvergeBecause('an SLO lies outside the in-process solver’s monotone class (a point-target SLO)', 'coupled'),
    };
    const refOptimize = vi.fn(async () => solved({ assignments: [{ node: NodeId('x'), key: keys.cost, value: 1 }], value: () => 1 }));
    const spyReference: ReferenceSolver = {
      resolve: () => Promise.resolve({ evaluate: stubNative.evaluate, optimize: refOptimize }),
    };
    const r = await tool(s, stubNative, 'optimize', spyReference).run(FASTEST);
    expect(refOptimize, 'a non-budget decline must NOT escalate').not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.text).toContain('monotone class'); // the native decline, surfaced verbatim
    expect(r.text).not.toContain('reference-mip'); // NOT a labeled escalation
  });
});
