// @algorithm Constant folding + Knaster-Tarski least-fixpoint MiniZinc encoding
// @problem The JS solver's cyclic cell systems must be certified by an independent solver, but a
//   finite MiniZinc float cannot hold the +/-Infinity identities empty min/max aggregations carry.
// @approach Constant-propagate to a fixpoint, inlining known cells and applying aggregation
//   identities (min(x,+inf)=x, x+0, x*1, ...) so the infinities vanish structurally; project the
//   cyclic residue to a model where each variable carries the post-fixpoint inequality F(t) <= t and
//   the objective minimizes their sum — by Knaster-Tarski the optimum of a monotone F is its least
//   fixpoint, i.e. exactly the Kleene answer.
// @complexity Folding iterates to a fixpoint over cells: O(passes * cells * expr size); model size
//   linear in the un-folded residue.
// @citations Knaster-Tarski fixed-point theorem (Tarski 1955); Kleene iteration equivalence for
//   monotone maps; standard compiler constant propagation.
// @invariants Folding preserves semantics exactly (pure-numeric subtrees folded through evalExpr,
//   the reference evaluator); the encoding's optimum equals the JS least fixpoint (differential-
//   tested forward and on chains).
// @where-tested engine/solve/src/minizinc/chain.test.ts,
//   engine/solve/src/minizinc/chain.property.test.ts, engine/solve/src/minizinc/differential.test.ts

import type { Cell, CellId } from '../fixpoint';
import { evalExpr, type Env, type Expr } from '../relation';
import { exprToMzn } from './project';

const never: Env<CellId> = () => {
  throw new Error('numeric fold referenced a variable');
};
const isNum = (e: Expr<CellId>, v: number): boolean => e.kind === 'num' && e.value === v;

/**
 * Constant-fold a cell expression, inlining known constants (`lookup`) and applying the aggregation
 * identities (`min(x,+∞)=x`, `max(x,−∞)=x`, `x+0`, `x*1`, …). This is what lets the chain project to
 * MiniZinc at all: the JS solver represents an empty min/max aggregation as ±Infinity, which a finite
 * MiniZinc float cannot hold — folding removes those identities structurally instead of inventing a
 * sentinel. Pure-numeric subexpressions are folded through `evalExpr` so the semantics stay identical.
 */
export function simplify(e: Expr<CellId>, lookup: (id: string) => number | undefined): Expr<CellId> {
  switch (e.kind) {
    case 'num':
      return e;
    case 'ref': {
      const v = lookup(e.key);
      return v === undefined ? e : { kind: 'num', value: v };
    }
    case 'neg': {
      const a = simplify(e.arg, lookup);
      return a.kind === 'num' ? { kind: 'num', value: -a.value } : { kind: 'neg', arg: a };
    }
    case 'binary': {
      const l = simplify(e.left, lookup);
      const r = simplify(e.right, lookup);
      if (l.kind === 'num' && r.kind === 'num') {
        return { kind: 'num', value: evalExpr({ kind: 'binary', op: e.op, left: l, right: r }, never) };
      }
      if (e.op === '+') {
        if (isNum(r, 0)) return l;
        if (isNum(l, 0)) return r;
      } else if (e.op === '-') {
        if (isNum(r, 0)) return l;
      } else if (e.op === '*') {
        if (isNum(r, 1)) return l;
        if (isNum(l, 1)) return r;
      } else if (e.op === '/') {
        if (isNum(r, 1)) return l;
      }
      return { kind: 'binary', op: e.op, left: l, right: r };
    }
    case 'call': {
      const args = e.args.map((a) => simplify(a, lookup));
      const ident = e.fn === 'min' ? Infinity : -Infinity;
      const nums: number[] = [];
      const rest: Expr<CellId>[] = [];
      for (const a of args) {
        if (a.kind === 'num') nums.push(a.value);
        else rest.push(a);
      }
      const numFold = nums.length > 0 ? (e.fn === 'min' ? Math.min(...nums) : Math.max(...nums)) : ident;
      if (rest.length === 0) return { kind: 'num', value: numFold };
      const finalArgs = numFold === ident ? rest : [...rest, { kind: 'num', value: numFold } as Expr<CellId>];
      return finalArgs.length === 1 ? (finalArgs[0] as Expr<CellId>) : { kind: 'call', fn: e.fn, args: finalArgs };
    }
    case 'compare': {
      const l = simplify(e.left, lookup);
      const r = simplify(e.right, lookup);
      if (l.kind === 'num' && r.kind === 'num') {
        return { kind: 'num', value: evalExpr({ kind: 'compare', op: e.op, left: l, right: r }, never) };
      }
      return { kind: 'compare', op: e.op, left: l, right: r };
    }
  }
}

