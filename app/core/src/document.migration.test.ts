import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { commonManifests, keys, registry } from '@sda/content';
import { Studio } from './store';
import { deserialize, serialize } from './document';

// LEGACY DEMAND-KEY MIGRATION — the FULL CHAIN (kept forever, additive, idempotent). The universal traffic-origin
// declaration has moved THREE times: `originRps` → `demandRps` → `assumedRps` (two key renames), and now
// `assumedRps` → a GENERATOR port function (doc: load-curves §3 — the chain's FOURTH link: a node-level config was
// sugar for `generate(level)` on the primary out port). An export written at ANY point of that history must load
// FOREVER, evaluate BIT-IDENTICALLY, and re-serialise in the CANONICAL schema-8 form (a generator; no legacy key;
// no assumedRps config on a migrated source). This suite pins that contract for every historical spelling. It is
// the ONE test allowed to name the legacy keys `originRps` / `demandRps` (besides the migration mapping in
// document.ts) — the rename guard asserts they appear nowhere else.

/** Every legacy spelling that must still migrate forward — the guard depends on these being the only names allowed. */
const LEGACY_KEYS = ['originRps', 'demandRps'] as const;
/** Every historical way the SAME 500 req/s origin was ever declared — all four must converge on one canonical form. */
const ALL_FORMS = ['originRps', 'demandRps', 'assumedRps'] as const;

/** A serialization-stable fingerprint of a loaded design's engine evaluation: the converged flag, every solved
 *  (node × key) value and every verdict. Two documents with the same MEANING share it — the equivalence proof. */
function fingerprint(json: string): string {
  const parsed = deserialize(json);
  if (!parsed.ok) return `LOAD_FAILED: ${parsed.error}`;
  const s = new Studio(registry, commonManifests);
  s.load(parsed.value);
  const ev = s.evaluate();
  if (!ev.ok) return JSON.stringify({ ok: false, error: [...ev.error] });
  const e = ev.value;
  const allKeys = Object.values(keys);
  const grid = parsed.value.instances.map((inst) => {
    const id = NodeId(inst.id);
    return [inst.id, allKeys.map((k) => { const v = e.value(id, k); return v === undefined ? null : Number.isNaN(v) ? 'NaN' : v; })] as const;
  });
  return JSON.stringify({ ok: true, converged: e.converged, verdicts: e.verdicts, grid });
}

/** A single self-contained source design (a compute.service that ORIGINATES traffic, no client) keyed by the given
 *  demand-key name — the historical forms (`originRps` / `demandRps` / `assumedRps`) differ by ONLY that token.
 *  Huge concurrency ⇒ the source emits its declared demand exactly, so the fold is observable in `throughput`. */
const designJson = (demandKey: string): string =>
  JSON.stringify({
    schema: 3,
    id: 'migration-fixture',
    name: 'Universal traffic origin',
    instances: [
      {
        id: 'gen',
        type: 'compute.service',
        config: { [demandKey]: 500, concurrency: 100000, perRequestDuration: 1 },
        bands: [{ key: 'throughput', band: { shape: 'minTargetMax', min: 400 } }],
      },
    ],
    wires: [],
  });

/** The SAME design authored CANONICALLY (schema 8): a generator on compute.service's primary out port (`db`,
 *  its first out/bi port), no assumedRps config — what every historical form must converge to. */
const canonicalJson = (): string =>
  JSON.stringify({
    schema: 8,
    id: 'migration-fixture',
    name: 'Universal traffic origin',
    instances: [
      {
        id: 'gen',
        type: 'compute.service',
        config: { concurrency: 100000, perRequestDuration: 1 },
        transforms: { db: { kind: 'generate', level: 500 } },
        bands: [{ key: 'throughput', band: { shape: 'minTargetMax', min: 400 } }],
      },
    ],
    wires: [],
  });

