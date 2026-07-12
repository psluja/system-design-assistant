import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeId } from '@sda/engine-core';
import { optimizeModel, parseMznCliOutput, type Tunable } from '@sda/engine-solve';
import { instantiate, manifests, registry, keys, type Instance, type Wire } from '../index';

const MZN = process.env.MINIZINC ?? 'minizinc';

function solveCbc(source: string): Record<string, number> {
  const dir = mkdtempSync(join(tmpdir(), 'sda-opt-'));
  try {
    const file = join(dir, 'm.mzn');
    writeFileSync(file, source);
    const out = execFileSync(MZN, ['--solver', 'cbc', '--output-mode', 'json', file], { encoding: 'utf8' });
    const o = parseMznCliOutput(out);
    return o.kind === 'solved' ? o.values : {};
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// "Run backwards" on the SAME real content graph: given a hard 1000 req/s throughput SLO and a cost
// that scales with provisioned concurrency, find the cheapest compute sizing that meets the SLO.
// Capacity = concurrency / 0.05s, so 1000 req/s needs concurrency ≥ 50 — the optimizer must land there.
describe('content pack ⇄ engine — synthesize/optimize (run backwards)', () => {
  const instances: Instance[] = [
    { id: 'client', type: 'client.source' },
    { id: 'gw', type: 'gateway.api' },
    { id: 'compute', type: 'compute.faas' },
    { id: 'db', type: 'db.sql', bands: [{ key: keys.throughput, band: { shape: 'minTargetMax', min: 1000 } }] },
  ];
  const wires: Wire[] = [
    { from: ['client', 'out'], to: ['gw', 'in'] },
    { from: ['gw', 'out'], to: ['compute', 'in'] },
    { from: ['compute', 'out'], to: ['db', 'in'] },
  ];

  it('finds the minimum compute concurrency that meets the throughput SLO at least cost', () => {
    const built = instantiate(manifests, instances, wires);
    if (!built.ok) throw new Error('graph build failed');

    const tunable: Tunable = { node: NodeId('compute'), key: keys.concurrency, min: 0, max: 500 };
    const m = optimizeModel(built.value, registry, [tunable], { node: NodeId('db'), key: keys.cost, direction: 'min' });
    if (!m.ok) throw new Error(m.error.join('; '));

    const sol = solveCbc(m.value.source);
    const concurrencyName = m.value.tunables[0]?.name as string;
    expect(sol[concurrencyName]).toBeCloseTo(50, 4); // capacity 50 / 0.05 = 1000 req/s, exactly the SLO

    const costRef = m.value.valueOf(NodeId('db'), keys.cost);
    expect(costRef?.kind).toBe('var');
    if (costRef?.kind === 'var') expect(sol[costRef.name]).toBeCloseTo(325, 4); // 200 + (50·1.5 + 50)
  });
});
