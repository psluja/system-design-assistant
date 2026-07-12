// @algorithm Graph-to-cell-network projection (PS split, class slicing, topological cell order)
// @problem Compile a typed-property graph plus registry algebra into the flat cell system the
//   fixpoint solver computes — including multi-commodity request classes contending for one node's
//   finite capacity — while keeping the solve fast and per-class flows honest.
// @approach Emit inflow/outflow/local/served expressions per (node, key, class); shared capacity is
//   divided by the processor-sharing split served = offered * cap / max(totalOffered, cap); each
//   class's wire membership is checked acyclic by a colored (white/gray/black) DFS; cells are emitted
//   in dependency-first topological order via iterative DFS post-order (cycle back-edges skipped) so
//   Gauss-Seidel settles a DAG in ONE sweep.
// @complexity O(cells + refs) for the build and the topological sort; the ordering turns an acyclic
//   solve from O(cells^2) into O(cells).
// @citations Processor-sharing discipline (Kleinrock 1967); Tarjan-style iterative DFS ordering;
//   multi-commodity flow framing (standard).
// @invariants No classes => byte-for-byte the single-class build (property-pinned); one class over
//   all wires collapses the PS split to min(cap, offered) exactly; cyclic class membership is
//   rejected with a deterministic witness cycle, never solved wrongly.
// @where-tested engine/solve/src/network/build.test.ts, engine/solve/src/network/build.class.test.ts,
//   engine/solve/src/network/transform.test.ts, engine/solve/src/network/generator.test.ts

import { assertNever, type Aggregation, type ClassId, type EdgeId, type Graph, type Key, type NodeId, type Port, type PortId, type Registry, type Result, type Transform } from '@sda/engine-core';
import { parse, type Expr } from '../relation';
import type { Cell, CellId } from '../fixpoint';

/**
 * Per-(node,key) structural metadata, kept so the verdict layer can ATTRIBUTE a value back to its
 * binding cause without re-deriving the topology (the relation/config local contribution, the
 * upstream contributors after async-cut, and the key's algebra). Engine-internal, like the cells.
 */
export interface CellMeta {
  readonly out: CellId;
  readonly input: CellId;
  /** The node's own contribution expression (a relation, or a ref to its config), or null if none. */
  readonly local: Expr<CellId> | null;
  readonly localKind: 'relation' | 'config' | 'none';
  /** Upstream nodes whose `out(·,key)` feeds this key here, after async edges are cut. */
  readonly contributors: readonly NodeId[];
  readonly series: Aggregation['series'];
}

/**
 * A REQUEST CLASS as the network builder consumes it: a named flow (a commodity)
 * with its own acyclic wire membership over a shared, possibly cyclic, topology, and its own per-node origins
 * (the rate it injects into the flow key). Opaque to the engine — the meaning of "order" / "report" is content.
 *
 * Passing NO classes (the default) is the single implicit class over every wire: the build output is BYTE-FOR-BYTE
 * today's, property-pinned by the equivalence test. Declaring classes indexes the FLOW cells by class and splits a
 * shared node's finite capacity across the classes that contend at it (processor-sharing, §4.1); non-flow folds
 * (latency/availability/cost) also run per class so a downstream quantity follows the class's own path (§4.2). One
 * class over the whole drawing reduces to the single river exactly (the PS split collapses to `min(cap, offered)`).
 */
export interface RequestClass {
  readonly id: ClassId;
  /** The edges this class traverses — its membership E_C. Must form an ACYCLIC subgraph even where the whole
   *  drawing is a mesh; a cyclic commodity is a build error naming the class and its cycle (§4.2). */
  readonly edges: readonly EdgeId[];
  /** Where THIS class injects load into the flow key(s): a per-node injected rate (its own origin), per §3. */
  readonly origins: readonly { readonly node: NodeId; readonly rps: number }[];
}

/**
 * The cell-network: the graph projected into a flat cell system the fixpoint solver computes, plus an
 * accessor for the per-node output of a key. This is engine-internal; component authors
 * never see it — they only write relations over key names.
 *
 * Model (implicit ref resolution):
 *   in(N,K)  = aggregate over incoming edges of out(M,K), per the key's algebra (async edges cut if
 *              the key's aggregation says so). Empty ⇒ the algebra's identity.
 *   out(N,K) = combine(local(N,K), in(N,K)) with the same algebra, or just in(N,K) (pass-through).
 *   A key ref J inside N's relation resolves to N's config J if it has one, else in(N,J).
 * So `min` gives the bottleneck, `sum` accumulates additive quantities, `product` compounds factors.
 *
 * With request classes declared, a FLOW key's in/out cells gain a class index (`out(N,K,C)`), the shared node
 * contends its capacity across classes (§4.1), and non-flow folds run per class; `out(N,K)` with no class stays
 * the single-river accessor. No classes ⇒ `classes` is empty and every cell is exactly as before.
 */
