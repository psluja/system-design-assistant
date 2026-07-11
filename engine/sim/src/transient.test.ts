import { describe, expect, it } from 'vitest';
import { simulate, StationId, type QueueingNetwork, type SimResult } from './index';
import { profileMean, type RateProfile } from './profile';
import {
  backlogGrowingAtEnd,
  drainTimeS,
  estimateTransientEvents,
  type StationBacklog,
  type TransientMetrics,
  type TransientWindow,
} from './transient';

// THE TRANSIENT (WINDOWED) RUN — the spike probe's engine seam. These tests pin:
//  (1) THE ANALYTIC ANCHORS (fluid limit of the M/M/1 with a step overload): while λ > μ the backlog grows at
//      (λ − μ) jobs/s; once the overload ends it drains at (μ − λ₀) jobs/s — the windowed backlog series must
//      show BOTH slopes and the drain time must match backlog/(μ − λ₀);
//  (2) a STABLE spike (×K still under capacity) survives with near-zero backlog and immediate recovery;
//  (3) the retry DEATH SPIRAL (undersized + retries) reads "does not recover" HONESTLY (backlog not draining);
//  (4) ONE-SHOT profiles: periodS = horizon ⇒ the spike never replays (the wrap is unreachable — the run stops);
//  (5) window math (grid, count conservation, amplification identity), determinism, and BUDGET HONESTY (the
//      hard event cap stops the run and says so — truncated + partial last window, never silent scaling);
//  (6) a run WITHOUT the option carries no transient field (the steady-state path is untouched — the sacred
//      flat-profile byte-identity in profile.test.ts guards the rest).

/** A one-station M/M/1 fed by a ONE-SHOT 3-phase spike profile: m=1 (baseline) → m=multiplier (spike) → m=1
 *  (recovery), with `rampS`-second linear ramps, periodS = the whole horizon (so a transient run never wraps).
 *  The declared DES rate is baseRate × m̄ — normalize-at-read then makes the effective λ(t) exactly baseRate·m(t). */
function spikeNet(cfg: {
  readonly baseRate: number;
  readonly serviceRate: number;
  readonly multiplier: number;
  readonly baselineS: number;
  readonly rampS: number;
  readonly spikeS: number;
  readonly horizonS: number;
  readonly timeoutMs?: number;
  readonly retries?: number;
}): QueueingNetwork {
  const a = StationId('a');
  const { baselineS, rampS, spikeS, multiplier } = cfg;
  const profile: RateProfile = {
    periodS: cfg.horizonS,
    points: [
      { t: 0, m: 1 },
      { t: baselineS, m: 1 },
      { t: baselineS + rampS, m: multiplier },
      { t: baselineS + rampS + spikeS, m: multiplier },
      { t: baselineS + rampS + spikeS + rampS, m: 1 },
    ],
  };
  return {
    stations: [{ id: a, service: { kind: 'exponential', rate: cfg.serviceRate }, servers: 1 }],
    arrivals: [
      {
        at: a,
        interarrival: { kind: 'exponential', rate: cfg.baseRate * profileMean(profile) },
        rateProfile: profile,
        ...(cfg.timeoutMs !== undefined
          ? { attemptPolicy: { timeoutMs: cfg.timeoutMs, retries: cfg.retries ?? 0, backoffMs: 100 } }
          : {}),
      },
    ],
    routing: new Map(),
  };
}

/** The transient block, asserted present (every test here opts in). */
function transientOf(r: SimResult): TransientMetrics {
  expect(r.transient).toBeDefined();
  return r.transient as TransientMetrics;
}

