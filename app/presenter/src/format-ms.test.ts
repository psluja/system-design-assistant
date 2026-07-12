import { describe, expect, it } from 'vitest';
import { type LagVerdict, type UncertaintyResult, formatMs as cFormatMs, formatMsDigits as cFormatMsDigits } from '@sda/content';
import { formatMs, formatMsDigits } from './format';
import {
  formatResponseTail,
  measuredResponseOf,
  latencyRangeBar,
  lagRows,
  summarySections,
  uncertaintySection,
  type SimTail,
  type SummaryInput,
} from './index';

// DISPLAY-CONSISTENCY SWEEP — every DISPLAYED time value is WHOLE milliseconds (rounded, thousands-grouped, no
// sub-ms noise); DATA keeps full precision. These pin the ONE shared formatter and then WALK the presenter view
// outputs for a design that PRODUCES fractional values, asserting no rendered ms string carries a decimal point.

// A number with a decimal point directly before a ' ms' unit — the exact thing the owner rule forbids on screen.
const FRACTIONAL_MS = /\d[\d,]*\.\d+\s*ms/;

describe('formatMs / formatMsDigits — the canonical whole-ms token', () => {
  it('rounds to whole ms and groups thousands (never a fraction, never a bare 1000)', () => {
    expect(formatMs(0)).toBe('0 ms');
    expect(formatMs(12.3456)).toBe('12 ms');
    expect(formatMs(123.456)).toBe('123 ms');
    expect(formatMs(499.6)).toBe('500 ms');
    expect(formatMs(1000)).toBe('1,000 ms');
    expect(formatMs(1234.5)).toBe('1,235 ms'); // half rounds up
    expect(formatMs(1234567.89)).toBe('1,234,568 ms');
  });

  it("the honesty guard: a NONZERO sub-½-ms value renders '<1 ms', never a false '0 ms'", () => {
    expect(formatMs(0.3)).toBe('<1 ms');
    expect(formatMs(0.001)).toBe('<1 ms');
    expect(formatMs(0.49)).toBe('<1 ms');
    expect(formatMs(0)).toBe('0 ms'); // a true zero is '0 ms' — only a NONZERO round-to-zero is '<1 ms'
    expect(formatMsDigits(0.3)).toBe('<1');
  });

  it("passes unknown / non-finite through honestly: '—' / '∞' / '−∞' (no fabricated number, no stray unit)", () => {
    expect(formatMs(undefined)).toBe('—');
    expect(formatMs(NaN)).toBe('—');
    expect(formatMs(Infinity)).toBe('∞');
    expect(formatMs(-Infinity)).toBe('−∞');
    expect(formatMsDigits(undefined)).toBe('—');
    expect(formatMsDigits(Infinity)).toBe('∞');
  });

  it('formatMsDigits is the bare (unit-less) form of the same rounding', () => {
    expect(formatMsDigits(123.456)).toBe('123');
    expect(formatMsDigits(1234.5)).toBe('1,235');
    expect(formatMsDigits(999.6)).toBe('1,000');
  });
});

// CROSS-PACKAGE PIN — content cannot import the presenter (presenter → content), so content/sda/src/doc/format-ms.ts is
// a byte-for-byte MIRROR. This asserts the two produce identical strings for a representative sample, so the doc
// renderer and every shell can never drift on how a duration reads.
describe('the content mirror is byte-identical to the presenter formatter', () => {
  const samples = [0, 0.0001, 0.3, 0.4, 0.5, 0.9, 1, 1.5, 12.3456, 123.456, 499.6, 500, 999.4, 999.6, 1000, 1234.5, 1234567.89, -0.3, -5.6, NaN, Infinity, -Infinity, undefined];
  it('formatMs and formatMsDigits agree across packages for every sample', () => {
    for (const v of samples) {
      expect(cFormatMs(v), `formatMs(${String(v)})`).toBe(formatMs(v));
      expect(cFormatMsDigits(v), `formatMsDigits(${String(v)})`).toBe(formatMsDigits(v));
    }
  });
});

// THE CANVAS LATENCY RANGE BAR (single-truth measured-or-nothing): the MEASURED p50→p99 anchors are whole-ms tokens
// WITH their names ("p50 81 ms" / "p99 213 ms"). `latencyRangeBar` is the ONE place both canvases (web + the VS Code
// webview, which imports the same node renderer) build this, so the two shells cannot drift.
describe('latencyRangeBar — the measured p50→p99 anchors are named whole-ms tokens', () => {
  it('renders "p50 <ms>" / "p99 <ms>" with whole-ms digits, and a null when there is nothing measured', () => {
    const measured = measuredResponseOf({ p50: 1, p95: 1, p99: 1, nodeResponse: [{ id: 'db', mean: 123.456, p50: 80.4, p95: 300.6, p99: 213.5, samples: 4096 }] }, 'db');
    expect(measured).not.toBeNull();
    const bar = latencyRangeBar(measured!);
    expect(bar.typical).toBe('p50 80 ms');
    expect(bar.tail).toBe('p99 214 ms'); // 213.5 → 214 (half rounds up)
    expect(bar.p50Digits).toBe('80');
    expect(bar.p99Digits).toBe('214');
    expect(bar.typical).not.toMatch(/\d\.\d/);
    expect(bar.tail).not.toMatch(/\d\.\d/);
    expect(bar.tooltip).not.toMatch(FRACTIONAL_MS);
    expect(measuredResponseOf(null, 'db')).toBeNull(); // measured-or-nothing: no run ⇒ no bar
  });
});

