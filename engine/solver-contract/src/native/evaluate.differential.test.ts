import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  ClassId,
  EdgeId,
  Key,
  NodeId,
  PortId,
  registryOf,
  Unit,
  type Aggregation,
  type Cell,
  type Edge,
  type Graph,
  type Node,
  type Port,
  type Registry,
  type Transform,
} from '@sda/engine-core';
import { evaluate, parse, type Expr, type RequestClass } from '@sda/engine-solve';
import {
  generateCorpus,
  generateDeclinedCorpus,
  generatedRegistry,
  rngOf,
  type GeneratedInstance,
  type NumericInstance,
  type Rng,
} from '../harness/generator';
import { makeNativeAdapter } from './index';

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// THE FORWARD-EVALUATE ORACLE ANCHOR (V&V phase-1 P0). `evaluate`/`evaluateBatch` — the scalar hot path that runs
// on every edit and feeds the whole UI — carried NO verification anchor (docs/FIDELITY.md §2.4: smoke-tested only).
// optimize/repair/explain/enumerate are graded against the incumbent MIP/ASP; evaluate was not. This file closes
// that gap with an INDEPENDENT re-derivation of the scalar flow algebra as the oracle, differentialled against the
// production `evaluate` across the seeded generated corpus PLUS a deliberately widened corpus (the corners the
// harness generator never reaches).
//
// WHY AN INDEPENDENT RE-DERIVATION (not MiniZinc): the MiniZinc forward path (engine/solve/src/minizinc) grades
// single RELATION EXPRESSIONS (evalExpr vs a per-expression emitter), never the whole-graph flow algebra; and the
// MiniZinc SEARCH path reuses `buildNetwork` (the very projection under test), so it cannot certify it. The honest
// oracle is a SECOND implementation of the documented algebra — offered = inflow + origin/level; served =
// min(capacity, offered); the fan-in / series / async-cut aggregations; the per-port transforms; the processor-
// sharing split under request classes; and the least-fixpoint iteration — written from the model (doc-4, network/
// build.ts's documented semantics), sharing NO code with `buildNetwork`/`solve`/`evalExpr`/`combineExpr`/
// `aggregateExpr`/`transformExpr`/`psSplit`. The ONLY production surface it reuses is the relation string PARSER
// (`parse`) — a lexer/parser, orthogonal to the numeric flow-algebra semantics being graded, and itself anchored
// separately (relation.test.ts + the JS↔MiniZinc expression differential). The reference's own AST evaluator, its
// aggregation/combine/transform arithmetic and its whole fixpoint are re-derived here.
//
// SEED-ROTATABLE (owner directive, mirrors native/index.test.ts): SDA_HARNESS_SEED offsets every base seed by a
// large stride (disjoint regions, byte-reproducible); SDA_HARNESS_DEEP=1 raises the COUNTS. A night loop that
// increments the seed roams fresh instance space — the distillation counts on finding gaps.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════

const SEED = Number.parseInt(process.env.SDA_HARNESS_SEED ?? '0', 10) || 0;
const DEEP = process.env.SDA_HARNESS_DEEP === '1';
const OFFSET = SEED * 1_000_003; // a stride >> any run's instance count ⇒ roamed regions never overlap
const reproEnv = `SDA_HARNESS_SEED=${SEED}${DEEP ? ' SDA_HARNESS_DEEP=1' : ''}`;

// ── Numeric equivalence (float-tolerant) ─────────────────────────────────────────────────────────────────────
// Both sides run the SAME IEEE-754 arithmetic assembled independently; at a fixpoint the values are exact, so a
// relative+absolute tolerance of 1e-7 comfortably absorbs float-reassociation noise while a REAL algebra bug
// (a wrong operator, a dropped transform, a mis-grouped fan-in, a wrong identity) diverges by O(1) relative —
// orders of magnitude above this floor. The threshold is the honest line: below it is float dust, above it a lie.
const RTOL = 1e-7;
const ATOL = 1e-7;
const close = (a: number, b: number): boolean => {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b; // ±Infinity is a legitimate identity — must match exactly
  return Math.abs(a - b) <= ATOL + RTOL * Math.max(Math.abs(a), Math.abs(b));
};

// ── Shared vocabulary + cell helpers (declared once, up front so nothing is used before its declaration) ──────
// The generated corpus's two keys (throughput min/sum/flow, cost sum) — the SAME the generator's `generatedRegistry`
// binds — plus a WIDE registry whose keys span the series/async/flow corners the corpus never reaches.
const THROUGHPUT = Key('throughput');
const COST = Key('cost');

const W_FLOW = Key('wflow'); //  min/sum, cut, flow (throughput-like)
const W_REL = Key('wrel'); //    product, CARRY across async (availability-like)
const W_HOT = Key('whot'); //    max/max, cut (peak-like)
const W_ACC = Key('wacc'); //    sum, cut (cumulative latency/cost-like)
const W_NEED = Key('wneed'); //  sum, LOCAL-only (a per-node sizing quantity that does not flow)
const W_OVER = Key('wover'); //  sum, cut (a derived overflow, reads self()+inflow())
const W_DEM = Key('wdem'); //    sum, cut (a derived downstream demand, reads outflow())

const wideRegistry: Registry = registryOf([
  { key: W_FLOW, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'min', fanIn: 'sum', onAsyncEdge: 'cut', flow: true }, kind: 'derived' },
  { key: W_REL, unit: Unit('ratio'), band: 'minTargetMax', aggregate: { series: 'product', onAsyncEdge: 'carry' }, kind: 'derived' },
  { key: W_HOT, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'max', fanIn: 'max', onAsyncEdge: 'cut' }, kind: 'derived' },
  { key: W_ACC, unit: Unit('ms'), band: 'minTargetMax', aggregate: { series: 'sum', onAsyncEdge: 'cut' }, kind: 'derived' },
  { key: W_NEED, unit: Unit('units'), band: 'minTargetMax', aggregate: { series: 'sum', local: true, onAsyncEdge: 'cut' }, kind: 'derived' },
  { key: W_OVER, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'sum', onAsyncEdge: 'cut' }, kind: 'derived' },
  { key: W_DEM, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'sum', onAsyncEdge: 'cut' }, kind: 'derived' },
]);

const fixed = (k: Key, v: number, unit: string): Cell => ({ kind: 'input', key: k, value: { kind: 'fixed', quantity: { value: v, unit: Unit(unit) } } });
const rel = (k: Key, expr: string, reads: readonly Key[]): Cell => ({ kind: 'derived', key: k, relation: { produces: k, reads, expr } });
const q = (value: number, unit = 'req/s'): Cell => fixed(THROUGHPUT, value, unit);

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// THE INDEPENDENT REFERENCE EVALUATOR (the oracle). A second implementation of the scalar forward pass, computed
// as direct numbers over a Kleene least-fixpoint iteration — NOT the production cell-network projection.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════

