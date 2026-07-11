import type { CauseLink, Graph, Key, NodeId, Registry, Remediation, Status, Verdict } from '@sda/engine-core';
import { Unit, exceedsCeiling } from '@sda/engine-core';

/**
 * Supplies the value of a key's tail at a given quantile (q ∈ (0,1)), in the key's own unit, or
 * undefined when no tail is available for that (node, key). It is the seam to the time engine: the
 * caller builds one from a DES run, keeping engine/solve decoupled from engine/sim (doc-4 §3b).
 */
export type TailProvider = (node: NodeId, key: Key, quantile: number) => number | undefined;

/** Parse a percentile label ("p50", "p99", "p999") to a quantile (0.5, 0.99, 0.999). */
function quantileOf(name: string): number | undefined {
  if (!/^p\d+$/.test(name)) return undefined;
  const q = Number(`0.${name.slice(1)}`);
  return Number.isFinite(q) && q > 0 && q < 1 ? q : undefined;
}

/**
 * Turn percentile (tail) SLO bands into honest verdicts using a DES-derived tail, replacing the
 * `unknown` the scalar forward pass must return for them (doc-4 §3b, §6). A target is breached when
 * the simulated quantile exceeds it; the verdict reports the highest answered quantile's value and a
 * remediation. A band no tail can answer stays `unknown` — never a guess.
 */
export function checkTailBands(graph: Graph, registry: Registry, tail: TailProvider): Verdict[] {
  const verdicts: Verdict[] = [];
  for (const node of graph.nodes.values()) {
    for (const cell of node.cells) {
      if (cell.kind !== 'input' || cell.value.kind !== 'band' || cell.value.band.shape !== 'percentiles') continue;
      const unit = registry.get(cell.key)?.unit ?? Unit('');

      let status: Status = 'unknown';
      let reported = NaN;
      let reportedQ = -1;
      const cause: CauseLink[] = [];
      let breached = '';

      for (const [name, target] of cell.value.band.targets) {
        const q = quantileOf(name);
        if (q === undefined) continue;
        const v = tail(node.id, cell.key, q);
        if (v === undefined) continue;
        if (status === 'unknown') status = 'ok'; // at least one target answered
        if (q > reportedQ) {
          reportedQ = q;
          reported = v;
        }
        // ε-tolerant (doc: latency-semantics-v2 §5): a tail within float noise of its target is AT it, not a
        // rounding-artefact breach; a real miss beyond ε still fails.
        if (exceedsCeiling(v, target)) {
          status = 'violation';
          breached = name;
          cause.push({ scope: node.id, key: cell.key, note: `${name} ${v} ${unit} exceeds target ${target} ${unit}` });
        }
      }

      const remediations: Remediation[] =
        status === 'violation'
          ? [{ action: `Cut ${cell.key} ${breached} at ${node.id}: add capacity at the saturated tier or shed load`, rank: 1 }]
          : [];
      verdicts.push({ key: cell.key, scope: node.id, computed: { value: reported, unit }, status, cause, remediations });
    }
  }
  return verdicts;
}
