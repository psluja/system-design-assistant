import type { Graph } from '@sda/engine-core';
import type { Tunable } from '@sda/engine-solve';
import { keys } from './registry';

// The provisioning knobs the backward-search (repair / optimize / synthesize) is allowed to vary — the
// SINGLE source of truth shared by the app, the MCP tools and synthesize (previously duplicated, and
// subtly wrong, in two places). It encodes the domain rules that keep the search honest:
//
//   • capacity dials are free: concurrency, replicas, maxUnits — BUT a node scaled by a COUNT (it declares
//     maxUnits or replicas) has a FIXED per-unit concurrency: you scale it by the count, so tune maxUnits /
//     replicas, never the per-unit concurrency. (Tuning both would make capacity = concurrency × count a
//     product of two variables — a nonlinear term no MIP/LP backend can linearise.)
//   • the offered WORKLOAD is fixed: `throughput` on a SOURCE node (no inflow) is the requirement, never a
//     knob — else the solver "cuts cost" by serving less traffic;
//   • `throughput` on a node WITH inflow is a capacity dial but RAISE-ONLY (min = current value): the search
//     may upsize it to meet an SLO, but never lower it to throttle flow and fake a cheaper design.
/** The whole-unit provisioning knobs: their capacity is an integer COUNT, so a continuous solver optimum must be
 *  CEIL-ed when written back (rounding down under-provisions; a fractional count is undeployable). The single
 *  definition the app, the MCP tools and synthesize all apply — previously re-encoded in three places. */
export const DISCRETE_KNOBS: ReadonlySet<string> = new Set([String(keys.concurrency), String(keys.replicas), String(keys.maxUnits)]);

/** Snap a solved knob value to what is deployable: ceil for a whole-unit knob, else round to 2 decimals. */
export const quantizeKnob = (key: string, v: number): number => (DISCRETE_KNOBS.has(key) ? Math.ceil(v) : Math.round(v * 100) / 100);

export function provisioningTunables(graph: Graph): Tunable[] {
  const out: Tunable[] = [];
  const hasInflow = new Set<string>();
  for (const e of graph.edges.values()) {
    const p = graph.ports.get(e.to);
    if (p) hasInflow.add(String(p.node));
  }
  const CONC = String(keys.concurrency), REPL = String(keys.replicas), THR = String(keys.throughput), UNITS = String(keys.maxUnits), ORIGIN = String(keys.assumedRps);
  for (const node of graph.nodes.values()) {
    // A node scaled by a COUNT (it declares maxUnits or replicas) keeps its per-unit concurrency fixed —
    // you grow it by the count, not the unit size. Tuning both would make capacity nonlinear (conc × count).
    const scaledByCount = node.cells.some((c) => c.kind === 'input' && (String(c.key) === UNITS || String(c.key) === REPL));
    for (const cell of node.cells) {
      if (cell.kind !== 'input' || cell.value.kind !== 'fixed') continue;
      const key = String(cell.key);
      // NEVER a tunable: assumedRps is DECLARED workload (like a client's throughput), FROZEN so the search cannot
      // reduce the traffic a node originates to fake meeting SLOs/cost (memory "search-tunables-no-cheating").
      // It is also excluded implicitly by the CONC/REPL/THR filter below; this guard makes the rule explicit.
      if (key === ORIGIN) continue;
      if (key === UNITS) { out.push({ node: node.id, key: cell.key, min: 1, max: 1e6 }); continue; }
      if (scaledByCount && key === CONC) continue; // per-unit/replica size is fixed; scale by the count
      if (key === THR && !hasInflow.has(String(node.id))) continue; // source = workload, fixed
      if (key !== CONC && key !== REPL && key !== THR) continue;
      out.push({ node: node.id, key: cell.key, min: key === THR ? cell.value.quantity.value : 1, max: 1e8 });
    }
  }
  return out;
}
