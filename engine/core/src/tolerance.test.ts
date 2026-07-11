import { describe, expect, it } from 'vitest';
import { EPSILON, closeEnough, withinBound, exceedsCeiling, belowFloor } from './tolerance';

// The numeric tolerances (doc: latency-semantics-v2 §5). Two settings: EQUIVALENCE (`closeEnough`, 1e-4 relative —
// two independently-computed values agree) and BAND BOUNDARY (`exceedsCeiling`/`belowFloor` — a computed value vs
// a declared bound, float-noise tolerant but tight enough that a real SLO margin — even a ratio one — still
// fails). The owner's live case (200.00000001246752 vs a 200 ms band) must read ok; a 1e-3 miss must still fail;
// and a five-nines-vs-eleven-nines durability gap (~1e-5) must remain a real violation — a boundary tolerance,
// never a slack budget.

describe('numeric tolerance ε', () => {
  it('the equivalence ε is 1e-4 (relative + absolute)', () => {
    expect(EPSILON).toBe(1e-4);
  });

  it('the owner live case reads AT the bound (ok), not a rounding-artefact breach', () => {
    const computed = 200.00000001246752;
    const band = 200;
    expect(withinBound(computed, band)).toBe(true);
    expect(closeEnough(computed, band)).toBe(true);
    expect(exceedsCeiling(computed, band)).toBe(false); // within noise ⇒ satisfies the ceiling
  });

  it('the band boundary is TIGHT on ratio quantities — a real durability miss (~1e-5) still fails', () => {
    // Five nines (0.99999) vs an eleven-nines floor (0.99999999999): a ~1e-5 gap that is a HUGE failure-probability
    // difference. The coarse equivalence ε (1e-4 relative) would swallow it — the boundary tolerance must not.
    expect(belowFloor(0.99999, 0.99999999999)).toBe(true); // a real violation
    expect(belowFloor(0.99999999999, 0.99999999999)).toBe(false); // exactly at the floor ⇒ ok
    expect(closeEnough(0.99999, 0.99999999999)).toBe(true); // the EQUIVALENCE ε WOULD swallow it — proving why band judging needs its own
  });

  it('a breach within 1e-9 (relative) of a bound is satisfied; a breach of 1e-3 is a real violation', () => {
    const band = 200;
    expect(exceedsCeiling(band * (1 + 1e-9), band)).toBe(false); // noise ⇒ ok
    expect(exceedsCeiling(band * (1 + 1e-3), band)).toBe(true); // real miss ⇒ violation
    // the floor twin: within ε below is satisfied; a meaningful shortfall is a breach.
    expect(belowFloor(band * (1 - 1e-9), band)).toBe(false);
    expect(belowFloor(band * (1 - 1e-3), band)).toBe(true);
  });

  it('exact equality and zero are handled (the absolute floor keeps near-zero comparisons sane)', () => {
    expect(closeEnough(0, 0)).toBe(true);
    expect(closeEnough(0, 1e-6)).toBe(true); // within the absolute ε floor
    expect(closeEnough(0, 1)).toBe(false);
    expect(exceedsCeiling(0, 0)).toBe(false);
    expect(belowFloor(0, 0)).toBe(false);
  });

  it('is symmetric', () => {
    expect(closeEnough(200, 200.00000001)).toBe(closeEnough(200.00000001, 200));
  });
});
