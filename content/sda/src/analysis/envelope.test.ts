import { describe, expect, it } from 'vitest';
import { evaluate } from '@sda/engine-solve';
import { makeNativeAdapter } from '@sda/solver-contract/native';
import type { Optimize } from '@sda/solver-contract';
import { instantiate, allManifests, registry, keys, type Instance, type Wire } from '../index';
import { computeEnvelope, type EnvelopeInput } from './envelope';

// THE CAPACITY ENVELOPE. Each test carries its ANALYTIC ANCHOR — a bound you can compute
// by hand from the design's capacities — plus a DIFFERENTIAL check that the native inversion agrees with an
// INDEPENDENT brute-force load sweep. The solver is the CONTRACT's native adapter (the same one the app binds), so
// these exercise the real inversion seam, not a stand-in.

const native = makeNativeAdapter({ registry });
const optimize: Optimize = native.optimize!;

/** client(throughput = its load) → a chain of compute.services. A service's capacity is concurrency×1000/duration,
 *  so with duration = 100 ms the capacity is concurrency×10 — a round, hand-computable number. */
function chain(caps: readonly number[]): { instances: Instance[]; wires: Wire[] } {
  const instances: Instance[] = [{ id: 'client', type: 'client.web', config: { throughput: 100 } }];
  const wires: Wire[] = [];
  let prev = 'client';
  let prevPort = 'out';
  caps.forEach((cap, i) => {
    const id = `svc${i + 1}`;
    instances.push({ id, type: 'compute.service', config: { concurrency: cap / 10, perRequestDuration: 100 } }); // cap = concurrency×10
    wires.push({ from: [prev, prevPort], to: [id, 'in'] });
    prev = id;
    prevPort = 'out';
  });
  return { instances, wires };
}

const inputOf = (d: { instances: Instance[]; wires: Wire[] }): EnvelopeInput => ({ instances: d.instances, wires: d.wires, registry, catalog: allManifests });

/** INDEPENDENT brute-force: the largest integer client load at which the raw (scalar) forward pass shows no
 *  violation — the referee the native inversion must agree with (differential). */
