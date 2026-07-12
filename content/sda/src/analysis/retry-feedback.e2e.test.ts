import { describe, expect, it } from 'vitest';
import { evaluate } from '@sda/engine-solve';
import { simulate } from '@sda/engine-sim';
import {
  checkGoodputBands,
  instantiate,
  keys,
  allManifests,
  registry,
  toQueueingNetwork,
  type Instance,
  type SimOutcome,
  type Wire,
} from '../index';

// ───────────────────────────────────────────────────────────────────────────────────────────────────────
// RETRY FEEDBACK & GOODPUT COLLAPSE — end-to-end on REAL content. The engine-level DES
// primitives (engine/sim/retry.test) are wired through the content projector here: a client's three retry
// knobs (timeoutMs / retryCount / retryBackoffMs) become an attemptPolicy on the traffic it originates, and
// the sim's goodput/error/amplification feed verdicts. Two laws:
//   1. THE HUMP on a 3-tier chain — sweep the offered load past a tier's capacity WITH a retry policy: goodput
//      collapses (per-request goodput at 1.2× < the served rate at 0.8×), amplification grows, errors appear.
//   2. NO POLICY ⇒ UNCHANGED — a chain with no retry keys reads exactly as before (pinned numbers): goodput ==
//      completion rate, error rate 0, amplification 1 — the pre-retry world, bit-for-bit.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

// A 3-tier chain: client → gateway → service (the bottleneck) → db. The SERVICE tier is the constraint: one
// server, 100 ms/request ⇒ capacity 10 req/s. `retry` toggles the caller's retry policy (on the client, which
// originates the traffic). `offered` is the client's req/s.
function chain(offered: number, retry: boolean): ReturnType<typeof instantiate> {
  const retryCfg = retry ? { timeoutMs: 250, retryCount: 3, retryBackoffMs: 20 } : {};
  const instances: Instance[] = [
    { id: 'client', type: 'client.source', config: { throughput: offered, ...retryCfg } },
    // gateway + db are generous (high concurrency, tiny service) so the SERVICE tier is the sole bottleneck.
    { id: 'gw', type: 'compute.service', config: { concurrency: 1000, perRequestDuration: 2, latency: 2 } },
    { id: 'svc', type: 'compute.service', config: { concurrency: 1, perRequestDuration: 100, latency: 100 } }, // cap = 10 req/s
    { id: 'db', type: 'compute.service', config: { concurrency: 1000, perRequestDuration: 2, latency: 2 } },
  ];
  const wires: Wire[] = [
    { from: ['client', 'out'], to: ['gw', 'in'] },
    { from: ['gw', 'out'], to: ['svc', 'in'] },
    { from: ['svc', 'out'], to: ['db', 'in'] },
  ];
  return instantiate(allManifests, instances, wires);
}

function runSim(offered: number, retry: boolean): SimOutcome & { amplification: number; departureRate: number } {
  const g = chain(offered, retry);
  if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
  const sim = simulate(toQueueingNetwork(g.value), { seed: 76076, warmupCompletions: 8000, measureCompletions: 40000 });
  return { goodputRps: sim.goodputRps, errorRate: sim.errorRate, amplification: sim.amplification, departureRate: sim.departureRate };
}

