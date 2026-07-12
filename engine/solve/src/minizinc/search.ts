// @algorithm Backward-search MIP compilation (interval boxing, PS-split linearization, reachability prune)
// @problem Turn optimize / repair / explain-infeasible over the cell network into a continuous
//   optimization model a MIP/LP solver (COIN-BC / HiGHS) can prove optimal — Gecode's float
//   branch-and-bound cannot terminate its optimality proof on these objectives.
// @approach Constant-fold the fixed cells; box every free variable by SOUND interval evaluation
//   (over-approximating reachable values); rewrite the processor-sharing split
//   offered*cap/max(total,cap) to its headroom-linear min(cap, offered) form; encode bands as
//   hard constraints (repair adds L1-distance minimization, UNSAT-explain relaxes bands to soft
//   penalties); prune tunables that cannot reach the objective by cell-graph reachability (the fix
//   for the 319s free-tunable degeneracy).
// @complexity Model construction linear in cells + expression sizes (interval eval, DFS cycle test,
//   reachability DFS); solve cost is the MIP solver's, hard time-bounded by the caller.
// @citations Interval arithmetic (Moore 1966); big-M-free linearization by headroom restriction; L1
//   goal programming for minimal repair (standard OR practice).
// @invariants Interval boxes are sound (never exclude a reachable value); linearization is exact on
//   the headroom-feasible region the model enforces; emitted model semantics match the JS evaluator
//   (differential-tested); degenerate free knobs are pruned, never silently explored.
// @where-tested engine/solve/src/minizinc/search.test.ts,
//   engine/solve/src/minizinc/transform.differential.test.ts

import { assertNever, type Band, type ClassId, type Graph, type Key, type NodeId, type Registry, type Result } from '@sda/engine-core';
import { buildNetwork, type Network, type RequestClass } from '../network';
import type { Cell, CellId } from '../fixpoint';
import type { Expr } from '../relation';
import { exprToMzn } from './project';
import { simplify } from './chain';

// The search modes (optimize / UNSAT-explain) emit a continuous optimization model. Solve it with a
// MIP/LP solver (COIN-BC or HiGHS) — NOT Gecode: Gecode's float branch-and-bound finds the optimum but
// its optimality PROOF does not terminate on these objectives. (The forward/chain models stay on Gecode.)

/** A knob the search may vary: a node's fixed config input, freed within a numeric domain. */
export interface Tunable {
  readonly node: NodeId;
  readonly key: Key;
  readonly min: number;
  readonly max: number;
}

/** What to optimize: a key at a node, minimized or maximized. With request classes declared, a NON-flow key
 *  (cost/latency) has no class-blind value — it lives per class — so `class` names WHICH class's value to read
 * off `out(node, key, class)`. Absent ⇒ the class-blind cell (a flow total / today).
 *
 *  `total` switches the objective from ONE node's cumulative out-cell to the WHOLE-GRAPH TOTAL of the key: the
 *  sum over every node of its LOCAL contribution `local(node, key)` — for a sum-aggregated key (e.g. a cost)
 *  that is the whole design's own spend, including branches no single out-cell accumulates (a cumulative
 *  out-cell only sums the paths INTO its node, so off-path branches are invisible to it). `node` then serves
 *  only as the read-back anchor; the solve objective is the sum of the local cells. Not supported together with
 *  request classes (a per-class local split is not modelled) — `optimizeModel` rejects that combination honestly. */
export interface Objective {
  readonly node: NodeId;
  readonly key: Key;
  readonly direction: 'min' | 'max';
  readonly class?: ClassId;
  readonly total?: boolean;
}

/**
 * Capacity HEADROOM: keep each SIZABLE tier's inflow(key) ≤ factor·self(key) — i.e. utilisation ρ ≤ factor —
 * so the solved design has finite queueing latency (offered load strictly below capacity), not the ρ=1
 * knife-edge that serves the load but with an unbounded queue. Generic over the flow `key`; the CALLER
 * (content) chooses the key + factor, so the engine stays domain-agnostic. Applied only where self(key) is a
 * sized var (a fixed tier has no knob to size, so it is left to the structural verdict).
 */
export interface Headroom {
  readonly key: Key;
  readonly factor: number;
}

/**
 * A SYSTEM band: a floor/ceiling on the WHOLE-GRAPH TOTAL of a sum-aggregated key — Σ over every node of its
 * LOCAL contribution `local(node, key)`, the exact sum a `total` {@link Objective} optimizes. This is how a
 * system-scoped promise (e.g. "the whole design costs ≤ 30,000 USD/month") enters the search as a HARD
 * constraint: a node band bounds one cumulative out-cell (a BRANCH's accumulated value, blind to off-path
 * branches); a system band bounds the sum of local cells, so an off-path branch's spend counts too. The caller
 * (content) declares which key + bounds — the engine stays domain-agnostic. Not supported together with request
 * classes (the per-class network does not model a class-blind local split) — rejected honestly, exactly like a
 * `total` objective.
 */
