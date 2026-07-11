import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, allManifests } from '@sda/content';
import { buildTools, type ToolResult } from './tools';

// What the AGENT has to specify is what it has to THINK about. These tests pin the ergonomics that keep the
// agent connecting dots instead of recalling exact port names: ports are OPTIONAL (the engine resolves the
// sole data port), a real choice must be named (and the error lists the options), and a mistyped type
// self-corrects. The same CQRS that needed 40 port strings now needs 2 — only where there's a genuine choice.
const catalog = allManifests;
const SNS = {
  type: 'topic.sns',
  ports: [{ name: 'in', dir: 'in', accepts: ['sns', 'https', 'http'] }, { name: 'out', dir: 'out', speaks: ['sns'] }], // Publish arrives over the AWS API / HTTPS
  config: [{ key: 'throughput', value: 30000, unit: 'msg/s' }, { key: 'latency', value: 10, unit: 'ms' }, { key: 'availability', value: 0.9999, unit: 'ratio' }, { key: 'durability', value: 0.999999999, unit: 'ratio' }, { key: 'unitCost', value: 1.3, unit: 'USD/(msg/s)·month' }],
  relations: [{ key: 'overflow', reads: ['throughput'], expr: 'max(0, inflow(throughput) - self(throughput))' }],
  bands: [{ key: 'overflow', band: { shape: 'minTargetMax', max: 0 } }],
};

const instances = [
  { id: 'client', type: 'client.web', config: { throughput: 100 } },
  { id: 'gw', type: 'apigw.rest' },
  { id: 'cmd', type: 'compute.service' },
  { id: 'pg', type: 'db.postgres' },
  { id: 'sns', type: 'topic.sns' },
  { id: 'indexq', type: 'queue.sqs' },
  { id: 'indexer', type: 'compute.faas' },
  { id: 'proj', type: 'search.elasticsearch' },
  { id: 'reportq', type: 'queue.sqs' },
  { id: 'reporter', type: 'compute.fargate' },
  { id: 's3', type: 'storage.object' },
];

const setup = () => {
  const s = new Studio(registry, catalog);
  const tools = buildTools(s);
  const call = (name: string, a: Record<string, unknown> = {}): ToolResult => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.run(a);
  };
  call('define_component', { json: JSON.stringify(SNS) });
  return { call };
};

describe('apply_design ergonomics — specify less, think less', () => {
  it('builds the CQRS with PORTS only where there is a real choice (3 of 10 wires)', () => {
    const { call } = setup();
    // Only nodes with SEVERAL outputs (cmd: db/cache/out; reporter: db/out) force a named port — a genuine
    // architectural choice. Every other wire is just "connect A to B": the engine fills the sole port.
    const wires = [
      ['client', 'gw'],
      ['gw', 'cmd'],
      ['cmd', 'db', 'pg'],
      ['cmd', 'out', 'sns'], // publish events over the generic out (https → SNS Publish)
      ['sns', 'indexq'],
      ['sns', 'reportq'],
      ['indexq', 'indexer'],
      ['indexer', 'proj'],
      ['reportq', 'reporter'],
      ['reporter', 'out', 's3'], // reports over the generic out (the db port is a SQL connection)
    ];
    const r = call('apply_design', { instances, wires });
    expect(r.ok, r.text).toBe(true);
    const verdicts = (JSON.parse(r.text) as { verdicts: Array<{ scope: string }> }).verdicts;
    expect(verdicts.length).toBeGreaterThan(0); // it built and evaluated — the wiring resolved

    // The burden the agent carried: 3 port strings, not the 20 a full [from,fromPort,to,toPort] form needs.
    const portStrings = wires.flat().length - wires.length * 2; // tokens beyond the from/to ids
    expect(portStrings).toBe(3);
  });

  it('an ambiguous port is NOT guessed — the error names the choices', () => {
    const { call } = setup();
    const r = call('apply_design', { instances, wires: [['cmd', 'pg']] }); // cmd has db AND cache outputs
    expect(r.ok).toBe(false);
    expect(r.text).toContain('ambiguous');
    expect(r.text).toContain('db');
    expect(r.text).toContain('cache');
  });

  it('a mistyped component type self-corrects with the closest matches', () => {
    const { call } = setup();
    const r = call('apply_design', { instances: [{ id: 'fn', type: 'lambda' }] });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('unknown type "lambda"');
    expect(r.text).toMatch(/compute\.(lambda|faas)/); // suggested a real type to use instead
  });
});
