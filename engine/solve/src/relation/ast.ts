import type { Key } from '@sda/engine-core';

/**
 * The relation expression AST — a small, readable arithmetic/comparison subset (doc-4 §10).
 * Authored once per relation; evaluated forward by the JS evaluator (hot path) and, later, emitted
 * to MiniZinc (cold). Semantics: real arithmetic; comparisons yield 1 (true) or 0 (false).
 */
// Parameterised by the reference type `R`: the relation LANGUAGE authors refs by registry `Key` (the default,
// `Expr` = `Expr<Key>`), while the cell-network / MiniZinc projection layers rewrite those into `Expr<CellId>`
// (a ref per concrete cell). Keeping `R` in the type means the projection is a real `Expr<Key>→Expr<CellId>`
// mapping instead of smuggling a CellId through the Key field with `as unknown as`.
export type Expr<R = Key> =
  | { readonly kind: 'num'; readonly value: number }
  // a key reference. `inflow` ⇒ the value flowing IN from upstream (offered); `outflow` ⇒ the value
  // pulled by DOWNSTREAM consumers (demand/drain); `self` ⇒ this node's OWN local value (its relation/
  // config, e.g. its capacity — before the incoming is combined in). None set ⇒ own config, else incoming.
  | { readonly kind: 'ref'; readonly key: R; readonly inflow?: boolean; readonly outflow?: boolean; readonly self?: boolean }
  | { readonly kind: 'neg'; readonly arg: Expr<R> }
  | { readonly kind: 'binary'; readonly op: '+' | '-' | '*' | '/'; readonly left: Expr<R>; readonly right: Expr<R> }
  | { readonly kind: 'call'; readonly fn: 'min' | 'max'; readonly args: readonly Expr<R>[] }
  | { readonly kind: 'compare'; readonly op: '<=' | '<' | '>=' | '>' | '=='; readonly left: Expr<R>; readonly right: Expr<R> };