interface RefEvaluation {
  readonly converged: boolean;
  readonly classes: readonly ClassId[];
  /** out(node,key) or, under declared classes, out(node,key,cls) — mirrors the production `value` reader exactly
   *  (class-blind unindexed value; per-class value; undefined where the production `value()` returns undefined). */
  value(node: NodeId, key: Key, cls?: ClassId): number | undefined;
}

/** My own AST evaluator — the reference numeric semantics, re-derived (NOT engine-solve's evalExpr). */
function evalAst(e: Expr, resolve: (key: Key, inflow: boolean, outflow: boolean, self: boolean) => number): number {
  switch (e.kind) {
    case 'num':
      return e.value;
    case 'ref':
      return resolve(e.key, e.inflow === true, e.outflow === true, e.self === true);
    case 'neg':
      return -evalAst(e.arg, resolve);
    case 'binary': {
      const l = evalAst(e.left, resolve);
      const r = evalAst(e.right, resolve);
      return e.op === '+' ? l + r : e.op === '-' ? l - r : e.op === '*' ? l * r : l / r;
    }
    case 'call': {
      const vs = e.args.map((a) => evalAst(a, resolve));
      return e.fn === 'min' ? Math.min(...vs) : Math.max(...vs);
    }
    case 'compare': {
      const l = evalAst(e.left, resolve);
      const r = evalAst(e.right, resolve);
      const b = e.op === '<=' ? l <= r : e.op === '<' ? l < r : e.op === '>=' ? l >= r : e.op === '>' ? l > r : l === r;
      return b ? 1 : 0;
    }
  }
}

