import type { Expr } from '../relation';

/** Format a JS number as a MiniZinc float literal (real arithmetic ⇒ matches the JS evaluator). */
function numToMzn(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`cannot project non-finite value ${v} to MiniZinc`);
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

const cmpToMzn: Record<'<=' | '<' | '>=' | '>' | '==', string> = {
  '<=': '<=',
  '<': '<',
  '>=': '>=',
  '>': '>',
  '==': '=',
};

/** Emit a relation expression as MiniZinc syntax. The numeric projector targets MiniZinc only. Generic over the
 *  ref type: refs are already MiniZinc identifiers by emit time (a Key name, or a rewritten cell name). */
export function exprToMzn<R>(e: Expr<R>): string {
  switch (e.kind) {
    case 'num':
      return numToMzn(e.value);
    case 'ref':
      return String(e.key);
    case 'neg':
      return `(-${exprToMzn(e.arg)})`;
    case 'binary':
      return `(${exprToMzn(e.left)} ${e.op} ${exprToMzn(e.right)})`;
    case 'call':
      return `${e.fn}([${e.args.map((a) => exprToMzn(a)).join(', ')}])`;
    case 'compare':
      return `bool2int(${exprToMzn(e.left)} ${cmpToMzn[e.op]} ${exprToMzn(e.right)})`;
  }
}

/**
 * A MiniZinc model for FORWARD evaluation: every referenced key is fixed to its env value and
 * `result` is constrained to the expression. Solving it must yield the same value as the JS
 * evaluator — the differential contract (doc-4 §5). Uses a `var` + `constraint` so `result` is a
 * real output variable (a `=`-defined float is folded to a parameter and not emitted).
 */
export function forwardModel(expr: Expr, env: Readonly<Record<string, number>>): string {
  const decls = Object.entries(env)
    .map(([k, v]) => `float: ${k} = ${numToMzn(v)};`)
    .join('\n');
  return `${decls}\nvar float: result;\nconstraint result = ${exprToMzn(expr)};\nsolve satisfy;\n`;
}
