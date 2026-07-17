import { Key, type Band } from '@sda/engine-core';
import { keys } from '../vocabulary/registry';
import { protocolCompat } from '../vocabulary/protocols';
import type { Instance, Manifest, ManifestBand, Wire } from '../vocabulary/manifest';
import { portNeedsOf, remapPorts } from './port-remap';
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

  // The node's wired ports, each with the peer protocol-set(s) it must legally reach (derived from the fixed
  // neighbours on the far ends). These are what a candidate must be able to CARRY — by direction + protocol, not by
  // port name, since same-family members name their ports inconsistently (a function's egress is `out`; a service's
  // are `db`/`cache`).
  const needs = portNeedsOf(catalog, instances, wires, node);
  if (needs.length === 0) return { ok: false, error: `node "${node}" has no connections — wire it first so its alternatives follow from the topology` };

  // A candidate fits when its ports can host EVERY wired port — each mapped by DIRECTION + protocol compatibility
  // (`portsConnect`, the same rule the legality layer uses) to a compatible candidate port, remapping the wire onto
  // that port. So a Lambda (in: http but accepts sqs; a single generic `out`) is a valid alternative to a Fargate
  // worker on an SQS queue, and to a service that talks to a db AND a cache (its `db`/`cache` wires remap onto the
  // Lambda's `out`). `remapPorts` returns the per-candidate name map (or null when a wire has no compatible port);
  // it is the SAME remap the command core applies on a swap (port-remap.ts), so OFFER and APPLY can never disagree.
  // Like-for-like: candidates share the node's FAMILY (the type-id prefix — `compute.*`, `db.*`, …). The family keeps
  // the comparison meaningful (a proxy is not a "compute alternative") while staying domain-agnostic.
  const family = familyOf(self.type);
  const types: string[] = [];
  const portMap: Record<string, Record<string, string>> = {};
  for (const t of Object.keys(catalog).sort()) {
    if (familyOf(t) !== family) continue;
    const map = remapPorts(catalog[t] as Manifest, needs, protocolCompat);
    if (map === null) continue; // no compatible port for some wire — not a drop-in
    types.push(t);
    portMap[t] = map;
  }

  const receivesLoad = needs.some((n) => n.dir === 'in');
  const ownBands = (self.bands ?? []).filter((b) => b.key !== keys.overflow);
  const bands: ManifestBand[] = receivesLoad ? [...ownBands, { key: keys.overflow, band: { shape: 'minTargetMax', max: 0 } }] : [...ownBands];

  return {
    ok: true,
    value: {
      fixed: instances.filter((i) => i.id !== node),
      slots: [{ id: node, node, types, portMap, ...(bands.length > 0 ? { bands } : {}) }],
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
