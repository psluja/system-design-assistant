import { describe, expect, it } from 'vitest';
import { type Key } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { allCatalogs, instantiate, keys, protocolIds, registry, type Manifest } from '../index';

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
//   5. POOLED-STORE CAPACITY IS COHERENT ACROSS ENGINES — a fixed-throughput store that declares a connection
//      POOL forms a DES M/M/pool station whose drain rate pool / (held/1000) must EQUAL its INDEPENDENT
//      `throughput` literal (the analytic/scalar ceiling). Three independent numbers; if the held time drifts (it
//      is a listed calibration tunable) or a typo slips in, the DES and the analytic engine silently disagree
//      about WHERE the store saturates — capacity is the "never lies" charter's #1 quantity.
//   6. PROVENANCE IS HONEST — (a) a config is never BOTH sourced and estimated: manifest.ts:73-77 states a value
//      is `documented` (has `source`), an `estimate` (`est: true`), or a plain `default` — never both, and
//      doc-model.ts's configProvenance checks `source` BEFORE `est`, so a config carrying both would silently
//      badge `documented` and DROP the estimate flag, presenting an estimate as a documented fact. (b) a `source`
//      is a real primary-doc URL (the same shape guarantee-slo.e2e checks for guarantee claims) — the assumptions
//      register renders `documented` sources as live anchors, so a non-URL source would be fabricated authority.
// 7. NO HARD NUMBER RIDES AS A BARE `default` — every config whose KEY is a capacity/latency/cost-
//      bearing quantity (HARD_NUMBER_KEYS below: throughput, latency, perRequestDuration, concurrency,
//      connectionPool, connectionHeldMs, drainRate, unitCost, availability, durability, vcpus, accountConcurrency,
//      egressUsdPerGb, payloadBytes, maxItemBytes, retention, maxBacklog — the keys this pass actually swept, plus
//      availability/durability which rule 6(b) already polices for `source`) must carry `source` OR `est: true`
//      UNLESS its value is NEUTRAL. NEUTRAL is defined narrowly, mechanically, with NO per-component whitelist:
//        (a) value === 0 — a literal zero (a disabled knob, "this hop adds no latency", "no retention at all");
//        (b) (key is availability OR durability) AND value === 1 — an abstract/always-up node's ceiling ratio.
//      Every other non-neutral hard number is either a PUBLISHED fact (`source`, a verifiable primary-doc URL) or
//      an honest ESTIMATE (`est: true`) — never a silent, unlabelled default masquerading as either. Deliberately
//      EXCLUDED from HARD_NUMBER_KEYS: `replicas`/`maxUnits` (an architect's SIZING choice, not an infra fact —
//      "how many" is a knob the design turns, not a vendor limit) and `deploymentMode`/`queueMode` (mode flags,
//      rule 3's own carve-out). A component whose bare default predates this law would have FAILED it — this law
// only passes because the pass above added `source`/`est` to every entry it covers.
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

// Law 7: the closed set of capacity/latency/cost-bearing config keys that must carry `source` or `est`
// whenever their value is non-neutral — see the header note above for the full rationale and the exclusions.
const HARD_NUMBER_KEYS = new Set<string>(
  [
    keys.throughput,
    keys.latency,
    keys.perRequestDuration,
    keys.concurrency,
    keys.connectionPool,
    keys.connectionHeldMs,
    keys.drainRate,
    keys.unitCost,
    keys.availability,
    keys.durability,
    keys.vcpus,
    keys.accountConcurrency,
    keys.egressUsdPerGb,
    keys.payloadBytes,
    keys.maxItemBytes,
    keys.retention,
    keys.maxBacklog,
  ].map(String),
);
const RATIO_KEYS_FOR_NEUTRALITY = new Set<string>([keys.availability, keys.durability].map(String));
/** Is this hard-number config value NEUTRAL (law 7 in the header above) — the ONLY case a hard number may stay a bare
 *  `default` with neither `source` nor `est`? A literal zero, or availability/durability exactly at 1. */
const isNeutralHardNumber = (key: string, value: number): boolean => value === 0 || (RATIO_KEYS_FOR_NEUTRALITY.has(key) && value === 1);

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

      it('a pooled store\'s DES capacity (pool / held) equals its declared throughput ceiling — the two engines cannot drift', () => {
        // A fixed-throughput store (no `concurrency`) that declares a connection POOL forms a DES M/M/pool station
        // with service = held (graph-read `baseStation`): its drain rate is pool / (held/1000). The analytic/scalar
        // engine reads capacity from the INDEPENDENT `throughput` literal. This pins pool/(held/1000) == throughput
        // for EVERY pooled store (present + future), the data-level twin of queueing.e2e's computed db.cheap check —
        // so redis/memcached/mongodb/db.sql (and anything added later) can never drift the way only db.cheap and
        // proxy.rds were previously guarded against.
        const val = (k: Key): number | undefined => m.config?.find((c) => String(c.key) === String(k))?.value;
        const pool = val(keys.connectionPool);
        const held = val(keys.connectionHeldMs);
        const concurrency = val(keys.concurrency);
        const throughput = val(keys.throughput);
        // Only the pooled-store mechanism applies: a connection pool, NOT a concurrency-bound station (which owns
        // its own M/M/c queue), and a LITERAL `throughput` to compare against — a relation-derived ceiling is
        // invisible to a config read (graph-read note) and no shipped pooled store uses one.
        if (pool === undefined || held === undefined || concurrency !== undefined || throughput === undefined) return;
        expect(pool / (held / 1000), `${type}: pool ${pool} / held ${held} ms = ${pool / (held / 1000)} ≠ throughput ${throughput}`).toBeCloseTo(throughput, 6);
      });

      it('a config is never both sourced and estimated (documented would silently win, dropping the estimate flag)', () => {
        for (const c of m.config ?? []) {
          const key = String(c.key);
          expect(
            !(c.source !== undefined && c.est === true),
            `${type}: config "${key}" = ${c.value} carries BOTH source and est — configProvenance checks source first, so the estimate flag would silently vanish`,
          ).toBe(true);
        }
      });

      it('every documented source is a real primary-doc URL, not a placeholder', () => {
        for (const c of m.config ?? []) {
          if (c.source === undefined) continue;
          const key = String(c.key);
          expect(c.source, `${type}: config "${key}" source "${c.source}" is not a well-formed https URL`).toMatch(/^https:\/\/[^\s]+$/);
        }
      });

      it('no hard infra number (throughput/latency/cost/…) rides as a bare, unprovenanced default (law 7)', () => {
        for (const c of m.config ?? []) {
          const key = String(c.key);
          if (!HARD_NUMBER_KEYS.has(key)) continue;
          if (isNeutralHardNumber(key, c.value)) continue;
          expect(
            c.source !== undefined || c.est === true,
            `${type}: hard-number config "${key}" = ${c.value} carries neither \`source\` nor \`est: true\` — a capacity/latency/cost-bearing number must be documented, estimated, or explicitly neutral (0, or availability/durability=1), never a silent default`,
          ).toBe(true);
        }
      });
    });
  }
});
