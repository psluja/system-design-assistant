// The CALIBRATION CORPUS — the machine-readable, one-home ground-truth format (TASK-93, Job 1). Each entry is
// pure DATA: a saved SDA model (.sda.json), the load sweep, the tunable component-defaults treated as free
// variables, and the measured ground truth with cited source URLs. Adding a corpus entry is DATA — a new JSON
// file under calibration/corpus/ — and re-fitting is one command (`pnpm calibrate`), no AI per iteration. The
// harness READS this and the referenced model; it NEVER writes back a shipped default (Job 3).

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Instance, Wire } from '@sda/content';

// ── The tunable free variables ────────────────────────────────────────────────────────────────────────────────
/** A FITTED free variable: the fitter searches [min, max] (log-spaced) for the value that minimises corpus error. */
export interface TunableRange {
  readonly min: number;
  readonly max: number;
}
/** A PINNED input: declared for the record (its catalog default vs the sourced value it is held at) but NOT
 *  fitted — e.g. a hardware thread count. Keeps the fit well-posed where two knobs are degenerate (capacity =
 *  concurrency / service ⇒ only the ratio matters, so we pin the sourced concurrency and fit the service time). */
export interface TunablePinned {
  readonly pinned: number;
}
export type TunableFit = TunableRange | TunablePinned;
/** Type guard: a tunable is a FREE VARIABLE (has a search range) rather than a pinned input. */
export const isFitted = (f: TunableFit): f is TunableRange => 'min' in f;

/** Which node(s) a tunable overrides: a specific `node` id, or every instance of a component `type`. */
export interface TunableSelector {
  readonly type?: string;
  readonly node?: string;
}

/**
 * A per-component DEFAULT treated as a tunable. `key` is the registry config key (perRequestDuration, concurrency,
 * connectionHeldMs, …); `catalogDefault` is what SDA ships (the out-of-box regime); `fit` is the search range OR a
 * pinned value. Two entries declaring the SAME (selector, key) SHARE one free variable — so a joint fit can be
 * over-determined (TechEmpower single + 20-query share db.postgres:perRequestDuration), which is exactly how the
 * irreducible structural residual is surfaced.
 */
export interface Tunable {
  readonly key: string;
  readonly selector: TunableSelector;
  readonly unit: string;
  readonly catalogDefault: number;
  readonly fit: TunableFit;
  readonly note: string;
}
/** The stable identity of a tunable ACROSS entries — a shared (selector, key) is ONE free variable. */
export const tunableId = (t: Tunable): string => `${t.selector.node ?? t.selector.type ?? '*'}:${t.key}`;

// ── The measured ground truth ─────────────────────────────────────────────────────────────────────────────────
export type MetricKind = 'capacityCeilingRps' | 'latencySharePct';
/**
 * One measured (or honestly-unknown) datapoint. `measured: null` means unpublished/unknown — the harness PREDICTS
 * and REPORTS it but does NOT score it (the tool must not invent a number to grade against). `capacityCeilingRps`
 * needs a sub-saturation `probeLoadRps`; `latencySharePct` needs the `numeratorNode` (the tier whose share is
 * measured) and `denominatorNode` (the operation-entry node whose end-to-end response is the denominator).
 */
export interface GroundTruth {
  readonly metric: MetricKind;
  readonly measured: number | null;
  readonly unit: string;
  readonly sourceUrl: string;
  readonly note: string;
  readonly probeLoadRps?: number;
  readonly numeratorNode?: string;
  readonly denominatorNode?: string;
}

export interface Source {
  readonly url: string;
  readonly note: string;
}

/** One corpus entry — a real, measured system SDA is held against. */
export interface CalibrationEntry {
  readonly name: string;
  readonly modelPath: string; // relative to the calibration root (e.g. "techempower-single-query.sda.json")
  readonly notes: string;
  readonly sources: readonly Source[];
  readonly workloadSweep: { readonly node: string; readonly key: string; readonly points: readonly number[] };
  readonly tunables: readonly Tunable[];
  readonly groundTruth: readonly GroundTruth[];
}

// ── Loading ───────────────────────────────────────────────────────────────────────────────────────────────────
/** The saved model reduced to what the engine needs: placed instances and their wiring. */
export interface LoadedModel {
  readonly instances: readonly Instance[];
  readonly wires: readonly Wire[];
}
export interface LoadedEntry {
  readonly entry: CalibrationEntry;
  readonly model: LoadedModel;
}

/** The calibration ROOT directory (holds corpus/ and the .sda.json models), resolved from this file's location. */
export const calibrationRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Read + parse the .sda.json model referenced by an entry, keeping only instances + wires (the engine inputs). */
function loadModel(root: string, modelPath: string): LoadedModel {
  const raw = JSON.parse(readFileSync(join(root, modelPath), 'utf8')) as { instances?: unknown; wires?: unknown };
  if (!Array.isArray(raw.instances) || !Array.isArray(raw.wires)) throw new Error(`model ${modelPath}: missing instances/wires`);
  return { instances: raw.instances as Instance[], wires: raw.wires as Wire[] };
}

/**
 * Load the whole corpus: every `corpus/*.json` entry (sorted by filename for determinism) plus its referenced
 * model. Pure read — no engine call, no write. The returned order is stable so leave-one-out and the report are
 * reproducible.
 */
export function loadCorpus(root: string = calibrationRoot()): LoadedEntry[] {
  const dir = join(root, 'corpus');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  return files.map((f) => {
    const entry = JSON.parse(readFileSync(join(dir, f), 'utf8')) as CalibrationEntry;
    return { entry, model: loadModel(root, entry.modelPath) };
  });
}
