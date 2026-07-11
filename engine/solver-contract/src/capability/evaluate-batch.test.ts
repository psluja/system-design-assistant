import { describe, expect, it } from 'vitest';
import type { EvaluateBatch, EvaluateBatchRequest, Scenario } from './evaluate-batch';
import type { Evaluation } from './evaluate';
import { feasibleDesign } from '../conformance/corpus';

// EvaluateBatch is a DECLARED SEAM with no active backend yet (docs §3.6); this test pins the type contract
// so the interface is inhabitable and its models are shaped as documented, without asserting any behaviour.
describe('EvaluateBatch capability (declared seam — N evaluations, one call)', () => {
  it('an implementation maps N scenarios to N Evaluations in order', async () => {
    const scenarios: Scenario[] = [{ overrides: { throughput: 500 } }, { overrides: { throughput: 900 } }];
    const stub: EvaluateBatch = async (req) =>
      req.scenarios.map((): Evaluation => ({ converged: true, value: () => 0, verdicts: [] }));
    const req: EvaluateBatchRequest = { graph: feasibleDesign(), scenarios };
    const out = await stub(req);
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.converged)).toBe(true);
  });

  it('a scenario carries its drawn overrides', () => {
    const s: Scenario = { overrides: { throughput: 750 } };
    expect(s.overrides.throughput).toBe(750);
  });
});
