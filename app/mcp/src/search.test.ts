import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { NodeId, type Key } from '@sda/engine-core';
import { commonManifests, registry, keys, localContribution, TARGET_UTILIZATION } from '@sda/content';
import { buildSearchTools } from './search';
import { bindSolvers } from './composition';

// Backward search exercised end-to-end through the MCP tools with the native COIN-BC solver. Mirrors
// the engine facade tests but at the tool surface — proving an agent can "run the design backwards".
function seed(): Studio {
  const s = new Studio(registry, commonManifests);
  s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
  s.dispatch({ kind: 'addComponent', id: 'nginx', type: 'proxy.nginx' });
  s.dispatch({ kind: 'addComponent', id: 'app', type: 'compute.service' });
  s.dispatch({ kind: 'addComponent', id: 'pg', type: 'db.postgres' });
  s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['nginx', 'in'] });
  s.dispatch({ kind: 'connect', from: ['nginx', 'out'], to: ['app', 'in'] });
  s.dispatch({ kind: 'connect', from: ['app', 'db'], to: ['pg', 'in'] });
  s.dispatch({ kind: 'setSLO', node: 'pg', key: keys.throughput, band: { shape: 'minTargetMax', min: 5000 } });
  return s;
}

const call = (s: Studio, name: string) => {
  const t = buildSearchTools(s, bindSolvers(registry)).find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t.run({});
};

describe('MCP backward-search tools (native COIN-BC)', () => {
  it('repair finds the minimal knob change that meets the SLO', async () => {
    // pg throughput = concurrency / (50ms) = 100/0.05 = 2,000 < 5,000. repair sizes each tier to ρ ≤ 80% headroom
    // (finite queueing latency, not the ρ=1 knife-edge), so it raises pg.concurrency to 250 / 0.8 = 312.5, not the
    // bare 250 that would meet the throughput floor exactly but leave the queue on the edge of blowing up.
    const r = await call(seed(), 'repair');
    expect(r.ok).toBe(true);
    const changes = JSON.parse(r.text) as Array<{ node: string; key: string; from: number; to: number }>;
    const pg = changes.find((c) => c.node === 'pg' && c.key === 'concurrency');
    expect(pg).toBeDefined();
    expect(pg?.from).toBeCloseTo(100, 4);
    expect(pg?.to).toBeCloseTo(250 / TARGET_UTILIZATION, 2); // 312.5 = the bare 250 target + the ρ ≤ 80% headroom
  });

  it('explain_infeasible reports feasibility when the SLO is reachable by tuning', async () => {
    const r = await call(seed(), 'explain_infeasible');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('feasible');
  });

  it('right-sizes a fleet: repair raises maxUnits to clear overflow (Fargate-style sizing)', async () => {
    const s = new Studio(registry, commonManifests);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
    s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.fargate' });
    s.dispatch({ kind: 'setConfig', node: 'client', key: 'throughput', value: 50000 });
    s.dispatch({ kind: 'setConfig', node: 'svc', key: 'maxUnits', value: 1 }); // capacity 1×1600 ≪ 50000 ⇒ overflow
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['svc', 'in'] });
    const r = await call(s, 'repair');
    expect(r.ok).toBe(true);
    const changes = JSON.parse(r.text) as Array<{ node: string; key: string; to: number }>;
    const mu = changes.find((c) => c.node === 'svc' && c.key === 'maxUnits');
    expect(mu).toBeDefined();
    expect(mu?.to).toBeCloseTo(50000 / 1600 / TARGET_UTILIZATION, 1); // ≈ 39.06 = 31.25 tasks for the load + ρ ≤ 80% headroom
  });
});

