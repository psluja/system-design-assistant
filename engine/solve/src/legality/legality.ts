import ds from 'datascript';
import type { Direction, EdgeId, Graph, PortId, ProtocolId } from '@sda/engine-core';

// @algorithm Datalog protocol legality + "what fits" suggester
// @problem Every edit must instantly answer "is this connection legal?" and "which catalog blocks
//   fit this open port?" over emit/accept protocol sets — the hot relational path behind the canvas.
// @approach DataScript (Datalog) queries over port/edge/compat datoms: illegal edges are computed
//   POSITIVELY (query the compatible set, take the complement) so no Datalog negation is needed;
//   the suggester matches accept/speak sets against the compat relation and ranks exact-protocol
//   matches before cross-protocol ones.
// @complexity Datalog join cost over O(ports + edges + compat facts) datoms per query; suggester
//   linear in catalog port-types after the join.
// @citations Datalog / DataScript query semantics; complement-instead-of-negation is a standard
//   stratification dodge.
// @invariants Domain-agnostic (protocol ids are opaque; compatibility arrives as data); the compat
//   relation is used reflexively as given, never inferred; deterministic ranking (exact first).
// @where-tested engine/solve/src/legality/legality.test.ts

// The relational legality layer. Domain-agnostic: it reasons over ports,
// edges and a PROTOCOL-COMPATIBILITY relation supplied as data — it knows nothing about what the
// protocols mean. DataScript (Datalog, pure JS) is the query engine; this is the hot relational path.

/** A directed protocol compatibility fact: a producer protocol a consumer protocol will accept. */
export interface Compat {
  readonly out: ProtocolId;
  readonly in: ProtocolId;
}

/** An edge wiring two protocol-bearing ports that are NOT compatible. */
export interface IllegalEdge {
  readonly edge: EdgeId;
  readonly from: PortId;
  readonly to: PortId;
  readonly fromProtocol: ProtocolId;
  readonly toProtocol: ProtocolId;
}

/** A catalog port-type the suggester may offer to fill an open port. `accepts` (consumer side) and `speaks`
 *  (producer side) are FULL protocol lists, treated as sets; the first entry is the natural wire protocol
 *  (used only to rank exact matches first). */
export interface Candidate {
  readonly component: string;
  readonly dir: Direction;
  readonly accepts?: readonly ProtocolId[];
  readonly speaks?: readonly ProtocolId[];
}

/** A port-ish thing's natural (display/ranking) protocol: the FIRST entry of the list matching its side. */
const primaryOf = (dir: Direction, accepts: readonly string[] | undefined, speaks: readonly string[] | undefined): string | undefined =>
  dir === 'out' ? (speaks?.[0] ?? accepts?.[0]) : (accepts?.[0] ?? speaks?.[0]);

type Datom = Record<string, unknown>;

// The emit/accept SETS are multi-valued (a port can speak/accept several protocols) ⇒ cardinality-many,
// else DataScript keeps only the last value pushed per entity.
const SCHEMA = {
  ':port/emits': { ':db/cardinality': ':db.cardinality/many' },
  ':port/accepts': { ':db/cardinality': ':db.cardinality/many' },
  ':cand/emits': { ':db/cardinality': ':db.cardinality/many' },
  ':cand/accepts': { ':db/cardinality': ':db.cardinality/many' },
};

/** Add `compat` facts plus reflexive ones (a protocol always accepts itself) for every protocol seen. */
function pushCompat(tx: Datom[], nextId: () => number, compat: readonly Compat[], protocols: Iterable<string>): void {
  const seen = new Set<string>();
  const add = (out: string, inn: string): void => {
    const k = `${out}\x00${inn}`;
    if (seen.has(k)) return;
    seen.add(k);
    tx.push({ ':db/id': nextId(), ':compat/out': out, ':compat/in': inn });
  };
  for (const c of compat) add(c.out, c.in);
  for (const p of protocols) add(p, p);
}

function loadGraphDb(graph: Graph, compat: readonly Compat[]): unknown {
  const tx: Datom[] = [];
  let id = 0;
  const nextId = (): number => --id;
  const protocols = new Set<string>();
  for (const p of graph.ports.values()) {
    const eid = nextId();
    const row: Datom = { ':db/id': eid, ':port/id': p.id, ':port/dir': p.dir, ':port/node': p.node };
    const primary = primaryOf(p.dir, p.accepts, p.speaks);
    if (primary !== undefined) {
      row[':port/protocol'] = primary; // the natural protocol — reported in IllegalEdge, never used for matching
      for (const a of p.speaks ?? []) { tx.push({ ':db/id': eid, ':port/emits': a }); protocols.add(a); }
      for (const a of p.accepts ?? []) { tx.push({ ':db/id': eid, ':port/accepts': a }); protocols.add(a); }
    }
    tx.push(row);
  }
  for (const e of graph.edges.values()) tx.push({ ':db/id': nextId(), ':edge/id': e.id, ':edge/from': e.from, ':edge/to': e.to });
  pushCompat(tx, nextId, compat, protocols);
  return ds.db_with(ds.empty_db(SCHEMA), tx);
}

const WITH_PROTOCOLS = `[:find ?eid ?fp ?tp ?pf ?pt
   :where
   [?e ":edge/id" ?eid] [?e ":edge/from" ?fp] [?e ":edge/to" ?tp]
   [?fe ":port/id" ?fp] [?fe ":port/protocol" ?pf]
   [?te ":port/id" ?tp] [?te ":port/protocol" ?pt]]`;

