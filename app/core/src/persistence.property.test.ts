import { describe, it } from 'vitest';
import fc from 'fast-check';
import { NodeId } from '@sda/engine-core';
import { commonManifests, keys, registry, type Manifest } from '@sda/content';
import { Studio } from './store';
import { deserialize, serialize } from './document';
import type { Command } from './commands';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// TIER 8 — PERSISTENCE ROUND-TRIP (property-based). "The export file IS the real backup" (CLAUDE.md), so
// it must be LOSSLESS and the command core must be HONEST about state: serialize→deserialize, and
// command→undo, can introduce NO drift. We assert four laws over THOUSANDS of random — but always LEGAL —
// projects, each assembled the only sanctioned way: by dispatching commands onto a fresh `Studio`
// (addComponent / setConfig / connect / setSLO / setLabel / addGroup / assignGroup). A FAANG-grade
// "verified, not a diagram" tool earns trust here: if a save loses a wire, an SLO, a group, or a custom
// component — or if undo lands on a *slightly* different document — the user's backup silently lies.
//
//   LAW 1  ROUND-TRIP IS STABLE & LOSSLESS — serialize(doc) re-parses to a structurally-equal document,
//          and re-serializing is byte-identical (a stable, diffable export; no field drift, no reorder).
//   LAW 2  LOAD PRESERVES MEANING — loading the round-tripped document yields the SAME engine evaluation
//          (converged flag, every solved value, every verdict). Persistence carries no semantic drift.
//   LAW 3  UNDO IS THE EXACT INVERSE — after each successful command, one undo restores the *exact* prior
//          document (proved against a serialized snapshot, not reference identity), and redo replays it.
//   LAW 4  CUSTOM COMPONENTS SURVIVE — a project-scoped `defineComponent` round-trips intact and stays
//          placeable after a reload (the self-contained project keeps its own vocabulary).
//
// Seeded for reproducibility. The generators only ever emit commands whose preconditions hold (e.g.
// `connect` references nodes that already exist via real ports), so every dispatch is expected to succeed
// — but each law still guards on the `Result.ok` the command core returns.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

const SEED = 20260629;

// The Studio's catalogue. The generators below pick types/ports ONLY from here, so every generated
// `addComponent`/`connect` is a legal command against a `new Studio(registry, commonManifests)`.
const CATALOG = commonManifests;
const portsOf = (type: string, dir: 'in' | 'out'): string[] =>
  (CATALOG[type]?.ports ?? []).filter((p) => p.dir === dir || p.dir === 'bi').map((p) => p.name);

// A SOURCE offers load (an out port, no in port); a RECEIVER can receive work (has an in port).
const SOURCE_TYPES = Object.keys(CATALOG).filter((t) => portsOf(t, 'out').length > 0 && portsOf(t, 'in').length === 0);
const RECEIVER_TYPES = Object.keys(CATALOG).filter((t) => portsOf(t, 'in').length > 0);

const ALL_KEYS = Object.values(keys);

/** Structural deep equality (order-insensitive for object keys) — meaningful only across a real JSON
 *  boundary, where `deserialize(serialize(x))` produces fresh objects that share no references with `x`. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ak = Object.keys(a as Record<string, unknown>);
  const bk = Object.keys(b as Record<string, unknown>);
  if (ak.length !== bk.length) return false;
  return ak.every(
    (k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** A serialization-stable fingerprint of the engine's verdict on the CURRENT document: the converged
 *  flag, every (node × key) solved value, and every verdict. Two studios with the same meaning share it. */
function fingerprint(s: Studio): string {
  const ev = s.evaluate();
  if (!ev.ok) return JSON.stringify({ ok: false, error: [...ev.error] });
  const e = ev.value;
  const grid = s.project().instances.map((inst) => {
    const id = NodeId(inst.id);
    const row = ALL_KEYS.map((k) => {
      const v = e.value(id, k);
      return v === undefined ? null : Number.isNaN(v) ? 'NaN' : v;
    });
    return [inst.id, row] as const;
  });
  return JSON.stringify({ ok: true, converged: e.converged, verdicts: e.verdicts, grid });
}

