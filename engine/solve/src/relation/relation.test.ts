import { describe, expect, it } from 'vitest';
import { parse } from './parse';
import { evalExpr, type Env } from './evaluate';
import type { Key } from '@sda/engine-core';

function ev(src: string, vars: Record<string, number>): number {
  const r = parse(src);
  if (!r.ok) throw new Error(`parse failed for ${JSON.stringify(src)}: ${r.error}`);
  const env: Env = (k: Key) => {
    const v = vars[k as string];
    if (v === undefined) throw new Error(`unbound key ${String(k)}`);
    return v;
  };
  return evalExpr(r.value, env);
}

describe('relation language', () => {
  it('evaluates the Lambda throughput relation', () => {
    expect(ev('concurrency / (perRequestDuration / 1000)', { concurrency: 20, perRequestDuration: 200 })).toBe(100);
  });

  it('evaluates backpressure min(C, max(R, t)) in both regimes (matches the spike)', () => {
    expect(ev('min(C, max(R, t))', { C: 7, R: 3, t: 5 })).toBe(5);
    expect(ev('min(C, max(R, t))', { C: 3, R: 7, t: 5 })).toBe(3);
  });

  it('respects operator precedence and parentheses', () => {
    expect(ev('2 + 3 * 4', {})).toBe(14);
    expect(ev('(2 + 3) * 4', {})).toBe(20);
    expect(ev('-2 + 3', {})).toBe(1);
  });

  it('evaluates comparisons to 1 / 0', () => {
    expect(ev('100 >= 50', {})).toBe(1);
    expect(ev('100 >= 400', {})).toBe(0);
  });

  it('supports variadic min / max', () => {
    expect(ev('min(5, 3, 9)', {})).toBe(3);
    expect(ev('max(5, 3, 9)', {})).toBe(9);
  });

  it('returns an error result (never throws) on malformed input', () => {
    expect(parse('2 +').ok).toBe(false);
    expect(parse('min()').ok).toBe(false);
    expect(parse('(1 + 2').ok).toBe(false);
    expect(parse('1 = 2').ok).toBe(false);
  });

  // An unknown function call used to die as the generic "unexpected trailing input" (the identifier
  // parsed as a key reference and the "(" trailed) — misleading for sqrt/abs/pow and for a typo'd
  // builtin. The parser now fails at the "(" with ONE guided form: name the token, list the closed
  // callable set (documented in).
  it('guides an unknown function call: names the token and lists the supported callables', () => {
    for (const [src, name] of [
      ['sqrt(x)', 'sqrt'],
      ['abs(x)', 'abs'],
      ['mni(C, max(R, t))', 'mni'], // a typo'd builtin gets the same guidance
    ] as const) {
      const r = parse(src);
      expect(r.ok, src).toBe(false);
      if (!r.ok) {
        expect(r.error, src).toBe(`unknown function "${name}" (the only callables are min, max, inflow, outflow, self)`);
      }
    }
    // The guidance fires only on a call: a bare identifier still parses as an ordinary key reference,
    // and the real callables are untouched.
    expect(ev('sqrt + 1', { sqrt: 4 })).toBe(5);
    expect(ev('min(2, 3)', {})).toBe(2);
  });
});