describe('MCP optimize {scope:"system"} — the whole-design total-cost objective (dogfood F8)', () => {
  // A FAN-OUT with an off-path priced tier: client(1000 rps) feeds appA (carrying the throughput SLO) AND appB
  // (no SLO — the branch a single node's cumulative cost cell can never see). compute.service prices its
  // concurrency at $0.24/conc·month, so the whole-design total only minimises when BOTH pools shrink.
  const seedFanOut = (): Studio => {
    const s = new Studio(registry, commonManifests);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
    s.dispatch({ kind: 'addComponent', id: 'appA', type: 'compute.service' });
    s.dispatch({ kind: 'addComponent', id: 'appB', type: 'compute.service' });
    s.dispatch({ kind: 'setConfig', node: 'client', key: 'throughput', value: 1000 });
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['appA', 'in'] });
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['appB', 'in'] });
    s.dispatch({ kind: 'setSLO', node: 'appA', key: keys.throughput, band: { shape: 'minTargetMax', min: 800 } });
    return s;
  };
  // HAND-COMPUTED optimum: each pool serves 1,000 rps at 20 ms/request under the ρ ≤ 80% headroom, so the least
  // feasible concurrency is 1000 · 0.020 / 0.8 = 25 workers — on BOTH tiers. (The SLO floor 800 is slack there:
  // served = min(1000, 1250) = 1000.) The DEPLOYED bill quantizes each whole-unit knob UP from the bisection's
  // feasible side (25 + ε → 26 workers), so the enacted whole-design total is 2 · 26 · $0.24 = $12.48/month.
  const HAND_CONC = 25;
  const HAND_TOTAL = 2 * Math.ceil(HAND_CONC + 1e-9) * 0.24; // 2 · 26 · 0.24 = 12.48 — the deployable bill

  it('minimizes the SUM of every node\'s own cost — the off-path pool descends too (hand-computed: 25 + 25 workers)', async () => {
    const s = seedFanOut();
    const optimize = buildSearchTools(s, bindSolvers(registry)).find((t) => t.name === 'optimize')!;
    const r = await optimize.run({ key: 'cost', direction: 'min', scope: 'system' });
    expect(r.ok, r.text).toBe(true);
    const rows = JSON.parse(r.text) as Array<{ node: string; key: string; value: number }>;
    const a = rows.find((x) => x.node === 'appA' && x.key === 'concurrency');
    const b = rows.find((x) => x.node === 'appB' && x.key === 'concurrency');
    expect(a?.value).toBeCloseTo(HAND_CONC, 1);
    expect(b?.value, 'the OFF-PATH pool must descend under the system scope (the F8 gap)').toBeCloseTo(HAND_CONC, 1);
  });

  it('apply_solution enacts it and the evaluated whole-design total equals the hand-computed bill ($12/mo)', async () => {
    const s = seedFanOut();
    const tools = buildSearchTools(s, bindSolvers(registry)); // one build: the solution store is shared
    const r = await tools.find((t) => t.name === 'optimize')!.run({ key: 'cost', direction: 'min', scope: 'system' });
    expect(r.ok, r.text).toBe(true);
    const applied = await tools.find((t) => t.name === 'apply_solution')!.run({});
    expect(applied.ok, applied.text).toBe(true);
    const ev = s.evaluate();
    expect(ev.ok).toBe(true);
    if (!ev.ok) return;
    const value = (id: string, key: Key): number | undefined => ev.value.value(NodeId(id), key);
    const proj = s.project();
    const own = localContribution(value, proj.instances, proj.wires, keys.cost);
    const total = Object.values(own).reduce((sum, c) => sum + c, 0);
    expect(total).toBeCloseTo(HAND_TOTAL, 2); // 2 · 26 · $0.24 = $12.48/mo — the honest full bill, both branches priced
  });

  it('without a node and without the system scope, the guided error names both ways forward', async () => {
    const s = seedFanOut();
    const optimize = buildSearchTools(s, bindSolvers(registry)).find((t) => t.name === 'optimize')!;
    const r = await optimize.run({ key: 'cost', direction: 'min' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('optimize needs a target');
    expect(r.text).toContain('scope:"system"');
  });
});

describe('MCP robust improve across worlds (assumption-model §8) — opt-in, base-mode untouched', () => {
  // client(100) → app(concurrency 1 ⇒ cap ~1,000) with an overflow SLO. Two named worlds override the demand: a
  // comfortable one and a stress one past the edge. Robust repair must size app to hold BOTH (the stress world binds).
  // The BASE config deliberately keeps the LEGACY `throughput` spelling (client.web's pre-unification preset) —
  // proving the compatibility sugar carries it through the robust-improve path; the WORLDS override the
  // unified `assumedRps` knob directly (the only key a scenario can actually move, post-unification).
  const seedWorlds = (): Studio => {
    const s = new Studio(registry, commonManifests);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
    s.dispatch({ kind: 'addComponent', id: 'app', type: 'compute.service' });
    s.dispatch({ kind: 'setConfig', node: 'client', key: 'throughput', value: 100 });
    s.dispatch({ kind: 'setConfig', node: 'app', key: 'concurrency', value: 1 });
    s.dispatch({ kind: 'setConfig', node: 'app', key: 'perRequestDuration', value: 1 });
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['app', 'in'] });
    s.dispatch({ kind: 'setSLO', node: 'app', key: keys.overflow, band: { shape: 'minTargetMax', max: 0 } });
    s.dispatch({ kind: 'declareScenario', decl: { id: 'real', name: 'Real', overrides: [{ node: 'client', key: 'assumedRps', value: 500 }] } });
    s.dispatch({ kind: 'declareScenario', decl: { id: 'stress', name: 'Stress', overrides: [{ node: 'client', key: 'assumedRps', value: 5000 }] } });
    return s;
  };
  const runRepair = (s: Studio, args: Record<string, unknown>) => {
    const t = buildSearchTools(s, bindSolvers(registry)).find((x) => x.name === 'repair')!;
    return t.run(args);
  };

  it('repair {worlds:"all"} sizes for the binding world and reports it; the design then holds every world', async () => {
    const r = await runRepair(seedWorlds(), { worlds: 'all' });
    expect(r.ok).toBe(true);
    // Robust improve now speaks the SAME pure JSON envelope as the base search — no prose preamble — so the whole
    // text IS the changes array (parsed directly, not sliced past a summary line). The robust facts ride the rows:
    // each names the world that BINDS its knob via `bindingWorld` — here the stress world past the edge (not 'real'
    // or 'base'). Same values as before; only the text shape changed (dropped the "Robust repair …" framing line).
    const changes = JSON.parse(r.text) as Array<{ node: string; key: string; bindingWorld: string }>;
    const app = changes.find((c) => c.node === 'app');
    expect(app?.bindingWorld).toBe('stress');
  });

  it('base mode (no `worlds`) is the UNTOUCHED single-graph path — a plain change list, no robust framing', async () => {
    // At base demand (100 ≤ cap 1,000) there is no violation, so plain repair reports "already within SLOs" — the
    // exact today behaviour, with none of the robust wording.
    const r = await runRepair(seedWorlds(), {});
    expect(r.ok).toBe(true);
    expect(r.text).not.toContain('Robust repair');
    expect(r.text).toContain('already within SLOs');
  });
});
