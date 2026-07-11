// PREDICT — run SDA's engine over a corpus model and read the metric under test (TASK-93, Job 2.1). This is the
// SAME content path the manual calibrations used: instantiate → evaluate (scalar forward pass) → nodeQueues
// (analytic M/M/c ρ + queue-inflated sojourn) → responseLatency (client-facing latency), plus a DES corroboration
// (toQueueingNetwork → simulate) for the tail. Pure and deterministic: no clock, no RNG (the DES takes an explicit
// seed). The harness OVERRIDES tunable config in memory only — it never touches a shipped manifest (Job 3).

import { NodeId, type Graph, type Key } from '@sda/engine-core';
import { allManifests, instantiate, nodeQueues, registry, responseLatency, toQueueingNetwork, type Instance } from '@sda/content';
import { evaluate } from '@sda/engine-solve';
import { simulate } from '@sda/engine-sim';
import { isFitted, tunableId, type CalibrationEntry, type GroundTruth, type LoadedModel, type Tunable } from './corpus';

/** The two regimes the harness predicts under: `default` = catalog defaults (what SDA ships, un-calibrated);
 *  `fitted` = the fitter's values for free variables, pinned values for pinned tunables. */
export type Regime = 'default' | 'fitted';
/** Fitted free-variable values, keyed by {@link tunableId}. Missing ⇒ the tunable's catalog default is used. */
export type TunableValues = ReadonlyMap<string, number>;

/** Resolve a tunable's numeric value under a regime. */
function resolveTunable(t: Tunable, regime: Regime, values: TunableValues): number {
  if (regime === 'default') return t.catalogDefault;
  if (isFitted(t.fit)) return values.get(tunableId(t)) ?? t.catalogDefault;
  return t.fit.pinned;
}

/** Does a tunable's selector target this instance? (a specific node id, or every instance of a component type.) */
function targets(t: Tunable, inst: Instance): boolean {
  if (t.selector.node !== undefined) return t.selector.node === inst.id;
  if (t.selector.type !== undefined) return t.selector.type === inst.type;
  return false;
}

/** A config key is safe to assign only if it is a plain own-property name — never a prototype-pollution vector.
 *  The corpus is trusted local data, but a config key is used as an object property, so we refuse the three magic
 *  names defensively (injection-resistance; a bad corpus key is dropped, never assigned). */
const safeKey = (key: string): boolean => key !== '__proto__' && key !== 'prototype' && key !== 'constructor';

/**
 * The model's instances with (a) each entry-declared tunable overridden onto the nodes it targets and (b) the
 * load-sweep node set to `load`. A node the model PINS in its own config (e.g. TechEmpower's service handler
 * time, held generous to isolate the DB) is only overridden when a tunable explicitly targets it — a tunable
 * that does not name it leaves the model's value intact.
 */
function applied(model: LoadedModel, entry: CalibrationEntry, regime: Regime, values: TunableValues, load: number): Instance[] {
  return model.instances.map((inst) => {
    const config: Record<string, number> = { ...(inst.config ?? {}) };
    for (const t of entry.tunables) if (targets(t, inst) && safeKey(t.key)) config[t.key] = resolveTunable(t, regime, values);
    if (inst.id === entry.workloadSweep.node && safeKey(entry.workloadSweep.key)) config[entry.workloadSweep.key] = load;
    return { ...inst, config };
  });
}

interface Evaluated {
  readonly graph: Graph;
  readonly value: (id: string, key: Key) => number | undefined;
}

/** Instantiate + evaluate the model at a load point, returning the graph and a value reader, or an error string. */
function evaluateApplied(model: LoadedModel, entry: CalibrationEntry, regime: Regime, values: TunableValues, load: number): Evaluated | { readonly error: string } {
  const g = instantiate(allManifests, applied(model, entry, regime, values, load), model.wires);
  if (!g.ok) return { error: 'instantiate: ' + JSON.stringify(g.error) };
  const r = evaluate(g.value, registry);
  if (!r.ok) return { error: 'evaluate: ' + r.error.join('; ') };
  const evaluation = r.value;
  return { graph: g.value, value: (id: string, key: Key) => evaluation.value(NodeId(id), key) };
}