describe('analytic anchors — M/M/1 with a step overload (fluid limit)', () => {
  // μ=100, λ₀=50 (ρ=0.5 at rest), ×4 spike ⇒ λ₁=200 for 60 s. Anchors: growth (λ₁−μ)=100 jobs/s during the
  // overload; peak ≈ 100×60 = 6000 (Poisson noise √((λ+μ)T) ≈ 134 ≪ 6000); drain (μ−λ₀)=50 jobs/s afterwards
  // ⇒ ~120 s to empty. Tiny ramps (1 s) keep the fluid arithmetic sharp.
  const cfg = { baseRate: 50, serviceRate: 100, multiplier: 4, baselineS: 30, rampS: 1, spikeS: 60, horizonS: 260 };
  const spikeStartS = cfg.baselineS + cfg.rampS; // 31 — overload begins
  const spikeEndS = cfg.baselineS + cfg.rampS + cfg.spikeS + cfg.rampS; // 92 — load fully back to base
  const r = simulate(spikeNet(cfg), { seed: 7, warmupCompletions: 0, measureCompletions: 0, transient: { horizonS: cfg.horizonS, windowS: 10 } });
  const t = transientOf(r);
  const backlog = t.backlog[0] as StationBacklog;

  it('backlog GROWS at ≈ (λ₁ − μ) jobs/s while overloaded', () => {
    // Two consecutive whole-overload windows: [40,50) and [50,60) — the max grows by ≈ 100 jobs/s × 10 s = 1000.
    const w4 = backlog.maxPerWindow[4] as number;
    const w5 = backlog.maxPerWindow[5] as number;
    const growth = w5 - w4;
    expect(growth).toBeGreaterThan(1000 * 0.8);
    expect(growth).toBeLessThan(1000 * 1.2);
  });

  it('peaks at ≈ (λ₁ − μ) × spikeS jobs, at the END of the overload', () => {
    const expectedPeak = (cfg.baseRate * cfg.multiplier - cfg.serviceRate) * cfg.spikeS; // 6000
    expect(backlog.peak).toBeGreaterThan(expectedPeak * 0.9);
    expect(backlog.peak).toBeLessThan(expectedPeak * 1.1);
    expect(backlog.peakAtS).toBeGreaterThan(spikeStartS + cfg.spikeS * 0.9); // near the end of the overload…
    expect(backlog.peakAtS).toBeLessThan(spikeEndS + 10); // …never far past it
  });

  it('DRAINS at ≈ (μ − λ₀) jobs/s once the overload ends', () => {
    // Two consecutive whole-drain windows: [100,110) and [110,120) — the max falls by ≈ 50 jobs/s × 10 s = 500.
    const w10 = backlog.maxPerWindow[10] as number;
    const w11 = backlog.maxPerWindow[11] as number;
    const drop = w10 - w11;
    expect(drop).toBeGreaterThan(500 * 0.75);
    expect(drop).toBeLessThan(500 * 1.25);
  });

  it('drain time ≈ peak / (μ − λ₀) — the fluid-limit clock, window-quantized', () => {
    // Theory: 6000 / 50 = 120 s. drainTimeS is conservative (the END of the first clean window) and the p99 of a
    // window still flushing old backlog stays high, so allow one extra window on top of the quantization.
    const drain = drainTimeS(t, { spikeEndS, baselineEndS: cfg.baselineS, p99Tolerance: 1.5, p99SlackS: 0.005 });
    expect(drain).not.toBeNull();
    expect(drain as number).toBeGreaterThan(105);
    expect(drain as number).toBeLessThan(160);
  });

  it('windowed p99 shows the spike: orders of magnitude above baseline during, back within tolerance after', () => {
    const byStart = new Map(t.windows.map((w) => [w.startS, w]));
    const baselineWin = byStart.get(10) as TransientWindow; // settled baseline window
    const overloadWin = byStart.get(70) as TransientWindow; // deep in the overload — long queued sojourns
    const lastWin = t.windows[t.windows.length - 1] as TransientWindow;
    expect(overloadWin.p99S).toBeGreaterThan(baselineWin.p99S * 20);
    expect(lastWin.p99S).toBeLessThan(baselineWin.p99S * 1.5 + 0.005);
  });
});

