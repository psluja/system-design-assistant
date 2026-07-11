import { describe, expect, it } from 'vitest';
import { parse } from '../relation';
import { solve, type Cell, type CellId } from './solve';

function expr(src: string) {
  const r = parse(src);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('least-fixpoint solver', () => {
  it('solves an acyclic chain (a → b → c)', () => {
    const cells = new Map<CellId, Cell>([
      ['a', { kind: 'input', value: 10 }],
      ['b', { kind: 'derived', expr: expr('a + 5') }],
      ['c', { kind: 'derived', expr: expr('b * 2') }],
    ]);
    const r = solve(cells);
    expect(r.converged).toBe(true);
    expect(r.values.get('b')).toBe(15);
    expect(r.values.get('c')).toBe(30);
  });

  it('finds the LEAST fixpoint of backpressure feedback (incl. the slack regime)', () => {
    // t = min(C, max(R, t)); least fixpoint = min(R, C). In the slack regime (C > R) a raw solve
    // admits spurious fixpoints {R..C}; Kleene-from-bottom must still pick min(R, C).
    const mk = (R: number, C: number): ReadonlyMap<CellId, Cell> =>
      new Map<CellId, Cell>([
        ['R', { kind: 'input', value: R }],
        ['C', { kind: 'input', value: C }],
        ['t', { kind: 'derived', expr: expr('min(C, max(R, t))') }],
      ]);
    expect(solve(mk(4, 10)).values.get('t')).toBe(4); // slack: 4, NOT 10
    expect(solve(mk(10, 4)).values.get('t')).toBe(4); // bottlenecked: 4
  });

  it('reports did-not-converge for a divergent system (never lies)', () => {
    const cells = new Map<CellId, Cell>([['t', { kind: 'derived', expr: expr('t + 1') }]]);
    const r = solve(cells, { maxIter: 50 });
    expect(r.converged).toBe(false);
    expect(r.iterations).toBe(50);
  });
});
