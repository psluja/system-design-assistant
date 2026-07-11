import { describe, expect, it } from 'vitest';
import type { TwoTierResult, Tier2Result, TimeSweep } from '@sda/content';
import { LOAD_STAGES_PRESETS } from '@sda/content';
import { backlogSparkline, originShapeGlyph, twoTierSection } from './two-tier-view';

// The ambient two-tier view-model — the ONE composition both shells render (doc: load-stages §10). These pin the
// Tier-1 rows (ρ-envelope strip, worst-window callout with the peaking node, cost integral, %-in-violation), the
// two-tier BASIS labelling (analytic + measured, never blurred), the resting-handshake gate (Tier-2 rows appear
// only when Tier 2 has run), the survival-verdict grammar (whole-ms tails, toned recovery), and the sparkline
// arithmetic (max-pooled — a peak never disappears).

function sweep(over: Partial<TimeSweep> = {}): TimeSweep {
  return {
    windows: [
      { tStartS: 0, rhoByNode: { db: 0.3 }, requiredUnitsByNode: {}, rhoMax: 0.3, cost: 100, violations: 0 },
      { tStartS: 900, rhoByNode: { db: 0.6 }, requiredUnitsByNode: {}, rhoMax: 0.6, cost: 100, violations: 0 },
      { tStartS: 1800, rhoByNode: { db: 1.2, svc: 0.4 }, requiredUnitsByNode: {}, rhoMax: 1.2, cost: 100, violations: 1 },
      { tStartS: 2700, rhoByNode: { db: 0.5 }, requiredUnitsByNode: {}, rhoMax: 0.5, cost: 100, violations: 0 },
    ],
    worstWindowIndex: 2,
    rhoEnvelope: [0.3, 0.6, 1.2, 0.5],
    costIntegral: 4210,
    pctWindowsViolating: 0.25,
    spanS: 3600,
    windowS: 900,
    basis: 'analytic (quasi-static)',
    ...over,
  };
}

const tier2 = (over: Partial<Tier2Result> = {}, verdictOver: Partial<Tier2Result['verdict']> = {}): Tier2Result => ({
  verdict: {
    survives: true,
    recoversInS: 60,
    peakBacklog: { node: 'db', value: 312, atS: 98 },
    p99DuringMs: 12345.6,
    p99AfterMs: 41.4,
    lostRequests: 0,
    amplificationPeak: 1,
    note: 'worst window recovers within ~60s of the peak, no requests lost',
    basis: 'measured (transient)',
    ...verdictOver,
  },
  windows: [],
  backlog: [
    { node: 'db', perWindow: [0, 0, 50, 200, 312, 150, 20, 0], peak: 312, peakAtS: 98 },
    { node: 'svc', perWindow: [0, 0, 0, 0, 0, 0, 0, 0], peak: 0, peakAtS: NaN },
  ],
  phases: { startAbsS: 1000, peakAtS: 800, horizonS: 2000, windowS: 33 },
  budget: { estimatedEvents: 6000, eventsProcessed: 5987, eventCap: 5_000_000, truncated: false, endS: 2000 },
  seed: 7,
  worst: { atS: 2250, rho: 1.2, node: 'db' },
  ...over,
});

const result = (over: Partial<TwoTierResult> = {}): TwoTierResult => ({ tier1: sweep(), tier2: tier2(), ...over });

const labelOf = (id: string): string => (id === 'db' ? 'Postgres' : id === 'svc' ? 'Order service' : id);

