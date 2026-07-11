import { describe, expect, it } from 'vitest';
import { parseMznCliOutput } from './cli';

describe('parseMznCliOutput', () => {
  it('parses a plain numeric solution block', () => {
    const o = parseMznCliOutput('{\n  "c0" : 25.0,\n  "c1" : 3000.0\n}\n----------\n==========\n');
    expect(o).toEqual({ kind: 'solved', values: { c0: 25, c1: 3000 } });
  });

  it('SKIPS variables serialized as a name, keeping the numeric ones (the presolve-aggregation case)', () => {
    // cbc serialized two presolve-merged variables as `"c12" : c12` — invalid JSON; a whole-blob parse
    // would throw and discard a PROVEN-OPTIMAL solution. The numeric assignments must survive.
    const stdout = '{\n  "c0" : 25.0,\n  "c12" : c12,\n  "c26" : c12,\n  "c33" : 1517.5\n}\n----------\n==========\n';
    const o = parseMznCliOutput(stdout);
    expect(o.kind).toBe('solved');
    if (o.kind === 'solved') {
      expect(o.values).toEqual({ c0: 25, c33: 1517.5 });
      expect(o.values.c12).toBeUndefined();
    }
  });

  it('proven infeasible ⇒ infeasible, not unknown', () => {
    expect(parseMznCliOutput('=====UNSATISFIABLE=====\n')).toEqual({ kind: 'infeasible' });
  });

  it('no solution / status only ⇒ unknown (did not converge), never a guess', () => {
    expect(parseMznCliOutput('=====UNKNOWN=====\n')).toEqual({ kind: 'unknown' });
    expect(parseMznCliOutput('')).toEqual({ kind: 'unknown' });
  });

  it('multiple improving solutions ⇒ takes the LAST (best) block', () => {
    const stdout = '{ "x" : 100.0 }\n----------\n{ "x" : 42.0 }\n----------\n==========\n';
    const o = parseMznCliOutput(stdout);
    expect(o).toEqual({ kind: 'solved', values: { x: 42 } });
  });

  it('handles integers, negatives and scientific notation', () => {
    const o = parseMznCliOutput('{ "a" : 7, "b" : -42.5, "c" : 1.5e8 }\n----------\n');
    expect(o).toEqual({ kind: 'solved', values: { a: 7, b: -42.5, c: 150000000 } });
  });
});
