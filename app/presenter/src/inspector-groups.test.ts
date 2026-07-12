import { describe, expect, it } from 'vitest';
import { keys } from '@sda/content';
import { knobGroupOf, knobGroups, isHiddenKnob, KNOB_GROUP_TITLE, PROMISES_TITLE, type KnobRow } from './node-detail';
import { bandComparator, num } from './band-text';

// THE INSPECTOR ROLE AXIS — the ONE classifier both shells render, pinned here so the
// section headings/order can never drift between the web Inspector and the VS Code native tree.

const knob = (key: string): KnobRow => ({ key, label: key, value: 0, unit: '' });

describe('knobGroupOf — a config knob is grouped by its registry role', () => {
  it('fact-assumption keys are Assumptions (facts about your world)', () => {
    for (const k of [keys.assumedRps, keys.perRequestDuration, keys.arrivalRate, keys.timeoutMs, keys.retryCount, keys.payloadBytes]) {
      expect(knobGroupOf(String(k))).toBe('assumptions');
    }
  });

  it('resource-limit keys are Resource limits', () => {
    for (const k of [keys.concurrency, keys.replicas, keys.maxUnits, keys.accountConcurrency, keys.deploymentMode, keys.queueMode, keys.latencyComposition, keys.unitCost]) {
      expect(knobGroupOf(String(k))).toBe('limits');
    }
  });

  it('an unclassified/unknown key falls to Resource limits (a knob is never dropped)', () => {
    expect(knobGroupOf('not-a-real-key')).toBe('limits');
  });
});

describe('knobGroups — partition into role-titled sections, in order, dropping empties', () => {
  it('splits knobs into Assumptions then Resource limits, each with the shared title', () => {
    const groups = knobGroups([knob(String(keys.assumedRps)), knob(String(keys.concurrency)), knob(String(keys.perRequestDuration))]);
    expect(groups.map((g) => g.id)).toEqual(['assumptions', 'limits']);
    expect(groups[0]!.title).toBe(KNOB_GROUP_TITLE.assumptions);
    expect(groups[0]!.title).toBe('Assumptions (facts about your world)');
    expect(groups[0]!.knobs.map((k) => k.key)).toEqual([String(keys.assumedRps), String(keys.perRequestDuration)]);
    expect(groups[1]!.title).toBe('Resource limits');
    expect(groups[1]!.knobs.map((k) => k.key)).toEqual([String(keys.concurrency)]);
  });

  it('drops an empty group (no-filler) — a limits-only node shows only Resource limits', () => {
    const groups = knobGroups([knob(String(keys.concurrency)), knob(String(keys.replicas))]);
    expect(groups.map((g) => g.id)).toEqual(['limits']);
  });

  it('is empty for a node with no knobs', () => {
    expect(knobGroups([])).toEqual([]);
  });
});

describe('isHiddenKnob — a hidden knob is suppressed from every human-facing surface (mechanism intact)', () => {
  it('assumedRps is hidden (authored via a generator now); ordinary knobs are not', () => {
    expect(isHiddenKnob(String(keys.assumedRps))).toBe(true);
    for (const k of [keys.concurrency, keys.perRequestDuration, keys.replicas, keys.maxUnits, keys.timeoutMs, keys.unitCost]) {
      expect(isHiddenKnob(String(k))).toBe(false);
    }
  });
});

describe('the shared section titles are stable (one form both shells render)', () => {
  it('the three group headings', () => {
    expect(KNOB_GROUP_TITLE.assumptions).toBe('Assumptions (facts about your world)');
    expect(KNOB_GROUP_TITLE.limits).toBe('Resource limits');
    expect(PROMISES_TITLE).toBe('Promises');
  });
});

describe('bandComparator — the canonical SLO-band grammar shared across shells', () => {
  it('renders a floor, a ceiling, a both-sided band, a percentile tail and a ratio', () => {
    expect(bandComparator(String(keys.throughput), { shape: 'minTargetMax', min: 5000 })).toBe('throughput ≥ 5,000 req/s');
    expect(bandComparator(String(keys.latency), { shape: 'minTargetMax', max: 120 })).toBe('latency ≤ 120 ms');
    expect(bandComparator(String(keys.latency), { shape: 'minTargetMax', min: 10, max: 120 })).toBe('latency ≥ 10 ms, ≤ 120 ms');
    expect(bandComparator(String(keys.tailLatency), { shape: 'percentiles', targets: new Map([['p99', 300]]) })).toBe('tailLatency · p99 ≤ 300 ms');
    expect(bandComparator(String(keys.availability), { shape: 'minTargetMax', min: 0.9999 })).toBe('availability ≥ 99.9900%');
  });

  it('num groups thousands and stays honest for non-finite', () => {
    expect(num(5000)).toBe('5,000');
    expect(num(12.5)).toBe('12.5');
    expect(num(Number.POSITIVE_INFINITY)).toBe('∞');
  });
});
