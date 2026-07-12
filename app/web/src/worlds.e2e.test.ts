import { describe, expect, it } from 'vitest';
import { Studio, emptyProject } from '@sda/core';
import {
  registry, allManifests, computeEnvelope, deriveDefaultScenarios, mergeDerivedTrio, resetScenario, evaluateWorlds,
  applyScenarioToGraph, isScenarioOverridable, hasScenarios,
} from '@sda/content';
import { evaluate } from '@sda/engine-solve';
import { envelopeSection, worldsMatrix } from '@sda/presenter';
import { bindBrowserSolvers } from './composition';

// THE ASSUMPTION MODEL, web wiring — driven through the SAME calls the System
// panel makes (web-is-a-dumb-renderer): the in-process solver (bindBrowserSolvers) → computeEnvelope /
// deriveDefaultScenarios / evaluateWorlds → the presenter view-models. Plus the active-lens overlay (a world's
// verdicts differ from the base) and the edit-routing decision (setScenarioOverride vs setConfig).

const catalog = allManifests;

/** A source client (throughput = its offered demand) → a service capped at 2,000 req/s (the auto overflow band binds
 *  there) — the finale's shape in miniature. */
function studioWithDesign(): Studio {
  const s = new Studio(registry, catalog);
  s.dispatch({ kind: 'addComponent', id: 'users', type: 'client.web' });
  s.dispatch({ kind: 'setConfig', node: 'users', key: 'throughput', value: 800 });
  s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.service' });
  s.dispatch({ kind: 'setConfig', node: 'svc', key: 'concurrency', value: 200 });
  s.dispatch({ kind: 'setConfig', node: 'svc', key: 'perRequestDuration', value: 100 }); // capacity = 200×10 = 2000 rps
  s.dispatch({ kind: 'connect', from: ['users', 'out'], to: ['svc', 'in'] });
  return s;
}

describe('web assumption model — envelope, the derived trio, worlds matrix, the active lens', () => {
  it('the envelope headline is the default answer, and the trio is 110/60/30% of it (badged derived)', async () => {
    const s = studioWithDesign();
    const solvers = await bindBrowserSolvers(registry);
    const proj = s.project();
    const env = await computeEnvelope({ instances: proj.instances, wires: proj.wires, registry, catalog }, solvers.optimize!);
    expect(env.perOrigin[0]!.maxRps).toBe(2000); // the service capacity edge (auto overflow band)
    const section = envelopeSection({ result: env }, (id) => id)!;
    expect(section.rows[0]!.value).toContain('handles up to 2,000 req/s');

    // DERIVE THE TRIO — the same calls the "✨ Derive trio" button makes
    const derived = deriveDefaultScenarios({ instances: proj.instances, wires: proj.wires, catalog, envelope: env });
    const merged = mergeDerivedTrio(proj.scenarios, derived.scenarios);
    expect(s.dispatchBatch(merged.map((w) => ({ kind: 'declareScenario', decl: w }))).ok).toBe(true);
    const real = s.project().scenarios.find((w) => w.id === 'real')!;
    expect(real.overrides[0]).toMatchObject({ node: 'users', key: 'throughput', value: 1200, provenance: 'derived' }); // 2000 × 0.60
  });

  it('the worlds matrix reflects all worlds; the active-lens overlay changes the verdicts (the stress world breaks)', async () => {
    const s = studioWithDesign();
    const solvers = await bindBrowserSolvers(registry);
    const proj = s.project();
    const env = await computeEnvelope({ instances: proj.instances, wires: proj.wires, registry, catalog }, solvers.optimize!);
    const derived = deriveDefaultScenarios({ instances: proj.instances, wires: proj.wires, catalog, envelope: env });
    s.dispatchBatch(mergeDerivedTrio(proj.scenarios, derived.scenarios).map((w) => ({ kind: 'declareScenario', decl: w })));

    const g = s.graph();
    if (!g.ok) throw new Error('build failed');
    const proj2 = s.project();
    const worlds = await evaluateWorlds({ graph: g.value, instances: proj2.instances, wires: proj2.wires, scenarios: proj2.scenarios }, solvers.evaluateBatch!);
    const matrix = worldsMatrix({ result: worlds, active: 'real' }, (id) => id)!;
    expect(matrix.title).toBe('Worlds · lens: Real');
    // pessimistic demand (2,200, past the 2,000 edge) ⇒ that world violates; real (1,200) is feasible
    expect(worlds.worlds.find((w) => w.id === 'pessimistic')!.feasible).toBe(false);
    expect(worlds.worlds.find((w) => w.id === 'real')!.feasible).toBe(true);

    // THE ACTIVE-LENS OVERLAY (the canvas core): evaluating the pessimistic-overlaid graph shows a violation the
    // base does not — the same overlay app.tsx feeds into `verds` when a world is active.
    const pessWorld = proj2.scenarios.find((w) => w.id === 'pessimistic')!;
    const overlaid = evaluate(applyScenarioToGraph(g.value, pessWorld), registry);
    const base = evaluate(g.value, registry);
    const viol = (e: typeof overlaid): number => (e.ok ? e.value.verdicts.filter((v) => v.status === 'violation').length : 0);
    expect(viol(overlaid)).toBeGreaterThan(viol(base));
  });

  it('the edit-routing decision: a demand knob is world-overridable; a limit / computed is not (base edit)', () => {
    const s = studioWithDesign();
    const { instances, wires } = s.project();
    expect(isScenarioOverridable('users', 'throughput', instances, wires)).toBe(true); // a source client's demand
    expect(isScenarioOverridable('svc', 'concurrency', instances, wires)).toBe(false); // a resource limit
    expect(isScenarioOverridable('svc', 'throughput', instances, wires)).toBe(false); // a computed capacity, not an origin
    expect(hasScenarios(s.project().scenarios)).toBe(false);
  });
});

