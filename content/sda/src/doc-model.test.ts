import { describe, expect, it } from 'vitest';
import { NodeId, type Key } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import {
  buildDocModel,
  instantiate,
  manifests,
  allManifests,
  registry,
  keys,
  nodeQueues,
  realCumulativeLatency,
  realAwareVerdicts,
  SCOPE_SENTENCE,
  type AssumptionRow,
  type DocModel,
  type Instance,
  type Wire,
  type SectionKey,
} from './index';

// DOC MODEL — the pure DATA the two renderers consume. These tests pin the MECHANICAL
// provenance derivation (the heart, §3), the honest scope sentence, the absent-when-not-provided alternatives,
// the OWNER RULING (no out-of-domain section ever), and chart-series sanity (utilisation = the engine's ρ).

// The representative design used across the design-doc tests: client → API gateway → under-provisioned FaaS → SQL.
function build(instances: Instance[], wires: Wire[]) {
  const g = instantiate(manifests, instances, wires);
  if (!g.ok) throw new Error(JSON.stringify(g.error));
  const ev = evaluate(g.value, registry);
  if (!ev.ok) throw new Error(ev.error.join('; '));
  const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
  const q = nodeQueues(g.value, value);
  const verdicts = realAwareVerdicts(ev.value.verdicts, g.value, value, q);
  const model = buildDocModel({
    name: 'Checkout API',
    instances,
    wires,
    catalog: manifests,
    verdicts,
    value,
    realLatencyByNode: Object.fromEntries(realCumulativeLatency(g.value, value, q)),
    saturated: [...q].filter(([, nq]) => nq.rho >= 1).map(([id]) => id),
    tail: { p50: 40, p95: 120, p99: 260 },
  });
  return { model, value };
}

const instances: Instance[] = [
  { id: 'client', type: 'client.source' },
  { id: 'gw', type: 'gateway.api', config: { availability: 0.9995 } },
  { id: 'compute', type: 'compute.faas', config: { concurrency: 30 } },
  { id: 'db', type: 'db.sql', bands: [{ key: keys.throughput, band: { shape: 'minTargetMax', target: 1000 } }, { key: keys.availability, band: { shape: 'minTargetMax', min: 0.9999 } }] },
];
const wires: Wire[] = [
  { from: ['client', 'out'], to: ['gw', 'in'] },
  { from: ['gw', 'out'], to: ['compute', 'in'] },
  { from: ['compute', 'out'], to: ['db', 'in'] },
];

const find = (rows: readonly AssumptionRow[], where: string, label: string): AssumptionRow | undefined =>
  rows.find((r) => r.where === where && r.label === label);