export interface SystemBand {
  readonly key: Key;
  readonly floor?: number;
  readonly ceiling?: number;
}

const inCellId = (n: NodeId, k: Key): CellId => `in:${n}:${k}`; // inflow(k) = offered load
const localCellId = (n: NodeId, k: Key): CellId => `local:${n}:${k}`; // self(k) = own capacity

/** Headroom constraints `offered ≤ factor·capacity` for every tier whose capacity (self(key)) is a sized var. */
function headroomConstraints(graph: Graph, c: Compiled, h: Headroom): string[] {
  const cs: string[] = [];
  for (const node of graph.nodes.values()) {
    const cap = localCellId(node.id, h.key);
    const off = inCellId(node.id, h.key);
    if (c.has(cap) && c.isVar(cap) && c.has(off)) cs.push(`constraint ${c.term(off)} <= ${num(h.factor)} * ${c.term(cap)};`);
  }
  return cs;
}

const num = (v: number): string => exprToMzn({ kind: 'num', value: v });

/** SYSTEM-band constraints `floor ≤ Σ local(node, key) ≤ ceiling` — the sum over every node's LOCAL contribution
 *  cell that materialised, the SAME cells a `total` objective sums (one truth: the verdict layer's whole-graph
 *  total, this constraint and the total objective all read Σ local). A design with no local cell for the key sums
 *  to the empty-sum 0 — honestly constrained (a floor > 0 is then infeasible, exactly as the verdict would read). */
function systemBandConstraints(graph: Graph, c: Compiled, bands: readonly SystemBand[]): string[] {
  const cs: string[] = [];
  for (const b of bands) {
    const terms: string[] = [];
    for (const node of graph.nodes.values()) {
      const localId = localCellId(node.id, b.key);
      if (c.has(localId)) terms.push(c.term(localId));
    }
    const sum = terms.length > 0 ? terms.join(' + ') : num(0);
    if (b.floor !== undefined) cs.push(`constraint ${sum} >= ${num(b.floor)};`);
    if (b.ceiling !== undefined) cs.push(`constraint ${sum} <= ${num(b.ceiling)};`);
  }
  return cs;
}

/** A finite bound for variable domains. Gecode's float branch-and-bound chokes on astronomically wide
 *  domains, so every solver variable gets a finite box — exact intervals where we can derive them. */
const BOUND = 1e9;

type Iv = readonly [number, number];

const fin = (x: number, fallback: number): number => (Number.isFinite(x) ? x : fallback);
const clampIv = (iv: Iv): Iv => [fin(iv[0], -BOUND), fin(iv[1], BOUND)];

/** Sound interval evaluation of an expression — over-approximates the reachable value set, so the true
 *  optimum is always inside the box it yields (acyclic only; refs must be evaluated deps-first). */
function evalInterval(e: Expr<CellId>, iv: (id: CellId) => Iv): Iv {
  switch (e.kind) {
    case 'num':
      return [e.value, e.value];
    case 'ref':
      return iv(e.key);
    case 'neg': {
      const [a, b] = evalInterval(e.arg, iv);
      return [-b, -a];
    }
    case 'binary': {
      const [a, b] = evalInterval(e.left, iv);
      const [c, d] = evalInterval(e.right, iv);
      switch (e.op) {
        case '+':
          return [a + c, b + d];
        case '-':
          return [a - d, b - c];
        case '*': {
          const p = [a * c, a * d, b * c, b * d];
          return [Math.min(...p), Math.max(...p)];
        }
        case '/': {
          if (c <= 0 && d >= 0) return [-Infinity, Infinity]; // denominator straddles 0
          const p = [a / c, a / d, b / c, b / d];
          return [Math.min(...p), Math.max(...p)];
        }
      }
      return [-Infinity, Infinity];
    }
    case 'call': {
      const ivs = e.args.map((a) => evalInterval(a, iv));
      const los = ivs.map((x) => x[0]);
      const his = ivs.map((x) => x[1]);
      return e.fn === 'min' ? [Math.min(...los), Math.min(...his)] : [Math.max(...los), Math.max(...his)];
    }
    case 'compare':
      return [0, 1];
  }
}

