import { copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Studio, deserialize } from '@sda/core';
import { registry, allManifests } from '@sda/content';
import { buildTools, type AnyTool, type AsyncToolDef, type ToolResult } from './tools';
import { buildUncertaintyTools } from './uncertainty';
import { bindSolvers } from './composition';

// ASSUMPTION UNCERTAINTY over MCP (doc: uncertainty-monte-carlo §4) — the minimal surface the owner can TRY before
// R3: set_range/clear_range declare ranges, run_uncertainty draws N scenarios through the CONTRACT's native
// EvaluateBatch and returns the §3 shapes. These tests pin the guided errors, the happy path (distributions +
// tornado), reproducibility, and the wall-clock of 1,000 scenarios on the finale design via the native binding.

const solvers = bindSolvers(registry); // native by default ⇒ evaluateBatch is bound (no WASM, no process spawn)

interface Fixture {
  readonly studio: Studio;
  readonly call: (name: string, a?: Record<string, unknown>) => ToolResult;
  readonly runUnc: (a?: Record<string, unknown>) => Promise<ToolResult>;
}

/** A Studio with the sync command tools + the async run_uncertainty tool, both over the same core. */
function fixture(): Fixture {
  const studio = new Studio(registry, allManifests);
  const tools = buildTools(studio);
  const unc = buildUncertaintyTools(studio, solvers);
  const call = (name: string, a: Record<string, unknown> = {}): ToolResult => (tools.find((t) => t.name === name) as AnyTool).run(a) as ToolResult;
  const runUnc = (a: Record<string, unknown> = {}): Promise<ToolResult> => (unc.find((t) => t.name === 'uncertainty') as AsyncToolDef).run(a);
  return { studio, call, runUnc };
}

/** A gen(compute.service, assumedRps) → sink(storage.object) design — a pay-per-use sink whose cost is linear in the
 *  originated load, so a range on assumedRps produces a legible cost distribution. */
function applyLinearDesign(f: Fixture): void {
  const applied = f.call('apply_design', {
    instances: [
      { id: 'gen', type: 'compute.service', config: { assumedRps: 500, concurrency: 100000 } },
      { id: 'sink', type: 'storage.object', config: { throughput: 100000000, unitCost: 0.1 } },
    ],
    wires: [['gen', 'out', 'sink', 'in']],
  });
  if (!applied.ok) throw new Error(`apply_design failed: ${applied.text}`);
}

describe('set_range / clear_range — guided errors and the additive range surface', () => {
  it('guides every unsound input to the fix (the MCP contract: each error names the next action)', () => {
    const f = fixture();
    applyLinearDesign(f);
    // unknown node → the error lists the real nodes
    expect(f.call('set_range', { node: 'ghost', key: 'unitCost', lo: 0.1, hi: 0.2 }).text).toContain('gen');
    // unknown config value → the error lists the node's real knobs
    const badKey = f.call('set_range', { node: 'sink', key: 'notaknob', lo: 1, hi: 2 });
    expect(badKey.ok).toBe(false);
    expect(badKey.text).toContain('unitCost');
    // lo > hi → the range cannot bracket its value
    expect(f.call('set_range', { node: 'sink', key: 'unitCost', lo: 0.5, hi: 0.1 }).ok).toBe(false);
    // triangular mode outside [lo, hi]
    const badMode = f.call('set_range', { node: 'sink', key: 'unitCost', lo: 0.1, hi: 0.2, mode: 0.9 });
    expect(badMode.ok).toBe(false);
    expect(badMode.text).toContain('mode');
    // a universal knob (assumedRps) is a real config value once set with set_config → then it is rangeable
    expect(f.call('set_range', { node: 'gen', key: 'assumedRps', lo: 200, hi: 800 }).ok).toBe(true);
  });

  it('clear_range removes a declared range and errors honestly on a missing one', () => {
    const f = fixture();
    applyLinearDesign(f);
    expect(f.call('set_range', { node: 'sink', key: 'unitCost', lo: 0.08, hi: 0.12 }).ok).toBe(true);
    expect(f.call('clear_range', { node: 'sink', key: 'unitCost' }).ok).toBe(true);
    expect(f.call('clear_range', { node: 'sink', key: 'unitCost' }).ok).toBe(false); // already gone
  });
});

