import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, allManifests } from '@sda/content';
import { buildSynthTools } from './synthesize';
import { bindSolvers } from './composition';

// compare_options end-to-end over a LIVE design (the path an AI takes through the bridge / MCP): clingo
// enumerates every component TYPE that fits the node's wiring (here: the compute family on an http-in node),
// MiniZinc/COIN-BC SIZES each to serve the load with no overflow, and the survivors come back ranked by sized
// monthly cost. This is the "Fargate vs Lambda vs ASG vs …" auto-pick built from the catalog, not hardcoded.
const catalog = allManifests;

describe('compare_options (clingo enumerate → MiniZinc size → rank) over a Studio design', () => {
  it('ranks the compute alternatives for a node by sized monthly cost — every survivor serves the load', async () => {
    const s = new Studio(registry, catalog);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
    s.dispatch({ kind: 'setConfig', node: 'client', key: 'throughput', value: 5000 });
    s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.faas' });
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['svc', 'in'] });

    const compare = buildSynthTools(s, bindSolvers(registry)).find((t) => t.name === 'compare_options');
    expect(compare).toBeDefined();
    const res = await compare!.run({ node: 'svc' });
    expect(res.ok).toBe(true);

    const rows = JSON.parse(res.text) as { type: string; cost: number; overflow: number; sizing: { key: string; value: number }[] }[];
    const chosen = rows.map((r) => r.type);
    // every alternative is from the SAME family (compute.*) and fits the http input — never a proxy or a db
    expect(chosen.every((t) => t.startsWith('compute.'))).toBe(true);
    // the headline auto-pick choices must be among them (drawn from the catalog, not named in the engine)
    expect(chosen).toContain('compute.faas');
    expect(chosen).toContain('compute.fargate');
    expect(chosen).toContain('compute.asg');

    // every survivor was sized so it serves the full 5,000 rps (no overflow) and has a real monthly cost.
    // (A demand-priced fleet has no cost-affecting knob ⇒ `sizing` may be empty; the optimiser prunes knobs
    // the cost objective doesn't depend on. Feasibility + a real cost are the invariants, not the knob count.)
    for (const r of rows) {
      expect(r.overflow).toBeLessThanOrEqual(0.01);
      expect(r.cost).toBeGreaterThan(0);
    }
    // ranked cheapest-first
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.cost).toBeGreaterThanOrEqual(rows[i - 1]!.cost);
  });

  it('a worker fed by a QUEUE offers the compute alternatives (accept-set, not exact-protocol fit)', async () => {
    // The bug doc-10 caught: a node fed by SQS (not http) returned "no alternative" because the fit check
    // demanded the candidate's in-port protocol EQUAL the producer's. A Lambda (in: http, but accepts sqs) IS
    // a valid alternative to a Fargate worker on a queue — now matched by the accept-set, like the legality layer.
    const s = new Studio(registry, catalog);
    s.dispatch({ kind: 'addComponent', id: 'src', type: 'client.web' });
    s.dispatch({ kind: 'setConfig', node: 'src', key: 'throughput', value: 1000 });
    s.dispatch({ kind: 'addComponent', id: 'q', type: 'queue.sqs' });
    s.dispatch({ kind: 'addComponent', id: 'worker', type: 'compute.fargate' });
    s.dispatch({ kind: 'connect', from: ['src', 'out'], to: ['q', 'in'] });
    s.dispatch({ kind: 'connect', from: ['q', 'out'], to: ['worker', 'in'] });

    const compare = buildSynthTools(s, bindSolvers(registry)).find((t) => t.name === 'compare_options')!;
    const res = await compare.run({ node: 'worker' });
    expect(res.ok).toBe(true);
    const chosen = (JSON.parse(res.text) as { type: string }[]).map((r) => r.type);
    expect(chosen.every((t) => t.startsWith('compute.'))).toBe(true);
    expect(chosen).toContain('compute.faas'); // a Lambda is a legal alternative to the Fargate worker
    expect(chosen.length).toBeGreaterThan(1); // real choices, not "no alternative"
  });

  it('reports honestly when a node has no connections to derive alternatives from', async () => {
    const s = new Studio(registry, catalog);
    s.dispatch({ kind: 'addComponent', id: 'lonely', type: 'compute.faas' });
    const compare = buildSynthTools(s, bindSolvers(registry)).find((t) => t.name === 'compare_options')!;
    const res = await compare.run({ node: 'lonely' });
    expect(res.ok).toBe(false);
    expect(res.text).toContain('no connections');
  });
});

describe('synthesize (multi-slot spec → whole verified designs, ranked) over the catalog', () => {
  it('designs a 3-tier spec from intent — fills a compute + a db slot, sized, ranked by cost', async () => {
    const s = new Studio(registry, catalog); // empty Studio — the spec comes entirely from the tool args
    const tool = buildSynthTools(s, bindSolvers(registry)).find((t) => t.name === 'synthesize')!;
    const res = await tool.run({
      fixed: [{ id: 'client', type: 'client.web', config: { throughput: 2000 } }],
      slots: [{ id: 'svc', family: 'compute' }, { id: 'store', family: 'db' }],
      wires: [['client', 'out', 'svc', 'in'], ['svc', 'db', 'store', 'in']],
      slos: [{ node: 'svc', key: 'latency', cmp: '<=', value: 100 }],
      limit: 4,
    });
    expect(res.ok).toBe(true);
    const rows = JSON.parse(res.text) as { selection: Record<string, string>; cost: number; sizing: unknown[] }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // every design is a real compute + a real db whose protocols agree (clingo enforced compatibility)
      expect(r.selection.svc?.startsWith('compute.')).toBe(true);
      expect(r.selection.store?.startsWith('db.')).toBe(true);
      expect(r.cost).toBeGreaterThan(0);
    }
    // ranked cheapest-first (whole-design monthly cost)
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.cost).toBeGreaterThanOrEqual(rows[i - 1]!.cost);
  });
});

describe('auto_architect (requirements → archetype → synthesized design)', () => {
  it('designs a web service from throughput + an SLO ALONE — ranked verified designs', async () => {
    const s = new Studio(registry, catalog); // no spec, no shape reasoning — just requirements
    const tool = buildSynthTools(s, bindSolvers(registry)).find((t) => t.name === 'auto_architect')!;
    const res = await tool.run({ throughput: 2000, shape: 'web', slos: [{ key: 'latency', cmp: '<=', value: 200 }], limit: 3 });
    expect(res.ok).toBe(true);
    const rows = JSON.parse(res.text) as { shape: string; selection: Record<string, string>; cost: number }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.shape).toBe('web');
      expect(r.selection.svc?.startsWith('compute.')).toBe(true);
      expect(r.selection.db?.startsWith('db.')).toBe(true);
    }
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.cost).toBeGreaterThanOrEqual(rows[i - 1]!.cost);
  });

  it('requires a workload (throughput)', async () => {
    const s = new Studio(registry, catalog);
    const tool = buildSynthTools(s, bindSolvers(registry)).find((t) => t.name === 'auto_architect')!;
    expect((await tool.run({ shape: 'web' })).ok).toBe(false);
  });
});