describe('twoTierSection — the ambient two-tier read-out, one composition for both shells', () => {
  it('Tier-1 rows: ρ-envelope strip, worst-window callout naming the peaking node, cost integral, %-in-violation', () => {
    const s = twoTierSection(result(), labelOf);
    expect(s.title).toBe('Load stages · transient');
    const env = s.rows.find((r) => r.label === 'Load envelope · ρ(t)')!;
    expect(env.value).toMatch(/^[▁▂▃▄▅▆▇█]{4} peak ρ 1\.20$/);
    expect(env.tone).toBe('bad'); // peak ρ ≥ 1 is a saturation violation

    const worst = s.rows.find((r) => r.label === 'Worst window')!;
    expect(worst.value).toBe('at 38m · ρ 1.20 · Postgres'); // (1800 + 900/2) = 2250 s ⇒ ~38 min; node argmax = db
    expect(worst.tone).toBe('bad');

    expect(s.rows.find((r) => r.label === 'Cost · mean over span')!.value).toBe('$4,210/mo');
    expect(s.rows.find((r) => r.label === 'Over capacity')!.value).toBe('25% of the span');
    expect(s.rows.find((r) => r.label === 'Over capacity')!.tone).toBe('warn');
  });

  it('both bases are labelled once Tier 2 has run — analytic + measured, never blurred', () => {
    const s = twoTierSection(result(), labelOf);
    expect(s.rows.find((r) => r.label === 'Basis')!.value).toBe('Tier 1 analytic (quasi-static) · Tier 2 measured (transient)');
  });

  it('the resting handshake: Tier-1 alone (no Tier 2 yet) shows the envelope + "measuring…", no verdict rows', () => {
    const s = twoTierSection({ tier1: sweep() }, labelOf);
    expect(s.rows.some((r) => r.label === 'Load envelope · ρ(t)')).toBe(true);
    expect(s.rows.some((r) => r.label === 'Worst window · verdict')).toBe(false);
    expect(s.rows.find((r) => r.label === 'Basis')!.value).toContain('Tier 2 measuring…');
  });

  it('a surviving Tier 2: ok verdict tone, peak backlog named by label, whole-ms tails', () => {
    const s = twoTierSection(result(), labelOf);
    const verdict = s.rows.find((r) => r.label === 'Worst window · verdict')!;
    expect(verdict.tone).toBe('ok');
    expect(verdict.value).toContain('recovers within ~60s');
    expect(s.rows.find((r) => r.label === 'Peak backlog')!.value).toBe('312 waiting · Postgres · at +98 s');
    expect(s.rows.find((r) => r.label === 'p99 rising to peak')!.value).toBe('12,346 ms');
    expect(s.rows.find((r) => r.label === 'p99 after peak')!.value).toBe('41 ms');
  });

  it('a non-surviving Tier 2: bad tones on the verdict, the peak and the after-tail', () => {
    const s = twoTierSection(
      result({ tier2: tier2({}, { survives: false, recoversInS: null, lostRequests: 214, note: 'does not recover: backlog still growing at the worst window (312 waiting at db)' }) }),
      labelOf,
    );
    expect(s.rows.find((r) => r.label === 'Worst window · verdict')!.tone).toBe('bad');
    expect(s.rows.find((r) => r.label === 'Peak backlog')!.tone).toBe('bad');
    expect(s.rows.find((r) => r.label === 'p99 after peak')!.tone).toBe('bad');
    const lost = s.rows.find((r) => r.label === 'Lost requests')!;
    expect(lost.value).toBe('214');
    expect(lost.tone).toBe('bad');
  });

  it('no-filler gates: no amplification row at ×1; no sparkline when nothing ever queued', () => {
    const s = twoTierSection(
      result({ tier2: tier2({ backlog: [{ node: 'db', perWindow: [0, 0, 0], peak: 0, peakAtS: NaN }] }, { peakBacklog: null, amplificationPeak: 1 }) }),
      labelOf,
    );
    expect(s.rows.some((r) => r.label.startsWith('Retry amplification'))).toBe(false);
    expect(s.rows.some((r) => r.label.startsWith('Backlog ·'))).toBe(false);
    expect(s.rows.find((r) => r.label === 'Peak backlog')!.value).toBe('none — no queue ever formed');
  });

  it('a measured retry storm shows the peak amplification with a warn tone', () => {
    const s = twoTierSection(result({ tier2: tier2({}, { amplificationPeak: 1.87 }) }), labelOf);
    const amp = s.rows.find((r) => r.label === 'Retry amplification · peak')!;
    expect(amp.value).toBe('×1.87');
    expect(amp.tone).toBe('warn');
  });

  it('budget honesty: a truncated Tier 2 reads PARTIAL with a warn tone and its verdict can never read green', () => {
    const s = twoTierSection(
      result({ tier2: tier2({ budget: { estimatedEvents: 9_000_000, eventsProcessed: 5_000_000, eventCap: 5_000_000, truncated: true, endS: 143 } }) }),
      labelOf,
    );
    const budget = s.rows.find((r) => r.label === 'Event budget')!;
    expect(budget.value).toContain('PARTIAL — stopped at +143 s');
    expect(budget.tone).toBe('warn');
    expect(s.rows.find((r) => r.label === 'Worst window · verdict')!.tone).toBe('bad');
  });
});

describe('backlogSparkline — max-pooled compact chart (a peak never disappears)', () => {
  it('scales to the series maximum with ▁ as the zero glyph and █ at the peak', () => {
    expect(backlogSparkline([0, 1, 2, 4, 8])).toBe('▁▂▃▅█');
  });
  it('an all-zero series is a flat baseline', () => {
    expect(backlogSparkline([0, 0, 0])).toBe('▁▁▁');
  });
  it('downsamples by MAX-pooling: a single-window peak survives any compression', () => {
    const series = new Array<number>(96).fill(1);
    series[50] = 1000;
    const spark = backlogSparkline(series, 32);
    expect(spark.length).toBe(32);
    expect(spark).toContain('█');
  });
  it('an empty series is an empty chart', () => {
    expect(backlogSparkline([])).toBe('');
  });
});

describe('originShapeGlyph — the canvas ⚡ chip shape hint (doc: load-stages §11)', () => {
  it('a shaped generator yields a short (≤7-glyph) silhouette that is NOT flat (peak > baseline glyph)', () => {
    const glyph = originShapeGlyph([...LOAD_STAGES_PRESETS.diurnal]);
    expect(glyph.length).toBeLessThanOrEqual(7);
    expect(glyph).toContain('█'); // the rush-hour peak survives into the compact chip
    expect(new Set(glyph.split('')).size).toBeGreaterThan(1); // a real shape, not a flat bar
  });

  it('an on-off-burst reads as a spiky silhouette (the burst survives max-pooling)', () => {
    const glyph = originShapeGlyph([...LOAD_STAGES_PRESETS['on-off-burst']]);
    expect(glyph).toContain('█'); // the ×5 pulse is never averaged away
  });

  it('a flat (all-×1) generator is a flat glyph — the caller shows the chip only for a shaped origin', () => {
    const glyph = originShapeGlyph([{ periodS: 100, stages: [{ durationS: 50, multiplier: 1 }] }]);
    expect(new Set(glyph.split('')).size).toBe(1); // no variation ⇒ one repeated glyph
  });
});
