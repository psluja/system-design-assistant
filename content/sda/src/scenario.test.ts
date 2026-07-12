import { describe, expect, it } from 'vitest';
import { NodeId, type Key } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { makeNativeAdapter } from '@sda/solver-contract/native';
import type { EvaluateBatch } from '@sda/solver-contract';
import { instantiate, allManifests, registry, keys, type Instance, type Wire } from './index';
import { systemSummary } from './system';
import { evaluateWorlds, scenarioProblems, overrideRoleProblem, isScenarioOverridable, toContractScenario, hasScenarios, type AssumptionScenario } from './scenario';

// NAMED WORLDS (scenarios) data core. The KEYSTONE property: a world IS the contract's
// Scenario, so evaluating it must equal a plain evaluate with the same fact-assumption overrides applied by hand.
// Plus the role boundary (only fact-assumptions overridable) and determinism. The evaluator is the CONTRACT's native
// EvaluateBatch — the same seam Monte-Carlo and the app ride.

const native = makeNativeAdapter({ registry });
const evaluateBatch: EvaluateBatch = native.evaluateBatch!;

/** gen ORIGINATES `assumedRps` (huge concurrency ⇒ it emits exactly that) → a pay-per-use sink (cost = inflow ×
 *  unitCost). So the whole-design cost moves with assumedRps — a fact-assumption a world overrides. */
const design = (): { instances: Instance[]; wires: Wire[] } => ({
  instances: [
    { id: 'gen', type: 'compute.service', config: { assumedRps: 500, concurrency: 1_000_000, perRequestDuration: 1 } },
    { id: 'sink', type: 'storage.object', config: { throughput: 100_000_000, unitCost: 0.1 }, bands: [{ key: keys.overflow, band: { shape: 'minTargetMax', max: 0 } }] },
  ],
  wires: [{ from: ['gen', 'out'], to: ['sink', 'in'] }],
});

/** Direct evaluate at a set of `node.key → value` overrides applied to the INSTANCE config, then the roll-up cost +
 *  violation count — the hand-computed reference a world must reproduce (bit-for-bit for the base, and with the
 *  overrides applied for a scenario). */
function referenceOf(d: { instances: Instance[]; wires: Wire[] }, overrides: Record<string, number>): { cost: number; violations: number } {
  const insts = d.instances.map((i) => {
    const cfg = { ...(i.config ?? {}) };
    for (const [coord, v] of Object.entries(overrides)) {
      const [node, key] = coord.split('|');
      if (node === i.id && key !== undefined) cfg[key] = v;
    }
    return { ...i, config: cfg };
  });
  const g = instantiate(allManifests, insts, d.wires);
  if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
  const ev = evaluate(g.value, registry);
  if (!ev.ok) throw new Error(`evaluate failed: ${ev.error.join('; ')}`);
  const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
  return { cost: systemSummary(insts, d.wires, value).cost.totalUsdMonth, violations: ev.value.verdicts.filter((v) => v.status === 'violation').length };
}

async function worldsOf(d: { instances: Instance[]; wires: Wire[] }, scenarios: readonly AssumptionScenario[]) {
  const g = instantiate(allManifests, d.instances, d.wires);
  if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
  return evaluateWorlds({ graph: g.value, instances: d.instances, wires: d.wires, scenarios }, evaluateBatch);
}

describe('named worlds — a world IS the contract Scenario (the keystone property)', () => {
  it('the base world is byte-for-byte the plain evaluation, and a world equals evaluate-with-overrides-applied', async () => {
    const d = design();
    const scenarios: AssumptionScenario[] = [
      { id: 'optimistic', overrides: [{ node: 'gen', key: 'assumedRps', value: 150 }] },
      { id: 'pessimistic', name: 'stress', overrides: [{ node: 'gen', key: 'assumedRps', value: 1200 }] },
    ];
    const res = await worldsOf(d, scenarios);
    expect(res.worlds.map((w) => w.id)).toEqual(['base', 'optimistic', 'pessimistic']); // base ALWAYS first

    // base world == plain evaluate (no overrides)
    const base = referenceOf(d, {});
    expect(res.worlds[0]!.costUsdMonth).toBeCloseTo(base.cost, 6);
    expect(res.worlds[0]!.violations).toBe(base.violations);

    // each named world == evaluate with its overrides applied by hand (the keystone: a world lowers to a Scenario)
    for (let i = 0; i < scenarios.length; i++) {
      const s = scenarios[i]!;
      const ref = referenceOf(d, toContractScenario(s).overrides);
      const w = res.worlds[i + 1]!;
      expect(w.costUsdMonth).toBeCloseTo(ref.cost, 6);
      expect(w.violations).toBe(ref.violations);
    }
    // the pessimistic world's friendly name rides through
    expect(res.worlds[2]!.name).toBe('stress');
  });

  it('the cost tracks the overridden fact-assumption (a higher-demand world costs more)', async () => {
    const d = design();
    const res = await worldsOf(d, [
      { id: 'low', overrides: [{ node: 'gen', key: 'assumedRps', value: 100 }] },
      { id: 'high', overrides: [{ node: 'gen', key: 'assumedRps', value: 2000 }] },
    ]);
    const low = res.worlds.find((w) => w.id === 'low')!;
    const high = res.worlds.find((w) => w.id === 'high')!;
    expect(high.costUsdMonth).toBeGreaterThan(low.costUsdMonth); // pay-per-use ⇒ more demand ⇒ more cost
  });

  it('is DETERMINISTIC — the same worlds evaluate identically', async () => {
    const d = design();
    const scenarios: AssumptionScenario[] = [{ id: 'w', overrides: [{ node: 'gen', key: 'assumedRps', value: 777 }] }];
    const a = await worldsOf(d, scenarios);
    const b = await worldsOf(d, scenarios);
    expect(a).toEqual(b);
  });

  it('reports and SKIPS a stale override (a node the design does not carry) — a soft lens, not a build error', async () => {
    const d = design();
    const res = await worldsOf(d, [{ id: 'w', overrides: [{ node: 'ghost', key: 'assumedRps', value: 100 }] }]);
    const w = res.worlds.find((x) => x.id === 'w')!;
    expect(w.staleOverrides).toEqual(['ghost.assumedRps']);
    // the stale override changed nothing — the world equals the base
    expect(w.costUsdMonth).toBeCloseTo(res.worlds[0]!.costUsdMonth, 6);
  });
});

