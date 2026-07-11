import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Key } from '@sda/engine-core';
import { evalExpr, parse, type Env, type Expr } from '../relation';
import { forwardModel } from './project';

// The native `minizinc` binary (on PATH, or via the MINIZINC env var). Installed for CI; this test
// enforces the core consistency invariant (doc-4 §5, §9): the JS evaluator and MiniZinc must agree
// on forward evaluation. A disagreement is a P0 — it means the tool would lie.
const MZN = process.env.MINIZINC ?? 'minizinc';

function runMiniZinc(src: string): number {
  const dir = mkdtempSync(join(tmpdir(), 'sda-mzn-'));
  try {
    const file = join(dir, 'm.mzn');
    writeFileSync(file, src);
    const out = execFileSync(MZN, ['--solver', 'gecode', '--output-mode', 'json', file], { encoding: 'utf8' });
    const json = JSON.parse((out.split('----------')[0] ?? '').trim()) as { result: number };
    return json.result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function jsEval(src: string, env: Record<string, number>): number {
  const p = parse(src);
  if (!p.ok) throw new Error(p.error);
  const lookup: Env = (k: Key) => {
    const v = env[k as string];
    if (v === undefined) throw new Error(`unbound ${String(k)}`);
    return v;
  };
  return evalExpr(p.value, lookup);
}

function mznEval(src: string, env: Record<string, number>): number {
  const p = parse(src);
  if (!p.ok) throw new Error(p.error);
  return runMiniZinc(forwardModel(p.value, env));
}

const cases: ReadonlyArray<{ src: string; env: Record<string, number> }> = [
  { src: 'concurrency / (perRequestDuration / 1000)', env: { concurrency: 20, perRequestDuration: 200 } },
  { src: 'min(capacity, demand)', env: { capacity: 100, demand: 400 } },
  { src: 'max(a, b) + c * d', env: { a: 1, b: 5, c: 2, d: 3 } },
  { src: '2 + 3 * 4 - 1', env: {} },
  { src: 'min(C, max(R, t))', env: { C: 10, R: 4, t: 4 } },
];

describe('JS evaluator <-> MiniZinc differential (forward eval)', () => {
  for (const c of cases) {
    it(`agrees on: ${c.src}`, () => {
      expect(mznEval(c.src, c.env)).toBeCloseTo(jsEval(c.src, c.env), 9);
    });
  }
});

// Random STRUCTURE coverage: integer-valued arithmetic over a,b,c,d. Catches projector-emission bugs
// (precedence, min/max array syntax, neg) that hand cases miss. Integers keep MiniZinc output exact;
// float precision is already covered by the division cases above. Spawns the solver, so kept small.
const KEYS = ['a', 'b', 'c', 'd'] as const;
const ref = (k: string): Expr => ({ kind: 'ref', key: k as unknown as Key });
const smallInt = fc.integer({ min: -20, max: 20 });

function arbArith(depth: number): fc.Arbitrary<Expr> {
  const leaf = fc.oneof(
    smallInt.map((value): Expr => ({ kind: 'num', value })),
    fc.constantFrom(...KEYS).map((k): Expr => ref(k)),
  );
  if (depth <= 0) return leaf;
  const sub = arbArith(depth - 1);
  return fc.oneof(
    { weight: 1, arbitrary: leaf },
    { weight: 1, arbitrary: sub.map((arg): Expr => ({ kind: 'neg', arg })) },
    {
      weight: 3,
      arbitrary: fc
        .tuple(fc.constantFrom('+', '-', '*') as fc.Arbitrary<'+' | '-' | '*'>, sub, sub)
        .map(([op, left, right]): Expr => ({ kind: 'binary', op, left, right })),
    },
    {
      weight: 2,
      arbitrary: fc
        .tuple(fc.constantFrom('min', 'max') as fc.Arbitrary<'min' | 'max'>, fc.array(sub, { minLength: 1, maxLength: 3 }))
        .map(([fn, args]): Expr => ({ kind: 'call', fn, args })),
    },
  );
}

const randomCases = fc.sample(fc.tuple(arbArith(2), fc.tuple(smallInt, smallInt, smallInt, smallInt)), {
  numRuns: 12,
  seed: 20260628,
});

describe('forward differential on random arithmetic (vs native MiniZinc)', () => {
  randomCases.forEach(([e, vals], i) => {
    it(`random structure #${i}`, () => {
      const map: Record<string, number> = { a: vals[0], b: vals[1], c: vals[2], d: vals[3] };
      const env: Env = (k) => map[k as unknown as string]!;
      expect(runMiniZinc(forwardModel(e, map))).toBeCloseTo(evalExpr(e, env), 6);
    });
  });
});
