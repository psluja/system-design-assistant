import { Key } from '@sda/engine-core';
import { polarityOf } from './registry';
import { isTriangularRange, type Instance, type Manifest, type Range, type Wire } from './manifest';
import type { EnvelopeResult } from './envelope';
import { isScenarioOverridable, type AssumptionScenario, type ScenarioOverride } from './scenario';

// THE DERIVED TRIO. Don't ask a lazy architect to invent three
// worlds; CREATE them — pessimistic / real / optimistic — with values ALREADY filled in. The whole credibility of
// the feature rests on WHERE those values come from: never invented, always derived from THIS design's own computed
// envelope and its declared ranges, and badged `derived` (provenance) so a reader sees they await a measurement.
//
// TWO SOURCES, exactly as the doc prescribes (§5.1, §5.2):
//   • DEMAND keys (a traffic origin's offered load) — fractions of the ENVELOPE's per-origin maximum: real ≈ 60%
//     (comfortably inside the ρ≤0.8 headroom band the tool sizes to), optimistic ≈ 30% (a quiet-launch world),
//     pessimistic ≈ 110% (deliberately PAST the edge — a stress world that SHOULD break, so the architect sees
//     which promise fails first under overload). Grounded in this design's capacity, never a market figure.
//   • RANGED non-demand keys — where a fact-assumption is declared as a range with a KNOWN polarity, the trio picks
//     its ends: pessimistic = the unfavourable bound, optimistic = the favourable bound, real = the mode (triangular)
//     or the midpoint (uniform). Where polarity is UNDEFINED, the key STAYS AT BASE in every world — no guessing
//     (doc §5.2 / tension #2): a world only diverges on an assumption whose direction is honestly known.
//
// HONESTY (no invented numbers): a design with no envelope to derive from (no origin, no SLO edge) and no declared
// range gets NO overrides — the trio is EMPTY with a reason (the feature stays silent rather than fabricate one).
// PURE + DETERMINISTIC: the same design + envelope always yields the same trio.

/** The demand fractions of the per-origin envelope maximum the trio sizes to (doc §5.1). Tunable in ONE place; the
 *  principle (every derived demand is a fraction of a number the tool computed for THIS design) is not negotiable. */
export const DERIVED_DEMAND_FRACTIONS = { pessimistic: 1.1, real: 0.6, optimistic: 0.3 } as const;

/**
 * The DEMAND the trio sizes each origin's fractions off — the capacity envelope, but never so low that the trio
 * under-loads the design below its STATED REQUIREMENT. The requirement floor is the load the design
 * is committed to carry: the origin's stated demand (`baseRps`) and any demand-bearing floor SLO (the envelope's
 * `minRps`). On an under-provisioned design (capacity below the stated demand) a pure fraction of the capacity
 * envelope makes "real" sit BELOW the stated demand — so the worlds ride GREEN by under-loading while the real
 * requirement would break the design (the false-green trap). We prevent it by sizing off an EFFECTIVE maximum
 * = max(capacity envelope, requirementFloor / real-fraction), so `real` = max(0.6·envelope, floor) ≥ the floor,
 * while the trio stays STRICTLY ordered pessimistic > real > optimistic (all three are fractions of one base).
 *
 * PRECEDENCE (envelope vs floor, stated honestly): the CAPACITY envelope leads whenever the design has ample
 * headroom for its stated load (0.6·envelope ≥ the floor) — the common, well-provisioned case, unchanged. The
 * requirement FLOOR binds only when the design is under-provisioned for what it is asked to carry — never a
 * silent under-load, so an under-sized design shows RED at its own requirement instead of a false green.
 */
function demandBaseOf(o: { readonly maxRps: number | undefined; readonly baseRps: number; readonly minRps?: number }): number {
  const floor = Math.max(o.baseRps, o.minRps ?? 0); // the load the design is committed to carry
  const envelope = o.maxRps ?? 0; // the capacity edge (0 when absent — then the floor alone sizes the trio)
  return Math.max(envelope, floor / DERIVED_DEMAND_FRACTIONS.real);
}

/** The trio's stable ids + friendly names, in worst→best order (matching the matrix column order the doc shows). */
type TrioId = 'pessimistic' | 'real' | 'optimistic';
const TRIO: readonly { readonly id: TrioId; readonly name: string }[] = [
  { id: 'pessimistic', name: 'Pessimistic' },
  { id: 'real', name: 'Real' },
  { id: 'optimistic', name: 'Optimistic' },
];