describe('a STABLE spike (×K still under capacity) — survives with near-zero backlog', () => {
  // μ=100, λ₀=20, ×3 ⇒ 60 < 100: the spike raises ρ to 0.6 — busier, but never overloaded.
  const cfg = { baseRate: 20, serviceRate: 100, multiplier: 3, baselineS: 30, rampS: 1, spikeS: 60, horizonS: 160 };
  const spikeEndS = cfg.baselineS + cfg.rampS + cfg.spikeS + cfg.rampS;
  const r = simulate(spikeNet(cfg), { seed: 7, warmupCompletions: 0, measureCompletions: 0, transient: { horizonS: cfg.horizonS, windowS: 10 } });
  const t = transientOf(r);

  it('backlog stays trivial (queueing noise, not accumulation) and recovery is immediate', () => {
    expect((t.backlog[0] as StationBacklog).peak).toBeLessThan(30); // vs the 6000 of the overloaded anchor
    const drain = drainTimeS(t, { spikeEndS, baselineEndS: cfg.baselineS, p99Tolerance: 1.5, p99SlackS: 0.005 });
    expect(drain).not.toBeNull();
    expect(drain as number).toBeLessThanOrEqual(20); // within the first window or two — nothing to drain
  });

  it('no retry policy ⇒ every window with arrivals reads amplification exactly 1 and zero failures', () => {
    for (const w of t.windows) {
      if (w.arrivals === 0) continue;
      expect(w.amplification).toBe(1);
      expect(w.failed).toBe(0);
    }
  });
});

describe('the retry DEATH SPIRAL — undersized + retries reads "does not recover", honestly', () => {
  // μ=50, λ₀=45 (ρ=0.9 — tight but healthy at rest: waits ≪ the 60 s client patience, amplification 1), then a
  // ×4 spike (180/s) for 60 s. The spike builds a queue MINUTES deep; from then on every attempt waits out its
  // full 60 s patience, abandons and re-fires (retry ×1) — the attempt stream stays ≈ 2×λ₀ ≥ μ, so the storm
  // OUTLIVES the spike: the cohort is still cycling (and failing out) at the window's end, the backlog never
  // returns to baseline, and the probe must say so — never a fabricated recovery.
  const cfg = { baseRate: 45, serviceRate: 50, multiplier: 4, baselineS: 30, rampS: 1, spikeS: 60, horizonS: 260, timeoutMs: 60_000, retries: 1 };
  const spikeEndS = cfg.baselineS + cfg.rampS + cfg.spikeS + cfg.rampS;
  const r = simulate(spikeNet(cfg), { seed: 7, warmupCompletions: 0, measureCompletions: 0, transient: { horizonS: cfg.horizonS, windowS: 10 } });
  const t = transientOf(r);

  it('the baseline is healthy — the storm is spike-TRIGGERED, not a sick design at rest', () => {
    const firstWins = t.windows.filter((w) => w.endS <= cfg.baselineS);
    for (const w of firstWins) {
      expect(w.amplification).toBe(1); // no retries at rest
      expect(w.failed).toBe(0);
    }
  });

  it('never recovers within the window: the backlog stays orders of magnitude above baseline', () => {
    expect(drainTimeS(t, { spikeEndS, baselineEndS: cfg.baselineS, p99Tolerance: 1.5, p99SlackS: 0.005 })).toBeNull();
    const backlog = t.backlog[0] as StationBacklog;
    const baselineMax = Math.max(...backlog.maxPerWindow.slice(0, 3));
    const lastMax = backlog.maxPerWindow[backlog.maxPerWindow.length - 1] as number;
    expect(lastMax).toBeGreaterThan(Math.max(baselineMax, 1) * 50);
  });

  it('the windows expose the storm: amplification well past unity and real failures after the spike ended', () => {
    // The retry waves ride the 60 s patience clock, so amplification is wave-shaped — the honest signal is the
    // post-spike PEAK (retries multiplying the offered work long after the overload ended), not one fixed window.
    const postSpike = t.windows.filter((w) => w.startS >= spikeEndS);
    const peakAmplification = Math.max(...postSpike.map((w) => w.amplification));
    expect(peakAmplification).toBeGreaterThan(1.5);
    const failedAfterSpike = postSpike.reduce((s, w) => s + w.failed, 0);
    expect(failedAfterSpike).toBeGreaterThan(0); // retries exhaust ⇒ honest failures, long after the spike ended
  });
});

