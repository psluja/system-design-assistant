import { describe, expect, it } from 'vitest';
import { NodeId, type Key } from '@sda/engine-core';
import { createEngine } from '@sda/engine-solve';
import { AVAILABILITY_TIERS, DR_TIERS, availabilityTier, recommendDrTier, reliabilityAdvice } from './reliability';
import { instantiate, commonManifests, registry } from '../index';
import { keys } from '../vocabulary/registry';

// The figures are sourced from the AWS Reliability pillar (the module cites the URLs). These tests pin the
// sourced numbers + the documented selection logic so the advice can't silently drift from AWS.
describe('reliability reference (sourced from AWS Well-Architected)', () => {
  it('the nines → max-downtime table matches AWS verbatim', () => {
    expect(AVAILABILITY_TIERS.find((t) => t.availability === 0.9995)?.maxDowntimePerYear).toBe('4 hours 22 minutes');
    expect(AVAILABILITY_TIERS.find((t) => t.availability === 0.9999)?.maxDowntimePerYear).toBe('52 minutes');
    expect(AVAILABILITY_TIERS.find((t) => t.availability === 0.99999)?.maxDowntimePerYear).toBe('5 minutes');
    expect(DR_TIERS.map((t) => t.name)).toEqual(['Backup & Restore', 'Pilot Light', 'Warm Standby', 'Multi-site Active/Active']);
  });

  it('availabilityTier returns the highest tier an availability MEETS', () => {
    expect(availabilityTier(0.9997)?.availability).toBe(0.9995); // meets 99.95, not 99.99
    expect(availabilityTier(0.99999)?.availability).toBe(0.99999);
    expect(availabilityTier(0.5)).toBeUndefined();
  });

  it('recommendDrTier picks the cheapest tier meeting RTO+RPO (AWS: not more stringent than needed)', () => {
    expect(recommendDrTier(6 * 3600, 24 * 3600).name).toBe('Backup & Restore'); // RPO hours, RTO 24h
    expect(recommendDrTier(3600, 3600).name).toBe('Pilot Light'); // RPO 1h (< Backup's 4h), RTO 1h
    expect(recommendDrTier(120, 600).name).toBe('Warm Standby'); // RPO 2min, RTO 10min
    expect(recommendDrTier(10, 30).name).toBe('Multi-site Active/Active'); // near-zero
  });

  it('reliabilityAdvice flags an unmet target with the AWS-documented remedy, naming the weakest', () => {
    const miss = reliabilityAdvice(0.998, 0.9999, { node: 'db', availability: 0.999 });
    expect(miss.meetsTarget).toBe(false);
    expect(miss.remedy).toContain('Availability Zone'); // independent redundancy / another AZ
    expect(miss.remedy).toContain('db'); // names the weakest hard dependency
    const met = reliabilityAdvice(0.99995, 0.9999);
    expect(met.meetsTarget).toBe(true);
    expect(met.remedy).toBeUndefined();
  });
});

describe('deploymentMode → the SOURCED RDS SLA per mode (db.postgres)', () => {
  const availabilityAt = (mode: number): number => {
    const g = instantiate(commonManifests, [{ id: 'db', type: 'db.postgres', config: { deploymentMode: mode } }], []);
    if (!g.ok) throw new Error('build failed');
    const ev = createEngine(registry).evaluate(g.value);
    if (!ev.ok) throw new Error('eval failed');
    return ev.value.value(NodeId('db'), keys.availability as Key) ?? -1;
  };
  it('single-AZ = 99.5%, Multi-AZ = 99.95% — the published RDS SLA, selected by the mode knob', () => {
    expect(availabilityAt(0)).toBeCloseTo(0.995, 6); // RDS single-AZ SLA
    expect(availabilityAt(1)).toBeCloseTo(0.9995, 6); // RDS Multi-AZ SLA
  });
});
