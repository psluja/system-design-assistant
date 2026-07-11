import { describe, expect, it } from 'vitest';
import { isFlatProfile, nextArrivalDelay, peakFactorOf, profileMean, profilePeak, profileValue, type RateProfile } from './profile';
import { mulberry32 } from './rng';
import { simulate, StationId, type QueueingNetwork, type SimOptions, type SimResult } from './index';

// THE RATE-PROFILE MODULE (doc: load-curves §3, §6) — the ONE home of load-curve arithmetic. These tests pin:
//  (1) the piecewise-linear evaluators (interpolation incl. the wrap segment, trapezoid mean, vertex peak, k);
//  (2) the INVERSION sampler's exactness (Λ(t + Δ) − Λ(t) = E to numerical precision — the closed-form
//      per-segment inverse really inverts the integrated rate);
//  (3) the NHPP's shape (arrivals distribute across the period ∝ the normalized multiplier) and its mean-rate
//      preservation (normalize-at-read: the level stays the period's MEAN);
//  (4) THE SACRED BYTE-IDENTITY (load-curves tension 4): a FLAT profile — and an absent one — leaves the whole
//      simulation byte-for-byte today's. This is the testable identity that justified inversion over
//      Lewis–Shedler thinning; weakening it would un-pin "no curve ≡ today".

/** A 24 h day in seconds — the shape content lowers a LoadCurve into. */
const DAY = 24 * 3600;

/** An evening-peak-ish asymmetric day: quiet night, climb, sharp evening peak, fall. Drawn multipliers are NOT
 *  mean-1 on purpose (m̄ ≈ drawn mean > 0) so normalize-at-read is actually exercised. */
const eveningPeak: RateProfile = {
  periodS: DAY,
  points: [
    { t: 0, m: 0.3 },
    { t: 6 * 3600, m: 0.3 },
    { t: 9 * 3600, m: 1.2 },
    { t: 16 * 3600, m: 1.5 },
    { t: 19 * 3600, m: 2.6 },
    { t: 21 * 3600, m: 2.0 },
  ],
};

/** Numerically integrate the NORMALIZED rate λ(u) = rate · m(u)/m̄ over [a, b] (fine trapezoid) — the reference
 *  Λ the closed-form inversion must invert. */
function integratedRate(p: RateProfile, rate: number, a: number, b: number): number {
  const mean = profileMean(p);
  const steps = 20000;
  const h = (b - a) / steps;
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const w = i === 0 || i === steps ? 0.5 : 1;
    sum += w * profileValue(p, a + i * h);
  }
  return (rate / mean) * sum * h;
}

describe('rate-profile evaluators (piecewise-linear, periodic)', () => {
  it('interpolates linearly between vertices and across the wrap segment', () => {
    // Between (16h, 1.5) and (19h, 2.6): halfway at 17.5h ⇒ 2.05.
    expect(profileValue(eveningPeak, 17.5 * 3600)).toBeCloseTo(2.05, 12);
    // The wrap segment runs (21h, 2.0) → (24h+0h, 0.3): halfway at 22.5h ⇒ 1.15.
    expect(profileValue(eveningPeak, 22.5 * 3600)).toBeCloseTo(1.15, 12);
    // Periodicity: one whole period later is the same value.
    expect(profileValue(eveningPeak, 17.5 * 3600 + DAY)).toBeCloseTo(2.05, 12);
  });

  it('a single point is a flat period at that multiplier', () => {
    const flat: RateProfile = { periodS: DAY, points: [{ t: 5 * 3600, m: 0.7 }] };
    expect(profileValue(flat, 0)).toBe(0.7);
    expect(profileValue(flat, 13 * 3600)).toBe(0.7);
    expect(profileMean(flat)).toBe(0.7);
    expect(peakFactorOf(flat)).toBe(1);
    expect(isFlatProfile(flat)).toBe(true);
  });

  it('the mean is the trapezoid integral over the period (wrap included) and k = max/mean', () => {
    // A symmetric triangle 0.5 → 1.5 → (wrap back to 0.5) has mean exactly 1.0 and peak 1.5.
    const triangle: RateProfile = { periodS: DAY, points: [{ t: 0, m: 0.5 }, { t: 12 * 3600, m: 1.5 }] };
    expect(profileMean(triangle)).toBeCloseTo(1.0, 12);
    expect(profilePeak(triangle)).toBe(1.5);
    expect(peakFactorOf(triangle)).toBeCloseTo(1.5, 12);
    // The evening-peak day: reference numeric mean matches the closed-form trapezoid.
    const ref = integratedRate(eveningPeak, 1, 0, DAY) / (DAY / profileMean(eveningPeak)); // = m̄ by construction
    expect(profileMean(eveningPeak)).toBeCloseTo(ref, 6);
    expect(peakFactorOf(eveningPeak)).toBeCloseTo(2.6 / profileMean(eveningPeak), 12);
  });
});

