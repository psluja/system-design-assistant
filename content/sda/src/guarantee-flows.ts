import { DimensionId, NodeId, type Graph } from '@sda/engine-core';
import { propagateFlow, type DimensionResult, type FlowGuarantees } from '@sda/engine-solve';
import { categorical } from './guarantees';
import { requestFlows, type ValueFn } from './system';

// The per-flow GUARANTEE roll-up — computed ONCE and shared by every surface
// (the MCP `evaluate`, and R3's canvas/System panel/design-doc), so the human and the AI read the SAME tokens
// and root causes. It reuses the SAME (source, terminal) flow decomposition the numeric roll-ups use
// (`requestFlows`), then asks the engine's domain-agnostic propagator for each dimension's end-to-end token +
// root cause. Domain-aware only in that it knows the content categorical vocabulary — the propagation itself is
// the engine's; this is the projector seam ("the web is a dumb renderer": one shared computation, no drift).

/** One flow's guarantee result, flattened for a surface: source, terminal, and per-dimension token + root cause. */
export interface FlowGuaranteeSummary {
  readonly source: string;
  readonly terminal: string;
  readonly dimensions: readonly {
    readonly dimension: string;
    readonly token: string;
    /** The node id the guarantee first dropped at (the provable root cause), or null if it never degraded. */
    readonly rootCauseNode: string | null;
    /** The port/edge id that declared the degrading contribution, or null. */
    readonly rootCauseScope: string | null;
    /** True iff the path touched a declared-unknown token — the verdict is honestly `unknown`, not a guess. */
    readonly touchedUnknown: boolean;
  }[];
}

/** Flatten one engine {@link FlowGuarantees} into the surface shape, dropping dimensions no hop touched AND left
 *  at TOP with no root cause (a preserved-strongest guarantee is not worth a row under the no-filler rule — a
 *  surface shows only what a flow actually claims or degrades). */
function summarise(fg: FlowGuarantees): FlowGuaranteeSummary {
  const dims = fg.dimensions
    .filter((d: DimensionResult) => d.rootCause !== null || d.touchedUnknown)
    .map((d) => ({
      dimension: String(d.dimension),
      token: String(d.token),
      rootCauseNode: d.rootCause ? String(d.rootCause.node) : null,
      rootCauseScope: d.rootCause ? String(d.rootCause.scope) : null,
      touchedUnknown: d.touchedUnknown,
    }));
  return { source: String(fg.source), terminal: String(fg.terminal), dimensions: dims };
}

/**
 * Per-flow guarantee summaries for a solved design: for each request flow (its source→terminal), propagate every
 * declared categorical dimension and report the degraded/unknown ones with their root cause. A flow whose every
 * dimension stays at its strongest guarantee contributes no rows — the whole feature stays silent for a design
 * that declares no guarantees (the no-filler rule). Deterministic: flows follow `requestFlows`' busiest-first
 * order; within a flow, dimensions follow the vocabulary order.
 *
 * When a flow has MULTIPLE source→terminal paths (a fan-out), the engine returns one result per path; we keep the
 * WEAKEST per dimension (the honest worst case a consumer could see), attributing to that path's root cause.
 */
export function flowGuarantees(graph: Graph, instances: readonly { readonly id: string; readonly type?: string }[], wires: readonly { readonly from: readonly [string, string]; readonly to: readonly [string, string] }[], value: ValueFn): FlowGuaranteeSummary[] {
  const out: FlowGuaranteeSummary[] = [];
  for (const flow of requestFlows(instances, wires, value)) {
    const paths = propagateFlow(graph, categorical, NodeId(flow.source), NodeId(flow.terminal));
    if (paths.length === 0) continue;
    // Merge the paths into one worst-case result per dimension (a fan-out consumer sees the weakest path).
    const worst = mergeWorst(paths);
    const summary = summarise(worst);
    if (summary.dimensions.length > 0) out.push(summary);
  }
  return out;
}

/** Combine several paths of one flow into a single worst-case {@link FlowGuarantees}: per dimension keep the
 *  path whose token is weakest (and, on a tie, the one that already carries a root cause), so a fan-out reports
 *  the honest floor a consumer could observe. Deterministic (paths are already in a stable order). */
function mergeWorst(paths: readonly FlowGuarantees[]): FlowGuarantees {
  const first = paths[0] as FlowGuarantees;
  if (paths.length === 1) return first;
  const byDim = new Map<string, DimensionResult>();
  const lat = (id: string) => categorical.get(DimensionId(id));
  for (const p of paths) {
    for (const d of p.dimensions) {
      const key = String(d.dimension);
      const prev = byDim.get(key);
      if (prev === undefined) {
        byDim.set(key, d);
        continue;
      }
      const l = lat(key);
      if (l === undefined) continue;
      const prevRank = l.rank(prev.token) ?? 0;
      const curRank = l.rank(d.token) ?? 0;
      // keep the weaker (larger rank); on a tie prefer one that names a root cause (more informative)
      if (curRank > prevRank || (curRank === prevRank && prev.rootCause === null && d.rootCause !== null)) byDim.set(key, d);
    }
  }
  return { source: first.source, terminal: first.terminal, dimensions: [...byDim.values()] };
}