// An edge is legal when SOME protocol the producer emits (own + speaks) reaches SOME protocol the consumer
// accepts (own + accepts). Both sides are sets, so this is an existential match over the two.
const COMPATIBLE = `[:find ?eid
   :where
   [?e ":edge/id" ?eid] [?e ":edge/from" ?fp] [?e ":edge/to" ?tp]
   [?fe ":port/id" ?fp] [?fe ":port/emits" ?pf]
   [?te ":port/id" ?tp] [?te ":port/accepts" ?pt]
   [?c ":compat/out" ?pf] [?c ":compat/in" ?pt]]`;

/**
 * Every edge whose two ports declare protocols that are not compatible. Ports without a protocol are
 * skipped (honest: legality there is "not checked", not "legal"). Computed positively — the set of
 * compatible edges, then the complement — so it needs no Datalog negation.
 */
export function illegalEdges(graph: Graph, compat: readonly Compat[]): IllegalEdge[] {
  const db = loadGraphDb(graph, compat);
  const withProto = ds.q(WITH_PROTOCOLS, db) as Array<[string, string, string, string, string]>;
  const legal = new Set((ds.q(COMPATIBLE, db) as Array<[string]>).map((r) => r[0]));
  return withProto
    .filter(([eid]) => !legal.has(eid))
    .map(([eid, fp, tp, pf, pt]) => ({
      edge: eid as EdgeId,
      from: fp as PortId,
      to: tp as PortId,
      fromProtocol: pf as ProtocolId,
      toProtocol: pt as ProtocolId,
    }))
    .sort((a, b) => (a.edge < b.edge ? -1 : a.edge > b.edge ? 1 : 0));
}

/**
 * The "what fits" suggester: catalog port-types that could legally attach to an open port. An open IN
 * (consumer) port admits producer (OUT) candidates whose protocol it accepts; an open OUT admits
 * consumer (IN) candidates; a `bi` port admits both. Deterministic order.
 */
export function whatFits(graph: Graph, openPort: PortId, catalog: readonly Candidate[], compat: readonly Compat[]): Candidate[] {
  const port = graph.ports.get(openPort);
  if (port === undefined || primaryOf(port.dir, port.accepts, port.speaks) === undefined) return [];

  const openEmits = port.speaks ?? [];
  const openAccepts = port.accepts ?? [];
  const tx: Datom[] = [];
  let id = 0;
  const nextId = (): number => --id;
  const protocols = new Set<string>([...openEmits, ...openAccepts]);
  catalog.forEach((cand, i) => {
    const eid = nextId();
    tx.push({ ':db/id': eid, ':cand/i': i, ':cand/dir': cand.dir });
    for (const a of cand.speaks ?? []) { tx.push({ ':db/id': eid, ':cand/emits': a }); protocols.add(a); }
    for (const a of cand.accepts ?? []) { tx.push({ ':db/id': eid, ':cand/accepts': a }); protocols.add(a); }
  });
  pushCompat(tx, nextId, compat, protocols);
  const db = ds.db_with(ds.empty_db(SCHEMA), tx);

  // open IN  → candidate is the producer (OUT): some protocol it emits reaches one the open port accepts.
  // open OUT → candidate is the consumer (IN):  some protocol the open port emits reaches one it accepts.
  const wantOut = port.dir === 'in' || port.dir === 'bi';
  const wantIn = port.dir === 'out' || port.dir === 'bi';
  const picked = new Set<number>();
  if (wantOut) {
    const rows = ds.q(
      `[:find ?i :in $ [?pt ...] :where [?x ":cand/i" ?i] [?x ":cand/dir" "out"] [?x ":cand/emits" ?proto] [?c ":compat/out" ?proto] [?c ":compat/in" ?pt]]`,
      db,
      openAccepts,
    ) as Array<[number]>;
    for (const [i] of rows) picked.add(i);
  }
  if (wantIn) {
    const rows = ds.q(
      `[:find ?i :in $ [?pf ...] :where [?x ":cand/i" ?i] [?x ":cand/dir" "in"] [?x ":cand/accepts" ?proto] [?c ":compat/out" ?pf] [?c ":compat/in" ?proto]]`,
      db,
      openEmits,
    ) as Array<[number]>;
    for (const [i] of rows) picked.add(i);
  }
  // Rank the most RELEVANT first: a candidate whose NATURAL protocol (first of its list) exactly matches the
  // open port's natural protocol (a redis cache for a redis port) before one that only fits via the rest of
  // its set or a cross-protocol compat (a worker that also consumes redis). Ties keep catalog order.
  const openPrimary = primaryOf(port.dir, port.accepts, port.speaks);
  const exact = (i: number): number => {
    const c = catalog[i] as Candidate;
    return primaryOf(c.dir, c.accepts, c.speaks) === openPrimary ? 0 : 1;
  };
  return [...picked].sort((a, b) => exact(a) - exact(b) || a - b).map((i) => catalog[i] as Candidate);
}

/**
 * Pure protocol compatibility — the SAME rule the DataScript `COMPATIBLE` query encodes, for callers that
 * reason over manifest ports directly (the canvas drag-check, the suggester's port picker, synthesis): does
 * SOME protocol the producer EMITS (own + speaks) reach SOME the consumer ACCEPTS (own + accepts), under
 * reflexivity + the cross-protocol `compat` table. ONE predicate so legality, the suggester and synthesis can
 * never disagree on "can these connect".
 */
export function portsConnect(emits: readonly string[], accepts: readonly string[], compat: readonly Compat[]): boolean {
  const reaches = (out: string, inn: string): boolean => out === inn || compat.some((c) => c.out === out && c.in === inn);
  return emits.some((e) => accepts.some((a) => reaches(e, a)));
}

