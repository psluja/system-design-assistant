import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { Studio, serialize } from '@sda/core';
import { registry, allManifests, keys } from '@sda/content';
import { buildTools } from './tools';
import { buildSearchTools } from './search';
import { bindSolvers } from './composition';

// The SAME CQRS system, made as CHEAP as the topology + rate allow — built and right-sized via the MCP tools.
// Levers: a DEMAND-SIZED command handler (custom, runs Fargate-style: cost tracks load, not a flat fee) with a
// proper events port; the cheapest open-source projection store; and `optimize` to right-size the Lambda
// indexer (its concurrency was 20× the load). Lambda + Fargate stay (as specified). Everything stays verified.
const catalog = allManifests;

const SNS = {
  type: 'topic.sns',
  ports: [{ name: 'in', dir: 'in', accepts: ['sns', 'https', 'http'] }, { name: 'out', dir: 'out', speaks: ['sns'] }],
  config: [
    { key: 'throughput', value: 30000, unit: 'msg/s' }, { key: 'latency', value: 10, unit: 'ms' },
    { key: 'availability', value: 0.9999, unit: 'ratio' }, { key: 'durability', value: 0.999999999, unit: 'ratio' },
    { key: 'unitCost', value: 1.3, unit: 'USD/(msg/s)·month' },
  ],
  relations: [
    { key: 'cost', reads: ['throughput', 'unitCost'], expr: 'inflow(throughput) * self(unitCost)' },
    { key: 'overflow', reads: ['throughput'], expr: 'max(0, inflow(throughput) - self(throughput))' },
  ],
  bands: [{ key: 'overflow', band: { shape: 'minTargetMax', max: 0 } }],
};

// A DEMAND-SIZED command handler (the real-world choice: the command API on Fargate/ECS, sized to the load) —
// http in, writes to Postgres (db), publishes events (a proper aws events port). Cost = required tasks ×
// $/task, so at a light command rate it is a couple of dollars, not a $120 flat server.
const COMMAND = {
  type: 'compute.command',
  ports: [{ name: 'in', dir: 'in', accepts: ['http'] }, { name: 'db', dir: 'out', speaks: ['postgresql'] }, { name: 'events', dir: 'out', speaks: ['https'] }],
  config: [
    { key: 'concurrency', value: 40, unit: '1' }, { key: 'perRequestDuration', value: 25, unit: 'ms' },
    { key: 'maxUnits', value: 100, unit: '1' }, { key: 'latency', value: 20, unit: 'ms' },
    { key: 'availability', value: 0.9995, unit: 'ratio' }, { key: 'unitCost', value: 30, unit: 'USD/task·month' },
  ],
  relations: [
    { key: 'throughput', reads: ['maxUnits', 'concurrency', 'perRequestDuration'], expr: 'maxUnits * concurrency / (perRequestDuration / 1000)' },
    { key: 'requiredUnits', reads: ['throughput', 'concurrency', 'perRequestDuration'], expr: 'inflow(throughput) / (concurrency / (perRequestDuration / 1000))' },
    { key: 'cost', reads: ['requiredUnits', 'unitCost'], expr: 'requiredUnits * self(unitCost)' },
    { key: 'overflow', reads: ['throughput'], expr: 'max(0, inflow(throughput) - self(throughput))' },
  ],
  bands: [{ key: 'overflow', band: { shape: 'minTargetMax', max: 0 } }],
};

const COMMANDS_RPS = 100;

// The CQRS topology as one apply_design payload (reused by the build test and the optimize-robustness guard).
const DESIGN = {
  instances: [
    { id: 'client', type: 'client.web', config: { throughput: COMMANDS_RPS }, label: 'Clients', description: 'HTTP POST commands' },
    { id: 'gw', type: 'apigw.rest', label: 'API Gateway' },
    { id: 'cmd', type: 'compute.command', label: 'Command handler', description: 'demand-sized; writes the source of truth + publishes events' },
    { id: 'pg', type: 'db.postgres', label: 'Source of truth', description: 'Postgres — the write model' },
    { id: 'sns', type: 'topic.sns', label: 'Event topic', description: 'SNS — fans events out' },
    { id: 'indexq', type: 'queue.sqs', label: 'Index queue' },
    { id: 'indexer', type: 'compute.faas', label: 'Indexer', description: 'Lambda — updates projections' },
    { id: 'proj', type: 'db.mysql', label: 'Projections', description: 'cheapest open-source read model' },
    { id: 'reportq', type: 'queue.sqs', label: 'Report queue' },
    { id: 'reporter', type: 'compute.fargate', label: 'Report cluster', description: 'Fargate — builds reports' },
    { id: 's3', type: 'storage.object', label: 'Reports', description: 'S3 — report output' },
  ],
  wires: [
    ['client', 'out', 'gw', 'in'], ['gw', 'out', 'cmd', 'in'], ['cmd', 'db', 'pg', 'in'], ['cmd', 'events', 'sns', 'in'],
    ['sns', 'out', 'indexq', 'in'], ['sns', 'out', 'reportq', 'in'],
    ['indexq', 'out', 'indexer', 'in'], ['indexer', 'out', 'proj', 'in'],
    ['reportq', 'out', 'reporter', 'in'], ['reporter', 'out', 's3', 'in'],
  ],
  slos: [{ node: 'pg', key: 'latency', cmp: '<=', value: 120 }],
};