export interface Network {
  readonly system: ReadonlyMap<CellId, Cell>;
  /** The per-node output of a key. With `cls` (and classes declared) the class's own served value `out(N,K,C)`. */
  out(node: NodeId, key: Key, cls?: ClassId): CellId;
  /** Structural metadata for attribution (cause-chain / remediations). */
  metaOf(node: NodeId, key: Key): CellMeta | undefined;
  /** The declared request-class ids, in declaration order. Empty ⇒ the single implicit class (today). */
  readonly classes: readonly ClassId[];
}

const cfgId = (n: NodeId, k: Key): CellId => `cfg:${n}:${k}`;
const inId = (n: NodeId, k: Key, c?: ClassId): CellId => (c === undefined ? `in:${n}:${k}` : `in:${n}:${k}:${c}`);
const outId = (n: NodeId, k: Key, c?: ClassId): CellId => (c === undefined ? `out:${n}:${k}` : `out:${n}:${k}:${c}`);
const downId = (n: NodeId, k: Key): CellId => `down:${n}:${k}`; // demand pulled by downstream consumers (outflow)
const localId = (n: NodeId, k: Key): CellId => `local:${n}:${k}`; // the node's OWN value (relation/config), before incoming is combined in (self)
// Class-only flow cells: a class's origin injection, its offered load (= inflow + origin),
// the shared node's total offered (the processor-sharing denominator), and the total inflow across classes (what a
// local relation's `inflow(k)` reads — offered load is class-blind capacity math). All absent when no class is declared.
const orgId = (n: NodeId, k: Key, c: ClassId): CellId => `org:${n}:${k}:${c}`;
const offId = (n: NodeId, k: Key, c: ClassId): CellId => `off:${n}:${k}:${c}`;
const totId = (n: NodeId, k: Key): CellId => `tot:${n}:${k}`;
const tinId = (n: NodeId, k: Key): CellId => `tin:${n}:${k}`;
// A generator port's SOURCE TERM for a flow key: the level a `generate` port originates,
// materialised as an input cell so every projection (JS fixpoint, MiniZinc, GPU) folds the same constant.
const genId = (p: PortId, k: Key): CellId => `gen:${p}:${k}`;
const ref = (id: CellId): Expr<CellId> => ({ kind: 'ref', key: id });

function identity(series: Aggregation['series']): number {
  switch (series) {
    case 'sum':
      return 0;
    case 'product':
      return 1;
    case 'min':
      return Infinity;
    case 'max':
      return -Infinity;
  }
}

/** Fold a list of contribution exprs with the key's algebra; empty ⇒ identity. */
function aggregateExpr(series: Aggregation['series'], refs: readonly Expr<CellId>[]): Expr<CellId> {
  if (refs.length === 0) return { kind: 'num', value: identity(series) };
  switch (series) {
    case 'min':
      return { kind: 'call', fn: 'min', args: refs };
    case 'max':
      return { kind: 'call', fn: 'max', args: refs };
    case 'sum':
      return refs.reduce((a, b) => ({ kind: 'binary', op: '+', left: a, right: b }));
    case 'product':
      return refs.reduce((a, b) => ({ kind: 'binary', op: '*', left: a, right: b }));
  }
}

/**
 * Apply a port's transfer function to a value EXPRESSION, as pure arithmetic.
 * This is the SYMBOLIC twin of engine-core's scalar `applyTransform`: the two encode the SAME semantics — one as
 * a fixpoint expression (so the JS hot path and the MiniZinc emitter both project it identically), the other as a
 * plain number (so presenters can label the wire without re-deriving engine math). Keep them term-for-term in step;
 * the JS↔MZN differential test pins that the expression form matches the scalar. `undefined` (no transform) is
 * identity — the expression is returned untouched, so a transform-free graph projects bit-for-bit as before.
 */