describe('one-shot profiles: periodS = horizon ⇒ the spike never replays', () => {
  it('tail-phase arrivals run at the BASE rate (the wrap segment is unreachable)', () => {
    const cfg = { baseRate: 40, serviceRate: 100, multiplier: 4, baselineS: 20, rampS: 1, spikeS: 20, horizonS: 200 };
    const r = simulate(spikeNet(cfg), { seed: 11, warmupCompletions: 0, measureCompletions: 0, transient: { horizonS: cfg.horizonS, windowS: 10 } });
    const t = transientOf(r);
    // Windows [100, 200) are all pure recovery: ≈ baseRate × 10 arrivals each — and nowhere near ×multiplier.
    const tail = t.windows.filter((w) => w.startS >= 100);
    const meanArrivals = tail.reduce((s, w) => s + w.arrivals, 0) / tail.length;
    expect(meanArrivals).toBeGreaterThan(cfg.baseRate * 10 * 0.8);
    expect(meanArrivals).toBeLessThan(cfg.baseRate * 10 * 1.2);
  });
});

describe('window math + determinism', () => {
  const cfg = { baseRate: 30, serviceRate: 100, multiplier: 2, baselineS: 10, rampS: 1, spikeS: 10, horizonS: 55 };
  const run = (seed: number): SimResult =>
    simulate(spikeNet(cfg), { seed, warmupCompletions: 0, measureCompletions: 0, transient: { horizonS: cfg.horizonS, windowS: 10 } });

  it('the windows tile [0, horizon] exactly — the last one clipped to the horizon', () => {
    const t = transientOf(run(7));
    expect(t.windows.length).toBe(6); // ceil(55 / 10)
    t.windows.forEach((w, i) => {
      expect(w.startS).toBe(i * 10);
      expect(w.endS).toBe(Math.min((i + 1) * 10, 55));
    });
    expect(t.endS).toBe(55);
    expect(t.truncated).toBe(false);
  });

  it('per-window outcome counts sum to the run totals (nothing double-counted, nothing lost)', () => {
    const r = run(7);
    const t = transientOf(r);
    const served = t.windows.reduce((s, w) => s + w.served, 0);
    const failed = t.windows.reduce((s, w) => s + w.failed, 0);
    expect(served + failed).toBe(r.completions);
    // The per-station backlog series covers every window.
    for (const b of t.backlog) expect(b.maxPerWindow.length).toBe(t.windows.length);
  });

  it('a fixed seed reproduces the whole transient block byte-for-byte; another seed differs', () => {
    const a = transientOf(run(42));
    const b = transientOf(run(42));
    expect(JSON.parse(JSON.stringify(b))).toStrictEqual(JSON.parse(JSON.stringify(a)));
    const c = transientOf(run(43));
    expect(JSON.parse(JSON.stringify(c))).not.toStrictEqual(JSON.parse(JSON.stringify(a)));
  });

  it('a steady-state run carries NO transient block (the classic path is untouched)', () => {
    const net = spikeNet(cfg);
    const r = simulate(net, { seed: 7, warmupCompletions: 100, measureCompletions: 1000 });
    expect(r.transient).toBeUndefined();
  });
});

