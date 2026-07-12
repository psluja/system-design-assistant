import { Key, type Band } from '@sda/engine-core';
import { portsConnect } from '@sda/engine-solve';
import { keys } from '../vocabulary/registry';
import { protocolCompat } from '../vocabulary/protocols';
import type { Instance, Manifest, ManifestBand, Wire } from '../vocabulary/manifest';
import type { SynthSlot, SynthSpec } from './synthesize';

// synth-spec — the DOMAIN spec-builders: turn a live design (a node to reconsider) or a
// high-level intent (fixed anchors + family slots + wiring + SLOs) into a SynthSpec for synthesize().
// This is content, not engine: it reads the manifest catalog + graph and knows the domain conventions
// (component FAMILIES, like-for-like swaps, the archetype system patterns). synthesize() then does the
// generate → size → rank; here we only shape WHAT it searches over. All meaning stays as data + rules.

const isIn = (d: string): boolean => d === 'in' || d === 'bi';
const isOut = (d: string): boolean => d === 'out' || d === 'bi';
const portProtocol = (catalog: Readonly<Record<string, Manifest>>, type: string, port: string): string | undefined => {
  const p = catalog[type]?.ports.find((x) => x.name === port);
  return p === undefined ? undefined : isOut(p.dir) ? (p.speaks?.[0] ?? p.accepts?.[0]) : (p.accepts?.[0] ?? p.speaks?.[0]); // the NATURAL protocol = first of the list
};
/** A component's FAMILY = the type-id prefix (`compute.faas` → `compute`). Domain-agnostic: just the
 *  catalog's naming convention; the engine never reads it. Keeps alternatives / slot candidates like-for-like. */
export const familyOf = (type: string): string => (type.includes('.') ? type.slice(0, type.indexOf('.')) : type);

/**
 * Build a single-slot synth spec from a live design: keep every node fixed EXCEPT `node`, whose type is
 * freed to any catalog type that drops into its exact wiring — the same port NAMES carrying compatible
 * protocols (derived from the fixed neighbours on the far ends). The slot keeps the node's own SLOs and, if
 * it receives load, an `overflow ≤ 0` band so a candidate cannot win by being undersized and silently
 * dropping traffic. The `objective` is what the survivors are sized-for and ranked-by.
 */
export function specForNode(
  catalog: Readonly<Record<string, Manifest>>,
  instances: readonly Instance[],
  wires: readonly Wire[],
  node: string,
  objective: { node: string; key: Key; direction: 'min' | 'max' },
): { ok: true; value: SynthSpec } | { ok: false; error: string } {
  const self = instances.find((i) => i.id === node);
  if (self === undefined) return { ok: false, error: `no node "${node}" in the design` };

  const typeOf = (id: string): string => instances.find((i) => i.id === id)?.type ?? '';
  const needIn = new Map<string, string>(); // node's in-port NAME → protocol it must accept (from the producer)
  const needOut = new Map<string, string>(); // node's out-port NAME → protocol it must produce (for the consumer)
  for (const w of wires) {
    if (w.to[0] === node) { const p = portProtocol(catalog, typeOf(w.from[0]), w.from[1]); if (p !== undefined) needIn.set(w.to[1], p); }
    if (w.from[0] === node) { const p = portProtocol(catalog, typeOf(w.to[0]), w.to[1]); if (p !== undefined) needOut.set(w.from[1], p); }
  }
  if (needIn.size === 0 && needOut.size === 0) return { ok: false, error: `node "${node}" has no connections — wire it first so its alternatives follow from the topology` };

  // A candidate fits if, for each wire the node carries, it has a SAME-NAMED port (the spec reuses the wire's
  // port names) whose protocol is COMPATIBLE with the neighbour — accept-set for an in-port, speak-set for an
  // out-port (the same rule the legality layer uses), NOT an exact-protocol match. So a Lambda (in: http, but
  // accepts sqs) is a valid alternative to a Fargate worker fed by an SQS queue.
  const fits = (m: Manifest): boolean => {
    const has = (name: string, proto: string, dir: 'in' | 'out'): boolean =>
      m.ports.some((p) => {
        if (p.name !== name || (dir === 'in' ? !isIn(p.dir) : !isOut(p.dir))) return false;
        return dir === 'in'
          ? portsConnect([proto], p.accepts ?? [], protocolCompat) // candidate IN accepts the producer's protocol
          : portsConnect(p.speaks ?? [], [proto], protocolCompat); // candidate OUT can emit to the consumer
      });
    for (const [name, proto] of needIn) if (!has(name, proto, 'in')) return false;
    for (const [name, proto] of needOut) if (!has(name, proto, 'out')) return false;
    return true;
  };
  // Like-for-like: candidates share the node's FAMILY (the type-id prefix — `compute.*`, `db.*`, …) AND drop
  // into its exact wiring. The family keeps the comparison meaningful (a proxy is not a "compute alternative")
  // while staying domain-agnostic: it generalises to every family, with no engine-side knowledge of any of them.
  const family = familyOf(self.type);
  const types = Object.keys(catalog).filter((t) => familyOf(t) === family && fits(catalog[t] as Manifest)).sort();

  const ownBands = (self.bands ?? []).filter((b) => b.key !== keys.overflow);
  const bands: ManifestBand[] = needIn.size > 0 ? [...ownBands, { key: keys.overflow, band: { shape: 'minTargetMax', max: 0 } }] : [...ownBands];

  return {
    ok: true,
    value: {
      fixed: instances.filter((i) => i.id !== node),
      slots: [{ id: node, node, types, ...(bands.length > 0 ? { bands } : {}) }],
      adjacencies: [],
      wires: [...wires],
      objective,
    },
  };
}