describe('NHPP arrivals by inversion (Çinlar time-change; Lewis & Shedler 1979 thinning is the documented fallback)', () => {
  it('inverts the integrated rate exactly: Λ(now → now+Δ) = E for random draws across the day', () => {
    const rng = mulberry32(7);
    const rate = 50;
    let t = 0;
    for (let i = 0; i < 200; i++) {
      const e = -Math.log(1 - rng.next());
      const dt = nextArrivalDelay(eveningPeak, rate, t, e);
      expect(dt).toBeGreaterThan(0);
      const got = integratedRate(eveningPeak, rate, t, t + dt);
      expect(Math.abs(got - e) / e).toBeLessThan(1e-3); // reference is a numeric trapezoid — its error, not ours
      t += dt;
    }
  });

  it('distributes arrivals across the period ∝ the normalized shape, and preserves the MEAN rate', () => {
    const rng = mulberry32(1234);
    const rate = 2; // 2/s × 10 days ⇒ ~1.7M... keep it small: 2/s over 20 periods of a short day
    const short: RateProfile = { periodS: 1000, points: [{ t: 0, m: 0.5 }, { t: 500, m: 1.5 }] }; // mean 1 triangle
    const horizon = 20 * short.periodS;
    let t = 0;
    let firstHalf = 0;
    let total = 0;
    while (t < horizon) {
      t += nextArrivalDelay(short, rate, t, -Math.log(1 - rng.next()));
      if (t >= horizon) break;
      total += 1;
      if (t % short.periodS < 500) firstHalf += 1;
    }
    // Mean preservation (normalize-at-read): expected total = rate × horizon.
    expect(Math.abs(total - rate * horizon) / (rate * horizon)).toBeLessThan(0.05);
    // Shape: ∫m̂ over the first half (0.5→1.5 rising) = ∫ over the second (1.5→0.5 falling) = 1/2 each for this
    // symmetric triangle — so halves split ~50/50 — but their PROFILES differ; use quarters for the asymmetry:
    expect(Math.abs(firstHalf / total - 0.5)).toBeLessThan(0.03);
    // Quarter check: [0,250) integrates m̂ from 0.5 to 1.0 ⇒ 0.75/4 of the day's mass ≈ 18.75%.
    const rng2 = mulberry32(99);
    let t2 = 0;
    let q1 = 0;
    let n2 = 0;
    while (t2 < horizon) {
      t2 += nextArrivalDelay(short, rate, t2, -Math.log(1 - rng2.next()));
      if (t2 >= horizon) break;
      n2 += 1;
      if (t2 % short.periodS < 250) q1 += 1;
    }
    expect(Math.abs(q1 / n2 - 0.1875)).toBeLessThan(0.03);
  });

  it('rides through zero-rate stretches (m = 0) without stalling — the arrival lands after them', () => {
    // Dead night: m = 0 across [0, 500); all mass in [500, 1000).
    const gated: RateProfile = { periodS: 1000, points: [{ t: 0, m: 0 }, { t: 499, m: 0 }, { t: 500, m: 2 }, { t: 999, m: 2 }] };
    const dt = nextArrivalDelay(gated, 1, 0, 0.001);
    expect(dt).toBeGreaterThan(499); // nothing can arrive inside the dead stretch
    expect(dt).toBeLessThan(1000);
  });

  it('is deterministic: the same draws yield the same arrival times', () => {
    const delays = (seed: number): number[] => {
      const rng = mulberry32(seed);
      const out: number[] = [];
      let t = 0;
      for (let i = 0; i < 50; i++) {
        const dt = nextArrivalDelay(eveningPeak, 10, t, -Math.log(1 - rng.next()));
        out.push(dt);
        t += dt;
      }
      return out;
    };
    expect(delays(42)).toEqual(delays(42));
  });
});