/** Rewrite the cell-id refs that survived constant folding (the variable cells) to MiniZinc names. */
function rewriteRefs(e: Expr<CellId>, name: (id: CellId) => string): Expr<CellId> {
  switch (e.kind) {
    case 'num':
      return e;
    case 'ref':
      return { kind: 'ref', key: name(e.key) };
    case 'neg':
      return { kind: 'neg', arg: rewriteRefs(e.arg, name) };
    case 'binary':
      return { kind: 'binary', op: e.op, left: rewriteRefs(e.left, name), right: rewriteRefs(e.right, name) };
    case 'call':
      return { kind: 'call', fn: e.fn, args: e.args.map((a) => rewriteRefs(a, name)) };
    case 'compare':
      return { kind: 'compare', op: e.op, left: rewriteRefs(e.left, name), right: rewriteRefs(e.right, name) };
  }
}

/**
 * Rewrite every processor-sharing split in a cell system to its headroom-region linear form. The split `served(N,K,C) = offered · cap / max(total, cap)` (build.ts psSplit) divides by a VARIABLE, so
 * a linear MIP cannot hold it; but on the class the native solver certifies it EQUALS `min(cap, offered)`:
 *  - single-class node (total ≡ offered): `offered·cap/max(offered,cap) = min(cap, offered)` — algebraically exact;
 *  - shared node, unsaturated (total ≤ cap ⇒ offered ≤ cap): `min(cap, offered) = offered = served` — exact.
 * Saturated shared nodes are OUTSIDE that class (native declines them); there `min(cap, offered)` is a proportional
 * over-estimate the MIP still solves. The rewrite preserves the capacity THROTTLE (min keeps the knob binding),
 * which a blanket `served = offered` would drop. Structural + precise: it matches ONLY the psSplit shape
 * `(X · ref(cap)) / max(…, ref(cap))` (the same `cap` ref in numerator and denominator), which build.ts alone emits. */
function linearizeFlowSplits(system: ReadonlyMap<CellId, Cell>): Map<CellId, Cell> {
  const out = new Map<CellId, Cell>();
  for (const [id, cell] of system) out.set(id, cell.kind === 'derived' ? { kind: 'derived', expr: linearizePsSplit(cell.expr) } : cell);
  return out;
}

/** Rewrite one expression's PS-split divisions to `min(cap, offered)` (see {@link linearizeFlowSplits}); recurses
 *  so a split nested inside a larger expression (e.g. a downstream fold) is caught too. */
function linearizePsSplit(e: Expr<CellId>): Expr<CellId> {
  switch (e.kind) {
    case 'num':
    case 'ref':
      return e;
    case 'neg':
      return { kind: 'neg', arg: linearizePsSplit(e.arg) };
    case 'binary': {
      const left = linearizePsSplit(e.left);
      const right = linearizePsSplit(e.right);
      // (offered · ref(cap)) / max(total, ref(cap))  ⇒  min(ref(cap), offered) — the same `cap` ref on both sides
      // is the psSplit signature (build.ts), so this cannot match an ordinary division or a batch transform (`x/n`).
      if (
        e.op === '/' &&
        left.kind === 'binary' &&
        left.op === '*' &&
        left.right.kind === 'ref' &&
        right.kind === 'call' &&
        right.fn === 'max' &&
        right.args.some((a) => a.kind === 'ref' && a.key === (left.right as Extract<Expr<CellId>, { kind: 'ref' }>).key)
      ) {
        return { kind: 'call', fn: 'min', args: [left.right, left.left] };
      }
      return { kind: 'binary', op: e.op, left, right };
    }
    case 'call':
      return { kind: 'call', fn: e.fn, args: e.args.map(linearizePsSplit) };
    case 'compare':
      return { kind: 'compare', op: e.op, left: linearizePsSplit(e.left), right: linearizePsSplit(e.right) };
  }
}

interface Compiled {
  readonly net: Network;
  readonly constants: ReadonlyMap<CellId, number>;
  readonly nameOf: ReadonlyMap<CellId, string>;
  readonly tunables: ReadonlyArray<{ node: NodeId; key: Key; cfg: CellId; name: string; current: number }>;
  readonly decls: readonly string[];
  readonly constraints: readonly string[];
  /** A MiniZinc term for a cell: its variable name, or its folded constant literal. */
  term(id: CellId): string;
  isVar(id: CellId): boolean;
  /** Whether the cell exists in the network at all (vs a never-materialised in:/local: id). */
  has(id: CellId): boolean;
}

/**
 * Shared front-end for the search modes: build the cell network, free the tunables, constant-fold
 * everything independent of them, and emit a `var` + equality constraint for each remaining cell.
 * ACYCLIC only — derived cells become equalities (uniquely determined). A cyclic dependency among the
 * free cells would need the post-fixpoint+minimize encoding, which conflicts with a cost
 * objective; that case is rejected honestly rather than solved wrongly.
 */