describe('deserialize migration — the demand-key chain, all four links (kept forever, additive, idempotent)', () => {
  for (const form of ALL_FORMS) {
    it(`a historical export declaring "${form}" loads as the CANONICAL generator (level on the primary out port, config key gone)`, () => {
      const back = deserialize(designJson(form));
      expect(back.ok).toBe(true);
      if (!back.ok) return;
      const inst = back.value.instances[0]!;
      expect(inst.transforms?.db).toEqual({ kind: 'generate', level: 500 }); // the fourth link: sugar → generator
      expect(inst.config?.assumedRps).toBeUndefined(); // the sugar key is gone from a migrated source
      expect(form in (inst.config ?? {})).toBe(false); // and the legacy name with it
      expect(inst.config?.concurrency).toBe(100000); // untouched siblings survive
      expect(back.value.schema).toBe(11);
    });

    it(`EVALUATION-EQUIVALENCE (sacred): the migrated "${form}" file evaluates BIT-IDENTICALLY to the canonical generator form`, () => {
      expect(fingerprint(designJson(form))).toBe(fingerprint(canonicalJson()));
    });

    it(`re-serialises CANONICALLY from "${form}" (generate present; no legacy key, no sugar config) — and the round-trip is a fixpoint`, () => {
      const back = deserialize(designJson(form));
      expect(back.ok).toBe(true);
      if (!back.ok) return;
      const out = serialize(back.value);
      expect(out).toContain('"generate"');
      expect(out).not.toContain('originRps');
      expect(out).not.toContain('demandRps');
      expect(out).not.toContain('assumedRps');
      // IDEMPOTENT: loading the canonical output changes nothing further (the migration is a fixpoint).
      const again = deserialize(out);
      expect(again.ok).toBe(true);
      if (again.ok) expect(serialize(again.value)).toBe(out);
    });
  }

  it('reads the demand under assumedRps (the reconciled level cell) and folds it into the source throughput', () => {
    const back = deserialize(designJson('originRps'));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const s = new Studio(registry, commonManifests);
    s.load(back.value);
    const ev = s.evaluate();
    expect(ev.ok).toBe(true);
    if (!ev.ok) return;
    expect(ev.value.value(NodeId('gen'), keys.assumedRps)).toBe(500); // the generator level rides the one address
    expect(ev.value.value(NodeId('gen'), keys.throughput)).toBe(500); // origin folded into emitted throughput
  });

  it('a MID-CHAIN assumedRps (a node with inbound wires) stays a config — its historical semantics are preserved', () => {
    const json = JSON.stringify({
      schema: 7,
      id: 'mid',
      name: 'mid-chain origin',
      instances: [
        { id: 'client', type: 'client.source' },
        { id: 'svc', type: 'compute.service', config: { assumedRps: 200, concurrency: 100000 } },
      ],
      wires: [{ from: ['client', 'out'], to: ['svc', 'in'] }],
    });
    const back = deserialize(json);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const svc = back.value.instances.find((i) => i.id === 'svc')!;
    expect(svc.config?.assumedRps).toBe(200); // untouched: migrating it would CHANGE numbers (origin was not emitted mid-chain)
    expect(svc.transforms?.db).toBeUndefined();
  });

  it('a source whose primary out port already carries a transform keeps its sugar (the slot is taken — honest no-op)', () => {
    const json = JSON.stringify({
      schema: 7,
      id: 'occupied',
      name: 'occupied slot',
      instances: [{ id: 'gen', type: 'compute.service', config: { assumedRps: 500 }, transforms: { db: { kind: 'ratio', value: 2 } } }],
      wires: [],
    });
    const back = deserialize(json);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const inst = back.value.instances[0]!;
    expect(inst.config?.assumedRps).toBe(500);
    expect(inst.transforms?.db).toEqual({ kind: 'ratio', value: 2 });
  });

  it('migrates an uncertainty RANGE keyed by the OLDEST legacy name — the range stays on assumedRps (the level address)', () => {
    const json = JSON.stringify({
      schema: 5,
      id: 'r',
      name: 'ranged',
      instances: [{ id: 'gen', type: 'compute.service', config: { originRps: 500, concurrency: 100000 }, ranges: { originRps: { lo: 200, hi: 800 } } }],
      wires: [],
    });
    const back = deserialize(json);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const inst = back.value.instances[0]!;
    // The RANGE keeps addressing assumedRps — the reconciled level cell Monte-Carlo draws against (doc: load-curves §3).
    expect(inst.ranges!.assumedRps).toEqual({ lo: 200, hi: 800 });
    expect('originRps' in inst.ranges!).toBe(false);
    // The LEVEL itself became the generator (the config sugar is gone).
    expect(inst.transforms?.db).toEqual({ kind: 'generate', level: 500 });
  });

  it('migrates an uncertainty RANGE keyed by the INTERMEDIATE legacy name (demandRps → assumedRps)', () => {
    const json = JSON.stringify({
      schema: 5,
      id: 'r',
      name: 'ranged',
      instances: [{ id: 'gen', type: 'compute.service', config: { demandRps: 500, concurrency: 100000 }, ranges: { demandRps: { lo: 200, hi: 800 } } }],
      wires: [],
    });
    const back = deserialize(json);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const ranges = back.value.instances[0]!.ranges!;
    expect(ranges.assumedRps).toEqual({ lo: 200, hi: 800 });
    expect('demandRps' in ranges).toBe(false);
  });

  for (const legacy of LEGACY_KEYS) {
    it(`migrates a SCENARIO override keyed by "${legacy}" — and it survives the role check (which knows only assumedRps)`, () => {
      // A scenario override on a legacy key would be REJECTED by the role validator (it knows only `assumedRps` as a
      // fact-assumption) unless the migration runs FIRST. That it loads proves the ordering AND the rename. The
      // override KEEPS addressing assumedRps — the generator's reconciled level cell — never the transform itself.
      const json = JSON.stringify({
        schema: 7,
        id: 'w',
        name: 'worlds',
        instances: [{ id: 'gen', type: 'compute.service', config: { [legacy]: 500, concurrency: 100000 } }],
        wires: [],
        scenarios: [{ id: 'stress', overrides: [{ node: 'gen', key: legacy, value: 900 }] }],
      });
      const back = deserialize(json);
      expect(back.ok).toBe(true);
      if (!back.ok) return;
      expect(back.value.scenarios[0]!.overrides[0]).toMatchObject({ node: 'gen', key: 'assumedRps', value: 900 });
    });
  }

  it('is IDEMPOTENT and ADDITIVE: a canonical schema-8 file (and one with no origin at all) round-trips byte-identically', () => {
    const canonical = deserialize(canonicalJson());
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    expect(canonical.value.instances[0]!.transforms?.db).toEqual({ kind: 'generate', level: 500 });
    const out = serialize(canonical.value);
    const again = deserialize(out);
    expect(again.ok).toBe(true);
    if (again.ok) expect(serialize(again.value)).toBe(out);
    // A design with no demand key at all is untouched (a plain relay).
    const neither = deserialize(JSON.stringify({ schema: 3, id: 'n', name: 'n', instances: [{ id: 'db', type: 'db.postgres', config: { concurrency: 50 } }], wires: [] }));
    expect(neither.ok).toBe(true);
    if (!neither.ok) return;
    expect(neither.value.instances[0]!.config).toEqual({ concurrency: 50 });
    expect(neither.value.instances[0]!.transforms).toBeUndefined();
  });

  it('an explicit assumedRps: 0 (an inert origin) is left exactly as written — never a silent edit', () => {
    const json = JSON.stringify({ schema: 7, id: 'z', name: 'zero', instances: [{ id: 'gen', type: 'compute.service', config: { assumedRps: 0 } }], wires: [] });
    const back = deserialize(json);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.instances[0]!.config).toEqual({ assumedRps: 0 });
    expect(back.value.instances[0]!.transforms).toBeUndefined();
  });

  it('a GENERATOR WITH A CURVE round-trips losslessly (schema 8 — plain arrays, no Map handling)', () => {
    const curve = { periodHours: 24, points: [{ t: 0, m: 0.3 }, { t: 9, m: 1.2 }, { t: 19, m: 2.6 }] };
    const json = JSON.stringify({
      schema: 8,
      id: 'c',
      name: 'curved',
      instances: [{ id: 'gen', type: 'compute.service', transforms: { db: { kind: 'generate', level: 500, curve } } }],
      wires: [],
    });
    const back = deserialize(json);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.instances[0]!.transforms?.db).toEqual({ kind: 'generate', level: 500, curve });
    const again = deserialize(serialize(back.value));
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.instances[0]!.transforms?.db).toEqual({ kind: 'generate', level: 500, curve });
  });
});
