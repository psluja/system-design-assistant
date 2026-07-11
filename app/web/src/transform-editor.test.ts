import { describe, expect, it } from 'vitest';
import { LOAD_STAGES_PRESETS } from '@sda/content';
import { generateProblem, parseEditCycles, previewShape } from './transform-editor';

// The GENERATOR authoring helpers (load-stages R3 §11) — the PURE logic behind the web stages table, tested at
// logic level (the flow-nodes `handleTop` idiom: the React shell is a dumb renderer over these). These pin: an
// empty cell is REFUSED (never a silent 0), the shared `cyclesProblem` is the one validator, a flat table is a
// legal flat generator, and the preview shape is the EVALUATED shape (its peak matches the authored multiplier).

describe('parseEditCycles — the string table → numeric cycles lowering', () => {
  it('an empty cell parses to NaN (so cyclesProblem refuses it), never a silent 0', () => {
    const parsed = parseEditCycles([{ periodS: '', stages: [{ durationS: '', multiplier: '2' }] }]);
    expect(Number.isNaN(parsed[0]!.periodS)).toBe(true);
    expect(Number.isNaN(parsed[0]!.stages[0]!.durationS)).toBe(true);
    expect(parsed[0]!.stages[0]!.multiplier).toBe(2);
  });

  it('well-formed strings become the numeric cycle', () => {
    const parsed = parseEditCycles([{ periodS: '86400', stages: [{ durationS: '43200', multiplier: '1.8' }] }]);
    expect(parsed).toEqual([{ periodS: 86400, stages: [{ durationS: 43200, multiplier: 1.8 }] }]);
  });
});

describe('generateProblem — the shared cyclesProblem + the level rule (guided)', () => {
  it('an empty table is a LEGAL flat generator (null — the ×1 identity)', () => {
    expect(generateProblem(200, [])).toBeNull();
  });

  it('a negative level is refused, naming the rule', () => {
    expect(generateProblem(-1, [])).toMatch(/≥ 0/);
  });

  it('a well-formed shaped generator validates', () => {
    expect(generateProblem(200, [{ periodS: '86400', stages: [{ durationS: '43200', multiplier: '2' }, { durationS: '43200', multiplier: '1' }] }])).toBeNull();
  });

  it('Σ durationS > periodS is refused with the exact rule (the shared cyclesProblem)', () => {
    const problem = generateProblem(200, [{ periodS: '100', stages: [{ durationS: '60', multiplier: '1' }, { durationS: '60', multiplier: '2' }] }]);
    expect(problem).toMatch(/periodS/);
  });

  it('an all-zero shape has no traffic — refused naming the fix', () => {
    expect(generateProblem(200, [{ periodS: '100', stages: [{ durationS: '50', multiplier: '0' }] }])).toMatch(/traffic/);
  });
});

describe('previewShape — the drawn silhouette IS the evaluated shape', () => {
  it('an empty / unrenderable table previews as a flat baseline', () => {
    expect(previewShape([]).series).toEqual([1, 1]);
    expect(previewShape([{ periodS: '', stages: [{ durationS: '', multiplier: '' }] }]).series).toEqual([1, 1]);
  });

  it('a ×3 hold cycle previews with peak ≈ 3 (the authored multiplier, sampled from content)', () => {
    const { peak } = previewShape([{ periodS: '200', stages: [{ durationS: '100', multiplier: '3' }, { durationS: '100', multiplier: '1' }] }]);
    expect(peak).toBeGreaterThan(2.9);
    expect(peak).toBeLessThanOrEqual(3 + 1e-9);
  });

  it('a preset pre-fill (diurnal) previews as a non-flat shape', () => {
    const editCycles = LOAD_STAGES_PRESETS.diurnal.map((c) => ({ periodS: String(c.periodS), stages: c.stages.map((s) => ({ durationS: String(s.durationS), multiplier: String(s.multiplier) })) }));
    const { series, peak } = previewShape(editCycles);
    expect(peak).toBeGreaterThan(Math.min(...series)); // a rush-hour hump, not a line
  });
});
