import { describe, expect, it } from 'vitest';
import { NodeId, type Key } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { makeNativeAdapter } from '@sda/solver-contract/native';
import type { EvaluateBatch } from '@sda/solver-contract';
import {
  buildDocModel,
  generateDesignDoc,
  renderHtml,
  instantiate,
  allManifests,
  registry,
  keys,
  nodeQueues,
  realAwareVerdicts,
  evaluateWorlds,
  type AssumptionScenario,
  type DocWorldsInput,
  type Instance,
  type ManifestBand,
  type Wire,
} from './index';

// THE SCENARIO-COMPARISON SECTION in the generated design doc (assumption-model doc §8, "the section we lack"). The
// budget-defence table: base + every named world side by side, per-world cost / verdict (incl. WHICH SLO breaks) /
// worst-tier ρ + the provenance mix. Present ONLY when the design declares a named world (no-filler); DATA-in, so the
// caller runs `evaluateWorlds`. These tests pin: the section shape, the no-filler gate, and both renderers.

const native = makeNativeAdapter({ registry });
const evaluateBatch: EvaluateBatch = native.evaluateBatch!;

const overflowSlo: ManifestBand = { key: keys.overflow, band: { shape: 'minTargetMax', max: 0 } };
const instances: Instance[] = [
  { id: 'c', type: 'client.web', config: { throughput: 100 } },
  { id: 'a', type: 'compute.service', config: { concurrency: 1, perRequestDuration: 1 }, bands: [overflowSlo] },
];
const wires: Wire[] = [{ from: ['c', 'out'], to: ['a', 'in'] }];
// Two derived worlds: a comfortable "real" (holds) and a stress "pessimistic" past the edge (breaks a.overflow).
const scenarios: AssumptionScenario[] = [
  { id: 'real', name: 'Real', overrides: [{ node: 'c', key: 'throughput', value: 500, provenance: 'derived' }] },
  { id: 'pessimistic', name: 'Pessimistic', overrides: [{ node: 'c', key: 'throughput', value: 5000, provenance: 'derived' }] },
];

async function docInputs(withWorlds: boolean) {
  const g = instantiate(allManifests, instances, wires);
  if (!g.ok) throw new Error(JSON.stringify(g.error));
  const ev = evaluate(g.value, registry);
  if (!ev.ok) throw new Error(ev.error.join('; '));
  const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
  const q = nodeQueues(g.value, value);
  const verdicts = realAwareVerdicts(ev.value.verdicts, g.value, value, q);
  const worlds: DocWorldsInput | undefined = withWorlds
    ? { result: await evaluateWorlds({ graph: g.value, instances, wires, scenarios }, evaluateBatch), scenarios }
    : undefined;
  return { value, verdicts, worlds };
}

describe('scenario-comparison section — the DocModel (assumption-model §8)', () => {
  it('is PRESENT (right after the assumptions register) with a row per world, when named worlds are declared', async () => {
    const { value, verdicts, worlds } = await docInputs(true);
    const model = buildDocModel({ name: 'Trio design', instances, wires, catalog: allManifests, verdicts, value, ...(worlds ? { worlds } : {}) });
    expect(model.scenarios).toBeDefined();
    // ordered immediately after the assumptions register (it extends it with a per-world value column, §8).
    const order = model.sectionOrder;
    expect(order).toContain('scenarios');
    expect(order.indexOf('scenarios')).toBe(order.indexOf('assumptions') + 1);

    const rows = model.scenarios!.worlds;
    expect(rows.map((w) => w.id)).toEqual(['base', 'real', 'pessimistic']); // base ALWAYS first
    const base = rows[0]!;
    expect(base.isBase).toBe(true);
    expect(base.overrides).toEqual([]);
    expect(base.derivedCount).toBe(0);

    const real = rows.find((w) => w.id === 'real')!;
    expect(real.feasible).toBe(true);
    expect(real.derivedCount).toBe(1); // one derived override
    expect(real.overrides[0]).toMatchObject({ node: 'c', key: 'throughput', value: 500, provenance: 'derived' });

    // pessimistic is past the edge — it breaks the overflow SLO, and the row NAMES which SLO breaks (the §8 honesty).
    const pess = rows.find((w) => w.id === 'pessimistic')!;
    expect(pess.feasible).toBe(false);
    expect(pess.violations).toBeGreaterThan(0);
    expect(pess.brokenSlos).toContain('a.overflow');

    // the cost series carries one point per world (the budget-defence bar).
    expect(model.scenarios!.costSeries.points.map((p) => p.label)).toEqual(['Base (as authored)', 'Real', 'Pessimistic']);
  });

  it('is ABSENT (no-filler) when the design declares no named world — bit-for-bit today', async () => {
    const { value, verdicts } = await docInputs(false);
    const model = buildDocModel({ name: 'Plain design', instances, wires, catalog: allManifests, verdicts, value });
    expect(model.scenarios).toBeUndefined();
    expect(model.sectionOrder).not.toContain('scenarios');
  });

  it('renders in BOTH surfaces — the HTML table and the Markdown table — with the derived badge and the broken SLO', async () => {
    const { value, verdicts, worlds } = await docInputs(true);
    const model = buildDocModel({ name: 'Trio design', instances, wires, catalog: allManifests, verdicts, value, ...(worlds ? { worlds } : {}) });

    const html = renderHtml(model);
    expect(html).toContain('Scenarios — world comparison');
    expect(html).toContain('Pessimistic');
    expect(html).toContain('derived'); // the provenance badge — awaits a measurement
    expect(html).toContain('a.overflow'); // the broken SLO named

    const md = generateDesignDoc({ name: 'Trio design', instances, wires, catalog: allManifests, verdicts, value, ...(worlds ? { worlds } : {}) });
    expect(md).toContain('## Scenarios — world comparison');
    expect(md).toContain('| Pessimistic |');
    expect(md).toContain('derived');
  });
});
