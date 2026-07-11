import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, allManifests } from '@sda/content';
import { buildTools, type ToolResult } from './tools';

// The MCP `evaluate` / `apply_design` result MUST apply the same queueing-aware (M/M/c) correction the canvas
// and generate_doc apply — otherwise the SAME design reads feasible:true from evaluate but a latency/saturation
// violation from generate_doc on the same server. "The tool must not lie" on the primary agent-facing path.
const catalog = allManifests;
const mk = () => {
  const s = new Studio(registry, catalog);
  const tools = buildTools(s);
  return (name: string, a: Record<string, unknown> = {}): ToolResult => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.run(a);
  };
};

describe('MCP evaluate is real-aware (queueing) — no false green vs generate_doc / the canvas', () => {
  it('flags a saturated tier as infeasible even when the IDEAL overflow is 0 (ρ=1 knife-edge)', () => {
    const call = mk();
    // compute.service capacity = concurrency / perRequestDuration = 10 / 50ms = 200 rps; the client offers EXACTLY
    // 200 → ρ = 1: overflow is 0 (the ideal Σ-service-time view sees no breach, and the ideal 50 ms latency clears
    // the 100 ms SLO) but the real M/M/c latency at ρ=1 is unbounded. evaluate must report the real violation.
    const r = call('apply_design', {
      instances: [
        { id: 'c', type: 'client.web', config: { throughput: 200 } },
        { id: 's', type: 'compute.service', config: { concurrency: 10, perRequestDuration: 50 } },
      ],
      wires: [['c', 's']],
      slos: [{ node: 's', key: 'latency', cmp: '<=', value: 100 }],
    });
    expect(r.ok).toBe(true);
    const out = JSON.parse(r.text) as { feasible: boolean; violations: number; verdicts: Array<{ scope: string; key: string; status: string }> };
    // Real-aware: the saturated tier is a violation, not a false green — evaluate agrees with generate_doc + the canvas.
    expect(out.feasible).toBe(false);
    expect(out.violations).toBeGreaterThan(0);
  });

  // client → svc → store (compute.service calls its db over its `db` port). Reused by the two cases below.
  interface EvalShape {
    feasible: boolean;
    violations: number;
    system: { flows: { source: string; terminal: string; throughputRps?: number; availability?: number }[]; cost: { totalUsdMonth: number } };
    responseLatencyMs?: unknown;
    latency?: string;
    verdicts: { scope: string; key: string; status: string }[];
  }
  const chain = (call: ReturnType<typeof mk>, clientRps: number): EvalShape => {
    const r = call('apply_design', {
      instances: [
        { id: 'client', type: 'client.web', config: { throughput: clientRps } },
        { id: 'svc', type: 'compute.service', config: { concurrency: 500, perRequestDuration: 20 } },
        { id: 'store', type: 'db.postgres' },
      ],
      wires: [['client', 'svc'], ['svc', 'db', 'store', 'in']],
    });
    expect(r.ok).toBe(true);
    return JSON.parse(call('evaluate').text) as EvalShape;
  };

  // OWNER RULING: single-truth latency = measured-or-nothing. The scalar `evaluate` no longer reports any analytic
  // latency — no per-node response readout, no per-flow latencyMs — only an honest note pointing at `simulate`.
  it('reports NO analytic latency — a note points at simulate, and no flow carries a latencyMs', () => {
    const out = chain(mk(), 1000); // store (postgres ceiling 2000) offered 1000 ⇒ feasible
    expect(out.responseLatencyMs).toBeUndefined(); // the analytic per-node readout is gone
    expect(typeof out.latency).toBe('string'); // an honest note in its place
    expect(out.latency).toMatch(/simulate/); // it points at the measured path
    for (const f of out.system.flows) expect('latencyMs' in f).toBe(false); // no analytic flow latency survives
    // the rest of the picture is intact: throughput/availability/cost/feasibility still computed.
    expect(out.feasible).toBe(true);
    expect(out.system.cost.totalUsdMonth).toBeGreaterThan(0);
  });

  it('a saturated design stays honest — infeasible, and STILL no analytic latency laundered in (only the note)', () => {
    // store saturated (3000 > ceiling 2000). The old evaluate emitted an analytic ∞ response latency; now it emits
    // none — the measured tail is `simulate`'s job — but the saturation must still read INFEASIBLE (never a false green).
    const out = chain(mk(), 3000);
    expect(out.responseLatencyMs).toBeUndefined();
    expect(out.latency).toMatch(/simulate/);
    expect(out.feasible).toBe(false); // caught via the verdicts (overflow/saturation), not via a latency readout
  });
});
