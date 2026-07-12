import { describe, expect, it } from 'vitest';
import { evaluate } from '@sda/engine-solve';
import { allCatalogs, instantiate, keys, protocolIds, registry, type Manifest } from './index';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// TIER 7 — DEEP CONTENT INTEGRITY. "The tool must not lie" begins with the catalog itself: EVERY shipped
// manifest must be internally consistent and physically sane BEFORE any solver reasons over it. A bad
// number, a typo'd registry key, an unparseable relation, or an unknown protocol would silently poison a
// verdict downstream — the opposite of "verified, not a dumb diagram". This suite is table-driven over the
// WHOLE catalog (allCatalogs, every catalog, every component), not a hand-picked few, so a new manifest is
// covered the moment it is added. It deliberately does NOT repeat catalogs.test.ts (keyed-by-type / no
// cross-catalog shadowing); it adds the DEEPER, per-manifest checks:
//
//   1. RELATIONS COMPILE — every relation expression parses and references only real registry keys. We
//      prove this end-to-end the way the engine does it: instantiate a single isolated node of the type
//      (no wires) and evaluate it. The relation parser + key resolver live in buildNetwork (engine/solve),
//      reached via evaluate; instantiate alone (buildGraph) only validates topology. A parse error or an
//      `unknown key "…"` / `not in registry` surfaces as evaluate → { ok: false }, naming the node + key.
//   2. EVERY DECLARED KEY IS GOVERNED — config keys, relation keys (and their `reads`), and band keys must
//      all exist in the property registry. The registry is the closed vocabulary; an ungoverned key has no
//      algebra and cannot compose.
//   3. PORTS ARE WELL-FORMED — every port speaks a known protocol id and has a legal direction.
//   4. CONFIG VALUES ARE PHYSICALLY SANE — ratios (availability, durability) ∈ [0,1]; magnitudes
//      (latency, throughput, cost, perRequestDuration) ≥ 0; unit counts (replicas, concurrency, maxUnits)
//      ≥ 1 wherever present. A negative latency or a "1.4 availability" is a lie the tool must never ship.
//
// Each it() states one law in plain English and every failure names the offending component + key + value.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every (type, manifest) across every shipped catalog — the table this suite iterates. */
const ALL_MANIFESTS: ReadonlyArray<readonly [string, Manifest]> = allCatalogs.flatMap((cat) => Object.entries(cat));

const LEGAL_DIRS: readonly string[] = ['in', 'out', 'bi'];

// Physical-sanity classification of config keys (string-keyed so we compare against the manifest's Key ids).
const RATIO_KEYS = new Set<string>([keys.availability, keys.durability].map(String)); // must be a probability ∈ [0,1]
const NON_NEGATIVE_KEYS = new Set<string>([keys.latency, keys.throughput, keys.cost, keys.perRequestDuration].map(String)); // ≥ 0
const POSITIVE_UNIT_KEYS = new Set<string>([keys.replicas, keys.concurrency, keys.maxUnits].map(String)); // a count of things ⇒ ≥ 1

describe('deep content integrity (every manifest, every catalog)', () => {
  for (const [type, m] of ALL_MANIFESTS) {
    describe(type, () => {
      it('every relation parses and references only registry keys (a single isolated node evaluates cleanly)', () => {
        // A one-node graph for just this manifest — no wires, so the ONLY build errors possible are the
        // relation parse / unknown-key / not-in-registry errors we are hunting for.
        const built = instantiate({ [type]: m }, [{ id: 'n', type }], []);
        expect(built.ok, `${type}: failed to instantiate a single node: ${built.ok ? '' : JSON.stringify(built.error)}`).toBe(true);
        if (!built.ok) return;

        const evaled = evaluate(built.value, registry);
        expect(evaled.ok, `${type}: relation parse / unknown-key error(s): ${evaled.ok ? '' : evaled.error.join(' | ')}`).toBe(true);
      });

      it('every config / relation / band key is governed by the registry', () => {
        for (const c of m.config ?? []) {
          expect(registry.has(c.key), `${type}: config key "${String(c.key)}" is not in the registry`).toBe(true);
        }
        for (const r of m.relations ?? []) {
          expect(registry.has(r.key), `${type}: relation produces ungoverned key "${String(r.key)}"`).toBe(true);
          for (const read of r.reads) {
            expect(registry.has(read), `${type}: relation for "${String(r.key)}" reads ungoverned key "${String(read)}"`).toBe(true);
          }
        }
        for (const b of m.bands ?? []) {
          expect(registry.has(b.key), `${type}: band key "${String(b.key)}" is not in the registry`).toBe(true);
        }
      });

      it('every port lists only known protocols, has a legal direction, and carries its side\'s list', () => {
        for (const p of m.ports) {
          for (const proto of [...(p.accepts ?? []), ...(p.speaks ?? [])]) {
            expect(protocolIds.has(proto), `${type}: port "${p.name}" references unknown protocol "${proto}"`).toBe(true);
          }
          expect(LEGAL_DIRS.includes(p.dir), `${type}: port "${p.name}" has illegal direction "${p.dir}"`).toBe(true);
          // a consumer must say what it ACCEPTS; a producer what it SPEAKS (legality is meaningless without)
          if (p.dir === 'in' || p.dir === 'bi') expect((p.accepts ?? []).length, `${type}: in-port "${p.name}" has an empty accepts list`).toBeGreaterThan(0);
          if (p.dir === 'out' || p.dir === 'bi') expect((p.speaks ?? []).length, `${type}: out-port "${p.name}" has an empty speaks list`).toBeGreaterThan(0);
        }
      });

      it('every config value is physically sane (ratios ∈ [0,1]; magnitudes ≥ 0; unit counts ≥ 1)', () => {
        for (const c of m.config ?? []) {
          const key = String(c.key);
          const v = c.value;
          expect(Number.isFinite(v), `${type}: config "${key}" = ${v} is not a finite number`).toBe(true);
          if (RATIO_KEYS.has(key)) {
            expect(v >= 0 && v <= 1, `${type}: ratio "${key}" = ${v} is outside [0,1]`).toBe(true);
          }
          if (NON_NEGATIVE_KEYS.has(key)) {
            expect(v >= 0, `${type}: "${key}" = ${v} must be ≥ 0`).toBe(true);
          }
          if (POSITIVE_UNIT_KEYS.has(key)) {
            expect(v >= 1, `${type}: unit count "${key}" = ${v} must be ≥ 1`).toBe(true);
          }
        }
      });
    });
  }
});