describe('retry feedback e2e — the hump curve on a 3-tier chain', () => {
  const SVC_CAP = 10; // req/s (1 server · 100 ms)

  it('goodput COLLAPSES past saturation, amplification grows, errors appear — retries never help', () => {
    // Sweep the offered load past the service tier's capacity, WITH the retry policy on the client.
    const over12 = runSim(1.2 * SVC_CAP, true); // 12 req/s into a 10 req/s tier
    const over15 = runSim(1.5 * SVC_CAP, true); // 15 req/s into a 10 req/s tier
    // The SAME overload WITHOUT retries — the honest UPPER bound (the tier serves ≈ capacity, ~10 req/s).
    const noRetry12 = runSim(1.2 * SVC_CAP, false);

    // THE HUMP — the model may NEVER claim retries help a saturated system: goodput WITH retries is strictly
    // below the no-retry served rate at the SAME offered load (the retry work is wasted, competing for the tier).
    expect(over12.goodputRps).toBeLessThan(noRetry12.departureRate);
    // And goodput can never exceed the service tier's ~10 req/s capacity, no matter how many retries fly.
    expect(over12.goodputRps).toBeLessThan(SVC_CAP * 1.05);

    // Amplification > 1 (retries add attempts) and GROWS deeper into overload (more timeouts ⇒ more retries).
    expect(over12.amplification).toBeGreaterThan(1);
    expect(over15.amplification).toBeGreaterThan(over12.amplification);

    // Past saturation, real FAILURES appear (retries exhausted) — the honest error metric, non-zero; the no-retry
    // run at the same load fails NOTHING (it just serves at capacity and the excess never enters — no error key).
    expect(over12.errorRate).toBeGreaterThan(0);
    expect(over15.errorRate).toBeGreaterThan(0);
    expect(noRetry12.errorRate).toBe(0);
  });

  it('a goodputRps FLOOR SLO reads unknown off the scalar pass, then a real verdict from the sim', () => {
    // The architect sets a goodput floor of 12 req/s on the terminal (db) node. The service tier caps goodput at
    // ~10 req/s under overload, so the floor is BREACHED — but only the sim can see it.
    const g = chain(1.5 * SVC_CAP, true);
    if (!g.ok) throw new Error('build failed');
    // Attach the SLO band by hand (mirrors set_slo{key:'goodputRps', min}). instantiate takes config, not bands,
    // so we evaluate then check: with no sim, the band is unknown; with the sim, it is answered.
    const withSlo = instantiate(
      allManifests,
      [
        { id: 'client', type: 'client.source', config: { throughput: 1.5 * SVC_CAP, timeoutMs: 250, retryCount: 3, retryBackoffMs: 20 } },
        { id: 'gw', type: 'compute.service', config: { concurrency: 1000, perRequestDuration: 2, latency: 2 } },
        { id: 'svc', type: 'compute.service', config: { concurrency: 1, perRequestDuration: 100, latency: 100 } },
        {
          id: 'db',
          type: 'compute.service',
          config: { concurrency: 1000, perRequestDuration: 2, latency: 2 },
          bands: [{ key: keys.goodputRps, band: { shape: 'minTargetMax', min: 12 } }],
        },
      ] as Instance[],
      [
        { from: ['client', 'out'], to: ['gw', 'in'] },
        { from: ['gw', 'out'], to: ['svc', 'in'] },
        { from: ['svc', 'out'], to: ['db', 'in'] },
      ],
    );
    if (!withSlo.ok) throw new Error(`build failed: ${JSON.stringify(withSlo.error)}`);

    // 1. The scalar pass produces NO value for goodputRps (derived, no relation) ⇒ evaluate leaves it unfilled;
    //    checkGoodputBands with no sim ⇒ the band is `unknown` (pointing at simulate).
    const ev = evaluate(withSlo.value, registry);
    expect(ev.ok).toBe(true);
    const noSim = checkGoodputBands(withSlo.value, undefined);
    const gpNoSim = noSim.find((v) => String(v.key) === String(keys.goodputRps) && String(v.scope) === 'db');
    expect(gpNoSim?.status).toBe('unknown');

    // 2. The sim answers it: goodput is ~10 < the 12 floor ⇒ a real VIOLATION.
    const sim = simulate(toQueueingNetwork(withSlo.value), { seed: 76076, warmupCompletions: 8000, measureCompletions: 40000 });
    const withSim = checkGoodputBands(withSlo.value, { goodputRps: sim.goodputRps, errorRate: sim.errorRate });
    const gp = withSim.find((v) => String(v.key) === String(keys.goodputRps) && String(v.scope) === 'db');
    expect(gp?.status).toBe('violation');
    expect(gp?.computed.value).toBeLessThan(12);
    expect(gp?.remediations.length).toBeGreaterThan(0);
  });
});

describe('retry feedback e2e — a chain with NO retry policy is unchanged (pinned)', () => {
  it('goodput == completion rate, errorRate 0, amplification 1 — the pre-retry world, bit-for-bit', () => {
    // Well below capacity (5 req/s vs 10 req/s cap) ⇒ a stable chain, no drops, no retries even if allowed.
    const g = chain(5, false);
    if (!g.ok) throw new Error('build failed');
    const sim = simulate(toQueueingNetwork(g.value), { seed: 76076, warmupCompletions: 8000, measureCompletions: 40000 });

    expect(sim.amplification).toBe(1); // exactly one attempt per arrival — no policy
    expect(sim.errorRate).toBe(0); // nothing fails
    expect(sim.goodputRps).toBe(sim.departureRate); // every completion is goodput
    // The served rate tracks the offered load (a stable, sub-saturation chain).
    expect(sim.departureRate).toBeGreaterThan(4.7);
    expect(sim.departureRate).toBeLessThan(5.3);

    // checkGoodputBands finds NOTHING to judge (no goodput/error SLO set) ⇒ no spurious verdicts.
    expect(checkGoodputBands(g.value, { goodputRps: sim.goodputRps, errorRate: sim.errorRate })).toHaveLength(0);
  });

  it('an INERT policy (timeoutMs=0) leaves the sim identical to no policy', () => {
    const noPolicy = chain(5, false);
    const inert = instantiate(
      allManifests,
      [
        { id: 'client', type: 'client.source', config: { throughput: 5, timeoutMs: 0, retryCount: 5, retryBackoffMs: 100 } },
        { id: 'gw', type: 'compute.service', config: { concurrency: 1000, perRequestDuration: 2, latency: 2 } },
        { id: 'svc', type: 'compute.service', config: { concurrency: 1, perRequestDuration: 100, latency: 100 } },
        { id: 'db', type: 'compute.service', config: { concurrency: 1000, perRequestDuration: 2, latency: 2 } },
      ] as Instance[],
      [
        { from: ['client', 'out'], to: ['gw', 'in'] },
        { from: ['gw', 'out'], to: ['svc', 'in'] },
        { from: ['svc', 'out'], to: ['db', 'in'] },
      ],
    );
    if (!noPolicy.ok || !inert.ok) throw new Error('build failed');
    const opts = { seed: 76076, warmupCompletions: 8000, measureCompletions: 40000 } as const;
    const a = simulate(toQueueingNetwork(noPolicy.value), opts);
    const b = simulate(toQueueingNetwork(inert.value), opts);
    expect(b.departureRate).toBe(a.departureRate); // timeoutMs=0 ⇒ no attemptPolicy ⇒ byte-identical
    expect(b.goodputRps).toBe(a.goodputRps);
    expect(b.amplification).toBe(1);
  });
});
