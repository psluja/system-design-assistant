import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { commonManifests, instantiate, registry, keys, type Instance, type Wire } from './index';

// Coverage for the quick-win properties: horizontal scaling, pay-per-use cost, data durability.
const client = (rps: number): Instance => ({ id: 'client', type: 'client.web', config: { throughput: rps } });

describe('SCALING: capacity = per-replica × replica count', () => {
  const run = (replicas: number): number => {
    const instances: Instance[] = [client(100000), { id: 'app', type: 'compute.replicated', config: { replicas } }];
    const wires: Wire[] = [{ from: ['client', 'out'], to: ['app', 'in'] }];
    const built = instantiate(commonManifests, instances, wires);
    if (!built.ok) throw new Error('build failed');
    const r = evaluate(built.value, registry);
    if (!r.ok) throw new Error('eval failed');
    return r.value.value(NodeId('app'), keys.throughput) ?? NaN;
  };

  it('scales throughput linearly with replicas (50 / 0.025 s = 2000 per replica)', () => {
    expect(run(2)).toBe(4000);
    expect(run(4)).toBe(8000);
    expect(run(8)).toBe(16000);
  });

  it('scales cost with replicas too ($30 / replica)', () => {
    const instances: Instance[] = [client(1000), { id: 'app', type: 'compute.replicated', config: { replicas: 4 } }];
    const built = instantiate(commonManifests, instances, [{ from: ['client', 'out'], to: ['app', 'in'] }]);
    if (!built.ok) throw new Error('build failed');
    const r = evaluate(built.value, registry);
    if (!r.ok) throw new Error('eval failed');
    expect(r.value.value(NodeId('app'), keys.cost)).toBe(120); // 4 × 30
  });
});

describe('PAY-PER-USE: cost tracks served throughput, not provisioned size', () => {
  const costAt = (demand: number): number => {
    const instances: Instance[] = [client(demand), { id: 'fn', type: 'compute.serverless' }];
    const built = instantiate(commonManifests, instances, [{ from: ['client', 'out'], to: ['fn', 'in'] }]);
    if (!built.ok) throw new Error('build failed');
    const r = evaluate(built.value, registry);
    if (!r.ok) throw new Error('eval failed');
    return r.value.value(NodeId('fn'), keys.cost) ?? NaN;
  };

  it('cost rises with load ($0.5 per sustained req/s) while idle ≈ 0', () => {
    expect(costAt(1000)).toBe(500); // 1000 × 0.5
    expect(costAt(2000)).toBe(1000);
    expect(costAt(0)).toBe(0); // pay-per-use: no load, no cost
  });
});

describe('DURABILITY: compounds like availability; SLO flags insufficient stores', () => {
  it('an object store meets an 11-nines durability SLO', () => {
    const instances: Instance[] = [
      client(100),
      { id: 's3', type: 'storage.object', bands: [{ key: keys.durability, band: { shape: 'minTargetMax', min: 0.999999999 } }] }, // 9 nines floor
    ];
    const built = instantiate(commonManifests, instances, [{ from: ['client', 'out'], to: ['s3', 'in'] }]);
    if (!built.ok) throw new Error('build failed');
    const r = evaluate(built.value, registry);
    if (!r.ok) throw new Error('eval failed');
    expect(r.value.value(NodeId('s3'), keys.durability)).toBeCloseTo(0.99999999999, 12);
    expect(r.value.verdicts.find((v) => v.scope === NodeId('s3') && v.key === keys.durability)?.status).toBe('ok');
  });

  it('Postgres (≈5 nines) fails an 11-nines durability SLO, blamed on itself', () => {
    const instances: Instance[] = [
      client(100),
      { id: 'app', type: 'compute.service' },
      { id: 'pg', type: 'db.postgres', bands: [{ key: keys.durability, band: { shape: 'minTargetMax', min: 0.99999999999 } }] }, // 11 nines floor
    ];
    const wires: Wire[] = [
      { from: ['client', 'out'], to: ['app', 'in'] },
      { from: ['app', 'db'], to: ['pg', 'in'] },
    ];
    const built = instantiate(commonManifests, instances, wires);
    if (!built.ok) throw new Error('build failed');
    const r = evaluate(built.value, registry);
    if (!r.ok) throw new Error('eval failed');
    const v = r.value.verdicts.find((x) => x.scope === NodeId('pg') && x.key === keys.durability);
    expect(v?.status).toBe('violation'); // 0.99999 < 0.99999999999
    expect(v?.cause.some((l) => l.scope === NodeId('pg'))).toBe(true);
  });
});

// GENERATE AT PORTS (doc: load-stages §4, §7, R1): the scalar pass NEVER reads the cycles. The generator's LEVEL
// is the BASELINE (ratified), so every scalar COST-facing read (pay-per-use = inflow × unit) bills the baseline
// unchanged whether or not a peaky cycle rides the generator — a shape never moves the scalar number. The honest
// mean-over-span bill and the peak-window capacity read are DERIVED (content: derivedMean / derivedPeak and the
// Tier-1 time-sweep costIntegral); the scalar stays the baseline, so cycles cannot silently rescale it.
describe('GENERATOR: the scalar cost reads the baseline level; the cycles are pure shape (load-stages §7)', () => {
  const EVENING_PEAK = [{ periodS: 86_400, stages: [{ durationS: 32_400, multiplier: 1.2 }, { durationS: 36_000, multiplier: 2.6 }] }];
  const costWith = (cycles?: { periodS: number; stages: { durationS: number; multiplier: number }[] }[]): number => {
    const instances: Instance[] = [
      { id: 'cron', type: 'compute.service', transforms: { db: { kind: 'generate', level: 1000, ...(cycles !== undefined ? { cycles } : {}) } }, config: { concurrency: 100000 } },
      { id: 'fn', type: 'compute.serverless' },
    ];
    // compute.service's db port speaks postgresql; serverless accepts events/https — wire via the generic out port instead.
    const wires: Wire[] = [{ from: ['cron', 'db'], to: ['fn', 'in'] }];
    const built = instantiate(commonManifests, instances, wires);
    if (!built.ok) throw new Error(`build failed: ${JSON.stringify(built.error)}`);
    const r = evaluate(built.value, registry);
    if (!r.ok) throw new Error('eval failed');
    // Cost is CUMULATIVE down the path (series 'sum'), so isolate the pay-per-use tier's OWN line: the terminal
    // total minus the generator host's own (concurrency-priced) cost.
    return (r.value.value(NodeId('fn'), keys.cost) ?? NaN) - (r.value.value(NodeId('cron'), keys.cost) ?? NaN);
  };

  it('a generator-driven pay-per-use tier bills level × unit — the baseline, with or without a peaky cycle', () => {
    const flat = costWith();
    expect(flat).toBe(500); // 1000 req/s × $0.5 per sustained req/s — the scalar reads the baseline level
    expect(costWith(EVENING_PEAK)).toBe(flat); // the cycles are pure shape: the scalar pass never reads them
  });
});
