import { describe, expect, it } from 'vitest';
import { NodeId, type Key } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { generateDesignDoc, instantiate, manifests, registry, keys, nodeQueues, realCumulativeLatency, responseLatency, realAwareVerdicts, type Instance, type Wire } from './index';

// The design-doc generator turns the SAME verified model the e2e test solves (client → API gateway →
// under-provisioned serverless → SQL DB) into the architect's Markdown deliverable. The document must
// carry the COMPUTED numbers (never hand-entered) and the doc-7 sections, so a single source serves both
// the human export and the AI `generate_doc`.
describe('design-doc generator (from the verified model)', () => {
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

  const built = instantiate(manifests, instances, wires);
  if (!built.ok) throw new Error('graph build failed');
  const r = evaluate(built.value, registry);
  if (!r.ok) throw new Error(r.error.join('; '));

  const doc = generateDesignDoc({
    name: 'Checkout API',
    instances,
    wires,
    descriptions: { compute: 'runs the checkout command' },
    verdicts: r.value.verdicts,
    value: (id, k) => r.value.value(NodeId(id), k),
  });

  it('emits the doc-7 sections', () => {
    for (const heading of ['# Design Document — Checkout API', '## 1. Context', '## 3. Promises', '## 4. Capacity', '## 5. High-level architecture', '## 6. Cost analysis', '## 7. Reliability', '## 8. Scalability & bottleneck analysis', '## 10. Security & privacy', '## Completeness']) {
      expect(doc).toContain(heading);
    }
  });

  it('renders MEASURED latency only — the analytic per-tier response table is gone (owner ruling: measured-or-nothing)', () => {
    const value = (id: string, k: Key): number | undefined => r.value.value(NodeId(id), k);
    const resp = responseLatency(built.value, value, nodeQueues(built.value, value));
    // Even fed the ANALYTIC per-tier response latencies, the doc renders NO "Response latency per tier" table — the
    // analytic scalar `responseLatency` must appear as a shown value on no surface.
    const docAnalytic = generateDesignDoc({ name: 'Checkout API', instances, wires, verdicts: r.value.verdicts, value, responseLatencyByNode: Object.fromEntries(resp) });
    expect(docAnalytic).not.toContain('Response latency per tier');
    // Fed the MEASURED busiest-flow tail, the §4 flow latency cell shows that measured p50 (single flow ⇒ the design's
    // whole sojourn), whole ms — never an analytic value, and the header drops the "(real)" qualifier.
    const docMeasured = generateDesignDoc({ name: 'Checkout API', instances, wires, verdicts: r.value.verdicts, value, tail: { p50: 37, p95: 90, p99: 150 } });
    expect(docMeasured).toContain('| Flow | Throughput | Latency | Availability | Branch cost |');
    expect(docMeasured).toMatch(/client → db \|.*37 ms/);
    // With NO measurement at all, the cell reads "no data" — never a fabricated or analytic number.
    expect(doc).toMatch(/client → db \|.*no data/);
  });

  it('fills the promises table with the COMPUTED numbers and verified status', () => {
    // throughput SLO target 1000, computed 600 (bottlenecked compute), so a soft-target warning.
    expect(doc).toMatch(/db \| Throughput \| target 1000.*\| 600 req\/s \| ⚠ warning/);
    // availability SLO ≥ 99.99%, computed 99.89% (0.9995·0.9995·0.9999 series product), below the floor.
    expect(doc).toContain('| db | Availability | ≥ 99.99');
  });

  it('produces a capacity table, a cost table, and a Mermaid C4 view from the model', () => {
    expect(doc).toContain('| Flow | Throughput | Latency | Availability | Branch cost |');
    expect(doc).toContain('client → db'); // the one request flow, source → terminal
    expect(doc).toContain('| Compute / storage / managed | $295 |'); // 50 + 30·1.5 + 200, the compute line
    expect(doc).toContain('Data transfer (egress)'); // the most-missed line, now modelled
    expect(doc).toContain('Total (on-demand)');
    expect(doc).toContain('With 1-yr commitment'); // committed-pricing scenario
    expect(doc).toContain('```mermaid');
    expect(doc).toContain('flowchart LR');
    expect(doc).toMatch(/n\d+ --> n\d+/); // a sync relationship
  });

  it('reports reliability against the AWS nines tier, with the sourced remedy', () => {
    expect(doc).toContain('reliability-pillar/availability.html'); // the cited source
    expect(doc).toMatch(/99\.8\d%|99\.9\d%/); // the computed end-to-end availability
    expect(doc).toContain('INDEPENDENT redundancy'); // the AWS-documented remedy (target missed)
  });

  it('names the bottleneck with its cause and a remediation', () => {
    expect(doc).toMatch(/Throughput at db \(600 req\/s\)/);
    expect(doc).toContain('Fix:');
  });

  it('flags the hallmark sections it does not model as author-required (doc-7 gating)', () => {
    expect(doc).toContain('⚠ author required');
    expect(doc).toContain('Security & privacy | ⚠ author required');
  });

  // BO-2 (autonomous test loop): the generated doc must NEVER launder a saturated design into a clean number.
  // Fed the real-aware inputs (queueing latency + saturation + tail), a tier at ρ≥1 must read ∞ / "saturated"
  // and §8 must name the bottleneck — not print the ideal latency and claim "no bottleneck or SLO breach".
  it('is queueing-aware: a saturated tier reads ∞ / "saturated" and is named as the bottleneck (never "no breach")', () => {
    const inst: Instance[] = [
      { id: 'client', type: 'client.source', config: { throughput: 5000 } },
      { id: 'svc', type: 'compute.faas', config: { concurrency: 50 }, bands: [{ key: keys.latency, band: { shape: 'minTargetMax', max: 500 } }] },
    ];
    const w: Wire[] = [{ from: ['client', 'out'], to: ['svc', 'in'] }];
    const g = instantiate(manifests, inst, w);
    if (!g.ok) throw new Error('build failed');
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const val = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);

    // svc capacity = 50 / 0.05s = 1000 rps; offered 5000 ⇒ ρ = 5 ⇒ real latency unbounded.
    const q = nodeQueues(g.value, val);
    expect(q.get('svc')?.sojournMs).toBe(Infinity);
    const verdicts = realAwareVerdicts(ev.value.verdicts, g.value, val);
    expect(verdicts.some((v) => String(v.scope) === 'svc' && String(v.key) === 'latency' && v.status === 'violation')).toBe(true);

    const md = generateDesignDoc({
      name: 'Saturated',
      instances: inst,
      wires: w,
      verdicts,
      value: val,
      realLatencyByNode: Object.fromEntries(realCumulativeLatency(g.value, val, q)),
      saturated: [...q].filter(([, nq]) => nq.rho >= 1).map(([id]) => id),
      tail: { p50: 100, p95: 800, p99: 1200 },
    });

    // §4 flow latency is the MEASURED sojourn now (single flow ⇒ the busiest-flow p50) — a real number, never the
    // analytic ∞ laundered in and never the ideal (owner ruling: single-truth measured-or-nothing). The saturation
    // honesty moves to the Saturation & overflow table + §8 (asserted just below).
    expect(md).toMatch(/client → svc \|.*100 ms/); // the measured p50 in the flow cell, whole ms
    expect(md).not.toContain('∞ ms — saturated'); // the analytic saturated-latency cell no longer exists
    expect(md).toContain('Saturation & overflow'); // the bottleneck section, populated — the tier is still named honestly
    expect(md).toContain('p99 1,200 ms'); // the tail a reviewer judges by (BO-4) — whole ms with thousands separator
    expect(md).not.toContain('no bottleneck or SLO breach detected'); // §8 must be honest
    expect(md).not.toContain('No tier is saturated'); // §4 healthy claim must be absent
  });

  // FLOW TRANSFORMS in the deliverable (R2): the capacity section must name a port that does not relay 1:1, with the
  // COMPUTED downstream rate — else the doc reads the wrong pressure. A plain 1:1 design must NOT show the block.
  it('lists an ACTIVE flow transform with the computed downstream rate (nothing invented)', () => {
    // Same catalog (`manifests`) as this file's other designs. client.source drives 1000 req/s; the FaaS emits ×100
    // on its OUT port (a logging sidecar) into a huge SQL sink, so the log tier truly sees 100k/s.
    const inst: Instance[] = [
      { id: 'client', type: 'client.source', config: { throughput: 1000 } },
      { id: 'gen', type: 'compute.faas', config: { concurrency: 100000 }, transforms: { out: { kind: 'ratio', value: 100 } } },
      { id: 'logs', type: 'db.sql', config: { concurrency: 100000 } },
    ];
    const w: Wire[] = [
      { from: ['client', 'out'], to: ['gen', 'in'] },
      { from: ['gen', 'out'], to: ['logs', 'in'] },
    ];
    const g = instantiate(manifests, inst, w);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const md = generateDesignDoc({ name: 'Logs', instances: inst, wires: w, verdicts: ev.value.verdicts, value: (id, k) => ev.value.value(NodeId(id), k) });
    expect(md).toContain('Flow transforms'); // the section is present
    expect(md).toContain('emits ×100 of its traffic'); // the OUT emission verb
    expect(md).toMatch(/gen → logs \| emits ×100 of its traffic \| 100000 req\/s \|/); // 1000 × 100, the real downstream pressure

    // A 1:1 design (the first describe design has no transforms) must NOT carry the block.
    expect(doc).not.toContain('Flow transforms');
  });

  // RETRY POLICY & GOODPUT in the deliverable (doc: retry-feedback). When a caller declares a retry
  // policy the doc must NAME it and — given a sim result — report goodput vs offered + the error rate honestly
  // (past saturation retries LOWER goodput). A policy-free design must carry NEITHER the note nor the numbers.
  it('names a declared retry policy and reports the simulated goodput vs offered', () => {
    const inst: Instance[] = [
      { id: 'client', type: 'client.source', config: { throughput: 2000, timeoutMs: 200, retryCount: 2, retryBackoffMs: 20 } },
      { id: 'svc', type: 'compute.faas', config: { concurrency: 30 } }, // under-provisioned ⇒ saturates
    ];
    const w: Wire[] = [{ from: ['client', 'out'], to: ['svc', 'in'] }];
    const g = instantiate(manifests, inst, w);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const md = generateDesignDoc({
      name: 'Retrying', instances: inst, wires: w, verdicts: ev.value.verdicts, value: (id, k) => ev.value.value(NodeId(id), k),
      retry: { goodputRps: 600, errorRate: 40, amplification: 1.7 },
    });
    // The policy is NAMED with its numbers, and the honest warning that retries lower goodput past saturation.
    expect(md).toContain('**Retry policy:**');
    expect(md).toContain('timeout 200 ms');
    expect(md).toMatch(/past saturation they LOWER useful throughput/);
    // The simulated goodput vs offered + the error rate, both from the sim result (never invented).
    expect(md).toContain('600 req/s succeed');
    expect(md).toContain('40 req/s fail');
    expect(md).toContain('×1.7');
  });

  it('carries NO retry section when no policy is declared (never invents resilience)', () => {
    // The first describe's design (no retry knobs) must not mention a retry policy or goodput-under-retry.
    expect(doc).not.toContain('**Retry policy:**');
    expect(doc).not.toContain('req/s succeed');
  });
});
