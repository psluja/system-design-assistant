import { describe, expect, it } from 'vitest';
import { buildGraph, EdgeId, NodeId, PortId, type Edge, type Node, type Port } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { simulate } from '@sda/engine-sim';
import { instantiate, allManifests, registry, keys, nodeQueues, responseLatency, toQueueingNetwork, type Instance, type NodeQueue, type Wire } from '../index';

// — the analytic response-latency composition must honor wire/port flow transforms the SAME way the DES
// does. THE BUG: `responseLatency`'s sequential combine() used to sum synchronous children's responses UNWEIGHTED,
// so a cache-aside service (ratio(miss) on its svc→db wire — the catalog's own recommended pattern, see
// catalog/common.ts's cache.redis comment) was charged the DB's FULL response on every request, while the DES
// correctly visits the DB on only the miss fraction. The fix weights the SEQUENTIAL (default) composition by each
// sync child's MEAN flow multiplicity — the same wire-wins-over-port resolution the DES route edges use
// (`edgeMultiplicity`, graph-read.ts) — so the two engines can no longer disagree about the same design's mean
// response. Parallel/fastest stay unweighted (queueing.ts doc comment states the limitation).

describe('responseLatency — wire-transform weighted sequential composition', () => {
  // ── (a) THE DIFFERENTIAL: a cache-aside design pins the disagreement shut ──────────────────────────────────
  // client → svc(compute.service), svc fans out to cache.redis (full rate, no transform) AND db.postgres (wire
  // ratio(0.2) — an 80%-hit cache: only the 20% miss fraction reaches the DB). db is sized down (concurrency 11)
  // so its OFFERED 200 req/s (1000 × 0.2) sits at rho ~ 0.91 — real, substantial M/M/c queueing — so the pre-fix
  // pessimism (paying the DB's full response on every request) is LARGE, not a rounding blip.
  const CLIENT_RPS = 1000;
  const MISS_RATIO = 0.2;
  const instances: Instance[] = [
    { id: 'client', type: 'client.web', config: { throughput: CLIENT_RPS } },
    { id: 'svc', type: 'compute.service' }, // default concurrency 500 / perRequestDuration 20ms — never the bottleneck
    { id: 'cache', type: 'cache.redis' }, // default: ~0 queueing at 1000 req/s (100k op/s ceiling)
    { id: 'db', type: 'db.postgres', config: { concurrency: 11 } }, // capacity 11/0.05s = 220 req/s; offered 200 ⇒ rho ~ 0.91
  ];
  const wires: Wire[] = [
    { from: ['client', 'out'], to: ['svc', 'in'] },
    { from: ['svc', 'cache'], to: ['cache', 'in'] }, // no transform ⇒ full 1000 req/s (weight 1)
    { from: ['svc', 'db'], to: ['db', 'in'], transform: { kind: 'ratio', value: MISS_RATIO } }, // only the 20% miss reaches the DB
  ];

  it('the analytic mean response at svc matches the DES mean within tolerance (post-fix)', () => {
    const g = instantiate(allManifests, instances, wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: typeof keys.throughput) => ev.value.value(NodeId(id), k);
    const q = nodeQueues(g.value, value);

    // db really does queue (the pre-fix pessimism needs this to be substantial, not a rounding blip).
    const dbQ = q.get('db');
    expect(dbQ?.rho).toBeGreaterThan(0.8);
    expect(dbQ?.rho).toBeLessThan(1);
    expect(dbQ?.sojournMs).toBeGreaterThan((dbQ?.serviceMs ?? 0) * 1.2); // a real queueing penalty above the bare service time

    const analytic = responseLatency(g.value, value, q).get('svc') as number;

    // THE DES twin, same design, run to a stable mean. engine/sim's internal clock is SECONDS (des.ts / sim.e2e.test
    // convention: `meanSojourn` etc. are seconds), so `nodeResponse[].mean` is converted ×1000 to compare in ms.
    const net = toQueueingNetwork(g.value);
    const sim = simulate(net, { seed: 20260712, warmupCompletions: 20000, measureCompletions: 150000 });
    const desMeanMs = (sim.nodeResponse.find((n) => String(n.id) === 'svc')?.mean as number) * 1000;
    expect(Number.isFinite(desMeanMs)).toBe(true);

    // PRE-FIX vs POST-FIX vs DES (recorded from an actual run — mutation-verified below, seed 20260712): db's own
    // sojourn is 84.11 ms (svc 20 ms, cache 0.01 ms — both negligible). The OLD unweighted sum charged svc the DB's
    // FULL response on every request: 20 + 0.01 + 84.11 = 104.12 ms — 194% above the DES's measured 35.39 ms. The FIX
    // weights the db branch by its 0.2 wire ratio: 20 + 1×0.01 + 0.2×84.11 = 36.83 ms, 4.1% from the DES — the
    // cross-engine disagreement this test pins shut.
    const rel = Math.abs(analytic - desMeanMs) / desMeanMs;
    expect(rel, `analytic ${analytic.toFixed(2)} ms vs DES ${desMeanMs.toFixed(2)} ms`).toBeLessThan(0.15);
  });

  // ── (b) the weighting composes: WIRE wins over the source out-port, then the target IN-port multiplies on top —
  //     the exact resolution sim.ts's DES route edges use (`edgeMultiplicity`, graph-read.ts). ──────────────────
  describe('the weighted composition resolves multiplicity exactly like the DES route edges (wire wins, then in-port)', () => {
    const P = (n: string, d: 'in' | 'out'): PortId => PortId(`${n}.${d}`);
    // A → B: A's out port carries a port-default ratio(5) (would apply if no wire override existed); B's in port
    // carries prob(0.5). The WIRE itself carries ratio(2) — it must WIN over A's port default, so the resolved
    // out-side factor is 2 (not 5), then B's in-port factor 0.5 multiplies on top ⇒ weight = 2 × 0.5 = 1.0.
    const build = (wireTransform: Edge['transform']): Map<string, number> => {
      const nodes: Node[] = [
        { id: NodeId('A'), ports: [P('A', 'in'), P('A', 'out')], cells: [] },
        { id: NodeId('B'), ports: [P('B', 'in'), P('B', 'out')], cells: [] },
      ];
      const ports: Port[] = [
        { id: P('A', 'in'), node: NodeId('A'), dir: 'in' },
        { id: P('A', 'out'), node: NodeId('A'), dir: 'out', transform: { kind: 'ratio', value: 5 } }, // the port DEFAULT
        { id: P('B', 'in'), node: NodeId('B'), dir: 'in', transform: { kind: 'prob', value: 0.5 } }, // the in-port factor
        { id: P('B', 'out'), node: NodeId('B'), dir: 'out' },
      ];
      const edges: Edge[] = [{ id: EdgeId('e0'), from: P('A', 'out'), to: P('B', 'in'), semantics: 'sync', ...(wireTransform ? { transform: wireTransform } : {}) }];
      const g = buildGraph({ nodes, ports, edges });
      if (!g.ok) throw new Error('graph: ' + g.error.join('; '));
      const queues = new Map<string, NodeQueue>();
      queues.set('A', { rho: 0.5, serviceMs: 10, sojournMs: 10, servers: 1, offered: 0, capacity: 0 });
      queues.set('B', { rho: 0.5, serviceMs: 100, sojournMs: 100, servers: 1, offered: 0, capacity: 0 });
      return responseLatency(g.value, () => undefined, queues);
    };

    it('a WIRE transform OVERRIDES the source out-port default (2 × 0.5 = 1.0×B, not 5 × 0.5 = 2.5×B)', () => {
      const r = build({ kind: 'ratio', value: 2 });
      // weight = wire ratio(2) [wins over A.out's ratio(5)] × B.in prob(0.5) = 1.0 ⇒ response(A) = 10 + 1.0×100 = 110
      expect(r.get('A')).toBeCloseTo(110, 6);
    });

    it('with NO wire transform, the source out-port default applies (5 × 0.5 = 2.5×B)', () => {
      const r = build(undefined);
      // weight = A.out ratio(5) [no wire override] × B.in prob(0.5) = 2.5 ⇒ response(A) = 10 + 2.5×100 = 260
      expect(r.get('A')).toBeCloseTo(260, 6);
    });
  });

  // ── (c) THE SACRED PIN: with no transform, the new weighted math reduces EXACTLY to today's plain sum ──────────
  it('with the transform removed, the analytic response equals the plain unweighted sum (todays value, computed independently)', () => {
    // A DIFFERENT db sizing than (a): removing the ratio(0.2) sends db the FULL 1000 req/s, so db must be sized to
    // comfortably serve it (default concurrency 100 ⇒ capacity 2000 req/s) — else it saturates (ρ≥1 ⇒ ∞), which
    // would make the "plain sum" degenerate to ∞ and defeat the point of this pin (a genuine, finite equality).
    const instancesNoTransform: Instance[] = [
      { id: 'client', type: 'client.web', config: { throughput: CLIENT_RPS } },
      { id: 'svc', type: 'compute.service' },
      { id: 'cache', type: 'cache.redis' },
      { id: 'db', type: 'db.postgres' }, // default concurrency 100 ⇒ capacity 2000 req/s ≫ 1000 offered
    ];
    const wiresNoTransform: Wire[] = [
      { from: ['client', 'out'], to: ['svc', 'in'] },
      { from: ['svc', 'cache'], to: ['cache', 'in'] },
      { from: ['svc', 'db'], to: ['db', 'in'] }, // no transform ⇒ full rate reaches db too
    ];
    const g = instantiate(allManifests, instancesNoTransform, wiresNoTransform);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: typeof keys.throughput) => ev.value.value(NodeId(id), k);
    const q = nodeQueues(g.value, value);

    // Independently reconstruct "today's" plain sum from each node's OWN sojourn (nodeQueues), never by re-reading
    // responseLatency's own output: response(svc) = own(svc) + response(cache) + response(db), and cache/db are
    // both leaves (their response IS their own sojourn — no further sync children).
    const svcOwn = q.get('svc')?.sojournMs as number;
    const cacheOwn = q.get('cache')?.sojournMs as number;
    const dbOwn = q.get('db')?.sojournMs as number;
    expect(Number.isFinite(svcOwn) && Number.isFinite(cacheOwn) && Number.isFinite(dbOwn)).toBe(true);
    const expectedPlainSum = svcOwn + cacheOwn + dbOwn;

    const analytic = responseLatency(g.value, value, q).get('svc') as number;
    expect(analytic).toBeCloseTo(expectedPlainSum, 6);
  });
});
