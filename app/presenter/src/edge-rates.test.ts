import { describe, expect, it } from 'vitest';
import { NodeId, applyTransform, type Key } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { instantiate, allManifests, registry, keys, type Instance, type Wire } from '@sda/content';
import { edgeRates, resolvePortTransform, resolveWireOutTransform } from './index';

const catalog = allManifests;

// ANTI-DRIFT (doc: flow-transformations-r2 §2): the number on the wire is the SOLVER's number, by construction.
// These tests build a REAL transformed chain, run a FULL engine evaluation, and pin the presenter's edge-rate
// pills against what the engine actually computed. If the presenter ever re-derived transform math differently
// from the engine, these fail — that is the whole point of importing `applyTransform` rather than copying it.

// The owner's example, on real catalog components: client → gen → (events 1×, logs ×100). The gen's log OUT-port
// carries ratio(100); the events path is identity. Instance overrides drive it, exactly like transform.e2e.ts.
function transformedChain(): { instances: Instance[]; wires: Wire[]; value: (id: string, k: Key) => number | undefined } {
  const instances: Instance[] = [
    { id: 'client', type: 'client.web', config: { throughput: 1000 } },
    { id: 'gen', type: 'compute.service', config: { concurrency: 100000 }, transforms: { db: { kind: 'ratio', value: 100 } } },
    { id: 'events', type: 'compute.service', config: { concurrency: 100000 } },
    { id: 'logs', type: 'db.postgres', config: { concurrency: 50 } }, // caps ≈ 1000 req/s ⇒ ×100 offered overflows
  ];
  const wires: Wire[] = [
    { from: ['client', 'out'], to: ['gen', 'in'] },
    { from: ['gen', 'out'], to: ['events', 'in'] }, // identity path
    { from: ['gen', 'db'], to: ['logs', 'in'] }, // ratio(100) path
  ];
  const built = instantiate(catalog, instances, wires);
  if (!built.ok) throw new Error(`build failed: ${JSON.stringify(built.error)}`);
  const r = evaluate(built.value, registry);
  if (!r.ok) throw new Error(r.error.join('; '));
  const value = (id: string, k: Key): number | undefined => r.value.value(NodeId(id), k);
  return { instances, wires, value };
}

describe('edgeRates — pins the pill rate against a full engine evaluation (anti-drift)', () => {
  const { instances, wires, value } = transformedChain();
  const rates = edgeRates({ instances, wires, catalog, value });
  const byTarget = (id: string) => rates.find((e) => e.to[0] === id)!;

  it('the identity edge (client → gen) carries NO persistent pill, only a hover rate', () => {
    const e = byTarget('gen');
    expect(e.pills).toHaveLength(0);
    expect(e.carried).toBeCloseTo(1000, 6); // the exact rate, for the hover pill
  });

  it('the events edge (gen → events, identity) stays quiet — no pill', () => {
    const e = byTarget('events');
    expect(e.pills).toHaveLength(0);
    expect(e.carried).toBeCloseTo(1000, 6);
  });

  it('the log edge earns an OUT pill whose rate = applyTransform(ratio(100), gen served) = the engine number', () => {
    const e = byTarget('logs');
    const out = e.pills.find((p) => p.side === 'out');
    expect(out).toBeDefined();
    expect(out!.transform).toEqual({ kind: 'ratio', value: 100 });
    expect(out!.tone).toBe('amp'); // k > 1 ⇒ amber amplification

    // ANTI-DRIFT: the presenter's number must be the engine's arithmetic on the engine's served value. Compute the
    // reference EXACTLY as the engine seams do — served throughput of the source pushed through applyTransform.
    const genServed = value('gen', keys.throughput)!;
    const engineReference = applyTransform({ kind: 'ratio', value: 100 }, genServed);
    expect(out!.rate).toBeCloseTo(engineReference, 6);
    expect(out!.rate).toBeCloseTo(100000, 6); // 1000 × 100, the load the log tier truly sees
  });

  it('the pill label reads the doc grammar ("×100 → 100k/s")', () => {
    const out = byTarget('logs').pills.find((p) => p.side === 'out')!;
    expect(out.label).toBe('×100 → 100k/s');
  });
});

