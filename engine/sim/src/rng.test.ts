import { describe, expect, it } from 'vitest';
import { mulberry32 } from './rng';

describe('mulberry32 (seeded PRNG)', () => {
  it('is reproducible: equal seeds ⇒ identical streams', () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    for (let i = 0; i < 1000; i++) expect(b.next()).toBe(a.next());
  });

  it('produces values in [0, 1)', () => {
    const r = mulberry32(99);
    for (let i = 0; i < 10000; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('different seeds diverge', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a.next()).not.toBe(b.next());
  });
});