const buildCqrs = (s: Studio): ((name: string, args?: Record<string, unknown>) => { ok: boolean; text: string }) => {
  const tools = buildTools(s);
  const call = (name: string, args: Record<string, unknown> = {}) => (tools.find((t) => t.name === name)!).run(args);
  call('define_component', { json: JSON.stringify(SNS) });
  call('define_component', { json: JSON.stringify(COMMAND) });
  call('apply_design', DESIGN as unknown as Record<string, unknown>);
  return call;
};

describe('CQRS @ ' + COMMANDS_RPS + ' command rps — made as cheap as the topology allows', () => {
  it('right-sizes + swaps to the cheapest feasible components, still verified', () => {
    const s = new Studio(registry, catalog);
    const call = buildCqrs(s);

    // right-size the Lambda indexer: faas capacity = concurrency / (per-request 50 ms) = concurrency × 20 rps.
    // For the 100 rps event rate, concurrency 5 serves it exactly (overflow 0) — anything less overflows. The
    // demand-sized fleets (command handler, Fargate reporter) already cost only what the load needs, so the
    // over-provisioned Lambda was the lone fat to trim.
    call('set_config', { node: 'indexer', key: 'concurrency', value: 5 });

    const e = s.evaluate();
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    const v = e.value;
    const val = (id: string, k = keys.cost) => v.value(NodeId(id), k);
    const wires = s.project().wires;
    const localCost = (id: string) => (val(id) ?? 0) - wires.filter((w) => w.to[0] === id).reduce((acc, w) => acc + (val(w.from[0]) ?? 0), 0);
    const total = s.project().instances.reduce((acc, i) => acc + Math.max(0, localCost(i.id)), 0);
    const violations = v.verdicts.filter((x) => x.status === 'violation').length;

    const out = `${process.env.TEMP ?? '.'}\\cqrs-cheapest.sda.json`;
    writeFileSync(out, serialize(s.project()), 'utf8');

    /* eslint-disable no-console */
    console.log(`\nCHEAPEST CQRS @ ${COMMANDS_RPS} command rps — verified (${violations} violations):`);
    console.log(`  indexer (Lambda) sized to concurrency ${val('indexer', keys.concurrency)} (was 100), overflow ${val('indexer', keys.overflow)}`);
    console.log(`  per-component $/mo: ${s.project().instances.map((i) => `${i.id} $${Math.round(localCost(i.id) * 10) / 10}`).join(' · ')}`);
    console.log(`  TOTAL ~ $${Math.round(total)}/mo  (was ~$1052)  → saved ${out}\n`);
    /* eslint-enable no-console */

    expect(violations).toBe(0);
    expect(total).toBeLessThan(1052);
  });

  // REGRESSION: this exact graph (custom demand-sized + pay-per-use components ⇒ many tunables whose knobs do
  // NOT affect cost) once spun cbc for 319 s. The optimize facade now prunes a FEASIBLE design's tunables to
  // the ones the objective actually depends on (cell-network reachability), so the MIP is tiny and SOLVES in
  // well under a second — and the hard solver time-limit remains as the backstop. Guards both: solves, fast.
  it('optimize SOLVES the pathological graph FAST (free knobs pruned) — never the 319 s hang', async () => {
    const s = new Studio(registry, catalog);
    buildCqrs(s);
    const optimize = buildSearchTools(s, bindSolvers(registry)).find((t) => t.name === 'optimize')!;
    const t0 = Date.now();
    const res = await optimize.run({ node: 'proj', key: 'cost', direction: 'min' });
    const ms = Date.now() - t0;
    expect(res.ok).toBe(true); // it actually SOLVES (the free vars that made it intractable are gone)
    expect(ms).toBeLessThan(4000); // fast — far under the 10 s timeout, and worlds from the old 319 s
    const assigns = JSON.parse(res.text) as Array<{ node: string; key: string; value: number }>;
    // the ONLY objective-relevant knob is the Lambda indexer's concurrency (cost = concurrency × rate); it is
    // sized DOWN toward what 100 rps needs (≈ 5). The free knobs (fleet maxUnits, queue/topic throughput) are
    // pruned, so they do not appear.
    const idx = assigns.find((a) => a.node === 'indexer' && a.key === 'concurrency');
    expect(idx).toBeDefined();
    expect(idx!.value).toBeLessThan(100); // reduced from the default 100
  }, 15_000);
});
