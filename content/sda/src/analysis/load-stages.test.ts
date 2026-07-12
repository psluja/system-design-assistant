import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { NodeId, cyclesProblem, type Cycle, type Key } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import {
  allManifests,
  combinedCycleProfile,
  cycleMultiplier,
  cyclesToProfile,
  derivedMean,
  derivedPeak,
  generatorRate,
  instantiate,
  keys,
  LOAD_STAGES_DEFAULTS,
  LOAD_STAGES_PRESETS,
  registry,
  shapeSeries,
  shortestFeatureStageS,
  STRESS_DEFAULTS,
  toQueueingNetwork,
  type Instance,
  type Wire,
} from '../index';

// LOAD STAGES — the λ(t) evaluator, the derived mean/peak, the presets, and the SACRED flat byte-identity
//. These pin: a hold is constant, a ramp is monotone, ×1 = the level; cycles MULTIPLY
// within a generator (§5); the mean bills and the peak judges (§7); a flat generator is byte-for-byte today.

describe('cycleMultiplier — piecewise-linear k6 ramp semantics', () => {
  const ramp: Cycle = { periodS: 200, stages: [{ durationS: 100, multiplier: 2 }] }; // ×1 → ×2 over [0,100], wrap back
  const hold: Cycle = { periodS: 300, stages: [{ durationS: 100, multiplier: 2 }, { durationS: 100, multiplier: 2 }] };

  it('starts at the ×1 baseline and ramps LINEARLY to the target', () => {
    expect(cycleMultiplier(ramp, 0)).toBeCloseTo(1, 9);
    expect(cycleMultiplier(ramp, 50)).toBeCloseTo(1.5, 9); // halfway up the ramp
    expect(cycleMultiplier(ramp, 100)).toBeCloseTo(2, 9);
  });

  it('a HOLD stage (multiplier repeats the previous) is constant across its span', () => {
    expect(cycleMultiplier(hold, 100)).toBeCloseTo(2, 9);
    expect(cycleMultiplier(hold, 150)).toBeCloseTo(2, 9); // still ×2 — a flat hold, not a ramp
    expect(cycleMultiplier(hold, 200)).toBeCloseTo(2, 9);
  });

  it('a ramp is MONOTONE up its stage (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 99, noNaN: true }), fc.double({ min: 0, max: 99, noNaN: true }), (a, b) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        expect(cycleMultiplier(ramp, lo)).toBeLessThanOrEqual(cycleMultiplier(ramp, hi) + 1e-9);
      }),
      { numRuns: 40 },
    );
  });

  it('wraps periodically (t and t + periodS agree)', () => {
    for (const t of [0, 37, 88, 150]) expect(cycleMultiplier(ramp, t)).toBeCloseTo(cycleMultiplier(ramp, t + ramp.periodS), 9);
  });
});

describe('generatorRate — λ(t) = level · Π cycles(t), the PRODUCT within a generator', () => {
  it('no cycles ⇒ the flat baseline level (the identity)', () => {
    expect(generatorRate(500, undefined, 123)).toBe(500);
    expect(generatorRate(500, [], 123)).toBe(500);
  });

  it('two cycles MULTIPLY — the busy hour of the busy week superimposes', () => {
    // Both cycles peak at ×3 at t = 100 (aligned), so their product there is ×9 off the baseline.
    const c1: Cycle = { periodS: 400, stages: [{ durationS: 100, multiplier: 3 }, { durationS: 100, multiplier: 1 }] };
    const c2: Cycle = { periodS: 400, stages: [{ durationS: 100, multiplier: 3 }, { durationS: 100, multiplier: 1 }] };
    expect(generatorRate(10, [c1, c2], 100)).toBeCloseTo(10 * 3 * 3, 6); // 90 — the peaks multiply
    expect(generatorRate(10, [c1, c2], 0)).toBeCloseTo(10, 6); // both at ×1 baseline ⇒ the level
  });

  it('a flat cycle contributes a factor of exactly 1 (adding it can only reshape, never rescale)', () => {
    const flat: Cycle = { periodS: 100, stages: [{ durationS: 50, multiplier: 1 }] };
    for (const t of [0, 25, 60, 99]) expect(generatorRate(700, [flat], t)).toBeCloseTo(700, 9);
  });
});