/**
 * The capacity CEILING (client req/s at which the system's busiest tier reaches ρ = 1). Evaluated at a small
 * sub-saturation probe and linearly extrapolated: in a feed-forward network the analytic ρ is linear in the
 * offered load, so ceiling = probe / max-ρ is exact and probe-independent. The probe is halved if a candidate
 * tunable ever pushes it into saturation, so the extrapolation always uses an unsaturated point.
 */
function predictCeiling(entry: CalibrationEntry, model: LoadedModel, gt: GroundTruth, regime: Regime, values: TunableValues): number {
  let probe = gt.probeLoadRps ?? entry.workloadSweep.points[0] ?? 1000;
  for (let i = 0; i < 30 && probe > 1e-6; i++) {
    const ev = evaluateApplied(model, entry, regime, values, probe);
    if ('error' in ev) return NaN;
    const queues = nodeQueues(ev.graph, ev.value);
    let maxRho = 0;
    for (const q of queues.values()) if (Number.isFinite(q.rho) && q.rho > maxRho) maxRho = q.rho;
    if (maxRho <= 0) return NaN;
    if (maxRho >= 0.95) { probe /= 2; continue; } // stay sub-saturation, then extrapolate
    return probe / maxRho;
  }
  return NaN;
}

/**
 * A tier's SHARE of end-to-end latency (%): the numerator node's own queueing sojourn divided by the operation
 * entry node's end-to-end response latency (the report's "~5 ms of ~46 ms"). Read from the same analytic twin the
 * canvas uses (nodeQueues for the hop, responseLatency for the operation), at a sub-saturation load point.
 */
function predictShare(entry: CalibrationEntry, model: LoadedModel, gt: GroundTruth, regime: Regime, values: TunableValues): number {
  const load = gt.probeLoadRps ?? entry.workloadSweep.points[0] ?? 1000;
  const ev = evaluateApplied(model, entry, regime, values, load);
  if ('error' in ev) return NaN;
  if (gt.numeratorNode === undefined || gt.denominatorNode === undefined) return NaN;
  const queues = nodeQueues(ev.graph, ev.value);
  const resp = responseLatency(ev.graph, ev.value, queues);
  const num = queues.get(gt.numeratorNode)?.sojournMs;
  const den = resp.get(gt.denominatorNode);
  if (num === undefined || den === undefined || !(den > 0) || !Number.isFinite(num)) return NaN;
  return (100 * num) / den;
}

/** Predict the metric of one ground-truth point (dispatch on its kind). Returns NaN if the design cannot evaluate. */
export function predictMetric(entry: CalibrationEntry, model: LoadedModel, gt: GroundTruth, regime: Regime, values: TunableValues): number {
  switch (gt.metric) {
    case 'capacityCeilingRps':
      return predictCeiling(entry, model, gt, regime, values);
    case 'latencySharePct':
      return predictShare(entry, model, gt, regime, values);
  }
}

/** A DES tail corroboration (report-only, never scored): the measured p50/p95/p99 at a sub-saturation load. */
export interface DesTail {
  readonly loadRps: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly note: string;
}

/**
 * Corroborate the fitted design with the discrete-event simulation — the SAME toQueueingNetwork → simulate path
 * the product's `simulate` tool runs, deterministic under seed 7. Held at ~0.85× the fitted ceiling (sub-saturation,
 * so the queue is bounded and the run is fast) to read a stable tail. Best-effort: returns undefined if the design
 * cannot build or the ceiling is not finite (never throws into the report).
 */
export function desCorroboration(entry: CalibrationEntry, model: LoadedModel, values: TunableValues, ceilingRps: number): DesTail | undefined {
  if (!Number.isFinite(ceilingRps) || ceilingRps <= 0) return undefined;
  const load = Math.max(1, Math.round(0.85 * ceilingRps));
  const ev = evaluateApplied(model, entry, 'fitted', values, load);
  if ('error' in ev) return undefined;
  try {
    const sim = simulate(toQueueingNetwork(ev.graph), { seed: 7, warmupCompletions: 2000, measureCompletions: 8000 });
    const ms = (q: number): number => sim.sojournPercentile(q) * 1000;
    return { loadRps: load, p50: ms(0.5), p95: ms(0.95), p99: ms(0.99), note: 'DES seed 7, 2k warmup / 8k measured, at ~0.85x the fitted ceiling' };
  } catch {
    return undefined;
  }
}
