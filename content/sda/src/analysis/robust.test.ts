import { describe, expect, it } from 'vitest';
import { NodeId, Key, type Graph } from '@sda/engine-core';
import { makeNativeAdapter } from '@sda/solver-contract/native';
import type { Repair, Optimize, EvaluateBatch } from '@sda/solver-contract';
import { instantiate, allManifests, registry, keys, quantizeKnob, provisioningTunables, evaluateWorlds, robustRepair, robustOptimize, type AssumptionScenario, type Instance, type ManifestBand, type RobustChange, type Wire } from '../index';

// ROBUST IMPROVE ACROSS WORLDS (assumption-model doc §8). The credibility properties: (1) the robust sizing HOLDS
// every SLO in EVERY selected world — verified INDEPENDENTLY by re-evaluating the applied design in each world; (2)
// the binding world is DERIVED per knob (the world whose own solve needed the most), and can DIFFER per band; (3) an
// empty world set is bit-for-bit the plain single-graph search (no silent behaviour change). The solver is the
// CONTRACT's NATIVE adapter (branch-and-bound, no MiniZinc), the same seam the app binds — so no external solver.

const native = makeNativeAdapter({ registry });
const repair: Repair = native.repair!;
const optimize: Optimize = native.optimize!;
const evaluateBatch: EvaluateBatch = native.evaluateBatch!;

/** An overflow SLO (offered ≤ capacity) — the demand-MONOTONE band a world's higher demand tightens, so different
 *  worlds bind different tiers. `compute.service` capacity = concurrency / (perRequestDuration/1000), and concurrency
 *  is a free provisioning knob, so repair raises it to clear the overflow. */
const overflowSlo: ManifestBand = { key: keys.overflow, band: { shape: 'minTargetMax', max: 0 } };

function build(instances: readonly Instance[], wires: readonly Wire[]): Graph {
  const g = instantiate(allManifests, instances, wires);
  if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
  return g.value;
}

/** Fold the robust knob changes back into the instances' config — what the architect would apply (apply_solution). */
function applyRobust(instances: readonly Instance[], changes: readonly RobustChange[]): Instance[] {
  return instances.map((inst): Instance => {
    const mine = changes.filter((c) => c.node === inst.id);
    if (mine.length === 0) return inst;
    const config: Record<string, number> = { ...inst.config };
    for (const c of mine) config[c.key] = c.value;
    return { ...inst, config };
  });
}

/** Two INDEPENDENT flows, each an overflow-SLO'd service at concurrency 1 (capacity ~1,000 req/s at 1 ms service). */
const twoFlow = (): { instances: Instance[]; wires: Wire[] } => ({
  instances: [
    { id: 'c1', type: 'client.web', config: { throughput: 100 } },
    { id: 'a1', type: 'compute.service', config: { concurrency: 1, perRequestDuration: 1 }, bands: [overflowSlo] },
    { id: 'c2', type: 'client.web', config: { throughput: 100 } },
    { id: 'a2', type: 'compute.service', config: { concurrency: 1, perRequestDuration: 1 }, bands: [overflowSlo] },
  ],
  wires: [
    { from: ['c1', 'out'], to: ['a1', 'in'] },
    { from: ['c2', 'out'], to: ['a2', 'in'] },
  ],
});