describe('budget honesty — the hard event cap stops the run and SAYS so', () => {
  it('truncates at the cap: partial last window, endS < horizon, never a silently scaled workload', () => {
    const cfg = { baseRate: 50, serviceRate: 100, multiplier: 2, baselineS: 10, rampS: 1, spikeS: 10, horizonS: 100 };
    const r = simulate(spikeNet(cfg), { seed: 7, warmupCompletions: 0, measureCompletions: 0, transient: { horizonS: cfg.horizonS, windowS: 10, maxEvents: 500 } });
    const t = transientOf(r);
    expect(t.truncated).toBe(true);
    expect(t.eventsProcessed).toBe(500);
    expect(t.eventCap).toBe(500);
    expect(t.endS).toBeLessThan(cfg.horizonS);
    expect(t.windows.length).toBeLessThan(10); // only the windows actually reached
    const last = t.windows[t.windows.length - 1] as TransientWindow;
    expect(last.endS).toBeCloseTo(t.endS, 9); // the honest partial window — clipped, not stretched
  });

  it('the up-front estimate is printed with the result and is in the right ballpark for a tandem network', () => {
    // Two stations in series: every request costs 1 external-arrival event + 1 departure per station visit = 3.
    const a = StationId('a');
    const b = StationId('b');
    const net: QueueingNetwork = {
      stations: [
        { id: a, service: { kind: 'exponential', rate: 100 }, servers: 1 },
        { id: b, service: { kind: 'exponential', rate: 100 }, servers: 1 },
      ],
      arrivals: [{ at: a, interarrival: { kind: 'exponential', rate: 20 } }],
      routing: new Map([[a, [{ to: b, prob: 1 }]]]),
    };
    expect(estimateTransientEvents(net, 100)).toBe(20 * 100 * (1 + 2)); // 6,000
    const r = simulate(net, { seed: 7, warmupCompletions: 0, measureCompletions: 0, transient: { horizonS: 100, windowS: 10 } });
    const t = transientOf(r);
    expect(t.estimatedEvents).toBe(6000);
    expect(t.eventsProcessed).toBeGreaterThan(6000 * 0.85);
    expect(t.eventsProcessed).toBeLessThan(6000 * 1.15);
  });
});

describe('drainTimeS + backlogGrowingAtEnd on synthetic fixtures (the pure arithmetic)', () => {
  const win = (startS: number, p99S: number, samples = 100): TransientWindow => ({
    startS,
    endS: startS + 10,
    arrivals: 100,
    attempts: 100,
    served: 100,
    failed: 0,
    p50S: p99S / 2,
    p99S,
    samples,
    amplification: 1,
  });
  const metrics = (p99s: readonly number[], series: readonly number[]): TransientMetrics => ({
    horizonS: p99s.length * 10,
    windowS: 10,
    endS: p99s.length * 10,
    windows: p99s.map((p, i) => win(i * 10, p)),
    backlog: [{ id: StationId('a'), maxPerWindow: series, peak: Math.max(...series), peakAtS: 0 }],
    eventsProcessed: 0,
    estimatedEvents: 0,
    eventCap: 0,
    truncated: false,
  });

  it('finds the FIRST post-spike window where backlog AND p99 are back within the baseline envelope', () => {
    // Baseline [0,20): backlog ≤ 2, p99 0.05. Spike ends at 40; window [40,50) still fat, [50,60) recovered.
    const t = metrics([0.05, 0.05, 2, 3, 1, 0.06], [2, 1, 500, 900, 400, 2]);
    expect(drainTimeS(t, { spikeEndS: 40, baselineEndS: 20, p99Tolerance: 1.5 })).toBe(20); // window [50,60) ends 20 s after
  });

  it('backlog alone is not enough — a drained queue with a still-fat p99 is NOT recovered', () => {
    const t = metrics([0.05, 0.05, 2, 3, 1, 1], [2, 1, 500, 900, 400, 2]);
    expect(drainTimeS(t, { spikeEndS: 40, baselineEndS: 20, p99Tolerance: 1.5 })).toBeNull();
  });

  it('reports growth-at-end only when the last window is nonzero and not below the one before', () => {
    expect(backlogGrowingAtEnd(metrics([1, 1, 1], [0, 100, 200]))).toBe(true); // growing
    expect(backlogGrowingAtEnd(metrics([1, 1, 1], [0, 200, 200]))).toBe(true); // plateaued full — not draining
    expect(backlogGrowingAtEnd(metrics([1, 1, 1], [0, 200, 100]))).toBe(false); // draining
    expect(backlogGrowingAtEnd(metrics([1, 1, 1], [0, 100, 0]))).toBe(false); // drained
  });
});
