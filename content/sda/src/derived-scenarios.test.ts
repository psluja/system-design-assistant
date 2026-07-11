import { describe, expect, it } from 'vitest';
import { allManifests, type Instance, type Wire } from './index';
import type { EnvelopeResult } from './envelope';
import { deriveDefaultScenarios, refreshDerivedScenarios, mergeDerivedTrio, resetScenario, DERIVED_DEMAND_FRACTIONS, type DeriveInput } from './derived-scenarios';
import type { AssumptionScenario } from './scenario';

// THE DERIVED TRIO (doc: assumption-model §5). The credibility test: every value traces to THIS design's own
// envelope / a declared range — never invented — the fractions are exact, polarity picks the ends honestly, a key
// with no polarity STAYS at base, and the three-state lifecycle (derived → frozen → back to derived) re-tracks.

/** A hand-built envelope with one origin at `maxRps` — lets the demand math be tested with NO solver (pure).
 *  `baseRps` is the origin's STATED demand (the requirement floor F6 anchors "real" to); default 2000, matching
 *  `clientSource`. */
const env = (maxRps: number, node = 'users', key = 'throughput', baseRps = 2000): EnvelopeResult => ({
  perOrigin: [{ node, key, baseRps, maxRps, basis: 'saturation', firstBreak: undefined }],
});

const clientSource: Instance[] = [{ id: 'users', type: 'client.source', config: { throughput: 2000 } }];
const inputOf = (instances: Instance[], wires: Wire[], envelope: EnvelopeResult): DeriveInput => ({ instances, wires, catalog: allManifests, envelope });

const world = (t: { scenarios: readonly AssumptionScenario[] }, id: string): AssumptionScenario => t.scenarios.find((s) => s.id === id)!;
const ov = (s: AssumptionScenario, node: string, key: string) => s.overrides.find((o) => o.node === node && o.key === key);

describe('derived trio — demand is a fraction of the envelope (never invented)', () => {
  it('sizes pessimistic / real / optimistic to 110% / 60% / 30% of the per-origin maximum, badged derived', () => {
    const t = deriveDefaultScenarios(inputOf(clientSource, [], env(5000)));
    expect(t.scenarios.map((s) => s.id)).toEqual(['pessimistic', 'real', 'optimistic']);
    expect(ov(world(t, 'pessimistic'), 'users', 'throughput')).toMatchObject({ value: 5500, provenance: 'derived' }); // 5000 × 1.10
    expect(ov(world(t, 'real'), 'users', 'throughput')).toMatchObject({ value: 3000, provenance: 'derived' }); // 5000 × 0.60
    expect(ov(world(t, 'optimistic'), 'users', 'throughput')).toMatchObject({ value: 1500, provenance: 'derived' }); // 5000 × 0.30
  });

  it('demand orders pessimistic > real > optimistic for any envelope maximum (a property)', () => {
    // A well-provisioned design (stated demand 100 well below capacity), so the pure-fraction path holds — the
    // requirement floor never binds and each world is exactly its fraction of the envelope maximum.
    for (const max of [700, 1234, 5000, 99999]) {
      const t = deriveDefaultScenarios(inputOf(clientSource, [], env(max, 'users', 'throughput', 100)));
      const p = ov(world(t, 'pessimistic'), 'users', 'throughput')!.value;
      const r = ov(world(t, 'real'), 'users', 'throughput')!.value;
      const o = ov(world(t, 'optimistic'), 'users', 'throughput')!.value;
      expect(p).toBeGreaterThan(r);
      expect(r).toBeGreaterThan(o);
      expect(p).toBe(Math.round(max * DERIVED_DEMAND_FRACTIONS.pessimistic));
    }
  });

  it('F6: an UNDER-PROVISIONED design anchors "real" to the stated demand — no false-green under-loading', () => {
    // The design is committed to 2000 rps (baseRps) but its capacity edge is only 700 (maxRps). A pure fraction of
    // the envelope would size "real" to 420 — under-loading below the stated demand so every world rides green,
    // hiding that the real requirement (2000) overflows the design. The floor anchor lifts "real" to ≥ 2000, so the
    // trio loads the design at its own requirement (and it shows RED there), while staying strictly ordered.
    const t = deriveDefaultScenarios(inputOf(clientSource, [], env(700, 'users', 'throughput', 2000)));
    const p = ov(world(t, 'pessimistic'), 'users', 'throughput')!.value;
    const r = ov(world(t, 'real'), 'users', 'throughput')!.value;
    const o = ov(world(t, 'optimistic'), 'users', 'throughput')!.value;
    expect(r).toBeGreaterThanOrEqual(2000); // never below the stated requirement (the F6 fix)
    expect(p).toBeGreaterThan(r); // still strictly ordered worst → real
    expect(r).toBeGreaterThan(o);
    expect(o).toBeGreaterThan(0);
  });

  it('F6: ample capacity keeps the pure envelope fraction — the floor does not bind when 0.6·max ≥ the demand', () => {
    // Capacity edge 5000, stated demand 2000: 0.6·5000 = 3000 ≥ 2000, so "real" stays the capacity fraction (3000),
    // NOT lifted — the requirement floor only binds an under-provisioned design (the documented precedence).
    const t = deriveDefaultScenarios(inputOf(clientSource, [], env(5000, 'users', 'throughput', 2000)));
    expect(ov(world(t, 'real'), 'users', 'throughput')!.value).toBe(3000); // 5000 × 0.60, unchanged
  });

  it('an un-overridable origin (a service throughput) yields no demand override — no silent no-op', () => {
    // The envelope names a NON-origin coordinate (a service's throughput). A scenario cannot override it, so the
    // trio must NOT create it (it would be a silent no-op). With no other derivable coordinate ⇒ empty-with-reason.
    const svc: Instance[] = [{ id: 'svc', type: 'compute.service' }];
    const t = deriveDefaultScenarios(inputOf(svc, [], env(4000, 'svc', 'throughput')));
    expect(t.scenarios).toHaveLength(0);
    expect(t.reason).toBeDefined();
  });
});