function transformExpr(t: Transform | undefined, x: Expr<CellId>): Expr<CellId> {
  if (t === undefined) return x;
  switch (t.kind) {
    case 'ratio': // out = value · x
    case 'prob': // scalar mean = value · x (the DES draws a per-job Bernoulli; the mean matches this)
      return { kind: 'binary', op: '*', left: x, right: { kind: 'num', value: t.value } };
    case 'batch': // out = x / value  (n : 1 aggregation)
      return { kind: 'binary', op: '/', left: x, right: { kind: 'num', value: t.value } };
    case 'cap': // out = min(x, value)  (a steady-state throttle; the excess lands in overflow)
      return { kind: 'call', fn: 'min', args: [x, { kind: 'num', value: t.value }] };
    case 'window': // out = min(x, 1000/value)  (time-window flush every `value` ms)
      return { kind: 'call', fn: 'min', args: [x, { kind: 'num', value: 1000 / t.value }] };
    case 'generate': // identity at the edge seam: a generator ORIGINATES flow at its NODE —
      // the level enters the node's served out-cell as a SOURCE TERM (see the generator fold below), so the value
      // crossing a generate port is already the node's emission. Mirrors engine-core's scalar `applyTransform`.
      return x;
  }
}

/** Combine a node's local contribution with its inbound value, per the key's algebra. */
function combineExpr(series: Aggregation['series'], a: Expr<CellId>, b: Expr<CellId>): Expr<CellId> {
  switch (series) {
    case 'sum':
      return { kind: 'binary', op: '+', left: a, right: b };
    case 'product':
      return { kind: 'binary', op: '*', left: a, right: b };
    case 'min':
      return { kind: 'call', fn: 'min', args: [a, b] };
    case 'max':
      return { kind: 'call', fn: 'max', args: [a, b] };
  }
}

/**
 * The processor-sharing split of a shared node's finite capacity across the classes that contend at it
 *: `served(N,K,C) = offered(N,K,C) · capacity / max(totalOffered, capacity)`.
 * Under headroom (total ≤ cap) the denominator is `capacity`, so the factor is 1 and served = offered —
 * separable and exact, the regime the search's ρ-headroom keeps every design in. Saturated (total > cap) the
 * denominator is `total`, so served = offered · cap/total (proportional; Σ_C served = capacity). Division-safe
 * for capacity > 0. With ONE class total = offered, so it reduces to `min(capacity, offered)` — bit-for-bit the
 * single-river `out = min(local, in)`.
 */
function psSplit(offered: Expr<CellId>, capacity: CellId, total: CellId): Expr<CellId> {
  return {
    kind: 'binary',
    op: '/',
    left: { kind: 'binary', op: '*', left: offered, right: ref(capacity) },
    right: { kind: 'call', fn: 'max', args: [ref(total), ref(capacity)] },
  };
}

/** Rewrite a relation's key refs to concrete cell-ids; unresolved keys collect an error. */
function rewrite(e: Expr<Key>, resolve: (key: Key, inflow: boolean, outflow: boolean, self: boolean) => CellId | null, errs: string[]): Expr<CellId> {
  switch (e.kind) {
    case 'num':
      return e;
    case 'ref': {
      const id = resolve(e.key, e.inflow ?? false, e.outflow ?? false, e.self ?? false);
      if (id === null) {
        errs.push(`unknown key "${String(e.key)}"`);
        return { kind: 'num', value: 0 }; // placeholder; the caller rejects the build because errs is non-empty
      }
      return ref(id);
    }
    case 'neg':
      return { kind: 'neg', arg: rewrite(e.arg, resolve, errs) };
    case 'binary':
      return { kind: 'binary', op: e.op, left: rewrite(e.left, resolve, errs), right: rewrite(e.right, resolve, errs) };
    case 'call':
      return { kind: 'call', fn: e.fn, args: e.args.map((a) => rewrite(a, resolve, errs)) };
    case 'compare':
      return { kind: 'compare', op: e.op, left: rewrite(e.left, resolve, errs), right: rewrite(e.right, resolve, errs) };
  }
}

/** Collect the cell-ids a cell expression references. */
function refsOf(e: Expr<CellId>, out: Set<CellId>): void {
  switch (e.kind) {
    case 'num':
      return;
    case 'ref':
      out.add(e.key);
      return;
    case 'neg':
      refsOf(e.arg, out);
      return;
    case 'binary':
      refsOf(e.left, out);
      refsOf(e.right, out);
      return;
    case 'call':
      for (const a of e.args) refsOf(a, out);
      return;
    case 'compare':
      refsOf(e.left, out);
      refsOf(e.right, out);
      return;
    default:
      return assertNever(e);
  }
}

/** Collect the keys referenced via `outflow(key)` (so we only build downstream-demand cells for those). */
function outflowKeysOf(e: Expr, out: Set<Key>): void {
  switch (e.kind) {
    case 'num':
      return;
    case 'ref':
      if (e.outflow === true) out.add(e.key);
      return;
    case 'neg':
      outflowKeysOf(e.arg, out);
      return;
    case 'binary':
      outflowKeysOf(e.left, out);
      outflowKeysOf(e.right, out);
      return;
    case 'call':
      for (const a of e.args) outflowKeysOf(a, out);
      return;
    case 'compare':
      outflowKeysOf(e.left, out);
      outflowKeysOf(e.right, out);
      return;
    default:
      return assertNever(e);
  }
}

