import { describe, expect, it } from 'vitest';
import { mulberry32 } from './rng';
import type { Distribution } from './distribution';
import { simulate, StationId, type ArrivalSource, type QueueingNetwork, type RouteEdge, type SimOptions } from './index';

// ---------------------------------------------------------------------------------------------------------------
// Retry feedback & goodput collapse (doc: retry-feedback). Three things to pin down:
//   1. absent policy ≡ today, bit-for-bit (the determinism contract must not shift for existing networks);
//   2. the RENEGING primitive matches Erlang-A (M/M/c + exponential abandonment) — the theory anchor;
//   3. the HUMP property — past saturation, retries LOWER goodput and amplify load (never "help").
// ---------------------------------------------------------------------------------------------------------------

const rel = (got: number, want: number): number => Math.abs(got - want) / Math.abs(want);

/** A pseudo-random open network (varied topology, service rates, servers, fan-out) — the property-test generator. */
function randomNetwork(seed: number): QueueingNetwork {
  const rng = mulberry32(seed);
  const nStations = 2 + Math.floor(rng.next() * 4); // 2..5 stations
  const ids = Array.from({ length: nStations }, (_, i) => StationId(`s${i}`));
  const stations = ids.map((id) => ({
    id,
    service: { kind: 'exponential', rate: 0.5 + rng.next() * 3 } as Distribution,
    servers: 1 + Math.floor(rng.next() * 3),
  }));
  const routing = new Map<StationId, RouteEdge[]>();
  for (let i = 0; i < nStations - 1; i++) {
    // each station may route onward to a later station (a DAG — no cycles ⇒ always drains)
    if (rng.next() < 0.75) {
      const to = ids[i + 1 + Math.floor(rng.next() * (nStations - 1 - i))] as StationId;
      routing.set(ids[i] as StationId, [{ to, prob: 0.5 + rng.next() * 0.5 }]);
    }
  }
  const arrivals: ArrivalSource[] = [{ at: ids[0] as StationId, interarrival: { kind: 'exponential', rate: 0.3 + rng.next() } }];
  return { stations, arrivals, routing };
}

describe('retry feedback — absent policy is bit-for-bit today (property)', () => {
  it('no attemptPolicy ⇒ identical results to the pre-retry engine, on many random networks + seeds', () => {
    for (let s = 0; s < 25; s++) {
      const net = randomNetwork(s);
      const opts: SimOptions = { seed: 1000 + s, warmupCompletions: 2000, measureCompletions: 8000 };
      const a = simulate(net, opts);
      const b = simulate(net, opts);
      // Determinism holds AND the new outcome accounting degenerates to the pre-retry world.
      expect(b.meanSojourn).toBe(a.meanSojourn);
      expect(b.departureRate).toBe(a.departureRate);
      expect(b.sojournPercentile(0.99)).toBe(a.sojournPercentile(0.99));
      expect(a.goodputRps).toBe(a.departureRate); // every completion is goodput when nothing renegess
      expect(a.errorRate).toBe(0); // no failures without a policy
      expect(a.amplification).toBe(1); // one attempt per arrival
    }
  });

  it('an INERT policy (timeoutMs=0) is byte-identical to no policy at all', () => {
    const s = StationId('s');
    const base: QueueingNetwork = {
      stations: [{ id: s, service: { kind: 'exponential', rate: 1 }, servers: 1 }],
      arrivals: [{ at: s, interarrival: { kind: 'exponential', rate: 0.8 } }],
      routing: new Map(),
    };
    const withInert: QueueingNetwork = {
      ...base,
      arrivals: [{ at: s, interarrival: { kind: 'exponential', rate: 0.8 }, attemptPolicy: { timeoutMs: 0, retries: 5, backoffMs: 100 } }],
    };
    const opts: SimOptions = { seed: 42, warmupCompletions: 5000, measureCompletions: 20000 };
    const a = simulate(base, opts);
    const b = simulate(withInert, opts);
    expect(b.meanSojourn).toBe(a.meanSojourn);
    expect(b.departureRate).toBe(a.departureRate);
    expect(b.sojournPercentile(0.99)).toBe(a.sojournPercentile(0.99));
    expect(b.goodputRps).toBe(a.goodputRps);
    expect(b.amplification).toBe(1);
  });
});

