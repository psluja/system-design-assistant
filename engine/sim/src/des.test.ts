import { describe, expect, it } from 'vitest';
import { mg1MeanWait, mm1, mmc, simulate, StationId, type QueueingNetwork, type SimOptions } from './index';

const rel = (got: number, want: number): number => Math.abs(got - want) / Math.abs(want);

function mm1Network(lambda: number, mu: number): QueueingNetwork {
  const s = StationId('s');
  return {
    stations: [{ id: s, service: { kind: 'exponential', rate: mu }, servers: 1 }],
    arrivals: [{ at: s, interarrival: { kind: 'exponential', rate: lambda } }],
    routing: new Map(),
  };
}

const LONG: Pick<SimOptions, 'warmupCompletions' | 'measureCompletions'> = {
  warmupCompletions: 20000,
  measureCompletions: 200000,
};

describe('discrete-event simulator vs closed-form queueing models', () => {
  it('reproduces M/M/1 (ρ=0.8) within tolerance and Little’s law holds', () => {
    const lambda = 0.8;
    const mu = 1.0;
    const r = simulate(mm1Network(lambda, mu), { seed: 12345, ...LONG });
    const a = mm1(lambda, mu); // ρ=0.8, L=4, W=5

    expect(r.stations[0]?.utilization).toBeCloseTo(a.rho, 1); // ~0.8
    expect(rel(r.meanNumberInSystem, a.L)).toBeLessThan(0.05);
    expect(rel(r.meanSojourn, a.W)).toBeLessThan(0.05);
    expect(rel(r.departureRate, lambda)).toBeLessThan(0.03);
    // Little's law on the simulation's OWN measured quantities: L = λ_eff · W.
    expect(rel(r.meanNumberInSystem, r.departureRate * r.meanSojourn)).toBeLessThan(0.02);
    // a real tail, ordered and positive
    expect(r.sojournPercentile(0.99)).toBeGreaterThan(r.sojournPercentile(0.5));
    expect(r.sojournPercentile(0.5)).toBeGreaterThan(0);
  });

  it('reproduces M/M/c (3 servers, ρ=0.8) within tolerance — the multi-server queue', () => {
    const servers = 3;
    const mu = 1.0; // per-server rate
    const lambda = 0.8 * servers * mu; // ρ = λ/(cμ) = 0.8 ⇒ λ = 2.4
    const s = StationId('s');
    const net: QueueingNetwork = {
      stations: [{ id: s, service: { kind: 'exponential', rate: mu }, servers }],
      arrivals: [{ at: s, interarrival: { kind: 'exponential', rate: lambda } }],
      routing: new Map(),
    };
    const r = simulate(net, { seed: 9001, ...LONG });
    const a = mmc(lambda, mu, servers);

    expect(r.stations[0]?.utilization).toBeCloseTo(a.rho, 1); // ~0.8 busy fraction per server
    expect(rel(r.meanSojourn, a.W)).toBeLessThan(0.05);
    expect(rel(r.meanNumberInSystem, a.L)).toBeLessThan(0.06);
    // c servers absorb load far better than one: M/M/3 sojourn is well below the M/M/1-at-same-ρ sojourn.
    expect(a.W).toBeLessThan(mm1(0.8, 1.0).W);
  });

  it('mmc(c=1) reduces exactly to M/M/1', () => {
    const one = mmc(0.7, 1.0, 1);
    const base = mm1(0.7, 1.0);
    expect(one.W).toBeCloseTo(base.W, 10);
    expect(one.Wq).toBeCloseTo(base.Wq, 10);
    expect(one.rho).toBeCloseTo(base.rho, 10);
  });

  it('M/M/c is honest about instability: ρ ≥ 1 ⇒ Infinity, never a throw', () => {
    expect(mmc(5, 1.0, 3).W).toBe(Infinity); // λ=5 > cμ=3
    expect(mmc(3, 1.0, 3).W).toBe(Infinity); // λ=cμ exactly ⇒ unstable
  });

  it('reproduces M/D/1 (deterministic service) via Pollaczek–Khinchine', () => {
    const lambda = 0.8;
    const serviceMean = 1.0; // μ=1, ρ=0.8
    const s = StationId('s');
    const net: QueueingNetwork = {
      stations: [{ id: s, service: { kind: 'deterministic', value: serviceMean }, servers: 1 }],
      arrivals: [{ at: s, interarrival: { kind: 'exponential', rate: lambda } }],
      routing: new Map(),
    };
    const r = simulate(net, { seed: 777, ...LONG });
    const Wq = mg1MeanWait(lambda, serviceMean, 0); // SCV=0 ⇒ 2.0
    const W = Wq + serviceMean; // 3.0
    const L = lambda * W; // 2.4

    expect(rel(r.meanSojourn, W)).toBeLessThan(0.05);
    expect(rel(r.meanNumberInSystem, L)).toBeLessThan(0.06);
    // deterministic service halves the wait vs exponential — proves it is not Markov-only
    expect(r.meanSojourn).toBeLessThan(mm1(lambda, 1.0).W);
  });

  it('a tandem network (routing) satisfies Little’s law end-to-end', () => {
    const a = StationId('a');
    const b = StationId('b');
    const net: QueueingNetwork = {
      stations: [
        { id: a, service: { kind: 'exponential', rate: 1.0 }, servers: 1 },
        { id: b, service: { kind: 'exponential', rate: 1.0 }, servers: 1 },
      ],
      arrivals: [{ at: a, interarrival: { kind: 'exponential', rate: 0.5 } }],
      routing: new Map([[a, [{ to: b, prob: 1 }]]]),
    };
    const r = simulate(net, { seed: 2024, warmupCompletions: 20000, measureCompletions: 150000 });

    expect(rel(r.meanNumberInSystem, r.departureRate * r.meanSojourn)).toBeLessThan(0.02);
    expect(rel(r.meanSojourn, 4)).toBeLessThan(0.06); // two M/M/1 in series, each W=2
    expect(r.stations[0]?.utilization).toBeCloseTo(0.5, 1);
    expect(r.stations[1]?.utilization).toBeCloseTo(0.5, 1);
  });

  it('FAN-OUT: a node feeding two downstreams sends the FULL rate to EACH (not a 50/50 split)', () => {
    const a = StationId('a');
    const b = StationId('b');
    const c = StationId('c');
    // a (fast hub) fans out to b (slow tier) AND c (fast cache). With fan-out, b and c EACH receive a's full
    // departure rate (~0.8). A 50/50 split would halve it (b would see 0.4) — this test distinguishes the two.
    const net: QueueingNetwork = {
      stations: [
        { id: a, service: { kind: 'exponential', rate: 10 }, servers: 1 },
        { id: b, service: { kind: 'exponential', rate: 1.0 }, servers: 1 },
        { id: c, service: { kind: 'exponential', rate: 10 }, servers: 1 },
      ],
      arrivals: [{ at: a, interarrival: { kind: 'exponential', rate: 0.8 } }],
      routing: new Map([[a, [{ to: b, prob: 1 }, { to: c, prob: 1 }]]]), // prob 1 each ⇒ fan-out
    };
    const r = simulate(net, { seed: 31337, ...LONG });
    const util = (id: StationId): number => r.stations.find((s) => s.id === id)?.utilization ?? -1;

    expect(util(b)).toBeCloseTo(0.8, 1); // FULL rate (ρ≈0.8) — a 50/50 split would give ≈0.4 and fail here
    expect(util(c)).toBeCloseTo(0.08, 1); // 0.8 / 10
    // a request joins at its SLOWEST fork (b), so the end-to-end sojourn is dominated by the loaded b tier
    // (≈ a's 0.1 + b's M/M/1 sojourn 1/(1−0.8)=5 ≈ 5.1) — NOT halved by the fast cache c (a split would give ≈1).
    expect(r.meanSojourn).toBeGreaterThan(3);
  });

  it('is deterministic: same seed ⇒ byte-identical metrics', () => {
    const opts: SimOptions = { seed: 42, warmupCompletions: 5000, measureCompletions: 20000 };
    const x = simulate(mm1Network(0.7, 1.0), opts);
    const y = simulate(mm1Network(0.7, 1.0), opts);
    expect(y.meanSojourn).toBe(x.meanSojourn);
    expect(y.meanNumberInSystem).toBe(x.meanNumberInSystem);
    expect(y.departureRate).toBe(x.departureRate);
    expect(y.sojournPercentile(0.99)).toBe(x.sojournPercentile(0.99));
  });
});
