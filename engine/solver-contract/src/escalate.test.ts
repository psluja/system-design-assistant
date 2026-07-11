import { describe, expect, it, vi } from 'vitest';
import {
  withBudgetEscalation,
  isBudgetCouplingDecline,
  solved,
  infeasible,
  didNotConverge,
  didNotConvergeBecause,
  type DidNotConvergeCode,
} from './index';

// HONEST ESCALATION — the reason-class gate (docs: honest escalation; owner ruling 2026-07-04). The primitive must
// escalate EXACTLY the budget-coupling class to the reference MIP and NOTHING else, and it must be hard-time-bounded
// and never throw across the seam. These are the guarantees the three shells (MCP/VS Code/web) rely on.

// Every declined class EXCEPT budget-coupling — none of these may consult the reference MIP.
const NON_BUDGET_CODES: readonly DidNotConvergeCode[] = ['not-steady', 'saturation', 'coupled', 'budget-explain', 'eval-budget', 'aborted', 'model-error'];

describe('honest escalation — the reason-class gate (budget-coupling ONLY)', () => {
  it('escalates EXACTLY the budget-coupling decline and returns the reference MIP answer, labeled', async () => {
    const native = didNotConvergeBecause('a budget ceiling binds against the objective', 'budget-coupling');
    const reference = vi.fn(async () => solved(42));
    const esc = await withBudgetEscalation<number>(native, reference);
    expect(reference).toHaveBeenCalledOnce();
    expect(esc.via).toBe('escalated');
    expect(esc.result).toEqual(solved(42));
  });

  it('does NOT escalate any OTHER decline reason — the reference is never consulted', async () => {
    for (const code of NON_BUDGET_CODES) {
      const reference = vi.fn(async () => solved(1));
      const esc = await withBudgetEscalation(didNotConvergeBecause('some cause', code), reference);
      expect(reference, `code "${code}" must not escalate`).not.toHaveBeenCalled();
      expect(esc.via).toBe('native');
    }
  });

  it('does NOT escalate a solved or a proven-infeasible native answer', async () => {
    const reference = vi.fn(async () => solved(1));
    expect((await withBudgetEscalation(solved(7), reference)).via).toBe('native');
    expect((await withBudgetEscalation(infeasible, reference)).via).toBe('native');
    expect(reference).not.toHaveBeenCalled();
  });

  it('does NOT escalate a code-less did-not-converge (the gate is the machine code, not the prose)', async () => {
    const reference = vi.fn(async () => solved(1));
    const esc = await withBudgetEscalation(didNotConverge, reference);
    expect(reference).not.toHaveBeenCalled();
    expect(esc.via).toBe('native');
    expect(esc.result).toEqual(didNotConverge);
  });

  it('unavailable reference (no MIP on this install) leaves the native budget-coupling decline standing', async () => {
    const native = didNotConvergeBecause('a budget ceiling binds', 'budget-coupling');
    const esc = await withBudgetEscalation(native, async () => undefined);
    expect(esc.via).toBe('unavailable');
    expect(esc.result).toEqual(native); // the honest native decline, for the loosen-the-ceiling guidance
  });

  it('rides the reference answer through — a proven infeasible or a further decline both label as escalated', async () => {
    const native = didNotConvergeBecause('b', 'budget-coupling');
    const inf = await withBudgetEscalation(native, async () => infeasible);
    expect(inf.via).toBe('escalated');
    expect(inf.result).toEqual(infeasible);
    const dnc = await withBudgetEscalation(native, async () => didNotConverge);
    expect(dnc.via).toBe('escalated');
    expect(dnc.result.kind).toBe('did-not-converge');
  });

  it('hard time-bound: a reference that HANGS settles as an escalated did-not-converge (never hangs)', async () => {
    const native = didNotConvergeBecause('b', 'budget-coupling');
    const t0 = Date.now();
    const esc = await withBudgetEscalation<number>(native, () => new Promise(() => { /* never resolves */ }), 25);
    expect(Date.now() - t0, 'must return well inside a generous margin of the 25ms bound').toBeLessThan(2000);
    expect(esc.via).toBe('escalated');
    expect(esc.result.kind).toBe('did-not-converge');
  });

  it('the time-bound ABORTS the reference signal (best-effort cancellation)', async () => {
    const native = didNotConvergeBecause('b', 'budget-coupling');
    const esc = await withBudgetEscalation<number>(
      native,
      (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(didNotConverge))),
      25,
    );
    expect(esc.via).toBe('escalated');
    expect(esc.result.kind).toBe('did-not-converge');
  });

  it('a reference that THROWS settles as an escalated did-not-converge (the search never throws across the seam)', async () => {
    const native = didNotConvergeBecause('b', 'budget-coupling');
    const esc = await withBudgetEscalation<number>(native, async () => { throw new Error('boom'); });
    expect(esc.via).toBe('escalated');
    expect(esc.result.kind).toBe('did-not-converge');
  });
});

describe('isBudgetCouplingDecline — the exact class predicate', () => {
  it('matches only the budget-coupling code, nothing else', () => {
    expect(isBudgetCouplingDecline(didNotConvergeBecause('x', 'budget-coupling'))).toBe(true);
    expect(isBudgetCouplingDecline(didNotConvergeBecause('x', 'coupled'))).toBe(false);
    expect(isBudgetCouplingDecline(didNotConvergeBecause('x', 'budget-explain'))).toBe(false);
    expect(isBudgetCouplingDecline(didNotConverge)).toBe(false);
    expect(isBudgetCouplingDecline(solved(1))).toBe(false);
    expect(isBudgetCouplingDecline(infeasible)).toBe(false);
  });
});