// -------------------- Erlang-A (M/M/c+M) reference, computed independently in the test --------------------
// The M/M/c+M stationary distribution is a birth–death chain: birth rate λ in every state; death rate nμ for
// n ≤ c servers busy, and cμ + (n−c)θ once a queue forms (each of the (n−c) waiting customers renegess at rate
// θ = 1/mean-patience). We solve it by the standard forward recursion p_{n+1} = p_n · λ / d_{n+1}, truncated
// far into the tail (θ guarantees the queue is positive-recurrent for ANY load — abandonment always stabilises
// it), then read the abandonment probability P_ab = θ·E[Lq]/λ = (rate customers renege) / (rate they arrive).
// This is a simulation-INDEPENDENT numeric method: the exact Erlang-A answer up to a negligible truncation.
function erlangAAbandonProb(lambda: number, mu: number, c: number, theta: number): number {
  const N = 20000; // truncation; θ > 0 makes tail mass vanish geometrically, so this is exact to machine noise
  const death = (n: number): number => (n <= c ? n * mu : c * mu + (n - c) * theta);
  const p: number[] = [1]; // unnormalised p_0 = 1
  for (let n = 1; n <= N; n++) p[n] = (p[n - 1] as number) * (lambda / death(n));
  let Z = 0;
  for (let n = 0; n <= N; n++) Z += p[n] as number;
  let ELq = 0; // expected queue length (customers waiting, i.e. beyond the c servers)
  for (let n = c + 1; n <= N; n++) ELq += (n - c) * (p[n] as number);
  ELq /= Z;
  return (theta * ELq) / lambda; // Little's law on the abandoning stream
}