describe('derived mean & peak — the mean bills, the peak judges', () => {
  const cycle: Cycle = { periodS: 200, stages: [{ durationS: 100, multiplier: 2 }] };

  it('single cycle: mean & peak are EXACT (the profile trapezoid mean / vertex max)', () => {
    expect(derivedMean(100, [cycle])).toBeCloseTo(150, 6); // level × mean(shape) = 100 × 1.5
    expect(derivedPeak(100, [cycle])).toBeCloseTo(200, 6); // level × peak(shape) = 100 × 2
  });

  it('no cycles ⇒ mean = peak = the level (flat)', () => {
    expect(derivedMean(100, undefined)).toBe(100);
    expect(derivedPeak(100, [])).toBe(100);
  });

  it('multi-cycle peak lands ABOVE either alone and no higher than the product of peaks (superposition)', () => {
    const daily: Cycle = { periodS: 400, stages: [{ durationS: 100, multiplier: 2 }, { durationS: 100, multiplier: 1 }] };
    const weekly: Cycle = { periodS: 1600, stages: [{ durationS: 400, multiplier: 3 }, { durationS: 400, multiplier: 1 }] };
    const peak = derivedPeak(1, [daily, weekly]);
    expect(peak).toBeGreaterThan(3); // above the weekly peak alone
    expect(peak).toBeLessThanOrEqual(2 * 3 + 1e-9); // never above the product of the two peaks
  });
});

describe('shapeSeries — the ONE editor-preview sampler', () => {
  it('no cycles ⇒ a flat ×1 series of the asked length (the sacred identity — a preview line, not a wiggle)', () => {
    expect(shapeSeries(undefined, 8)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(shapeSeries([], 4)).toEqual([1, 1, 1, 1]);
  });

  it('samples the product shape over the SLOWEST period — its peak equals derivedPeak(1, cycles) at that instant', () => {
    const cycle: Cycle = { periodS: 200, stages: [{ durationS: 100, multiplier: 3 }, { durationS: 100, multiplier: 1 }] };
    const series = shapeSeries([cycle], 200); // dense enough to land on the ×3 vertex
    const peak = series.reduce((mx, v) => Math.max(mx, v), 0);
    expect(peak).toBeCloseTo(derivedPeak(1, [cycle]), 6); // the drawn peak IS the evaluated peak (anti-drift)
    expect(series[0]).toBeCloseTo(1, 9); // the shape starts at the ×1 baseline
  });

  it('count is floored at 1 — a degenerate ask still yields a point, never an empty polyline', () => {
    expect(shapeSeries([{ periodS: 100, stages: [{ durationS: 50, multiplier: 2 }] }], 0).length).toBe(1);
  });

  it('the diurnal preset previews as a non-flat hump (peak > trough)', () => {
    const series = shapeSeries(LOAD_STAGES_PRESETS.diurnal, 96);
    const peak = Math.max(...series);
    const trough = Math.min(...series);
    expect(peak).toBeGreaterThan(trough); // a real day has a rush hour and a lull
  });
});

describe('the SACRED flat byte-identity', () => {
  it('combinedCycleProfile / cyclesToProfile detect a flat generator (all ×1) as undefined — property', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 1, max: 3600 }), (n, dur) => {
        // Every stage at ×1 ⇒ a flat shape ⇒ no profile (the DES then samples exponentially, byte-for-byte today).
        const stages = Array.from({ length: n }, () => ({ durationS: dur, multiplier: 1 }));
        const cycle: Cycle = { periodS: (n + 1) * dur, stages };
        expect(combinedCycleProfile([cycle])).toBeUndefined();
        expect(cyclesToProfile([cycle])).toBeUndefined();
      }),
      { numRuns: 30 },
    );
  });

  it('a flat-cycle generator projects to the SAME DES arrival as a no-cycle generator (byte-for-byte)', () => {
    const build = (cycles?: Cycle[]): ReturnType<typeof toQueueingNetwork> => {
      const instances: Instance[] = [
        { id: 'svc', type: 'compute.service', transforms: { out: { kind: 'generate', level: 800, ...(cycles !== undefined ? { cycles } : {}) } } },
        { id: 'aurora', type: 'db.aurora' },
      ];
      const wires: Wire[] = [{ from: ['svc', 'out'], to: ['aurora', 'in'] }];
      const g = instantiate(allManifests, instances, wires);
      if (!g.ok) throw new Error(JSON.stringify(g.error));
      return toQueueingNetwork(g.value);
    };
    const bare = build();
    const flat = build([{ periodS: 86_400, stages: [{ durationS: 43_200, multiplier: 1 }] }]);
    expect(flat.arrivals).toStrictEqual(bare.arrivals); // identical rate (800), no rateProfile — the sacred pin
  });
});

