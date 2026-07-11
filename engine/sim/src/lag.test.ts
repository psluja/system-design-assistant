import { describe, expect, it } from 'vitest';
import {
  mm1,
  RESPONSE_RESERVOIR_CAP,
  simulate,
  StationId,
  type PairLag,
  type QueueingNetwork,
  type RouteEdge,
  type SimOptions,
  type SimResult,
} from './index';

// FLOW-SCOPED LAG sampling (doc: latency-semantics-v2 §3): the wall-clock from a lineage's ARRIVAL at a declared
// SOURCE to its ARRIVAL at a declared TERMINAL, measured over the SAME single run — and INCLUDING every async queue
// wait on the way (the whole point of a CDC / replication SLO). These tests are the twin of the per-node response
// differentials (response.test.ts): the DES per-pair lag MEAN must track the analytic forward-transit sum (Burke's
// theorem — a stable M/M/1's departures are Poisson at the same rate, so each downstream tier is an independent
// M/M/1 on λ), the async wait must be INCLUDED (unlike the response cut), declaring a pair must leave every existing
// metric bit-for-bit identical (the disjoint-RNG discipline), results must be seed-deterministic, and a pair never
// reached must read NaN — honest `unknown`, never a fabricated number.

const rel = (got: number, want: number): number => Math.abs(got - want) / Math.abs(want);
const LONG: Pick<SimOptions, 'warmupCompletions' | 'measureCompletions'> = { warmupCompletions: 20000, measureCompletions: 200000 };

/** This run's lag stats for a declared pair (throws rather than silently skip — a missing pair is a test bug). */
function pl(r: SimResult, source: string, terminal: string): PairLag {
  const n = r.pairLag.find((x) => String(x.source) === source && String(x.terminal) === terminal);
  if (n === undefined) throw new Error(`no lag stats for pair '${source} → ${terminal}'`);
  return n;
}

/** A tandem a→b→c of single-server M/M/1 stations (every hop SYNCHRONOUS). */
function syncChain(lambda: number, mu: number): QueueingNetwork {
  const a = StationId('a');
  const b = StationId('b');
  const c = StationId('c');
  return {
    stations: [
      { id: a, service: { kind: 'exponential', rate: mu }, servers: 1 },
      { id: b, service: { kind: 'exponential', rate: mu }, servers: 1 },
      { id: c, service: { kind: 'exponential', rate: mu }, servers: 1 },
    ],
    arrivals: [{ at: a, interarrival: { kind: 'exponential', rate: lambda } }],
    routing: new Map<StationId, RouteEdge[]>([
      [a, [{ to: b, prob: 1 }]],
      [b, [{ to: c, prob: 1 }]],
    ]),
  };
}