describe('retry feedback — RENEGING matches Erlang-A (M/M/c + exponential patience)', () => {
  // HONEST SCOPE OF THIS DIFFERENTIAL: Erlang-A assumes EXPONENTIAL patience; a production timeout is a FIXED
  // deadline (deterministic patience). The two are DIFFERENT abandonment processes. So we validate the DES's
  // reneging MECHANISM by driving it with an exponential patience clock (the `patience` override on the arrival
  // source) and comparing to the Erlang-A closed form. With retries=0 every renege is a terminal failure, so the
  // DES `errorRate / offered-λ` is exactly the abandonment probability. Deterministic-timeout fidelity is then
  // covered by the hump property below (no closed form; the qualitative law that must hold).
  const cases: ReadonlyArray<{ lambda: number; mu: number; c: number; theta: number }> = [
    { lambda: 3.0, mu: 1.0, c: 2, theta: 0.5 }, // ρ=1.5 (overloaded) — abandonment is the only thing that stabilises it
    { lambda: 2.4, mu: 1.0, c: 2, theta: 1.0 }, // ρ=1.2 (overloaded), faster giving-up
    { lambda: 1.8, mu: 1.0, c: 2, theta: 0.5 }, // ρ=0.9 (loaded but sub-saturation) — modest abandonment
  ];

  for (const { lambda, mu, c, theta } of cases) {
    it(`abandonment prob ≈ Erlang-A at λ=${lambda}, μ=${mu}, c=${c}, θ=${theta}`, () => {
      const s = StationId('s');
      const net: QueueingNetwork = {
        stations: [{ id: s, service: { kind: 'exponential', rate: mu }, servers: c }],
        arrivals: [
          {
            at: s,
            interarrival: { kind: 'exponential', rate: lambda },
            // exponential patience (mean 1/θ) with retries=0 ⇒ a renege is a terminal failure we can count
            attemptPolicy: { timeoutMs: 1, retries: 0, backoffMs: 0 }, // timeoutMs>0 only arms the clock; `patience` sets it
            patience: { kind: 'exponential', rate: theta },
          },
        ],
        routing: new Map(),
      };
      const r = simulate(net, { seed: 20260703, warmupCompletions: 20000, measureCompletions: 200000 });
      const offered = lambda; // arrivals/s (each original arrival makes exactly one attempt: retries=0)
      const desAbandon = r.errorRate / offered; // failures/s ÷ offered/s = P(abandon)
      const ref = erlangAAbandonProb(lambda, mu, c, theta);
      expect(ref).toBeGreaterThan(0.01); // the reference is a meaningful, non-degenerate probability
      // CI tolerance: DES sampling noise over a finite window. 8% relative is comfortable at these counts.
      expect(rel(desAbandon, ref)).toBeLessThan(0.08);
      // The un-abandoned fraction is exactly the goodput fraction (retries=0): a second, independent cross-check.
      expect(rel(r.goodputRps / offered, 1 - ref)).toBeLessThan(0.05);
    });
  }

  it('exponential patience with retries=0 makes an OVERLOADED single-server queue stable & honest', () => {
    // ρ=2 with NO abandonment would be unstable (∞). With patience the queue self-limits: goodput < capacity,
    // the rest fails, and amplification stays 1 (retries=0). Proves reneging alone bounds an overloaded system.
    const s = StationId('s');
    const net: QueueingNetwork = {
      stations: [{ id: s, service: { kind: 'exponential', rate: 1 }, servers: 1 }],
      arrivals: [
        {
          at: s,
          interarrival: { kind: 'exponential', rate: 2 }, // ρ=2
          attemptPolicy: { timeoutMs: 1, retries: 0, backoffMs: 0 },
          patience: { kind: 'exponential', rate: 1 },
        },
      ],
      routing: new Map(),
    };
    const r = simulate(net, { seed: 7, warmupCompletions: 20000, measureCompletions: 200000 });
    expect(r.goodputRps).toBeGreaterThan(0);
    expect(r.goodputRps).toBeLessThan(1.0001); // cannot exceed the μ=1 server capacity
    expect(r.errorRate).toBeGreaterThan(0); // the excess offered load fails
    expect(r.amplification).toBeCloseTo(1, 5); // retries=0 ⇒ exactly one attempt each
  });
});

describe('retry feedback — THE HUMP: retries never help a saturated system', () => {
  // A single overloaded server with a SHORT deterministic timeout and 2 retries. The model must show the
  // congestion-collapse hump: goodput STRICTLY below the served rate a no-retry run achieves at the same offered
  // load, and amplification > 1 (retries are extra load attacking an already-saturated tier).
  function oneStation(rho: number, withRetries: boolean): QueueingNetwork {
    const s = StationId('s');
    const mu = 1;
    const lambda = rho * mu; // offered load as a multiple of capacity
    const policy = withRetries ? { attemptPolicy: { timeoutMs: 800, retries: 2, backoffMs: 50 } } : {};
    return {
      stations: [{ id: s, service: { kind: 'exponential', rate: mu }, servers: 1 }],
      arrivals: [{ at: s, interarrival: { kind: 'exponential', rate: lambda }, ...policy }],
      routing: new Map(),
    };
  }

  for (const rho of [1.2, 1.5]) {
    it(`ρ=${rho}: goodput WITH retries < served rate WITHOUT, and amplification > 1`, () => {
      const opts: SimOptions = { seed: 999, warmupCompletions: 10000, measureCompletions: 60000 };
      // Baseline: no retries. Past saturation the server serves ≈ capacity (μ=1) — the honest UPPER bound.
      const noRetry = simulate(oneStation(rho, false), opts);
      // With retries: reneging + re-injection. Goodput must fall BELOW the no-retry served rate.
      const retry = simulate(oneStation(rho, true), opts);

      expect(retry.goodputRps).toBeLessThan(noRetry.departureRate); // the model NEVER claims retries help
      expect(retry.amplification).toBeGreaterThan(1); // retries add load (attempts ÷ arrivals > 1)
      expect(retry.errorRate).toBeGreaterThan(0); // and past saturation, real failures appear
      // Goodput is still bounded by the single server's capacity — retries cannot manufacture throughput.
      expect(retry.goodputRps).toBeLessThan(1.05);
    });
  }

  it('amplification GROWS as the system gets more saturated (deeper overload ⇒ more retry traffic)', () => {
    const opts: SimOptions = { seed: 555, warmupCompletions: 10000, measureCompletions: 60000 };
    const mild = simulate(oneStation(1.2, true), opts);
    const heavy = simulate(oneStation(1.6, true), opts);
    expect(heavy.amplification).toBeGreaterThan(mild.amplification);
  });
});

