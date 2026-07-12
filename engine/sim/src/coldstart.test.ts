import { describe, expect, it } from 'vitest';
import { mulberry32 } from './rng';
import { mean, sample, type Distribution } from './distribution';
import { simulate, StationId, type QueueingNetwork } from './index';

// Cold starts: most requests are fast, a fraction pay a spin-up penalty. The mean barely moves; the
// TAIL is where the cold start actually hurts — which is exactly what the time engine exposes.
describe('cold-start distribution', () => {
  const dist: Distribution = { kind: 'coldStart', base: { kind: 'deterministic', value: 50 }, penalty: 200, probability: 0.1 };

  it('mean = base + probability · penalty', () => {
    expect(mean(dist)).toBe(70); // 50 + 0.1·200
  });

  it('is bimodal — about 10% of samples pay the penalty', () => {
    const rng = mulberry32(1);
    let cold = 0;
    let sum = 0;
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      const v = sample(dist, rng);
      sum += v;
      if (v > 200) cold += 1; // 50 (warm) vs 250 (cold)
    }
    expect(sum / n).toBeCloseTo(70, 0);
    expect(cold / n).toBeCloseTo(0.1, 1);
  });

  it('surfaces in the DES tail: p99 ≫ p50', () => {
    const s = StationId('fn');
    const net: QueueingNetwork = {
      stations: [
        {
          id: s,
          service: { kind: 'coldStart', base: { kind: 'exponential', rate: 1 / 0.05 }, penalty: 0.2, probability: 0.1 },
          servers: 50,
        },
      ],
      arrivals: [{ at: s, interarrival: { kind: 'exponential', rate: 200 } }],
      routing: new Map(),
    };
    const r = simulate(net, { seed: 5, warmupCompletions: 5000, measureCompletions: 50000 });
    expect(r.sojournPercentile(0.99)).toBeGreaterThan(r.sojournPercentile(0.5));
    expect(r.meanSojourn).toBeGreaterThan(0.05); // > the warm base mean
  });
});
