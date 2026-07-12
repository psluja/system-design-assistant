import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Key, Transform } from '@sda/engine-core';
import { evalExpr, type Env, type Expr } from '../relation';
import { forwardModel } from './project';

// FLOW TRANSFORMS — JS↔MiniZinc differential. The port transforms are baked
// into the cell-network as ordinary Expr arithmetic (ratio/prob = `x * k`, batch = `x / n`, cap = `min(x, r)`,
// window = `min(x, 1000/ms)`), so the JS hot path and the MiniZinc emitter consume the SAME expression. This
// test proves they agree per function: any disagreement would be the tool lying about the transformed rate.
// Needs the native minizinc binary (on PATH or $MINIZINC), the same as the other differential suite.
const MZN = process.env.MINIZINC ?? 'minizinc';

function runMiniZinc(src: string): number {
  const dir = mkdtempSync(join(tmpdir(), 'sda-mzn-tf-'));
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

const x: Expr = { kind: 'ref', key: 'x' as Key };
/** The SAME arithmetic `transformExpr` (network/build.ts) emits for each transform — kept in lock-step with it
 *  so the differential actually tests the shipping encoding, not a re-derivation that could drift from it.
 *  `generate` is the identity at the edge seam (its level is a NODE-level source term, doc: load-curves §3);
 *  its node-fold arithmetic is covered by the network build + the generator-axis oracle differential instead. */
function transformExpr(t: Transform, arg: Expr): Expr {
  switch (t.kind) {
    case 'ratio':
    case 'prob':
      return { kind: 'binary', op: '*', left: arg, right: { kind: 'num', value: t.value } };
    case 'batch':
      return { kind: 'binary', op: '/', left: arg, right: { kind: 'num', value: t.value } };
    case 'cap':
      return { kind: 'call', fn: 'min', args: [arg, { kind: 'num', value: t.value }] };
    case 'window':
      return { kind: 'call', fn: 'min', args: [arg, { kind: 'num', value: 1000 / t.value }] };
    case 'generate':
      return arg;
  }
}

/** The five RESHAPING transforms (generate has no scalar `value`; its edge-seam function is the identity above). */
type Reshaping = Exclude<Transform, { kind: 'generate' }>;
const cases: ReadonlyArray<{ t: Reshaping; inputs: readonly number[] }> = [
  { t: { kind: 'ratio', value: 100 }, inputs: [1000, 5, 0] },
  { t: { kind: 'ratio', value: 0.2 }, inputs: [1000, 333] }, // cache-miss to DB (fractional ratio)
  { t: { kind: 'batch', value: 100 }, inputs: [1000, 12345, 50] },
  { t: { kind: 'cap', value: 250 }, inputs: [1000, 100, 250] },
  { t: { kind: 'window', value: 10 }, inputs: [1000, 50] }, // ≤ 100 msg/s
  { t: { kind: 'prob', value: 0.01 }, inputs: [1000, 7] }, // DLQ split (scalar mean)
];

describe('flow-transform arithmetic: JS evaluator ⇄ native MiniZinc agree', () => {
  for (const c of cases) {
    for (const input of c.inputs) {
      it(`${c.t.kind}(${c.t.value}) on ${input}`, () => {
        const expr = transformExpr(c.t, x);
        const env: Env = (k) => (String(k) === 'x' ? input : Number.NaN);
        const js = evalExpr(expr, env);
        const mzn = runMiniZinc(forwardModel(expr, { x: input }));
        expect(mzn).toBeCloseTo(js, 6);
      });
    }
  }

  // A short COMPOSED chain (ratio then cap then batch), the shape a real pipeline has — same two engines agree.
  it('a composed chain ratio(3)→cap(1200)→batch(2) agrees', () => {
    const chain = transformExpr({ kind: 'batch', value: 2 }, transformExpr({ kind: 'cap', value: 1200 }, transformExpr({ kind: 'ratio', value: 3 }, x)));
    const env: Env = (k) => (String(k) === 'x' ? 500 : Number.NaN);
    const js = evalExpr(chain, env); // min(1500, 1200)/2 = 600
    const mzn = runMiniZinc(forwardModel(chain, { x: 500 }));
    expect(js).toBeCloseTo(600, 6);
    expect(mzn).toBeCloseTo(js, 6);
  });
});