/** Rewrite the cell-id refs that survived folding (the variable cells) to their MiniZinc names. */
function rewriteRefs(e: Expr<CellId>, name: (id: string) => string): Expr<CellId> {
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

function assertFinite(e: Expr<CellId>, id: CellId): void {
  switch (e.kind) {
    case 'num':
      if (!Number.isFinite(e.value)) {
        throw new Error(`chain projection: variable cell "${id}" retains non-finite literal ${e.value}`);
      }
      return;
    case 'ref':
      return;
    case 'neg':
      return assertFinite(e.arg, id);
    case 'binary':
      assertFinite(e.left, id);
      assertFinite(e.right, id);
      return;
    case 'call':
      e.args.forEach((a) => assertFinite(a, id));
      return;
    case 'compare':
      assertFinite(e.left, id);
      assertFinite(e.right, id);
      return;
  }
}

/** A whole-chain MiniZinc model plus the maps to read its solution back into cell terms. */
export interface ChainModel {
  /** The model text, or null when the system is fully constant (no fixpoint to solve). */
  readonly source: string | null;
  /** Variable cells → their MiniZinc identifier (`v0`, `v1`, …). */
  readonly varOf: ReadonlyMap<CellId, string>;
  /** Cells the projector resolved to constants (inputs + acyclic derivations), inlined into the model. */
  readonly constants: ReadonlyMap<CellId, number>;
}

/**
 * Project a cell system to a single MiniZinc model that computes its LEAST fixpoint (doc-4 §3a).
 *
 * Acyclic cells fold to constants (and are inlined); only genuine cyclic cells become variables. Each
 * variable carries the post-fixpoint inequality `F(t) ≤ t` (encoded `expr <= cell`) and the model
 * `minimize`s their sum. By Knaster–Tarski, the minimum post-fixpoint of a monotone F is its least
 * fixpoint — the same steady state the JS Kleene-from-⊥ solver lands on. The variable domain starts at
 * 0 to mirror the JS solver's `bottom = 0`; `=`-via-`minimize` would also admit spurious fixpoints,
 * which the minimization discards.
 */
export function chainModel(system: ReadonlyMap<CellId, Cell>): ChainModel {
  const constants = new Map<CellId, number>();
  for (const [id, cell] of system) if (cell.kind === 'input') constants.set(id, cell.value);

  // Constant propagation to a fixpoint: a derived cell whose expr folds to a number is constant.
  // What never folds is exactly the cyclic part — those stay variables.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, cell] of system) {
      if (cell.kind !== 'derived' || constants.has(id)) continue;
      const folded = simplify(cell.expr, (k) => constants.get(k as CellId));
      if (folded.kind === 'num') {
        constants.set(id, folded.value);
        changed = true;
      }
    }
  }

  const varIds = [...system.keys()]
    .filter((id) => system.get(id)?.kind === 'derived' && !constants.has(id))
    .sort();
  const varOf = new Map<CellId, string>();
  varIds.forEach((id, i) => varOf.set(id, `v${i}`));
  if (varIds.length === 0) return { source: null, varOf, constants };

  const name = (id: string): string => {
    const n = varOf.get(id as CellId);
    if (n === undefined) throw new Error(`chain projection: unresolved reference "${id}"`);
    return n;
  };

  const decls: string[] = [];
  const constraints: string[] = [];
  for (const id of varIds) {
    const cell = system.get(id);
    if (cell === undefined || cell.kind !== 'derived') continue;
    const folded = simplify(cell.expr, (k) => constants.get(k as CellId));
    assertFinite(folded, id);
    const expr = rewriteRefs(folded, name);
    const v = varOf.get(id) as string;
    // Non-negative domain mirrors solve()'s bottom = 0; the post-fixpoint constraint lower-bounds it.
    decls.push(`var 0.0..1.0e15: ${v};`);
    constraints.push(`constraint ${exprToMzn(expr)} <= ${v};`);
  }
  const objective = varIds.map((id) => varOf.get(id) as string).join(' + ');
  const source = `${decls.join('\n')}\n${constraints.join('\n')}\nsolve minimize ${objective};\n`;
  return { source, varOf, constants };
}
