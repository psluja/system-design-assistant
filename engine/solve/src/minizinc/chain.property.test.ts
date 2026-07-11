import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Key } from '@sda/engine-core';
import { evalExpr, type Env, type Expr } from '../relation';
import { simplify } from './chain';

// `simplify` is the riskiest new code in the chain projector: it inlines constants and folds the
// aggregation identities so the model never carries ±Infinity into MiniZinc. If it ever changes a
// value, every cold-path solve silently disagrees with the hot path. These properties pin it down on
// random expression trees, not just hand-picked cases (doc-4 §5).

const KEYS = ['a', 'b', 'c', 'd'] as const;
const ref = (k: string): Expr => ({ kind: 'ref', key: k as unknown as Key });
const finite = fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true });

/** Random relation expression over KEYS, bounded by `depth`. */
function arbExpr(depth: number): fc.Arbitrary<Expr> {
  const leaf = fc.oneof(
    finite.map((value): Expr => ({ kind: 'num', value })),
    fc.constantFrom(...KEYS).map((k): Expr => ref(k)),
  );
  if (depth <= 0) return leaf;
  const sub = arbExpr(depth - 1);
  return fc.oneof(
    { weight: 1, arbitrary: leaf },
    { weight: 1, arbitrary: sub.map((arg): Expr => ({ kind: 'neg', arg })) },
    {
      weight: 3,
      arbitrary: fc
        .tuple(fc.constantFrom('+', '-', '*', '/') as fc.Arbitrary<'+' | '-' | '*' | '/'>, sub, sub)
        .map(([op, left, right]): Expr => ({ kind: 'binary', op, left, right })),
    },
    {
      weight: 3,
      arbitrary: fc
        .tuple(fc.constantFrom('min', 'max') as fc.Arbitrary<'min' | 'max'>, fc.array(sub, { minLength: 1, maxLength: 3 }))
        .map(([fn, args]): Expr => ({ kind: 'call', fn, args })),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.constantFrom('<=', '<', '>=', '>', '==') as fc.Arbitrary<'<=' | '<' | '>=' | '>' | '=='>, sub, sub)
        .map(([op, left, right]): Expr => ({ kind: 'compare', op, left, right })),
    },
  );
}

// Equal up to NaN-identity and a relative epsilon (min/max re-ordering is exact; this is just safety).
function sameNum(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a === b) return true;
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

const envOf = (vals: readonly number[]): { env: Env<string>; map: Record<string, number> } => {
  const map: Record<string, number> = { a: vals[0]!, b: vals[1]!, c: vals[2]!, d: vals[3]! };
  return { env: (k) => map[k]!, map };
};

describe('simplify (chain projector constant-folder)', () => {
  it('preserves value under any partial constant environment', () => {
    fc.assert(
      fc.property(arbExpr(3), fc.tuple(finite, finite, finite, finite), fc.subarray([...KEYS]), (e, vals, constKeys) => {
        const { env, map } = envOf(vals);
        const known = new Set(constKeys);
        const folded = simplify(e, (id) => (known.has(id as (typeof KEYS)[number]) ? map[id] : undefined));
        return sameNum(evalExpr(folded, env), evalExpr(e, env));
      }),
      { numRuns: 1000 },
    );
  });

  it('fully folds to a single number when every reference is constant', () => {
    fc.assert(
      fc.property(arbExpr(3), fc.tuple(finite, finite, finite, finite), (e, vals) => {
        const { env, map } = envOf(vals);
        const folded = simplify(e, (id) => map[id]);
        expect(folded.kind).toBe('num');
        if (folded.kind === 'num') expect(sameNum(folded.value, evalExpr(e, env))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
