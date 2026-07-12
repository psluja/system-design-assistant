import { describe, expect, it } from 'vitest';
import type { EnvelopeResult, WorldsResult } from '@sda/content';
import { envelopeSection } from './envelope-view';
import { worldsMatrix, activeLensLabel, overrideProvenanceLabel, overrideProvenanceBadge } from './worlds-view';

// THE ASSUMPTION-MODEL view-models — the ONE composition both shells render. These pin
// the envelope-by-default headline forms (to-X / band / no-origin reason), the worlds matrix rows, and the visible
// active-lens tagging (never a silent mix — doc tension #4).

describe('envelopeSection — the default answer, honest in every state', () => {
  it('shows the per-origin headline + first break + knee + the two-view hint', () => {
    const env: EnvelopeResult = {
      perOrigin: [{ node: 'users', key: 'throughput', baseRps: 2000, maxRps: 5000, basis: 'slo', firstBreak: { node: 'kafka', key: 'overflow' } }],
      knee: { atRps: 4000, node: 'kafka', utilization: 0.8 },
    };
    const s = envelopeSection({ result: env })!;
    expect(s.title).toBe('Load limits');
    expect(s.rows[0]!.value).toBe('handles up to 5,000 req/s — first to break: kafka');
    expect(s.rows.some((r) => r.value.includes('up to ~4,000 req/s'))).toBe(true);
    expect(s.rows.some((r) => r.value.includes('set a demand scenario'))).toBe(true); // absolutes need a point (§3.2)
  });

  it('shows the BAND form when a floor SLO makes the feasible set a band (the finale shape)', () => {
    const env: EnvelopeResult = {
      perOrigin: [{ node: 'users', key: 'throughput', baseRps: 2000, maxRps: 5000, minRps: 2000, basis: 'slo', firstBreak: { node: 'kafka', key: 'overflow' } }],
    };
    const s = envelopeSection({ result: env })!;
    expect(s.rows[0]!.value).toContain('handles 2,000–5,000 req/s');
  });

  it('with NO traffic origin shows the honest reason (naming the enabling move), never a fabricated boundary', () => {
    const env: EnvelopeResult = { perOrigin: [], note: "No traffic origin — add a generator on a node's output port (or add a client)" };
    const s = envelopeSection({ result: env })!;
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]!.value).toContain('add a generator');
  });

  it('is honest while computing, and silent before any pass', () => {
    expect(envelopeSection({ result: null, computing: true })!.rows[0]!.value).toBe('measuring…');
    expect(envelopeSection({ result: null })).toBeNull();
  });
});

const worlds: WorldsResult = {
  worlds: [
    { id: 'base', costUsdMonth: 2000, feasible: true, violations: 0, peakRho: 0.4, verdicts: [], staleOverrides: [] },
    { id: 'pessimistic', name: 'Pessimistic', costUsdMonth: 3900, feasible: false, violations: 1, peakRho: 1.08, verdicts: [{ scope: 'kafka', key: 'overflow', status: 'violation', value: 100, unit: 'req/s' }], staleOverrides: [] },
    { id: 'real', name: 'Real', costUsdMonth: 2140, feasible: true, violations: 0, peakRho: 0.55, verdicts: [], staleOverrides: [] },
  ],
};

describe('worldsMatrix — the comparison matrix + the visible active lens', () => {
  it('names the active lens, marks the active row ●, and tones a violating world red with its worst cell', () => {
    const s = worldsMatrix({ result: worlds, active: 'real' })!;
    expect(s.title).toBe('Worlds · lens: Real');
    const real = s.rows.find((r) => r.label.includes('Real'))!;
    expect(real.label.startsWith('●')).toBe(true);
    expect(real.tone).toBe('ok');
    const pess = s.rows.find((r) => r.label.includes('Pessimistic'))!;
    expect(pess.label.startsWith('○')).toBe(true);
    expect(pess.tone).toBe('bad');
    expect(pess.value).toContain('1 violation (kafka.overflow)');
    expect(s.rows.find((r) => r.label.includes('base'))!.value).toContain('$2,000/mo');
  });

  it('with no active world the BASE row is the marked lens', () => {
    const s = worldsMatrix({ result: worlds })!; // no active ⇒ base lens
    expect(s.title).toBe('Worlds · lens: base');
    expect(s.rows.find((r) => r.label.includes('base'))!.label.startsWith('●')).toBe(true);
  });

  it('is silent with only the base world (no declared world) — the no-filler rule', () => {
    expect(worldsMatrix({ result: { worlds: [worlds.worlds[0]!] } })).toBeNull();
  });
});

describe('active-lens + provenance helpers', () => {
  it('activeLensLabel gives the friendly world name (or base)', () => {
    expect(activeLensLabel(undefined, [])).toBe('base');
    expect(activeLensLabel('real', [{ id: 'real', name: 'Real', overrides: [] }])).toBe('Real');
    expect(activeLensLabel('real', [{ id: 'real', overrides: [] }])).toBe('real'); // falls back to id
  });

  it('overrideProvenance renders derived distinctly from a hand-set value (doc §5.3)', () => {
    expect(overrideProvenanceLabel('derived')).toContain('replace with a measured value');
    expect(overrideProvenanceLabel('architect')).toContain('frozen');
    expect(overrideProvenanceBadge('derived')).toBe('derived');
    expect(overrideProvenanceBadge('architect')).toBe('frozen');
    expect(overrideProvenanceBadge(undefined)).toBe('manual');
  });
});