// One receiver's random choices (mod-indexed at assembly so any value is valid ⇒ fast-check shrinks cleanly).
const arbReceiver = fc.record({
  type: fc.constantFrom(...RECEIVER_TYPES),
  parent: fc.nat(), // which earlier out-capable node to attach to
  fromPort: fc.nat(), // which of the parent's out ports
  toPort: fc.nat(), // which of this node's in ports
  async: fc.boolean(),
});

// A random port transform (the closed set) — used to prove per-instance transforms round-trip losslessly.
const arbTransform = fc.oneof(
  fc.record({ kind: fc.constant('ratio' as const), value: fc.integer({ min: 1, max: 1000 }) }),
  fc.record({ kind: fc.constant('batch' as const), value: fc.integer({ min: 1, max: 1000 }) }),
  fc.record({ kind: fc.constant('cap' as const), value: fc.integer({ min: 1, max: 100_000 }) }),
  fc.record({ kind: fc.constant('window' as const), value: fc.integer({ min: 1, max: 60_000 }) }),
  fc.record({ kind: fc.constant('prob' as const), value: fc.constantFrom(0.01, 0.1, 0.5, 1) }),
);

// Extra LEGAL mutations layered on top of the topology (config / SLO / friendly label / group / grouping /
// per-port flow transform / per-WIRE flow transform). Every one is an additive, undoable per-instance/wire/document field.
const arbExtra = fc.oneof(
  fc.record({ tag: fc.constant('label' as const), node: fc.nat(), text: fc.string() }),
  fc.record({ tag: fc.constant('config' as const), node: fc.nat(), value: fc.integer({ min: 0, max: 100_000 }) }),
  fc.record({ tag: fc.constant('slo' as const), node: fc.nat(), max: fc.integer({ min: 1, max: 100_000 }) }),
  fc.record({ tag: fc.constant('group' as const), node: fc.nat(), label: fc.string() }),
  fc.record({ tag: fc.constant('assign' as const), node: fc.nat() }),
  fc.record({ tag: fc.constant('transform' as const), node: fc.nat(), port: fc.nat(), transform: arbTransform }),
  fc.record({ tag: fc.constant('wireTransform' as const), wire: fc.nat(), transform: arbTransform }),
);

/**
 * A random VALID project expressed as a legal command sequence: a load source, receivers each wired from
 * an earlier out-capable node through real ports (sync/async), then a handful of config/SLO/label/group
 * mutations. Every command's preconditions hold by construction, so each dispatch is expected to succeed.
 */
