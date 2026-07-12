import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { evaluate, type Evaluation } from '@sda/engine-solve';
import { simulate } from '@sda/engine-sim';
import { instantiate, allManifests, registry, keys, toQueueingNetwork, type Instance, type Wire } from '../index';

// AWS RDS Proxy (proxy.rds): a pass-through hop whose CAPACITY emerges from its connection pool
// (Little's law: pool/heldMs), with the pool-pressure band and the per-target-vCPU price. Sourced values
// live in the manifest; these tests pin the algebra end-to-end on a real chain.

const W = (a: string, ap: string, b: string, bp: string): Wire => ({ from: [a, ap], to: [b, bp] });

function build(insts: Instance[], wires: Wire[]): Evaluation {
  const g = instantiate(allManifests, insts, wires);
  if (!g.ok) throw new Error(`build error: ${JSON.stringify(g.error)}`);
  const r = evaluate(g.value, registry);
  if (!r.ok) throw new Error(`eval error: ${r.error.join('; ')}`);
  return r.value;
}
const at = (e: Evaluation, id: string, k: typeof keys.throughput): number | undefined => e.value(NodeId(id), k);
const verdictFor = (e: Evaluation, id: string, k: typeof keys.throughput) =>
  e.verdicts.find((v) => String(v.scope) === id && String(v.key) === String(k));

const chain = (rps: number): Evaluation =>
  build(
    [
      { id: 'client', type: 'client.web', config: { throughput: rps } },
      { id: 'app', type: 'compute.service', config: { concurrency: 1000 } },
      { id: 'proxy', type: 'proxy.rds' },
      { id: 'pg', type: 'db.postgres' },
    ],
    [W('client', 'out', 'app', 'in'), W('app', 'db', 'proxy', 'in'), W('proxy', 'out', 'pg', 'in')],
  );

