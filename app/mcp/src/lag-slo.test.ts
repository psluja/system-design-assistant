import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, allManifests } from '@sda/content';
import { buildTools, type AnyTool, type ToolResult } from './tools';
import { buildSimTools } from './simulate';

// FLOW-SCOPED LAG (doc: latency-semantics-v2 §3) over MCP: set_lag_slo declares a CDC/replication deadline on a
// (source, terminal) flow; the async queue wait along the path COUNTS. The honesty split the two tools enforce:
// `evaluate` (scalar) can only PROVE a violation or read `unknown` (the queue wait is invisible to it), while
// `simulate` MEASURES the true async-inclusive mean lag and resolves it — the same shared `lagVerdicts` computation.
describe('set_lag_slo + evaluate/simulate — the flow-scoped lag surface', () => {
  const setup = () => {
    const s = new Studio(registry, allManifests);
    const tools = buildTools(s);
    const sim = buildSimTools(s, registry);
    const call = (set: AnyTool[], name: string, a: Record<string, unknown> = {}): ToolResult => (set.find((t) => t.name === name) as AnyTool).run(a) as ToolResult;
    // capture (originates the change stream) →ASYNC→ q (a queue-mode buffer) →SYNC→ loader (the destination
    // consumer). The async hop is the whole point — its backlog wait belongs to lag(capture → loader). This mirrors
    // the finale's proven-legal checkout→sqs(async)→worker wiring.
    const applied = call(tools, 'apply_design', {
      instances: [
        { id: 'capture', type: 'compute.service', config: { assumedRps: 100, latency: 20, concurrency: 100000 } },
        { id: 'q', type: 'queue.sqs', config: { queueMode: 1, drainRate: 120, maxBacklog: 1000000 } },
        { id: 'loader', type: 'compute.faas', config: { concurrency: 100000, perRequestDuration: 30 } },
      ],
      wires: [['capture', 'out', 'q', 'in', true], ['q', 'loader']],
    });
    if (!applied.ok) throw new Error(`apply_design failed: ${applied.text}`);
    const lagRows = (text: string) => (JSON.parse(text) as { lagVerdicts?: Array<{ scope: string; status: string; basis: string }> }).lagVerdicts ?? [];
    return { call, tools, sim, lagRows };
  };

  it('set_lag_slo guides an unknown endpoint to the real node ids (the MCP contract)', () => {
    const { call, tools } = setup();
    const r = call(tools, 'set_lag_slo', { source: 'ghost', terminal: 'loader', maxMs: 2000 });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('capture'); // the error names the actual nodes to pick from
    // maxMs must be positive
    expect(call(tools, 'set_lag_slo', { source: 'capture', terminal: 'loader', maxMs: 0 }).ok).toBe(false);
  });

  it('evaluate reads a lag SLO the scalar cannot prove as `unknown` (the queue wait is invisible to it)', () => {
    const { call, tools } = setup();
    call(tools, 'set_lag_slo', { source: 'capture', terminal: 'loader', maxMs: 2000 });
    const row = call(tools, 'evaluate').text;
    const v = (JSON.parse(row) as { lagVerdicts?: Array<{ scope: string; status: string; basis: string }> }).lagVerdicts?.find((x) => x.scope === 'capture → loader');
    expect(v?.status).toBe('unknown');
    expect(v?.basis).toBe('unknown');
  });

  it('simulate RESOLVES the lag SLO — a generous deadline verifies ok, a tight one is a real violation', () => {
    const { call, tools, sim, lagRows } = setup();
    // generous: comfortably above the true async-inclusive lag ⇒ measured ok.
    call(tools, 'set_lag_slo', { source: 'capture', terminal: 'loader', maxMs: 100000 });
    const okV = lagRows((call(sim, 'simulate') as { text: string }).text).find((x) => x.scope === 'capture → loader');
    expect(okV?.status).toBe('ok');
    expect(okV?.basis).toBe('measured'); // the DES answered it, not the scalar

    // tight: below the real lag (which includes the queue wait) ⇒ measured violation.
    call(tools, 'set_lag_slo', { source: 'capture', terminal: 'loader', maxMs: 1 });
    const badV = lagRows((call(sim, 'simulate') as { text: string }).text).find((x) => x.scope === 'capture → loader');
    expect(badV?.status).toBe('violation');
  });
});
