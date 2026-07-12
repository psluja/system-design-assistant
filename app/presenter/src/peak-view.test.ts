import { describe, expect, it } from 'vitest';
import { worstCaseRho, worstCaseUnits } from './peak-view';

// WORST-CASE PER-NODE LOAD (owner ruling: a peak is just traffic in a given environment + config). The presenter
// shows ONE reading — the worst load the declared environment produces — with NO 'peak' vocabulary, no '@HH:MM'
// instant and no dual 'steady vs peak' pair. `worstCaseRho` folds the steady ρ and the sweep's worst-window ρ into
// that single number; whether it saturates is the truth the shared verdict list also carries. These tests INVERT
// the old labelling contract: they pin that the presenter never mints a special 'peak' label.

describe('worstCaseRho — the single worst-case ρ every per-node surface shows', () => {
  it('takes the worst window when it strains the tier more than the steady baseline', () => {
    expect(worstCaseRho(0.4, { rho: 1.41, atS: 61_200 })).toBe(1.41);
  });

  it('keeps the steady ρ when the worst window is no worse (a trough-heavy or flat shape)', () => {
    expect(worstCaseRho(0.8, { rho: 0.6, atS: 100 })).toBe(0.8);
    expect(worstCaseRho(0.9, { rho: 0.9, atS: 100 })).toBe(0.9);
  });

  it('SACRED PIN: no shape (peak undefined) returns the steady ρ UNCHANGED (byte-identical to today)', () => {
    expect(worstCaseRho(0.4, undefined)).toBe(0.4);
    expect(worstCaseRho(0, undefined)).toBe(0);
  });

  it('a capacity-less origin (no steady ρ) that self-saturates surfaces its worst-window ρ (steady treated as 0)', () => {
    expect(worstCaseRho(undefined, { rho: 1.2, atS: 64_800 })).toBe(1.2);
  });

  it('is undefined only when the node has neither a steady ρ nor a peak (nothing to show)', () => {
    expect(worstCaseRho(undefined, undefined)).toBeUndefined();
    expect(worstCaseRho(0.5, undefined)).toBe(0.5);
  });

  it('HONESTY CONTRACT: returns a bare ρ NUMBER — never a peak label, instant or dual reading', () => {
    const r = worstCaseRho(0.4, { rho: 1.41, atS: 61_200 });
    expect(typeof r).toBe('number');
    expect(String(r)).not.toContain('peak');
    expect(String(r)).not.toContain('@');
  });
});

// WORST-CASE REQUIRED UNITS — the peer of worstCaseRho for the '⊞ tasks' chip. The chip must report the units the
// node's generation scaled to at its HIGHEST point, coherent with the peak ρ (both read the same worst window). These
// pin: the worst-window count wins when the shape strains the tier more than the baseline, and — the SACRED PIN — a
// node with no shaped generator (peak undefined, or a peak carrying no units) shows its steady requiredUnits VERBATIM.
describe('worstCaseUnits — the single worst-case task count the ⊞ chip shows', () => {
  it('takes the worst-window requiredUnits when the shape scales the tier above its steady baseline', () => {
    expect(worstCaseUnits(1.25, { rho: 3, atS: 90, requiredUnits: 3.75 })).toBe(3.75);
  });

  it('keeps the steady requiredUnits when the worst window is no higher (a trough-heavy or flat shape)', () => {
    expect(worstCaseUnits(4, { rho: 0.6, atS: 100, requiredUnits: 2 })).toBe(4);
    expect(worstCaseUnits(2, { rho: 0.9, atS: 100, requiredUnits: 2 })).toBe(2);
  });

  it('SACRED PIN: no shape (peak undefined) returns the steady requiredUnits UNCHANGED (byte-identical to today)', () => {
    expect(worstCaseUnits(1.25, undefined)).toBe(1.25);
    expect(worstCaseUnits(6, undefined)).toBe(6);
  });

  it('SACRED PIN: with no peak the steady value passes through VERBATIM — undefined and non-finite unchanged', () => {
    // The chip reads `valueOf(requiredUnits)`, which for a pathological config can be undefined / Infinity / NaN. With
    // no shape the fold must not reshape it, so the `units > 0` guard + Math.ceil see the exact value they see today.
    expect(worstCaseUnits(undefined, undefined)).toBeUndefined();
    expect(worstCaseUnits(Infinity, undefined)).toBe(Infinity);
    expect(worstCaseUnits(Number.NaN, undefined)).toBeNaN();
  });

  it('a peak that carries NO requiredUnits (a shape on a unit-less tier) leaves the steady value verbatim', () => {
    expect(worstCaseUnits(3, { rho: 2, atS: 90 })).toBe(3);
    expect(worstCaseUnits(undefined, { rho: 2, atS: 90 })).toBeUndefined();
  });

  it('a tier with no steady requiredUnits but a worst-window count surfaces that count (steady treated as 0)', () => {
    expect(worstCaseUnits(undefined, { rho: 1.2, atS: 64_800, requiredUnits: 5 })).toBe(5);
  });
});