describe('DocModel — structure & scope (owner ruling §6)', () => {
  const { model } = build(instances, wires);

  it('states the ONE honest scope sentence in the summary (never a filler section)', () => {
    expect(model.summary.scope).toBe(SCOPE_SENTENCE);
    expect(model.summary.scope).toContain('capacity, latency, availability, cost');
  });

  it('carries NO out-of-domain section — the section list is the in-domain canon only', () => {
    const canon: readonly SectionKey[] = ['summary', 'requirements', 'assumptions', 'architecture', 'capacity', 'simulation', 'reliability', 'cost', 'risks', 'glossary'];
    // every present section key is in the canon; NONE is security/rollout/organization (unrepresentable by type,
    // asserted here at runtime too — a belt-and-braces guard the owner ruling can never regress).
    for (const key of model.sectionOrder) expect(canon).toContain(key);
    for (const forbidden of ['security', 'rollout', 'organization', 'privacy', 'threat']) {
      expect(model.sectionOrder as readonly string[]).not.toContain(forbidden);
    }
  });

  it('omits the alternatives section when the caller passes none (no padding)', () => {
    expect(model.alternatives).toBeUndefined();
    expect(model.sectionOrder).not.toContain('alternatives');
  });

  it('includes the alternatives section ONLY when the caller supplies the data', () => {
    const g = instantiate(manifests, instances, wires);
    if (!g.ok) throw new Error('build failed');
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const withAlts = buildDocModel({
      name: 'Checkout API', instances, wires, catalog: manifests, verdicts: ev.value.verdicts, value,
      alternatives: [{ node: 'db', method: 'compare_options (same family, sized to the SLOs)', options: [{ type: 'db.postgres', label: 'PostgreSQL', costUsdMonth: 140, costDeltaUsdMonth: -60, meetsSlos: true, note: 'Multi-AZ' }] }],
    });
    expect(withAlts.alternatives).toBeDefined();
    expect(withAlts.alternatives?.sets[0]?.node).toBe('db');
    expect(withAlts.sectionOrder).toContain('alternatives');
  });

  it('a declared guarantee contribution rides the assumptions register with its provenance', () => {
    // the design's db.sql is a writer → declares consistency:strong; that contribution appears in the register.
    const { model } = build(instances, wires);
    const row = model.assumptions.find((r) => r.label === 'Guarantee: consistency' && r.where.startsWith('db'));
    expect(row).toBeDefined();
    expect(row?.display).toBe('consistency: strong'); // the token, verbatim (categorical, not a quantity)
    // provenance rides the source/est. data automatically — a writer's strong-read is an honest estimate.
    expect(row?.provenance === 'documented' || row?.provenance === 'estimate').toBe(true);
  });

  it('includes the guarantees section ONLY when the caller supplies guaranteeVerdicts (no padding)', () => {
    const { model: silent } = build(instances, wires);
    expect(silent.guarantees).toBeUndefined();
    expect(silent.sectionOrder).not.toContain('guarantees');

    const g = instantiate(manifests, instances, wires);
    if (!g.ok) throw new Error('build failed');
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const withGuarantees = buildDocModel({
      name: 'Checkout API', instances, wires, catalog: manifests, verdicts: ev.value.verdicts, value,
      guaranteeVerdicts: [{ source: 'producer', terminal: 'worker', dimension: 'ordering', required: 'per-key', computed: 'none', status: 'violation', rootCauseNode: 'q', remediation: 'switch q to queue.sqs.fifo' }],
    });
    expect(withGuarantees.guarantees).toBeDefined();
    expect(withGuarantees.guarantees?.rows[0]?.rootCauseNode).toBe('q');
    expect(withGuarantees.sectionOrder).toContain('guarantees');
  });

  it('carries the flow-scoped LAG rows on the capacity section ONLY when the caller supplies lagVerdicts (no padding)', () => {
    const { model: silent } = build(instances, wires);
    expect(silent.capacity.lag).toBeUndefined();

    const g = instantiate(manifests, instances, wires);
    if (!g.ok) throw new Error('build failed');
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const withLag = buildDocModel({
      name: 'Checkout API', instances, wires, catalog: manifests, verdicts: ev.value.verdicts, value,
      lagVerdicts: [{ source: 'producer', terminal: 'worker', maxMs: 2000, status: 'unknown', basis: 'unknown', lowerBoundMs: 50, note: 'run simulate for the true lag' }],
    });
    expect(withLag.capacity.lag).toHaveLength(1);
    expect(withLag.capacity.lag?.[0]?.maxMs).toBe(2000);
    expect(withLag.capacity.lag?.[0]?.status).toBe('unknown');
  });

  it('an end-to-end availability promise IS a NODE band on the terminal — judged against the terminal cumulative, counts as an SLO', () => {
    // The consolidation (flowPromises removed): an end-to-end availability floor is declared as a band on the
    // TERMINAL node (`db`), and is judged against value(db, availability) — the serial product over the whole path
    // (registry: availability aggregates `series:'product'`). One home, no separate path container.
    const g = instantiate(manifests, instances, wires);
    if (!g.ok) throw new Error('build failed');
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    // A floor the serial chain (client · gw 0.9995 · faas 0.9995 · db 0.9999 ≈ 0.9989) cannot reach ⇒ violation.
    const dbWithAvail = instances.map((i) => (i.id === 'db' ? { ...i, bands: [{ key: keys.availability, band: { shape: 'minTargetMax' as const, min: 0.9995 } }] } : i));
    const g2 = instantiate(manifests, dbWithAvail, wires);
    if (!g2.ok) throw new Error('build failed');
    const ev2 = evaluate(g2.value, registry);
    if (!ev2.ok) throw new Error(ev2.error.join('; '));
    const value2 = (id: string, k: Key): number | undefined => ev2.value.value(NodeId(id), k);
    const withNodeBand = buildDocModel({
      name: 'Checkout API', instances: dbWithAvail, wires, catalog: manifests, verdicts: ev2.value.verdicts, value: value2,
    });
    const row = withNodeBand.requirements.find((r) => r.node === 'db' && r.key === 'availability');
    expect(row).toBeDefined();
    expect(row?.scope).toBe('node'); // the terminal's cumulative IS the end-to-end availability — one home
    expect(row?.status).toBe('violation');
    // The computed column is the terminal's cumulative — the SAME cell value(db, availability) reads (one home).
    expect(row?.computedValue).toBeCloseTo(value('db', keys.availability) ?? NaN, 10);
    // A declared node band counts as an SLO exactly like throughput/latency (one-form), and its breach breaks
    // meetsAllSlos. Proof: the SAME design with `db` carrying NO band declares one fewer SLO — the availability
    // floor on the terminal adds exactly one. (The module-level `instances` already gives `db` its own bands, so it
    // is not a clean baseline for THIS band; strip them to isolate the +1 the availability floor contributes. The
    // pre-consolidation test compared against `build(instances)` because the retired flow promise was an ADDITIONAL
    // container ON TOP of `db`'s bands; consolidated, the promise IS `db`'s availability node band — the same slot,
    // never a +1 over a design that already declares it.)
    const dbNoBand = instances.map((i) => (i.id === 'db' ? { ...i, bands: [] } : i));
    const gBase = instantiate(manifests, dbNoBand, wires);
    if (!gBase.ok) throw new Error('build failed');
    const evBase = evaluate(gBase.value, registry);
    if (!evBase.ok) throw new Error(evBase.error.join('; '));
    const valueBase = (id: string, k: Key): number | undefined => evBase.value.value(NodeId(id), k);
    const baseline = buildDocModel({
      name: 'Checkout API', instances: dbNoBand, wires, catalog: manifests, verdicts: evBase.value.verdicts, value: valueBase,
    });
    expect(baseline.summary.slosDeclared).toBe(0); // db stripped of bands ⇒ no declared SLOs
    expect(withNodeBand.summary.slosDeclared).toBe(baseline.summary.slosDeclared + 1); // the availability band is the one SLO
    expect(withNodeBand.summary.meetsAllSlos).toBe(false);
  });
});

