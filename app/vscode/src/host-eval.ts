import { Studio, deserialize } from '@sda/core';
import { registry, allManifests, nodeQueues, realAwareVerdicts, timeSweep, peakLoadByNode, LOAD_STAGES_DEFAULTS, type EvaluateGraph, type NodePeak, type NodeQueue } from '@sda/content';
import { evaluate } from '@sda/engine-solve';
import { NodeId, Key, type Graph, type Verdict } from '@sda/engine-core';

// The ONE host-side evaluation path for a `.sda.json` opened as TEXT. Both the CodeLens roll-ups (text-insights)
// and the SLO Test Explorer (slo-tests) must build a throwaway Studio from the document text and run the SAME
// queueing-aware verdict path the canvas uses — otherwise the two native surfaces could disagree with each other
// and with the canvas (the tool would lie). This module is that single seam: `evaluateText` compiles the text and
// returns the real-aware verdicts + a value lookup + the graph, or null when the design does not build.
//
// Pure of vscode and deterministic (no clock/randomness): the same text always yields the same result — so it is
// unit-testable directly under vitest and cannot drift between surfaces.

/** The host-side evaluation of one design text: the queueing-aware verdicts plus the raw handles a caller needs to
 *  read solved values (a node's real latency, a tier's ρ). Everything here mirrors what the canvas computes. */
export interface HostEvaluation {
  /** The ONE real-aware verdict list (queueing-aware latency + ρ≥1 saturation) every surface consumes. */
  readonly verdicts: readonly Verdict[];
  /** The validated engine graph (topology + cells) the verdicts were computed against. */
  readonly graph: Graph;
  /** A solved-value lookup by node id + registry key (undefined when that node has no value for the key). */
  readonly value: (id: string, key: Key) => number | undefined;
  /** The per-node queue model (ρ, waits) — reused so a caller never recomputes it out of step with the verdicts. */
  readonly queues: Map<string, NodeQueue>;
  /** WORST-CASE LOAD (owner ruling: a peak is just traffic in a given environment) — each node's worst-window ρ from
   *  the ambient Tier-1 sweep, folded into `verdicts` so a node saturated at its declared peak reads red like the
   *  canvas. Undefined when no generator is shaped (the design has no time-varying demand — byte-identical). */
  readonly peak: ReadonlyMap<string, NodePeak> | undefined;
}

/**
 * Build a throwaway Studio from the design TEXT and evaluate it with the queueing-aware path. Returns null when the
 * text does not parse OR the design does not build/evaluate — the caller then shows NO fabricated state (an honest
 * "did not build", never a fake ok/violation). Same inputs every time → same output.
 */
export function evaluateText(text: string): HostEvaluation | null {
  const parsed = deserialize(text);
  if (!parsed.ok) return null;

  const studio = new Studio(registry, allManifests, parsed.value);
  const ev = studio.evaluate();
  if (!ev.ok) return null;
  const graphR = studio.graph();
  if (!graphR.ok) return null;
  const graph = graphR.value;

  const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
  const queues = nodeQueues(graph, value);
  // WORST-CASE LOAD (owner ruling): when a generator declares periodic cycles, run the ambient Tier-1 sweep (the
  // SAME coarse live budget the canvas worker uses, so the native surfaces read the same worst-window ρ as the
  // canvas) and fold each node's worst-window ρ into the verdicts — so a node saturated only at its declared peak
  // reads a real violation here too. Silent (undefined) for a flat design ⇒ the verdict list is byte-identical.
  const evalDI: EvaluateGraph = (gr) => { const r = evaluate(gr, registry); return r.ok ? r.value : undefined; };
  const sweep = timeSweep({ graph, evaluate: evalDI, pointsPerCycle: LOAD_STAGES_DEFAULTS.livePointsPerCycle, maxWindows: LOAD_STAGES_DEFAULTS.liveWindowTarget });
  const peak = sweep !== undefined ? peakLoadByNode(sweep) : undefined;
  const verdicts = realAwareVerdicts(ev.value.verdicts, graph, value, queues, peak);
  return { verdicts, graph, value, queues, peak };
}