/** Everything the derivation reads: the design's structure + merged catalog, and the already-computed capacity
 *  ENVELOPE (the demand source). A strict superset of what the envelope caller already holds. */
export interface DeriveInput {
  readonly instances: readonly Instance[];
  readonly wires: readonly Wire[];
  readonly catalog: Readonly<Record<string, Manifest>>;
  readonly envelope: EnvelopeResult;
}

/** The derived trio, or an empty list with an honest `reason` when there is nothing to derive from (doc §5.3):
 *  no overridable demand origin AND no ranged fact-assumption with a known polarity. Never a fabricated world. */
export interface DerivedTrioResult {
  readonly scenarios: readonly AssumptionScenario[];
  /** Present ⇒ `scenarios` is empty; WHY the trio could not be derived (surfaced verbatim — no guess). */
  readonly reason?: string;
}

/** The real (mode/midpoint) value of a range — the honest centre a `real` world sits at. */
function realOf(range: Range): number {
  return isTriangularRange(range) ? range.mode : (range.lo + range.hi) / 2;
}

/** The value a ranged key takes in world `id`, given its polarity (doc §5.2). Pessimistic = the unfavourable end,
 *  optimistic = the favourable end, real = the mode/midpoint. */
function rangedValue(id: TrioId, range: Range, polarity: 'higher-is-worse' | 'lower-is-worse'): number {
  if (id === 'real') return realOf(range);
  const worseEnd = polarity === 'higher-is-worse' ? range.hi : range.lo;
  const betterEnd = polarity === 'higher-is-worse' ? range.lo : range.hi;
  return id === 'pessimistic' ? worseEnd : betterEnd;
}

/**
 * Derive the default pessimistic / real / optimistic trio for a design (doc §5). PURE and deterministic. Every
 * override is badged provenance `derived` — the auto-value that live-tracks the envelope until the architect edits
 * it (doc §9, tension #5). Returns an EMPTY trio with a `reason` when there is nothing honest to derive from.
 */
export function deriveDefaultScenarios(input: DeriveInput): DerivedTrioResult {
  const { instances, wires, envelope } = input;

  // 1. DEMAND overrides — one per envelope origin with a computed maximum, scaled to each world's fraction. Guard
  //    on overridability (an origin whose demand knob a scenario may legally set — a fact-assumption or a source
  //    client's throughput); an un-overridable origin is skipped honestly (no silent no-op override).
  const demandOrigins = envelope.perOrigin.filter(
    (o) => o.maxRps !== undefined && Number.isFinite(o.maxRps) && isScenarioOverridable(o.node, o.key, instances, wires),
  );

  // 2. RANGED overrides — one per declared range on a fact-assumption key with a KNOWN polarity (else stay at base).
  const rangedKeys: { readonly node: string; readonly key: string; readonly range: Range; readonly polarity: 'higher-is-worse' | 'lower-is-worse' }[] = [];
  for (const inst of instances) {
    for (const [key, range] of Object.entries(inst.ranges ?? {})) {
      if (!isScenarioOverridable(inst.id, key, instances, wires)) continue; // only a fact-assumption / demand knob
      const polarity = polarityOf(Key(key));
      if (polarity === undefined) continue; // polarity unknown ⇒ no guess — the key stays at base in every world
      rangedKeys.push({ node: inst.id, key, range, polarity });
    }
  }

  if (demandOrigins.length === 0 && rangedKeys.length === 0) {
    const reason =
      envelope.note ??
      "nothing to derive worlds from — no overridable traffic origin and no declared range with a known polarity. Add a generator on a node's output port (or a source client), or declare a range, so the trio has something to size.";
    return { scenarios: [], reason };
  }

  // Precompute the demand base per origin ONCE (the effective maximum that respects the requirement floor), so each
  // world is a clean fraction of it — the trio stays strictly ordered and the floor anchoring is applied uniformly.
  const demandBaseByOrigin = new Map(demandOrigins.map((o) => [`${o.node}|${o.key}`, demandBaseOf(o)] as const));

  const scenarios: AssumptionScenario[] = TRIO.map(({ id, name }) => {
    const overrides: ScenarioOverride[] = [];
    for (const o of demandOrigins) {
      const base = demandBaseByOrigin.get(`${o.node}|${o.key}`) ?? (o.maxRps as number);
      overrides.push({ node: o.node, key: o.key, value: Math.round(base * DERIVED_DEMAND_FRACTIONS[id]), provenance: 'derived' });
    }
    for (const r of rangedKeys) {
      overrides.push({ node: r.node, key: r.key, value: rangedValue(id, r.range, r.polarity), provenance: 'derived' });
    }
    return { id, name, overrides };
  });

  return { scenarios };
}