describe('DocModel — provenance derivation (§3, mechanical)', () => {
  const { model } = build(instances, wires);
  const a = model.assumptions;

  it('badges an instance override ≠ manifest default as ARCHITECT', () => {
    // gw availability was set to 0.9995; the manifest default is also 0.9995 (documented SLA) — so this is NOT an
    // override. compute.concurrency was set to 30 (manifest default 100) ⇒ a genuine architect override.
    const conc = find(a, 'compute', 'Concurrency');
    expect(conc?.provenance).toBe('architect');
    expect(conc?.value).toBe(30);
  });

  it('badges a documented manifest default (source URL) as DOCUMENTED and links it', () => {
    // gw throughput 10,000 rps is the documented API Gateway account throttle (untouched by the instance).
    const thr = find(a, 'gw', 'Throughput ceiling');
    expect(thr?.provenance).toBe('documented');
    expect(thr?.source).toContain('docs.aws.amazon.com');
  });

  it('badges an est.-marked manifest default as ESTIMATE', () => {
    // compute.faas perRequestDuration carries est: true (workload-dependent).
    const dur = find(a, 'compute', 'Per-request duration');
    expect(dur?.provenance).toBe('estimate');
  });

  it('badges the account-concurrency ceiling DOCUMENTED (a verdict-participating limit)', () => {
    const acct = find(a, 'compute', 'Account concurrency ceiling');
    expect(acct?.provenance).toBe('documented');
    expect(acct?.source).toContain('lambda');
  });

  it('lists a declared SLO band as an ARCHITECT assumption', () => {
    const slo = find(a, 'db', 'SLO: Throughput ceiling');
    expect(slo?.provenance).toBe('architect');
    expect(slo?.value).toBe(1000);
  });

  it('badges the deployment COST surcharge DOCUMENTED, sourced from the RDS pricing page (task-77)', () => {
    // A Multi-AZ Postgres carries `withDeploymentCost` → its cost is surcharged ≈2× (the billed standby). That
    // surcharge is a DOCUMENTED cost assumption sourced from the RDS PRICING page — a DIFFERENT source than the
    // deploymentMode row's SLA (which the AVAILABILITY rests on). Both rows must appear, each linking its own source.
    const inst: Instance[] = [
      { id: 'client', type: 'client.source', config: { throughput: 100 } },
      { id: 'pg', type: 'db.postgres', config: { deploymentMode: 1 } },
    ];
    const w: Wire[] = [{ from: ['client', 'out'], to: ['pg', 'in'] }];
    const g = instantiate(allManifests, inst, w);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const model2 = buildDocModel({ name: 'AZ', instances: inst, wires: w, catalog: allManifests, verdicts: ev.value.verdicts, value });
    const surcharge = model2.assumptions.find((r) => r.where === 'pg' && r.label === 'Deployment cost surcharge');
    expect(surcharge?.provenance).toBe('documented');
    expect(surcharge?.source).toBe('https://aws.amazon.com/rds/pricing/');
    expect(surcharge?.value).toBe(2); // RDS Multi-AZ standby billed ≈ 2×
    expect(surcharge?.display).toBe('×2 (Multi-AZ)');
    // The deploymentMode row still links the SLA (its availability provenance) — the two sources stay distinct.
    const mode = model2.assumptions.find((r) => r.where === 'pg' && r.label === 'Deployment mode');
    expect(mode?.provenance).toBe('documented');
    expect(mode?.source).toBe('https://aws.amazon.com/rds/sla/');
  });

  it('never pads: an inert zero default (assumedRps / retry) does not appear as a row', () => {
    expect(find(a, 'client', 'Offered traffic')).toBeUndefined(); // client has no assumedRps set (throughput preset drives it)
    expect(a.some((r) => r.label === 'Retry count')).toBe(false);
  });

  it('surfaces a MANIFEST-level flow transform (the closed leftover) badged estimate, at manifest level', () => {
    // cdn.cloudfront's OUT port carries a manifest-default ratio(0.1) — a manifest-level transform. Wire it here.
    const inst: Instance[] = [
      { id: 'client', type: 'client.source' },
      { id: 'cdn', type: 'cdn.cloudfront' },
      { id: 'origin', type: 'compute.service' },
    ];
    const w: Wire[] = [
      { from: ['client', 'out'], to: ['cdn', 'in'] },
      { from: ['cdn', 'out'], to: ['origin', 'in'] },
    ];
    const g = instantiate(allManifests, inst, w);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const model2 = buildDocModel({ name: 'CDN', instances: inst, wires: w, catalog: allManifests, verdicts: ev.value.verdicts, value });
    const t = model2.assumptions.find((r) => r.label === 'Flow transform' && r.where.startsWith('cdn'));
    expect(t).toBeDefined();
    expect(t?.transformLevel).toBe('manifest');
    expect(t?.provenance).toBe('estimate');
  });

  it('badges a WIRE-level transform architect, at wire level', () => {
    const inst: Instance[] = [
      { id: 'client', type: 'client.source', config: { throughput: 1000 } },
      { id: 'svc', type: 'compute.service', config: { concurrency: 100000 } },
      { id: 'db', type: 'db.postgres', config: { concurrency: 100000 } },
    ];
    const w: Wire[] = [
      { from: ['client', 'out'], to: ['svc', 'in'] },
      { from: ['svc', 'db'], to: ['db', 'in'], transform: { kind: 'ratio', value: 0.2 } }, // cache-aside miss ratio on the wire
    ];
    const g = instantiate(allManifests, inst, w);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const model2 = buildDocModel({ name: 'CacheAside', instances: inst, wires: w, catalog: allManifests, verdicts: ev.value.verdicts, value });
    const t = model2.assumptions.find((r) => r.label === 'Flow transform' && r.transformLevel === 'wire');
    expect(t).toBeDefined();
    expect(t?.provenance).toBe('architect');
    expect(t?.value).toBe(0.2);
  });
});

