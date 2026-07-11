import { describe, expect, it } from 'vitest';
import { Key, NodeId } from '@sda/engine-core';
import { equivalentOptimize, referee, throwOnDivergence, type SolverBindings } from './bindings';
import { enumerated } from './capability/enumerate';
import { didNotConverge, infeasible, solved } from './honesty';
import { corpusObjective, corpusTunable, feasibleDesign, selectionProblem } from './conformance/corpus';

// Two stub adapters standing in for the incumbent and a candidate solver, so the referee harness is proven
// BEFORE a real second solver exists (docs §7 step 6). The trusted answer always ships; the candidate is
// only measured against it.
const optimizeReturning = (value: number): SolverBindings => ({
  evaluate: () => ({ ok: true, value: { converged: true, value: () => value, verdicts: [] } }),
  optimize: async () => solved({ assignments: [{ node: NodeId('svc'), key: Key('cost'), value }], value: () => value }),
});

const req = { graph: feasibleDesign(), tunables: [corpusTunable], objective: corpusObjective } as const;

describe('SolverBindings + referee', () => {
  it('equivalentOptimize compares objective VALUE (float-tolerant), not the knob vector', () => {
    const a = solved({ assignments: [{ node: NodeId('svc'), key: Key('cost'), value: 30 }], value: () => 30 });
    const b = solved({ assignments: [{ node: NodeId('svc'), key: Key('cost'), value: 999 }], value: () => 30.00001 });
    // Same objective read-back (30) despite a different assignment ⇒ equivalent.
    expect(equivalentOptimize(NodeId('svc'), corpusObjective.key, a, b)).toBe(true);
  });

  it('equivalentOptimize flags a genuinely different objective', () => {
    const a = solved({ assignments: [], value: () => 30 });
    const b = solved({ assignments: [], value: () => 45 });
    expect(equivalentOptimize(NodeId('svc'), corpusObjective.key, a, b)).toBe(false);
  });

  it('a divergent kind (solved vs infeasible) is not equivalent', () => {
    const a = solved({ assignments: [], value: () => 30 });
    expect(equivalentOptimize(NodeId('svc'), corpusObjective.key, a, infeasible)).toBe(false);
    expect(equivalentOptimize(NodeId('svc'), corpusObjective.key, didNotConverge, infeasible)).toBe(false);
  });

  it('referee returns the TRUSTED answer when the candidate agrees', async () => {
    const bound = referee(optimizeReturning(30), optimizeReturning(30));
    const r = await bound.optimize!(req);
    expect(r.kind).toBe('solved');
    if (r.kind === 'solved') expect(r.value.value(NodeId('svc'), corpusObjective.key)).toBe(30);
  });

  it('referee reports a divergence as P0 when the candidate disagrees', async () => {
    const reports: string[] = [];
    const bound = referee(optimizeReturning(30), optimizeReturning(45), (cap, detail) => reports.push(`${cap}:${detail}`));
    await bound.optimize!(req);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('optimize');
  });

  it('the default divergence reporter throws (impossible to miss in CI)', () => {
    expect(() => throwOnDivergence('optimize', 'x≠y')).toThrow(/referee divergence in optimize/);
  });

  it('referee binds evaluate to the trusted adapter directly (no referee latency on the hot path)', () => {
    const trusted = optimizeReturning(30);
    const bound = referee(trusted, optimizeReturning(45), () => {});
    expect(bound.evaluate).toBe(trusted.evaluate);
  });

  it('referee compares enumerate selection sets exactly', async () => {
    const enumAdapter = (sels: Record<string, string>[]): SolverBindings => ({
      evaluate: () => ({ ok: true, value: { converged: true, value: () => 0, verdicts: [] } }),
      enumerate: async () => enumerated(sels),
    });
    const reports: string[] = [];
    const bound = referee(
      enumAdapter([{ ingress: 'gw', compute: 'faas', store: 'sql' }]),
      enumAdapter([{ ingress: 'lb', compute: 'vm', store: 'sql' }]),
      (cap) => reports.push(cap),
    );
    await bound.enumerate!({ problem: selectionProblem });
    expect(reports).toEqual(['enumerate']);
  });
});