describe('station wait deadline (maxQueueWaitMs) — the borrow-timeout primitive', () => {
  // A STATION-level wait deadline is distinct from the caller's per-attempt timeout: it is armed on queue-JOIN at
  // THIS station and disarmed on service start (the RDS-Proxy connection-borrow timeout). An abandon here is a
  // FAILURE attributed to the station (its `dropped`), and — absent a caller policy — a terminal request failure.

  const opts: SimOptions = { seed: 314159, warmupCompletions: 8000, measureCompletions: 40000 };
  // A single-server station, μ=1, offered ρ=2 (overloaded) so a borrow queue forms and waits grow without bound.
  function overloaded(maxQueueWaitMs?: number): QueueingNetwork {
    const s = StationId('s');
    return {
      stations: [{ id: s, service: { kind: 'exponential', rate: 1 }, servers: 1, ...(maxQueueWaitMs !== undefined ? { maxQueueWaitMs } : {}) }],
      arrivals: [{ at: s, interarrival: { kind: 'exponential', rate: 2 } }], // ρ=2, NO caller policy
      routing: new Map(),
    };
  }

  it('absent field ≡ today, bit-for-bit (a station with no deadline is identical to before) — property', () => {
    // Same generator as the policy property test, and additionally with a deadline field left undefined: the new
    // machinery must be perfectly inert. `overloaded()` (no deadline) is the unbounded-queue baseline.
    for (let s = 0; s < 25; s++) {
      const net = randomNetwork(s); // never sets maxQueueWaitMs
      const o: SimOptions = { seed: 2000 + s, warmupCompletions: 2000, measureCompletions: 8000 };
      const a = simulate(net, o);
      const b = simulate(net, o);
      expect(b.meanSojourn).toBe(a.meanSojourn);
      expect(b.departureRate).toBe(a.departureRate);
      expect(a.errorRate).toBe(0); // no deadline anywhere ⇒ nothing renegess ⇒ no failures
      for (const st of a.stations) expect(st.dropped).toBe(0); // and nothing is dropped at any station
    }
  });

  it('an overloaded station SHEDS load once a deadline is set: goodput ≈ capacity, the excess fails at the station', () => {
    // Without a deadline ρ=2 is unstable (the queue and sojourn diverge); the DES still serves ≈ μ=1 but the
    // backlog is unbounded. With a finite deadline the borrow queue self-limits: the served (goodput) rate stays
    // ≈ the μ=1 server capacity, and the un-servable excess (~half the 2/s offered) renegess as station drops.
    const withDeadline = simulate(overloaded(500), opts); // 500 ms borrow timeout
    expect(withDeadline.goodputRps).toBeGreaterThan(0.8);
    expect(withDeadline.goodputRps).toBeLessThan(1.05); // cannot exceed the single server's capacity
    expect(withDeadline.errorRate).toBeGreaterThan(0); // the excess offered load fails (no caller retry ⇒ terminal)
    // Every failure is a station drop here (the only loss mechanism) and no caller retries fly ⇒ amplification 1.
    const dropped = withDeadline.stations.reduce((n, st) => n + st.dropped, 0);
    expect(dropped).toBeGreaterThan(0);
    expect(withDeadline.amplification).toBe(1); // no attemptPolicy ⇒ exactly one attempt per arrival
  });

  it('abandonments are DEADLINE-GATED: a LONGER borrow timeout drops FEWER jobs (monotone) on a loaded station', () => {
    // The deadline gates when a waiter gives up: a job renegess only after WAITING longer than the deadline, so a
    // longer deadline lets more waiters reach a server first ⇒ strictly fewer drops. Pick a HEAVILY-loaded but
    // sub-critical station (ρ=0.95): its queue is finite but its waits are long and heavy-tailed, so a short
    // deadline clips the tail and sheds real load while a generous deadline sheds almost nothing (the queue clears
    // within it). This makes the monotonicity robust rather than the ρ>1 knife-edge where the server never idles.
    const s = StationId('s');
    const loaded = (maxQueueWaitMs: number): QueueingNetwork => ({
      stations: [{ id: s, service: { kind: 'exponential', rate: 1 }, servers: 1, maxQueueWaitMs }],
      arrivals: [{ at: s, interarrival: { kind: 'exponential', rate: 0.95 } }], // ρ=0.95: long, heavy-tailed waits
      routing: new Map(),
    });
    const o: SimOptions = { seed: 271828, warmupCompletions: 20000, measureCompletions: 120000 };
    const short = simulate(loaded(200), o); // 200 ms — clips the long-wait tail
    const long = simulate(loaded(20000), o); // 20 s — the queue almost always clears first
    expect(short.errorRate).toBeGreaterThan(long.errorRate); // shorter deadline ⇒ strictly more abandonment
    expect(long.errorRate).toBeLessThan(short.errorRate * 0.5); // and materially fewer (the generous deadline barely bites)
    // A stable station serves essentially all offered load with the generous deadline ⇒ goodput ≈ offered 0.95/s.
    expect(long.goodputRps).toBeGreaterThan(0.9);
  });

  it('COMPOSES with a caller retry policy: a station renege triggers the caller re-attempt (amplification > 1)', () => {
    // The station deadline and the caller policy are ORTHOGONAL mechanisms that must compose without special-casing:
    // a job reneged at the station is an ordinary failed attempt, so a caller with a retry budget re-injects it.
    const s = StationId('s');
    const net: QueueingNetwork = {
      stations: [{ id: s, service: { kind: 'exponential', rate: 1 }, servers: 1, maxQueueWaitMs: 200 }],
      arrivals: [
        {
          at: s,
          interarrival: { kind: 'exponential', rate: 2 }, // ρ=2 ⇒ a borrow queue forms and renegess at 200 ms
          // The caller ALSO has a per-attempt timeout + retries, but its timeout is so large it NEVER fires within
          // any bounded run: the STATION deadline (200 ms) is the only thing that renegess, and its failure feeds
          // the caller's retry loop — proving composition (the two deadlines are orthogonal), not a special case.
          attemptPolicy: { timeoutMs: 1e12, retries: 3, backoffMs: 10 },
        },
      ],
      routing: new Map(),
    };
    const withRetry = simulate(net, opts);
    expect(withRetry.amplification).toBeGreaterThan(1); // station reneges drove caller re-attempts
    const dropped = withRetry.stations.reduce((n, st) => n + st.dropped, 0);
    expect(dropped).toBeGreaterThan(0); // the station attributed the renege drops
    expect(withRetry.goodputRps).toBeLessThan(1.05); // retries still cannot exceed the μ=1 capacity — the hump holds

    // Control: the SAME overload + retry-capable caller but with NO station deadline. The caller's 1e12 ms timeout
    // never fires in any bounded run, so nothing renegess ⇒ amplification stays 1 and no station drops occur. This
    // isolates the STATION deadline as the retry trigger above: remove it and the identical caller adds no traffic.
    const noDeadline: QueueingNetwork = { ...net, stations: [{ id: s, service: { kind: 'exponential', rate: 1 }, servers: 1 }] };
    const controlRun = simulate(noDeadline, opts);
    expect(controlRun.amplification).toBe(1);
    expect(controlRun.stations.reduce((n, st) => n + st.dropped, 0)).toBe(0);
  });
});
