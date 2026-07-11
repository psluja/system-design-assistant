import { describe, expect, it } from 'vitest';
import { Key, NodeId, type Result } from '@sda/engine-core';
import type { Evaluate, EvaluateRequest, Evaluation } from './evaluate';
import { feasibleDesign } from '../conformance/corpus';

// A minimal stub implementation proves the interface is inhabitable and its models are shaped as documented.
// The REAL exactness of an implementation is graded by the conformance suite; this only pins the type contract.
describe('Evaluate capability (the sync hot path)', () => {
  it('an implementation returns a synchronous Result<Evaluation> with converged + value + verdicts', () => {
    const stub: Evaluate = (): Result<Evaluation, readonly string[]> => ({
      ok: true,
      value: { converged: true, value: () => 100, verdicts: [] },
    });
    const req: EvaluateRequest = { graph: feasibleDesign() };
    const r = stub(req);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.converged).toBe(true);
    expect(r.value.value(NodeId('svc'), Key('throughput'))).toBe(100);
    expect(r.value.verdicts).toEqual([]);
  });

  it('a build problem is a Result error (a value, not a throw)', () => {
    const stub: Evaluate = (): Result<Evaluation, readonly string[]> => ({ ok: false, error: ['unregistered key'] });
    const r = stub({ graph: feasibleDesign() });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual(['unregistered key']);
  });
});
