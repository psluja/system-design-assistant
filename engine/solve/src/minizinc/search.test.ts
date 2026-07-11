import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGraph,
  registryOf,
  ClassId,
  EdgeId,
  Key,
  NodeId,
  PortId,
  Unit,
  type Band,
  type Edge,
  type Graph,
  type KeyDef,
  type Node,
  type Port,
} from '@sda/engine-core';
import { optimizeModel, reachableTunables, relaxedModel, type Tunable } from './search';
import { parseMznCliOutput } from './cli';

const MZN = process.env.MINIZINC ?? 'minizinc';

const tput = Key('throughput');
const cost = Key('cost');

const registry = registryOf([
  { key: tput, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'min', onAsyncEdge: 'cut' }, kind: 'derived' },
  { key: cost, unit: Unit('USD'), band: 'minTargetMax', aggregate: { series: 'sum', onAsyncEdge: 'cut' }, kind: 'derived' },
] satisfies KeyDef[]);

// request(1000 req/s) → service(capacity = a TUNABLE knob; cost = capacity·0.1) with a throughput SLO.
// out(service,throughput) = min(capacity, 1000); out(service,cost) = capacity·0.1.
function serviceGraph(tputBand: Band): Graph {
  const req = NodeId('req');
  const svc = NodeId('svc');
  const reqOut = PortId('req.out');
  const svcIn = PortId('svc.in');
  const nodes: Node[] = [
    { id: req, ports: [reqOut], cells: [{ kind: 'input', key: tput, value: { kind: 'fixed', quantity: { value: 1000, unit: Unit('req/s') } } }] },
    {
      id: svc,
      ports: [svcIn],
      cells: [
        { kind: 'input', key: tput, value: { kind: 'fixed', quantity: { value: 500, unit: Unit('req/s') } } }, // freed by the tunable
        { kind: 'derived', key: cost, relation: { produces: cost, reads: [tput], expr: 'throughput * 0.1' } },
        { kind: 'input', key: tput, value: { kind: 'band', band: tputBand } },
      ],
    },
  ];
  const ports: Port[] = [
    { id: reqOut, node: req, dir: 'out' },
    { id: svcIn, node: svc, dir: 'in' },
  ];
  const edges: Edge[] = [{ id: EdgeId('e1'), from: reqOut, to: svcIn, semantics: 'sync' }];
  const g = buildGraph({ nodes, ports, edges });
  if (!g.ok) throw new Error('invalid graph');
  return g.value;
}

