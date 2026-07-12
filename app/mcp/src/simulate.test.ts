import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, manifests, simResultForDoc } from '@sda/content';
import { buildTools, type AnyTool } from './tools';
import { buildSimTools } from './simulate';
import { roundMs } from './tool-kit';

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
    return { call, tools, sim, dbLatency, s };
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

  // SINGLE-TRUTH (single-truth-display / web-is-a-dumb-renderer): the design-doc's EMBEDDED tail (simResultForDoc,
  // via generate_doc) and the interactive `simulate` tool must report the SAME p50/p95/p99 for the SAME design —
  // they now share ONE run config (content `TAIL_SIM_OPTIONS`), so a doc can never quote a p99 that disagrees with
  // what `simulate` shows. This pins that the two surfaces stay the same DES run: same seed/window ⇒ identical
  // percentiles, equal once the tool's whole-ms rounding is applied. If either surface's run config or s→ms reshape
  // drifts, this fails.
  it('the design-doc tail equals the `simulate` tool tail for the same design (one DES run, one truth)', () => {
    const { call, sim, s } = setup();
    const g = s.graph();
    if (!g.ok) throw new Error('graph build failed');
    const doc = simResultForDoc(g.value, registry).tail; // raw ms, the deliverable's embedded tail
    const tool = (JSON.parse((call(sim, 'simulate') as { text: string }).text) as { tailLatencyMs: { p50: number; p95: number; p99: number } }).tailLatencyMs;
    expect(doc.p99).toBeGreaterThan(0); // a real, non-vacuous queueing tail (compute at ρ≈0.83)
    for (const q of ['p50', 'p95', 'p99'] as const) {
      expect(roundMs(doc[q]), `doc ${q} ${doc[q]} ms ≠ simulate ${q} ${tool[q]} ms`).toBe(tool[q]);
    }
  });
});
