import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { StationId, simulate } from '@sda/engine-sim';
import { instantiate, allManifests, registry, keys, toQueueingNetwork, type Instance, type Wire } from './index';

// FLOW TRANSFORMS end-to-end (doc: flow-transformations) — the OWNER'S example, on real catalog components.
// A report generator emits ONE "done" event per request but ONE HUNDRED log lines: an OUT-port ratio(100) on
// the log path. The log tier must see 100× the request rate (its verdict fires), while the events tier sees 1×.
// Then an aggregator's IN-port batch(100) collapses 100:1. Instance overrides drive it (the R2 catalog work is
// separate); a document round-trip must keep the transforms; and the DES must carry the multiplicity.

describe('flow transforms e2e — report generator: 1 event, 100 log lines', () => {
  const CLIENT_RPS = 1000;
  // client → gen (compute.service); gen.out → events sink (1×), gen.db → logs sink (ratio 100 on the log path).
  const instances: Instance[] = [
    { id: 'client', type: 'client.web', config: { throughput: CLIENT_RPS } },
    // gen relays; the OWNER declares "100 log lines per request" as a per-instance transform on the log out-port.
    { id: 'gen', type: 'compute.service', config: { concurrency: 100000 }, transforms: { db: { kind: 'ratio', value: 100 } } },
    { id: 'events', type: 'compute.service', config: { concurrency: 100000 } }, // fast events sink (1× load)
    { id: 'logs', type: 'db.postgres', config: { concurrency: 50 } }, // log store; capacity ≈ 50/50ms = 1000 req/s
  ];
  const wires: Wire[] = [
    { from: ['client', 'out'], to: ['gen', 'in'] }, // http → service in
    { from: ['gen', 'out'], to: ['events', 'in'] }, // https → service in (events, ratio 1)
    { from: ['gen', 'db'], to: ['logs', 'in'] }, // postgresql → postgres in (logs, ratio 100)
  ];

  const built = instantiate(allManifests, instances, wires);
  if (!built.ok) throw new Error(`build failed: ${JSON.stringify(built.error)}`);
  const graph = built.value;

  it('the events tier sees 1× (1000/s) but the log tier sees 100× the request rate', () => {
    const r = evaluate(graph, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    expect(r.value.converged).toBe(true);
    // events: ratio 1 (no transform) ⇒ the full 1000 req/s, served by the fast sink.
    expect(r.value.value(NodeId('events'), keys.throughput)).toBeCloseTo(CLIENT_RPS, 6);
    // logs: the OUT-port ratio(100) means 100 000 req/s is OFFERED to the log store — which caps at ~1000 and
    // OVERFLOWS on the rest. Formerly SDA showed 1000/s on this edge and the overflow was invisible (the bug).
    const logsServed = r.value.value(NodeId('logs'), keys.throughput) ?? 0;
    const logsOverflow = r.value.value(NodeId('logs'), keys.overflow) ?? 0;
    expect(logsServed).toBeCloseTo(1000, 0); // capacity ≈ 1000 req/s
    expect(logsOverflow).toBeGreaterThan(90000); // ~100000 offered − ~1000 served ⇒ massive throttle (was 0 before)
  });

  it("the log tier's overflow verdict FIRES on the transformed load (it used to lie)", () => {
    const r = evaluate(graph, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    const v = r.value.verdicts.find((x) => x.scope === NodeId('logs') && x.key === keys.overflow);
    expect(v, 'overflow verdict at logs').toBeDefined();
    expect(v?.status).toBe('violation'); // overflow > 0 breaches the ≤ 0 band — the honest signal
  });

  it('DES carries the ratio: the log station is fed a multiplicity-100 route edge', () => {
    const qn = toQueueingNetwork(graph);
    const genRoutes = qn.routing.get(qn.stations.find((s) => String(s.id) === 'gen')?.id ?? ('gen' as never)) ?? [];
    const toLogs = genRoutes.find((e) => String(e.to) === 'logs');
    const toEvents = genRoutes.find((e) => String(e.to) === 'events');
    expect(toLogs?.multiplicity).toBe(100); // 100 jobs downstream per completion
    expect(toEvents?.multiplicity ?? 1).toBe(1); // events path unchanged
  });
});

describe('flow transforms e2e — aggregator IN-port batch(100) collapses 100:1', () => {
  it('1000 req/s in ⇒ the aggregator intakes 10 req/s (1/100)', () => {
    const instances: Instance[] = [
      { id: 'client', type: 'client.web', config: { throughput: 1000 } },
      // an aggregator that batches 100:1 from ANY sender — the transform is on ITS in-port (receiver owns it).
      { id: 'agg', type: 'compute.service', config: { concurrency: 100000 }, transforms: { in: { kind: 'batch', value: 100 } } },
    ];
    const wires: Wire[] = [{ from: ['client', 'out'], to: ['agg', 'in'] }];
    const built = instantiate(allManifests, instances, wires);
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const r = evaluate(built.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    expect(r.value.value(NodeId('agg'), keys.throughput)).toBeCloseTo(10, 6);
  });
});

describe('flow transforms e2e — instance override beats the manifest default', () => {
  it('an instance transform on a port overrides whatever the manifest would apply', () => {
    // compute.service's `db` port has NO manifest transform (identity). We override it to ratio(5) and see 5×.
    const base: Instance[] = [
      { id: 'client', type: 'client.web', config: { throughput: 200 } },
      { id: 'svc', type: 'compute.service', config: { concurrency: 100000 } },
      { id: 'store', type: 'db.postgres', config: { concurrency: 100000 } },
    ];
    const wires: Wire[] = [
      { from: ['client', 'out'], to: ['svc', 'in'] },
      { from: ['svc', 'db'], to: ['store', 'in'] },
    ];
    const plain = instantiate(allManifests, base, wires);
    if (!plain.ok) throw new Error(JSON.stringify(plain.error));
    const rPlain = evaluate(plain.value, registry);
    if (!rPlain.ok) throw new Error(rPlain.error.join('; '));
    expect(rPlain.value.value(NodeId('store'), keys.throughput)).toBeCloseTo(200, 6); // identity: 1×

    const overridden = base.map((i) => (i.id === 'svc' ? { ...i, transforms: { db: { kind: 'ratio', value: 5 } as const } } : i));
    const withOv = instantiate(allManifests, overridden, wires);
    if (!withOv.ok) throw new Error(JSON.stringify(withOv.error));
    const rOv = evaluate(withOv.value, registry);
    if (!rOv.ok) throw new Error(rOv.error.join('; '));
    expect(rOv.value.value(NodeId('store'), keys.throughput)).toBeCloseTo(1000, 6); // 200 × 5
  });

  it('an override naming a non-existent port is an honest InstantiateError (never a silent drop)', () => {
    const bad = instantiate(
      allManifests,
      [{ id: 'svc', type: 'compute.service', config: { assumedRps: 10 }, transforms: { nope: { kind: 'ratio', value: 2 } } }],
      [],
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.some((e) => e.kind === 'unknown-transform-port')).toBe(true);
  });
});

describe('flow transforms e2e — the STRESS-CAMPAIGN case: a per-WIRE routing split (70/30)', () => {
  // The 2026-07-02 stress campaign bug: ONE out port feeding TWO edges broadcast the FULL rate to each (pub/sub
  // semantics), so a 70/30 catalog/checkout split was inexpressible and checkout was FALSELY overloaded. The fix:
  // a per-WIRE transform. Here a gateway at 2000 rps fans its single `out` port to catalog (wire prob 0.7) and
  // checkout (wire prob 0.3). Catalog must see 1400, checkout 600 — the true split — with NO false overload, and
  // the two shares must SUM to the offered 2000 (the whole is conserved).
  const GATEWAY_RPS = 2000;
  const instances: Instance[] = [
    // a gateway SERVICE that originates 2000 rps and fans it out; sized to serve the whole 2000 (so it is the SOURCE
    // of the split, not itself a bottleneck). A compute.service is a DES station (concurrency + service time), so
    // the DES cross-check sees it route its served flow downstream.
    { id: 'gateway', type: 'compute.service', config: { assumedRps: GATEWAY_RPS, concurrency: 200, perRequestDuration: 50 } }, // ≈ 4000/s capacity
    // both services sized to comfortably serve their SHARE but NOT the whole 2000 — so a false broadcast WOULD overload them.
    { id: 'catalog', type: 'compute.service', config: { concurrency: 100, perRequestDuration: 50 } }, // ≈ 2000/s capacity
    { id: 'checkout', type: 'compute.service', config: { concurrency: 40, perRequestDuration: 50 } }, // ≈ 800/s — 600 fits, 2000 would NOT
  ];
  // ONE out port (`gateway.out`) feeds BOTH services — the per-PORT transform cannot split it; the WIRES do.
  const wires: Wire[] = [
    { from: ['gateway', 'out'], to: ['catalog', 'in'], transform: { kind: 'prob', value: 0.7 } },
    { from: ['gateway', 'out'], to: ['checkout', 'in'], transform: { kind: 'prob', value: 0.3 } },
  ];
  const built = instantiate(allManifests, instances, wires);
  if (!built.ok) throw new Error(`build failed: ${JSON.stringify(built.error)}`);
  const graph = built.value;

  it('catalog sees 1400 of 2000, checkout 600 — the whole is preserved, no false overload', () => {
    const r = evaluate(graph, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    expect(r.value.converged).toBe(true);
    const catalog = r.value.value(NodeId('catalog'), keys.throughput) ?? 0;
    const checkout = r.value.value(NodeId('checkout'), keys.throughput) ?? 0;
    expect(catalog).toBeCloseTo(1400, 0); // 2000 × 0.7 — served in full (capacity ≈ 2000)
    expect(checkout).toBeCloseTo(600, 0); //  2000 × 0.3 — served in full (capacity ≈ 800; 600 fits)
    expect(catalog + checkout).toBeCloseTo(GATEWAY_RPS, 0); // the split conserves the offered load

    // NO false overload: checkout would drop ~1200/s under the OLD broadcast (2000 offered, ~800 capacity); with
    // the wire split it takes only its 600 share, so its overflow verdict must NOT fire.
    const overflow = r.value.value(NodeId('checkout'), keys.overflow) ?? 0;
    expect(overflow).toBeCloseTo(0, 0);
    const v = r.value.verdicts.find((x) => x.scope === NodeId('checkout') && x.key === keys.overflow);
    expect(v?.status ?? 'ok').not.toBe('violation');
  });

  it('DES cross-check: catalog completions ≈ 0.7 and checkout ≈ 0.3 of the gateway completions (mean rates agree)', () => {
    const net = toQueueingNetwork(graph);
    // the two route edges off the gateway carry their wire shares as multiplicity
    const gwRoutes = net.routing.get(net.stations.find((s) => String(s.id) === 'gateway')?.id ?? ('gateway' as never)) ?? [];
    expect(gwRoutes.find((e) => String(e.to) === 'catalog')?.multiplicity).toBeCloseTo(0.7, 6);
    expect(gwRoutes.find((e) => String(e.to) === 'checkout')?.multiplicity).toBeCloseTo(0.3, 6);

    const r = simulate(net, { seed: 424242, warmupCompletions: 5000, measureCompletions: 80000 });
    const comp = (id: string): number => r.stations.find((s) => s.id === StationId(id))?.completions ?? 0;
    const gw = comp('gateway');
    expect(gw).toBeGreaterThan(0);
    expect(Math.abs(comp('catalog') / gw - 0.7) / 0.7).toBeLessThan(0.05); // DES mean matches the 0.7 split
    expect(Math.abs(comp('checkout') / gw - 0.3) / 0.3).toBeLessThan(0.06); // and the 0.3 split
  });
});

describe('flow transforms — scalar ⇄ DES cross-check on a ratio chain', () => {
  it('the DES downstream/upstream completion ratio matches the scalar ratio (mean rates agree)', () => {
    // client → gen (fast) -[out-port ratio 5]-> sink (fast). Scalar: sink offered = 5 × gen served. DES: sink
    // should complete ≈ 5× gen's completions. Both engines must tell the same story about the transformed rate.
    const RATIO = 5;
    const instances: Instance[] = [
      { id: 'client', type: 'client.web', config: { throughput: 200 } },
      { id: 'gen', type: 'compute.service', config: { concurrency: 100000 }, transforms: { out: { kind: 'ratio', value: RATIO } } },
      { id: 'sink', type: 'compute.service', config: { concurrency: 100000 } }, // effectively unbounded ⇒ serves all
    ];
    const wires: Wire[] = [
      { from: ['client', 'out'], to: ['gen', 'in'] },
      { from: ['gen', 'out'], to: ['sink', 'in'] },
    ];
    const built = instantiate(allManifests, instances, wires);
    if (!built.ok) throw new Error(JSON.stringify(built.error));

    // scalar: sink throughput = 200 × 5 = 1000 (its capacity is huge, so all served)
    const scalar = evaluate(built.value, registry);
    if (!scalar.ok) throw new Error(scalar.error.join('; '));
    expect(scalar.value.value(NodeId('sink'), keys.throughput)).toBeCloseTo(1000, 6);

    // DES: sink completions ≈ RATIO × gen completions
    const net = toQueueingNetwork(built.value);
    const r = simulate(net, { seed: 909, warmupCompletions: 5000, measureCompletions: 60000 });
    const comp = (id: string): number => r.stations.find((s) => s.id === StationId(id))?.completions ?? 0;
    const genC = comp('gen');
    const sinkC = comp('sink');
    expect(genC).toBeGreaterThan(0);
    expect(Math.abs(sinkC / genC - RATIO) / RATIO).toBeLessThan(0.05); // the DES mean multiplicity matches the scalar ratio
  });
});

describe('flow transforms e2e — the cdn.cloudfront MANIFEST DEFAULT (R3 catalog audit)', () => {
  // A CDN's whole point is that the origin does NOT see 100% of client traffic. cdn.cloudfront ships an est.-marked
  // OUT-port ratio(0.1) (≈90% cache-hit), so OUT OF THE BOX the origin behind it is offered ~0.1× the client rate —
  // no per-instance transform required. This is the one non-identity catalog default; it must be visible AND
  // overridable (the architect can pin an all-dynamic distribution back to 1:1).
  const CLIENT_RPS = 1000;
  const wires: Wire[] = [
    { from: ['client', 'out'], to: ['cdn', 'in'] },
    { from: ['cdn', 'out'], to: ['origin', 'in'] },
  ];
  // an origin sized to serve the full client rate, so what it SEES (its offered throughput) is the honest test signal.
  const originBig = { id: 'origin', type: 'compute.service', config: { concurrency: 1_000_000 } } as const;

  it('out of the box, the origin is offered ~0.1× the client traffic (identity would be a systematic lie)', () => {
    const instances: Instance[] = [{ id: 'client', type: 'client.web', config: { throughput: CLIENT_RPS } }, { id: 'cdn', type: 'cdn.cloudfront' }, originBig];
    const built = instantiate(allManifests, instances, wires);
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const r = evaluate(built.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    // 90% cache-hit ⇒ the origin sees ~100 req/s of the 1000, not 1000 (the CDN default ratio(0.1) at work).
    expect(r.value.value(NodeId('origin'), keys.throughput)).toBeCloseTo(CLIENT_RPS * 0.1, 6);
  });

  it('a per-instance override ratio(1) restores 1:1 pass-through (an all-dynamic / non-cacheable distribution)', () => {
    const instances: Instance[] = [
      { id: 'client', type: 'client.web', config: { throughput: CLIENT_RPS } },
      { id: 'cdn', type: 'cdn.cloudfront', transforms: { out: { kind: 'ratio', value: 1 } } }, // pin back to full pass-through
      originBig,
    ];
    const built = instantiate(allManifests, instances, wires);
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const r = evaluate(built.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    expect(r.value.value(NodeId('origin'), keys.throughput)).toBeCloseTo(CLIENT_RPS, 6); // the override beats the manifest default
  });

  it('the DES carries the default: the origin route edge is thinned to multiplicity 0.1', () => {
    const instances: Instance[] = [{ id: 'client', type: 'client.web', config: { throughput: CLIENT_RPS } }, { id: 'cdn', type: 'cdn.cloudfront' }, originBig];
    const built = instantiate(allManifests, instances, wires);
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const qn = toQueueingNetwork(built.value);
    const cdnRoutes = qn.routing.get(qn.stations.find((s) => String(s.id) === 'cdn')?.id ?? ('cdn' as never)) ?? [];
    expect(cdnRoutes.find((e) => String(e.to) === 'origin')?.multiplicity).toBeCloseTo(0.1, 6);
  });
});
