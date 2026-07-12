import { describe, expect, it } from 'vitest';
import { NodeId, type Key } from '@sda/engine-core';
import { createEngine } from '@sda/engine-solve';
import { instantiate, manifests, registry, type Instance, type Wire } from '../index';
import { costPromise, isSystemPromiseKey, systemBandsOf, systemPromiseVerdicts, SYSTEM_PROMISE_KEYS } from './system-promise';
import { systemSummary } from './system';
import { keys } from '../vocabulary/registry';

// SYSTEM PROMISES — judged against THE ONE TRUTH (owner ruling: cost is for THE WHOLE SYSTEM). The design below
// carries an OFF-PATH branch (gw → audit beside the gw → fn → db flow spine): the audit store's cost is INVISIBLE
// to the terminal's cumulative cost cell (a branch cost sums only the paths INTO its node), but it IS part of the
// whole system's bill. The verdict must judge the promise against the whole-graph Σ of OWN costs — the exact sum
// `Objective.total` optimizes and the solvers' system band constrains — never the branch cost.
const instances: Instance[] = [
  { id: 'client', type: 'client.source' },
  { id: 'gw', type: 'gateway.api' },
  { id: 'fn', type: 'compute.faas' },
  { id: 'db', type: 'db.sql' },
  { id: 'audit', type: 'db.cheap' }, // the off-path branch — priced, but on no path into the terminal
];
const wires: Wire[] = [
  { from: ['client', 'out'], to: ['gw', 'in'] },
  { from: ['gw', 'out'], to: ['fn', 'in'] },
  { from: ['fn', 'out'], to: ['db', 'in'] },
  { from: ['gw', 'out'], to: ['audit', 'in'] },
];

function solve(): (id: string, k: Key) => number | undefined {
  const g = instantiate(manifests, instances, wires);
  if (!g.ok) throw new Error('build failed');
  const ev = createEngine(registry).evaluate(g.value);
  if (!ev.ok) throw new Error('eval failed');
  return (id, k) => ev.value.value(NodeId(id), k);
}

describe('systemPromiseVerdicts — the whole-system promise judged against the one truth', () => {
  it('judges the cost promise against the WHOLE-GRAPH total (off-path branches included), never the branch cost', () => {
    const value = solve();
    const cum = (id: string): number => value(id, keys.cost) ?? 0;

    // The HAND-DERIVED whole-system total, independent of localContribution's inversion: on this tree the two leaf
    // cumulatives double-count the shared client→gw prefix exactly once, so
    //   total = cum(db) + cum(cache) − cum(gw)
    // (cum(db) = own(client)+own(gw)+own(fn)+own(db); cum(cache) = own(client)+own(gw)+own(cache); cum(gw) is the
    // shared prefix). This is the number a human sums by hand off the cumulative cells.
    const handTotal = cum('db') + cum('audit') - cum('gw');
    const summary = systemSummary(instances, wires, value);
    expect(summary.totalCostUsdMonth).toBeCloseTo(handTotal, 6);
    // The off-path branch is REAL money the terminal's branch cost cannot see: total > branch (strictly).
    expect(handTotal).toBeGreaterThan(cum('db'));

    // A ceiling BETWEEN the branch cost and the whole total: judging the branch would read ok (the lie the owner
    // ruled out); judging the whole system reads violation. The verdict must say violation, scope 'system'.
    const between = (cum('db') + handTotal) / 2;
    const [tight] = systemPromiseVerdicts(instances, wires, value, [costPromise(between)]);
    expect(tight?.scope).toBe('system');
    expect(tight?.status).toBe('violation');
    expect(tight?.computed).toBeCloseTo(handTotal, 6);
    expect(tight?.unit).toBe('USD/month');

    // A ceiling above the whole total: ok — and the computed figure is STILL the one whole-graph truth.
    const [roomy] = systemPromiseVerdicts(instances, wires, value, [costPromise(handTotal + 1)]);
    expect(roomy?.status).toBe('ok');
    expect(roomy?.computed).toBeCloseTo(handTotal, 6);
  });

  it('reads honest unknowns: build errors, a key outside the v1 vocabulary, a non-scalar band — never a guess or a drop', () => {
    const value = solve();
    // Build errors ⇒ the total cannot be computed ⇒ unknown pointing at the fix (value = null is the caller's signal).
    const [broken] = systemPromiseVerdicts(instances, wires, null, [costPromise(1000)]);
    expect(broken?.status).toBe('unknown');
    expect(broken?.note).toContain('build errors');

    // A declared promise on a key the v1 judge does not cover stays DATA and reads unknown naming the covered set.
    const [alien] = systemPromiseVerdicts(instances, wires, value, [{ key: 'latency', band: { shape: 'minTargetMax', max: 200 } }]);
    expect(alien?.status).toBe('unknown');
    expect(alien?.note).toContain('cost');

    // A non-scalar band shape on a covered key is not judged here — honest unknown, never a fabricated number.
    const [oddShape] = systemPromiseVerdicts(instances, wires, value, [{ key: String(keys.cost), band: { shape: 'percentiles', targets: new Map([['p99', 1]]) } }]);
    expect(oddShape?.status).toBe('unknown');
  });

  it('lowers judgeable promises to the solver SUM-band (and only those) — the constraint twin of the verdict', () => {
    // The v1 vocabulary is cost, and the shared gate agrees with it.
    expect(SYSTEM_PROMISE_KEYS).toContain(String(keys.cost));
    expect(isSystemPromiseKey('latency')).toBe(false);

    const bands = systemBandsOf([
      costPromise(30000), // judgeable ⇒ lowers to a ceiling on Σ local cost
      { key: 'latency', band: { shape: 'minTargetMax', max: 200 } }, // outside the vocabulary ⇒ verdict-only (unknown)
      { key: String(keys.cost), band: { shape: 'minTargetMax' } }, // target-less, bound-less ⇒ nothing to constrain
    ]);
    expect(bands).toEqual([{ key: keys.cost, ceiling: 30000 }]);
  });
});
