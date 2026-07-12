import { describe, expect, it } from 'vitest';
import { NodeId, type Key } from '@sda/engine-core';
import { createEngine, evaluate, illegalEdges } from '@sda/engine-solve';
import { instantiate, allManifests, registry, keys, toQueueingNetwork, systemSummary, provisioningTunables, type Instance, type Wire } from './index';

// UNIVERSAL TRAFFIC ORIGIN (the design correction: not every architecture has a client). A DB-to-DB MIGRATION
// chain with NO client at all: a service ORIGINATES 500 req/s (assumedRps) and fans it to two databases it is
// migrating between (read source Postgres → write Aurora). Every node must be able to play the traffic-origin
// role, and requirements must hold at every node — this proves it end-to-end (scalar flow, DES, roll-up, search).
describe('universal traffic origin — a client-less DB migration', () => {
  const ORIGIN = 500;
  const instances: Instance[] = [
    { id: 'svc', type: 'compute.service', config: { assumedRps: ORIGIN } }, // originates the migration workload
    { id: 'pg', type: 'db.postgres', bands: [{ key: keys.throughput, band: { shape: 'minTargetMax', target: ORIGIN } }] },
    { id: 'aurora', type: 'db.aurora', bands: [{ key: keys.throughput, band: { shape: 'minTargetMax', target: ORIGIN } }] },
  ];
  // compute.service `db` port speaks postgresql; its generic `out` port also speaks postgresql (CLIENT_PROTOCOLS).
  const wires: Wire[] = [
    { from: ['svc', 'db'], to: ['pg', 'in'] },
    { from: ['svc', 'out'], to: ['aurora', 'in'] },
  ];

  const built = instantiate(allManifests, instances, wires);
  if (!built.ok) throw new Error(`build failed: ${JSON.stringify(built.error)}`);
  const graph = built.value;

  it('wiring is protocol-legal (postgresql on both hops), no client required', () => {
    expect(illegalEdges(graph, [])).toEqual([]);
  });

  it('the ORIGINATED 500 req/s reaches BOTH databases (offered load with no client)', () => {
    const r = evaluate(graph, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    expect(r.value.converged).toBe(true);
    // svc emits its origin (capped by its own large capacity); each db is offered the full 500 (fan-out).
    expect(r.value.value(NodeId('svc'), keys.throughput)).toBe(ORIGIN);
    expect(r.value.value(NodeId('pg'), keys.throughput)).toBe(ORIGIN); // pg capacity 2000 ≥ 500 ⇒ served in full
    expect(r.value.value(NodeId('aurora'), keys.throughput)).toBe(ORIGIN); // aurora capacity 10000 ≥ 500
  });

  it('SLOs/verdicts hold AT the databases (requirements at every node, no client present)', () => {
    const r = evaluate(graph, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    for (const id of ['pg', 'aurora']) {
      const v = r.value.verdicts.find((x) => x.scope === NodeId(id) && x.key === keys.throughput);
      expect(v, `throughput verdict at ${id}`).toBeDefined();
      expect(v?.status, `throughput OK at ${id}`).toBe('ok'); // 500 served ≥ 500 target
      // no overflow: 500 offered ≤ capacity
      expect(r.value.value(NodeId(id), keys.overflow) ?? 0).toBeCloseTo(0, 6);
    }
  });

  it('the system roll-up reports a flow whose SOURCE is the originating service (not a client)', () => {
    const ev = createEngine(registry).evaluate(graph);
    if (!ev.ok) throw new Error('eval failed');
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const s = systemSummary(instances, wires, value);
    expect(s.flows.length).toBeGreaterThanOrEqual(1);
    expect(s.flows.every((f) => f.source === 'svc')).toBe(true); // svc DECLARES origin ⇒ it is the flow source
  });

  it('DES: arrivals are emitted from the originating service (a client-less design still simulates a tail)', () => {
    const qn = toQueueingNetwork(graph);
    // svc originates AND serves ⇒ it is a station, and its 500 req/s arrive AT svc (so the tail includes its work).
    const svcArrivals = qn.arrivals.filter((a) => String(a.at) === 'svc');
    expect(svcArrivals).toHaveLength(1);
    expect(svcArrivals[0]?.interarrival).toMatchObject({ kind: 'exponential', rate: ORIGIN });
    expect(qn.stations.some((st) => String(st.id) === 'svc')).toBe(true); // originating service is a station
    // svc routes its served flow to both databases (fan-out prob 1 each).
    const svcRoutes = qn.routing.get(qn.stations.find((st) => String(st.id) === 'svc')!.id) ?? [];
    expect(new Set(svcRoutes.map((e) => String(e.to)))).toEqual(new Set(['pg', 'aurora']));
  });

  it('SEARCH HONESTY: assumedRps is FROZEN — never a tunable the solver can lower to fake a cheaper design', () => {
    const tunables = provisioningTunables(graph);
    expect(tunables.some((t) => String(t.key) === String(keys.assumedRps))).toBe(false);
    // and svc's declared origin survives verbatim in the graph (it is an input cell, not a search variable).
    const svc = graph.nodes.get(NodeId('svc'));
    const originCell = svc?.cells.find((c) => c.kind === 'input' && String(c.key) === String(keys.assumedRps));
    expect(originCell && originCell.kind === 'input' && originCell.value.kind === 'fixed' ? originCell.value.quantity.value : undefined).toBe(ORIGIN);
  });
});