describe('proxy.rds — the pooled pass-through', () => {
  it('wires legally between a service db port and postgres, and evaluates', () => {
    expect(() => chain(100)).not.toThrow();
  });

  it('capacity emerges from the pool: 100 connections / 30 ms held cap a saturating load at ~3,333 req/s', () => {
    // `throughput` merges as min(capacity, offered): at 100 rps the node shows the OFFERED 100; push 5,000
    // and the pool-derived ceiling binds — the served rate is pool/held = 3,333, not the offer.
    expect(at(chain(100), 'proxy', keys.throughput)).toBeCloseTo(100, 5);
    expect(at(chain(5000), 'proxy', keys.throughput)).toBeCloseTo(100 / 0.03, 0);
  });

  it('pool pressure at 100 rps × 30 ms = 3 connections — inside the pool (overflow 0, band ok)', () => {
    const e = chain(100);
    expect(at(e, 'proxy', keys.poolConnectionsNeeded)).toBeCloseTo(3, 5);
    expect(at(e, 'proxy', keys.poolOverflow)).toBe(0);
    expect(verdictFor(e, 'proxy', keys.poolOverflow)?.status).toBe('ok');
  });

  it('a saturating load overflows the pool and the band flags the violation', () => {
    // 5,000 rps × 30 ms → 150 connections against a pool of 100 → overflow 50.
    const e = chain(5000);
    expect(at(e, 'proxy', keys.poolOverflow)).toBeGreaterThan(0);
    expect(verdictFor(e, 'proxy', keys.poolOverflow)?.status).toBe('violation');
  });

  it('price follows the sourced per-target-vCPU rate: the 2-vCPU minimum × $10.95 ≈ $21.9/mo', () => {
    // `cost` accumulates along the path — the proxy's OWN price is the step from the node before it.
    const e = chain(100);
    const own = (at(e, 'proxy', keys.cost) ?? NaN) - (at(e, 'app', keys.cost) ?? NaN);
    expect(own).toBeCloseTo(2 * 10.95, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// CONNECTION BORROW TIMEOUT — the DES twin of the scalar poolOverflow. The
// proxy's connection pool IS an M/M/c station in the time engine: c = `connectionPool` slots, each held for
// `connectionHeldMs`, so its capacity pool/held matches the scalar `throughput` (they agree). Under pool pressure
// the borrow queue's wait exceeds `maxQueueWaitMs` (default the sourced 120 s `ConnectionBorrowTimeout`) and
// requests renege — a station-side FAILURE (proxy `dropped` + system `errorRate`). This is the SAME story the
// scalar `poolOverflow` violation tells, now unfolding over time. Both mechanisms must agree at their own scale.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A proxy chain whose pool + borrow timeout are overridable, so the test can drive it into (and out of) pool
// pressure on a FAST-reaching borrow queue. The app + pg tiers are generous (huge concurrency) so the PROXY POOL
// is the sole bottleneck. `borrowMs` overrides the sourced 120 s default only to keep the run short — the exact
// 120 s number is pinned separately, on the manifest, below.
function poolChain(rps: number, pool: number, heldMs: number, borrowMs: number): ReturnType<typeof instantiate> {
  return instantiate(
    allManifests,
    [
      { id: 'client', type: 'client.web', config: { throughput: rps } },
      { id: 'app', type: 'compute.service', config: { concurrency: 100000, perRequestDuration: 1, latency: 1 } },
      { id: 'proxy', type: 'proxy.rds', config: { connectionPool: pool, connectionHeldMs: heldMs, maxQueueWaitMs: borrowMs } },
      { id: 'pg', type: 'db.postgres', config: { concurrency: 100000, perRequestDuration: 1 } },
    ],
    [W('client', 'out', 'app', 'in'), W('app', 'db', 'proxy', 'in'), W('proxy', 'out', 'pg', 'in')],
  );
}
const proxyDrops = (g: ReturnType<typeof instantiate>, seed: number): { dropped: number; errorRate: number; goodputRps: number } => {
  if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
  const sim = simulate(toQueueingNetwork(g.value), { seed, warmupCompletions: 20000, measureCompletions: 80000 });
  const proxy = sim.stations.find((s) => String(s.id) === 'proxy');
  return { dropped: proxy?.dropped ?? 0, errorRate: sim.errorRate, goodputRps: sim.goodputRps };
};

describe('proxy.rds — connection-borrow-timeout reneging (DES)', () => {
  it('ships the sourced 120 s ConnectionBorrowTimeout, wired onto an M/M/pool station (not a pure delay)', () => {
    // The manifest carries the real default: ConnectionBorrowTimeout = 120 s (120,000 ms). The FAST-run tests below
    // override it purely to keep simulated time short; this pins the shipped number so the coverage claim is honest.
    const borrow = allManifests['proxy.rds']?.config?.find((c) => String(c.key) === String(keys.maxQueueWaitMs));
    expect(borrow?.value).toBe(120000);
    // And the DES projector carries it onto the proxy's station (ms, unchanged) and — critically — makes the proxy
    // a FINITE-server M/M/pool station (c = the 100-connection pool, μ = 1/held) rather than the pure-delay hop it
    // is without a deadline. Only then can its borrow queue actually build a wait that exceeds the timeout.
    const inst = instantiate(
      allManifests,
      [
        { id: 'client', type: 'client.web', config: { throughput: 100 } },
        { id: 'app', type: 'compute.service', config: { concurrency: 1000 } },
        { id: 'proxy', type: 'proxy.rds' },
        { id: 'pg', type: 'db.postgres' },
      ],
      [W('client', 'out', 'app', 'in'), W('app', 'db', 'proxy', 'in'), W('proxy', 'out', 'pg', 'in')],
    );
    if (!inst.ok) throw new Error('build failed');
    const proxyStation = toQueueingNetwork(inst.value).stations.find((s) => String(s.id) === 'proxy');
    expect(proxyStation?.maxQueueWaitMs).toBe(120000);
    expect(proxyStation?.servers).toBe(100); // c = the pool (M/M/100), NOT PURE_DELAY
  });

  it('a SATURATED pool renegess: offered × held ≫ pool ⇒ proxy drops > 0 and errorRate > 0', () => {
    // pool 10, held 30 ms ⇒ capacity ≈ 333 req/s. Offer 3,000 req/s (ρ ≈ 9): the borrow queue's wait blows past the
    // borrow timeout and requests time out AT THE PROXY. A short 300 ms timeout keeps the run fast; the physics is
    // the sourced one (a wait past ConnectionBorrowTimeout is an error).
    const sat = proxyDrops(poolChain(3000, 10, 30, 300), 424242);
    expect(sat.dropped).toBeGreaterThan(0); // requests reneged AT the proxy (borrow timeout)
    expect(sat.errorRate).toBeGreaterThan(0); // and they surface as system failures (no caller retry ⇒ terminal)
    // Goodput is capped at the pool capacity (~333 req/s): the borrow timeout can never manufacture throughput.
    expect(sat.goodputRps).toBeLessThan(333 * 1.15);
  });

  it('WITHIN the pool: offered × held < pool ⇒ ZERO proxy drops (the borrow queue never forms)', () => {
    // pool 100, held 30 ms ⇒ capacity ≈ 3,333 req/s. Offer 500 req/s (ρ ≈ 0.15): every borrow is satisfied at once,
    // so no wait, no renege — the healthy design sheds nothing even with the borrow timeout armed.
    const ok = proxyDrops(poolChain(500, 100, 30, 300), 424242);
    expect(ok.dropped).toBe(0);
    expect(ok.errorRate).toBe(0);
  });

  it('scalar poolOverflow tells the SAME story at its own time-scale (both mechanisms agree)', () => {
    // The DES-saturated design (3,000 req/s into a pool-10/30 ms proxy) is ALSO a scalar poolOverflow violation:
    // needed = 3,000 × 0.03 = 90 connections against a pool of 10 ⇒ overflow 80. The forward pass and the DES both
    // flag the pressure — the scalar as an instantaneous budget breach, the DES as a timeout wave over time.
    const g = poolChain(3000, 10, 30, 120000);
    if (!g.ok) throw new Error('build failed');
    const e = evaluate(g.value, registry);
    if (!e.ok) throw new Error(`eval failed: ${e.error.join('; ')}`);
    expect(at(e.value, 'proxy', keys.poolOverflow)).toBeGreaterThan(0);
    expect(verdictFor(e.value, 'proxy', keys.poolOverflow)?.status).toBe('violation');
  });
});