const arbCommands: fc.Arbitrary<Command[]> = fc
  .tuple(
    fc.constantFrom(...SOURCE_TYPES),
    fc.integer({ min: 1, max: 100_000 }), // offered load on the source
    fc.array(arbReceiver, { minLength: 1, maxLength: 6 }),
    fc.array(arbExtra, { maxLength: 8 }),
  )
  .map(([srcType, load, receivers, extras]): Command[] => {
    const cmds: Command[] = [];
    const ids: string[] = ['n0'];
    const typeOf: Record<string, string> = { n0: srcType };
    const outCapable: number[] = [0]; // indices into `ids` that have an out port (eligible parents)
    const wireKeys: Array<{ from: readonly [string, string]; to: readonly [string, string] }> = []; // the wires laid down, for wire-level mutations

    cmds.push({ kind: 'addComponent', id: 'n0', type: srcType, x: 0, y: 0 });
    // `n0` is always a SOURCE_TYPES member (a dedicated source, no in/bi port) — its offered load is the
    // universal `assumedRps` knob (the catalog's historical `throughput`-as-workload preset is gone), so a
    // pre-unification `throughput` override — a LEGACY spelling `document.ts`'s `migrateClientThroughputToAssumedRps`
    // migration folds onto `assumedRps` on load — would make the round-trip non-identity BY DESIGN (the migration is
    // meaning-preserving, LAW 2, but not byte-identical, LAW 1). Use the canonical key so LAW 1 tests today's form.
    cmds.push({ kind: 'setConfig', node: 'n0', key: keys.assumedRps, value: load });

    receivers.forEach((rec, k) => {
      const i = k + 1;
      const id = `n${i}`;
      cmds.push({ kind: 'addComponent', id, type: rec.type, x: i * 40, y: i * 30 });
      const pIdx = outCapable[rec.parent % outCapable.length]!;
      const parentId = ids[pIdx]!;
      const outs = portsOf(typeOf[parentId]!, 'out');
      const ins = portsOf(rec.type, 'in');
      const from = [parentId, outs[rec.fromPort % outs.length]!] as const;
      const to = [id, ins[rec.toPort % ins.length]!] as const;
      cmds.push({ kind: 'connect', from, to, semantics: rec.async ? 'async' : 'sync' });
      wireKeys.push({ from, to });
      ids.push(id);
      typeOf[id] = rec.type;
      if (portsOf(rec.type, 'out').length > 0) outCapable.push(i);
    });

    const groups: string[] = [];
    for (const ex of extras) {
      // A wireTransform is addressed by a WIRE (from/to), not a node — handle it first so we never read a `node`
      // field it does not carry.
      if (ex.tag === 'wireTransform') {
        if (wireKeys.length > 0) {
          const wk = wireKeys[ex.wire % wireKeys.length]!;
          cmds.push({ kind: 'setWireTransform', from: wk.from, to: wk.to, transform: ex.transform });
        }
        continue;
      }
      const node = ids[ex.node % ids.length]!;
      if (ex.tag === 'label') cmds.push({ kind: 'setLabel', id: node, label: ex.text });
      // `node` is `n0` (the unique SOURCE_TYPES member, no in/bi port) or a RECEIVER_TYPES member (has
      // one) — mirror that with the same key split as the initial load above, so a config mutation on the source
      // never re-triggers the legacy-throughput migration and breaks LAW 1's byte-identity for a reason unrelated
      // to what this property actually tests.
      else if (ex.tag === 'config') cmds.push({ kind: 'setConfig', node, key: node === 'n0' ? keys.assumedRps : keys.throughput, value: ex.value });
      else if (ex.tag === 'slo') cmds.push({ kind: 'setSLO', node, key: keys.latency, band: { shape: 'minTargetMax', max: ex.max } });
      else if (ex.tag === 'transform') {
        // Pick a REAL port of the node (any direction) so the override references an existing port name.
        const allPorts = (CATALOG[typeOf[node]!]?.ports ?? []).map((p) => p.name);
        if (allPorts.length > 0) cmds.push({ kind: 'setTransform', node, port: allPorts[ex.port % allPorts.length]!, transform: ex.transform });
      } else if (ex.tag === 'group') {
        const gid = `g${groups.length}`;
        groups.push(gid);
        cmds.push({ kind: 'addGroup', id: gid, label: ex.label, x: 0, y: 0, w: 100, h: 100 });
      } else if (groups.length > 0) {
        cmds.push({ kind: 'assignGroup', node, group: groups[ex.node % groups.length]! });
      }
    }
    return cmds;
  });

/** Drive a fresh Studio through a legal command sequence; assert nothing was rejected. */
function build(cmds: readonly Command[]): Studio {
  const s = new Studio(registry, commonManifests);
  for (const cmd of cmds) {
    const r = s.dispatch(cmd);
    if (!r.ok) throw new Error(`generated command unexpectedly rejected: ${r.error} :: ${JSON.stringify(cmd)}`);
  }
  return s;
}

