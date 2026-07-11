import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NodeId, type Verdict } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { simulate } from '@sda/engine-sim';
import { makeNativeAdapter } from '@sda/solver-contract/native';
import type { Optimize } from '@sda/solver-contract';
import { instantiate, allManifests, registry, keys, nodeQueues, toQueueingNetwork, computeEnvelope, type Instance, type Wire, type Manifest } from './index';

// ENVELOPE EDGE, DES-CONFIRMED (TASK-85 AC#3). The capacity envelope's per-origin `maxRps` is computed on the
// SCALAR forward pass (ρ→1 / an SLO). This suite asks the harder question the owner wanted closed: is that scalar
// boundary REAL dynamics-wise? We run the discrete-event simulator (the time engine) BRACKETING the edge and assert
// the design is stable BELOW it and shows saturation signals JUST ABOVE — on two analytic chains and the committed
// CQRS example. Seeded + deterministic; the DES and the analytic queueing twin (`nodeQueues`, the M/M/c model the
// DES is differential-tested against) tell the SAME story, at their own time-scale.
//
// The signals, honest by construction (the tool must not lie):
//   • STABLE below — the binding tier is comfortably utilised (< 95%), nothing queues to infinity, nothing dropped.
//   • SATURATED above — the binding tier pins at ~100% utilisation, its analytic queue diverges (sojourn → ∞), the
//     simulated departure rate can no longer keep up with the offered load, and the scalar overflow band flips red.

const native = makeNativeAdapter({ registry });
const optimize: Optimize = native.optimize!;

// A single seed + a fixed, generous measurement window ⇒ the utilisation/sojourn figures are steady-state and
// reproducible run to run (no clock, no wall-time). The same window content's other DES e2e tests use.
const SIM = { seed: 4242, warmupCompletions: 20_000, measureCompletions: 100_000 } as const;

/** client(throughput = its load) → a chain of compute.services. A service's capacity is concurrency×1000/duration,
 *  so with duration = 100 ms the capacity is concurrency×10 — a round, hand-computable M/M/c tier. (Same shape as
 *  `envelope.test.ts`, so the analytic anchor is shared.) */
function chain(caps: readonly number[]): { instances: Instance[]; wires: Wire[] } {
  const instances: Instance[] = [{ id: 'client', type: 'client.web', config: { throughput: 100 } }];
  const wires: Wire[] = [];
  let prev = 'client';
  caps.forEach((cap, i) => {
    const id = `svc${i + 1}`;
    instances.push({ id, type: 'compute.service', config: { concurrency: cap / 10, perRequestDuration: 100 } });
    wires.push({ from: [prev, 'out'], to: [id, 'in'] });
    prev = id;
  });
  return { instances, wires };
}

/** One dynamics observation at a given origin load: the scalar violations (the boundary), the DES run (the
 *  dynamics), and the analytic queueing twin — everything a bracket assertion needs, seeded and deterministic. */
function run(
  catalog: Readonly<Record<string, Manifest>>,
  instances: readonly Instance[],
  wires: readonly Wire[],
  originId: string,
  load: number,
): { violations: readonly Verdict[]; sim: ReturnType<typeof simulate>; q: ReturnType<typeof nodeQueues> } {
  const scaled = instances.map((i) => (i.id === originId ? { ...i, config: { ...(i.config ?? {}), throughput: load } } : i));
  const g = instantiate(catalog, scaled, wires);
  if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
  const ev = evaluate(g.value, registry);
  if (!ev.ok) throw new Error(ev.error.join('; '));
  const sim = simulate(toQueueingNetwork(g.value), SIM);
  const q = nodeQueues(g.value, (id, k) => ev.value.value(NodeId(id), k));
  const violations = ev.value.verdicts.filter((v) => v.status === 'violation');
  return { violations, sim, q };
}

const stationOf = (sim: ReturnType<typeof simulate>, id: string) => sim.stations.find((s) => String(s.id) === id)!;
const totalDropped = (sim: ReturnType<typeof simulate>): number => sim.stations.reduce((s, st) => s + st.dropped, 0);
const isOverflow = (v: Verdict): boolean => String(v.key) === String(keys.overflow);