describe('named worlds — the role boundary is enforced mechanically', () => {
  // Design-aware: overridability of a client's throughput depends on it being a SOURCE (no inbound wire).
  const noDesign: { instances: Instance[]; wires: Wire[] } = { instances: [], wires: [] };
  const clientSource: Instance[] = [{ id: 'users', type: 'client.source', config: { throughput: 2000 } }, { id: 'svc', type: 'compute.service' }];
  const clientWired: Wire[] = [{ from: ['users', 'out'], to: ['svc', 'in'] }];

  it('overrideRoleProblem: a fact-assumption passes; a limit / computed / promise is refused, naming its role', () => {
    expect(overrideRoleProblem('a', 'assumedRps', noDesign.instances, noDesign.wires)).toBeNull();
    expect(overrideRoleProblem('a', 'perRequestDuration', noDesign.instances, noDesign.wires)).toBeNull();
    expect(overrideRoleProblem('a', 'concurrency', noDesign.instances, noDesign.wires)).toContain('resource limit');
    expect(overrideRoleProblem('a', 'cost', noDesign.instances, noDesign.wires)).toContain('computed');
    expect(overrideRoleProblem('a', 'tailLatency', noDesign.instances, noDesign.wires)).toContain('promise');
    expect(overrideRoleProblem('a', 'nonsense', noDesign.instances, noDesign.wires)).toContain('not a known quantity');
  });

  it("a SOURCE client's throughput IS overridable demand; a non-origin's throughput is refused (points at the origin)", () => {
    // `users` is a client with no inbound wire — its throughput is its offered demand (doc §2), so it passes.
    expect(overrideRoleProblem('users', 'throughput', clientSource, clientWired)).toBeNull();
    expect(isScenarioOverridable('users', 'throughput', clientSource, clientWired)).toBe(true);
    // `svc` (a compute service) throughput is a COMPUTED capacity, not demand — refused, naming it is not an origin.
    const p = overrideRoleProblem('svc', 'throughput', clientSource, clientWired);
    expect(p).toContain('not an origin');
    expect(isScenarioOverridable('svc', 'throughput', clientSource, clientWired)).toBe(false);
  });

  it('scenarioProblems: rejects a non-fact-assumption override, a blank id, and a duplicate id', () => {
    expect(scenarioProblems([{ id: 'ok', overrides: [{ node: 'a', key: 'assumedRps', value: 1 }] }], noDesign.instances, noDesign.wires)).toEqual([]);
    expect(scenarioProblems([{ id: 'bad', overrides: [{ node: 'a', key: 'replicas', value: 3 }] }], noDesign.instances, noDesign.wires)[0]).toContain('resource limit');
    expect(scenarioProblems([{ id: '', overrides: [] }], noDesign.instances, noDesign.wires)[0]).toContain('no id');
    expect(scenarioProblems([{ id: 'x', overrides: [] }, { id: 'x', overrides: [] }], noDesign.instances, noDesign.wires).some((p) => p.includes('duplicate'))).toBe(true);
    // a source client's throughput override is accepted design-aware (the finale's shape)
    expect(scenarioProblems([{ id: 'w', overrides: [{ node: 'users', key: 'throughput', value: 3000 }] }], clientSource, clientWired)).toEqual([]);
  });

  it('hasScenarios is the no-filler gate', () => {
    expect(hasScenarios([])).toBe(false);
    expect(hasScenarios(undefined)).toBe(false);
    expect(hasScenarios([{ id: 'w', overrides: [] }])).toBe(true);
  });
});