describe('robust improve — the sizing holds every selected world (assumption-model §8)', () => {
  it('two worlds bind DIFFERENT knobs; the robust sizing holds ALL worlds (verified by evaluateWorlds post-apply)', async () => {
    const d = twoFlow();
    const g = build(d.instances, d.wires);
    // World A stresses flow-1 (c1 high), world B stresses flow-2 (c2 high) — disjoint, so each binds its own tier.
    const worlds: AssumptionScenario[] = [
      { id: 'stressA', overrides: [{ node: 'c1', key: 'throughput', value: 5000 }] },
      { id: 'stressB', overrides: [{ node: 'c2', key: 'throughput', value: 5000 }] },
    ];
    const out = await robustRepair({ graph: g, instances: d.instances, wires: d.wires, worlds }, repair, evaluateBatch);
    expect(out.kind).toBe('solved');
    if (out.kind !== 'solved') return;

    // a1's knob is bound by the world that pushed c1 high (stressA); a2's by stressB — the binding world DIFFERS per band.
    const a1 = out.changes.find((c) => c.node === 'a1');
    const a2 = out.changes.find((c) => c.node === 'a2');
    expect(a1?.bindingWorld).toBe('stressA');
    expect(a2?.bindingWorld).toBe('stressB');
    expect(new Set(out.changes.map((c) => c.bindingWorld)).size).toBeGreaterThan(1); // genuinely differs per knob

    // INDEPENDENT verification (not trusting robust.ts's own internal check): apply the sizing, re-evaluate every
    // world — the base world plus both stress worlds — and assert EVERY one is now feasible.
    const fixed = applyRobust(d.instances, out.changes);
    const ver = await evaluateWorlds({ graph: build(fixed, d.wires), instances: fixed, wires: d.wires, scenarios: worlds }, evaluateBatch);
    expect(ver.worlds.map((w) => w.id)).toEqual(['base', 'stressA', 'stressB']);
    expect(ver.worlds.every((w) => w.feasible)).toBe(true);
  });

  it('robustOptimize (min cost) sizes to the worst world per knob and holds all worlds; the max-demand world binds', async () => {
    const d = { instances: twoFlow().instances.slice(0, 2), wires: [twoFlow().wires[0]!] }; // single flow c1 → a1
    const g = build(d.instances, d.wires);
    const worlds: AssumptionScenario[] = [
      { id: 'low', overrides: [{ node: 'c1', key: 'throughput', value: 1000 }] },
      { id: 'high', overrides: [{ node: 'c1', key: 'throughput', value: 5000 }] },
    ];
    const out = await robustOptimize(
      { graph: g, instances: d.instances, wires: d.wires, worlds },
      { node: NodeId('a1'), key: Key(String(keys.concurrency)), direction: 'min' },
      optimize,
      evaluateBatch,
    );
    expect(out.kind).toBe('solved');
    if (out.kind !== 'solved') return;
    // The max-demand world (high) needs the most concurrency, so it BINDS the knob.
    const a1 = out.changes.find((c) => c.node === 'a1' && c.key === String(keys.concurrency));
    expect(a1?.bindingWorld).toBe('high');
    const fixed = applyRobust(d.instances, out.changes);
    const ver = await evaluateWorlds({ graph: build(fixed, d.wires), instances: fixed, wires: d.wires, scenarios: worlds }, evaluateBatch);
    expect(ver.worlds.every((w) => w.feasible)).toBe(true);
  });

  it('BASE MODE (empty world set) is bit-for-bit the plain single-graph repair — no silent behaviour change', async () => {
    // A single under-provisioned flow: c(5000) → a(concurrency 1 ⇒ cap ~1,000) overflows, so plain repair raises it.
    const d: { instances: Instance[]; wires: Wire[] } = {
      instances: [
        { id: 'c', type: 'client.web', config: { throughput: 5000 } },
        { id: 'a', type: 'compute.service', config: { concurrency: 1, perRequestDuration: 1 }, bands: [overflowSlo] },
      ],
      wires: [{ from: ['c', 'out'], to: ['a', 'in'] }],
    };
    const g = build(d.instances, d.wires);
    // The plain single-graph repair (the untouched path), quantized exactly as the tool would apply it.
    const plain = await repair({ graph: g, tunables: provisioningTunables(g), headroom: { key: keys.throughput, factor: 0.8 } });
    expect(plain.kind).toBe('solved');
    if (plain.kind !== 'solved') return;
    const plainSet = new Set(plain.value.map((c) => `${String(c.node)}|${String(c.key)}|${quantizeKnob(String(c.key), c.to)}`));

    // Robust over the EMPTY world set ⇒ the base world only ⇒ the SAME changes (bit-for-bit on node/key/quantized value).
    const out = await robustRepair({ graph: g, instances: d.instances, wires: d.wires, worlds: [] }, repair, evaluateBatch);
    expect(out.kind).toBe('solved');
    if (out.kind !== 'solved') return;
    const robustSet = new Set(out.changes.map((c) => `${c.node}|${c.key}|${c.value}`));
    expect(robustSet).toEqual(plainSet);
    expect(out.changes.every((c) => c.bindingWorld === 'base')).toBe(true);
  });

  it('an INFEASIBLE world is surfaced honestly, NAMING the world (infeasible ≠ did-not-converge)', async () => {
    // A latency SLO tighter than the service's fixed latency — no provisioning knob can reduce a fixed service time,
    // so the search is proven INFEASIBLE (not a timeout). Robust over the empty set names the binding world ('base').
    const d: { instances: Instance[]; wires: Wire[] } = {
      instances: [
        { id: 'c', type: 'client.web', config: { throughput: 100 } },
        { id: 'a', type: 'compute.service', config: { latency: 20 }, bands: [{ key: keys.latency, band: { shape: 'minTargetMax', max: 5 } }] },
      ],
      wires: [{ from: ['c', 'out'], to: ['a', 'in'] }],
    };
    const g = build(d.instances, d.wires);
    const out = await robustRepair({ graph: g, instances: d.instances, wires: d.wires, worlds: [] }, repair, evaluateBatch);
    expect(out.kind).toBe('infeasible');
    if (out.kind !== 'infeasible') return;
    expect(out.world).toBe('base');
  });
});
