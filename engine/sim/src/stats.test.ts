import { describe, expect, it } from 'vitest';
import { mean, percentileSorted } from './stats';

describe('percentileSorted (nearest-rank tail estimate)', () => {
  const sorted = [10, 20, 30, 40, 50] as const;

  it('lands on the expected elements for p = 0 / 0.5 / 0.99 / 1', () => {
    expect(percentileSorted([...sorted], 0)).toBe(10); // first
    expect(percentileSorted([...sorted], 0.5)).toBe(30); // median (rank 3)
    expect(percentileSorted([...sorted], 0.99)).toBe(50); // top rank
    expect(percentileSorted([...sorted], 1)).toBe(50); // last
  });

  it('clamps out-of-range p to the first/last element', () => {
    expect(percentileSorted([...sorted], -5)).toBe(10); // below 0 ⇒ first
    expect(percentileSorted([...sorted], 2)).toBe(50); // above 1 ⇒ last
  });

  it('returns NaN for an empty sample (honest: no data ⇒ no percentile)', () => {
    expect(percentileSorted([], 0.5)).toBeNaN();
  });
});

describe('mean', () => {
  it('averages a non-empty sample', () => {
    expect(mean([10, 20, 30, 40, 50])).toBe(30);
  });

  it('returns NaN for an empty sample', () => {
    expect(mean([])).toBeNaN();
  });
});
