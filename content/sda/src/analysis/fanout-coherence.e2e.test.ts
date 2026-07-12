import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { evaluate, illegalEdges } from '@sda/engine-solve';
import { StationId, simulate } from '@sda/engine-sim';
import { instantiate, allManifests, registry, keys, toQueueingNetwork, type Instance, type Wire } from '../index';

// FAN-OUT COHERENCE (the "internal-inconsistency / never lies" charter). A service that calls BOTH a
// cache AND a database sends each request to BOTH downstreams — a FAN-OUT, not a load-balancer SPLIT. The
// forward/flow model already fans out (each downstream is offered the FULL served rate); the DES must agree. The
// bug this locks: content/sim.ts toQueueingNetwork once routed a node's N non-source outputs with prob = 1/N — a
// probabilistic 50/50 SPLIT — so adding a cache on a service's SECOND output secretly HALVED the database's
// simulated load, un-saturating it and dropping the DES tail ~7× while NOT ONE analytic metric moved. Two engines
// disagreeing about a fan-out node (a service in front of a cache AND a DB — a ubiquitous shape) is exactly the
// inconsistency the charter forbids. This test pins BOTH engines to the same answer, at the routing, analytic and
// discrete-event levels.

const SEED = 7;
const WARMUP = 20_000;
const MEASURE = 100_000;
const ORIGIN = 1600; // req/s the service originates; db.postgres caps at 2,000 ⇒ analytic ρ = 0.8 (loaded, stable)
const DB_CAPACITY = 2000; // db.postgres: concurrency 100 / (perRequestDuration 50 ms) = 2,000 req/s

// A client-less originating service (every node an origin) wired to a database on its `db` port. The `withCache`
// variant adds a SECOND downstream — a Redis cache on the service's `cache` port — the side branch whose 50/50
// split was the bug. Redis (100k op/s) is effectively unloaded, so under a correct FAN-OUT it steals nothing from
// the database; under the old SPLIT it would halve the database's simulated load.
const base: Instance[] = [
  { id: 'svc', type: 'compute.service', config: { assumedRps: ORIGIN } },
  { id: 'db', type: 'db.postgres' },
];
const dbWire: Wire = { from: ['svc', 'db'], to: ['db', 'in'] };
const cacheWire: Wire = { from: ['svc', 'cache'], to: ['cache', 'in'] };

const buildGraph = (instances: Instance[], wires: Wire[]) => {
  const built = instantiate(allManifests, instances, wires);
  if (!built.ok) throw new Error(`build failed: ${JSON.stringify(built.error)}`);
  return built.value;
};

const noCache = buildGraph(base, [dbWire]);
const withCache = buildGraph([...base, { id: 'cache', type: 'cache.redis' }], [dbWire, cacheWire]);

const dbUtilization = (graph: ReturnType<typeof buildGraph>): number => {
  const r = simulate(toQueueingNetwork(graph), { seed: SEED, warmupCompletions: WARMUP, measureCompletions: MEASURE });
  const db = r.stations.find((s) => s.id === StationId('db'));
  if (db === undefined) throw new Error('db station missing from the DES');
  return db.utilization;
};

const dbAnalytic = (graph: ReturnType<typeof buildGraph>): { throughput: number | undefined; overflow: number } => {
  const r = evaluate(graph, registry);
  if (!r.ok) throw new Error(r.error.join('; '));
  return {
    throughput: r.value.value(NodeId('db'), keys.throughput),
    overflow: r.value.value(NodeId('db'), keys.overflow) ?? 0,
  };
};

describe('fan-out coherence — a cache on a service’s second output must not secretly offload the database', () => {
  it('both wirings are protocol-legal (postgresql on the db hop, resp on the cache hop)', () => {
    expect(illegalEdges(noCache, [])).toEqual([]);
    expect(illegalEdges(withCache, [])).toEqual([]);
  });

  it('the DES routes the service to BOTH downstreams with prob 1 (fan-out), never a 1/N split', () => {
    const svcRoutes = toQueueingNetwork(withCache).routing.get(StationId('svc')) ?? [];
    expect(new Set(svcRoutes.map((e) => String(e.to)))).toEqual(new Set(['db', 'cache']));
    // THE root cause: every fan-out edge carries the FULL rate (prob 1), not a 1/N probabilistic split.
    expect(svcRoutes.every((e) => e.prob === 1)).toBe(true);
  });

  it('ANALYTIC: the database is offered the full origin rate — adding the cache moves no analytic metric', () => {
    const a = dbAnalytic(noCache);
    const b = dbAnalytic(withCache);
    expect(a.throughput).toBe(ORIGIN); // 1,600 ≤ 2,000 capacity ⇒ served in full
    expect(a.overflow).toBeCloseTo(0, 6);
    expect(b.throughput).toBe(a.throughput); // the side branch offloads NOTHING (fan-out, not split)
    expect(b.overflow).toBeCloseTo(a.overflow, 6);
  });

  it('DES ⇄ ANALYTIC: the simulated database load equals the analytic ρ and the cache does NOT halve it', () => {
    const rho = ORIGIN / DB_CAPACITY; // 0.8 — the analytic utilisation the DES must reproduce
    const utilNoCache = dbUtilization(noCache);
    const utilWithCache = dbUtilization(withCache);

    // the DES agrees with the analytic engine that the database is ~80% busy (NOT the old 50/50 bug's ~40%)...
    expect(utilNoCache).toBeCloseTo(rho, 1);
    // ...and adding the cache side branch leaves that load essentially unchanged (fan-out, not a probabilistic split).
    expect(utilWithCache).toBeCloseTo(rho, 1);
    expect(Math.abs(utilWithCache - utilNoCache)).toBeLessThan(0.1);
  });
});
