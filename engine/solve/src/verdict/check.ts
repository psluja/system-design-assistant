import { withinBound, exceedsCeiling, belowFloor, type Band, type CauseChain, type ClassId, type Graph, type Registry, type Remediation, type Status, type Verdict } from '@sda/engine-core';
import type { Network } from '../network';
import { explain, type Goal } from './explain';

/**
 * Turn solved cell values into honest verdicts: for every band declared on a node, compare the
 * computed value of that key against the band → ok / warning / violation / unknown.
 * Percentile bands are 'unknown' until the DES computes true tails. `cause` and
 * `remediations` are enriched in a later slice.
 */
export function evaluateBands(
  graph: Graph,
  registry: Registry,
  network: Network,
  values: ReadonlyMap<string, number>,
): readonly Verdict[] {
  const verdicts: Verdict[] = [];
  for (const node of graph.nodes.values()) {
    for (const cell of node.cells) {
      if (cell.kind !== 'input' || cell.value.kind !== 'band') continue;
      const def = registry.get(cell.key);
      if (def === undefined) continue; // unknown key (buildNetwork would already have errored)

      // PER-CLASS PERSPECTIVES: under declared classes, a non-flow, non-local key
      // (latency, availability, cost) has NO honest class-blind value at a shared node — it lives per class (a node
      // crossed by two classes has two latencies). So the band is judged ONCE PER CLASS, reading that class's own
      // `out(N,K,C)`. A FLOW key is judged against the node's class-blind TOTAL served (`out(N,K)` = Σ_C served, a
      // single unambiguous aggregate); a node-LOCAL ceiling is class-blind by construction. With NO classes the
      // list is empty and this collapses to exactly one class-less verdict per band — byte-for-byte today.
      const perClass = network.classes.length > 0 && def.aggregate.local !== true && def.aggregate.flow !== true;
      const scopes: readonly (ClassId | undefined)[] = perClass ? network.classes : [undefined];

      for (const cls of scopes) {
        const computed = values.get(network.out(node.id, cell.key, cls));
        const status: Status =
          computed !== undefined && Number.isFinite(computed)
            ? statusForBand(computed, cell.value.band)
            : 'unknown';

        // Cause-chain / remediation attribution walks the class-BLIND cells; keep it for the class-blind verdicts
        // (no classes, flow total, node-local ceiling) where it is exact, and leave a per-class perspective's cause
        // empty in R2 — the honest status is the load-bearing output; per-class attribution is a later refinement.
        let cause: CauseChain = [];
        let remediations: readonly Remediation[] = [];
        if (cls === undefined && (status === 'warning' || status === 'violation') && computed !== undefined) {
          const goal = goalFor(computed, cell.value.band);
          if (goal !== null) {
            const ex = explain(network, registry, values, node.id, cell.key, goal);
            cause = ex.cause;
            remediations = ex.remediations;
          }
        }

        verdicts.push({
          key: cell.key,
          scope: node.id,
          computed: { value: computed ?? NaN, unit: def.unit },
          status,
          cause,
          remediations,
          ...(cls !== undefined ? { class: cls } : {}),
        });
      }
    }
  }
  return verdicts;
}

/** The direction a breached band wants the value moved — drives the remediation verb. */
function goalFor(v: number, band: Band): Goal | null {
  switch (band.shape) {
    case 'minTargetMax':
      if (band.max !== undefined && v > band.max) return 'lower';
      if ((band.min !== undefined && v < band.min) || (band.target !== undefined && v < band.target)) return 'raise';
      return null;
    case 'point':
      return v > band.target ? 'lower' : v < band.target ? 'raise' : null;
    case 'percentiles':
      return null;
  }
}

/** A hard-floor/ceiling breach is a violation; below target is a warning; otherwise ok. Every comparison is
 *  ε-tolerant (the ONE shared `closeEnough`, doc: latency-semantics-v2 §5): a value within float noise of a bound
 *  is AT the bound, never a rounding-artefact breach — but a real miss beyond ε still fails honestly. This unifies
 *  the point-case tolerance (previously a bespoke 1e-9) onto the same shared ε as the floor/ceiling. */
function statusForBand(v: number, band: Band): Status {
  switch (band.shape) {
    case 'minTargetMax':
      if (band.max !== undefined && exceedsCeiling(v, band.max)) return 'violation';
      if (band.min !== undefined && belowFloor(v, band.min)) return 'violation';
      if (band.target !== undefined && belowFloor(v, band.target)) return 'warning';
      return 'ok';
    case 'point':
      return withinBound(v, band.target) ? 'ok' : 'warning';
    case 'percentiles':
      return 'unknown'; // true tails need the DES, not a scalar
  }
}
