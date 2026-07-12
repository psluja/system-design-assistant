// @algorithm Inverse-CDF duration sampling (exponential / uniform / cold-start mixture)
// @problem Draw interarrival and service times from typed duration distributions deterministically —
//   each shape must consume a fixed number of uniforms so seeded runs stay reproducible.
// @approach Inverse-CDF transform per shape: -ln(1-u)/rate for the exponential (1-u keeps log finite),
//   affine stretch for the uniform, and a Bernoulli mixture for the cold-start penalty; analytic means
//   are computed per shape for the queueing checks.
// @complexity O(1) per draw (cold-start recurses once into its base shape).
// @citations Inverse transform sampling — Devroye, "Non-Uniform Random Variate Generation" (1986), ch. 2.
// @invariants Samples are non-negative; exponential consumes exactly one uniform, cold-start exactly
//   one more than its base; mean() agrees with the distribution's analytic expectation.
// @where-tested engine/sim/src/des.test.ts, engine/sim/src/coldstart.test.ts

import type { Rng } from './rng';

/**
 * A non-negative duration distribution (interarrival or service time). Domain-free probability, not
 * system-design vocabulary. Extend with more shapes (lognormal, Erlang, Pareto) as content needs them.
 */
export type Distribution =
  | { readonly kind: 'exponential'; readonly rate: number } // Markovian; mean = 1/rate
  | { readonly kind: 'deterministic'; readonly value: number } // constant
  | { readonly kind: 'uniform'; readonly min: number; readonly max: number }
  // A cold-start mixture: with `probability` a request also pays `penalty` on top of `base` (e.g. a
  // serverless container spin-up). Bimodal — its TAIL is what the cold start actually costs.
  | { readonly kind: 'coldStart'; readonly base: Distribution; readonly penalty: number; readonly probability: number };

/** Draw one sample. Inverse-CDF for the exponential (`1 - u ∈ (0,1]` keeps `log` finite). */
export function sample(d: Distribution, rng: Rng): number {
  switch (d.kind) {
    case 'exponential':
      return -Math.log(1 - rng.next()) / d.rate;
    case 'deterministic':
      return d.value;
    case 'uniform':
      return d.min + (d.max - d.min) * rng.next();
    case 'coldStart':
      return sample(d.base, rng) + (rng.next() < d.probability ? d.penalty : 0);
  }
}

/** The analytic mean of a distribution (used by the analytic queueing checks). */
export function mean(d: Distribution): number {
  switch (d.kind) {
    case 'exponential':
      return 1 / d.rate;
    case 'deterministic':
      return d.value;
    case 'uniform':
      return (d.min + d.max) / 2;
    case 'coldStart':
      return mean(d.base) + d.probability * d.penalty;
  }
}
