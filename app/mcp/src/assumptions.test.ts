import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, allManifests } from '@sda/content';
import { buildAssumptionTools } from './assumptions';
import { bindSolvers } from './composition';
import type { AsyncToolDef } from './tools';

// THE ASSUMPTION MODEL over MCP — the owner can DRIVE the whole model before any UI: the
// envelope (default answer), and named worlds (declare / set / list / evaluate). The role boundary is enforced with
// a guided error. The solver is the composition root's native binding (the shipped default).

const tools = (s: Studio): Record<string, AsyncToolDef> => {
  const out: Record<string, AsyncToolDef> = {};
  for (const t of buildAssumptionTools(s, registry, bindSolvers(registry))) out[t.name] = t;
  return out;
};

/** gen ORIGINATES traffic (assumedRps, huge capacity ⇒ it emits exactly that) → a sink capped at 5000 req/s. */
function studioWithDesign(): Studio {
  const s = new Studio(registry, allManifests);
  const must = (r: { ok: boolean; error?: string }): void => { if (!r.ok) throw new Error(r.error); };
  must(s.dispatch({ kind: 'addComponent', id: 'gen', type: 'compute.service' }));
  must(s.dispatch({ kind: 'setConfig', node: 'gen', key: 'assumedRps', value: 500 }));
  must(s.dispatch({ kind: 'setConfig', node: 'gen', key: 'concurrency', value: 1_000_000 }));
  must(s.dispatch({ kind: 'setConfig', node: 'gen', key: 'perRequestDuration', value: 1 }));
  must(s.dispatch({ kind: 'addComponent', id: 'sink', type: 'storage.object' }));
  must(s.dispatch({ kind: 'setConfig', node: 'sink', key: 'throughput', value: 5000 }));
  must(s.dispatch({ kind: 'connect', from: ['gen', 'out'], to: ['sink', 'in'] }));
  return s;
}

describe('MCP — the envelope tool', () => {
  it('reports the capacity edge and the first break with no declared demand', async () => {
    const s = studioWithDesign();
    const r = await tools(s).envelope!.run({});
    expect(r.ok).toBe(true);
    expect(r.text).toContain('holds to 5000 req/s'); // the sink capacity edge
    expect(r.text).toContain('first break: sink');
  });

  it('says WHY when the design has no traffic origin (never a fabricated boundary)', async () => {
    const s = new Studio(registry, allManifests);
    s.dispatch({ kind: 'addComponent', id: 'db', type: 'db.postgres' });
    const r = await tools(s).envelope!.run({});
    expect(r.ok).toBe(true);
    expect(r.text.toLowerCase()).toContain('origin');
  });
});