// THE CONSISTENCY RELIGION (owner) — "what I see is what is": with a world active, a demand/service-time edit lands
// in THAT world (never base), and the overlaid canvas shows it; with no world, it edits base. This drives the exact
// routing `commitConfig` performs, plus the RESET and NEW-DESIGN affordances.
describe('web — the consistency religion: edit routing, reset, new design', () => {
  async function withTrio(): Promise<Studio> {
    const s = studioWithDesign();
    const solvers = await bindBrowserSolvers(registry);
    const proj = s.project();
    const env = await computeEnvelope({ instances: proj.instances, wires: proj.wires, registry, catalog }, solvers.optimize!);
    const derived = deriveDefaultScenarios({ instances: proj.instances, wires: proj.wires, catalog, envelope: env });
    s.dispatchBatch(mergeDerivedTrio(proj.scenarios, derived.scenarios).map((w) => ({ kind: 'declareScenario', decl: w })));
    return s;
  }

  it('LENS ON — the edit lands in the active world, base untouched, the overlaid canvas shows it', async () => {
    const s = await withTrio();
    s.setActiveScenario('real');
    const active = s.activeScenario()!;
    expect(active).toBe('real');

    // The exact commitConfig routing: active + overridable ⇒ setScenarioOverride into the active world.
    s.dispatch({ kind: 'setScenarioOverride', scenario: active, node: 'users', key: 'throughput', value: 1600 });
    const real = s.project().scenarios.find((w) => w.id === 'real')!;
    expect(real.overrides.find((o) => o.node === 'users' && o.key === 'throughput')?.value).toBe(1600); // in the world
    expect(s.project().instances.find((i) => i.id === 'users')?.config?.throughput).toBe(800); // BASE untouched — religion

    // THE CANVAS SHOWS IT: the active-lens overlay substitutes the fixed input cell the whole pipeline evaluates.
    const g = s.graph();
    if (!g.ok) throw new Error('build failed');
    const overlaid = applyScenarioToGraph(g.value, real);
    let cellVal: number | undefined;
    for (const n of overlaid.nodes.values()) {
      if (String(n.id) !== 'users') continue;
      for (const c of n.cells) if (String(c.key) === 'throughput' && c.kind === 'input' && c.value.kind === 'fixed') cellVal = c.value.quantity.value;
    }
    expect(cellVal).toBe(1600);
  });

  it('LENS OFF — the edit writes the shared base (setConfig)', () => {
    const s = studioWithDesign();
    s.setActiveScenario(undefined);
    s.dispatch({ kind: 'setConfig', node: 'users', key: 'throughput', value: 950 });
    expect(s.project().instances.find((i) => i.id === 'users')?.config?.throughput).toBe(950);
  });

  it('RESET — resetWorld wipes a frozen trio world back to freshly-derived (frozen dropped)', async () => {
    const s = await withTrio();
    const proj = s.project();
    const solvers = await bindBrowserSolvers(registry);
    const env = await computeEnvelope({ instances: proj.instances, wires: proj.wires, registry, catalog }, solvers.optimize!);
    const fresh = deriveDefaultScenarios({ instances: proj.instances, wires: proj.wires, catalog, envelope: env }).scenarios;
    s.dispatch({ kind: 'setScenarioOverride', scenario: 'real', node: 'users', key: 'throughput', value: 9999 }); // freeze
    // resetWorld's core: fresh derivation → resetScenario → declareScenario (replace-in-place).
    const reset = resetScenario(s.project().scenarios, fresh, 'real')!;
    s.dispatch({ kind: 'declareScenario', decl: reset });
    const real = s.project().scenarios.find((w) => w.id === 'real')!;
    expect(real.overrides.find((o) => o.node === 'users' && o.key === 'throughput')).toMatchObject({ value: 1200, provenance: 'derived' });
  });

  it('NEW DESIGN — resets to an empty project, undoably (no data loss)', () => {
    const s = studioWithDesign();
    expect(s.project().instances.length).toBeGreaterThan(0);
    s.replaceDoc(emptyProject('p1', 'Untitled')); // the newDesign core (replaceDoc keeps it undoable)
    expect(s.project().instances).toHaveLength(0);
    expect(s.project().name).toBe('Untitled');
    expect(s.canUndo()).toBe(true);
    s.undo();
    expect(s.project().instances.length).toBeGreaterThan(0); // Undo restores the prior design — nothing lost
  });
});