describe('run_uncertainty — the Monte-Carlo surface', () => {
  it('reports nothing to run when no range is declared (no-filler)', async () => {
    const f = fixture();
    applyLinearDesign(f);
    const r = await f.runUnc({});
    expect(r.ok).toBe(false);
    expect(r.text).toContain('no uncertainty ranges declared');
  });

  it('returns per-metric distributions, SLO confidence, a tornado, and the seed + N — reproducibly', async () => {
    const f = fixture();
    applyLinearDesign(f);
    f.call('set_range', { node: 'gen', key: 'assumedRps', lo: 200, hi: 800 });
    const a = await f.runUnc({ n: 800, seed: 42 });
    expect(a.ok).toBe(true);
    const out = JSON.parse(a.text) as {
      seed: number;
      scenarios: number;
      rangedInputs: string[];
      metrics: { metric: string; median: number; p5: number; p95: number }[];
      tornado: { metric: string; input: string; sharePct: number }[];
    };
    expect(out.seed).toBe(42);
    expect(out.scenarios).toBe(800);
    expect(out.rangedInputs).toContain('gen.assumedRps (uniform)');
    const cost = out.metrics.find((m) => m.metric === 'cost')!;
    expect(cost.p95).toBeGreaterThan(cost.median);
    expect(cost.median).toBeGreaterThan(cost.p5); // a real spread, not a point
    // the tornado attributes the whole cost spread to the only ranged input
    const costDriver = out.tornado.find((t) => t.metric === 'cost')!;
    expect(costDriver.input).toBe('gen.assumedRps');
    expect(costDriver.sharePct).toBeGreaterThan(99);
    // reproducibility: same seed ⇒ byte-identical output
    const b = await f.runUnc({ n: 800, seed: 42 });
    expect(b.text).toBe(a.text);
  });

  it('clamps N to the [1, 10000] budget', async () => {
    const f = fixture();
    applyLinearDesign(f);
    f.call('set_range', { node: 'gen', key: 'assumedRps', lo: 200, hi: 800 });
    const r = await f.runUnc({ n: 999999, seed: 1 });
    expect((JSON.parse(r.text) as { scenarios: number }).scenarios).toBe(10000);
  });
});

describe('run_uncertainty — 1,000 scenarios on the finale design (native binding wall-clock)', () => {
  it('runs the finale under a unitCost range and reports the timing', async () => {
    // Time 1,000 scenarios on the owner's live finale design through the native EvaluateBatch. To keep this suite
    // STRUCTURALLY UNABLE to touch the owner's working file, we COPY the example into the OS temp dir (a read-only
    // read of the source) and load the TEMP COPY — every file handle the test then holds is a temp path, so no edit
    // to this test can ever write back under examples/ (owner directive 2026-07-04; guarded by no-examples-writes.test.ts).
    // This is the interactive-adjacency claim: evaluation goes through the solver contract's native path
    // (~1 ms/eval), so 1k scenarios are seconds on CPU.
    const src = fileURLToPath(new URL('../../../examples/oracle-to-aurora-migration-repeat.sda.json', import.meta.url));
    const work = join(tmpdir(), `sda-finale-${process.pid}.sda.json`);
    copyFileSync(src, work); // read-only on the owner's file; the working copy lives in the temp dir
    const doc = deserialize(readFileSync(work, 'utf8'));
    if (!doc.ok) throw new Error(`finale did not load: ${doc.error}`);
    const f = fixture();
    f.studio.load(doc.value);

    // A range on a soft cost input (the full-load service's $/unit) — the finale's own knobs, unchanged on disk.
    expect(f.call('set_range', { node: 'full_load_service', key: 'unitCost', lo: 0.18, hi: 0.36 }).ok).toBe(true);

    const t0 = performance.now();
    const r = await f.runUnc({ n: 1000, seed: 7 });
    const elapsedMs = performance.now() - t0;
    expect(r.ok).toBe(true);
    const out = JSON.parse(r.text) as { scenarios: number; metrics: { metric: string }[] };
    expect(out.scenarios).toBe(1000);
    expect(out.metrics.some((m) => m.metric === 'cost')).toBe(true);
    // Report the wall-clock (visible in the test output). Generous ceiling so CI variance never flakes it; the
    // measured number is the deliverable, not the bound.
    console.log(`[uncertainty] finale — 1000 scenarios via native EvaluateBatch: ${elapsedMs.toFixed(1)} ms`);
    expect(elapsedMs).toBeLessThan(20000);
  });
});