describe('derived trio — ranged keys at polarity ends, no-polarity keys stay at base', () => {
  it('a triangular range on a higher-is-worse key: pessimistic = hi, real = mode, optimistic = lo', () => {
    const insts: Instance[] = [{ id: 'svc', type: 'compute.service', ranges: { perRequestDuration: { lo: 10, mode: 20, hi: 40 } } }];
    const t = deriveDefaultScenarios(inputOf(insts, [], { perOrigin: [] }));
    expect(ov(world(t, 'pessimistic'), 'svc', 'perRequestDuration')).toMatchObject({ value: 40, provenance: 'derived' });
    expect(ov(world(t, 'real'), 'svc', 'perRequestDuration')!.value).toBe(20);
    expect(ov(world(t, 'optimistic'), 'svc', 'perRequestDuration')!.value).toBe(10);
  });

  it('a uniform range uses the midpoint for real', () => {
    const insts: Instance[] = [{ id: 'svc', type: 'compute.service', ranges: { perRequestDuration: { lo: 10, hi: 40 } } }];
    const t = deriveDefaultScenarios(inputOf(insts, [], { perOrigin: [] }));
    expect(ov(world(t, 'real'), 'svc', 'perRequestDuration')!.value).toBe(25); // (10 + 40) / 2
  });

  it('a fact-assumption with UNKNOWN polarity (timeoutMs) is ABSENT from every world — no guessing (doc §5.2)', () => {
    const insts: Instance[] = [{ id: 'svc', type: 'compute.service', ranges: { timeoutMs: { lo: 100, hi: 500 } } }];
    const t = deriveDefaultScenarios(inputOf(insts, [], { perOrigin: [] }));
    // no origin, and the only ranged key has no polarity ⇒ nothing to derive
    expect(t.scenarios).toHaveLength(0);
    expect(t.reason).toBeDefined();
  });
});

describe('derived trio — honest empty-with-reason', () => {
  it('a design with no origin and no range gets NO trio, and says why (never a fabricated world)', () => {
    const t = deriveDefaultScenarios(inputOf([{ id: 'db', type: 'db.postgres' }], [], { perOrigin: [], note: "No traffic origin — add a generator on a node's output port (or add a client)" }));
    expect(t.scenarios).toHaveLength(0);
    expect(t.reason).toContain('origin');
  });
});