/** A SLOT in a synth template: a node id to fill, constrained to one component FAMILY. */
export interface SlotReq {
  readonly id: string;
  readonly family: string;
}
/** One end-to-end / per-node requirement: a band on `node.key` (≥ a floor or ≤ a ceiling). */
export interface SloReq {
  readonly node: string;
  readonly key: string;
  readonly cmp: '>=' | '<=';
  readonly value: number;
}

/**
 * Build a multi-slot synth spec from a high-level intent: FIXED anchors (their type pinned), SLOTS (a node id
 * + a component family to fill), a WIRING template over both, and SLOs. Each slot's candidate types are the
 * family members that carry the port NAMES its wires use (and, where a wire's other end is a FIXED node, the
 * matching protocol — slot↔slot protocol agreement is left to clingo's adjacency compatibility + instantiate).
 * Every receiver gets `overflow ≤ 0` so a winner must actually serve the load. The objective defaults to cost
 * at a sink. The caller passes this straight to `synthesize()`; the SEARCH (which type, which size) is the
 * engine's — the intent is all the AI supplies.
 */
export function specFromSlots(
  catalog: Readonly<Record<string, Manifest>>,
  fixed: readonly Instance[],
  slots: readonly SlotReq[],
  wires: readonly Wire[],
  slos: readonly SloReq[],
  objective: { node?: string; key: Key; direction: 'min' | 'max' },
): { ok: true; value: SynthSpec } | { ok: false; error: string } {
  const fixedById = new Map(fixed.map((f) => [f.id, f]));
  const slotIds = new Set(slots.map((s) => s.id));
  const allIds = new Set<string>([...fixedById.keys(), ...slotIds]);
  if (allIds.size === 0) return { ok: false, error: 'no fixed anchors or slots given' };
  for (const w of wires) {
    if (!allIds.has(w.from[0])) return { ok: false, error: `wire from unknown node "${w.from[0]}"` };
    if (!allIds.has(w.to[0])) return { ok: false, error: `wire to unknown node "${w.to[0]}"` };
  }

  const receivers = new Set(wires.map((w) => w.to[0]));
  const fixedType = (id: string): string | undefined => fixedById.get(id)?.type;
  const portMatches = (m: Manifest, name: string, proto: string | undefined, dir: 'in' | 'out'): boolean =>
    m.ports.some((p) => p.name === name && (dir === 'in' ? isIn(p.dir) : isOut(p.dir)) && (proto === undefined || ((dir === 'in' ? p.accepts : p.speaks)?.includes(proto) ?? false)));

  const candidatesFor = (slot: SlotReq): string[] => {
    const needIn: Array<readonly [string, string | undefined]> = [];
    const needOut: Array<readonly [string, string | undefined]> = [];
    for (const w of wires) {
      if (w.to[0] === slot.id) { const nt = fixedType(w.from[0]); needIn.push([w.to[1], nt !== undefined ? portProtocol(catalog, nt, w.from[1]) : undefined]); }
      if (w.from[0] === slot.id) { const nt = fixedType(w.to[0]); needOut.push([w.from[1], nt !== undefined ? portProtocol(catalog, nt, w.to[1]) : undefined]); }
    }
    return Object.keys(catalog)
      .filter((t) => familyOf(t) === slot.family && needIn.every(([n, p]) => portMatches(catalog[t] as Manifest, n, p, 'in')) && needOut.every(([n, p]) => portMatches(catalog[t] as Manifest, n, p, 'out')))
      .sort();
  };

  // The SLO bands a node carries, plus `overflow ≤ 0` if it receives load (so a winner truly serves it).
  const bandsFor = (id: string): ManifestBand[] => {
    const out: ManifestBand[] = [];
    for (const s of slos) {
      if (s.node !== id) continue;
      const band: Band = { shape: 'minTargetMax', ...(s.cmp === '>=' ? { min: s.value } : { max: s.value }) };
      out.push({ key: Key(s.key), band });
    }
    if (receivers.has(id) && !out.some((b) => b.key === keys.overflow)) out.push({ key: keys.overflow, band: { shape: 'minTargetMax', max: 0 } });
    return out;
  };

  const synthSlots: SynthSlot[] = [];
  for (const s of slots) {
    const types = candidatesFor(s);
    if (types.length === 0) return { ok: false, error: `no "${s.family}" component fits slot "${s.id}" (check its family and port names)` };
    const b = bandsFor(s.id);
    synthSlots.push({ id: s.id, node: s.id, types, ...(b.length > 0 ? { bands: b } : {}) });
  }

  const fixedInsts: Instance[] = fixed.map((f) => {
    const extra = bandsFor(f.id).filter((nb) => !(f.bands ?? []).some((eb) => eb.key === nb.key));
    const merged = [...(f.bands ?? []), ...extra];
    return merged.length > 0 ? { ...f, bands: merged } : f;
  });

  const adjacencies = wires.filter((w) => slotIds.has(w.from[0]) && slotIds.has(w.to[0])).map((w) => [w.from[0], w.to[0]] as const);

  // Objective node: explicit, else a SINK (no outgoing wire — where cumulative cost is the system total),
  // preferring the last in declaration order; falls back to the last declared node.
  const hasOut = new Set(wires.map((w) => w.from[0]));
  const ordered = [...fixed.map((f) => f.id), ...slots.map((s) => s.id)];
  const objNode = objective.node ?? [...ordered].reverse().find((id) => !hasOut.has(id)) ?? ordered[ordered.length - 1];
  if (objNode === undefined) return { ok: false, error: 'cannot pick an objective node' };

  return { ok: true, value: { fixed: fixedInsts, slots: synthSlots, adjacencies: [...adjacencies], wires: [...wires], objective: { node: objNode, key: objective.key, direction: objective.direction } } };
}