describe('MCP — named worlds (declare / set / list / evaluate)', () => {
  it('declares a world, lists it, and refuses a non-fact-assumption override with a guided error', async () => {
    const s = studioWithDesign();
    const t = tools(s);
    expect((await t.declare_scenario!.run({ id: 'pessimistic', overrides: [{ node: 'gen', key: 'assumedRps', value: 4000 }] })).ok).toBe(true);
    expect((await t.set_scenario_value!.run({ scenario: 'pessimistic', node: 'gen', key: 'assumedRps', value: 6000 })).ok).toBe(true);

    // the ROLE BOUNDARY: an override on a resource-limit key is refused, naming the role + the right surface
    const bad = await t.set_scenario_value!.run({ scenario: 'pessimistic', node: 'gen', key: 'concurrency', value: 10 });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('resource limit');

    const list = await t.list_scenarios!.run({});
    expect(list.ok).toBe(true);
    const parsed = JSON.parse(list.text) as { id: string; overrides: { node: string; key: string; value: number }[] }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.overrides).toEqual([{ node: 'gen', key: 'assumedRps', value: 6000 }]);
  });

  it('derive_scenarios authors the pessimistic/real/optimistic trio from the envelope, badged derived', async () => {
    const s = studioWithDesign();
    const t = tools(s);
    const r = await t.derive_scenarios!.run({});
    expect(r.ok).toBe(true);
    expect(r.text).toContain('gen.assumedRps=3000'); // real ≈ 60% of the 5000 envelope
    // the trio landed in the doc, each value badged `derived`
    expect(s.project().scenarios.map((x) => x.id)).toEqual(['pessimistic', 'real', 'optimistic']);
    const real = s.project().scenarios.find((x) => x.id === 'real')!;
    expect(real.overrides[0]).toMatchObject({ node: 'gen', key: 'assumedRps', value: 3000, provenance: 'derived' });
    const pess = s.project().scenarios.find((x) => x.id === 'pessimistic')!;
    expect(pess.overrides[0]!.value).toBe(5500); // 5000 × 1.10 — past the edge (a stress world)
  });

  it('re-running derive_scenarios PRESERVES a value the architect froze', async () => {
    const s = studioWithDesign();
    const t = tools(s);
    await t.derive_scenarios!.run({});
    await t.set_scenario_value!.run({ scenario: 'real', node: 'gen', key: 'assumedRps', value: 8888 }); // freezes it
    await t.derive_scenarios!.run({}); // re-derive
    const real = s.project().scenarios.find((x) => x.id === 'real')!;
    expect(real.overrides.find((o) => o.node === 'gen' && o.key === 'assumedRps')).toMatchObject({ value: 8888, provenance: 'architect' });
  });

  it('derive_scenarios is honest empty-with-reason when there is no origin/range to derive from', async () => {
    const s = new Studio(registry, allManifests);
    s.dispatch({ kind: 'addComponent', id: 'db', type: 'db.postgres' });
    const r = await tools(s).derive_scenarios!.run({});
    expect(r.ok).toBe(true);
    expect(r.text).toContain('No trio derived');
  });

  it('reset_scenario WIPES a trio world back to freshly-derived (dropping a frozen edit)', async () => {
    const s = studioWithDesign();
    const t = tools(s);
    await t.derive_scenarios!.run({}); // real ≈ 3000 derived
    await t.set_scenario_value!.run({ scenario: 'real', node: 'gen', key: 'assumedRps', value: 8888 }); // freezes it
    const r = await t.reset_scenario!.run({ id: 'real' });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('freshly-derived');
    const real = s.project().scenarios.find((x) => x.id === 'real')!;
    // frozen 8888 dropped, re-tracks the envelope (3000), badged derived again
    expect(real.overrides.find((o) => o.node === 'gen' && o.key === 'assumedRps')).toMatchObject({ value: 3000, provenance: 'derived' });
  });

  it('reset_scenario CLEARS a custom world to base (falls back to base) and refuses an unknown id', async () => {
    const s = studioWithDesign();
    const t = tools(s);
    await t.declare_scenario!.run({ id: 'peak', overrides: [{ node: 'gen', key: 'assumedRps', value: 6000 }] });
    const r = await t.reset_scenario!.run({ id: 'peak' });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('falls back to the base');
    expect(s.project().scenarios.find((x) => x.id === 'peak')!.overrides).toEqual([]);

    const bad = await t.reset_scenario!.run({ id: 'ghost' });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('no named world');
  });

  it('evaluate_scenarios returns the base + every world (one batch) with per-world cost and verdict', async () => {
    const s = studioWithDesign();
    const t = tools(s);
    await t.declare_scenario!.run({ id: 'quiet', overrides: [{ node: 'gen', key: 'assumedRps', value: 100 }] });
    await t.declare_scenario!.run({ id: 'stress', overrides: [{ node: 'gen', key: 'assumedRps', value: 6000 }] }); // past the 5000 edge

    const r = await t.evaluate_scenarios!.run({});
    expect(r.ok).toBe(true);
    expect(r.text).toContain('World comparison');
    expect(r.text).toMatch(/- base:/);
    expect(r.text).toContain('quiet');
    // the stress world exceeds the sink capacity ⇒ it must show a violation (the derived stress world earning its keep)
    expect(r.text).toContain('stress');
    expect(r.text).toContain('violation');
  });
});
