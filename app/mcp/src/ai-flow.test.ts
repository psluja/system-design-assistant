import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { Studio, serialize } from '@sda/core';
import { registry, allManifests } from '@sda/content';
import { buildTools, type AnyTool, type ToolResult } from './tools';
import { buildSynthTools } from './synthesize';
import { buildUncertaintyTools } from './uncertainty';
import { buildFileTools, withinRoots, type FileSystemPort } from './file-io';
import { bindSolvers } from './composition';

// What an AI ACTUALLY does over MCP, end-to-end, on the recommended "design from requirements" flow — timed
// and call-counted, so we can say whether the toolset is convenient and efficient for an agent. The MCP
// transport (loopback JSON-RPC / WS) is ~1 ms and irrelevant next to the solvers, so calling the tool
// functions directly measures the real work an agent waits on.
const catalog = allManifests;

describe('AI-via-MCP: design an architecture from requirements (timed)', () => {
  it('auto_architect → apply_design → evaluate yields a VERIFIED design in 3 calls', async () => {
    const s = new Studio(registry, catalog);
    const sync = buildTools(s);
    const synth = buildSynthTools(s, bindSolvers(registry));
    const call = (set: AnyTool[], name: string, args: Record<string, unknown> = {}) => Promise.resolve((set.find((t) => t.name === name) as AnyTool).run(args));

    let calls = 0;
    const timings: string[] = [];
    const step = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const t0 = performance.now();
      const r = await fn();
      calls += 1;
      timings.push(`  [${calls}] ${label} — ${Math.round(performance.now() - t0)} ms`);
      return r;
    };

    const wall0 = performance.now();

    // 1 — state the REQUIREMENTS; the engine designs (clingo enumerates, MiniZinc sizes), returns ranked verified designs.
    const res1 = await step('auto_architect{ 5000 rps, web, latency ≤ 300 }', () =>
      call(synth, 'auto_architect', { throughput: 5000, shape: 'web', slos: [{ key: 'latency', cmp: '<=', value: 300 }], limit: 3 }),
    );
    expect(res1.ok).toBe(true);
    const designs = JSON.parse(res1.text) as Array<{ selection: Record<string, string>; cost: number; sizing: { node: string; key: string; value: number }[] }>;
    const best = designs[0]!;

    // 2 — APPLY the cheapest verified design in ONE call (its components + the engine's sizing).
    const cfg = (node: string): Record<string, number> => Object.fromEntries(best.sizing.filter((z) => z.node === node).map((z) => [z.key, z.value]));
    const res2 = await step('apply_design (whole design, 1 call)', () =>
      call(sync, 'apply_design', {
        instances: [
          { id: 'client', type: 'client.web', config: { throughput: 5000 } },
          { id: 'svc', type: best.selection.svc, config: cfg('svc') },
          { id: 'db', type: best.selection.db, config: cfg('db') },
        ],
        wires: [['client', 'out', 'svc', 'in'], ['svc', 'db', 'db', 'in']],
        slos: [{ node: 'db', key: 'latency', cmp: '<=', value: 300 }],
      }),
    );
    expect(res2.ok).toBe(true);

    // 3 — confirm it is verified (no SLO violations).
    const res3 = await step('evaluate', () => call(sync, 'evaluate'));
    const verdicts = (JSON.parse(res3.text) as { verdicts: Array<{ status: string }> }).verdicts;
    const violations = verdicts.filter((v) => v.status === 'violation').length;

    // eslint-disable-next-line no-console
    console.log(
      `\nAI-via-MCP design flow @ 5000 rps:\n${timings.join('\n')}\n` +
        `  → ${designs.length} verified designs; chose ${best.selection.svc} + ${best.selection.db} @ $${best.cost}/mo\n` +
        `  → applied design: ${verdicts.length} verdicts, ${violations} violations\n` +
        `  TOTAL: ${calls} tool calls, ${Math.round(performance.now() - wall0)} ms (vs ~12–15 fine-grained calls + per-step LLM reasoning the old way)\n`,
    );

    expect(violations).toBe(0); // the synthesized + applied design meets its SLOs, first try
    expect(calls).toBe(3);
  });
});