describe('persistence round-trip (property-based, over random legal projects)', () => {
  it('LAW 1 — round-trip is STABLE and LOSSLESS: re-serialization is byte-identical and the parsed doc deep-equals the original', () => {
    fc.assert(
      fc.property(arbCommands, (cmds) => {
        const doc = build(cmds).project();
        const json1 = serialize(doc);
        const back = deserialize(json1);
        if (!back.ok) return false; // an export we just wrote MUST parse
        // Lossless: the freshly-parsed document (shares no references with `doc`) is structurally equal.
        if (!deepEqual(back.value, doc)) return false;
        // Stable/diffable: serializing the parsed document reproduces the exact same bytes (no reorder/drift).
        return serialize(back.value) === json1;
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('LAW 2 — load preserves MEANING: a reloaded project yields the identical engine evaluation (values + verdicts)', () => {
    fc.assert(
      fc.property(arbCommands, (cmds) => {
        const s = build(cmds);
        const before = fingerprint(s);
        const back = deserialize(serialize(s.project()));
        if (!back.ok) return false;
        s.load(back.value); // open/import the backup
        return fingerprint(s) === before; // no semantic drift across persistence
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('LAW 3 — undo is the EXACT inverse and redo replays: each command, stepped back, restores the precise prior document', () => {
    fc.assert(
      fc.property(arbCommands, (cmds) => {
        const s = new Studio(registry, commonManifests);
        // Serialized snapshots: snaps[0] = empty project, snaps[n] = state after the n-th successful command.
        const snaps: string[] = [serialize(s.project())];
        for (const cmd of cmds) {
          if (s.dispatch(cmd).ok) snaps.push(serialize(s.project()));
        }
        // Unwind: every single undo must land EXACTLY on the previous snapshot, until history is empty.
        for (let i = snaps.length - 1; i >= 1; i--) {
          if (!s.canUndo() || !s.undo()) return false;
          if (serialize(s.project()) !== snaps[i - 1]) return false;
        }
        if (s.canUndo()) return false; // nothing left to undo at the start state
        // Replay: every redo restores the corresponding post-command snapshot.
        for (let i = 1; i < snaps.length; i++) {
          if (!s.redo()) return false;
          if (serialize(s.project()) !== snaps[i]) return false;
        }
        return true;
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('LAW 4 — project-scoped CUSTOM components survive a round-trip and stay placeable after reload', () => {
    fc.assert(
      fc.property(fc.nat(), fc.integer({ min: 1, max: 100_000 }), fc.boolean(), (n, tp, withIn) => {
        const type = `custom.svc${n}`;
        const manifest: Manifest = {
          type,
          ports: withIn
            ? [{ name: 'in', dir: 'in', accepts: ['http'] }, { name: 'out', dir: 'out', speaks: ['http'] }]
            : [{ name: 'out', dir: 'out', speaks: ['http'] }],
          config: [{ key: keys.throughput, value: tp, unit: 'req/s' }],
        };

        const s = new Studio(registry, commonManifests);
        if (!s.dispatch({ kind: 'defineComponent', manifest }).ok) return false;
        if (!s.dispatch({ kind: 'addComponent', id: 'a', type }).ok) return false; // placeable before save

        const back = deserialize(serialize(s.project()));
        if (!back.ok) return false;
        // The custom definition is embedded in the file and survives byte-for-byte (pure DATA, deep-equal).
        const survived = back.value.components.find((c) => c.type === type);
        if (survived === undefined || !deepEqual(survived, manifest)) return false;
        if (!back.value.instances.some((i) => i.type === type)) return false; // its instance persisted too

        s.load(back.value);
        if (!s.componentTypes().includes(type)) return false; // known after reload
        if (!s.dispatch({ kind: 'addComponent', id: 'b', type }).ok) return false; // still placeable
        return s.graph().ok; // and the self-contained project still compiles
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});