describe('DocModel — chart series sanity', () => {
  const { model, value } = build(instances, wires);

  it('the utilisation series matches the engine ρ = offered / capacity per tier', () => {
    const util = model.capacity.utilizationSeries;
    expect(util.points.length).toBeGreaterThan(0);
    // compute is under-provisioned (concurrency 30 ⇒ 600 rps capacity), offered ~1000 ⇒ ρ ≈ 1.67.
    const computePoint = util.points.find((p) => p.label === 'compute');
    expect(computePoint).toBeDefined();
    const capacity = value('compute', keys.throughput) ?? 0; // served (clamped) — the tier's own capacity
    // the series value is offered/served; recompute offered from the gateway's served throughput (its predecessor).
    const offered = value('gw', keys.throughput) ?? 0;
    expect(capacity).toBeGreaterThan(0);
    expect(computePoint?.value).toBeCloseTo(offered / capacity, 5);
    expect(computePoint?.value).toBeGreaterThanOrEqual(1); // saturated
  });

  it('the cost breakdown series equals the per-component own cost (sorted, non-zero)', () => {
    const series = model.cost.perComponentSeries;
    // db is the priciest own-cost tier in this design.
    expect(series.points[0]?.label).toBe('db');
    expect(series.points.every((p) => p.value !== 0)).toBe(true);
    // sorted descending
    for (let i = 1; i < series.points.length; i++) {
      expect((series.points[i - 1] as { value: number }).value).toBeGreaterThanOrEqual((series.points[i] as { value: number }).value);
    }
  });

  it('the latency waterfall lists per-tier own latency along the busiest flow', () => {
    const wf = model.capacity.latencyWaterfall;
    expect(wf.points.length).toBeGreaterThan(0);
    expect(wf.unit).toBe('ms');
  });

  it('the per-tier utilisation ρ is TRANSFORM-AWARE: a wire-split target reads the arriving share, not the raw predecessor rate', () => {
    // A gateway that splits 0.3 of its 1,000 rps to a target must show that target's ρ against the 300 rps that
    // ACTUALLY arrive — not the raw 1,000 (which would falsely read ρ ≈ 3× and contradict its saturation state).
    const inst: Instance[] = [
      { id: 'client', type: 'client.source', config: { throughput: 1000 } },
      { id: 'gw', type: 'gateway.api' },
      { id: 'svc', type: 'compute.service', config: { concurrency: 100000 } }, // ample capacity ⇒ NOT saturated
    ];
    const w: Wire[] = [
      { from: ['client', 'out'], to: ['gw', 'in'] },
      { from: ['gw', 'out'], to: ['svc', 'in'], transform: { kind: 'prob', value: 0.3 } }, // 30% split on the wire
    ];
    const g = instantiate(allManifests, inst, w);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const q = nodeQueues(g.value, value);
    const m2 = buildDocModel({
      name: 'Split', instances: inst, wires: w, catalog: allManifests,
      verdicts: realAwareVerdicts(ev.value.verdicts, g.value, value, q), value,
      saturated: [...q].filter(([, nq]) => nq.rho >= 1).map(([id]) => id),
    });
    const svc = m2.capacity.tiers.find((t) => t.node === 'svc');
    expect(svc).toBeDefined();
    // THE FIX: offered = 0.3 × gw served (≈ 300), NOT the raw 1,000 predecessor rate. Before the fix this read the
    // full 1,000 and ρ ≈ 3.3 while the tier had headroom — the false-ρ the capacity table used to show for a split.
    const gwServed = value('gw', keys.throughput) ?? 0;
    const served = value('svc', keys.throughput) ?? 0;
    expect(svc?.offeredRps).toBeCloseTo(0.3 * gwServed, 5);
    expect(svc?.offeredRps).toBeLessThan(gwServed); // strictly less than the raw predecessor rate (the split applied)
    // ρ = offered / served ≤ 1 and NOT saturated: the ρ column and the saturation state now AGREE (no false ρ ≈ 3.3).
    expect(svc?.utilization).toBeCloseTo((svc?.offeredRps ?? 0) / served, 5);
    expect(svc?.utilization).toBeLessThanOrEqual(1 + 1e-9);
    expect(svc?.saturated).toBe(false);
  });
});