function compile(graph: Graph, registry: Registry, tunablesIn: readonly Tunable[], classes?: readonly RequestClass[]): Result<Compiled, readonly string[]> {
  const netR = buildNetwork(graph, registry, classes);
  if (!netR.ok) return netR;
  const net = netR.value;
  // Under request classes the flow served cells carry the PROCESSOR-SHARING split `offered·cap/max(total,cap)`
  // (build.ts psSplit) — a division by a VARIABLE (the max), which a linear MIP cannot express. Rewrite it to the
  // headroom-region form `min(cap, offered)`: EXACT wherever the search operates — a
  // single-class node's split IS `min(cap, offered)`, and a shared node in the unsaturated region (total ≤ cap ⇒
  // offered ≤ cap) has `min(cap, offered) = offered = served`, so the MIP and the JS psSplit AGREE on the whole
  // headroom class the native solver certifies. Saturated shared nodes (the non-monotone boundary) the native
  // solver DECLINES; there the linear `min` is a proportional over-estimate the MIP still SOLVES (never the false
  // infeasible), exactly as tail latency is a DES-measured truth the scalar only estimates. No-class systems have
  // no such cell, so the rewrite is a no-op and the single river projects byte-for-byte as before.
  const system = classes !== undefined && classes.length > 0 ? linearizeFlowSplits(net.system) : net.system;

  const tunableCfg = new Set<CellId>();
  const tunables: { node: NodeId; key: Key; cfg: CellId; name: string; current: number }[] = [];
  for (const t of tunablesIn) {
    const meta = net.metaOf(t.node, t.key);
    if (meta === undefined || meta.localKind !== 'config' || meta.local === null || meta.local.kind !== 'ref') {
      return { ok: false, error: [`tunable ${t.node}.${t.key} must be a fixed config input`] };
    }
    const cfg = meta.local.key;
    tunableCfg.add(cfg);
    const cell = system.get(cfg);
    const current = cell !== undefined && cell.kind === 'input' ? cell.value : NaN;
    tunables.push({ node: t.node, key: t.key, cfg, name: '', current });
  }

  // Constant-propagate everything EXCEPT the tunables; what remains depending on a tunable is a var.
  const constants = new Map<CellId, number>();
  for (const [id, cell] of system) if (cell.kind === 'input' && !tunableCfg.has(id)) constants.set(id, cell.value);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, cell] of system) {
      if (cell.kind !== 'derived' || constants.has(id)) continue;
      const f = simplify(cell.expr, (k) => constants.get(k as CellId));
      if (f.kind === 'num') {
        constants.set(id, f.value);
        changed = true;
      }
    }
  }

  const varIds = [...system.keys()].filter((id) => !constants.has(id)).sort();
  const nameOf = new Map<CellId, string>();
  varIds.forEach((id, i) => nameOf.set(id, `c${i}`));
  for (const t of tunables) {
    const n = nameOf.get(t.cfg);
    if (n === undefined) return { ok: false, error: [`tunable ${t.node}.${t.key} folded away unexpectedly`] };
    t.name = n;
  }

  // Cycle check among the variable derived cells (acyclic-only invariant).
  const tunByCfg = new Map<CellId, { min: number; max: number }>();
  tunablesIn.forEach((t, i) => {
    const cfg = tunables[i]?.cfg;
    if (cfg !== undefined) tunByCfg.set(cfg, { min: t.min, max: t.max });
  });
  const varDeps = new Map<CellId, CellId[]>();
  for (const id of varIds) {
    const cell = system.get(id) as Cell;
    if (cell.kind !== 'derived') {
      varDeps.set(id, []);
      continue;
    }
    const folded = simplify(cell.expr, (k) => constants.get(k as CellId));
    const refs = new Set<CellId>();
    collectVarRefs(folded, nameOf, refs);
    varDeps.set(id, [...refs]);
  }
  if (hasCycle(varDeps)) {
    return { ok: false, error: ['search over a cyclic flow is not supported in this slice'] };
  }

  const isVar = (id: CellId): boolean => nameOf.has(id);
  const term = (id: CellId): string => {
    const n = nameOf.get(id);
    if (n !== undefined) return n;
    return num(constants.get(id) ?? NaN);
  };

  // Tight finite domain per variable, by interval propagation over the tunable domains (deps-first).
  const interval = new Map<CellId, Iv>();
  const ivOf = (id: CellId): Iv => {
    const c = constants.get(id);
    if (c !== undefined) return [c, c];
    return interval.get(id) ?? [-BOUND, BOUND];
  };
  for (const [id, cell] of system) {
    if (constants.has(id)) continue;
    const tdom = tunByCfg.get(id);
    if (tdom !== undefined) {
      interval.set(id, [tdom.min, tdom.max]);
      continue;
    }
    if (cell.kind === 'derived') {
      interval.set(id, clampIv(evalInterval(simplify(cell.expr, (k) => constants.get(k as CellId)), ivOf)));
    }
  }

  const decls: string[] = [];
  const constraints: string[] = [];
  for (const id of varIds) {
    const dom = interval.get(id) ?? [-BOUND, BOUND];
    decls.push(`var ${num(dom[0])}..${num(dom[1])}: ${nameOf.get(id) as string};`);
    const tdom = tunByCfg.get(id);
    if (tdom !== undefined) continue; // a free knob — no defining constraint
    const cell = system.get(id) as Cell;
    if (cell.kind !== 'derived') return { ok: false, error: [`unexpected free input cell ${id}`] };
    const folded = simplify(cell.expr, (k) => constants.get(k as CellId));
    const expr = rewriteRefs(folded, (rid) => nameOf.get(rid) ?? num(constants.get(rid) ?? NaN));
    constraints.push(`constraint ${nameOf.get(id) as string} = ${exprToMzn(expr)};`);
  }

  return { ok: true, value: { net, constants, nameOf, tunables, decls, constraints, term, isVar, has: (id) => system.has(id) } };
}

