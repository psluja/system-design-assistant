import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, allManifests } from '@sda/content';
import { buildTools } from './tools';

// The MCP contract (user finding, 2026-07-02): every error must NAME THE NEXT ACTION — the server leads the
// agent by the hand instead of leaving it to burn tokens re-deriving our conventions. These tests pin the
// guided errors for the exact malformed calls observed in the wild, plus the list_protocols vocabulary tool.

function tools() {
  const s = new Studio(registry, allManifests);
  const list = buildTools(s);
  const get = (name: string) => {
    const t = list.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} missing`);
    return t;
  };
  return { studio: s, get };
}

const text = (r: unknown): string => String((r as { text?: unknown }).text ?? '') + String((r as { body?: unknown }).body ?? '');

describe('list_protocols', () => {
  it('returns every official protocol id with kind and spec', async () => {
    const { get } = tools();
    const r = text(await get('list_protocols').run({}));
    for (const id of ['postgresql', 'oracle-tns', 'odbc', 'https', 'grpc', 'kafka', 'sqs']) {
      expect(r).toContain(id);
    }
    expect(r).toContain('[sync]');
    expect(r).toContain('[event]');
    expect(r).toMatch(/compat/);
  });
});

describe('apply_design wiring errors lead by the hand', () => {
  it('a FUSED "node,port" string gets the exact tuple correction (the observed OracleSource,db case)', async () => {
    const { get } = tools();
    const r = text(await get('apply_design').run({
      instances: [{ id: 'OracleSource', type: 'db.postgres' }, { id: 'sink', type: 'db.postgres' }],
      wires: [['OracleSource,out', 'sink']],
    }));
    expect(r).toContain('fuses node and port');
    expect(r).toContain('["OracleSource","out",<to>]');
  });

  it('an unknown wire endpoint lists the declared instance ids', async () => {
    const { get } = tools();
    const r = text(await get('apply_design').run({
      instances: [{ id: 'a', type: 'client.web' }],
      wires: [['ghost', 'a']],
    }));
    expect(r).toContain('unknown node "ghost"');
    expect(r).toContain('[a]');
  });
});

describe('connect names the next action for unknown nodes', () => {
  it('lists the design nodes and suggests add_component / get_project', async () => {
    const { get } = tools();
    const r = text(await get('connect').run({ fromNode: 'nope', fromPort: 'out', toNode: 'also-nope', toPort: 'in' }));
    expect(r).toContain('is not a node in this design');
    expect(r).toMatch(/add_component|get_project/);
  });
});

describe('connect refuses a non-existent PORT, listing the node’s real ports (F6)', () => {
  it('a typo’d target port is rejected with the ports the node actually has', async () => {
    const { get } = tools();
    get('add_component').run({ id: 'client', type: 'client.web' });
    get('add_component').run({ id: 'pg', type: 'db.postgres' });
    const r = text(await get('connect').run({ fromNode: 'client', fromPort: 'out', toNode: 'pg', toPort: 'nope' }));
    expect(r).toContain('has no port "nope"');
    expect(r).toMatch(/its ports are \[[^\]]*\bin\b[^\]]*\]/); // names pg's real ports
  });
});

describe('set_config / set_slo validate the key with did-you-mean (F5)', () => {
  it('set_config refuses a phantom knob and suggests the closest real one', async () => {
    const { get } = tools();
    get('add_component').run({ id: 'pg', type: 'db.postgres' });
    const r = text(await get('set_config').run({ node: 'pg', key: 'concurrencyy', value: 100 }));
    expect(r).toContain('no config knob "concurrencyy"');
    expect(r).toMatch(/did you mean .*concurrency/);
  });

  it('set_config accepts a universal knob (assumedRps) on any node', async () => {
    const { get } = tools();
    get('add_component').run({ id: 'pg', type: 'db.postgres' });
    const r = get('set_config').run({ node: 'pg', key: 'assumedRps', value: 2000 });
    expect(r.ok, r.text).toBe(true);
  });

  it('set_slo refuses a typo’d metric and suggests the closest SLO-able one', async () => {
    const { get } = tools();
    get('add_component').run({ id: 'pg', type: 'db.postgres' });
    const r = text(await get('set_slo').run({ node: 'pg', key: 'latncy', max: 300 }));
    expect(r).toContain('is not an SLO-able metric');
    expect(r).toMatch(/did you mean .*latency/);
  });
});

describe('define_component refuses invented protocols with guidance', () => {
  it('points at list_protocols and near-miss ids', async () => {
    const { get } = tools();
    const r = text(await get('define_component').run({
      json: JSON.stringify({ type: 'custom.oracle', ports: [{ name: 'db', dir: 'in', accepts: ['oracle'] }], config: [] }),
    }));
    expect(r).toContain('unknown protocol "oracle"');
    expect(r).toContain('list_protocols');
    expect(r).toContain('oracle-tns');
  });
});

describe('discovery surface is self-sufficient (no source reading needed)', () => {
  it('list_components shows ports + protocols per type', async () => {
    const { get } = tools();
    const r = text(await get('list_components').run({}));
    expect(r).toContain('db.postgres');
    expect(r).toMatch(/db\.postgres\s+in: in\(postgresql/);
  });

  it('describe_component returns the full card: ports, config defaults with units, bands', async () => {
    const { get } = tools();
    const r = text(await get('describe_component').run({ type: 'compute.lambda' }));
    expect(r).toContain('PORTS');
    expect(r).toContain('CONFIG');
    expect(r).toContain('perRequestDuration = 100 ms');
    expect(r).toContain('https');
  });

  it('describe_component on an unknown type suggests near ids + list_components', async () => {
    const { get } = tools();
    const r = text(await get('describe_component').run({ type: 'db.oracle' }));
    expect(r).toContain('unknown type');
    expect(r).toContain('list_components');
  });

  it('add_component refuses an unknown type with suggestions instead of a bare engine error', async () => {
    const { get } = tools();
    const r = text(await get('add_component').run({ id: 'x', type: 'lambda' }));
    expect(r).toContain('unknown type "lambda"');
    expect(r).toMatch(/did you mean .*compute\.lambda/);
  });
});
