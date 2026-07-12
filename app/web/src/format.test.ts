import { describe, expect, it } from 'vitest';
import { fmt, opnd, plural, prettyExpr, rate } from './format';

describe('web formatting helpers', () => {
  it('fmt: dash for undefined/NaN, ∞ for non-finite, grouped ≥1000, ≤2 decimals otherwise', () => {
    expect(fmt(undefined)).toBe('—');
    expect(fmt(NaN)).toBe('—');
    expect(fmt(Infinity)).toBe('∞');
    expect(fmt(-Infinity)).toBe('−∞');
    expect(fmt(1234)).toBe('1,234');
    expect(fmt(71.234)).toBe('71.23');
    expect(fmt(0)).toBe('0');
  });

  it('plural: never "1 issues"', () => {
    expect(plural(1, 'issue')).toBe('1 issue');
    expect(plural(0, 'issue')).toBe('0 issues');
    expect(plural(2, 'SLO')).toBe('2 SLOs');
  });

  it('opnd/rate: a cost equation reads exactly (operand × base = total)', () => {
    expect(opnd(1000)).toBe('1,000');
    expect(opnd(3.125)).toBe('3.125'); // fractions keep enough precision to multiply out
    expect(rate(1.4)).toBe('$1.4');
    expect(rate(0.0009)).toBe('$0.0009'); // a tiny per-unit rate does NOT round to $0
  });

  it('prettyExpr: strips self()/inflow()/outflow() and shows × for multiplication', () => {
    expect(prettyExpr('self(throughput) * self(unitCost)')).toBe('throughput × unitCost');
    expect(prettyExpr('concurrency * self(unitCost)')).toBe('concurrency × unitCost');
    expect(prettyExpr('inflow(throughput) * self(unitCost)')).toBe('throughput × unitCost');
  });
});