describe('derived trio — the three-state lifecycle (live → frozen → re-tracks)', () => {
  it('refresh re-tracks derived values on a moved envelope, and NEVER overwrites a frozen (architect) value', () => {
    const before = deriveDefaultScenarios(inputOf(clientSource, [], env(5000))).scenarios;
    // Simulate: the architect FROZE the real world's demand (a manual edit → architect), left pessimistic derived.
    const frozenReal: AssumptionScenario = { id: 'real', name: 'Real', overrides: [{ node: 'users', key: 'throughput', value: 9999, provenance: 'architect' }] };
    const derivedPess = world({ scenarios: before }, 'pessimistic');

    // The design changes ⇒ the envelope moves to 6000. Re-derive and reconcile.
    const fresh = deriveDefaultScenarios(inputOf(clientSource, [], env(6000))).scenarios;
    const next = refreshDerivedScenarios([frozenReal, derivedPess], fresh);

    // frozen value is untouched; the derived value re-tracks the moved envelope (6000 × 1.10 = 6600).
    expect(ov(next.find((s) => s.id === 'real')!, 'users', 'throughput')).toMatchObject({ value: 9999, provenance: 'architect' });
    expect(ov(next.find((s) => s.id === 'pessimistic')!, 'users', 'throughput')!.value).toBe(6600);
  });

  it('refresh is idempotent — an unchanged scenario is returned by reference (no needless emit)', () => {
    const fresh = deriveDefaultScenarios(inputOf(clientSource, [], env(5000))).scenarios;
    const again = refreshDerivedScenarios(fresh, fresh);
    expect(again[0]).toBe(fresh[0]); // same reference ⇒ nothing changed
  });

  it('mergeDerivedTrio preserves a frozen edit while refreshing the rest on a re-derive', () => {
    const frozen: AssumptionScenario[] = [{ id: 'real', name: 'Real', overrides: [{ node: 'users', key: 'throughput', value: 9999, provenance: 'architect' }] }];
    const fresh = deriveDefaultScenarios(inputOf(clientSource, [], env(6000))).scenarios;
    const merged = mergeDerivedTrio(frozen, fresh);
    // the real world keeps the architect's 9999 (not the fresh 3600); pessimistic/optimistic come fresh + derived
    expect(ov(merged.find((s) => s.id === 'real')!, 'users', 'throughput')).toMatchObject({ value: 9999, provenance: 'architect' });
    expect(ov(merged.find((s) => s.id === 'pessimistic')!, 'users', 'throughput')).toMatchObject({ value: 6600, provenance: 'derived' });
  });
});

// THE RESET (doc §5.3 — "reset means reset") — the NON-preserving twin of mergeDerivedTrio. Where a re-derive KEEPS
// the architect's frozen edits, a reset WIPES them: a trio world back to freshly-derived, a custom world to base.
describe('resetScenario — the non-preserving wipe', () => {
  const fresh = deriveDefaultScenarios(inputOf(clientSource, [], env(6000))).scenarios; // real = 3600 derived

  it('resets a DERIVED-TRIO world to its freshly-derived values, DROPPING a frozen edit', () => {
    // The architect froze `real` at 9999; reset re-tracks the fresh envelope (3600), frozen gone.
    const existing: AssumptionScenario[] = [{ id: 'real', name: 'Real', overrides: [{ node: 'users', key: 'throughput', value: 9999, provenance: 'architect' }] }];
    const reset = resetScenario(existing, fresh, 'real');
    expect(reset).toBeDefined();
    expect(ov(reset!, 'users', 'throughput')).toMatchObject({ value: 3600, provenance: 'derived' });
  });

  it('CLEARS a custom world (not in the fresh trio) to base — empty overrides', () => {
    const existing: AssumptionScenario[] = [{ id: 'peak', name: 'Black Friday', overrides: [{ node: 'users', key: 'throughput', value: 12000 }] }];
    const reset = resetScenario(existing, fresh, 'peak');
    expect(reset).toEqual({ id: 'peak', name: 'Black Friday', overrides: [] });
  });

  it('returns undefined for an unknown world id', () => {
    expect(resetScenario([], fresh, 'ghost')).toBeUndefined();
  });

  it('with NO fresh derivation available, a trio id still clears to base (the honest fallback)', () => {
    const existing: AssumptionScenario[] = [{ id: 'real', name: 'Real', overrides: [{ node: 'users', key: 'throughput', value: 9999, provenance: 'architect' }] }];
    const reset = resetScenario(existing, [], 'real');
    expect(reset).toEqual({ id: 'real', name: 'Real', overrides: [] });
  });
});