function bruteMaxRps(d: { instances: Instance[]; wires: Wire[] }, hiGuess = 1_000_000): number {
  const feasible = (load: number): boolean => {
    const insts = d.instances.map((i) => (i.id === 'client' ? { ...i, config: { ...(i.config ?? {}), throughput: load } } : i));
    const g = instantiate(allManifests, insts, d.wires);
    if (!g.ok) return false;
    const ev = evaluate(g.value, registry);
    if (!ev.ok) return false;
    return ev.value.verdicts.every((v) => v.status !== 'violation');
  };
  let lo = 0;
  let hi = hiGuess;
  if (feasible(hi)) return hi; // unbounded within the guess
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (feasible(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

describe('capacity envelope — analytic anchors', () => {
  it('a single-tier chain: the envelope IS the tier capacity, bounded by saturation (overflow≤0)', async () => {
    // client → svc(capacity 2000). Push the client load to the edge: it holds to exactly 2000 req/s (offered =
    // capacity), and the first thing to give is svc's overflow — pure capacity saturation, no declared SLO.
    const d = chain([2000]);
    const env = await computeEnvelope(inputOf(d), optimize);
    expect(env.perOrigin).toHaveLength(1);
    const o = env.perOrigin[0]!;
    expect(o.node).toBe('client');
    expect(o.key).toBe('assumedRps'); // : the unified demand knob (client.web's declared demand rides it directly)
    expect(o.maxRps).toBe(2000); // the hand-computed capacity
    expect(o.basis).toBe('saturation');
    expect(o.firstBreak).toEqual({ node: 'svc1', key: String(keys.overflow) });
  });

  it('breaking order matches the per-node bounds: the SMALLEST tier gives first', async () => {
    // client → svc1(2000) → svc2(1000). As load grows, svc2 (the smaller capacity) overflows first at 1000 —
    // the envelope is the MIN capacity along the chain, and the first break names that tier.
    const d = chain([2000, 1000]);
    const env = await computeEnvelope(inputOf(d), optimize);
    const o = env.perOrigin[0]!;
    expect(o.maxRps).toBe(1000);
    expect(o.firstBreak?.node).toBe('svc2');
  });

  it('the queueing KNEE sits at ρ = 0.8 of the capacity edge (the headroom line)', async () => {
    // svc capacity 2000 ⇒ ρ = offered/2000; ρ reaches the 0.8 headroom line at offered ≈ 1600 — below the
    // capacity edge (2000), which is exactly the point of the knee: reality bites before saturation.
    const d = chain([2000]);
    const env = await computeEnvelope(inputOf(d), optimize);
    expect(env.knee).toBeDefined();
    expect(env.knee!.node).toBe('svc1');
    expect(Math.abs(env.knee!.atRps - 1600)).toBeLessThanOrEqual(25); // 0.8 × 2000
    expect(env.knee!.utilization).toBe(0.8);
  });
});

describe('capacity envelope — a floor SLO makes the feasible region a BAND', () => {
  it('a throughput FLOOR (minimum served rate) reports [minRps, maxRps], not 0', async () => {
    // client → svc(capacity 2000) with a throughput FLOOR of 800 on svc: below 800 offered the floor is unmet, at
    // ≥ 800 it holds until saturation at 2000. The envelope is the BAND 800..2000 — reporting 0 (as a naive
    // "violated at zero load" would) is wrong: 0 is not in the feasible set. D_max = 2000, D_min = 800.
    const d = chain([2000]);
    d.instances = d.instances.map((i) => (i.id === 'svc1' ? { ...i, bands: [{ key: keys.throughput, band: { shape: 'minTargetMax', min: 800 } }] } : i));
    const env = await computeEnvelope(inputOf(d), optimize);
    const o = env.perOrigin[0]!;
    expect(o.maxRps).toBe(2000);
    expect(o.minRps).toBe(800);
    expect(o.note).toContain('floor');
  });
});

describe('capacity envelope — differential vs a brute-force sweep', () => {
  for (const caps of [[2000], [1500, 3000], [3000, 1000, 2000], [700]]) {
    it(`native inversion agrees with the brute-force edge for capacities [${caps.join(', ')}]`, async () => {
      const d = chain(caps);
      const env = await computeEnvelope(inputOf(d), optimize);
      const brute = bruteMaxRps(d);
      // The reported edge (native inversion) matches the independent brute-force forward sweep within rounding.
      expect(Math.abs((env.perOrigin[0]!.maxRps ?? -1) - brute)).toBeLessThanOrEqual(1);
      // And it is the MIN capacity along the chain (the hand bound).
      expect(env.perOrigin[0]!.maxRps).toBe(Math.min(...caps));
    });
  }
});

describe('capacity envelope — honest states & determinism', () => {
  it('a design with NO traffic origin has no envelope (says why, never a fabricated boundary)', async () => {
    const d = { instances: [{ id: 'db', type: 'db.postgres' }] as Instance[], wires: [] as Wire[] };
    const env = await computeEnvelope(inputOf(d), optimize);
    expect(env.perOrigin).toHaveLength(0);
    expect(env.note).toBeDefined();
  });

  it('is DETERMINISTIC — the same design yields the same envelope', async () => {
    const d = chain([2000, 1000]);
    const a = await computeEnvelope(inputOf(d), optimize);
    const b = await computeEnvelope(inputOf(d), optimize);
    expect(a).toEqual(b);
  });

  it('reports a JOINT edge when several origins drive the design', async () => {
    // two clients, each 100 req/s, both into one svc(capacity 2000): jointly they saturate it when their SUM
    // reaches 2000 — the joint edge is 2000 total (each ~1000 at the current 1:1 ratio).
    const d = {
      instances: [
        { id: 'c1', type: 'client.web', config: { throughput: 100 } },
        { id: 'c2', type: 'client.web', config: { throughput: 100 } },
        { id: 'svc', type: 'compute.service', config: { concurrency: 200, perRequestDuration: 100 } },
      ] as Instance[],
      wires: [
        { from: ['c1', 'out'], to: ['svc', 'in'] },
        { from: ['c2', 'out'], to: ['svc', 'in'] },
      ] as Wire[],
    };
    const env = await computeEnvelope(inputOf(d), optimize);
    expect(env.perOrigin).toHaveLength(2);
    expect(env.joint).toBeDefined();
    expect(env.joint!.maxTotalRps).toBe(2000);
    expect(env.joint!.firstBreak?.node).toBe('svc');
  });
});