describe('flow-scoped lag sampling — one run, per-pair journeys (doc: latency-semantics-v2 §3)', () => {
  it('(a) DIFFERENTIAL: a pair lag mean tracks the FORWARD-TRANSIT sum of the sojourns between source and terminal', () => {
    const lambda = 0.5;
    const mu = 1.0; // each tier: W = 1/(μ−λ) = 2 s; Burke ⇒ every tier sees Poisson(0.5)
    const w = mm1(lambda, mu).W; // 2
    const r = simulate(syncChain(lambda, mu), {
      seed: 12345,
      ...LONG,
      lagPairs: [
        { source: StationId('a'), terminal: StationId('c') },
        { source: StationId('a'), terminal: StationId('b') },
        { source: StationId('b'), terminal: StationId('c') },
      ],
    });
    // lag = time from source ARRIVAL to terminal ARRIVAL = Σ sojourns of every hop STRICTLY BEFORE the terminal
    // (the terminal's own sojourn is not yet incurred at its arrival). a→c ⇒ W_a + W_b; a→b ⇒ W_a; b→c ⇒ W_b.
    expect(rel(pl(r, 'a', 'c').mean, 2 * w)).toBeLessThan(0.06);
    expect(rel(pl(r, 'a', 'b').mean, w)).toBeLessThan(0.06);
    expect(rel(pl(r, 'b', 'c').mean, w)).toBeLessThan(0.06);
  });

  it('(b) ASYNC INCLUSION: an async queue wait is INCLUDED in lag but CUT from the caller response', () => {
    const lambda = 0.5;
    const mu = 1.0;
    const src = StationId('src');
    const q = StationId('q');
    const dest = StationId('dest');
    // src hands to q ASYNCHRONOUSLY (fire-and-forget); q → dest is synchronous. The lag from src to dest must span
    // q's full sojourn — the queue wait is the point of a replication SLO — while src's RESPONSE is cut at the async
    // hop, so it excludes q entirely. This is the core reason lag is a SEPARATE anchor from the node/response SLO.
    const net: QueueingNetwork = {
      stations: [
        { id: src, service: { kind: 'exponential', rate: mu }, servers: 1 },
        { id: q, service: { kind: 'exponential', rate: mu }, servers: 1 },
        { id: dest, service: { kind: 'exponential', rate: mu }, servers: 1 },
      ],
      arrivals: [{ at: src, interarrival: { kind: 'exponential', rate: lambda } }],
      routing: new Map<StationId, RouteEdge[]>([
        [src, [{ to: q, prob: 1, async: true }]],
        [q, [{ to: dest, prob: 1 }]],
      ]),
    };
    const r = simulate(net, {
      seed: 4242,
      ...LONG,
      lagPairs: [{ source: src, terminal: dest }],
    });
    const w = mm1(lambda, mu).W; // 2

    // lag(src → dest) INCLUDES the async q's wait: ≈ W_src + W_q (dest's own sojourn excluded, recorded at arrival).
    expect(rel(pl(r, 'src', 'dest').mean, 2 * w)).toBeLessThan(0.06);
    // The async branch is real in lag: it is well above the src response, which the async hop cuts to ≈ W_src.
    const srcResponse = r.nodeResponse.find((x) => String(x.id) === 'src')?.mean ?? NaN;
    expect(rel(srcResponse, w)).toBeLessThan(0.06); // response EXCLUDES the async queue
    expect(pl(r, 'src', 'dest').mean).toBeGreaterThan(srcResponse * 1.5); // lag INCLUDES it — meaningfully larger
  });

  it('(c) BYTE-IDENTICAL: declaring lag pairs perturbs NOTHING — sojourn, tail and every node response are unchanged', () => {
    const opts: SimOptions = { seed: 777, warmupCompletions: 8000, measureCompletions: 40000 };
    const plain = simulate(syncChain(0.6, 1), opts);
    const withLag = simulate(syncChain(0.6, 1), { ...opts, lagPairs: [{ source: StationId('a'), terminal: StationId('c') }] });
    // The lag sampler draws only from its OWN disjoint RNG stream, so the event order — and thus every existing
    // metric — is identical bit-for-bit to a run that declared no pair. (The R1 discipline, now extended to lag.)
    expect(withLag.meanSojourn).toBe(plain.meanSojourn);
    for (const p of [0.5, 0.95, 0.99]) expect(withLag.sojournPercentile(p)).toBe(plain.sojournPercentile(p));
    for (const id of ['a', 'b', 'c']) {
      const g = (r: SimResult): number => r.nodeResponse.find((x) => String(x.id) === id)?.mean ?? NaN;
      expect(g(withLag)).toBe(g(plain));
      for (const p of [0.5, 0.99]) expect(withLag.responsePercentile(StationId(id), p)).toBe(plain.responsePercentile(StationId(id), p));
    }
  });

  it('(d) DETERMINISM: same seed ⇒ identical per-pair lag mean, percentiles and sample count', () => {
    const opts: SimOptions = { seed: 42, warmupCompletions: 5000, measureCompletions: 20000, lagPairs: [{ source: StationId('a'), terminal: StationId('c') }] };
    const x = simulate(syncChain(0.6, 1), opts);
    const y = simulate(syncChain(0.6, 1), opts);
    expect(pl(y, 'a', 'c').mean).toBe(pl(x, 'a', 'c').mean);
    expect(pl(y, 'a', 'c').samples).toBe(pl(x, 'a', 'c').samples);
    for (const p of [0.5, 0.95, 0.99]) expect(y.lagPercentile(StationId('a'), StationId('c'), p)).toBe(x.lagPercentile(StationId('a'), StationId('c'), p));
  });

  it('(e) RESERVOIR BOUND: per-pair memory is capped even when lags vastly outnumber the cap', () => {
    const r = simulate(syncChain(0.7, 1), { seed: 5, warmupCompletions: 2000, measureCompletions: 50000, lagPairs: [{ source: StationId('a'), terminal: StationId('c') }] });
    expect(pl(r, 'a', 'c').samples).toBe(RESPONSE_RESERVOIR_CAP);
  });

  it('(f) a pair whose terminal is never reached from the source reads NaN — honest `unknown`', () => {
    // c → a is the WRONG direction (routing only flows a→b→c), so no lineage ever carries a c-stamp to a.
    const r = simulate(syncChain(0.5, 1), { seed: 1, ...LONG, lagPairs: [{ source: StationId('c'), terminal: StationId('a') }] });
    expect(pl(r, 'c', 'a').samples).toBe(0);
    expect(pl(r, 'c', 'a').mean).toBeNaN();
    expect(r.lagPercentile(StationId('c'), StationId('a'), 0.99)).toBeNaN();
    // an UNDECLARED pair is likewise NaN (never a fabricated number for a pair the caller did not ask about)
    expect(r.lagPercentile(StationId('a'), StationId('b'), 0.5)).toBeNaN();
  });

  it('(g) raising the async queue drain rate LOWERS the measured lag (the monotone sensitivity direction)', () => {
    const lambda = 0.5;
    const src = StationId('src');
    const q = StationId('q');
    const dest = StationId('dest');
    const net = (muQ: number): QueueingNetwork => ({
      stations: [
        { id: src, service: { kind: 'exponential', rate: 1 }, servers: 1 },
        { id: q, service: { kind: 'exponential', rate: muQ }, servers: 1 },
        { id: dest, service: { kind: 'exponential', rate: 1 }, servers: 1 },
      ],
      arrivals: [{ at: src, interarrival: { kind: 'exponential', rate: lambda } }],
      routing: new Map<StationId, RouteEdge[]>([
        [src, [{ to: q, prob: 1, async: true }]],
        [q, [{ to: dest, prob: 1 }]],
      ]),
    });
    const slow = simulate(net(0.75), { seed: 99, ...LONG, lagPairs: [{ source: src, terminal: dest }] }); // ρ_q = 0.67
    const fast = simulate(net(4.0), { seed: 99, ...LONG, lagPairs: [{ source: src, terminal: dest }] }); // ρ_q = 0.125
    // A faster drain empties the async queue's backlog, so a change spends less time queued ⇒ its lag falls.
    expect(pl(fast, 'src', 'dest').mean).toBeLessThan(pl(slow, 'src', 'dest').mean);
  });
});
