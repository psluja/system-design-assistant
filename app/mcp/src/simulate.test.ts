import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, manifests } from '@sda/content';
import { buildTools, type AnyTool } from './tools';
import { buildSimTools } from './simulate';

// increment 2: the `simulate` MCP tool verifies a percentile (p99) SLO against the DES tail — turning
// the scalar pass's `unknown` into a real ok/violation. This is what makes the tool actually USEFUL for a tail
// requirement (not just honest about not knowing).
const catalog = { ...manifests };

describe('simulate — a percentile (p99) latency SLO becomes a real DES-verified verdict', () => {
  const setup = () => {
    const s = new Studio(registry, catalog);
    const tools = buildTools(s);
    const sim = buildSimTools(s, registry);
    const call = (set: AnyTool[], name: string, a: Record<string, unknown> = {}) => (set.find((t) => t.name === name) as AnyTool).run(a);
    // client.source → gateway.api → compute.faas → db.sql (db is the request-path TERMINAL / sink).
    call(tools, 'apply_design', { instances: [{ id: 'client', type: 'client.source' }, { id: 'gw', type: 'gateway.api' }, { id: 'fn', type: 'compute.faas', config: { concurrency: 60 } }, { id: 'db', type: 'db.sql' }], wires: [['client', 'gw'], ['gw', 'fn'], ['fn', 'db']] });
    const dbLatency = (text: string) => (JSON.parse(text) as { verdicts: Array<{ scope: string; key: string; status: string }>; tailLatencyMs: { p99: number } });
    return { call, tools, sim, dbLatency };
  };

  it('a generous p99 target verifies OK against a measured (non-zero) tail', () => {
    const { call, tools, sim, dbLatency } = setup();
    call(tools, 'set_slo', { node: 'db', key: 'tailLatency', percentiles: { p99: 1e9 } });
    const r = dbLatency((call(sim, 'simulate') as { text: string }).text);
    const v = r.verdicts.find((x) => x.scope === 'db' && x.key === 'tailLatency');
    expect(v?.status).toBe('ok'); // a real verdict, not 'unknown'
    expect(r.tailLatencyMs.p99).toBeGreaterThan(0); // a measured p99, in ms
  });

  it('a tight p99 target is a real violation (the tail exceeds it)', () => {
    const { call, tools, sim, dbLatency } = setup();
    call(tools, 'set_slo', { node: 'db', key: 'tailLatency', percentiles: { p99: 0.001 } });
    const v = dbLatency((call(sim, 'simulate') as { text: string }).text).verdicts.find((x) => x.scope === 'db' && x.key === 'tailLatency');
    expect(v?.status).toBe('violation');
  });
});