/** ARCHETYPE shape templates for `auto_architect` — the skeleton (slots + wiring + terminal) the engine fills
 *  and sizes from requirements alone. The fixed `client.web` (carrying the workload) is prepended by the tool.
 *  Wirings use ports that exist across the family so candidates are non-trivial; the terminal carries the
 *  end-to-end SLOs and is the cost-objective node. New patterns are pure data here — no engine change. */
export const ARCHETYPES: Readonly<Record<string, { readonly slots: readonly SlotReq[]; readonly wires: readonly Wire[]; readonly terminal: string }>> = {
  // a request service: client → compute → database
  web: {
    slots: [{ id: 'svc', family: 'compute' }, { id: 'db', family: 'db' }],
    wires: [{ from: ['client', 'out'], to: ['svc', 'in'] }, { from: ['svc', 'db'], to: ['db', 'in'] }],
    terminal: 'db',
  },
  // a read service with a cache in front of the store: client → compute → {cache, database}
  'cached-read': {
    slots: [{ id: 'svc', family: 'compute' }, { id: 'cache', family: 'cache' }, { id: 'db', family: 'db' }],
    wires: [{ from: ['client', 'out'], to: ['svc', 'in'] }, { from: ['svc', 'cache'], to: ['cache', 'in'] }, { from: ['svc', 'db'], to: ['db', 'in'] }],
    terminal: 'db',
  },
};
