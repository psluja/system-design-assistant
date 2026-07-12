// @algorithm Forward AST evaluation (the reference numeric semantics)
// @problem One expression tree must mean exactly one number everywhere: the JS hot path, the MiniZinc
//   projection and the GPU bytecode all claim to compute "the same" value, so a single reference
//   evaluator has to define that value.
// @approach Recursive tree walk in IEEE-754 float64; comparisons yield 1/0; generic over the ref type
//   R so the identical evaluator serves Expr<Key> (relations) and Expr<CellId> (the cell network).
// @complexity O(nodes) per expression.
// @citations None (elementary tree interpretation); IEEE 754 determinism is the load-bearing fact.
// @invariants Deterministic per IEEE-754; total for well-formed ASTs; it IS the differential
//   reference — MiniZinc projection and fp32 bytecode are tested to agree with it.
// @where-tested engine/solve/src/relation/relation.test.ts,
//   engine/solve/src/minizinc/differential.test.ts, engine/solver-contract/src/gpu/differential.test.ts

import type { Key } from '@sda/engine-core';
import type { Expr } from './ast';

/** Resolves a reference to its current numeric value. Parameterised by the ref type: a registry `Key` in a
 *  relation (the default), or a `CellId` when evaluating the cell network — the same evaluator serves both. */
export type Env<R = Key> = (ref: R) => number;

/**
 * Evaluate a relation expression forward. Real (float64) arithmetic — deterministic per IEEE-754.
 * Comparisons yield 1 (true) or 0 (false). This is the hot-path primitive; the MiniZinc projector
 * must match this semantics exactly (the differential contract). Generic over the ref type `R`
 * so it evaluates both `Expr<Key>` (relations) and `Expr<CellId>` (the cell network) without any cast.
 */
export function evalExpr<R>(e: Expr<R>, env: Env<R>): number {
  switch (e.kind) {
    case 'num':
      return e.value;
    case 'ref':
      return env(e.key);
    case 'neg':
      return -evalExpr(e.arg, env);
    case 'binary':
      return binary(e.op, evalExpr(e.left, env), evalExpr(e.right, env));
    case 'call': {
      const vs = e.args.map((a) => evalExpr(a, env));
      return e.fn === 'min' ? Math.min(...vs) : Math.max(...vs);
    }
    case 'compare':
      return compare(e.op, evalExpr(e.left, env), evalExpr(e.right, env)) ? 1 : 0;
  }
}

function binary(op: '+' | '-' | '*' | '/', l: number, r: number): number {
  switch (op) {
    case '+':
      return l + r;
    case '-':
      return l - r;
    case '*':
      return l * r;
    case '/':
      return l / r;
  }
}

function compare(op: '<=' | '<' | '>=' | '>' | '==', l: number, r: number): boolean {
  switch (op) {
    case '<=':
      return l <= r;
    case '<':
      return l < r;
    case '>=':
      return l >= r;
    case '>':
      return l > r;
    case '==':
      return l === r;
  }
}