function referenceEvaluate(graph: Graph, registry: Registry, classes?: readonly RequestClass[]): RefEvaluation {
  const declared = classes ?? [];
  const hasClasses = declared.length > 0;
  const classIds = declared.map((c) => c.id);
  const membership = new Map<ClassId, Set<EdgeId>>(declared.map((c) => [c.id, new Set(c.edges)]));
  const originsByClass = new Map<ClassId, Map<NodeId, number>>(declared.map((c) => [c.id, new Map(c.origins.map((o) => [o.node, o.rps]))]));

  // Declared keys, fixed configs, parsed relations, generator port levels — read straight off the graph.
  const keysInPlay = new Set<Key>();
  const config = new Map<string, number>(); //           `${node}|${key}` → fixed value
  const relations = new Map<string, Expr>(); //          `${node}|${key}` → parsed relation
  const genLevels = new Map<NodeId, number[]>(); //       a node's generate-port baseline levels (> 0)
  for (const node of graph.nodes.values()) {
    for (const cell of node.cells) {
      keysInPlay.add(cell.key);
      if (cell.kind === 'input') {
        if (cell.value.kind === 'fixed') config.set(`${node.id}|${cell.key}`, cell.value.quantity.value);
      } else {
        const p = parse(cell.relation.expr);
        if (!p.ok) throw new Error(`reference: relation parse failed (${cell.relation.expr}): ${p.error}`);
        relations.set(`${node.id}|${cell.key}`, p.value);
      }
    }
    const levels: number[] = [];
    for (const pid of node.ports) {
      const port = graph.ports.get(pid);
      if (port !== undefined && port.dir !== 'in' && port.transform?.kind === 'generate' && port.transform.level > 0) levels.push(port.transform.level);
    }
    if (levels.length > 0) genLevels.set(node.id, levels);
  }

  // Which keys are read via outflow(key) anywhere ⇒ a downstream-demand value is materialised for them.
  const outflowKeys = new Set<Key>();
  const scanOutflow = (e: Expr): void => {
    switch (e.kind) {
      case 'num':
        return;
      case 'ref':
        if (e.outflow === true) outflowKeys.add(e.key);
        return;
      case 'neg':
        scanOutflow(e.arg);
        return;
      case 'binary':
      case 'compare':
        scanOutflow(e.left);
        scanOutflow(e.right);
        return;
      case 'call':
        e.args.forEach(scanOutflow);
        return;
    }
  };
  for (const ex of relations.values()) scanOutflow(ex);

  // Incoming/outgoing adjacency, each incoming edge carrying its f_out (wire override > source port), target
  // in-port id (contributions group by it) and the in-port's f_in.
  interface InEdge {
    readonly edge: EdgeId;
    readonly up: NodeId;
    readonly semantics: 'sync' | 'async';
    readonly fOut?: Transform;
    readonly toPort: string;
    readonly fIn?: Transform;
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
    if (from === undefined || to === undefined) continue;
    const fOut = edge.transform ?? from.transform;
    incoming.get(to.node)?.push({
      edge: edge.id,
      up: from.node,
      semantics: edge.semantics,
      ...(fOut !== undefined ? { fOut } : {}),
      toPort: String(edge.to),
      ...(to.transform !== undefined ? { fIn: to.transform } : {}),
    });
    outgoing.get(from.node)?.push(to.node);
  }

  const aggOf = (k: Key): Aggregation => {
    const def = registry.get(k);
    if (def === undefined) throw new Error(`reference: key "${String(k)}" not in registry`);
    return def.aggregate;
  };
  const isLocalOnly = (k: Key): boolean => aggOf(k).local === true;
  const hasConfig = (n: NodeId, k: Key): boolean => config.has(`${n}|${k}`);
  const hasRelation = (n: NodeId, k: Key): boolean => relations.has(`${n}|${k}`);
  const hasLocal = (n: NodeId, k: Key): boolean => hasConfig(n, k) || hasRelation(n, k);

  // ── The value store + the re-derived algebra primitives ──────────────────────────────────────────────────
  const cur = new Map<string, number>();
  const g = (id: string): number => cur.get(id) ?? 0; // a not-yet-computed cell reads ⊥ = 0 (Kleene from bottom)
  const set = (id: string, v: number): void => {
    cur.set(id, v);
  };
  type Series = Aggregation['series'];
  const identity = (s: Series): number => (s === 'sum' ? 0 : s === 'product' ? 1 : s === 'min' ? Infinity : -Infinity);
  const fold = (s: Series, xs: readonly number[]): number => {
    if (xs.length === 0) return identity(s);
    switch (s) {
      case 'sum':
        return xs.reduce((a, b) => a + b);
      case 'product':
        return xs.reduce((a, b) => a * b);
      case 'min':
        return Math.min(...xs);
      case 'max':
        return Math.max(...xs);
    }
  };
  const combine = (s: Series, a: number, b: number): number => (s === 'sum' ? a + b : s === 'product' ? a * b : s === 'min' ? Math.min(a, b) : Math.max(a, b));
  // The transform arithmetic, re-derived (the scalar twin of engine-core applyTransform, NOT imported).
  const xf = (t: Transform | undefined, x: number): number => {
    if (t === undefined) return x;
    switch (t.kind) {
      case 'ratio':
      case 'prob':
        return t.value * x;
      case 'batch':
        return x / t.value;
      case 'cap':
        return Math.min(x, t.value);
      case 'window':
        return Math.min(x, 1000 / t.value);
      case 'generate':
        return x;
    }
  };
  // A flow key's inflow: per incoming edge apply f_out to the upstream served value; group contributions by
  // target in-port; fan-in-aggregate each group; apply that port's f_in; fan-in-aggregate across ports.
  const flowInflow = (fanIn: Series, ups: readonly InEdge[], upOut: (up: NodeId) => number): number => {
    const byPort = new Map<string, InEdge[]>();
    for (const u of ups) {
      const grp = byPort.get(u.toPort);
      if (grp === undefined) byPort.set(u.toPort, [u]);
      else grp.push(u);
    }
    const intakes: number[] = [];
    for (const edges of byPort.values()) {
      const contribs = edges.map((e) => xf(e.fOut, upOut(e.up)));
      intakes.push(xf(edges[0]?.fIn, fold(fanIn, contribs)));
    }
    return fold(fanIn, intakes);
  };

  // Resolve a relation's key ref (self / outflow / inflow / plain) to a current numeric value, per the model.
  const inflowVal = (n: NodeId, j: Key): number => (hasClasses ? g(`tin:${n}:${j}`) : g(`in:${n}:${j}`));
  const resolveFor = (n: NodeId) => (j: Key, inflow: boolean, outflow: boolean, self: boolean): number => {
    if (self || isLocalOnly(j)) return hasLocal(n, j) ? g(`local:${n}:${j}`) : NaN;
    if (outflow) return keysInPlay.has(j) ? g(`down:${n}:${j}`) : NaN;
    if (inflow) return keysInPlay.has(j) ? inflowVal(n, j) : NaN;
    if (hasConfig(n, j)) return config.get(`${n}|${j}`) as number;
    return keysInPlay.has(j) ? inflowVal(n, j) : NaN;
  };
  const computeLocal = (n: NodeId, k: Key): number | null => {
    const rel = relations.get(`${n}|${k}`);
    if (rel !== undefined) return evalAst(rel, resolveFor(n));
    if (hasConfig(n, k)) return config.get(`${n}|${k}`) as number;
    return null;
  };

  const nodesList = [...graph.nodes.keys()];
  const keys = [...keysInPlay];

  const recomputeNode = (n: NodeId): void => {
    const upsAll = incoming.get(n) ?? [];
    for (const k of keys) {
      const agg = aggOf(k);
      const series = agg.series;
      const fanIn = agg.fanIn ?? series;
      const isFlow = agg.flow === true;
      const localOnly = agg.local === true;
      const ups = upsAll.filter((u) => !(agg.onAsyncEdge === 'cut' && u.semantics === 'async'));

      if (!hasClasses) {
        const inflow = isFlow ? flowInflow(fanIn, ups, (up) => g(`out:${up}:${k}`)) : fold(fanIn, ups.map((u) => g(`out:${u.up}:${k}`)));
        set(`in:${n}:${k}`, inflow);
        const local = computeLocal(n, k);
        if (local !== null) set(`local:${n}:${k}`, local);
        if (localOnly) {
          if (local !== null) set(`out:${n}:${k}`, local); // no local ⇒ no out cell (value absent)
        } else if (isFlow && (genLevels.get(n)?.length ?? 0) > 0) {
          const levels = genLevels.get(n) as number[];
          const offered = fold(fanIn, [g(`in:${n}:${k}`), ...levels]);
          const out = hasRelation(n, k) ? (local as number) : local !== null ? combine(series, local, offered) : offered;
          set(`out:${n}:${k}`, out);
        } else {
          const out = local !== null ? (ups.length > 0 ? combine(series, local, g(`in:${n}:${k}`)) : local) : g(`in:${n}:${k}`);
          set(`out:${n}:${k}`, out);
        }
        if (outflowKeys.has(k)) set(`down:${n}:${k}`, fold('sum', (outgoing.get(n) ?? []).map((d) => g(`out:${d}:${k}`))));
      } else {
        for (const c of classIds) {
          const upsC = ups.filter((u) => membership.get(c)?.has(u.edge) === true);
          const inC = isFlow ? flowInflow(fanIn, upsC, (up) => g(`out:${up}:${k}:${c}`)) : fold(fanIn, upsC.map((u) => g(`out:${u.up}:${k}:${c}`)));
          set(`in:${n}:${k}:${c}`, inC);
          if (isFlow) {
            const rps = originsByClass.get(c)?.get(n);
            set(`off:${n}:${k}:${c}`, inC + (rps ?? 0));
          }
        }
        set(`tin:${n}:${k}`, fold('sum', classIds.map((c) => g(`in:${n}:${k}:${c}`))));
        const local = computeLocal(n, k);
        if (local !== null) set(`local:${n}:${k}`, local);
        if (localOnly) {
          if (local !== null) set(`out:${n}:${k}`, local);
        } else if (isFlow) {
          set(`tot:${n}:${k}`, fold('sum', classIds.map((c) => g(`off:${n}:${k}:${c}`))));
          const tot = g(`tot:${n}:${k}`);
          for (const c of classIds) {
            const off = g(`off:${n}:${k}:${c}`);
            set(`out:${n}:${k}:${c}`, local !== null ? (off * local) / Math.max(tot, local) : off);
          }
          set(`out:${n}:${k}`, fold('sum', classIds.map((c) => g(`out:${n}:${k}:${c}`)))); // class-blind total (flow only)
        } else {
          for (const c of classIds) {
            const upsC = ups.filter((u) => membership.get(c)?.has(u.edge) === true);
            const inC = g(`in:${n}:${k}:${c}`);
            set(`out:${n}:${k}:${c}`, local !== null ? (upsC.length > 0 ? combine(series, local, inC) : local) : inC);
          }
        }
        if (outflowKeys.has(k)) {
          const terms: number[] = [];
          for (const d of outgoing.get(n) ?? []) for (const c of classIds) terms.push(g(`out:${d}:${k}:${c}`));
          set(`down:${n}:${k}`, fold('sum', terms));
        }
      }
    }
  };

  // Kleene least-fixpoint: iterate the whole recompute to a stable point (matching the production maxIter/epsilon).
  const maxIter = 1000;
  const epsilon = 1e-9;
  let settled = false;
  for (let iter = 0; iter < maxIter; iter++) {
    const prev = new Map(cur);
    for (const n of nodesList) recomputeNode(n);
    let maxDelta = 0;
    for (const [id, v] of cur) {
      const p = prev.get(id);
      const d = p === undefined ? Number.POSITIVE_INFINITY : Math.abs(v - p);
      if (d > maxDelta) maxDelta = d;
    }
    if (maxDelta <= epsilon) {
      settled = true;
      break;
    }
  }
  let hasNaN = false;
  for (const v of cur.values()) if (Number.isNaN(v)) hasNaN = true;

  return {
    converged: settled && !hasNaN,
    classes: classIds,
    value: (node, key, cls) => {
      const id = hasClasses && cls !== undefined ? `out:${node}:${key}:${cls}` : `out:${node}:${key}`;
      return cur.has(id) ? cur.get(id) : undefined;
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// THE DIFFERENTIAL — production `evaluate` MUST equal the independent reference per (node, key[, class]).
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════

interface Divergence {
  readonly where: string;
  readonly production: number | undefined | boolean;
  readonly reference: number | undefined | boolean;
}

/** Compare production `evaluate` against the independent reference on one graph; return every mismatch found. */
function diff(label: string, graph: Graph, registry: Registry, classes?: readonly RequestClass[]): Divergence[] {
  const cls = classes as readonly RequestClass[] | undefined;
  const prod = evaluate(graph, registry, cls);
  if (!prod.ok) throw new Error(`${label}: production evaluate returned a build error (unexpected for a valid graph): ${JSON.stringify(prod.error)}`);
  const ref = referenceEvaluate(graph, registry, classes);
  const out: Divergence[] = [];

  // (1) Convergence-flag parity — a did-not-converge is meaningless as a value, but the two MUST agree on WHETHER
  //     the fixpoint settled (an honesty divergence is itself a P0).
  if (prod.value.converged !== ref.converged) {
    out.push({ where: `${label} :: converged`, production: prod.value.converged, reference: ref.converged });
    return out; // non-converged values are order-dependent noise; do not compare them
  }
  if (!prod.value.converged) return out; // both did-not-converge ⇒ nothing else to compare (honest)

  // (2) Per-node, per-key, per-class value parity. Iterate the declared keys × every node × {class-blind, each
  //     declared class}, exactly the addressing the production `value()` reader answers.
  const keysInPlay = new Set<Key>();
  for (const node of graph.nodes.values()) for (const c of node.cells) keysInPlay.add(c.key);
  const classSlots: (ClassId | undefined)[] = [undefined, ...ref.classes];
  for (const node of graph.nodes.values()) {
    for (const key of keysInPlay) {
      for (const c of classSlots) {
        const pv = prod.value.value(node.id, key, c);
        const rv = ref.value(node.id, key, c);
        const bothAbsent = pv === undefined && rv === undefined;
        const bothPresent = pv !== undefined && rv !== undefined && close(pv, rv);
        if (!bothAbsent && !bothPresent) {
          out.push({ where: `${label} :: ${String(node.id)} / ${String(key)}${c !== undefined ? ` / ${String(c)}` : ''}`, production: pv, reference: rv });
        }
      }
    }
  }
  return out;
}

/** Fail a describe with a fully-reproducible, plain report of every divergence (owner mandate: report plainly). */
function assertNoDivergence(divs: readonly Divergence[]): void {
  if (divs.length === 0) return;
  const lines = divs.slice(0, 40).map((d) => `  ${d.where}: production=${String(d.production)} reference=${String(d.reference)}`);
  throw new Error(`evaluate DIVERGED from the independent oracle on ${divs.length} (node,key) point(s) — reproduce with ${reproEnv}:\n${lines.join('\n')}`);
}

// ── (A) MICRO CASES that PIN THE ORACLE to hand arithmetic ───────────────────────────────────────────────────
// The oracle must itself be trustworthy: three tiny designs with values computed BY HAND anchor the reference to
// human arithmetic (so a bug in the reference is caught here), and each is ALSO differentialled against production
// (closing the loop: hand ⟶ reference ⟶ production).

describe('reference oracle — pinned to hand arithmetic (the oracle must itself be right)', () => {
  it('chain min/sum: served = min(cap, offered), cost accumulates', () => {
    const g = buildGraph({
      nodes: [
        { id: NodeId('src'), ports: [PortId('src.out')], cells: [q(1000)] },
        {
          id: NodeId('t0'),
          ports: [PortId('t0.in'), PortId('t0.out')],
          cells: [q(700), { kind: 'derived', key: COST, relation: { produces: COST, reads: [THROUGHPUT], expr: 'throughput * 0.1' } }],
        },
      ],
      ports: [
        { id: PortId('src.out'), node: NodeId('src'), dir: 'out' },
        { id: PortId('t0.in'), node: NodeId('t0'), dir: 'in' },
        { id: PortId('t0.out'), node: NodeId('t0'), dir: 'out' },
      ],
      edges: [{ id: EdgeId('e0'), from: PortId('src.out'), to: PortId('t0.in'), semantics: 'sync' }],
    });
    if (!g.ok) throw new Error('bad graph');
    const ref = referenceEvaluate(g.value, generatedRegistry);
    expect(ref.value(NodeId('src'), THROUGHPUT)).toBe(1000);
    expect(ref.value(NodeId('t0'), THROUGHPUT)).toBe(700); // min(700, 1000)
    expect(ref.value(NodeId('src'), COST)).toBe(0); // sum identity (no cost cell at src)
    expect(ref.value(NodeId('t0'), COST)).toBeCloseTo(70, 9); // 700 * 0.1 + 0
    assertNoDivergence(diff('micro-chain', g.value, generatedRegistry));
  });

  it('fan-in sum with an out-port ratio transform: offered SUMS the shaped contributions', () => {
    const g = buildGraph({
      nodes: [
        { id: NodeId('s0'), ports: [PortId('s0.out')], cells: [q(300)] },
        { id: NodeId('s1'), ports: [PortId('s1.out')], cells: [q(400)] },
        { id: NodeId('k'), ports: [PortId('k.in')], cells: [q(1000)] },
      ],
      ports: [
        { id: PortId('s0.out'), node: NodeId('s0'), dir: 'out' },
        { id: PortId('s1.out'), node: NodeId('s1'), dir: 'out', transform: { kind: 'ratio', value: 0.5 } },
        { id: PortId('k.in'), node: NodeId('k'), dir: 'in' },
      ],
      edges: [
        { id: EdgeId('e0'), from: PortId('s0.out'), to: PortId('k.in'), semantics: 'sync' },
        { id: EdgeId('e1'), from: PortId('s1.out'), to: PortId('k.in'), semantics: 'sync' },
      ],
    });
    if (!g.ok) throw new Error('bad graph');
    const ref = referenceEvaluate(g.value, generatedRegistry);
    expect(ref.value(NodeId('k'), THROUGHPUT)).toBe(500); // min(1000, 300 + 0.5*400)
    assertNoDivergence(diff('micro-fanin', g.value, generatedRegistry));
  });

  it('product / max / async-cut-vs-carry (wide registry): each series composes per its own algebra', () => {
    const wr = (n: string): NodeId => NodeId(n);
    const cell = (k: Key, v: number, unit: string): Cell => ({ kind: 'input', key: k, value: { kind: 'fixed', quantity: { value: v, unit: Unit(unit) } } });
    const g = buildGraph({
      nodes: [
        { id: wr('a'), ports: [PortId('a.out')], cells: [cell(W_FLOW, 100, 'req/s'), cell(W_REL, 0.9, 'ratio'), cell(W_HOT, 10, 'req/s')] },
        { id: wr('b'), ports: [PortId('b.out')], cells: [cell(W_FLOW, 200, 'req/s'), cell(W_REL, 0.8, 'ratio'), cell(W_HOT, 30, 'req/s')] },
        { id: wr('m'), ports: [PortId('m.in')], cells: [cell(W_FLOW, 1000, 'req/s'), cell(W_REL, 0.95, 'ratio'), cell(W_HOT, 5, 'req/s')] },
      ],
      ports: [
        { id: PortId('a.out'), node: wr('a'), dir: 'out' },
        { id: PortId('b.out'), node: wr('b'), dir: 'out' },
        { id: PortId('m.in'), node: wr('m'), dir: 'in' },
      ],
      edges: [
        { id: EdgeId('ea'), from: PortId('a.out'), to: PortId('m.in'), semantics: 'sync' },
        { id: EdgeId('eb'), from: PortId('b.out'), to: PortId('m.in'), semantics: 'async' }, // async: cut for flow/hot, carried for rel
      ],
    });
    if (!g.ok) throw new Error('bad graph');
    const ref = referenceEvaluate(g.value, wideRegistry);
    expect(ref.value(wr('m'), W_FLOW)).toBe(100); // async b cut ⇒ min(1000, 100)
    expect(ref.value(wr('m'), W_REL)).toBeCloseTo(0.684, 9); // carry ⇒ 0.95 * (0.9 * 0.8)
    expect(ref.value(wr('m'), W_HOT)).toBe(10); // async b cut ⇒ max(5, 10)
    assertNoDivergence(diff('micro-wide', g.value, wideRegistry));
  });
});

// ── (B) THE WIDENED CORPUS — the flow-algebra corners the harness generator never reaches ────────────────────
// The seeded generator (harness/generator.ts) is NARROW for the flow algebra: only min/sum series, all-`sync`
// edges, no cycles, no product/max, no self/inflow/outflow relations, no localOnly keys. A clean pass on it alone
// is NOT an anchor. This wide registry + design set deliberately spans: product & max aggregations; async edges
// (cut vs carry); per-port transforms combined with fan-in/fan-out; self()/inflow()/outflow() relations; a
// localOnly key; and FEEDBACK CYCLES (the least-fixpoint iteration the DAG corpus never exercises), including a
// deliberately NON-converging cycle (both engines must honestly report did-not-converge). The wide registry + keys
// + cell helpers are declared up front (top of file).

/** Build & validate a wide-registry graph, throwing on an invalid one (a seed bug). */
function wideGraph(label: string, nodes: readonly Node[], ports: readonly Port[], edges: readonly Edge[]): { label: string; graph: Graph } {
  const g = buildGraph({ nodes: [...nodes], ports: [...ports], edges: [...edges] });
  if (!g.ok) throw new Error(`wide design "${label}" is invalid: ${JSON.stringify(g.error)}`);
  return { label, graph: g.value };
}

/** A batch of widened designs for one rng — each stresses a corner the harness corpus never reaches. */
function widenedDesigns(rng: Rng): { label: string; graph: Graph }[] {
  const out: { label: string; graph: Graph }[] = [];
  const cap = (): number => rng.pick([200, 500, 700, 1000, 1500]);
  const relv = (): number => rng.pick([0.9, 0.95, 0.99, 0.999]);
  const hot = (): number => rng.pick([5, 10, 20, 50]);
  const lat = (): number => rng.pick([5, 10, 20]);
  const xform = (): Transform | undefined => rng.pick<Transform | undefined>([undefined, { kind: 'ratio', value: 0.5 }, { kind: 'cap', value: 600 }, { kind: 'batch', value: 2 }, { kind: 'window', value: 2 }, { kind: 'prob', value: 0.7 }]);

  // W1 — deep chain mixing product (carry) + max + sum(acc) + flow, with random per-edge transforms and a random
  //      async edge (cut for flow/hot/acc, carried for rel). Exercises all four series down a chain.
  {
    const len = rng.int(4, DEEP ? 12 : 7);
    const nodes: Node[] = [{ id: NodeId('src'), ports: [PortId('src.out')], cells: [fixed(W_FLOW, rng.pick([800, 1500, 2500]), 'req/s'), fixed(W_REL, relv(), 'ratio'), fixed(W_HOT, hot(), 'req/s'), fixed(W_ACC, lat(), 'ms')] }];
    const ports: Port[] = [{ id: PortId('src.out'), node: NodeId('src'), dir: 'out' }];
    const edges: Edge[] = [];
    let prev = PortId('src.out');
    const asyncAt = rng.int(0, len - 1);
    for (let i = 0; i < len; i++) {
      const id = NodeId(`n${i}`);
      const cells: Cell[] = [fixed(W_FLOW, cap(), 'req/s'), fixed(W_REL, relv(), 'ratio'), fixed(W_HOT, hot(), 'req/s'), fixed(W_ACC, lat(), 'ms')];
      const t = xform();
      nodes.push({ id, ports: [PortId(`n${i}.in`), PortId(`n${i}.out`)], cells });
      ports.push(t !== undefined ? { id: PortId(`n${i}.in`), node: id, dir: 'in', transform: t } : { id: PortId(`n${i}.in`), node: id, dir: 'in' }, { id: PortId(`n${i}.out`), node: id, dir: 'out' });
      edges.push({ id: EdgeId(`e${i}`), from: prev, to: PortId(`n${i}.in`), semantics: i === asyncAt ? 'async' : 'sync' });
      prev = PortId(`n${i}.out`);
    }
    out.push(wideGraph('wide-chain-4series', nodes, ports, edges));
  }

  // W2 — fan-out then fan-in (a diamond) with per-branch transforms: max at the join for W_HOT, sum for flow,
  //      product for rel — the multi-port grouping the corpus's single-in-port fan-ins never stress together.
  {
    const branches = rng.int(2, DEEP ? 6 : 4);
    const nodes: Node[] = [{ id: NodeId('src'), ports: [PortId('src.out')], cells: [fixed(W_FLOW, 3000, 'req/s'), fixed(W_REL, relv(), 'ratio'), fixed(W_HOT, hot(), 'req/s')] }];
    const ports: Port[] = [{ id: PortId('src.out'), node: NodeId('src'), dir: 'out' }];
    const edges: Edge[] = [];
    const joinIn = PortId('join.in');
    for (let i = 0; i < branches; i++) {
      const id = NodeId(`br${i}`);
      const t = xform();
      nodes.push({ id, ports: [PortId(`br${i}.in`), PortId(`br${i}.out`)], cells: [fixed(W_FLOW, cap(), 'req/s'), fixed(W_REL, relv(), 'ratio'), fixed(W_HOT, hot(), 'req/s')] });
      ports.push(
        { id: PortId(`br${i}.in`), node: id, dir: 'in' },
        t !== undefined ? { id: PortId(`br${i}.out`), node: id, dir: 'out', transform: t } : { id: PortId(`br${i}.out`), node: id, dir: 'out' },
      );
      edges.push({ id: EdgeId(`ei${i}`), from: PortId('src.out'), to: PortId(`br${i}.in`), semantics: 'sync' });
      edges.push({ id: EdgeId(`eo${i}`), from: PortId(`br${i}.out`), to: joinIn, semantics: 'sync' });
    }
    nodes.push({ id: NodeId('join'), ports: [joinIn], cells: [fixed(W_FLOW, 5000, 'req/s'), fixed(W_REL, relv(), 'ratio'), fixed(W_HOT, hot(), 'req/s')] });
    ports.push({ id: joinIn, node: NodeId('join'), dir: 'in' });
    out.push(wideGraph('wide-diamond', nodes, ports, edges));
  }

  // W3 — self()/inflow() overflow + a localOnly sizing key + an outflow() downstream-demand relation. The
  //      relation surface the corpus never authors (all its relations are `throughput * literal`).
  {
    const srcRate = rng.pick([800, 1200, 2000]);
    const capMid = rng.pick([300, 500, 700]);
    const nodes: Node[] = [
      { id: NodeId('src'), ports: [PortId('src.out')], cells: [fixed(W_FLOW, srcRate, 'req/s')] },
      {
        id: NodeId('mid'),
        ports: [PortId('mid.in'), PortId('mid.out')],
        cells: [
          fixed(W_FLOW, capMid, 'req/s'),
          // overflow = max(0, offered - capacity): reads inflow(wflow) (offered) and self(wflow) (this node's own capacity)
          rel(W_OVER, 'max(0, inflow(wflow) - self(wflow))', [W_FLOW]),
          // a node-local sizing quantity that does NOT flow (localOnly): units = capacity / 100
          rel(W_NEED, 'self(wflow) / 100', [W_FLOW]),
          // downstream demand pulled by consumers = outflow(wflow)
          rel(W_DEM, 'outflow(wflow)', [W_FLOW]),
        ],
      },
      { id: NodeId('sink'), ports: [PortId('sink.in')], cells: [fixed(W_FLOW, rng.pick([100, 250, 400]), 'req/s')] },
    ];
    const ports: Port[] = [
      { id: PortId('src.out'), node: NodeId('src'), dir: 'out' },
      { id: PortId('mid.in'), node: NodeId('mid'), dir: 'in' },
      { id: PortId('mid.out'), node: NodeId('mid'), dir: 'out' },
      { id: PortId('sink.in'), node: NodeId('sink'), dir: 'in' },
    ];
    const edges: Edge[] = [
      { id: EdgeId('e0'), from: PortId('src.out'), to: PortId('mid.in'), semantics: 'sync' },
      { id: EdgeId('e1'), from: PortId('mid.out'), to: PortId('sink.in'), semantics: 'sync' },
    ];
    out.push(wideGraph('wide-self-outflow-localonly', nodes, ports, edges));
  }

  // W4 — a CONVERGING feedback cycle: src → a → b → a (back-edge) on the min/sum flow key. The least-fixpoint
  //      iteration the acyclic corpus NEVER exercises. Bounded by the caps, so both engines must settle to the
  //      same fixpoint.
  {
    const srcRate = rng.pick([500, 900, 1400]);
    const capA = rng.pick([300, 600, 900]);
    const capB = rng.pick([200, 400, 800]);
    const nodes: Node[] = [
      { id: NodeId('src'), ports: [PortId('src.out')], cells: [fixed(W_FLOW, srcRate, 'req/s')] },
      { id: NodeId('a'), ports: [PortId('a.in'), PortId('a.out')], cells: [fixed(W_FLOW, capA, 'req/s')] },
      { id: NodeId('b'), ports: [PortId('b.in'), PortId('b.out')], cells: [fixed(W_FLOW, capB, 'req/s')] },
    ];
    const ports: Port[] = [
      { id: PortId('src.out'), node: NodeId('src'), dir: 'out' },
      { id: PortId('a.in'), node: NodeId('a'), dir: 'in' },
      { id: PortId('a.out'), node: NodeId('a'), dir: 'out' },
      { id: PortId('b.in'), node: NodeId('b'), dir: 'in' },
      { id: PortId('b.out'), node: NodeId('b'), dir: 'out' },
    ];
    const edges: Edge[] = [
      { id: EdgeId('e0'), from: PortId('src.out'), to: PortId('a.in'), semantics: 'sync' },
      { id: EdgeId('e1'), from: PortId('a.out'), to: PortId('b.in'), semantics: 'sync' },
      { id: EdgeId('e2'), from: PortId('b.out'), to: PortId('a.in'), semantics: 'sync' }, // the back-edge (a mesh over the flow key)
    ];
    out.push(wideGraph('wide-cycle-converging', nodes, ports, edges));
  }

  // W5 — a node with TWO DISTINCT in-ports, each with its OWN f_in transform, one port fed by a fan-in of two
  //      sources. This exercises the ACROSS-PORT aggregation (aggregate the per-port intakes) that neither the
  //      harness corpus nor W1–W4 reach — every corpus fan-in lands on a SINGLE in-port.
  {
    const capM = rng.pick([400, 800, 1200]);
    const nodes: Node[] = [
      { id: NodeId('s0'), ports: [PortId('s0.out')], cells: [fixed(W_FLOW, rng.pick([200, 400, 600]), 'req/s')] },
      { id: NodeId('s1'), ports: [PortId('s1.out')], cells: [fixed(W_FLOW, rng.pick([200, 400, 600]), 'req/s')] },
      { id: NodeId('s2'), ports: [PortId('s2.out')], cells: [fixed(W_FLOW, rng.pick([200, 400, 600]), 'req/s')] },
      { id: NodeId('m'), ports: [PortId('m.inA'), PortId('m.inB')], cells: [fixed(W_FLOW, capM, 'req/s'), fixed(W_ACC, lat(), 'ms')] },
    ];
    const ports: Port[] = [
      { id: PortId('s0.out'), node: NodeId('s0'), dir: 'out' },
      { id: PortId('s1.out'), node: NodeId('s1'), dir: 'out' },
      { id: PortId('s2.out'), node: NodeId('s2'), dir: 'out' },
      { id: PortId('m.inA'), node: NodeId('m'), dir: 'in', transform: { kind: 'cap', value: 600 } }, // f_in on port A: cap the summed intake
      { id: PortId('m.inB'), node: NodeId('m'), dir: 'in', transform: { kind: 'ratio', value: 0.5 } }, // f_in on port B: halve
    ];
    const edges: Edge[] = [
      { id: EdgeId('e0'), from: PortId('s0.out'), to: PortId('m.inA'), semantics: 'sync' },
      { id: EdgeId('e1'), from: PortId('s2.out'), to: PortId('m.inA'), semantics: 'sync' }, // two sources SUM at port A, then f_in caps
      { id: EdgeId('e2'), from: PortId('s1.out'), to: PortId('m.inB'), semantics: 'sync' }, // one source at port B, then f_in halves
    ];
    out.push(wideGraph('wide-multi-inport', nodes, ports, edges));
  }

  // W6 — an EDGE-LEVEL transform OVERRIDE (a routing split: one wire overrides the source out-port's transform, the
  //      other keeps it) + a MULTI-GENERATOR node (two generate ports whose levels both sum into the offered load).
  //      Both are corpus blind spots (no edge carries a transform; every generator node has exactly one gen port).
  {
    const srcRate = rng.pick([1000, 2000, 3000]);
    const genCap = rng.pick([2000, 4000]);
    const l1 = rng.pick([300, 500]);
    const l2 = rng.pick([200, 400]);
    const nodes: Node[] = [
      { id: NodeId('src'), ports: [PortId('src.out')], cells: [fixed(W_FLOW, srcRate, 'req/s')] },
      { id: NodeId('x'), ports: [PortId('x.in')], cells: [fixed(W_FLOW, 9000, 'req/s')] },
      { id: NodeId('y'), ports: [PortId('y.in')], cells: [fixed(W_FLOW, 9000, 'req/s')] },
      { id: NodeId('gen'), ports: [PortId('gen.o1'), PortId('gen.o2')], cells: [fixed(W_FLOW, genCap, 'req/s')] },
      { id: NodeId('z'), ports: [PortId('z.in')], cells: [fixed(W_FLOW, 9000, 'req/s')] },
    ];
    const ports: Port[] = [
      { id: PortId('src.out'), node: NodeId('src'), dir: 'out', transform: { kind: 'ratio', value: 0.5 } }, // the port default f_out
      { id: PortId('x.in'), node: NodeId('x'), dir: 'in' },
      { id: PortId('y.in'), node: NodeId('y'), dir: 'in' },
      { id: PortId('gen.o1'), node: NodeId('gen'), dir: 'out', transform: { kind: 'generate', level: l1 } },
      { id: PortId('gen.o2'), node: NodeId('gen'), dir: 'out', transform: { kind: 'generate', level: l2 } }, // a SECOND generator on the same node
      { id: PortId('z.in'), node: NodeId('z'), dir: 'in' },
    ];
    const edges: Edge[] = [
      { id: EdgeId('e0'), from: PortId('src.out'), to: PortId('x.in'), semantics: 'sync', transform: { kind: 'prob', value: 0.7 } }, // WIRE OVERRIDE ⇒ 0.7·src
      { id: EdgeId('e1'), from: PortId('src.out'), to: PortId('y.in'), semantics: 'sync' }, // no override ⇒ the port's 0.5·src
      { id: EdgeId('e2'), from: PortId('gen.o1'), to: PortId('z.in'), semantics: 'sync' }, // z sees out(gen) = min(genCap, l1 + l2)
    ];
    out.push(wideGraph('wide-edge-override-multigen', nodes, ports, edges));
  }

  return out;
}

// ── The corpus assembly (seeded, seed-rotatable) ─────────────────────────────────────────────────────────────
// Every generated NUMERIC design's graph, evaluated forward at its FIXED capacities (exactly what `evaluate`
// does), PLUS the declined corpus (which includes SATURATED request-class designs — the processor-sharing split
// under saturation, a corner the SEARCH declines but `evaluate` computes cleanly), PLUS the widened designs.
function numericGraphs(): { label: string; graph: Graph; registry: Registry; classes?: readonly RequestClass[] }[] {
  const perCell = DEEP ? 6 : 3;
  const perAxis = DEEP ? 2 : 1;
  const declinedPerCell = DEEP ? 3 : 2;
  const corpus: GeneratedInstance[] = [
    ...generateCorpus({ perCell, perAxis, axes: true, baseSeed: 0x5da79 + OFFSET }),
    ...generateDeclinedCorpus({ perCell: declinedPerCell, baseSeed: 0xdec11 + OFFSET }),
  ];
  const jobs: { label: string; graph: Graph; registry: Registry; classes?: readonly RequestClass[] }[] = [];
  for (const inst of corpus) {
    if (inst.kind !== 'numeric') continue; // enumerate instances carry no graph
    const n = inst as NumericInstance;
    jobs.push({ label: `corpus:${n.axis}/${n.topology}/${n.regime}/${n.capability}#${n.seed}`, graph: n.graph, registry: generatedRegistry, ...(n.classes !== undefined ? { classes: n.classes } : {}) });
  }
  const wideRng = rngOf(0x3d1e + OFFSET);
  const wideRounds = DEEP ? 8 : 3;
  for (let r = 0; r < wideRounds; r++) for (const d of widenedDesigns(wideRng)) jobs.push({ label: `wide:${d.label}#${r}`, graph: d.graph, registry: wideRegistry });
  return jobs;
}

describe(`evaluate — oracle-graded differential vs an independent re-derivation (${reproEnv})`, () => {
  const jobs = numericGraphs();

  it(`grades a broad corpus (${jobs.length} designs: harness axes + declined + widened flow-algebra corners)`, () => {
    // The count is asserted so a regression that silently empties the corpus (a false clean pass) fails loudly.
    expect(jobs.length).toBeGreaterThan(80);
  });

  it('production evaluate matches the independent oracle on EVERY (node, key[, class]) across the whole corpus', () => {
    const all: Divergence[] = [];
    for (const j of jobs) all.push(...diff(j.label, j.graph, j.registry, j.classes));
    assertNoDivergence(all);
  });

  // A deliberately NON-CONVERGING feedback cycle: a sum-series flow with a back-edge and no ceiling grows every
  // sweep. BOTH engines must honestly report did-not-converge (converged:false) — the anti-lie parity the corpus
  // (all DAGs) never tests. This is asserted directly (not via `diff`, which returns early on non-convergence).
  it('a non-converging feedback cycle: production and the oracle BOTH report did-not-converge (honesty parity)', () => {
    const runaway = registryOf([{ key: W_ACC, unit: Unit('ms'), band: 'minTargetMax', aggregate: { series: 'sum', fanIn: 'sum', onAsyncEdge: 'carry' }, kind: 'derived' }]);
    const g = buildGraph({
      nodes: [
        { id: NodeId('src'), ports: [PortId('src.out')], cells: [fixed(W_ACC, 10, 'ms')] },
        { id: NodeId('a'), ports: [PortId('a.in'), PortId('a.out')], cells: [] },
        { id: NodeId('b'), ports: [PortId('b.in'), PortId('b.out')], cells: [] },
      ],
      ports: [
        { id: PortId('src.out'), node: NodeId('src'), dir: 'out' },
        { id: PortId('a.in'), node: NodeId('a'), dir: 'in' },
        { id: PortId('a.out'), node: NodeId('a'), dir: 'out' },
        { id: PortId('b.in'), node: NodeId('b'), dir: 'in' },
        { id: PortId('b.out'), node: NodeId('b'), dir: 'out' },
      ],
      edges: [
        { id: EdgeId('e0'), from: PortId('src.out'), to: PortId('a.in'), semantics: 'sync' },
        { id: EdgeId('e1'), from: PortId('a.out'), to: PortId('b.in'), semantics: 'sync' },
        { id: EdgeId('e2'), from: PortId('b.out'), to: PortId('a.in'), semantics: 'sync' }, // a + b feed a: the sum accumulates without bound
      ],
    });
    if (!g.ok) throw new Error('bad graph');
    const prod = evaluate(g.value, runaway);
    if (!prod.ok) throw new Error('unexpected build error');
    const ref = referenceEvaluate(g.value, runaway);
    expect(prod.value.converged, 'production must honestly report did-not-converge on an unbounded sum cycle').toBe(false);
    expect(ref.converged).toBe(false);
    expect(prod.value.converged).toBe(ref.converged);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// evaluateBatch — BATCH CONSISTENCY: each world's Evaluation must equal the single-world evaluate on the same
// design under that scenario's overrides (the contract's seeded/deterministic promise, docs §3.6).
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════

describe('evaluateBatch — each world equals the single-world evaluate (batch consistency)', () => {
  it('N scenarios ⇒ N Evaluations, each identical to a single evaluate on the correspondingly-overridden graph', async () => {
    const native = makeNativeAdapter({ registry: generatedRegistry });
    // A concrete design with a tunable capacity to override per scenario (seed fixed — this is a consistency law,
    // not a corpus sweep; the corpus sweep above already grades the single-world evaluate the batch delegates to).
    const inst = generateCorpus({ perCell: 1, baseSeed: 0x5da79 + OFFSET }).find((i): i is NumericInstance => i.kind === 'numeric') as NumericInstance;
    const tunable = inst.tunables[0];
    if (tunable === undefined) throw new Error('expected a tunable to override');
    const scenarios = [{ overrides: {} }, { overrides: { [`${tunable.node}|${tunable.key}`]: 123 } }, { overrides: { [`${tunable.node}|${tunable.key}`]: 999 } }];

    const batch = await native.evaluateBatch!({ graph: inst.graph, scenarios });
    expect(batch).toHaveLength(scenarios.length);

    const keys = new Set<Key>();
    for (const node of inst.graph.nodes.values()) for (const c of node.cells) keys.add(c.key);

    scenarios.forEach((scenario, i) => {
      const overlaid = overlay(inst.graph, scenario.overrides);
      const single = evaluate(overlaid, generatedRegistry);
      if (!single.ok) throw new Error('single evaluate failed');
      const world = batch[i];
      if (world === undefined) throw new Error(`missing world ${i}`);
      expect(world.converged).toBe(single.value.converged);
      for (const node of inst.graph.nodes.values()) {
        for (const key of keys) {
          const wv = world.value(node.id, key);
          const sv = single.value.value(node.id, key);
          expect(wv === undefined ? undefined : close(wv, sv ?? NaN), `world ${i} :: ${String(node.id)}/${String(key)}: batch=${String(wv)} single=${String(sv)}`).not.toBe(false);
          expect(wv === undefined).toBe(sv === undefined);
        }
      }
    });
  });
});

/** Overlay fixed-config overrides onto a graph (mirrors the native adapter's applyOverrides — an INDEPENDENT copy
 *  so the batch-consistency check does not depend on the adapter's own internal surgery). */
function overlay(graph: Graph, overrides: Readonly<Record<string, number>>): Graph {
  if (Object.keys(overrides).length === 0) return graph;
  const nodes = new Map(graph.nodes);
  for (const [id, node] of nodes) {
    let changed = false;
    const cells = node.cells.map((c) => {
      if (c.kind !== 'input' || c.value.kind !== 'fixed') return c;
      const v = overrides[`${id}|${c.key}`];
      if (v === undefined) return c;
      changed = true;
      return { ...c, value: { kind: 'fixed' as const, quantity: { ...c.value.quantity, value: v } } };
    });
    if (changed) nodes.set(id, { ...node, cells });
  }
  return { nodes, ports: graph.ports, edges: graph.edges };
}