function solveModel(source: string): Record<string, number> {
  const dir = mkdtempSync(join(tmpdir(), 'sda-search-'));
  try {
    const file = join(dir, 'm.mzn');
    writeFileSync(file, source);
    // COIN-BC (MIP/LP), not Gecode: continuous optimization with a terminating optimality proof.
    const out = execFileSync(MZN, ['--solver', 'cbc', '--output-mode', 'json', file], { encoding: 'utf8' });
    const o = parseMznCliOutput(out);
    return o.kind === 'solved' ? o.values : {};
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SVC = NodeId('svc');
const tunable: Tunable = { node: SVC, key: tput, min: 0, max: 1000 };

describe('MiniZinc search projector (optimize + UNSAT explain)', () => {
  it('optimize: picks the cheapest capacity that still meets the throughput SLO', () => {
    // SLO: throughput floor 300. min(capacity,1000) >= 300 ⇒ capacity >= 300; minimize cost ⇒ capacity = 300.
    const g = serviceGraph({ shape: 'minTargetMax', min: 300 });
    const m = optimizeModel(g, registry, [tunable], { node: SVC, key: cost, direction: 'min' });
    if (!m.ok) throw new Error(m.error.join('; '));
    const sol = solveModel(m.value.source);

    const capName = m.value.tunables[0]?.name as string;
    expect(sol[capName]).toBeCloseTo(300, 4);

    const costRef = m.value.valueOf(SVC, cost);
    expect(costRef?.kind).toBe('var');
    if (costRef?.kind === 'var') expect(sol[costRef.name]).toBeCloseTo(30, 4);

    const tputRef = m.value.valueOf(SVC, tput);
    if (tputRef?.kind === 'var') expect(sol[tputRef.name]).toBeCloseTo(300, 4);
  });

  it('UNSAT explain: an impossible SLO yields the exact shortfall as a penalty', () => {
    // SLO floor 1200, but throughput can never exceed the 1000 offered ⇒ best shortfall = 200.
    const g = serviceGraph({ shape: 'minTargetMax', min: 1200 });
    const m = relaxedModel(g, registry, [tunable]);
    if (!m.ok) throw new Error(m.error.join('; '));
    const sol = solveModel(m.value.source);

    expect(m.value.penalties).toHaveLength(1);
    const pen = m.value.penalties[0];
    expect(pen?.key).toBe(tput);
    expect(pen?.bound).toBe('floor');
    expect(sol[pen?.name as string]).toBeCloseTo(200, 4);
  });

  it('rejects a cyclic search honestly rather than solving it wrong', () => {
    // self-loop on svc makes (svc,throughput) cyclic
    const g = serviceGraph({ shape: 'minTargetMax', min: 300 });
    const svcOut = PortId('svc.out2');
    const svcIn2 = PortId('svc.in2');
    const cyclic: Graph = {
      nodes: new Map([
        ...g.nodes,
        [SVC, { ...g.nodes.get(SVC) as Node, ports: [...(g.nodes.get(SVC) as Node).ports, svcOut, svcIn2] }],
      ]),
      ports: new Map([
        ...g.ports,
        [svcOut, { id: svcOut, node: SVC, dir: 'out' }],
        [svcIn2, { id: svcIn2, node: SVC, dir: 'in' }],
      ]),
      edges: new Map([...g.edges, [EdgeId('loop'), { id: EdgeId('loop'), from: svcOut, to: svcIn2, semantics: 'sync' }]]),
    };
    const m = optimizeModel(cyclic, registry, [tunable], { node: SVC, key: cost, direction: 'min' });
    expect(m.ok).toBe(false);
  });

  // FLOW TRANSFORMS in the SEARCH (MIP) path: the MiniZinc model consumes the SAME transform-baked cell network
  // as the JS hot path, so optimize sizes for the TRANSFORMED offered load — a differential-in-spirit check that
  // the search honours the same arithmetic. request emits 1000, an OUT-port ratio(10) offers 10 000 to the
  // service; a throughput floor of 5000 forces capacity ≥ 5000 (cost 500), not the un-transformed 5000@1×.
  it('optimize sizes for the TRANSFORMED offered load (an out-port ratio scales what the service must serve)', () => {
    // A flow-flagged registry so the port ratio actually acts (the top-of-file one is a plain non-flow key).
    const flowReg = registryOf([
      { key: tput, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'min', fanIn: 'sum', onAsyncEdge: 'carry', flow: true }, kind: 'derived' },
      { key: cost, unit: Unit('USD'), band: 'minTargetMax', aggregate: { series: 'sum', onAsyncEdge: 'carry' }, kind: 'derived' },
    ] satisfies KeyDef[]);
    const req = NodeId('req');
    const svc = NodeId('svc');
    const nodes: Node[] = [
      { id: req, ports: [PortId('req.out')], cells: [{ kind: 'input', key: tput, value: { kind: 'fixed', quantity: { value: 1000, unit: Unit('req/s') } } }] },
      {
        id: svc,
        ports: [PortId('svc.in')],
        cells: [
          { kind: 'input', key: tput, value: { kind: 'fixed', quantity: { value: 500, unit: Unit('req/s') } } }, // freed by the tunable
          { kind: 'derived', key: cost, relation: { produces: cost, reads: [tput], expr: 'throughput * 0.1' } },
          { kind: 'input', key: tput, value: { kind: 'band', band: { shape: 'minTargetMax', min: 5000 } } },
        ],
      },
    ];
    const ports: Port[] = [
      { id: PortId('req.out'), node: req, dir: 'out', transform: { kind: 'ratio', value: 10 } }, // 1000 → 10 000 offered
      { id: PortId('svc.in'), node: svc, dir: 'in' },
    ];
    const edges: Edge[] = [{ id: EdgeId('e1'), from: PortId('req.out'), to: PortId('svc.in'), semantics: 'sync' }];
    const gg = buildGraph({ nodes, ports, edges });
    if (!gg.ok) throw new Error('invalid graph');

    const m = optimizeModel(gg.value, flowReg, [{ node: svc, key: tput, min: 0, max: 20000 }], { node: svc, key: cost, direction: 'min' });
    if (!m.ok) throw new Error(m.error.join('; '));
    const sol = solveModel(m.value.source);
    const capName = m.value.tunables[0]?.name as string;
    // 10 000 offered; to serve the 5000 floor, min(cap, 10000) ≥ 5000 ⇒ cap = 5000 (minimise cost). Without the
    // ratio the floor would be met at cap=1000, so this value proves the search read the transformed inflow.
    expect(sol[capName]).toBeCloseTo(5000, 3);
  });

  // THE TOTAL OBJECTIVE (dogfood F8): `{ total: true }` optimizes the WHOLE-GRAPH sum of local(node, key) — the
  // whole design's own cost — instead of one node's cumulative out-cell. The fan-out below is the distinguishing
  // shape: svcB is OFF the SLO branch, so out(svcA, cost) never sees its spend; only the total prices it.
  //   req(1000) → svcA (tunable, cost 0.1/unit, floor 300)
  //   req(1000) → svcB (tunable, cost 0.2/unit, no band)
  function fanOutGraph(): Graph {
    const req = NodeId('req');
    const svcA = NodeId('svcA');
    const svcB = NodeId('svcB');
    const nodes: Node[] = [
      { id: req, ports: [PortId('req.out')], cells: [{ kind: 'input', key: tput, value: { kind: 'fixed', quantity: { value: 1000, unit: Unit('req/s') } } }] },
      {
        id: svcA,
        ports: [PortId('svcA.in')],
        cells: [
          { kind: 'input', key: tput, value: { kind: 'fixed', quantity: { value: 500, unit: Unit('req/s') } } }, // freed
          { kind: 'derived', key: cost, relation: { produces: cost, reads: [tput], expr: 'throughput * 0.1' } },
          { kind: 'input', key: tput, value: { kind: 'band', band: { shape: 'minTargetMax', min: 300 } } },
        ],
      },
      {
        id: svcB,
        ports: [PortId('svcB.in')],
        cells: [
          { kind: 'input', key: tput, value: { kind: 'fixed', quantity: { value: 500, unit: Unit('req/s') } } }, // freed
          { kind: 'derived', key: cost, relation: { produces: cost, reads: [tput], expr: 'throughput * 0.2' } },
        ],
      },
    ];
    const ports: Port[] = [
      { id: PortId('req.out'), node: req, dir: 'out' },
      { id: PortId('svcA.in'), node: svcA, dir: 'in' },
      { id: PortId('svcB.in'), node: svcB, dir: 'in' },
    ];
    const edges: Edge[] = [
      { id: EdgeId('eA'), from: PortId('req.out'), to: PortId('svcA.in'), semantics: 'sync' },
      { id: EdgeId('eB'), from: PortId('req.out'), to: PortId('svcB.in'), semantics: 'sync' },
    ];
    const g = buildGraph({ nodes, ports, edges });
    if (!g.ok) throw new Error('invalid graph');
    return g.value;
  }
  const fanOutTunables: Tunable[] = [
    { node: NodeId('svcA'), key: tput, min: 0, max: 1000 },
    { node: NodeId('svcB'), key: tput, min: 0, max: 1000 },
  ];

  it('optimize with a TOTAL objective prices the off-path branch too (svcB descends to 0; svcA to its floor)', () => {
    const m = optimizeModel(fanOutGraph(), registry, fanOutTunables, { node: NodeId('svcA'), key: cost, direction: 'min', total: true });
    if (!m.ok) throw new Error(m.error.join('; '));
    // The solve line is ONE linear sum of the local cost terms — the MIP takes it natively.
    expect(m.value.source).toMatch(/solve minimize .+ \+ .+;/);
    const sol = solveModel(m.value.source);
    const capA = m.value.tunables[0]?.name as string;
    const capB = m.value.tunables[1]?.name as string;
    expect(sol[capA]).toBeCloseTo(300, 4); // the floor holds: min(capA, 1000) ≥ 300 at least cost
    expect(sol[capB]).toBeCloseTo(0, 4); // no band on svcB ⇒ the total drives its knob to 0
    // Hand-computed whole-design total at the optimum: 300·0.1 + 0·0.2 = 30.
    const costA = m.value.valueOf(NodeId('svcA'), cost);
    const costB = m.value.valueOf(NodeId('svcB'), cost);
    const read = (ref: typeof costA): number => (ref === null ? Number.NaN : ref.kind === 'var' ? sol[ref.name] ?? Number.NaN : ref.value);
    expect(read(costA) + read(costB)).toBeCloseTo(30, 4);
  });

  it('reachableTunables keeps the off-path knob under a TOTAL objective and prunes it under the single-cell one', () => {
    const g = fanOutGraph();
    const single = reachableTunables(g, registry, fanOutTunables, { node: NodeId('svcA'), key: cost }, []);
    expect(single.map((t) => String(t.node))).toEqual(['svcA']); // svcB has no gradient on out(svcA, cost)
    const total = reachableTunables(g, registry, fanOutTunables, { node: NodeId('svcA'), key: cost, total: true }, []);
    expect(total.map((t) => String(t.node)).sort()).toEqual(['svcA', 'svcB']); // every priced knob survives
  });

  it('rejects a TOTAL objective combined with request classes honestly', () => {
    const g = serviceGraph({ shape: 'minTargetMax', min: 300 });
    const m = optimizeModel(g, registry, [tunable], { node: SVC, key: cost, direction: 'min', total: true }, undefined, [
      { id: ClassId('c0'), edges: [EdgeId('e1')], origins: [{ node: NodeId('req'), rps: 100 }] },
    ]);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.error.join(' ')).toContain('request classes');
  });
});