/**
 * Find a cycle in ONE class's edge subgraph, or null if it is acyclic. A class's own
 * path must be acyclic even where the whole drawing is a mesh — a synchronous self-wait (A→B→A within one class)
 * has no finite response and is refused, honestly, naming the offending cycle. Deterministic (nodes explored in
 * id order) so the reported cycle is stable. Only the class's OWN edges are traversed, so the mesh — two classes
 * each carving an acyclic slice — passes even though the union is cyclic.
 */
function findClassCycle(classEdges: readonly EdgeId[], graph: Graph): NodeId[] | null {
  const adj = new Map<NodeId, NodeId[]>();
  const nodes = new Set<NodeId>();
  for (const eid of classEdges) {
    const e = graph.edges.get(eid);
    if (e === undefined) continue; // unknown edge id — reported separately; skip here
    const from = graph.ports.get(e.from);
    const to = graph.ports.get(e.to);
    if (from === undefined || to === undefined) continue;
    nodes.add(from.node);
    nodes.add(to.node);
    const list = adj.get(from.node);
    if (list === undefined) adj.set(from.node, [to.node]);
    else list.push(to.node);
  }
  const color = new Map<NodeId, 0 | 1 | 2>(); // 0 white, 1 on-path (gray), 2 done (black)
  const onPath: NodeId[] = [];
  let cycle: NodeId[] | null = null;
  const dfs = (u: NodeId): void => {
    color.set(u, 1);
    onPath.push(u);
    for (const v of [...(adj.get(u) ?? [])].sort()) {
      if (cycle !== null) break;
      const c = color.get(v) ?? 0;
      if (c === 1) {
        const idx = onPath.indexOf(v);
        cycle = [...onPath.slice(idx), v]; // v … u … v — the back-edge closes it
        break;
      }
      if (c === 0) dfs(v);
    }
    onPath.pop();
    color.set(u, 2);
  };
  for (const n of [...nodes].sort()) {
    if (cycle !== null) break;
    if ((color.get(n) ?? 0) === 0) dfs(n);
  }
  return cycle;
}