describe('edgeRates — honesty: no traffic origin ⇒ the pill shows the function only, never a fake number', () => {
  it('with a null value accessor (build error), a transformed edge shows its function but rate undefined', () => {
    const instances: Instance[] = [
      { id: 'gen', type: 'compute.service', transforms: { db: { kind: 'ratio', value: 100 } } },
      { id: 'logs', type: 'db.postgres' },
    ];
    const wires: Wire[] = [{ from: ['gen', 'db'], to: ['logs', 'in'] }];
    const rates = edgeRates({ instances, wires, catalog, value: null });
    const e = rates.find((x) => x.to[0] === 'logs')!;
    const out = e.pills.find((p) => p.side === 'out')!;
    expect(out.transform).toEqual({ kind: 'ratio', value: 100 });
    expect(out.rate).toBeUndefined(); // no origin ⇒ no rate
    expect(out.label).toBe('×100'); // the function only, no fabricated "→ N/s"
    expect(e.carried).toBeUndefined();
  });
});

describe('edgeRates — IN-side transform renders at the target (batch aggregation)', () => {
  it('an aggregator IN-port batch(100) produces a teal "reduce" IN pill collapsing 1000 → 10', () => {
    const instances: Instance[] = [
      { id: 'client', type: 'client.web', config: { throughput: 1000 } },
      { id: 'agg', type: 'compute.service', config: { concurrency: 100000 }, transforms: { in: { kind: 'batch', value: 100 } } },
    ];
    const wires: Wire[] = [{ from: ['client', 'out'], to: ['agg', 'in'] }];
    const built = instantiate(catalog, instances, wires);
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const r = evaluate(built.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    const value = (id: string, k: Key): number | undefined => r.value.value(NodeId(id), k);
    const rates = edgeRates({ instances, wires, catalog, value });
    const inPill = rates[0]!.pills.find((p) => p.side === 'in')!;
    expect(inPill.transform).toEqual({ kind: 'batch', value: 100 });
    expect(inPill.tone).toBe('reduce');
    expect(inPill.rate).toBeCloseTo(10, 6); // 1000 / 100
    // and it matches the engine's own served value at the aggregator (which is the batched intake)
    expect(inPill.rate).toBeCloseTo(value('agg', keys.throughput)!, 6);
    expect(inPill.label).toBe('÷100 → 10/s');
  });
});

describe('edgeRates — a per-WIRE override wins over the source port, and the pill marks its provenance (source)', () => {
  // A gateway service fans its ONE out port to catalog (wire prob 0.7) and checkout (wire prob 0.3): the split the
  // per-port transform cannot express. Each pill must carry the WIRE's rate AND source:'wire', so a UI can mark it.
  function split(): { instances: Instance[]; wires: Wire[]; value: (id: string, k: Key) => number | undefined } {
    const instances: Instance[] = [
      { id: 'gw', type: 'compute.service', config: { assumedRps: 2000, concurrency: 200, perRequestDuration: 50 } },
      { id: 'catalog', type: 'compute.service', config: { concurrency: 100, perRequestDuration: 50 } },
      { id: 'checkout', type: 'compute.service', config: { concurrency: 40, perRequestDuration: 50 } },
    ];
    const wires: Wire[] = [
      { from: ['gw', 'out'], to: ['catalog', 'in'], transform: { kind: 'prob', value: 0.7 } },
      { from: ['gw', 'out'], to: ['checkout', 'in'], transform: { kind: 'prob', value: 0.3 } },
    ];
    const built = instantiate(catalog, instances, wires);
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const r = evaluate(built.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    const value = (id: string, k: Key): number | undefined => r.value.value(NodeId(id), k);
    return { instances, wires, value };
  }

  it('each wire pill reflects THE WIRE (0.7 / 0.3), rate = the engine number, source = "wire"', () => {
    const { instances, wires, value } = split();
    const rates = edgeRates({ instances, wires, catalog, value });
    const catPill = rates.find((e) => e.to[0] === 'catalog')!.pills.find((p) => p.side === 'out')!;
    const chkPill = rates.find((e) => e.to[0] === 'checkout')!.pills.find((p) => p.side === 'out')!;
    expect(catPill.transform).toEqual({ kind: 'prob', value: 0.7 });
    expect(catPill.source).toBe('wire');
    expect(catPill.rate).toBeCloseTo(1400, 6); // 2000 × 0.7 — the WIRE's share
    expect(chkPill.transform).toEqual({ kind: 'prob', value: 0.3 });
    expect(chkPill.source).toBe('wire');
    expect(chkPill.rate).toBeCloseTo(600, 6);
    // and the pill rate is the engine's served share at the target
    expect(catPill.rate).toBeCloseTo(value('catalog', keys.throughput)!, 6);
  });

  it('a pill with NO wire override marks its source as the PORT level (instance / manifest), not wire', () => {
    // instance port override (no wire transform) ⇒ source 'instance'
    const instances: Instance[] = [
      { id: 'gen', type: 'compute.service', config: { assumedRps: 100 }, transforms: { db: { kind: 'ratio', value: 3 } } },
      { id: 'logs', type: 'db.postgres', config: { concurrency: 100000 } },
    ];
    const wires: Wire[] = [{ from: ['gen', 'db'], to: ['logs', 'in'] }]; // NO wire transform
    const built = instantiate(catalog, instances, wires);
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const r = evaluate(built.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    const value = (id: string, k: Key): number | undefined => r.value.value(NodeId(id), k);
    const pill = edgeRates({ instances, wires, catalog, value }).find((e) => e.to[0] === 'logs')!.pills.find((p) => p.side === 'out')!;
    expect(pill.transform).toEqual({ kind: 'ratio', value: 3 });
    expect(pill.source).toBe('instance'); // the port override, NOT a wire
  });
});

describe('resolveWireOutTransform — the full precedence (wire > instance > manifest)', () => {
  const man = catalog['compute.service']!;
  it('a wire transform wins over an instance port override', () => {
    const inst: Instance = { id: 'gw', type: 'compute.service', transforms: { out: { kind: 'ratio', value: 5 } } };
    const wire: Wire = { from: ['gw', 'out'], to: ['x', 'in'], transform: { kind: 'prob', value: 0.7 } };
    expect(resolveWireOutTransform(wire, inst, man, 'out')).toEqual({ transform: { kind: 'prob', value: 0.7 }, source: 'wire' });
  });
  it('no wire transform ⇒ the instance port override, marked "instance"', () => {
    const inst: Instance = { id: 'gw', type: 'compute.service', transforms: { out: { kind: 'ratio', value: 5 } } };
    const wire: Wire = { from: ['gw', 'out'], to: ['x', 'in'] };
    expect(resolveWireOutTransform(wire, inst, man, 'out')).toEqual({ transform: { kind: 'ratio', value: 5 }, source: 'instance' });
  });
  it('neither ⇒ the manifest default (identity here), marked "manifest"', () => {
    const inst: Instance = { id: 'gw', type: 'compute.service' };
    const wire: Wire = { from: ['gw', 'out'], to: ['x', 'in'] };
    // compute.service's `out` has no manifest transform ⇒ identity (undefined), source 'manifest'.
    expect(resolveWireOutTransform(wire, inst, man, 'out')).toEqual({ transform: undefined, source: 'manifest' });
  });
});

describe('resolvePortTransform — instance override beats manifest default (mirrors instantiate)', () => {
  const man = catalog['compute.service']!;
  it('returns the instance override when present', () => {
    const inst: Instance = { id: 'x', type: 'compute.service', transforms: { db: { kind: 'ratio', value: 7 } } };
    expect(resolvePortTransform(inst, man, 'db')).toEqual({ kind: 'ratio', value: 7 });
  });
  it('falls back to the manifest port default, then to undefined (identity)', () => {
    const inst: Instance = { id: 'x', type: 'compute.service' };
    // compute.service declares no manifest transform on `db` ⇒ identity (undefined) with no override.
    expect(resolvePortTransform(inst, man, 'db')).toBeUndefined();
  });
});
