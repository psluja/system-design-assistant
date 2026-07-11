// @algorithm Nearest-rank percentile
// @problem Turn a sorted latency sample into the tail statistic (p95/p99) a verdict compares against
//   a band, without optimistic smoothing on small samples.
// @approach Nearest-rank order statistic (the ceil(p*n)-th sorted value), chosen over interpolating
//   estimators as the conservative tail read; empty samples answer NaN (honest: no data, no estimate).
// @complexity O(1) per query on an already-sorted sample (sorting is the caller's O(n log n)).
// @citations Nearest-rank percentile = type 1 in Hyndman & Fan, "Sample Quantiles in Statistical
//   Packages", The American Statistician 50(4), 1996.
// @invariants Result is always an element of the sample (never interpolated); p clamped to [0,1];
//   NaN only for the empty sample.
// @where-tested engine/sim/src/stats.test.ts

/** Arithmetic mean, or NaN for an empty sample (honest: no data ⇒ no mean). */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * Nearest-rank percentile over an ascending-sorted sample. `p ∈ [0,1]` (clamped). Empty ⇒ NaN.
 * Nearest-rank (not interpolation) is the conservative tail estimate the verdict layer wants.
 */
export function percentileSorted(sorted: readonly number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const clamped = p < 0 ? 0 : p > 1 ? 1 : p;
  const rank = Math.ceil(clamped * n);
  const idx = rank <= 1 ? 0 : rank >= n ? n - 1 : rank - 1;
  return sorted[idx] as number;
}
