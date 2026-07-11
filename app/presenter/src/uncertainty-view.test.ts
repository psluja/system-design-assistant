import { describe, expect, it } from 'vitest';
import { Key } from '@sda/engine-core';
import type { UncertaintyResult } from '@sda/content';
import { uncertaintySection } from './uncertainty-view';

// The ambient-uncertainty view-model (TASK-81): the resting handshake made visible. These pin that fp32 PREVIEW
// and CPU-CONFIRMED render as DIFFERENT, honest states, and that the metric/SLO rows read as the doc specifies.

const result = (over: Partial<UncertaintyResult> = {}): UncertaintyResult => ({
  seed: 24301,
  scenarios: 500,
  rangedInputs: [{ node: 'db', key: 'unitCost', kind: 'uniform' }],
  metrics: [{ name: 'cost', unit: 'USD/month', median: 5746.9, p5: 5000, p95: 7200, mean: 5800, min: 4800, max: 7600, histogram: [] }],
  sloConfidence: [{ scope: 'svc', key: String(Key('latency')), satisfiedFraction: 0.97 }],
  tornado: [],
  ...over,
});

describe('uncertaintySection — the resting handshake is visible and honest', () => {
  it('null result while computing shows a computing state row (no fabricated numbers)', () => {
    const s = uncertaintySection({ result: null, state: 'computing', backend: 'gpu' });
    expect(s).not.toBeNull();
    expect(s!.rows[0]!.value).toContain('computing');
    expect(s!.rows).toHaveLength(1); // no metric/SLO rows until a result exists (no-filler)
  });

  it('nothing to show (no result, not computing) yields no section', () => {
    expect(uncertaintySection({ result: null, state: 'confirmed' })).toBeNull();
  });

  it('a PREVIEW is tagged fp32 (GPU) — explicitly NOT verdict-grade', () => {
    const s = uncertaintySection({ result: result(), state: 'preview', backend: 'gpu', elapsedMs: 8 });
    const state = s!.rows.find((r) => r.label === 'State')!;
    expect(state.value).toMatch(/preview · fp32 \(GPU\)/);
    expect(state.value).toContain('seed 24301');
    expect(state.tone).toBeUndefined(); // a preview never reads as an OK/confirmed truth
  });

  it('a CONFIRMED pass carries seed + N and an OK tone (verdict-grade)', () => {
    const s = uncertaintySection({ result: result(), state: 'confirmed', backend: 'cpu', elapsedMs: 620 });
    const state = s!.rows.find((r) => r.label === 'State')!;
    expect(state.value).toContain('confirmed');
    expect(state.value).toContain('seed 24301');
    expect(state.value).toContain('500 scenarios');
    expect(state.tone).toBe('ok');
  });

  it('metrics read as median (p5–p95); SLO confidence reads as % scenarios ✓ with a tone', () => {
    const s = uncertaintySection({ result: result(), state: 'confirmed' }, (id) => (id === 'svc' ? 'Checkout API' : id));
    const cost = s!.rows.find((r) => r.label === 'cost')!;
    expect(cost.value).toMatch(/\(.*–.*\)/); // a p5–p95 band
    const slo = s!.rows.find((r) => r.label.startsWith('Checkout API'))!;
    expect(slo.value).toMatch(/%\s+scenarios ✓/);
    expect(slo.tone).toBe('ok'); // 97% ≥ 95% ⇒ ok
  });
});
