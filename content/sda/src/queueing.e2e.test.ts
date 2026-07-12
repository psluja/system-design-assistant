import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { simulate } from '@sda/engine-sim';
import { instantiate, manifests, commonManifests, registry, keys, nodeQueues, toQueueingNetwork, type Instance, type Wire } from './index';

const rel = (got: number, want: number): number => Math.abs(got - want) / Math.abs(want);

// The analytic (hot-path) queueing-aware latency must AGREE with the DES on the SAME real content design —
// it is the cheap twin that lets the canvas/footer show the real latency live without simulating every edit.
describe('queueing-aware latency (analytic) ⇄ the DES', () => {
  // client → faas: c servers, 50 ms service ⇒ capacity = c / 0.05 rps; offered = 0.8 · capacity ⇒ ρ = 0.8.
  const built = (concurrency: number, offered: number): ReturnType<typeof instantiate> => {
    const instances: Instance[] = [
      { id: 'client', type: 'client.source', config: { throughput: offered } },
      { id: 'svc', type: 'compute.faas', config: { concurrency, perRequestDuration: 50, latency: 50 } },
    ];
    const wires: Wire[] = [{ from: ['client', 'out'], to: ['svc', 'in'] }];
    return instantiate(manifests, instances, wires);
  };
  const svcQueue = (g: Parameters<typeof nodeQueues>[0]) => {
    const r = evaluate(g, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    return nodeQueues(g, (id, k) => r.value.value(NodeId(id), k)).get('svc')!;
  };

  it('matches the DES at ρ=0.8 for BOTH a single server (large queue) and a 10-server pool (small queue)', () => {
    for (const [c, offered, minInflate] of [[1, 16, 4], [10, 160, 1.1]] as const) {
      const g = built(c, offered);
      if (!g.ok) throw new Error('build failed');
      const svc = svcQueue(g.value);
      expect(svc.rho).toBeCloseTo(0.8, 2);
      const sim = simulate(toQueueingNetwork(g.value), { seed: 4242, warmupCompletions: 20000, measureCompletions: 200000 });
      // client is a load source (no station) ⇒ the end-to-end DES sojourn IS the one station's sojourn.
      expect(rel(svc.sojournMs, sim.meanSojourn * 1000)).toBeLessThan(0.07);
      // the queue inflates the real latency above the no-queue ideal — far more with one server than with ten.
      expect(svc.sojournMs).toBeGreaterThan(svc.serviceMs * minInflate);
    }
  });

  it('is honest about saturation: offered ≥ capacity ⇒ unbounded (Infinity), not a finite lie', () => {
    const g = built(10, 400); // 400 > capacity 200 ⇒ ρ = 2
    if (!g.ok) throw new Error('build failed');
    const svc = svcQueue(g.value);
    expect(svc.rho).toBeGreaterThanOrEqual(1);
    expect(svc.sojournMs).toBe(Infinity);
  });
});

// utilisation ρ must be honest for a FIXED-THROUGHPUT tier too (a component with NO concurrency
// knob — cache, gateway, db.sql…). Its real capacity is its DECLARED throughput ceiling, not c·μ with
// c=PURE_DELAY (which made ρ≈0 even AT the ceiling — "the tool must not lie"). The M/M/c tiers above are
// unaffected: they still read c·μ.
describe('utilisation ρ of a fixed-throughput tier (no concurrency config)', () => {
  // Feed `offered` rps into one fixed-throughput target and read back its ρ. The forward-pass `value` is
  // stubbed so the feeder delivers EXACTLY `offered` to the target (decoupled from upstream arithmetic).
  const rhoAt = (target: 'gateway.api' | 'db.cheap', offered: number): number => {
    const instances: Instance[] = [
      { id: 'src', type: 'client.source', config: { throughput: offered } },
      { id: 'node', type: target },
    ];
    const wires: Wire[] = [{ from: ['src', 'out'], to: ['node', 'in'] }];
    const g = instantiate(manifests, instances, wires);
    if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
    return nodeQueues(g.value, (id, k) => (id === 'src' && k === keys.throughput ? offered : undefined)).get('node')!.rho;
  };

  it('reports ρ≈1 at the rated ceiling (gateway.api 10000 req/s; db.cheap 1000 req/s) — NOT ρ≈0', () => {
    expect(rhoAt('gateway.api', 10000)).toBeCloseTo(1, 5);
    expect(rhoAt('db.cheap', 1000)).toBeCloseTo(1, 5);
  });

  it('reports the right fraction below the ceiling', () => {
    expect(rhoAt('gateway.api', 5000)).toBeCloseTo(0.5, 5); // 5000 / 10000
    expect(rhoAt('db.cheap', 250)).toBeCloseTo(0.25, 5); //  250 / 1000
  });

  it('is honest about saturation: offered above the ceiling ⇒ ρ ≥ 1', () => {
    expect(rhoAt('db.cheap', 1500)).toBeGreaterThan(1); // 1500 > 1000 ceiling
  });
});

// A REPLICATED / demand-sized fleet serves `concurrency` slots PER unit across `replicas`/`maxUnits` units, so its
// queueing capacity is concurrency × the fleet size. Without this the queue model shows a perfectly-sized fleet as
// SATURATED (compare/Improve would then recommend a design its own verdict flags as ∞-latency). Analytic ⇄ DES.
describe('a replicated/demand-sized fleet: capacity scales with the fleet count', () => {
  it('models concurrency × replicas servers — a 2-replica fleet is healthy where 1 replica would saturate', () => {
    const instances: Instance[] = [
      { id: 'client', type: 'client.web', config: { throughput: 3200 } },
      { id: 'svc', type: 'compute.replicated', config: { concurrency: 50, perRequestDuration: 25, replicas: 2 } },
    ];
    const wires: Wire[] = [{ from: ['client', 'out'], to: ['svc', 'in'] }];
    const g = instantiate({ ...manifests, ...commonManifests }, instances, wires);
    if (!g.ok) throw new Error('build failed');
    const r = evaluate(g.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    const q = nodeQueues(g.value, (id, k) => r.value.value(NodeId(id), k)).get('svc')!;
    // per unit: 50 / 0.025 s = 2000 rps; × 2 replicas = 4000 rps capacity; offered 3200 ⇒ ρ = 0.8 (one replica ⇒ 1.6).
    expect(q.rho).toBeCloseTo(0.8, 2);
    expect(q.sojournMs).toBeLessThan(Infinity);
    const sim = simulate(toQueueingNetwork(g.value), { seed: 4242, warmupCompletions: 20000, measureCompletions: 200000 });
    expect(rel(q.sojournMs, sim.meanSojourn * 1000)).toBeLessThan(0.1); // the analytic fleet model agrees with the DES
  });

  it('a maxUnits fleet (fargate) likewise: capacity = concurrency × maxUnits', () => {
    const instances: Instance[] = [
      { id: 'client', type: 'client.web', config: { throughput: 5000 } },
      { id: 'svc', type: 'compute.fargate', config: { concurrency: 80, perRequestDuration: 25, maxUnits: 2 } },
    ];
    const wires: Wire[] = [{ from: ['client', 'out'], to: ['svc', 'in'] }];
    const g = instantiate({ ...manifests, ...commonManifests }, instances, wires);
    if (!g.ok) throw new Error('build failed');
    const r = evaluate(g.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    const q = nodeQueues(g.value, (id, k) => r.value.value(NodeId(id), k)).get('svc')!;
    // per unit: 80 / 0.025 = 3200 rps; × 2 = 6400 rps; offered 5000 ⇒ ρ ≈ 0.78, NOT the 1.5625 a single unit would show.
    expect(q.rho).toBeCloseTo(0.78, 2);
    expect(q.sojournMs).toBeLessThan(Infinity);
  });
});

// CALIBRATION #3 — a POOLED datastore (no `concurrency`, but a `connectionPool` + `connectionHeldMs`) must QUEUE in
// the ANALYTIC twin exactly as it already does in the DES: c = the pool slots, μ = 1/held, so c·μ = pool/held EQUALS
// its throughput ceiling (capacity unmoved) and its Erlang-C wait now inflates with load. Before this, the analytic
// modelled it as PURE_DELAY (flat sojourn), so the canvas showed rising ρ but not queue-inflated latency — the DES
// and the analytic disagreed at the very tier that saturates. This pins that the two engines now AGREE on a pooled
// store (the differential discipline), reading the SAME pool primitives through the shared graph-read `queueStation`.
describe('a pooled datastore queues in the analytic twin ⇄ the DES (calibration #3)', () => {
  const dbQueue = (g: Parameters<typeof nodeQueues>[0]) => {
    const r = evaluate(g, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    return nodeQueues(g, (id, k) => r.value.value(NodeId(id), k)).get('db')!;
  };
  // db.cheap: pool 12 · held 12 ms ⇒ M/M/12, c·μ = 12 / 12 ms = 1000 req/s == its declared throughput ceiling.
  const built = (offered: number): ReturnType<typeof instantiate> =>
    instantiate(
      manifests,
      [
        { id: 'client', type: 'client.source', config: { throughput: offered } },
        { id: 'db', type: 'db.cheap' },
      ],
      [{ from: ['client', 'out'], to: ['db', 'in'] }],
    );

  it('analytic ρ + Erlang-C wait track the DES at ρ≈0.8 (c = the pool, capacity = the throughput ceiling)', () => {
    const g = built(800); // 800 / 1000 ceiling ⇒ ρ = 0.8
    if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
    const db = dbQueue(g.value);
    expect(db.servers).toBe(12); // c = the pool slots, NOT PURE_DELAY (it forms a real M/M/12)
    expect(db.capacity).toBeCloseTo(1000, 5); // = pool/held = the declared throughput ceiling (byte-identical scalar)
    expect(db.rho).toBeCloseTo(0.8, 2);
    expect(db.sojournMs).toBeGreaterThan(db.serviceMs); // the queue inflates the real latency above the flat 12 ms
    expect(db.sojournMs).toBeLessThan(Infinity);
    // AGREES with the DES on the same design — the client is a zero-service passthrough, so the end-to-end DES
    // sojourn IS the datastore's M/M/12 sojourn (the same Erlang-C the analytic computes).
    const sim = simulate(toQueueingNetwork(g.value), { seed: 4242, warmupCompletions: 20000, measureCompletions: 200000 });
    expect(rel(db.sojournMs, sim.meanSojourn * 1000)).toBeLessThan(0.1);
  });

  it('is honest about saturation: offered ≥ the pool ceiling ⇒ unbounded (Infinity), not a flat lie', () => {
    const g = built(1500); // 1500 > 1000 ceiling ⇒ ρ = 1.5
    if (!g.ok) throw new Error('build failed');
    const db = dbQueue(g.value);
    expect(db.rho).toBeGreaterThanOrEqual(1);
    expect(db.sojournMs).toBe(Infinity);
  });
});

// CALIBRATION residual #1 — a datastore QUERY TIMEOUT past saturation. Reusing the SAME station wait-deadline the
// RDS-Proxy borrow timeout uses (one-form-per-kind: a wait deadline before reneging), a datastore that declares
// `maxQueueWaitMs` renegess a query whose wait for a pooled connection exceeds it, so past capacity the pool queue
// no longer grows unbounded — requests DROP (goodput collapses, errorRate > 0) instead of an ever-growing,
// window-dependent tail. Pure config: the DES projector already carries `maxQueueWaitMs` onto the pool station.
// Default (no deadline declared) = today, byte-for-byte: an unbounded queue and ZERO drops.
describe('datastore query timeout (maxQueueWaitMs) — bounded drops past saturation (calibration residual #1)', () => {
  const drive = (rps: number, queryTimeoutMs: number, seed: number): { dropped: number; errorRate: number; goodputRps: number } => {
    const g = instantiate(
      manifests,
      [
        { id: 'client', type: 'client.source', config: { throughput: rps } },
        { id: 'db', type: 'db.cheap', config: queryTimeoutMs > 0 ? { maxQueueWaitMs: queryTimeoutMs } : {} },
      ],
      [{ from: ['client', 'out'], to: ['db', 'in'] }],
    );
    if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
    const sim = simulate(toQueueingNetwork(g.value), { seed, warmupCompletions: 8000, measureCompletions: 25000 });
    const db = sim.stations.find((s) => String(s.id) === 'db');
    return { dropped: db?.dropped ?? 0, errorRate: sim.errorRate, goodputRps: sim.goodputRps };
  };

  it('WITH a query timeout: a saturating load (2× the ceiling) renegess ⇒ drops > 0, errorRate > 0, goodput capped', () => {
    const sat = drive(2000, 400, 20259); // 2000 rps into the 1000-req/s pool (ρ ≈ 2); 400 ms query timeout
    expect(sat.dropped).toBeGreaterThan(0); // queries reneged AT the datastore (query timeout)
    expect(sat.errorRate).toBeGreaterThan(0); // and surfaced as system failures (no caller retry ⇒ terminal)
    expect(sat.goodputRps).toBeLessThan(1000 * 1.15); // the timeout can never manufacture throughput past capacity
  });

  it('DEFAULT (no query timeout) is byte-identical to today: the pool queue is unbounded, ZERO drops', () => {
    const sat = drive(2000, 0, 20259);
    expect(sat.dropped).toBe(0);
    expect(sat.errorRate).toBe(0);
  });
});
