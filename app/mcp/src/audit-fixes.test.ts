import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, commonManifests, allManifests, keys } from '@sda/content';
import { buildTools, type ToolResult } from './tools';
import { buildSearchTools } from './search';
import { bindSolvers } from './composition';

// The readiness-audit AGENT-path fixes (TASK-84): F2 (no false green on an originless design) and F10 (a
// backward-search proposal is applyable in one call; repair with no SLO guides instead of a confusing no-op).

describe('F2 — evaluate is honest about an originless / empty design (no false green)', () => {
  const evaluated = (s: Studio): { ok: boolean; note?: string; feasible?: boolean } => {
    const t = buildTools(s).find((x) => x.name === 'evaluate');
    if (t === undefined) throw new Error('no evaluate tool');
    const r = t.run({}) as ToolResult;
    return { ok: r.ok, ...(JSON.parse(r.text) as { note?: string; feasible?: boolean }) };
  };

  it('an empty design says so + names the enabling move', () => {
    const out = evaluated(new Studio(registry, allManifests));
    expect(out.note).toMatch(/empty design/);
  });

  it('nodes but NO traffic origin: says so and points at assumedRps / a client / envelope', () => {
    const s = new Studio(registry, allManifests);
    s.dispatch({ kind: 'addComponent', id: 'pg', type: 'db.postgres' });
    const out = evaluated(s);
    expect(out.note).toMatch(/no traffic origin/);
    expect(out.note).toMatch(/assumedRps|client|envelope/);
  });

  it('a design WITH an origin reads clean — no note', () => {
    const s = new Studio(registry, allManifests);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
    s.dispatch({ kind: 'addComponent', id: 'pg', type: 'db.postgres' });
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['pg', 'in'] });
    s.dispatch({ kind: 'setConfig', node: 'client', key: 'throughput', value: 500 });
    expect(evaluated(s).note).toBeUndefined();
  });
});

describe('F10 — apply_solution enacts a backward-search proposal; repair guides with no SLOs', () => {
  function seed(): Studio {
    const s = new Studio(registry, commonManifests);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
    s.dispatch({ kind: 'addComponent', id: 'app', type: 'compute.service' });
    s.dispatch({ kind: 'addComponent', id: 'pg', type: 'db.postgres' });
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['app', 'in'] });
    s.dispatch({ kind: 'connect', from: ['app', 'db'], to: ['pg', 'in'] });
    s.dispatch({ kind: 'setConfig', node: 'client', key: 'throughput', value: 5000 });
    s.dispatch({ kind: 'setSLO', node: 'pg', key: keys.throughput, band: { shape: 'minTargetMax', min: 5000 } });
    return s;
  }

  it('repair carries an applyable id → apply_solution enacts it in ONE call → the violation clears', async () => {
    const s = seed();
    const tools = buildSearchTools(s, bindSolvers(registry)); // ONE build so the solution store is shared
    const repair = tools.find((t) => t.name === 'repair');
    const applySol = tools.find((t) => t.name === 'apply_solution');
    if (repair === undefined || applySol === undefined) throw new Error('missing search tools');

    expect(s.verdicts().filter((v) => v.status === 'violation').length).toBeGreaterThan(0);

    const rp = await repair.run({});
    expect(rp.ok, rp.text).toBe(true);
    const changes = JSON.parse(rp.text) as Array<{ node: string; key: string; to: number; solution: string }>;
    expect(changes[0]?.solution).toMatch(/^sol-\d+$/); // the response includes an applyable solution id

    const ap = await applySol.run({}); // {} = the latest proposal — no id transcription
    expect(ap.ok, ap.text).toBe(true);
    expect(ap.text).toContain('applied');
    expect(s.verdicts().filter((v) => v.status === 'violation').length).toBe(0); // enacted — the SLO now holds
  });

  it('apply_solution with nothing stored guides the agent to run repair/optimize first', async () => {
    const ap = await buildSearchTools(seed(), bindSolvers(registry)).find((t) => t.name === 'apply_solution')!.run({});
    expect(ap.ok).toBe(false);
    expect(ap.text).toMatch(/run repair or optimize/);
  });

  it('repair with NO SLO declares nothing to do — guidance, not a confusing "already within SLOs" no-op', async () => {
    const s = new Studio(registry, commonManifests);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
    s.dispatch({ kind: 'addComponent', id: 'pg', type: 'db.postgres' });
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['pg', 'in'] });
    s.dispatch({ kind: 'setConfig', node: 'client', key: 'throughput', value: 100 });
    const rp = await buildSearchTools(s, bindSolvers(registry)).find((t) => t.name === 'repair')!.run({});
    expect(rp.ok).toBe(false);
    expect(rp.text).toContain('no SLOs declared');
  });
});