// ── THE SACRED BYTE-IDENTITY (load-curves tension 4) ────────────────────────────────────────────────────────
// A FLAT profile must reduce to today's exponential draw LITERALLY: same uniforms, same IEEE operations, same
// event order — so the whole SimResult is byte-identical, not statistically close. This is the pinned identity
// that makes "no curve ≡ today" a fact, not a claim. DO NOT weaken to toBeCloseTo.

/** A two-tier M/M/c network with retries off — enough moving parts that any RNG drift would surface. */
function tandem(profileOn: 'none' | 'flat'): QueueingNetwork {
  const a = StationId('a');
  const b = StationId('b');
  // A flat profile at an arbitrary multiplier (0.7 everywhere, several vertices) — normalize-at-read makes the
  // effective m̂ ≡ 1 exactly, so the modulated stream IS the homogeneous one.
  const flat: RateProfile = { periodS: DAY, points: [{ t: 0, m: 0.7 }, { t: 8 * 3600, m: 0.7 }, { t: 17 * 3600, m: 0.7 }] };
  return {
    stations: [
      { id: a, service: { kind: 'exponential', rate: 12 }, servers: 1 },
      { id: b, service: { kind: 'exponential', rate: 9 }, servers: 2 },
    ],
    arrivals: [{ at: a, interarrival: { kind: 'exponential', rate: 8 }, ...(profileOn === 'flat' ? { rateProfile: flat } : {}) }],
    routing: new Map([[a, [{ to: b, prob: 1 }]]]),
  };
}

/** Every scalar the simulator reports, flattened for exact equality (functions sampled at fixed percentiles). */
function fingerprint(r: SimResult): unknown {
  return {
    measuredTime: r.measuredTime,
    completions: r.completions,
    departureRate: r.departureRate,
    meanNumberInSystem: r.meanNumberInSystem,
    meanSojourn: r.meanSojourn,
    p50: r.sojournPercentile(0.5),
    p95: r.sojournPercentile(0.95),
    p99: r.sojournPercentile(0.99),
    stations: r.stations,
    nodeResponse: r.nodeResponse,
    goodputRps: r.goodputRps,
    errorRate: r.errorRate,
    amplification: r.amplification,
  };
}

describe('flat curve ≡ no curve, byte-for-byte (the sacred identity — never weaken)', () => {
  it('a FLAT rateProfile leaves every metric byte-identical to the profile-free run', () => {
    const opts: SimOptions = { seed: 7, warmupCompletions: 2000, measureCompletions: 20000 };
    for (const seed of [7, 42, 20260705]) {
      const base = fingerprint(simulate(tandem('none'), { ...opts, seed }));
      const flat = fingerprint(simulate(tandem('flat'), { ...opts, seed }));
      expect(flat).toStrictEqual(base);
    }
  });

  it('a NON-flat profile changes the realisation (the modulation is real, not a no-op)', () => {
    const net = tandem('none');
    const shaped: QueueingNetwork = {
      ...net,
      arrivals: [{ at: StationId('a'), interarrival: { kind: 'exponential', rate: 8 }, rateProfile: eveningPeak }],
    };
    const opts: SimOptions = { seed: 7, warmupCompletions: 2000, measureCompletions: 20000 };
    const base = fingerprint(simulate(net, opts));
    const mod = fingerprint(simulate(shaped, opts));
    expect(mod).not.toStrictEqual(base);
  });
});