function collectVarRefs(e: Expr<CellId>, nameOf: ReadonlyMap<CellId, string>, out: Set<CellId>): void {
  switch (e.kind) {
    case 'num':
      return;
    case 'ref': {
      const id = e.key;
      if (nameOf.has(id)) out.add(id);
      return;
    }
    case 'neg':
      collectVarRefs(e.arg, nameOf, out);
      return;
    case 'binary':
      collectVarRefs(e.left, nameOf, out);
      collectVarRefs(e.right, nameOf, out);
      return;
    case 'call':
      for (const a of e.args) collectVarRefs(a, nameOf, out);
      return;
    case 'compare':
      collectVarRefs(e.left, nameOf, out);
      collectVarRefs(e.right, nameOf, out);
      return;
    default:
      return assertNever(e);
  }
}

function hasCycle(deps: ReadonlyMap<CellId, readonly CellId[]>): boolean {
  const state = new Map<CellId, 1 | 2>();
  const onStack = new Set<CellId>();
  const stack: { id: CellId; i: number }[] = [];
  for (const root of deps.keys()) {
    if (state.has(root)) continue;
    stack.push({ id: root, i: 0 });
    onStack.add(root);
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { id: CellId; i: number };
      const d = deps.get(top.id) ?? [];
      if (top.i < d.length) {
        const next = d[top.i] as CellId;
        top.i += 1;
        if (onStack.has(next)) return true;
        if (!state.has(next)) {
          state.set(next, 1);
          stack.push({ id: next, i: 0 });
          onStack.add(next);
        }
      } else {
        state.set(top.id, 2);
        onStack.delete(top.id);
        stack.pop();
      }
    }
  }
  return false;
}

/** Every SCALAR band declared on a node, with its scope (for emitting SLO constraints). PERCENTILE (tail) bands
 *  are SKIPPED: a tail is not a value the linear forward model produces (its key may have no forward value at
 *  all, e.g. `tailLatency` ⇒ NaN), and a percentile cannot be a linear constraint — it is verified by the DES,
 *  not the MIP. The search instead earns a finite, sane tail through capacity HEADROOM (ρ ≤ factor). */
function bandsOf(graph: Graph): Array<{ node: NodeId; key: Key; band: Band }> {
  const out: Array<{ node: NodeId; key: Key; band: Band }> = [];
  for (const node of graph.nodes.values()) {
    for (const cell of node.cells) {
      if (cell.kind === 'input' && cell.value.kind === 'band' && cell.value.band.shape !== 'percentiles') {
        out.push({ node: node.id, key: cell.key, band: cell.value.band });
      }
    }
  }
  return out;
}

export interface OptimizeModel {
  readonly source: string;
  readonly tunables: ReadonlyArray<{ node: NodeId; key: Key; name: string }>;
  /** How to read out(node,key) from the solution: a solved variable, or a fixed constant. With request classes,
   *  pass `cls` to read that class's own value `out(node,key,class)` (a non-flow key has no class-blind value). */
  valueOf(node: NodeId, key: Key, cls?: ClassId): { kind: 'var'; name: string } | { kind: 'const'; value: number } | null;
}