// THE WALKER — feed FRACTIONAL ms through the real presenter view-models and assert no rendered ms value shows a
// decimal point. This is the anti-regression net: if any surface reverts to `fmt`/`toFixed` on a time value, a
// fractional input flows straight through and one of these assertions fires.
describe('no presenter view output renders a fractional ms (walker over a fractional design)', () => {
  const tailInput = (sim: SimTail): SummaryInput => ({
    instances: [],
    wires: [],
    value: null,
    flows: [],
    queues: new Map(),
    saturated: new Map(),
    totalCost: 0,
    costBreak: null,
    verdicts: [],
    evalOk: true,
    evalErrorCount: 0,
    sim,
    labelOf: (id: string) => id,
    typeOf: (id: string) => id,
  });

  it('the simulated tail rows (p50 / p95 / p99) round to whole ms', () => {
    const sections = summarySections(tailInput({ p50: 123.456, p95: 456.72, p99: 789.9 }));
    const values = sections.flatMap((s) => s.rows.map((r) => r.value));
    for (const v of values) expect(v, v).not.toMatch(FRACTIONAL_MS);
    const tail = sections.find((s) => s.title === 'Response time · end-to-end')!;
    expect(tail.rows.map((r) => r.value)).toEqual(['123 ms', '457 ms', '790 ms']);
  });

  it('the canvas latency range bar and the Response-tail line are pure whole ms', () => {
    const sim: SimTail = { p50: 1, p95: 1, p99: 1, nodeResponse: [{ id: 'db', mean: 123.456, p50: 100.4, p95: 300.6, p99: 456.789, samples: 4096 }] };
    const bar = latencyRangeBar(measuredResponseOf(sim, 'db')!);
    expect(bar.typical).toBe('p50 100 ms');
    expect(bar.tail).toBe('p99 457 ms');
    expect(bar.typical).not.toMatch(/\d\.\d/); // a pure-time string: not even a bare percentile carries a decimal
    expect(bar.tail).not.toMatch(/\d\.\d/);
    expect(bar.tooltip).not.toMatch(FRACTIONAL_MS);

    const line = formatResponseTail({ id: 'db', mean: 123.456, p50: 100.4, p95: 300.6, p99: 456.789, samples: 4096 });
    expect(line).toBe('p50 100 ms · p95 301 ms · p99 457 ms');
    expect(line).not.toMatch(/\d\.\d/);
  });

  it('the flow-scoped lag rows (deadline + measured / lower-bound) round to whole ms', () => {
    const measured: LagVerdict = { source: 'a', terminal: 'b', maxMs: 2000.4, lowerBoundMs: 51.6, measuredMeanMs: 63.456, status: 'ok', basis: 'measured', note: '' };
    const overBound: LagVerdict = { source: 'a', terminal: 'c', maxMs: 100.7, lowerBoundMs: 152.6, status: 'violation', basis: 'lower-bound', note: '' };
    const rows = lagRows([measured, overBound], (id) => id, (id) => id);
    for (const r of rows) {
      expect(r.value, r.value).not.toMatch(FRACTIONAL_MS);
      expect(r.value, r.value).not.toMatch(/\d\.\d/);
    }
    expect(rows[0]!.value).toBe('≤ 2,000 ms · 63 ms ✓ (incl. queue wait)');
    expect(rows[1]!.value).toBe('≤ 101 ms · lower bound 153 ms already over ✗');
  });

  it('the uncertainty block: a TIME metric band and the compute-cadence round to whole ms', () => {
    const result: UncertaintyResult = {
      seed: 24301,
      scenarios: 500,
      rangedInputs: [],
      metrics: [{ name: 'latency', unit: 'ms', median: 123.456, p5: 90.1, p95: 210.9, mean: 130.2, min: 80.4, max: 260.7, histogram: [] }],
      sloConfidence: [],
      tornado: [],
    };
    const section = uncertaintySection({ result, state: 'confirmed', backend: 'cpu', elapsedMs: 42.7 })!;
    for (const r of section.rows) expect(r.value, r.value).not.toMatch(FRACTIONAL_MS);
    const metric = section.rows.find((r) => r.label === 'latency')!;
    expect(metric.value).toBe('123 (90–211) ms'); // bare whole-ms digits, the unit riding once at the end
    expect(metric.value).not.toMatch(/\d\.\d/);
    const state = section.rows.find((r) => r.label === 'State')!;
    expect(state.value).toContain('43 ms'); // the compute cadence, rounded
  });
});
