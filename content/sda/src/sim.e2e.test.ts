import { describe, expect, it } from 'vitest';
import { StationId, simulate } from '@sda/engine-sim';
import { instantiate, manifests, toQueueingNetwork, type Instance, type Wire } from './index';

const rel = (got: number, want: number): number => Math.abs(got - want) / Math.abs(want);

// The TIME engine on the SAME content design. Algebraically the chain's latency is 63 ms (sum of
// means) and throughput "fits" (compute capacity 1200 > 1000 demand) — but that hides the TAIL. With
// compute at concurrency 60 (ρ = 1000 / (60·20) ≈ 0.83) the DES exposes the queueing the algebra
// cannot: a real p99 well above the mean. This is exactly why the simulator is a separate engine.
describe('content pack ⇄ time engine (DES tail latency)', () => {
  const instances: Instance[] = [
    { id: 'client', type: 'client.source' },
    { id: 'gw', type: 'gateway.api' },
    { id: 'compute', type: 'compute.faas', config: { concurrency: 60 } },
    { id: 'db', type: 'db.sql' },
  ];
  const wires: Wire[] = [
    { from: ['client', 'out'], to: ['gw', 'in'] },
    { from: ['gw', 'out'], to: ['compute', 'in'] },
    { from: ['compute', 'out'], to: ['db', 'in'] },
  ];

  it('simulates the chain: compute utilization, Little, and a tail the algebra misses', () => {
    const built = instantiate(manifests, instances, wires);
    if (!built.ok) throw new Error('graph build failed');
    const net = toQueueingNetwork(built.value);

    const r = simulate(net, { seed: 7, warmupCompletions: 20000, measureCompletions: 100000 });

    // throughput is demand-driven (≈ 1000 req/s) and Little's law holds end-to-end
    expect(rel(r.departureRate, 1000)).toBeLessThan(0.05);
    expect(rel(r.meanNumberInSystem, r.departureRate * r.meanSojourn)).toBeLessThan(0.03);

    // the capacity-limited tier is ~83% busy; the delay tiers (gw, db) never saturate
    const compute = r.stations.find((s) => s.id === StationId('compute'));
    expect(compute?.utilization).toBeCloseTo(0.83, 1);

    // THE POINT: a real tail. p99 > p50, and the mean sojourn exceeds the 63 ms of pure service time.
    expect(r.sojournPercentile(0.99)).toBeGreaterThan(r.sojournPercentile(0.5));
    expect(r.meanSojourn).toBeGreaterThan(0.063);
  });
});
