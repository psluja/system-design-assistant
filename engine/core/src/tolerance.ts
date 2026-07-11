// @algorithm Dual float-tolerance regimes (equivalence vs band boundary)
// @problem Float comparisons can make the tool lie in BOTH directions: a bare > flips an SLO verdict
//   on 1e-8 summation residue, while one coarse relative tolerance would swallow a real five-nines
//   vs eleven-nines durability gap (~1e-5 near ratio 1).
// @approach Two deliberately different epsilons: EQUIVALENCE (closeEnough, relative + absolute
//   1e-4) for "do two independently computed optima agree", scaling with MIP feasibility tolerance;
//   BAND BOUNDARY (exceedsCeiling/belowFloor/withinBound, absolute floor 1e-6 + tiny relative 1e-9)
//   that rescues rounding noise without ever absorbing a genuine SLO miss.
// @complexity O(1) per comparison.
// @citations Relative/absolute epsilon comparison folklore (Goldberg 1991, "What Every Computer
//   Scientist Should Know About Floating-Point Arithmetic"); constants are the module's own, argued
//   in the header.
// @invariants Boundary tolerances are never slack budgets — any meaningful miss still reads as a
//   violation; every caller shares these single definitions (no bespoke epsilons elsewhere).
// @where-tested engine/core/src/tolerance.test.ts

// THE numeric tolerances (doc: latency-semantics-v2 §5). SDA compares computed values against declared bounds in
// two DISTINCT settings, and they honestly need two different ε — both live here so every caller shares ONE
// definition of each and nothing re-invents a bespoke constant.
//
// 1. EQUIVALENCE (`closeEnough`, ε = 1e-4, RELATIVE + absolute). "Do two independently-computed values agree?" —
//    the solver-oracle referee comparing two MIP optima, the harness comparing objective values / SLO
//    satisfaction. Those values range up to the hundreds of millions (the magnitude axis), and two exact solvers
//    legitimately differ by a MIP feasibility tolerance that SCALES with magnitude, so the tolerance must be
//    RELATIVE and generous (1e-4). This is the contract's tolerance (solver-contract bindings.ts consumes it).
//
// 2. BAND BOUNDARY (`exceedsCeiling` / `belowFloor` / `withinBound`). "Is a computed value on the wrong side of a
//    declared bound, or merely float noise away from it?" Summed queueing/latency/cost terms accumulate ~1e-8
//    residue (a chain of `+`s lands on 200.00000001246752 where the exact answer is 200), so a bare `>` flips a
//    verdict on rounding noise — the tool "fails" an SLO it meets. But this judge spans EVERY key, INCLUDING
//    ratio quantities near 1 (availability, durability) where a meaningful SLO margin is itself tiny — five nines
//    vs eleven nines differ by only ~1e-5. A coarse RELATIVE tolerance (1e-4) would swallow that real gap and lie
//    in the OTHER direction (passing a design that misses its durability SLO by six orders of magnitude of failure
//    probability). So the boundary tolerance is a small ABSOLUTE floor (1e-6 — far above double-rounding residue,
//    far below any real SLO margin) plus a tiny RELATIVE term (1e-9) that only grows the window for genuinely
//    large-magnitude sums. It rescues float noise WITHOUT ever swallowing a real miss on either side.
//
// Both are BOUNDARY tolerances, never slack budgets: a design that misses a bound by any meaningful margin still
// reads a violation. The tool must not lie in EITHER direction.

/** The equivalence tolerance ε: 1e-4, applied relative + absolute. For comparing two independently-computed
 *  values (objective optima, SLO satisfaction) whose magnitude can be huge — see the file header (setting 1). */
export const EPSILON = 1e-4;

/** Whether `a` and `b` are EQUAL within the equivalence ε — `|a − b| ≤ ε + ε·max(|a|,|b|)` (relative + absolute,
 *  ε = 1e-4). Two values within it are the SAME number. Used by the solver referee/harness (contract), NOT for
 *  judging a band boundary (that is {@link exceedsCeiling}/{@link belowFloor} — see the file header). */
export const closeEnough = (a: number, b: number): boolean =>
  Math.abs(a - b) <= EPSILON + EPSILON * Math.max(Math.abs(a), Math.abs(b));

/** The band-boundary absolute floor: 1e-6. Above realistic double-precision residue on a summed quantity, below
 *  any SLO margin an architect sets — even a ratio one (5 nines vs 6 nines differ by ~9e-7, but the durability
 *  SLOs SDA judges differ by ≥ ~1e-5, well outside this). */
export const BOUNDARY_ABS = 1e-6;
/** The band-boundary relative term: 1e-9. Negligible for the ratio/latency keys, it only widens the window for
 *  genuinely large-magnitude sums (a cost of 1e6 tolerates ~1e-3 of accumulated residue), so the floor stays a
 *  noise tolerance rather than a fixed absolute that would be too tight on big numbers. */
export const BOUNDARY_REL = 1e-9;

/** Whether `a` is within float noise of `b` for a BAND judgement — `|a − b| ≤ 1e-6 + 1e-9·max(|a|,|b|)`. A value
 *  within it is AT the bound. Sized to rescue rounding residue without swallowing a real SLO margin, including on
 *  ratio quantities near 1 (see the file header, setting 2). */
export const withinBound = (a: number, b: number): boolean =>
  Math.abs(a - b) <= BOUNDARY_ABS + BOUNDARY_REL * Math.max(Math.abs(a), Math.abs(b));

/** Whether `v` breaches a CEILING `max` for real — strictly above it AND not merely within band-boundary noise of
 *  it. A value at the bound (within noise) satisfies the ceiling; only a genuine excess reads as a breach. */
export const exceedsCeiling = (v: number, max: number): boolean => v > max && !withinBound(v, max);

/** Whether `v` breaches a FLOOR `min` for real — strictly below it AND not merely within band-boundary noise of
 *  it. The floor twin of {@link exceedsCeiling}: a value at the floor (within noise) satisfies it; only a genuine
 *  shortfall reads as a breach. This is what keeps a five-nines-vs-eleven-nines durability miss (~1e-5) a real
 *  violation while a 1e-8 latency-sum residue at a ceiling reads ok. */
export const belowFloor = (v: number, min: number): boolean => v < min && !withinBound(v, min);
