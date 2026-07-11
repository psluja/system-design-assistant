import { describe, expect, it } from 'vitest';
import {
  mm1,
  mmc,
  RESPONSE_RESERVOIR_CAP,
  simulate,
  StationId,
  type NodeResponse,
  type QueueingNetwork,
  type RouteEdge,
  type SimOptions,
  type SimResult,
} from './index';

// Per-node RESPONSE sampling (doc: latency-semantics-v2 §4): every station reports the response from its OWN
// perspective — the clock from a job's arrival there to the completion of its SYNCHRONOUS subtree — from the SAME
// single run. These tests are the twin of the existing DES-vs-closed-form differentials (des.test.ts): the DES
// per-node response MEAN must track the analytic sojourn(+synchronous-downstream sum), the entry node's response
// distribution must equal the end-to-end sojourn, an async hop must be cut, results must be seed-deterministic,
// and memory must stay bounded. The analytic oracle uses Burke's theorem — the departure process of a stable
// M/M/c queue is Poisson at the same rate, so each downstream tier of a tandem is an independent M/M/c on λ.

const rel = (got: number, want: number): number => Math.abs(got - want) / Math.abs(want);
const LONG: Pick<SimOptions, 'warmupCompletions' | 'measureCompletions'> = { warmupCompletions: 20000, measureCompletions: 200000 };

/** This run's response stats for a station (throws rather than silently skip — a missing node is a test bug). */
function nr(r: SimResult, id: string): NodeResponse {
  const n = r.nodeResponse.find((x) => String(x.id) === id);
  if (n === undefined) throw new Error(`no response stats for station '${id}'`);
  return n;
}

/** A tandem A→B→C of single-server M/M/1 stations, every hop SYNCHRONOUS (the caller waits for what it calls). */
function syncChain(lambda: number, muA: number, muB: number, muC: number): QueueingNetwork {
  const a = StationId('a');
  const b = StationId('b');
  const c = StationId('c');
  return {
    stations: [
      { id: a, service: { kind: 'exponential', rate: muA }, servers: 1 },
      { id: b, service: { kind: 'exponential', rate: muB }, servers: 1 },
      { id: c, service: { kind: 'exponential', rate: muC }, servers: 1 },
    ],
    arrivals: [{ at: a, interarrival: { kind: 'exponential', rate: lambda } }],
    routing: new Map<StationId, RouteEdge[]>([
      [a, [{ to: b, prob: 1 }]],
      [b, [{ to: c, prob: 1 }]],
    ]),
  };
}

