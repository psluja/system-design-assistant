import { describe, expect, it } from 'vitest';
import { isUntouchedSeedOrEmpty, shouldShowOnboarding, initialInspectorOpen, SEED_IDS } from './onboarding';

// The pure decisions behind TASK-73's first-run onboarding + responsive Inspector default. No DOM — the whole
// point is that "should the card show?" and "should the Inspector start collapsed?" are deterministic and testable.

describe('isUntouchedSeedOrEmpty', () => {
  it('the exact four seed ids → true (the untouched seed)', () => {
    expect(isUntouchedSeedOrEmpty({ instanceIds: [...SEED_IDS] })).toBe(true);
  });

  it('order does not matter', () => {
    expect(isUntouchedSeedOrEmpty({ instanceIds: ['pg', 'app', 'nginx', 'client'] })).toBe(true);
  });

  it('an empty canvas → true (a cleared design is still first-run material)', () => {
    expect(isUntouchedSeedOrEmpty({ instanceIds: [] })).toBe(true);
  });

  it('an added node (five ids) → false — the user has started editing', () => {
    expect(isUntouchedSeedOrEmpty({ instanceIds: [...SEED_IDS, 'cache1'] })).toBe(false);
  });

  it('a removed node (three seed ids) → false', () => {
    expect(isUntouchedSeedOrEmpty({ instanceIds: ['client', 'nginx', 'app'] })).toBe(false);
  });

  it('four ids but a different design (same count, different members) → false', () => {
    expect(isUntouchedSeedOrEmpty({ instanceIds: ['gw', 'cmd', 'pg', 'sns'] })).toBe(false);
  });
});

describe('shouldShowOnboarding', () => {
  it('fresh profile (no flag) over the untouched seed → show', () => {
    expect(shouldShowOnboarding(null, { instanceIds: [...SEED_IDS] })).toBe(true);
  });

  it('fresh profile over an empty canvas → show', () => {
    expect(shouldShowOnboarding(null, { instanceIds: [] })).toBe(true);
  });

  it('already onboarded (flag set) → never show, even over the seed', () => {
    expect(shouldShowOnboarding('1', { instanceIds: [...SEED_IDS] })).toBe(false);
  });

  it('fresh profile but the design has been edited → do not show', () => {
    expect(shouldShowOnboarding(null, { instanceIds: [...SEED_IDS, 'redis1'] })).toBe(false);
  });
});

describe('initialInspectorOpen', () => {
  it('a persisted "open" wins at any width (never fight the user)', () => {
    expect(initialInspectorOpen('1', 800)).toBe(true);
    expect(initialInspectorOpen('1', 1920)).toBe(true);
  });

  it('a persisted "collapsed" wins at any width', () => {
    expect(initialInspectorOpen('0', 1920)).toBe(false);
    expect(initialInspectorOpen('0', 800)).toBe(false);
  });

  it('no stored preference: auto-collapse below 1100px, open at/above', () => {
    expect(initialInspectorOpen(null, 900)).toBe(false);
    expect(initialInspectorOpen(null, 1099)).toBe(false);
    expect(initialInspectorOpen(null, 1100)).toBe(true);
    expect(initialInspectorOpen(null, 1440)).toBe(true);
  });
});
