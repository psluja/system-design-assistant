import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { NodeId, type Key } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import {
  buildDocModel,
  instantiate,
  manifests,
  registry,
  keys,
  nodeQueues,
  realCumulativeLatency,
  responseLatency,
  realAwareVerdicts,
  renderHtml,
  type Instance,
  type Wire,
} from './index';

// ARTIFACT GENERATOR (design-doc-v2 R2). Writes docs/design/sample-generated-design-doc.html — a BUILD ARTIFACT for
// OWNER REVIEW — from a representative design (client → API GW → under-provisioned FaaS → SQL, with a ×100 log
// fan-out, a retry policy, SLOs, groups, a canvas layout, a load sweep and alternatives). It is GATED behind the
// env flag `SDA_GEN_SAMPLE` so the normal suite does NOT run it (no repo side effect, no count change on every test).
// Regenerate the artifact after a renderer change with:
//   $env:SDA_GEN_SAMPLE="1"; pnpm --filter @sda/content exec vitest run gen-sample-doc
it.runIf(process.env.SDA_GEN_SAMPLE)('writes the sample generated design doc', () => {
  const instances: Instance[] = [
    { id: 'client', type: 'client.source', config: { throughput: 2000, timeoutMs: 200, retryCount: 2, retryBackoffMs: 50 } },
    { id: 'gw', type: 'gateway.api', config: { availability: 0.9995 } },
    { id: 'compute', type: 'compute.faas', config: { concurrency: 30 } },
    {
      id: 'db',
      type: 'db.sql',
      bands: [
        { key: keys.throughput, band: { shape: 'minTargetMax', target: 1000 } },
        { key: keys.availability, band: { shape: 'minTargetMax', min: 0.9999 } },
      ],
    },
    { id: 'logs', type: 'db.sql' },
  ];
  const wires: Wire[] = [
    { from: ['client', 'out'], to: ['gw', 'in'] },
    { from: ['gw', 'out'], to: ['compute', 'in'] },
    { from: ['compute', 'out'], to: ['db', 'in'] },
    { from: ['compute', 'out'], to: ['logs', 'in'], transform: { kind: 'ratio', value: 100 } },
  ];

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
    labels: { client: 'users', gw: 'API gateway', compute: 'checkout fn', db: 'orders DB', logs: 'log store' },
    descriptions: { compute: 'runs the checkout command' },
    layout: {
      client: { x: 0, y: 120 },
      gw: { x: 220, y: 120 },
      compute: { x: 440, y: 120 },
      db: { x: 680, y: 40 },
      logs: { x: 680, y: 200 },
    },
    groups: [{ id: 'vpc', label: 'Application VPC', members: ['gw', 'compute', 'db', 'logs'] }],
    realLatencyByNode: Object.fromEntries(realCumulativeLatency(g.value, value, q)),
    responseLatencyByNode: Object.fromEntries(responseLatency(g.value, value, q)),
    saturated: [...q].filter(([, nq]) => nq.rho >= 1).map(([id]) => id),
    tail: { p50: 42, p95: 118, p99: 264 },
    retry: { goodputRps: 600, errorRate: 40, amplification: 1.7 },
    sweep: [
      { offeredRps: 200, latencyMs: 34 },
      { offeredRps: 400, latencyMs: 41 },
      { offeredRps: 600, latencyMs: 78 },
      { offeredRps: 800, latencyMs: 340 },
      { offeredRps: 1000, latencyMs: 1200 },
    ],
    alternatives: [
      {
        node: 'db',
        method: 'compare_options (same family, each sized to the SLOs)',
        options: [
          { type: 'db.postgres', label: 'PostgreSQL (Multi-AZ)', costUsdMonth: 140, costDeltaUsdMonth: -60, meetsSlos: true, note: 'lower cost, meets every SLO' },
          { type: 'db.dynamodb', label: 'DynamoDB (on-demand)', costUsdMonth: 220, costDeltaUsdMonth: 20, meetsSlos: false, note: 'misses the throughput SLO at this size' },
        ],
      },
    ],
    generatedAt: '2026-07-03T09:00:00Z',
  });

  const html = renderHtml(model);
  const target = new URL('../../../docs/design/sample-generated-design-doc.html', import.meta.url);
  writeFileSync(target, html, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`wrote ${target.pathname} (${Buffer.byteLength(html, 'utf8')} bytes)`);
});