describe('DocModel — risks & simulation honesty', () => {
  it('records violations/warnings as risks with a fix, and every unknown with what resolves it', () => {
    const { model } = build(instances, wires);
    // the availability floor is violated (series product below 99.99%) and the throughput target is a warning.
    expect(model.risks.items.some((r) => r.severity === 'violation')).toBe(true);
    // an unknown (e.g. a tail/goodput SLO with no sim) carries a resolvedBy hint — assert the shape holds when present.
    for (const it of model.risks.items) {
      if (it.severity === 'unknown') expect(it.resolvedBy).toBeTruthy();
    }
  });

  it('omits the retry story entirely when no retry policy is declared', () => {
    const { model } = build(instances, wires);
    expect(model.simulation.retry).toBeUndefined();
    expect(model.simulation.tail).toEqual({ p50: 40, p95: 120, p99: 260 });
  });

  it('includes the retry story ONLY with a declared policy AND a measured outcome', () => {
    const inst: Instance[] = [
      { id: 'client', type: 'client.source', config: { throughput: 2000, timeoutMs: 200, retryCount: 2, retryBackoffMs: 20 } },
      { id: 'svc', type: 'compute.faas', config: { concurrency: 30 } },
    ];
    const w: Wire[] = [{ from: ['client', 'out'], to: ['svc', 'in'] }];
    const g = instantiate(manifests, inst, w);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const model = buildDocModel({
      name: 'Retrying', instances: inst, wires: w, catalog: manifests, verdicts: ev.value.verdicts, value,
      retry: { goodputRps: 600, errorRate: 40, amplification: 1.7 },
    });
    expect(model.simulation.retry?.goodputRps).toBe(600);
    expect(model.simulation.retry?.callers[0]?.node).toBe('client');
    expect(model.simulation.retry?.callers[0]?.timeoutMs).toBe(200);
  });
});

describe('DocModel — purity', () => {
  it('is a pure function of the input (no clock): two builds are deeply equal', () => {
    const a = build(instances, wires).model;
    const b = build(instances, wires).model;
    const stable = (m: DocModel) => JSON.stringify(m);
    expect(stable(a)).toBe(stable(b));
  });

  it('carries the generation timestamp as an INPUT, not a clock read', () => {
    const g = instantiate(manifests, instances, wires);
    if (!g.ok) throw new Error('build failed');
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const model = buildDocModel({ name: 'X', instances, wires, catalog: manifests, verdicts: ev.value.verdicts, value, generatedAt: '2026-07-03T00:00:00Z' });
    expect(model.generatedAt).toBe('2026-07-03T00:00:00Z');
  });
});
