import { describe, expect, it } from 'vitest';
import { simulate, StationId, type QueueingNetwork, type SimOptions } from './index';

// FLOW-TRANSFORM MULTIPLICITY in the DES. A route edge's `multiplicity` is the mean
// number of jobs it delivers per upstream completion, realised as a true integer count (floor + Bernoulli of the
// fraction). We assert the downstream/upstream completion RATIO matches k (ratio), p (prob/thinning) and 1/n
// (batch) — the scalar↔DES cross-check the honesty contract requires. Comparing COUNT ratios (b/a) cancels the
// measurement-window timing, which fan-out (extra jobs) otherwise skews. `a` is a fast hub so it never queues.

const rel = (got: number, want: number): number => Math.abs(got - want) / Math.abs(want);
const LONG: Pick<SimOptions, 'warmupCompletions' | 'measureCompletions'> = { warmupCompletions: 20000, measureCompletions: 200000 };

/** Ratio of downstream (b) to upstream (a) completions over one run — the empirical edge multiplicity. `a` is a
 *  fast hub, `b` effectively unbounded, so neither queues and every routed job completes. */
function edgeRatio(lambda: number, multiplicity: number, seed: number): number {
  const a = StationId('a');
  const b = StationId('b');
  const net: QueueingNetwork = {
    stations: [
      { id: a, service: { kind: 'exponential', rate: 1000 }, servers: 1 },
      { id: b, service: { kind: 'exponential', rate: 1_000_000 }, servers: 4 },
    ],
    arrivals: [{ at: a, interarrival: { kind: 'exponential', rate: lambda } }],
    routing: new Map([[a, [{ to: b, prob: 1, multiplicity }]]]),
  };
  const r = simulate(net, { seed, ...LONG });
  const aC = r.stations.find((s) => s.id === a)?.completions ?? 0;
  const bC = r.stations.find((s) => s.id === b)?.completions ?? 0;
  return bC / aC;
}

describe('DES flow-transform multiplicity — the mean rate matches the scalar transform', () => {
  it('ratio k>1: downstream completions ≈ k × upstream (log/event amplification)', () => {
    for (const k of [3, 10]) {
      const ratio = edgeRatio(0.5, k, 4242 + k);
      expect(rel(ratio, k), `ratio(${k})`).toBeLessThan(0.03);
    }
  });

  it('fractional ratio 0<f<1: downstream ≈ f × upstream (sampling / cache-miss)', () => {
    for (const f of [0.1, 0.2]) {
      const ratio = edgeRatio(0.8, f, 8080 + Math.round(f * 100));
      expect(rel(ratio, f), `ratio(${f})`).toBeLessThan(0.06);
    }
  });

  it('prob(p) split ≈ p of the completions reach the DLQ downstream', () => {
    const p = 0.05; // 5% error/DLQ split
    const ratio = edgeRatio(0.8, p, 31337);
    expect(rel(ratio, p)).toBeLessThan(0.1); // rarer event ⇒ a looser but honest bound
  });

  it('batch(n) thinning: 1/n of the arrivals reach the aggregator downstream', () => {
    const n = 10; // batch(10) ⇒ multiplicity 1/10
    const ratio = edgeRatio(1.0, 1 / n, 5150);
    expect(rel(ratio, 1 / n)).toBeLessThan(0.06);
  });

  it('multiplicity 1 is exactly one downstream job per upstream completion (unchanged fan-out)', () => {
    expect(edgeRatio(0.8, 1, 2024)).toBeCloseTo(1, 6);
  });
});
