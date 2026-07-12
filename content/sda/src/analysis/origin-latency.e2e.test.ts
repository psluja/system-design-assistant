import { describe, expect, it } from 'vitest';
import { simulate, StationId } from '@sda/engine-sim';
import { instantiate, manifests, toQueueingNetwork, type Instance, type Wire } from '../index';

// SINGLE-TRUTH LATENCY FOR ORIGINS (R1). A client / origin used to be a PURE EMITTER — it injected arrivals at its
// downstream targets and was NOT a station, so the DES recorded no response for it and its canvas latency bar was
// blank (the owner's CQRS report: the query-clients node showed a rate but no latency). It is now a ZERO-SERVICE
// PASSTHROUGH station: arrivals inject AT it, and by the v2 suffix identity (des.ts §4) the ENTRY node's response IS
// the request's end-to-end sojourn. So the client finally carries the same measured p50→p99 bar every served tier
// does — MEASURED via its own reservoir, never invented.
describe('origin is a measured station — the client bar = the end-to-end journey', () => {
  // The proven-stable chain from the web latency-bar e2e (client → gw → fn → db at 400 rps): comfortably below every
  // tier's capacity, so responses are finite and the identity is clean.
  const instances: Instance[] = [
    { id: 'client', type: 'client.source', config: { throughput: 400 } },
    { id: 'gw', type: 'gateway.api' },
    { id: 'fn', type: 'compute.faas' },
    { id: 'db', type: 'db.sql' },
  ];
  const wires: Wire[] = [
    { from: ['client', 'out'], to: ['gw', 'in'] },
    { from: ['gw', 'out'], to: ['fn', 'in'] },
    { from: ['fn', 'out'], to: ['db', 'in'] },
  ];
  const built = instantiate(manifests, instances, wires);
  if (!built.ok) throw new Error(`build failed: ${JSON.stringify(built.error)}`);
  const net = toQueueingNetwork(built.value);

  it('PROJECTION: the client is a station and injects its load AT ITSELF (a zero-service passthrough), then routes to gw', () => {
    expect(net.stations.some((s) => String(s.id) === 'client')).toBe(true);
    const arr = net.arrivals.filter((a) => String(a.at) === 'client');
    expect(arr).toHaveLength(1);
    expect(arr[0]?.interarrival).toMatchObject({ kind: 'exponential', rate: 400 });
    // No arrival is injected straight at gw anymore — the client relays it there via routing (distribution-neutral).
    expect(net.arrivals.some((a) => String(a.at) === 'gw')).toBe(false);
    const routes = net.routing.get(StationId('client')) ?? [];
    expect(routes.map((e) => String(e.to))).toEqual(['gw']);
  });

  it('IDENTITY: the client response p50/p99/mean ≈ the end-to-end sojourn (the entry node IS the whole request)', () => {
    const sim = simulate(net, { seed: 7, warmupCompletions: 20000, measureCompletions: 100000 });
    const client = sim.nodeResponse.find((n) => String(n.id) === 'client');
    expect(client).toBeDefined();
    expect(client!.samples).toBeGreaterThan(0);
    const rel = (got: number, want: number): number => Math.abs(got - want) / Math.abs(want);
    // The zero-service entry adds ~0 own time, so its measured response distribution equals the end-to-end sojourn
    // (same tolerances as the engine-sim suffix-identity test: reservoir sample vs the full sojourn array).
    expect(rel(client!.p50, sim.sojournPercentile(0.5))).toBeLessThan(0.05);
    expect(rel(client!.p99, sim.sojournPercentile(0.99))).toBeLessThan(0.08);
    expect(rel(client!.mean, sim.meanSojourn)).toBeLessThan(0.03);
    // And the client's response is the BUSIEST journey — it is every downstream tier's response plus its own 0, so
    // it is ≥ any single downstream tier's own response (the whole chain, not one hop).
    const db = sim.nodeResponse.find((n) => String(n.id) === 'db')!;
    expect(client!.mean).toBeGreaterThan(db.mean);
  });
});
