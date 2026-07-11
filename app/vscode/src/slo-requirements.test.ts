import { describe, it, expect } from 'vitest';
import { serialize, type ProjectDoc } from '@sda/core';
import { keys } from '@sda/content';
import { SLO_REQUIREMENTS, requirementForKey, sloRowsFor } from './slo-requirements';

// Pure tests for the SLO requirement catalog + the Inspector's row reader (vscode-free). The command flows that
// consume these live in commands.ts (vscode-facing); the DECISIONS — which band a requirement builds, how a row
// reads — are proven here.

describe('SLO_REQUIREMENTS (the requirement catalog — mirrors the web)', () => {
  it('offers throughput ≥, latency ≤, availability ≥, cost ≤, and a p99 tail ≤', () => {
    const byKey = new Map(SLO_REQUIREMENTS.map((r) => [r.key, r]));
    expect(byKey.get(String(keys.throughput))?.cmp).toBe('≥');
    expect(byKey.get(String(keys.latency))?.cmp).toBe('≤');
    expect(byKey.get(String(keys.availability))?.cmp).toBe('≥');
    expect(byKey.get(String(keys.cost))?.cmp).toBe('≤');
    expect(byKey.get(String(keys.tailLatency))?.cmp).toBe('≤');
  });

  it('builds a minTargetMax floor for a ≥ requirement and a ceiling for a ≤ requirement', () => {
    const tput = requirementForKey(String(keys.throughput))!;
    const floor = tput.build(5000);
    expect(floor.shape === 'minTargetMax' && floor.min).toBe(5000);
    expect(floor.shape === 'minTargetMax' && floor.max).toBeUndefined();

    const lat = requirementForKey(String(keys.latency))!;
    const ceiling = lat.build(120);
    expect(ceiling.shape === 'minTargetMax' && ceiling.max).toBe(120);
    expect(ceiling.shape === 'minTargetMax' && ceiling.min).toBeUndefined();
  });

  it('builds a percentiles band with a p99 target for the tail requirement', () => {
    const tail = requirementForKey(String(keys.tailLatency))!;
    const band = tail.build(300);
    expect(band.shape).toBe('percentiles');
    expect(band.shape === 'percentiles' && band.targets instanceof Map).toBe(true);
    expect(band.shape === 'percentiles' && band.targets.get('p99')).toBe(300);
  });

  it('flags availability as a ratio (the InputBox validates 0..1) and the others as plain values', () => {
    expect(requirementForKey(String(keys.availability))?.isRatio).toBe(true);
    expect(requirementForKey(String(keys.throughput))?.isRatio).toBe(false);
    expect(requirementForKey(String(keys.cost))?.isRatio).toBe(false);
  });

  it('returns undefined for a key not in the catalog', () => {
    expect(requirementForKey('not-a-requirement')).toBeUndefined();
  });
});

describe('sloRowsFor (the Inspector requirement rows)', () => {
  const design = (): ProjectDoc => ({
    schema: 11,
    id: 'p1',
    name: 'T',
    instances: [
      { id: 'app', type: 'compute.service' },
      {
        id: 'pg',
        type: 'db.postgres',
        bands: [
          { key: keys.throughput, band: { shape: 'minTargetMax', min: 5000 } },
          { key: keys.tailLatency, band: { shape: 'percentiles', targets: new Map([['p99', 300]]) } },
        ],
      },
    ],
    wires: [],
    layout: {},
    labels: {},
    descriptions: {},
    groups: [],
    components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [], scenarios: [], systemPromises: [],
  });

  it('lists a node\'s SLOs with comparator labels, in declaration order', () => {
    const rows = sloRowsFor(serialize(design()), 'pg');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.key).toBe(String(keys.throughput));
    // The label borrows sloComparator's grammar (thousands-grouped, unit-suffixed).
    expect(rows[0]!.label).toContain('≥');
    expect(rows[0]!.label).toContain('5,000');
    expect(rows[1]!.key).toBe(String(keys.tailLatency));
    expect(rows[1]!.label).toContain('p99');
  });

  it('returns an empty list for a node with no bands', () => {
    expect(sloRowsFor(serialize(design()), 'app')).toHaveLength(0);
  });

  it('returns an empty list for an unknown node or unparseable text (never fabricates a row)', () => {
    expect(sloRowsFor(serialize(design()), 'ghost')).toHaveLength(0);
    expect(sloRowsFor('{ not json', 'pg')).toHaveLength(0);
  });
});
