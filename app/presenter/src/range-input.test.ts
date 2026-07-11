import { describe, expect, it } from 'vitest';
import { formatRange, formatRangeInput, parseRangeInput, rangeFromFields } from './range-input';

// RANGE TEXT I/O — the pure parse/format spine both shells render (doc: uncertainty-monte-carlo §2). These tests
// pin the grammar (`lo-hi` / `lo-mode-hi` / blank), the display (`±(lo–hi)`), the round-trip seed, and — the
// honesty-critical part — that an UNSOUND range surfaces as a guided error rather than a silent clamp. The bracket
// sanity itself is `rangeProblem` (proven in @sda/content); here we prove the shell entry points reach it.

describe('formatRange (collapsed indicator + native tree row)', () => {
  it('renders a UNIFORM range as ±(lo–hi) with grouped numbers', () => {
    expect(formatRange({ lo: 100, hi: 180 })).toBe('±(100–180)');
    expect(formatRange({ lo: 1500, hi: 3000 })).toBe('±(1,500–3,000)');
  });

  it('renders a TRIANGULAR range as ±(lo–mode–hi)', () => {
    expect(formatRange({ lo: 100, mode: 130, hi: 180 })).toBe('±(100–130–180)');
    expect(formatRange({ lo: 0.6, mode: 0.8, hi: 0.9 })).toBe('±(0.6–0.8–0.9)');
  });
});

describe('formatRangeInput (editable seed, round-trips with parseRangeInput)', () => {
  it('emits raw hyphen-joined numbers (no thousands grouping) so it re-parses exactly', () => {
    expect(formatRangeInput({ lo: 1500, hi: 3000 })).toBe('1500-3000');
    expect(formatRangeInput({ lo: 100, mode: 130, hi: 180 })).toBe('100-130-180');
  });

  it('round-trips: parse(format(range)) === range', () => {
    for (const range of [{ lo: 100, hi: 180 }, { lo: 1500, mode: 2000, hi: 3000 }] as const) {
      const back = parseRangeInput(formatRangeInput(range));
      expect(back.kind).toBe('range');
      if (back.kind === 'range') expect(back.range).toEqual(range);
    }
  });
});

describe('parseRangeInput (single-string grammar — the VS Code InputBox)', () => {
  it('blank input CLEARS the range', () => {
    expect(parseRangeInput('').kind).toBe('clear');
    expect(parseRangeInput('   ').kind).toBe('clear');
  });

  it('parses UNIFORM "lo-hi"', () => {
    expect(parseRangeInput('100-180')).toEqual({ kind: 'range', range: { lo: 100, hi: 180 } });
  });

  it('parses TRIANGULAR "lo-mode-hi"', () => {
    expect(parseRangeInput('100-130-180')).toEqual({ kind: 'range', range: { lo: 100, mode: 130, hi: 180 } });
  });

  it('tolerates surrounding whitespace, an en-dash separator, and thousands commas', () => {
    expect(parseRangeInput('  1,500 – 3,000 ')).toEqual({ kind: 'range', range: { lo: 1500, hi: 3000 } });
  });

  it('a malformed entry is a GUIDED error naming the accepted forms — never a silent guess', () => {
    const r = parseRangeInput('abc');
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/uniform "lo-hi".*triangular "lo-mode-hi"/);
  });

  it('a single number (no range) is a guided error', () => {
    expect(parseRangeInput('130').kind).toBe('error');
  });

  it('an UNSOUND range surfaces rangeProblem\'s reason (lo>hi)', () => {
    const r = parseRangeInput('180-100');
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/must bracket/);
  });

  it('a triangular mode OUTSIDE [lo,hi] is rejected honestly', () => {
    const r = parseRangeInput('100-250-180');
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/mode 250 is outside/);
  });
});

describe('rangeFromFields (the web Inspector\'s discrete lo/hi/mode fields)', () => {
  it('all blank ⇒ clear (the affordance emptied)', () => {
    expect(rangeFromFields('', '', '').kind).toBe('clear');
  });

  it('lo + hi ⇒ uniform', () => {
    expect(rangeFromFields('1500', '3000', '')).toEqual({ kind: 'range', range: { lo: 1500, hi: 3000 } });
  });

  it('lo + hi + mode ⇒ triangular (mode presence switches shape automatically)', () => {
    expect(rangeFromFields('100', '180', '130')).toEqual({ kind: 'range', range: { lo: 100, mode: 130, hi: 180 } });
  });

  it('a partial entry (hi missing) is a guided error, not a silent half-range', () => {
    expect(rangeFromFields('100', '', '').kind).toBe('error');
  });

  it('an unsound range (lo>hi) surfaces rangeProblem\'s reason inline', () => {
    const r = rangeFromFields('180', '100', '');
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/must bracket/);
  });
});