describe('envelope edge, DES-confirmed — analytic chains', () => {
  for (const caps of [[2000], [2000, 1000]] as const) {
    it(`chain [${caps.join(', ')}]: stable at ~90% of the edge, saturated at ~115%`, async () => {
      const d = chain(caps);
      const env = await computeEnvelope({ instances: d.instances, wires: d.wires, registry, catalog: allManifests }, optimize);
      const o = env.perOrigin[0]!;
      expect(o.maxRps).toBe(Math.min(...caps)); // the hand-computed capacity edge (envelope.test.ts's anchor)
      const edge = o.maxRps!;
      const bind = o.firstBreak!.node; // the smallest tier — the binding M/M/c station in this chain

      // BELOW the edge (10% headroom): the scalar pass is clean AND the DES is stable.
      const below = run(allManifests, d.instances, d.wires, 'client', Math.floor(edge * 0.9));
      expect(below.violations).toHaveLength(0);
      expect(stationOf(below.sim, bind).utilization).toBeLessThan(0.95);
      expect(totalDropped(below.sim)).toBe(0);
      expect(Number.isFinite(below.sim.meanSojourn)).toBe(true);
      expect(below.q.get(bind)!.rho).toBeLessThan(1);
      expect(Number.isFinite(below.q.get(bind)!.sojournMs)).toBe(true);

      // JUST ABOVE the edge (15% over): the scalar boundary flips (overflow) AND the DES saturates.
      const overLoad = Math.ceil(edge * 1.15);
      const above = run(allManifests, d.instances, d.wires, 'client', overLoad);
      expect(above.violations.some(isOverflow)).toBe(true); // the scalar boundary is crossed
      expect(stationOf(above.sim, bind).utilization).toBeGreaterThan(0.98); // pinned at capacity
      expect(above.q.get(bind)!.rho).toBeGreaterThan(1);
      expect(above.q.get(bind)!.sojournMs).toBe(Infinity); // the analytic queue diverges past ρ = 1
      expect(above.sim.departureRate).toBeLessThan(overLoad); // the DES cannot serve the offered load
      expect(above.sim.meanSojourn).toBeGreaterThan(below.sim.meanSojourn * 3); // the tail blows up crossing the edge
    });
  }
});

// The committed CQRS example (examples/cqrs.sda.json), with its inline `topic.sns` component merged into the catalog.
// The export tags no Maps here (no percentile bands), so a plain JSON.parse suffices.
function loadCqrs(): { instances: Instance[]; wires: Wire[]; catalog: Record<string, Manifest> } {
  const path = fileURLToPath(new URL('../../../examples/cqrs.sda.json', import.meta.url));
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { instances: Instance[]; wires: Wire[]; components?: Manifest[] };
  const catalog: Record<string, Manifest> = { ...allManifests };
  for (const c of doc.components ?? []) catalog[c.type] = c;
  return { instances: doc.instances, wires: doc.wires, catalog };
}

describe('envelope edge, DES-confirmed — the CQRS example', () => {
  it('the write-model store is bounded below the computed edge and saturated at/above it', async () => {
    const { instances, wires, catalog } = loadCqrs();
    const env = await computeEnvelope({ instances, wires, registry, catalog }, optimize);
    const o = env.perOrigin[0]!;
    expect(o.node).toBe('client');
    expect(o.basis).toBe('saturation');
    const edge = o.maxRps!;
    expect(edge).toBe(12_500); // the fan-out / gateway throughput-ceiling edge (firstBreak on cmd/gw overflow)

    // The envelope edge is a THROUGHPUT-CEILING boundary (gw/cmd overflow), which `toQueueingNetwork` models as a
    // pure-delay hop — it never queues in the DES. The co-critical CONCURRENCY-bound tier the DES DOES queue is the
    // write-model Postgres `pg` (concurrency 625 × 1000/50 ms = 12,500 = the SAME edge), so we confirm the boundary
    // THERE — the tier the simulator can actually see. (The SNS fan-out queues drain at a fixed rate and saturate
    // independently BELOW the edge — a separate, pre-existing DES dynamic, deliberately not asserted here.)
    const BIND = 'pg';

    // Comfortably BELOW the edge (80%): scalar clean, and `pg` is a comfortably-utilised M/M/c — bounded, no drops.
    const below = run(catalog, instances, wires, 'client', Math.round(edge * 0.8));
    expect(below.violations).toHaveLength(0);
    expect(stationOf(below.sim, BIND).utilization).toBeLessThan(0.9);
    expect(stationOf(below.sim, BIND).dropped).toBe(0);
    expect(below.q.get(BIND)!.rho).toBeLessThan(1);
    expect(Number.isFinite(below.q.get(BIND)!.sojournMs)).toBe(true);

    // ABOVE the edge (110%): the scalar overflow band flips red, and `pg` pins at ~100% utilisation — its inflow is
    // capped at the edge by the upstream gateway ceiling, so saturation shows as ρ→1 (an infinite-buffer M/M/c does
    // not drop; it queues), exactly at the boundary the envelope computed.
    const above = run(catalog, instances, wires, 'client', Math.round(edge * 1.1));
    expect(above.violations.some(isOverflow)).toBe(true);
    expect(stationOf(above.sim, BIND).utilization).toBeGreaterThan(0.95);
    expect(stationOf(above.sim, BIND).dropped).toBe(0);
  });
});
