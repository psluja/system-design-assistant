import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGraph,
  registryOf,
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
import { createEngine, type MznSolver } from './facade';
import { parseMznCliOutput } from './minizinc';

const MZN = process.env.MINIZINC ?? 'minizinc';
const tput = Key('throughput');
const cost = Key('cost');

const registry = registryOf([
  { key: tput, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'min', onAsyncEdge: 'cut' }, kind: 'derived' },
  { key: cost, unit: Unit('USD'), band: 'minTargetMax', aggregate: { series: 'sum', onAsyncEdge: 'cut' }, kind: 'derived' },
] satisfies KeyDef[]);

// COIN-BC runner injected into the engine — exactly how the browser would inject minizinc-js instead.
const solveMzn: MznSolver = async (model) => {
  const dir = mkdtempSync(join(tmpdir(), 'sda-facade-'));
  try {
    const file = join(dir, 'm.mzn');
    writeFileSync(file, model);
    const out = execFileSync(MZN, ['--solver', 'cbc', '--output-mode', 'json', file], { encoding: 'utf8' });
    return parseMznCliOutput(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// request(1000) → service(capacity tunable; cost = capacity·0.1) with a throughput SLO floor.
function serviceGraph(band: Band): Graph {
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
        { kind: 'input', key: tput, value: { kind: 'fixed', quantity: { value: 500, unit: Unit('req/s') } } },
        { kind: 'derived', key: cost, relation: { produces: cost, reads: [tput], expr: 'throughput * 0.1' } },
        { kind: 'input', key: tput, value: { kind: 'band', band } },
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

const SVC = NodeId('svc');
const tunable = { node: SVC, key: tput, min: 0, max: 1000 } as const;

describe('Engine facade', () => {
  it('optimize() returns the cheapest assignment meeting the SLO', async () => {
    const engine = createEngine(registry, { solveMzn });
    const r = await engine.optimize(serviceGraph({ shape: 'minTargetMax', min: 300 }), [tunable], { node: SVC, key: cost, direction: 'min' });
    if (!r.ok) throw new Error(r.error.join('; '));
    expect(r.value.assignments[0]?.value).toBeCloseTo(300, 4);
    expect(r.value.value(SVC, cost)).toBeCloseTo(30, 4);
  });

  it('explainInfeasible() reports the exact shortfall of an impossible SLO', async () => {
    const engine = createEngine(registry, { solveMzn });
    const r = await engine.explainInfeasible(serviceGraph({ shape: 'minTargetMax', min: 1200 }), [tunable]);
    if (!r.ok) throw new Error(r.error.join('; '));
    expect(r.value).toHaveLength(1);
    expect(r.value[0]?.key).toBe(tput);
    expect(r.value[0]?.bound).toBe('floor');
    expect(r.value[0]?.amount).toBeCloseTo(200, 4);
  });

  it('repair() finds the minimal change to a tunable that satisfies the SLO', async () => {
    const engine = createEngine(registry, { solveMzn });
    // current capacity 500, demand 1000, floor 800 ⇒ violation; smallest fix is raising 500 → 800.
    const r = await engine.repair(serviceGraph({ shape: 'minTargetMax', min: 800 }), [tunable]);
    if (!r.ok) throw new Error(r.error.join('; '));
    expect(r.value).toHaveLength(1);
    expect(r.value[0]?.key).toBe(tput);
    expect(r.value[0]?.from).toBe(500);
    expect(r.value[0]?.to).toBeCloseTo(800, 4);
    expect(r.value[0]?.delta).toBeCloseTo(300, 4);
  });

  it('sync modes work with no solver injected; search modes fail loudly', async () => {
    const engine = createEngine(registry); // no solveMzn
    const e = engine.evaluate(serviceGraph({ shape: 'minTargetMax', min: 300 }));
    expect(e.ok).toBe(true);
    await expect(engine.optimize(serviceGraph({ shape: 'minTargetMax', min: 300 }), [tunable], { node: SVC, key: cost, direction: 'min' })).rejects.toThrow(/no MiniZinc solver/);
  });
});
