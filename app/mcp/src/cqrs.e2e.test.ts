import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { Studio, serialize } from '@sda/core';
import { registry, allManifests, keys } from '@sda/content';
import { buildTools } from './tools';

// A REAL CQRS design, built the way an AI builds it over MCP: define the one missing component (SNS), then
// apply_design the whole topology in one call, then read the verdicts. The engine COMPUTES it. Writes an
// importable .sda.json so it can be loaded straight onto the canvas.
const catalog = allManifests;

// SNS standard topic (fan-out pub/sub) — the only piece not in the seed catalog. ILLUSTRATIVE figures in the
// project's "numbers are sourced or marked" style: high publish throughput, low latency, cross-AZ durability,
// pay-per-use cost (~$0.50 / 1M publishes + delivery). Carries the universal overflow check too.
const SNS = {
  type: 'topic.sns',
  ports: [
    { name: 'in', dir: 'in', accepts: ['sns', 'https', 'http'] },
    { name: 'out', dir: 'out', speaks: ['sns'] },
  ],
  config: [
    { key: 'throughput', value: 30000, unit: 'msg/s' },
    { key: 'latency', value: 10, unit: 'ms' },
    { key: 'availability', value: 0.9999, unit: 'ratio' },
    { key: 'durability', value: 0.999999999, unit: 'ratio' },
    { key: 'unitCost', value: 1.3, unit: 'USD/(msg/s)·month' },
  ],
  relations: [
    { key: 'cost', reads: ['throughput', 'unitCost'], expr: 'inflow(throughput) * self(unitCost)' },
    { key: 'overflow', reads: ['throughput'], expr: 'max(0, inflow(throughput) - self(throughput))' },
  ],
  bands: [{ key: 'overflow', band: { shape: 'minTargetMax', max: 0 } }],
};

const COMMANDS_RPS = 100; // HTTP POST command rate (≈ 8.6M/day) — adjustable

describe('CQRS @ ' + COMMANDS_RPS + ' command rps — Postgres source of truth, SNS+SQS events, ES projections', () => {
  it('builds and computes a verified CQRS design via the MCP tools', () => {
    const studio = new Studio(registry, catalog);
    const tools = buildTools(studio);
    const call = (name: string, args: Record<string, unknown>) => (tools.find((t) => t.name === name)!).run(args);

    // 1 — define the missing SNS component (the AI's define_component).
    expect(call('define_component', { json: JSON.stringify(SNS) }).ok).toBe(true);

    // 2 — build the WHOLE CQRS topology in ONE call.
    const res = call('apply_design', {
      instances: [
        { id: 'client', type: 'client.web', config: { throughput: COMMANDS_RPS }, label: 'Clients', description: 'HTTP POST commands' },
        { id: 'gw', type: 'apigw.rest', label: 'API Gateway' },
        { id: 'cmd', type: 'compute.service', label: 'Command handler', description: 'writes to the source of truth, publishes events' },
        { id: 'pg', type: 'db.postgres', label: 'Source of truth', description: 'Postgres — the write model' },
        { id: 'sns', type: 'topic.sns', label: 'Event topic', description: 'SNS — fans events out' },
        { id: 'indexq', type: 'queue.sqs', label: 'Index queue', description: 'SQS — indexing' },
        { id: 'indexer', type: 'compute.faas', label: 'Indexer', description: 'Lambda — updates projections' },
        { id: 'proj', type: 'search.elasticsearch', label: 'Projections', description: 'Elasticsearch — open-source read model' },
        { id: 'reportq', type: 'queue.sqs', label: 'Report queue', description: 'SQS — reporting' },
        { id: 'reporter', type: 'compute.fargate', label: 'Report cluster', description: 'Fargate — builds reports' },
        { id: 's3', type: 'storage.object', label: 'Reports', description: 'S3 — report output' },
      ],
      wires: [
        ['client', 'out', 'gw', 'in'],
        ['gw', 'out', 'cmd', 'in'],
        ['cmd', 'db', 'pg', 'in'], // write to the source of truth
        ['cmd', 'out', 'sns', 'in'], // publish events over the service's generic out (https → SNS Publish)
        ['sns', 'out', 'indexq', 'in'], // SNS → SQS fan-out (1/2)
        ['sns', 'out', 'reportq', 'in'], // SNS → SQS fan-out (2/2)
        ['indexq', 'out', 'indexer', 'in'],
        ['indexer', 'out', 'proj', 'in'], // index into projections
        ['reportq', 'out', 'reporter', 'in'],
        ['reporter', 'out', 's3', 'in'], // reports to S3 over the generic out (the db port is a SQL connection)
      ],
      slos: [{ node: 'pg', key: 'latency', cmp: '<=', value: 120 }], // command write-path latency budget
    });
    expect(res.ok).toBe(true);

    // 3 — read the computed values + verdicts.
    const e = studio.evaluate();
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    const v = e.value;
    const val = (id: string, k = keys.cost): number | undefined => v.value(NodeId(id), k);

    // local cost per node = cumulative out(cost) − Σ predecessors' out(cost); summed = the true system total.
    const wires = studio.project().wires;
    const localCost = (id: string): number => (val(id) ?? 0) - wires.filter((w) => w.to[0] === id).reduce((s, w) => s + (val(w.from[0]) ?? 0), 0);
    const total = studio.project().instances.reduce((s, i) => s + Math.max(0, localCost(i.id)), 0);
    const violations = v.verdicts.filter((x) => x.status === 'violation');

    // write the importable project file
    const out = `${process.env.TEMP ?? '.'}\\cqrs.sda.json`;
    writeFileSync(out, serialize(studio.project()), 'utf8');

    /* eslint-disable no-console */
    console.log(`\nCQRS design @ ${COMMANDS_RPS} command rps — built via MCP tools, computed by the engine:`);
    console.log(`  components: ${studio.project().instances.length} · wires: ${wires.length} · violations: ${violations.length}`);
    console.log(`  WRITE path  client → gw → cmd → pg(source of truth): latency ${val('pg', keys.latency)} ms, served ${val('pg', keys.throughput)} rps, overflow ${val('pg', keys.overflow)}`);
    console.log(`  INDEX path  sns → indexq → indexer(Lambda) → proj(Elasticsearch): served ${val('proj', keys.throughput)} rps, overflow indexq ${val('indexq', keys.overflow)}`);
    console.log(`  REPORT path sns → reportq → reporter(Fargate) → s3: served ${val('s3', keys.throughput)} rps, fargate tasks ${val('reporter', keys.requiredUnits)}`);
    console.log(`  per-component $/mo: ${studio.project().instances.map((i) => `${i.id} $${Math.round(localCost(i.id))}`).join(' · ')}`);
    console.log(`  TOTAL ~ $${Math.round(total)}/mo · saved importable project → ${out}\n`);
    /* eslint-enable no-console */

    // sanity: it builds, every receiver is within capacity at this rate (no overflow), nothing is NaN.
    expect(violations.length).toBe(0);
    for (const id of ['pg', 'sns', 'indexq', 'reportq', 'proj', 's3']) expect(val(id, keys.overflow) ?? 0).toBeLessThanOrEqual(0.01);
  });
});