describe('per-node response sampling — one run, N perspectives (doc: latency-semantics-v2 §4)', () => {
  it('(a) DIFFERENTIAL: each node response mean tracks its M/M/1 sojourn + its synchronous downstream sum', () => {
    const lambda = 0.5;
    const mu = 1.0; // each tier: W = 1/(μ−λ) = 2 s; Burke ⇒ every tier sees Poisson(0.5)
    const r = simulate(syncChain(lambda, mu, mu, mu), { seed: 12345, ...LONG });
    const w = mm1(lambda, mu).W; // 2

    expect(rel(nr(r, 'c').mean, w)).toBeLessThan(0.06); // leaf: its own sojourn only
    expect(rel(nr(r, 'b').mean, 2 * w)).toBeLessThan(0.06); // b waits for c ⇒ W_b + W_c
    expect(rel(nr(r, 'a').mean, 3 * w)).toBeLessThan(0.06); // a waits for b→c ⇒ W_a + W_b + W_c
  });

  it('(a) DIFFERENTIAL: a multi-server node reports its own M/M/c sojourn, plus a synchronous downstream tier', () => {
    const mu = 1.0;
    const servers = 3;
    const lambda = 0.8 * servers * mu; // 2.4 ⇒ ρ_A = 0.8 at the M/M/3 head
    const muB = 3.0; // ρ_B = 2.4/3 = 0.8 at the M/M/1 tail (Burke: it sees Poisson(2.4))
    const a = StationId('a');
    const b = StationId('b');
    const net: QueueingNetwork = {
      stations: [
        { id: a, service: { kind: 'exponential', rate: mu }, servers },
        { id: b, service: { kind: 'exponential', rate: muB }, servers: 1 },
      ],
      arrivals: [{ at: a, interarrival: { kind: 'exponential', rate: lambda } }],
      routing: new Map<StationId, RouteEdge[]>([[a, [{ to: b, prob: 1 }]]]),
    };
    const r = simulate(net, { seed: 24680, ...LONG });
    const wA = mmc(lambda, mu, servers).W; // ≈ 2.079
    const wB = mm1(lambda, muB).W; // ≈ 1.667

    expect(rel(nr(r, 'b').mean, wB)).toBeLessThan(0.06);
    expect(rel(nr(r, 'a').mean, wA + wB)).toBeLessThan(0.06); // M/M/c sojourn + synchronous downstream sum
  });

  it('(b) IDENTITY: at the entry node of a pure synchronous chain, response ≈ end-to-end sojourn (same distribution)', () => {
    const r = simulate(syncChain(0.5, 1, 1, 1), { seed: 2024, ...LONG });
    // The entry node's synchronous subtree IS the whole request, so per-job its response equals the sojourn; the
    // only gap is sampling (a bounded reservoir vs the full sojourn array). Percentiles agree within tolerance.
    expect(rel(r.responsePercentile(StationId('a'), 0.5), r.sojournPercentile(0.5))).toBeLessThan(0.05);
    expect(rel(r.responsePercentile(StationId('a'), 0.95), r.sojournPercentile(0.95))).toBeLessThan(0.06);
    expect(rel(r.responsePercentile(StationId('a'), 0.99), r.sojournPercentile(0.99))).toBeLessThan(0.08);
    expect(rel(nr(r, 'a').mean, r.meanSojourn)).toBeLessThan(0.02);
  });

  it('(b) IDENTITY inherits TRUE fork-join: a parallel-branch node response equals the max-based end-to-end, not a serial sum', () => {
    const a = StationId('a');
    const b = StationId('b');
    const c = StationId('c');
    // a fans out SYNCHRONOUSLY to a SLOW b and a FAST c; the request (and a's response) join on the slower branch.
    // Because a node's view is a suffix of the REAL journey, its response is the wall-clock max — no serial-sum lie.
    const net: QueueingNetwork = {
      stations: [
        { id: a, service: { kind: 'exponential', rate: 10 }, servers: 1 },
        { id: b, service: { kind: 'exponential', rate: 1.0 }, servers: 1 },
        { id: c, service: { kind: 'exponential', rate: 10 }, servers: 1 },
      ],
      arrivals: [{ at: a, interarrival: { kind: 'exponential', rate: 0.8 } }],
      routing: new Map<StationId, RouteEdge[]>([[a, [{ to: b, prob: 1 }, { to: c, prob: 1 }]]]),
    };
    const r = simulate(net, { seed: 31337, ...LONG });

    expect(rel(nr(r, 'a').mean, r.meanSojourn)).toBeLessThan(0.02); // a (entry, all sync) response = end-to-end
    expect(nr(r, 'a').mean).toBeGreaterThan(nr(r, 'b').mean); // = own_a + max(b,c) > the b branch alone
  });

  it('(c) ASYNC CUT: an async hop is EXCLUDED from the caller response but INCLUDED in end-to-end', () => {
    const lambda = 0.5;
    const muA = 1.0;
    const muQ = 1.0;
    const a = StationId('a');
    const q = StationId('q');
    // a hands to q ASYNCHRONOUSLY (fire-and-forget). a's caller does not block on q, so a's response excludes it;
    // q begins a fresh perspective; the whole-system sojourn still includes q (the request joins when q exits).
    const net: QueueingNetwork = {
      stations: [
        { id: a, service: { kind: 'exponential', rate: muA }, servers: 1 },
        { id: q, service: { kind: 'exponential', rate: muQ }, servers: 1 },
      ],
      arrivals: [{ at: a, interarrival: { kind: 'exponential', rate: lambda } }],
      routing: new Map<StationId, RouteEdge[]>([[a, [{ to: q, prob: 1, async: true }]]]),
    };
    const r = simulate(net, { seed: 4242, ...LONG });
    const wA = mm1(lambda, muA).W; // 2
    const wQ = mm1(lambda, muQ).W; // 2

    expect(rel(nr(r, 'a').mean, wA)).toBeLessThan(0.06); // a EXCLUDES the async queue: ≈ W_A, not W_A + W_Q
    expect(rel(nr(r, 'q').mean, wQ)).toBeLessThan(0.06); // q is a fresh root: ≈ W_Q
    expect(rel(r.meanSojourn, wA + wQ)).toBeLessThan(0.06); // end-to-end INCLUDES the async branch
    expect(nr(r, 'a').mean).toBeLessThan(r.meanSojourn * 0.7); // the cut is real: a is well below end-to-end
  });

  it('(d) DETERMINISM: same seed ⇒ identical per-node response percentiles, mean and sample count', () => {
    const opts: SimOptions = { seed: 42, warmupCompletions: 5000, measureCompletions: 20000 };
    const x = simulate(syncChain(0.6, 1, 1, 1), opts);
    const y = simulate(syncChain(0.6, 1, 1, 1), opts);
    for (const id of ['a', 'b', 'c']) {
      for (const p of [0.5, 0.95, 0.99]) {
        expect(y.responsePercentile(StationId(id), p)).toBe(x.responsePercentile(StationId(id), p));
      }
      expect(nr(y, id).mean).toBe(nr(x, id).mean);
      expect(nr(y, id).samples).toBe(nr(x, id).samples);
    }
  });

  it('(e) RESERVOIR BOUND: memory is capped even when responses vastly outnumber the cap', () => {
    // 50k measured requests ⇒ ~50k responses per node, far past the 8192 cap ⇒ every reservoir fills to exactly it.
    const r = simulate(syncChain(0.7, 1, 1, 1), { seed: 5, warmupCompletions: 2000, measureCompletions: 50000 });
    for (const id of ['a', 'b', 'c']) {
      expect(nr(r, id).samples).toBeLessThanOrEqual(RESPONSE_RESERVOIR_CAP);
      expect(nr(r, id).samples).toBe(RESPONSE_RESERVOIR_CAP);
    }
  });

  it('a node that has produced no response reads NaN — honest `unknown`, never a fabricated number', () => {
    const r = simulate(syncChain(0.5, 1, 1, 1), { seed: 1, ...LONG });
    expect(r.responsePercentile(StationId('does-not-exist'), 0.99)).toBeNaN();
  });
});