// the uncertainty WORKFLOW the owner's Copilot session wandered through (no recipe, forked the file,
// "nic się nie zmieniło"). With the file tools + the instructions recipe, an agent completes it in the exact
// order with ZERO wrong calls: import the open file → declare a range → run Monte Carlo → save it back.
const WS = resolve('sda-ai-flow-ws');
const wsAt = (name: string): string => resolve(WS, name);
function memFs(seed: Record<string, string>): FileSystemPort & { store: Record<string, string> } {
  const store: Record<string, string> = { ...seed };
  return {
    store,
    exists: (abs) => abs in store,
    read: (abs) => {
      if (!(abs in store)) throw new Error(`ENOENT: ${abs}`);
      return store[abs] as string;
    },
    write: (abs, text) => {
      store[abs] = text;
    },
    listSdaFiles: (roots) => Object.keys(store).filter((p) => p.endsWith('.sda.json') && roots.some((r) => withinRoots([r], p))),
  };
}
function openDesignJson(): string {
  const s = new Studio(registry, allManifests);
  s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
  s.dispatch({ kind: 'addComponent', id: 'pg', type: 'db.postgres' });
  s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['pg', 'in'] });
  s.dispatch({ kind: 'setConfig', node: 'client', key: 'throughput', value: 1000 });
  return serialize(s.project());
}

describe('AI-via-MCP: the uncertainty workflow on the OPEN file (import → set_range → uncertainty → save)', () => {
  it('an agent completes the recipe with zero wrong tool calls, and the human sees it', async () => {
    const studio = new Studio(registry, allManifests);
    const fs = memFs({ [wsAt('open.sda.json')]: openDesignJson() });
    const tools: AnyTool[] = [...buildFileTools(studio, fs, [WS]), ...buildTools(studio), ...buildUncertaintyTools(studio, bindSolvers(registry))];
    const call = (name: string, a: Record<string, unknown> = {}): Promise<ToolResult> =>
      Promise.resolve((tools.find((t) => t.name === name) as AnyTool).run(a));

    // 1 — import the file the human has open (not a fork).
    const r1 = await call('import_design', { path: 'open.sda.json' });
    expect(r1.ok, r1.text).toBe(true);

    // 2 — declare the soft input as a ± range (a traffic figure that is really 800–1,500).
    const r2 = await call('set_range', { node: 'client', key: 'throughput', lo: 800, hi: 1500 });
    expect(r2.ok, r2.text).toBe(true);

    // 3 — run Monte Carlo: the conclusions come back as distributions (+ the tornado of what drives them).
    const r3 = await call('uncertainty', { n: 200, seed: 1 });
    expect(r3.ok, r3.text).toBe(true);
    expect(JSON.parse(r3.text)).toHaveProperty('metrics');

    // 4 — save it BACK to the open file (this is what makes the human's canvas move).
    const r4 = await call('save_design', {});
    expect(r4.ok, r4.text).toBe(true);
    expect(r4.text).toContain('Uncertainty'); // the result tells the agent what the human now sees

    // the file the human has open now carries the range — the canvas will light the Uncertainty block on reload.
    expect(fs.store[wsAt('open.sda.json')]).toContain('ranges');
  });
});

// apply_design must report ALL problems in ONE response and apply NOTHING (never first-error-abort to a
// half/zero-node canvas). This pins the multi-problem response SHAPE — several distinct problems in a single reply.
describe('AI-via-MCP: apply_design collects every problem in one response (F1)', () => {
  it('an unknown type AND an ambiguous port AND a bad port all come back at once; nothing is applied', () => {
    const studio = new Studio(registry, allManifests);
    const apply = buildTools(studio).find((t) => t.name === 'apply_design') as AnyTool;
    const r = apply.run({
      instances: [
        { id: 'ghost', type: 'lambda' }, // problem 1: unknown type
        { id: 'cmd', type: 'compute.service' },
        { id: 'pg', type: 'db.postgres' },
      ],
      wires: [
        ['cmd', 'pg'], // problem 2: cmd has several out ports → ambiguous
        ['cmd', 'db', 'pg', 'nope'], // problem 3: pg has no in port "nope"
      ],
    }) as ToolResult;

    expect(r.ok).toBe(false);
    // every problem is present in the SAME response (not one-at-a-time).
    expect(r.text).toContain('unknown type "lambda"');
    expect(r.text).toContain('ambiguous');
    expect(r.text).toContain('no in port "nope"');
    expect(r.text).toMatch(/3 problems/);
    // atomic: nothing was applied — the canvas stays empty, no half-build to strand the agent.
    expect(studio.project().instances).toHaveLength(0);
  });
});