describe('multi-origin SUM — a batch report is its own generator node', () => {
  it('two generator origins feeding one sink SUM their baseline load; the batch node keeps its own cycles', () => {
    const quarterly: Cycle[] = [{ periodS: 7_776_000, stages: [{ durationS: 10_800, multiplier: 3 }, { durationS: 10_800, multiplier: 1 }] }];
    const instances: Instance[] = [
      { id: 'web', type: 'compute.service', transforms: { out: { kind: 'generate', level: 300 } } },
      { id: 'batch', type: 'compute.service', transforms: { out: { kind: 'generate', level: 200, cycles: quarterly } } }, // the additive report job
      { id: 'sink', type: 'db.aurora' },
    ];
    const wires: Wire[] = [
      { from: ['web', 'out'], to: ['sink', 'in'] },
      { from: ['batch', 'out'], to: ['sink', 'in'] },
    ];
    const g = instantiate(allManifests, instances, wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const r = evaluate(g.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    // The sink's offered load is the SUM of the two origins (baseline; the scalar pass reads the baseline, §7).
    expect(r.value.value(NodeId('sink'), keys.throughput as Key)).toBe(500);
    // Each origin injects its OWN arrival stream (Poisson superposition) — two arrival sources, not one.
    const qn = toQueueingNetwork(g.value);
    const rates = new Map(qn.arrivals.map((a) => [String(a.at), a.interarrival.kind === 'exponential' ? a.interarrival.rate : NaN]));
    expect(rates.get('web')).toBe(300);
    expect(rates.get('batch')).toBeCloseTo(derivedMean(200, quarterly), 6); // the batch node rides its cycle's mean
  });
});

describe('presets & the absorbed STRESS_DEFAULTS', () => {
  it('every shipped preset is a well-formed cycle list (flat is empty)', () => {
    for (const [name, cycles] of Object.entries(LOAD_STAGES_PRESETS)) {
      expect(cyclesProblem(cycles), name).toBeNull();
    }
    expect(LOAD_STAGES_PRESETS.flat).toEqual([]); // the ×1 identity — no cycles
  });

  it('the spike preset is BUILT FROM STRESS_DEFAULTS (absorbed — cannot drift)', () => {
    const spike = LOAD_STAGES_PRESETS.spike[0] as Cycle;
    expect(spike.stages.map((s) => s.multiplier)).toEqual([1, STRESS_DEFAULTS.multiplier, STRESS_DEFAULTS.multiplier, 1]);
    expect(spike.stages.map((s) => s.durationS)).toEqual([STRESS_DEFAULTS.baselineS, STRESS_DEFAULTS.rampS, STRESS_DEFAULTS.spikeS, STRESS_DEFAULTS.rampS]);
    expect(LOAD_STAGES_DEFAULTS.desSeed).toBe(STRESS_DEFAULTS.seed); // the seed absorbed verbatim
  });

  it('the diurnal preset peaks at ×1.8 and the quarterly at ×3 (the §5 stack)', () => {
    expect(derivedPeak(1, LOAD_STAGES_PRESETS.diurnal)).toBeCloseTo(1.8, 6);
    expect(derivedPeak(1, LOAD_STAGES_PRESETS['quarterly-report'])).toBeCloseTo(3, 6);
  });

  // THE ONE-SHOT ENCODING — a spike/ramp-up is a SHORT cycle whose period is its own
  // total duration, NOT a 30-day non-repeating period (which pushed the sweep window past the feature so it vanished).
  it('the one-shot presets (spike, ramp-up) have a SHORT period = their own total duration (a few minutes)', () => {
    for (const name of ['spike', 'ramp-up'] as const) {
      const cycle = LOAD_STAGES_PRESETS[name][0] as Cycle;
      const total = cycle.stages.reduce((t, st) => t + st.durationS, 0);
      expect(cycle.periodS).toBe(total); // the period IS the shape's own scheduled duration
      expect(cycle.periodS).toBeLessThanOrEqual(600); // a few minutes — not the old 30-day (2 592 000 s) period
    }
    expect((LOAD_STAGES_PRESETS.spike[0] as Cycle).periodS).toBe(STRESS_DEFAULTS.baselineS + 2 * STRESS_DEFAULTS.rampS + STRESS_DEFAULTS.spikeS); // 160
    // The derived PEAK is unchanged by the shorter period (peak is a vertex, not a span average): spike still ×3.
    expect(derivedPeak(1, LOAD_STAGES_PRESETS.spike)).toBeCloseTo(3, 6);
    expect(derivedPeak(1, LOAD_STAGES_PRESETS['ramp-up'])).toBeCloseTo(2, 6);
  });

  it('the periodic presets keep their REAL periods (diurnal a day, quarterly 90 days)', () => {
    expect((LOAD_STAGES_PRESETS.diurnal[0] as Cycle).periodS).toBe(86_400);
    expect((LOAD_STAGES_PRESETS['on-off-burst'][0] as Cycle).periodS).toBe(600);
    expect((LOAD_STAGES_PRESETS['quarterly-report'][0] as Cycle).periodS).toBe(7_776_000);
  });
});

describe('shortestFeatureStageS — the shortest ramp/hold to resolve, past the hard-step edges (doc: §16.3 A)', () => {
  it('returns the shortest stage durationS across cycles (the feature the fine window must sample)', () => {
    const cycle: Cycle = { periodS: 400, stages: [{ durationS: 200, multiplier: 2 }, { durationS: 60, multiplier: 1 }] };
    expect(shortestFeatureStageS([cycle])).toBe(60);
  });

  it('EXCLUDES the near-instant hard-step edges (≤ 1 s) — the ON-plateau hold is the feature, not the 1 s step', () => {
    // on-off-burst: [ε→×5, 59 s ×5, ε→×1, 500 s ×1]; the two ε steps (1 s) are edges, so the shortest FEATURE is the
    // 59 s ×5 hold (not the 1 s step, which would force a needless 0.25 s window and ~4 800 windows).
    expect(shortestFeatureStageS(LOAD_STAGES_PRESETS['on-off-burst'])).toBe(59);
    // Proof the step is what's excluded: including it (a bare min over all stages) would be 1.
    const rawMin = Math.min(...LOAD_STAGES_PRESETS['on-off-burst'].flatMap((c) => c.stages.map((st) => st.durationS)));
    expect(rawMin).toBe(1);
  });

  it('no cycles ⇒ 0 (the period resolution alone governs — no feature bound)', () => {
    expect(shortestFeatureStageS([])).toBe(0);
    expect(shortestFeatureStageS(LOAD_STAGES_PRESETS.flat)).toBe(0);
  });

  it('the spike preset resolves to its 5 s ramp (the shortest non-edge stage)', () => {
    expect(shortestFeatureStageS(LOAD_STAGES_PRESETS.spike)).toBe(STRESS_DEFAULTS.rampS); // 5
  });
});
