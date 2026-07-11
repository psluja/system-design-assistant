import { describe, it, expect } from 'vitest';
import { serialize, type ProjectDoc } from '@sda/core';
import { keys } from '@sda/content';
import { NodeId, Key, Unit, type Verdict } from '@sda/engine-core';
import { sloItems, toSloItem, sloComparator, verdictForSlo, num } from './slo-tests-pure';

// Pure mapping tests for the SLO Test Explorer (bands → item labels; verdict matching). No `vscode` here — the
// controller/run glue lives in slo-tests.ts and is exercised by the e2e; the interesting decisions are all here.

describe('sloComparator', () => {
  it('renders an upper-bound latency band with the registry unit', () => {
    expect(sloComparator(String(keys.latency), { shape: 'minTargetMax', max: 120 })).toBe('latency ≤ 120 ms');
  });

  it('renders a lower-bound throughput band, thousands-grouped', () => {
    expect(sloComparator(String(keys.throughput), { shape: 'minTargetMax', min: 5000 })).toBe('throughput ≥ 5,000 req/s');
  });

  it('renders a two-sided band with both bounds', () => {
    expect(sloComparator(String(keys.latency), { shape: 'minTargetMax', min: 10, max: 120 })).toBe('latency ≥ 10 ms, ≤ 120 ms');
  });

  it('renders a percentile (tail) band as pN ≤ target with the unit on each', () => {
    const band = { shape: 'percentiles', targets: new Map([['p99', 300]]) } as const;
    expect(sloComparator(String(keys.tailLatency), band)).toBe('tailLatency · p99 ≤ 300 ms');
  });

  it('renders multiple percentile targets', () => {
    const band = { shape: 'percentiles', targets: new Map([['p50', 50], ['p99', 300]]) } as const;
    expect(sloComparator(String(keys.tailLatency), band)).toBe('tailLatency · p50 ≤ 50 ms, p99 ≤ 300 ms');
  });

  it('renders a ratio key (availability) as a percentage, not the raw unit', () => {
    // Same nines convention as the design doc's `pct`: ≥ 0.9999 → 4 decimals (so "99.9900%"); this keeps the SLO
    // requirement reading identically across the doc and the Testing view.
    expect(sloComparator(String(keys.availability), { shape: 'minTargetMax', min: 0.9999 })).toBe('availability ≥ 99.9900%');
    expect(sloComparator(String(keys.availability), { shape: 'minTargetMax', min: 0.995 })).toBe('availability ≥ 99.500%');
  });

  it('renders a point band', () => {
    expect(sloComparator(String(keys.concurrency), { shape: 'point', target: 8 })).toBe('concurrency = 8');
  });
});

describe('toSloItem', () => {
  it('builds a stable id and the prefixed label, and flags a percentile band', () => {
    const scalar = toSloItem('pg', { key: keys.latency, band: { shape: 'minTargetMax', max: 120 } });
    expect(scalar.id).toBe('pg::latency');
    expect(scalar.label).toBe('pg · latency ≤ 120 ms');
    expect(scalar.isPercentile).toBe(false);

    const tail = toSloItem('pg', { key: keys.tailLatency, band: { shape: 'percentiles', targets: new Map([['p99', 300]]) } });
    expect(tail.id).toBe('pg::tailLatency');
    expect(tail.label).toBe('pg · tailLatency · p99 ≤ 300 ms');
    expect(tail.isPercentile).toBe(true);
  });
});

describe('sloItems', () => {
  const doc = (): ProjectDoc => ({
    schema: 11,
    id: 'p1',
    name: 'T',
    instances: [
      { id: 'app', type: 'compute.service' }, // no SLO
      { id: 'pg', type: 'db.postgres', bands: [{ key: keys.throughput, band: { shape: 'minTargetMax', min: 5000 } }] },
      // A node with TWO SLOs (a mean and a tail) → both listed, in order.
      { id: 'gw', type: 'apigw.rest', bands: [
        { key: keys.latency, band: { shape: 'minTargetMax', max: 100 } },
        { key: keys.tailLatency, band: { shape: 'percentiles', targets: new Map([['p99', 300]]) } },
      ] },
    ],
    wires: [],
    layout: {},
    labels: {},
    descriptions: {},
    groups: [],
    components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [], scenarios: [], systemPromises: [],
  });

  it('lists one item per USER SLO, skipping nodes with none', () => {
    const items = sloItems(serialize(doc()));
    expect(items.map((i) => i.id)).toEqual(['pg::throughput', 'gw::latency', 'gw::tailLatency']);
    expect(items.map((i) => i.label)).toEqual([
      'pg · throughput ≥ 5,000 req/s',
      'gw · latency ≤ 100 ms',
      'gw · tailLatency · p99 ≤ 300 ms',
    ]);
    expect(items.find((i) => i.id === 'gw::tailLatency')!.isPercentile).toBe(true);
  });

  it('returns an empty list for text that does not parse (never a fabricated SLO)', () => {
    expect(sloItems('{ not json')).toEqual([]);
  });

  it('returns an empty list for a design with no user SLOs', () => {
    const bare: ProjectDoc = { ...doc(), instances: [{ id: 'app', type: 'compute.service' }] };
    expect(sloItems(serialize(bare))).toEqual([]);
  });
});

describe('verdictForSlo', () => {
  const verdict = (scope: string, key: Key, status: Verdict['status']): Verdict => ({
    key,
    scope: NodeId(scope),
    computed: { value: 3000, unit: Unit('req/s') },
    status,
    cause: [],
    remediations: [],
  });

  it('matches the verdict scoped to the SLO node AND keyed to the band key', () => {
    const slo = toSloItem('pg', { key: keys.throughput, band: { shape: 'minTargetMax', min: 5000 } });
    const verdicts = [
      verdict('pg', keys.latency, 'ok'), // right node, wrong key
      verdict('app', keys.throughput, 'ok'), // right key, wrong node
      verdict('pg', keys.throughput, 'violation'), // the match
    ];
    const v = verdictForSlo(slo, verdicts);
    expect(v).toBeDefined();
    expect(v!.status).toBe('violation');
  });

  it('is undefined when no verdict matches (caller reports honestly, never fabricates)', () => {
    const slo = toSloItem('pg', { key: keys.throughput, band: { shape: 'minTargetMax', min: 5000 } });
    expect(verdictForSlo(slo, [verdict('pg', keys.latency, 'ok')])).toBeUndefined();
  });
});

describe('num', () => {
  it('groups thousands and keeps decimals', () => {
    expect(num(5000)).toBe('5,000');
    expect(num(1234567)).toBe('1,234,567');
    expect(num(12.5)).toBe('12.5');
    expect(num(12.3456)).toBe('12.35');
  });
  it('renders ∞ for a non-finite value (a saturated tier), never "Infinity"', () => {
    expect(num(Number.POSITIVE_INFINITY)).toBe('∞');
  });
});