export function buildNetwork(graph: Graph, registry: Registry, classes?: readonly RequestClass[]): Result<Network, readonly string[]> {
  const errors: string[] = [];

  // incoming adjacency (downstream node ← upstream node, with edge semantics) + outgoing (for `outflow`).
  // Each incoming edge ALSO carries the FLOW transforms at its two ends — the source OUT-port's f_out and the
  // TARGET IN-port (identified so contributions can be summed per in-port before that port's f_in is applied).
  // These are inert for non-flow keys; only the flow-key inflow assembly reads them. `edge` is kept so a request
  // class can restrict the fold to its OWN wires (per-class inflow folds over E_C only).
  interface InEdge {
    readonly edge: EdgeId;
    readonly up: NodeId;
    readonly semantics: 'sync' | 'async';
    readonly fOut: Transform | undefined; // the OUT-side transform for THIS edge: wire override > source port default (see below)
    readonly toPort: string; // the target in-port id (contributions group by it, then f_in applies per port)
    readonly fIn: Transform | undefined; // the target in-port's transform (consumption shaping)
  }
  const incoming = new Map<NodeId, InEdge[]>();
  const outgoing = new Map<NodeId, NodeId[]>();
  for (const id of graph.nodes.keys()) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const edge of graph.edges.values()) {
    const from = graph.ports.get(edge.from);
    const to = graph.ports.get(edge.to);
    if (from === undefined || to === undefined) {
      errors.push(`edge ${String(edge.id)}: unknown port`);
      continue;
    }
    // RESOLUTION ORDER for the OUT-side: the WIRE's own transform WINS over the
    // source out-port's, so ONE out port can feed several edges with DIFFERENT shares (a 70/30 routing split the
    // per-port transform cannot express). Absent wire transform ⇒ the port's f_out — today's broadcast, bit for bit.
    incoming.get(to.node)?.push({ edge: edge.id, up: from.node, semantics: edge.semantics, fOut: edge.transform ?? from.transform, toPort: String(edge.to), fIn: to.transform });
    outgoing.get(from.node)?.push(to.node);
  }

  // Request classes: validate membership + origins, and enforce per-class acyclicity.
  // Absent ⇒ hasClasses is false and the whole per-class machinery below is inert (the single implicit river).
  const declaredClasses = classes ?? [];
  const hasClasses = declaredClasses.length > 0;
  const classIds: ClassId[] = [];
  const membership = new Map<ClassId, Set<EdgeId>>();
  const originsByClass = new Map<ClassId, Map<NodeId, number>>();
  if (hasClasses) {
    const seen = new Set<ClassId>();
    for (const rc of declaredClasses) {
      if (seen.has(rc.id)) {
        errors.push(`duplicate request class "${String(rc.id)}"`);
        continue;
      }
      seen.add(rc.id);
      classIds.push(rc.id);
      const edgeSet = new Set<EdgeId>();
      for (const eid of rc.edges) {
        if (!graph.edges.has(eid)) errors.push(`class "${String(rc.id)}": unknown edge "${String(eid)}"`);
        else edgeSet.add(eid);
      }
      membership.set(rc.id, edgeSet);
      const originMap = new Map<NodeId, number>();
      for (const o of rc.origins) {
        if (!graph.nodes.has(o.node)) errors.push(`class "${String(rc.id)}": unknown origin node "${String(o.node)}"`);
        else originMap.set(o.node, o.rps);
      }
      originsByClass.set(rc.id, originMap);
      const cyc = findClassCycle(rc.edges, graph);
      if (cyc !== null) errors.push(`class "${String(rc.id)}": cyclic membership ${cyc.map((n) => String(n)).join(' → ')} — a request class must be acyclic`);
    }
  }

  // declared keys, config (fixed input) values, parsed derived relations
  const keysInPlay = new Set<Key>();
  const configVal = new Map<string, number>(); // cfgId -> value
  const derivedExpr = new Map<string, Expr>(); // `${node}|${key}` -> parsed relation
  const hasConfig = (n: NodeId, k: Key): boolean => configVal.has(cfgId(n, k));

  for (const node of graph.nodes.values()) {
    for (const cell of node.cells) {
      keysInPlay.add(cell.key);
      if (cell.kind === 'input') {
        if (cell.value.kind === 'fixed') configVal.set(cfgId(node.id, cell.key), cell.value.quantity.value);
        // band inputs are SLO targets (verdicts), not flow values — ignored here.
      } else {
        const parsed = parse(cell.relation.expr);
        if (!parsed.ok) errors.push(`node ${String(node.id)} key ${String(cell.key)}: ${parsed.error}`);
        else derivedExpr.set(`${node.id}|${cell.key}`, parsed.value);
      }
    }
  }

  // keys read via outflow(key) ⇒ we materialise a downstream-demand cell (down:N:K) for them
  const outflowKeys = new Set<Key>();
  for (const ex of derivedExpr.values()) outflowKeysOf(ex, outflowKeys);

  // each key in play needs a registry definition (for its algebra)
  const aggOf = new Map<Key, Aggregation>();
  for (const k of keysInPlay) {
    const def = registry.get(k);
    if (def === undefined) errors.push(`key "${String(k)}" not in registry`);
    else aggOf.set(k, def.aggregate);
  }

  if (errors.length > 0) return { ok: false, error: errors };

  // A NODE-LOCAL key (aggregate.local) does not flow across edges — there is no in/down cell for it and any
  // reference to it is the node's own local value (see the per-key loop and `resolve`).
  const isLocalOnly = (j: Key): boolean => aggOf.get(j)?.local === true;

  // Assemble a FLOW key's inflow with its port transforms (the edge-contribution seam). Per incoming edge the
  // contribution is f_out applied to the upstream's served value; contributions group by TARGET in-port; each
  // in-port's f_in applies to that port's fan-in sum; the node inflow is the fan-in across ports. Grouping by
  // in-port is what makes f_in a per-PORT function: it transforms the WHOLE stream arriving at that port, not
  // each source separately. Empty ⇒ the fan-in identity, so a node with no inbound edge is unchanged. `upOut`
  // yields the upstream served-value expression — `out(up,k)` for the single river, `out(up,k,C)` per class.
  const flowInflow = (fanIn: Aggregation['series'], ups: readonly InEdge[], upOut: (up: NodeId) => Expr<CellId>): Expr<CellId> => {
    const byPort = new Map<string, InEdge[]>();
    for (const u of ups) {
      const group = byPort.get(u.toPort);
      if (group === undefined) byPort.set(u.toPort, [u]);
      else group.push(u);
    }
    const portIntakes: Expr<CellId>[] = [];
    for (const [, edges] of byPort) {
      const contributions = edges.map((e) => transformExpr(e.fOut, upOut(e.up))); // f_out(served_up) per edge
      const portSum = aggregateExpr(fanIn, contributions); // this in-port's fan-in of its contributions
      portIntakes.push(transformExpr(edges[0]?.fIn, portSum)); // f_in applies to the port's whole intake
    }
    return aggregateExpr(fanIn, portIntakes);
  };

  const system = new Map<CellId, Cell>();
  const meta = new Map<string, CellMeta>();
  for (const node of graph.nodes.values()) {
    const n = node.id;
    // THE GENERATOR PORTS: out/bi ports of THIS node carrying `generate` with a level > 0
    // (level 0 = declared-but-silent, exactly like an inert origin — the whole feature stays a no-op). A generator
    // ORIGINATES flow at its node: generated flow consumes the host's own capacity and the served share exits the
    // port ("a cron eats its host"), so the fold happens at the NODE's out cell for each FLOW key — never at the
    // edge seam (transformExpr(generate) is the identity) and never in the in-cell (`inflow(k)` stays pure
    // through-flow, so a relation's universal overflow `offered − served` reads inflow + its own origin term
    // without double counting). A graph with no generate port anywhere is bit-for-bit as before.
    const genPorts: Port[] = [];
    for (const pid of node.ports) {
      const p = graph.ports.get(pid);
      if (p !== undefined && p.dir !== 'in' && p.transform?.kind === 'generate' && p.transform.level > 0) genPorts.push(p);
    }
    // `inflow(j)` resolves to the value arriving from upstream (in:N:j) — the demand OFFERED to N, before
    // it clamps to capacity. `outflow(j)` ⇒ down:N:j (demand pulled by downstream consumers). `self(j)` ⇒
    // local:N:j (N's OWN value for j — its relation/config, e.g. capacity — independent of incoming), which
    // is how a relation reads another of its node's derived values. A plain ref ⇒ own config, else incoming.
    // With classes, `inflow(j)` reads the TOTAL inflow across classes (tin:N:j) — a local relation's capacity
    // math is class-blind (§4.1); the per-class in cells feed the offered/split, not the node's own relation.
    const hasLocal = (j: Key): boolean => hasConfig(n, j) || derivedExpr.has(`${n}|${j}`);
    const inflowCell = (j: Key): CellId => (hasClasses ? tinId(n, j) : inId(n, j));
    const resolve = (j: Key, inflow: boolean, outflow: boolean, self: boolean): CellId | null =>
      self || isLocalOnly(j) // self(), or ANY read of a node-local key, is the node's own local value
        ? hasLocal(j)
          ? localId(n, j)
          : null
        : outflow
          ? keysInPlay.has(j)
            ? downId(n, j)
            : null
          : inflow
            ? keysInPlay.has(j)
              ? inflowCell(j)
              : null
            : hasConfig(n, j)
              ? cfgId(n, j)
              : keysInPlay.has(j)
                ? inflowCell(j)
                : null;

    for (const k of keysInPlay) {
      const agg = aggOf.get(k) as Aggregation;
      const series = agg.series;
      const localOnly = agg.local === true;
      const fanIn = agg.fanIn ?? series;
      const isFlow = agg.flow === true;

      if (hasConfig(n, k)) system.set(cfgId(n, k), { kind: 'input', value: configVal.get(cfgId(n, k)) as number });

      const ups = (incoming.get(n) ?? []).filter((u) => !(agg.onAsyncEdge === 'cut' && u.semantics === 'async'));

      // The node's OWN value (its relation/config) — SHARED across classes (one physical node, one service time /
      // capacity in R1). Materialised as a cell so `self(k)` reads it and `out = local ⊕ incoming` references it.
      let local: Expr<CellId> | null = null;
      const dkey = `${n}|${k}`;
      const declared = derivedExpr.get(dkey);
      if (declared !== undefined) local = rewrite(declared, resolve, errors);
      else if (hasConfig(n, k)) local = ref(cfgId(n, k));
      if (local !== null) system.set(localId(n, k), { kind: 'derived', expr: local });

      if (localOnly) {
        // A node-local key does not flow across edges ⇒ no fan-in and no per-class index. out = the node's local
        // value alone; with NO local definition the node has no out cell (value()/MiniZinc report it absent).
        if (local !== null) system.set(outId(n, k), { kind: 'derived', expr: ref(localId(n, k)) });
      } else if (!hasClasses) {
        // ── THE SINGLE IMPLICIT CLASS (today, BIT-FOR-BIT) ──
        // THE EDGE-CONTRIBUTION SEAM. For a plain (non-flow) key the inflow is the fan-in aggregate of each
        // upstream's served value. For a FLOW key the port TRANSFORMS act here (f_out/f_in). Empty ⇒ identity.
        const inflowExpr = isFlow ? flowInflow(fanIn, ups, (up) => ref(outId(up, k))) : aggregateExpr(fanIn, ups.map((u) => ref(outId(u.up, k))));
        system.set(inId(n, k), { kind: 'derived', expr: inflowExpr });
        // demand a node's consumers pull from it = SUM of downstream out(·,k) (total downstream demand).
        if (outflowKeys.has(k)) system.set(downId(n, k), { kind: 'derived', expr: aggregateExpr('sum', (outgoing.get(n) ?? []).map((d) => ref(outId(d, k)))) });
        // THE GENERATOR SOURCE TERM — flow keys only, and only where a generator port sits:
        //  • RELATION-local: the node's own relation OWNS the emission. `out = local` — the through-flow bound
        //    `out ≤ in` no longer applies because the node originates flow of its own; the relation reads
        //    `inflow(k)` and its origin cells, so it IS "through-flow + served level, capacity-gated" (this is
        //    exactly what content's origin lowering authors: min(capacity, inflow + origin)).
        //  • CONFIG-local: the config is a bare capacity, so the engine supplies the arithmetic — the offered
        //    flow is the fan-in of through-flow AND the generator levels (materialised as gen: input cells), and
        //    the key's own algebra gates it (min-series ⇒ served = min(capacity, in + Σ levels)).
        //  • NO local: nothing gates ⇒ out = through-flow ⊕ Σ levels (a pure origin with no declared ceiling).
        // No generator ⇒ the exact expressions of today, bit for bit.
        const gens = isFlow ? genPorts : [];
        const offeredExpr = (): Expr<CellId> => {
          for (const gp of gens) system.set(genId(gp.id, k), { kind: 'input', value: (gp.transform as Extract<Transform, { kind: 'generate' }>).level });
          return aggregateExpr(fanIn, [ref(inId(n, k)), ...gens.map((gp) => ref(genId(gp.id, k)))]);
        };
        // out = local combined with the incoming — BUT a node with no incoming is just its local value (so a
        // SOURCE isn't zeroed by a sum fan-in identity of 0). Behaviour-preserving where fanIn === series.
        const outExpr: Expr<CellId> =
          local !== null
            ? gens.length > 0
              ? declared !== undefined
                ? ref(localId(n, k)) // relation-local generator: the relation owns the emission (see above)
                : combineExpr(series, ref(localId(n, k)), offeredExpr()) // config-local: capacity gates in ⊕ levels
              : ups.length > 0
                ? combineExpr(series, ref(localId(n, k)), ref(inId(n, k)))
                : ref(localId(n, k))
            : gens.length > 0
              ? offeredExpr()
              : ref(inId(n, k));
        system.set(outId(n, k), { kind: 'derived', expr: outExpr });
      } else {
        // ── PER-CLASS FLOW CELLS ──
        // Each class folds its inflow over its OWN wires E_C; the shared node contends its capacity across classes.
        // GENERATOR ports are INERT here: under declared classes the per-class ORIGINS are authoritative (the org:
        // cells below) — exactly the class-blind-origin semantics content already gives `assumedRps` under classes.
        // A generator's per-class share is a later load-curves round; declaring both today means the classes win.
        for (const c of classIds) {
          const upsC = ups.filter((u) => membership.get(c)?.has(u.edge) === true);
          const inflowExpr = isFlow ? flowInflow(fanIn, upsC, (up) => ref(outId(up, k, c))) : aggregateExpr(fanIn, upsC.map((u) => ref(outId(u.up, k, c))));
          system.set(inId(n, k, c), { kind: 'derived', expr: inflowExpr });
          if (isFlow) {
            // offered(N,K,C) = inflow(N,K,C) + origin(N,C) — this class's arrivals at N.
            const rps = originsByClass.get(c)?.get(n);
            let offered: Expr<CellId>;
            if (rps !== undefined) {
              system.set(orgId(n, k, c), { kind: 'input', value: rps });
              offered = { kind: 'binary', op: '+', left: ref(inId(n, k, c)), right: ref(orgId(n, k, c)) };
            } else {
              offered = ref(inId(n, k, c));
            }
            system.set(offId(n, k, c), { kind: 'derived', expr: offered });
          }
        }
        // total inflow across classes — what a local relation's `inflow(k)`/bare ref reads (class-blind capacity math).
        system.set(tinId(n, k), { kind: 'derived', expr: aggregateExpr('sum', classIds.map((c) => ref(inId(n, k, c)))) });
        if (isFlow) {
          // totalOffered(N,K) = Σ_C offered(N,K,C): all classes queue at the SAME servers (the PS denominator).
          system.set(totId(n, k), { kind: 'derived', expr: aggregateExpr('sum', classIds.map((c) => ref(offId(n, k, c)))) });
          for (const c of classIds) {
            // served(N,K,C) = the processor-sharing split when the node has a capacity; with none, a pass-through
            // (nothing to contend) so served = offered. One class ⇒ this reduces to min(capacity, offered).
            const off = ref(offId(n, k, c));
            system.set(outId(n, k, c), { kind: 'derived', expr: local !== null ? psSplit(off, localId(n, k), totId(n, k)) : off });
          }
          // The class-blind node TOTAL served — Σ_C served(N,K,C). The UNINDEXED accessor `out(N,K)` reads it, so a
          // class-blind consumer (the system roll-up, a total-throughput SLO) still sees the node's true total under
          // classes — the one unambiguous flow aggregate (a per-class latency/cost has no honest class-blind value,
          // so those stay per-class only). Absent classes ⇒ this branch never runs and `out(N,K)` is today's cell.
          system.set(outId(n, k), { kind: 'derived', expr: aggregateExpr('sum', classIds.map((c) => ref(outId(n, k, c)))) });
        } else {
          // Non-flow folds run per class too, so a downstream quantity (cumulative latency, availability, cost)
          // follows the class's own path (§4.2). `local` is shared; a class that does not reach N carries N's own value.
          for (const c of classIds) {
            const upsC = ups.filter((u) => membership.get(c)?.has(u.edge) === true);
            system.set(outId(n, k, c), {
              kind: 'derived',
              expr: local !== null ? (upsC.length > 0 ? combineExpr(series, ref(localId(n, k)), ref(inId(n, k, c))) : ref(localId(n, k))) : ref(inId(n, k, c)),
            });
          }
        }
        // total downstream demand across classes (outflow) — Σ over downstream nodes of Σ_C out(d,k,C).
        if (outflowKeys.has(k)) {
          const terms: Expr<CellId>[] = [];
          for (const d of outgoing.get(n) ?? []) for (const c of classIds) terms.push(ref(outId(d, k, c)));
          system.set(downId(n, k), { kind: 'derived', expr: aggregateExpr('sum', terms) });
        }
      }

      meta.set(dkey, {
        out: outId(n, k),
        input: inId(n, k),
        local,
        localKind: declared !== undefined ? 'relation' : hasConfig(n, k) ? 'config' : 'none',
        contributors: localOnly ? [] : ups.map((u) => u.up),
        series,
      });
    }
  }

  if (errors.length > 0) return { ok: false, error: errors };

  // dependencies-first order ⇒ deterministic AND fast Gauss-Seidel sweeps (one sweep for a DAG)
  const ordered = new Map<CellId, Cell>();
  for (const id of dependencyOrder(system)) ordered.set(id, system.get(id) as Cell);
  return {
    ok: true,
    value: {
      system: ordered,
      out: (node, key, cls) => outId(node, key, hasClasses ? cls : undefined),
      metaOf: (node, key) => meta.get(`${node}|${key}`),
      classes: classIds,
    },
  };
}