/**
 * Project the graph to a MiniZinc model that OPTIMIZES `objective` subject to all declared bands as
 * HARD constraints, over the freed `tunables`. Solving it yields the tunable
 * assignment achieving the best objective that still satisfies every SLO; UNSAT ⇒ no assignment can
 * (use `relaxedModel` to explain why).
 */
export function optimizeModel(
  graph: Graph,
  registry: Registry,
  tunables: readonly Tunable[],
  objective: Objective,
  headroom?: Headroom,
  classes?: readonly RequestClass[],
  systemBands?: readonly SystemBand[],
): Result<OptimizeModel, readonly string[]> {
  // A TOTAL objective sums per-node LOCAL cells, which the per-class projection does not split — reject the
  // combination honestly rather than optimize a class-blind total that silently ignores the declared classes.
  if (objective.total === true && classes !== undefined && classes.length > 0) {
    return { ok: false, error: ['a total objective is not supported together with request classes'] };
  }
  // A SYSTEM band sums the same per-node LOCAL cells — the identical class-blindness, the identical honest refusal.
  if (systemBands !== undefined && systemBands.length > 0 && classes !== undefined && classes.length > 0) {
    return { ok: false, error: ['a system band is not supported together with request classes'] };
  }
  const c = compile(graph, registry, tunables, classes);
  if (!c.ok) return c;
  const { net, term, isVar, decls, constraints } = c.value;

  const bandConstraints: string[] = [];
  for (const b of bandsOf(graph)) bandConstraints.push(...hardBand(term(net.out(b.node, b.key)), b.band));
  bandConstraints.push(...systemBandConstraints(graph, c.value, systemBands ?? []));
  const headroomCs = headroom ? headroomConstraints(graph, c.value, headroom) : [];

  // The objective term(s). Single-cell (the default): one node's cumulative out-cell, exactly as before. TOTAL:
  // the sum of every node's LOCAL contribution `local(node, key)` — a plain linear sum the MIP handles natively.
  // Constant terms ride along as literals (they shift, never bend, the optimum); a totally-constant objective
  // (no term depends on a knob) degenerates to `satisfy`, mirroring the single-cell `isVar` gate.
  const objTerms: string[] = [];
  let objIsVar = false;
  if (objective.total === true) {
    for (const node of graph.nodes.values()) {
      const localId = localCellId(node.id, objective.key);
      if (!c.value.has(localId)) continue; // a node with no own contribution for this key adds nothing
      objTerms.push(term(localId));
      objIsVar = objIsVar || isVar(localId);
    }
  } else {
    const objId = net.out(objective.node, objective.key, objective.class);
    objTerms.push(term(objId));
    objIsVar = isVar(objId);
  }
  const solveLine = objIsVar
    ? `solve ${objective.direction === 'min' ? 'minimize' : 'maximize'} ${objTerms.join(' + ')};`
    : 'solve satisfy;';

  const source = `${[...decls, ...constraints, ...bandConstraints, ...headroomCs].join('\n')}\n${solveLine}\n`;
  const nameOf = c.value.nameOf;
  return {
    ok: true,
    value: {
      source,
      tunables: c.value.tunables.map((t) => ({ node: t.node, key: t.key, name: t.name })),
      valueOf: (node, key, cls) => {
        const id = net.out(node, key, cls);
        const n = nameOf.get(id);
        if (n !== undefined) return { kind: 'var', name: n };
        const v = c.value.constants.get(id);
        return v === undefined ? null : { kind: 'const', value: v };
      },
    },
  };
}

function hardBand(t: string, band: Band): string[] {
  switch (band.shape) {
    case 'minTargetMax': {
      const cs: string[] = [];
      if (band.min !== undefined) cs.push(`constraint ${t} >= ${num(band.min)};`);
      if (band.max !== undefined) cs.push(`constraint ${t} <= ${num(band.max)};`);
      return cs;
    }
    case 'point':
      return [`constraint ${t} = ${num(band.target)};`];
    case 'percentiles':
      return []; // a tail SLO needs the DES, not a scalar
  }
}

export interface RelaxedModel {
  readonly source: string;
  /** Each penalty variable measures by how much its band is missed (0 ⇒ satisfied). */
  readonly penalties: ReadonlyArray<{ node: NodeId; key: Key; bound: 'floor' | 'ceiling' | 'point'; name: string }>;
}

/**
 * The UNSAT explainer: re-encode every band as SOFT — a non-negative penalty makes up any
 * shortfall — and `minimize` the total penalty. A positive penalty in the solution names exactly which
 * SLO cannot be met and BY HOW MUCH, which the verdict layer turns into graded remediations. Strictly
 * more informative than a bare UNSAT or a boolean unsat-core.
 */