/**
 * Re-track the LIVE-derived values in `existing` against a freshly-derived trio (doc §9, tension #5 — "live-derived
 * until first manual edit, then frozen"). An override provenance=`derived` takes the fresh envelope-fraction value;
 * an `architect` (frozen) or hand-authored (undefined) override is left EXACTLY as the architect set it — never
 * silently overwritten. UPDATE-ONLY: it refreshes the values of existing derived overrides, it does not add or drop
 * coordinates (re-creating the trio picks up a new origin). Idempotent — an unchanged scenario is returned by
 * reference so a caller can skip a no-op re-render/emit. Matches fresh by scenario id + node|key.
 */
/**
 * Merge a freshly-derived trio over the EXISTING worlds for a re-derivation (the "create the trio" affordance pressed
 * again, or an MCP `derive_scenarios` re-run): take the fresh derived value for every derivable coordinate, but
 * PRESERVE the architect's frozen (`architect`) and hand-authored (undefined) overrides — a re-derive never silently
 * discards a number the architect typed. For a world the design has no existing counterpart of, the fresh world is
 * used as-is. Returns one `AssumptionScenario` per fresh world (the trio), ready to `declareScenario`.
 */
export function mergeDerivedTrio(
  existing: readonly AssumptionScenario[],
  fresh: readonly AssumptionScenario[],
): AssumptionScenario[] {
  const byId = new Map(existing.map((s) => [s.id, s]));
  return fresh.map((f) => {
    const prev = byId.get(f.id);
    if (prev === undefined) return f;
    const frozen = prev.overrides.filter((o) => o.provenance !== 'derived'); // architect + hand-authored — kept
    const frozenCoords = new Set(frozen.map((o) => `${o.node}|${o.key}`));
    const derived = f.overrides.filter((o) => !frozenCoords.has(`${o.node}|${o.key}`)); // fresh derived where not frozen
    return { ...f, overrides: [...derived, ...frozen] };
  });
}

/**
 * The RESET of ONE named world (the explicit "reset means reset" affordance, doc §5.3) — the NON-preserving twin of
 * {@link mergeDerivedTrio}. Where a re-derive PRESERVES the architect's frozen/hand-authored edits, a reset WIPES
 * them:
 *   • a DERIVED-TRIO world (its id is in `fresh`) is reset to its freshly-derived values — ALL overrides become
 *     provenance=`derived` again (any `architect`/frozen number the architect typed is dropped), so the world
 *     re-tracks the current capacity envelope from scratch.
 *   • a CUSTOM world (its id is NOT in `fresh` — no derivation to reset to) has its overrides CLEARED entirely, so
 *     the world falls back to the base layer (an empty-override world evaluates exactly as base).
 * Returns the reset world (ready to `declareScenario`, replacing the old one by id in ONE undoable edit), or
 * undefined when `id` names no declared world. PURE — the caller supplies the fresh trio (or `[]` when nothing is
 * derivable, in which case even a trio id clears to base, the honest fallback).
 */
export function resetScenario(
  existing: readonly AssumptionScenario[],
  fresh: readonly AssumptionScenario[],
  id: string,
): AssumptionScenario | undefined {
  const derived = fresh.find((f) => f.id === id);
  if (derived !== undefined) return derived; // a trio world → reset to the freshly-derived (all `derived`, frozen dropped)
  const world = existing.find((s) => s.id === id);
  if (world === undefined) return undefined; // no such world
  return { ...world, overrides: [] }; // a custom world → clear overrides (falls back to base)
}

export function refreshDerivedScenarios(
  existing: readonly AssumptionScenario[],
  fresh: readonly AssumptionScenario[],
): AssumptionScenario[] {
  const freshById = new Map(fresh.map((s) => [s.id, new Map(s.overrides.map((o) => [`${o.node}|${o.key}`, o.value] as const))]));
  return existing.map((s) => {
    const fm = freshById.get(s.id);
    if (fm === undefined) return s; // a custom scenario the trio does not cover — untouched
    let changed = false;
    const overrides = s.overrides.map((o) => {
      if (o.provenance !== 'derived') return o; // architect/frozen or hand-authored — never re-tracked
      const nv = fm.get(`${o.node}|${o.key}`);
      if (nv === undefined || nv === o.value) return o;
      changed = true;
      return { ...o, value: nv };
    });
    return changed ? { ...s, overrides } : s;
  });
}
