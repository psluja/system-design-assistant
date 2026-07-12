// The conformance CORPUS — a small set of designs with KNOWN answers that the conformance suite runs every
// adapter against. Each fixture is domain-agnostic: two nodes, a
// throughput floor SLO on the sink and a linear cost relation, so an adapter's optimize/repair/explain answer
// is arithmetic anyone can check by hand. This is the anti-lie corpus — it is the SHARED reference both the
// incumbent and any future adapter are graded on, so it lives with the contract, not in an app.
//
// A design is a `{ graph, registry }` pair plus the tunable/objective the search fixtures use. The numbers are
// deliberately round (demand 1000, unit cost 0.1) so the expected optimum/shortfall/repair is exact.

import { buildGraph, EdgeId, Key, NodeId, PortId, registryOf, Unit, type Band, type Edge, type Graph, type KeyDef, type Node, type Port, type Registry } from '@sda/engine-core';
import type { Objective, Tunable } from '../capability/optimize';

export const THROUGHPUT = Key('throughput');
export const COST = Key('cost');
export const SVC = NodeId('svc');

/** The corpus registry: a throughput key (the flow, min-aggregated) and a cost key (summed). */
export const corpusRegistry: Registry = registryOf([
  { key: THROUGHPUT, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'min', onAsyncEdge: 'cut' }, kind: 'derived' },
  { key: COST, unit: Unit('USD'), band: 'minTargetMax', aggregate: { series: 'sum', onAsyncEdge: 'cut' }, kind: 'derived' },
] satisfies KeyDef[]);

/** The freed knob the search fixtures vary: the service's own throughput capacity, in [0, 1000]. */
export const corpusTunable: Tunable = { node: SVC, key: THROUGHPUT, min: 0, max: 1000 };

/** The objective the optimize fixtures minimize: the service's cost. */
export const corpusObjective: Objective = { node: SVC, key: COST, direction: 'min' };

/**
 * request(1000 req/s) → service(capacity 500 req/s; cost = capacity·0.1) with a throughput SLO `band` on the
 * service. The single knob is the service's capacity. This is the same two-node shape the facade tests use,
 * lifted here so the conformance suite owns its own fixtures. Varying the floor gives the corpus its cases:
 *   - floor 300  ⇒ optimize picks capacity 300, cost 30 (feasible, cheapest meeting the floor);
 *   - floor 800  ⇒ repair raises 500 → 800 (delta 300);
 *   - floor 1200 ⇒ infeasible (capacity ≤ 1000 < 1200); explain reports a floor shortfall of 200.
 */
export function serviceGraph(band: Band): Graph {
  const req = NodeId('req');
  const reqOut = PortId('req.out');
  const svcIn = PortId('svc.in');
  const nodes: Node[] = [
    { id: req, ports: [reqOut], cells: [{ kind: 'input', key: THROUGHPUT, value: { kind: 'fixed', quantity: { value: 1000, unit: Unit('req/s') } } }] },
    {
      id: SVC,
      ports: [svcIn],
      cells: [
        { kind: 'input', key: THROUGHPUT, value: { kind: 'fixed', quantity: { value: 500, unit: Unit('req/s') } } },
        { kind: 'derived', key: COST, relation: { produces: COST, reads: [THROUGHPUT], expr: 'throughput * 0.1' } },
        { kind: 'input', key: THROUGHPUT, value: { kind: 'band', band } },
      ],
    },
  ];
  const ports: Port[] = [
    { id: reqOut, node: req, dir: 'out' },
    { id: svcIn, node: SVC, dir: 'in' },
  ];
  const edges: Edge[] = [{ id: EdgeId('e1'), from: reqOut, to: svcIn, semantics: 'sync' }];
  const g = buildGraph({ nodes, ports, edges });
  if (!g.ok) throw new Error('corpus graph is invalid — a fixture bug');
  return g.value;
}

/** A feasible design: floor 300, met by capacity 300 at cost 30 (the known optimum). */
export const feasibleDesign = (): Graph => serviceGraph({ shape: 'minTargetMax', min: 300 });

/** A violated-but-repairable design: floor 800 with capacity 500 ⇒ minimal repair raises 500 → 800. */
export const violatedDesign = (): Graph => serviceGraph({ shape: 'minTargetMax', min: 800 });

/** A proven-infeasible design: floor 1200 exceeds the max capacity 1000, so no assignment can meet it. */
export const infeasibleDesign = (): Graph => serviceGraph({ shape: 'minTargetMax', min: 1200 });

/** A well-formed selection problem for Enumerate: ingress → compute → store with protocol-style compatibility.
 *  The four valid chains are gw-faas-kv, gw-faas-sql, gw-vm-sql, lb-vm-sql (mirrors the ASP adapter test). */
export const selectionProblem = {
  slots: [
    { id: 'ingress', candidates: ['gw', 'lb'] },
    { id: 'compute', candidates: ['faas', 'vm'] },
    { id: 'store', candidates: ['sql', 'kv'] },
  ],
  adjacencies: [
    ['ingress', 'compute'],
    ['compute', 'store'],
  ],
  compatible: [
    ['gw', 'faas'],
    ['gw', 'vm'],
    ['lb', 'vm'],
    ['faas', 'sql'],
    ['faas', 'kv'],
    ['vm', 'sql'],
  ],
} as const;

/** An UNSAT selection problem: no compatibility, so no chain exists ⇒ an empty enumeration (not an error). */
export const unsatSelectionProblem = { ...selectionProblem, compatible: [] as const } as const;