export function relaxedModel(
  graph: Graph,
  registry: Registry,
  tunables: readonly Tunable[],
  classes?: readonly RequestClass[],
): Result<RelaxedModel, readonly string[]> {
  const c = compile(graph, registry, tunables, classes);
  if (!c.ok) return c;
  const { net, term, decls, constraints } = c.value;

  const penaltyDecls: string[] = [];
  const penaltyConstraints: string[] = [];
  const penalties: { node: NodeId; key: Key; bound: 'floor' | 'ceiling' | 'point'; name: string }[] = [];
  let p = 0;
  const addPenalty = (node: NodeId, key: Key, bound: 'floor' | 'ceiling' | 'point', emit: (name: string) => string): void => {
    const name = `p${p++}`;
    penaltyDecls.push(`var 0.0..${num(BOUND)}: ${name};`);
    penaltyConstraints.push(emit(name));
    penalties.push({ node, key, bound, name });
  };

  for (const b of bandsOf(graph)) {
    const t = term(net.out(b.node, b.key));
    if (b.band.shape === 'minTargetMax') {
      const { min, max } = b.band;
      if (min !== undefined) addPenalty(b.node, b.key, 'floor', (n) => `constraint ${t} + ${n} >= ${num(min)};`);
      if (max !== undefined) addPenalty(b.node, b.key, 'ceiling', (n) => `constraint ${t} - ${n} <= ${num(max)};`);
    } else if (b.band.shape === 'point') {
      const target = b.band.target;
      addPenalty(b.node, b.key, 'point', (n) => `constraint ${t} + ${n} >= ${num(target)};`);
      addPenalty(b.node, b.key, 'point', (n) => `constraint ${t} - ${n} <= ${num(target)};`);
    }
  }

  const objective = penalties.length === 0 ? 'satisfy' : `minimize ${penalties.map((x) => x.name).join(' + ')}`;
  const source = `${[...decls, ...constraints, ...penaltyDecls, ...penaltyConstraints].join('\n')}\nsolve ${objective};\n`;
  return { ok: true, value: { source, penalties } };
}

export interface RepairModel {
  readonly source: string;
  readonly tunables: ReadonlyArray<{ node: NodeId; key: Key; name: string; current: number }>;
}

/**
 * The `repair` mode: given a graph that violates its SLOs, find the MINIMAL change to the
 * tunables that makes every band hold — minimize the L1 distance from the current configuration
 * (Σ|new − current|) subject to all bands as hard constraints. Answers "what is the smallest edit that
 * fixes this design", not "what is the cheapest design".
 */
export function repairModel(graph: Graph, registry: Registry, tunables: readonly Tunable[], headroom?: Headroom, classes?: readonly RequestClass[], systemBands?: readonly SystemBand[]): Result<RepairModel, readonly string[]> {
  // A SYSTEM band sums per-node LOCAL cells the per-class network does not split — the same honest refusal as
  // a `total` objective under classes (optimizeModel above).
  if (systemBands !== undefined && systemBands.length > 0 && classes !== undefined && classes.length > 0) {
    return { ok: false, error: ['a system band is not supported together with request classes'] };
  }
  const c = compile(graph, registry, tunables, classes);
  if (!c.ok) return c;
  const { net, term, decls, constraints } = c.value;

  const bandConstraints: string[] = [];
  for (const b of bandsOf(graph)) bandConstraints.push(...hardBand(term(net.out(b.node, b.key)), b.band));
  bandConstraints.push(...systemBandConstraints(graph, c.value, systemBands ?? []));
  const headroomCs = headroom ? headroomConstraints(graph, c.value, headroom) : [];

  const deltaDecls: string[] = [];
  const deltaConstraints: string[] = [];
  for (const t of c.value.tunables) {
    const d = `delta_${t.name}`;
    deltaDecls.push(`var 0.0..${num(BOUND)}: ${d};`);
    deltaConstraints.push(`constraint ${t.name} - ${num(t.current)} <= ${d};`);
    deltaConstraints.push(`constraint ${num(t.current)} - ${t.name} <= ${d};`);
  }
  const objective =
    c.value.tunables.length === 0 ? 'satisfy' : `minimize ${c.value.tunables.map((t) => `delta_${t.name}`).join(' + ')}`;
  const source = `${[...decls, ...constraints, ...bandConstraints, ...headroomCs, ...deltaDecls, ...deltaConstraints].join('\n')}\nsolve ${objective};\n`;
  return {
    ok: true,
    value: { source, tunables: c.value.tunables.map((t) => ({ node: t.node, key: t.key, name: t.name, current: t.current })) },
  };
}

