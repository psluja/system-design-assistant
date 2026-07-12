// @algorithm mulberry32 (seeded PRNG)
// @problem The simulator needs a deterministic, seedable source of uniform randomness so that a
// fixed seed reproduces byte-identical runs across machines; Math.random is unseedable.
// @approach mulberry32 — a 32-bit counter-increment + multiply/xorshift mixer; every draw in the DES
//   flows through this one Rng interface.
// @complexity O(1) per draw; 32 bits of state.
// @citations Tommy Ettinger's mulberry32 (public domain; popularized by bryc's JS PRNG collection).
// @invariants Pure given seed (no global state); output uniform in [0, 1); same seed => same stream.
// @where-tested engine/sim/src/rng.test.ts, engine/sim/src/des.test.ts (determinism under seed)

/**
 * A seeded pseudo-random stream. The simulator's ONLY source of randomness — the determinism
 * contract requires every draw to come from here, so a fixed seed ⇒ byte-identical runs.
 */
export interface Rng {
  /** Next uniform draw in [0, 1). */
  next(): number;
}

/**
 * mulberry32 — a tiny, fast, well-distributed 32-bit PRNG. Pure given its seed; no global state.
 * Chosen over `Math.random` precisely because it is seedable and reproducible across machines.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
