// @algorithm Recursive-descent parser for the relation expression language
// @problem Manifests declare numeric semantics as expression STRINGS (the closed framework's only
//   formula surface); they must become a typed AST totally — bad input yields a Result error with
//   position, never a throw or a partial parse.
// @approach Hand-written tokenizer + recursive-descent / precedence-climbing parser (compare -> add
//   -> mul -> unary -> primary, with min/max/inflow/outflow/self call forms); a typed ParseError is
//   used internally and converted to Result at the boundary.
// @complexity O(n) in source length (single token stream pass, no backtracking).
// @citations Standard precedence-climbing / recursive-descent construction (e.g. Norvell 1999;
//   Crenshaw's tradition); grammar is the module's own.
// @invariants Total (never throws to callers); whole-input consumption enforced (expectEnd);
//   deterministic single parse tree per input.
// @where-tested engine/solve/src/relation/relation.test.ts

import type { Key, Result } from '@sda/engine-core';
import type { Expr } from './ast';

/**
 * Parse a relation expression into an AST. Total: returns a Result; never throws to callers.
 * (A typed ParseError is used internally for control flow and converted at the boundary.)
 */
export function parse(src: string): Result<Expr, string> {
  try {
    const parser = new Parser(tokenize(src));
    const expr = parser.parseExpr();
    parser.expectEnd();
    return { ok: true, value: expr };
  } catch (e) {
    return { ok: false, error: e instanceof ParseError ? e.message : String(e) };
  }
}

class ParseError extends Error {}

type Cmp = '<=' | '<' | '>=' | '>' | '==';
type Punct = '+' | '-' | '*' | '/' | '(' | ')' | ',';
type Tok =
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'punct'; v: Punct }
  | { t: 'cmp'; v: Cmp };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let i = 0;
  const isDigit = (c: string): boolean => c >= '0' && c <= '9';
  const isIdStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isIdPart = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

  while (i < n) {
    const c = src.charAt(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
    } else if (isDigit(c) || (c === '.' && isDigit(src.charAt(i + 1)))) {
      let j = i + 1;
      while (j < n && (isDigit(src.charAt(j)) || src.charAt(j) === '.')) j += 1;
      const s = src.slice(i, j);
      const v = Number(s);
      if (!Number.isFinite(v)) throw new ParseError(`bad number "${s}"`);
      toks.push({ t: 'num', v });
      i = j;
    } else if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src.charAt(j))) j += 1;
      toks.push({ t: 'id', v: src.slice(i, j) });
      i = j;
    } else if (c === '<' || c === '>') {
      if (src.charAt(i + 1) === '=') {
        toks.push({ t: 'cmp', v: `${c}=` as Cmp });
        i += 2;
      } else {
        toks.push({ t: 'cmp', v: c as Cmp });
        i += 1;
      }
    } else if (c === '=') {
      if (src.charAt(i + 1) === '=') {
        toks.push({ t: 'cmp', v: '==' });
        i += 2;
      } else {
        throw new ParseError('single "=" is not valid (use "==")');
      }
    } else if (c === '+' || c === '-' || c === '*' || c === '/' || c === '(' || c === ')' || c === ',') {
      toks.push({ t: 'punct', v: c });
      i += 1;
    } else {
      throw new ParseError(`unexpected character "${c}"`);
    }
  }
  return toks;
}

// Recursive-descent / precedence-climbing parser.
class Parser {
  private pos = 0;
  constructor(private readonly toks: readonly Tok[]) {}

  parseExpr(): Expr {
    return this.parseCompare();
  }

  expectEnd(): void {
    if (this.pos !== this.toks.length) throw new ParseError('unexpected trailing input');
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  private take(): Tok {
    const t = this.toks[this.pos];
    if (t === undefined) throw new ParseError('unexpected end of input');
    this.pos += 1;
    return t;
  }

  private parseCompare(): Expr {
    const left = this.parseAdd();
    const t = this.peek();
    if (t !== undefined && t.t === 'cmp') {
      this.pos += 1;
      return { kind: 'compare', op: t.v, left, right: this.parseAdd() };
    }
    return left;
  }

  private parseAdd(): Expr {
    let left = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t !== undefined && t.t === 'punct' && (t.v === '+' || t.v === '-')) {
        this.pos += 1;
        left = { kind: 'binary', op: t.v, left, right: this.parseMul() };
      } else {
        return left;
      }
    }
  }

  private parseMul(): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t !== undefined && t.t === 'punct' && (t.v === '*' || t.v === '/')) {
        this.pos += 1;
        left = { kind: 'binary', op: t.v, left, right: this.parseUnary() };
      } else {
        return left;
      }
    }
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t !== undefined && t.t === 'punct' && t.v === '-') {
      this.pos += 1;
      return { kind: 'neg', arg: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.take();
    if (t.t === 'num') return { kind: 'num', value: t.v };
    if (t.t === 'id') {
      if (t.v === 'min' || t.v === 'max') {
        const open = this.peek();
        if (open !== undefined && open.t === 'punct' && open.v === '(') {
          this.pos += 1;
          return { kind: 'call', fn: t.v, args: this.parseArgs() };
        }
      }
      if (t.v === 'inflow' || t.v === 'outflow' || t.v === 'self') {
        const open = this.peek();
        if (open !== undefined && open.t === 'punct' && open.v === '(') {
          this.pos += 1;
          const id = this.take();
          if (id.t !== 'id') throw new ParseError(`${t.v}() expects a key name`);
          const close = this.take();
          if (!(close.t === 'punct' && close.v === ')')) throw new ParseError(`expected ")" after ${t.v}(key)`);
          if (t.v === 'inflow') return { kind: 'ref', key: id.v as Key, inflow: true };
          if (t.v === 'outflow') return { kind: 'ref', key: id.v as Key, outflow: true };
          return { kind: 'ref', key: id.v as Key, self: true };
        }
      }
      // Any OTHER identifier immediately followed by "(" is a call to a function that does not exist
      // (sqrt, abs, pow, or a typo like mni). Without this check the identifier would parse as a key
      // reference and the "(" would only die later as a generic "unexpected trailing input". Fail here
      // instead, naming the token and the closed callable set, so the author can self-correct — the one
      // guided form documented in
      const open = this.peek();
      if (open !== undefined && open.t === 'punct' && open.v === '(') {
        throw new ParseError(`unknown function "${t.v}" (the only callables are min, max, inflow, outflow, self)`);
      }
      return { kind: 'ref', key: t.v as Key };
    }
    if (t.t === 'punct' && t.v === '(') {
      const inner = this.parseExpr();
      const close = this.take();
      if (!(close.t === 'punct' && close.v === ')')) throw new ParseError('expected ")"');
      return inner;
    }
    throw new ParseError('unexpected token');
  }

  private parseArgs(): Expr[] {
    const args: Expr[] = [this.parseExpr()]; // at least one argument
    for (;;) {
      const t = this.take();
      if (t.t === 'punct' && t.v === ')') return args;
      if (t.t === 'punct' && t.v === ',') {
        args.push(this.parseExpr());
      } else {
        throw new ParseError('expected "," or ")" in argument list');
      }
    }
  }
}