/**
 * Order cells dependencies-first — a topological order of the cell dependency graph (cycle back-edges
 * skipped), tie-broken by id for determinism. The Gauss-Seidel solver then settles an acyclic chain
 * in ONE sweep (O(cells)) instead of the O(cells²) a flow-agnostic order (e.g. alphabetical) forces,
 * while cyclic SCCs still iterate to their least fixpoint. Iterative DFS post-order — no recursion
 * depth limit on long chains.
 */
function dependencyOrder(system: ReadonlyMap<CellId, Cell>): CellId[] {
  const deps = new Map<CellId, CellId[]>();
  for (const [id, cell] of system) {
    if (cell.kind !== 'derived') {
      deps.set(id, []);
      continue;
    }
    const set = new Set<CellId>();
    refsOf(cell.expr, set);
    deps.set(id, [...set].filter((r) => system.has(r)).sort());
  }

  const order: CellId[] = [];
  const state = new Map<CellId, 1 | 2>(); // 1 = on stack, 2 = finished
  for (const root of [...system.keys()].sort()) {
    if (state.has(root)) continue;
    const stack: { id: CellId; i: number }[] = [{ id: root, i: 0 }];
    state.set(root, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { id: CellId; i: number };
      const d = deps.get(top.id) as CellId[];
      if (top.i < d.length) {
        const next = d[top.i] as CellId;
        top.i += 1;
        if (!state.has(next)) {
          state.set(next, 1);
          stack.push({ id: next, i: 0 });
        }
      } else {
        state.set(top.id, 2);
        order.push(top.id);
        stack.pop();
      }
    }
  }
  return order;
}
