/// <reference path="./datascript.d.ts" />
// engine/solve — the numeric core: the relation language + JS evaluator (hot path), and (next)
// the cell-network constructor + least-fixpoint iterator. Pure TS; the differential reference
// the MiniZinc projection must agree with (doc-4 §3, §5).
export * from './relation';
export * from './fixpoint';
export * from './network';
export * from './verdict';
export * from './engine';
export * from './minizinc';
export * from './legality';
export * from './guarantee';
export * from './facade';
