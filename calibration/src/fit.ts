// FIT + RESIDUAL + GENERALIZATION — the deterministic fitter (TASK-93, Jobs 2.2–2.5). Treats the corpus's fitted
// tunables as FREE VARIABLES and minimises the aggregate corpus error by coordinate descent over a log-spaced grid
// (deterministic — no RNG, fixed order, fixed refinement). The residual that REMAINS after the best fit is the real
// output: the structural gaps no tunable can remove. Leave-one-out (with only a few entries) is the honest over-fit
// guard — fit on the rest, report the error on the held-out entry.

import { isFitted, tunableId, type CalibrationEntry, type GroundTruth, type LoadedEntry, type LoadedModel } from './corpus';
import { predictMetric, type TunableValues } from './predict';

/** A free variable the fitter searches: its id (shared across entries), bounds, and catalog-default start point. */
export interface FreeVar {
  readonly id: string;
  readonly min: number;
  readonly max: number;
  readonly def: number;
}

/** Collect the FITTED tunables across a set of entries, deduplicated by {@link tunableId} — a (selector, key)
 *  declared by several entries is ONE shared free variable. Order is stable (sorted by id) for determinism. */
export function freeVarsOf(entries: readonly LoadedEntry[]): FreeVar[] {
  const byId = new Map<string, FreeVar>();
  for (const le of entries) {
    for (const t of le.entry.tunables) {
      if (!isFitted(t.fit)) continue;
      const id = tunableId(t);
      if (!byId.has(id)) byId.set(id, { id, min: t.fit.min, max: t.fit.max, def: t.catalogDefault });
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The signed relative error of a single scored prediction, or undefined for an unknown/unscored point. */
function relError(entry: CalibrationEntry, model: LoadedModel, gt: GroundTruth, values: TunableValues): number | undefined {
  if (gt.measured === null) return undefined;
  const pred = predictMetric(entry, model, gt, 'fitted', values);
  if (!Number.isFinite(pred)) return 1e3; // an infeasible design is a huge (finite) penalty, never NaN into the fit
  return (pred - gt.measured) / gt.measured;
}

/** The aggregate objective: RMS of signed relative errors over every SCORED point in `entries`, at `values`. */
export function objective(entries: readonly LoadedEntry[], values: TunableValues): number {
  let sumsq = 0;
  let n = 0;
  for (const le of entries) {
    for (const gt of le.entry.groundTruth) {
      const rel = relError(le.entry, le.model, gt, values);
      if (rel === undefined) continue;
      sumsq += rel * rel;
      n += 1;
    }
  }
  return n === 0 ? 0 : Math.sqrt(sumsq / n);
}

/** A log-spaced grid of `n` points over [min, max] (service times / pool sizes span orders of magnitude). */
function logGrid(min: number, max: number, n: number): number[] {
  if (!(min > 0) || !(max > min)) return [Math.max(min, 1e-9)];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(min * Math.pow(max / min, i / (n - 1)));
  return out;
}

const GRID_POINTS = 33; // coarse log grid per coordinate
const REFINE_POINTS = 21; // linear refinement between the coarse grid's neighbours
const PASSES = 5; // coordinate-descent passes (separable objective ⇒ converges in 1–2; a few for safety)
const CONVERGE_EPS = 1e-9;

/** The full fit result: the recommended free-variable values, the achieved objective, and per-entry residuals. */
export interface FitResult {
  readonly values: Map<string, number>;
  readonly objective: number;
  readonly freeVars: readonly FreeVar[];
  readonly residuals: readonly EntryResidual[];
}
/** One scored point's residual after the fit. */
export interface PointResidual {
  readonly metric: string;
  readonly measured: number;
  readonly predictedDefault: number;
  readonly predictedFitted: number;
  readonly errorDefaultPct: number;
  readonly errorFittedPct: number;
  readonly unit: string;
}
export interface EntryResidual {
  readonly name: string;
  readonly points: readonly PointResidual[];
  readonly rmsFittedPct: number; // RMS of |fitted error| over this entry's scored points
}

/**
 * Coordinate-descent fit over the free variables of `entries`. Deterministic: each coordinate is scanned on a
 * fixed log grid, the best cell is refined on a fixed linear grid between its neighbours, and coordinates are
 * visited in a fixed (sorted) order for a fixed number of passes. Free variables start at their catalog default.
 */
export function fit(entries: readonly LoadedEntry[]): FitResult {
  const freeVars = freeVarsOf(entries);
  const values = new Map<string, number>();
  for (const v of freeVars) values.set(v.id, Math.min(Math.max(v.def, v.min), v.max));

  let best = objective(entries, values);
  for (let pass = 0; pass < PASSES; pass++) {
    let improvedThisPass = false;
    for (const v of freeVars) {
      const coarse = logGrid(v.min, v.max, GRID_POINTS);
      // coarse scan
      let bestIdx = 0;
      let bestObj = Infinity;
      for (let i = 0; i < coarse.length; i++) {
        values.set(v.id, coarse[i] as number);
        const o = objective(entries, values);
        if (o < bestObj) { bestObj = o; bestIdx = i; }
      }
      // linear refinement between the winning cell's neighbours
      const lo = coarse[Math.max(0, bestIdx - 1)] as number;
      const hi = coarse[Math.min(coarse.length - 1, bestIdx + 1)] as number;
      let bestVal = coarse[bestIdx] as number;
      for (let j = 0; j < REFINE_POINTS; j++) {
        const val = lo + ((hi - lo) * j) / (REFINE_POINTS - 1);
        values.set(v.id, val);
        const o = objective(entries, values);
        if (o < bestObj) { bestObj = o; bestVal = val; }
      }
      values.set(v.id, bestVal);
      if (bestObj < best - CONVERGE_EPS) { best = bestObj; improvedThisPass = true; }
    }
    if (!improvedThisPass) break;
  }

  const residuals = entries.map((le) => entryResidual(le, values));
  return { values, objective: objective(entries, values), freeVars, residuals };
}

/** Compute one entry's per-point residuals (default vs fitted prediction) and the RMS of its fitted errors. */
function entryResidual(le: LoadedEntry, values: TunableValues): EntryResidual {
  const points: PointResidual[] = [];
  let sumsq = 0;
  let n = 0;
  for (const gt of le.entry.groundTruth) {
    if (gt.measured === null) continue;
    const predictedDefault = predictMetric(le.entry, le.model, gt, 'default', new Map());
    const predictedFitted = predictMetric(le.entry, le.model, gt, 'fitted', values);
    const errorDefaultPct = (100 * (predictedDefault - gt.measured)) / gt.measured;
    const errorFittedPct = (100 * (predictedFitted - gt.measured)) / gt.measured;
    points.push({ metric: gt.metric, measured: gt.measured, predictedDefault, predictedFitted, errorDefaultPct, errorFittedPct, unit: gt.unit });
    sumsq += errorFittedPct * errorFittedPct;
    n += 1;
  }
  return { name: le.entry.name, points, rmsFittedPct: n === 0 ? 0 : Math.sqrt(sumsq / n) };
}

// ── Leave-one-out generalization (the over-fit guard) ──────────────────────────────────────────────────────────
export interface LooError {
  readonly metric: string;
  readonly measured: number;
  readonly predicted: number;
  readonly errorPct: number;
  readonly unit: string;
}
export interface LooResult {
  readonly heldOut: string;
  readonly foldInFreeVars: readonly string[]; // which free vars the fold-in set actually constrained
  readonly errors: readonly LooError[];
  readonly rmsPct: number;
  /** True when EVERY fitted tunable the held-out entry declares was constrained by the fold-in set — i.e. a
   *  genuine out-of-sample prediction. False when the held-out entry's tunables are disjoint from the fold-in
   *  set (predicted at catalog defaults) or it declares none. Only `constrained` entries are true generalization. */
  readonly constrained: boolean;
  readonly note: string;
}

/**
 * Leave-one-out: for each entry, fit on the REST and report the error on the held-out entry. With disjoint
 * component sets across entries a held-out entry's tunables may not be in the fold-in free-var set — then it is
 * predicted at catalog defaults, and the harness says so honestly (that is the true generalization with few,
 * disjoint entries, not a hidden pass).
 */
export function leaveOneOut(entries: readonly LoadedEntry[]): LooResult[] {
  return entries.map((held) => {
    const foldIn = entries.filter((e) => e !== held);
    const { values } = fit(foldIn);
    const foldInIds = new Set(freeVarsOf(foldIn).map((v) => v.id));
    const heldIds = new Set(held.entry.tunables.filter((t) => isFitted(t.fit)).map(tunableId));
    const constrainedIds = [...heldIds].filter((id) => foldInIds.has(id));
    const constrained = heldIds.size > 0 && constrainedIds.length === heldIds.size;
    const errors: LooError[] = [];
    let sumsq = 0;
    let n = 0;
    for (const gt of held.entry.groundTruth) {
      if (gt.measured === null) continue;
      const predicted = predictMetric(held.entry, held.model, gt, 'fitted', values);
      const errorPct = (100 * (predicted - gt.measured)) / gt.measured;
      errors.push({ metric: gt.metric, measured: gt.measured, predicted, errorPct, unit: gt.unit });
      sumsq += errorPct * errorPct;
      n += 1;
    }
    const note = constrained
      ? 'held-out tunables were all constrained by the fold-in set (a genuine out-of-sample prediction)'
      : heldIds.size === 0
        ? 'held-out entry declares no fitted tunable — its metric is structural, predicted as-is'
        : `held-out tunables ${[...heldIds].filter((id) => !foldInIds.has(id)).join(', ')} are DISJOINT from the fold-in set, so they fall back to catalog defaults — the honest un-calibrated generalization (not a true out-of-sample test)`;
    return { heldOut: held.entry.name, foldInFreeVars: [...foldInIds].sort(), errors, rmsPct: n === 0 ? 0 : Math.sqrt(sumsq / n), constrained, note };
  });
}