// The tunables RELEVANT to a search: those whose config cell the engine can reach, in the cell network, from
// any of the `targets` — the objective cell AND every currently-violated band. A knob reachable from neither
// is a free MIP variable (it sits in constraints with slack and has no gradient on the objective), and cbc
// branch-and-bounds such variables forever proving an optimum any value satisfies — the 319 s hang. Pruning
// them is sound: an objective-irrelevant knob whose every band already holds can stay at its current value
// (optimum-preserving), and a knob that COULD relax a violated band is, by construction, reachable from that
// band's cell, so it is kept. Per target we follow `in:N:<targetKey>` (how that quantity aggregates up the
// path) but STOP at `in:N:<otherKey>` — an offered-load inflow of another key is the fixed/raise-only
// workload, not a lever (else a pay-per-use `cost = inflow(throughput)·unitCost` would reach upstream
// throughput configs through the min-capacity chain). Falls back to ALL tunables if the network can't build.
export function reachableTunables(
  graph: Graph,
  registry: Registry,
  tunables: readonly Tunable[],
  objective: { readonly node: NodeId; readonly key: Key; readonly total?: boolean },
  violatedBands: ReadonlyArray<{ readonly node: NodeId; readonly key: Key }>,
  systemBands?: readonly SystemBand[],
): readonly Tunable[] {
  const netR = buildNetwork(graph, registry);
  if (!netR.ok) return tunables;
  const system = netR.value.system;
  const refsOf = (e: Expr<CellId>, out: Set<CellId>): void => {
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
  };
  const relevant = new Set<CellId>(); // config cells reachable from some target

  // `followInSuffix` = the only `in:` (cross-edge) key we chase. For the OBJECTIVE we chase `in:*:<objKey>`
  // (that is how the objective sums/mins up the path). For a VIOLATED BAND we chase NO `in:*` (null): the band
  // is relaxed by the node's OWN knobs and the pull of its downstream CONSUMER (a `down:`/outflow ref, which is
  // NOT an `in:` cell, so it IS followed) — the carried part of an aggregated band (e.g. overflow's `max`) is a
  // DIFFERENT node's violation and so its own target, which is why we never chase the inflow carry here.
  const explore = (start: CellId, followInSuffix: string | null): void => {
    const visited = new Set<CellId>();
    const stack: CellId[] = [start];
    while (stack.length > 0) {
      const id = stack.pop() as CellId;
      if (visited.has(id)) continue;
      visited.add(id);
      if (String(id).startsWith('cfg:')) relevant.add(id);
      const cell = system.get(id);
      if (cell !== undefined && cell.kind === 'derived') {
        const r = new Set<CellId>();
        refsOf(cell.expr, r);
        for (const x of r) {
          if (String(x).startsWith('in:') && (followInSuffix === null || !String(x).endsWith(followInSuffix))) continue;
          if (!visited.has(x)) stack.push(x);
        }
      }
    }
  };

  if (objective.total === true) {
    // A TOTAL objective is Σ over nodes of `local:N:<key>` — every node's own contribution is a target, so a knob
    // feeding ANY node's local cell (an off-path branch's sizing included) survives the prune. Same in-chase rule
    // as the single-cell objective (follow `in:*:<objKey>`, stop at other keys — the workload is not a lever).
    for (const node of graph.nodes.values()) {
      const local = `local:${String(node.id)}:${String(objective.key)}` as CellId;
      if (system.has(local)) explore(local, ':' + String(objective.key));
    }
  } else {
    explore(netR.value.out(objective.node, objective.key), ':' + String(objective.key));
  }
  for (const b of violatedBands) {
    const local = `local:${String(b.node)}:${String(b.key)}`; // the node's OWN contribution
    explore(system.has(local) ? local : netR.value.out(b.node, b.key), null);
  }
  // A SYSTEM band is Σ over nodes of `local:N:<key>` — every node's own contribution sits inside the constraint,
  // so a knob feeding ANY of those local cells is a lever on it (an off-path priced knob can buy budget headroom
  // for the objective's knobs) and must survive the prune. Same exploration a `total` objective performs.
  for (const b of systemBands ?? []) {
    for (const node of graph.nodes.values()) {
      const local = `local:${String(node.id)}:${String(b.key)}` as CellId;
      if (system.has(local)) explore(local, ':' + String(b.key));
    }
  }

  const cfgId = (t: Tunable): CellId => `cfg:${String(t.node)}:${String(t.key)}`;
  return tunables.filter((t) => relevant.has(cfgId(t)));
}
