import { describe, expect, it } from 'vitest';
import { keys, registry, roles, roleOf, isFactAssumption, polarityOf, type Role } from './registry';

// THE ROLE AXIS lint. One-form-per-kind is a MECHANICAL law, not a convention: every
// node quantity carries exactly one role, the classification partitions sanely, and it can never contradict the
// engine's own input/derived split. These assertions are the guard — a new key with no role, or a role that
// disagrees with the key's `kind`, fails here rather than silently letting a scenario override the wrong thing.

const VALID_ROLES: readonly Role[] = ['fact-assumption', 'resource-limit', 'computed', 'promise-target'];
const allKeys = Object.values(keys).map(String);

describe('the role axis — every registry key is classified (one-form-per-kind)', () => {
  it('EVERY key in the registry carries a role', () => {
    for (const k of allKeys) {
      expect(roles[k], `key "${k}" has no role — every node quantity must be classified (doc §2)`).toBeDefined();
      expect(VALID_ROLES).toContain(roles[k]!.role);
    }
  });

  it('has NO stale role entry (every classified key is a real registry key)', () => {
    const known = new Set(allKeys);
    for (const k of Object.keys(roles)) {
      expect(known.has(k), `role table names "${k}", which is not a registry key`).toBe(true);
    }
  });

  it('roleOf agrees with the table for every key, and isFactAssumption is the fact-assumption test', () => {
    for (const k of Object.values(keys)) {
      expect(roleOf(k)).toBe(roles[String(k)]!.role);
      expect(isFactAssumption(String(k))).toBe(roles[String(k)]!.role === 'fact-assumption');
    }
  });
});

describe('the role axis — the partition is sane (role ↔ engine kind)', () => {
  // The cross-check that makes "partition sanely" mechanical: an INPUT key (authored) is a belief or a ceiling
  // (fact-assumption | resource-limit); a DERIVED key (computed by the engine/DES) is a result or a promise target
  // (computed | promise-target). This ties the meta-model role to the split the cell network already enforces, so
  // the two can never drift (a derived key mislabelled fact-assumption — hence wrongly scenario-overridable — fails).
  it('a kind:"input" key is fact-assumption or resource-limit; a kind:"derived" key is computed or promise-target', () => {
    for (const k of Object.values(keys)) {
      const def = registry.get(k);
      expect(def, `key "${String(k)}" is not in the engine registry`).toBeDefined();
      const role = roleOf(k)!;
      if (def!.kind === 'input') {
        expect(['fact-assumption', 'resource-limit'], `input key "${String(k)}" has role ${role}`).toContain(role);
      } else {
        expect(['computed', 'promise-target'], `derived key "${String(k)}" has role ${role}`).toContain(role);
      }
    }
  });

  it('classifies the anchor keys exactly (doc §2.1)', () => {
    // fact-assumption — the assumption space
    expect(roleOf(keys.assumedRps)).toBe('fact-assumption');
    expect(roleOf(keys.perRequestDuration)).toBe('fact-assumption');
    expect(roleOf(keys.arrivalRate)).toBe('fact-assumption');
    // resource-limit — design ceilings / sizing / quotas
    for (const k of [keys.concurrency, keys.replicas, keys.maxUnits, keys.accountConcurrency, keys.connectionPool]) {
      expect(roleOf(k)).toBe('resource-limit');
    }
    // computed — read-back results
    for (const k of [keys.throughput, keys.latency, keys.availability, keys.cost, keys.overflow, keys.backlog]) {
      expect(roleOf(k)).toBe('computed');
    }
    // promise-target — the DES-fed SLO-only keys (no forward value)
    for (const k of [keys.tailLatency, keys.goodputRps, keys.errorRate]) {
      expect(roleOf(k)).toBe('promise-target');
    }
  });

  it('every role has at least one member (a non-degenerate four-way partition)', () => {
    for (const role of VALID_ROLES) {
      expect(allKeys.some((k) => roles[k]!.role === role), `no key carries role ${role}`).toBe(true);
    }
  });
});

describe('the role axis — polarity is declared ONLY where honestly known (no guessing)', () => {
  it('polarity, where present, is a valid value and only on a fact-assumption', () => {
    for (const k of Object.values(keys)) {
      const pol = polarityOf(k);
      if (pol === undefined) continue;
      expect(['higher-is-worse', 'lower-is-worse']).toContain(pol);
      // Polarity is the unfavourable direction of a WORLD assumption — it is meaningful only for a fact-assumption.
      expect(roleOf(k), `polarity on non-fact-assumption "${String(k)}"`).toBe('fact-assumption');
    }
  });

  it('the load/service/payload assumptions are higher-is-worse; the two-sided caller knobs carry no polarity', () => {
    expect(polarityOf(keys.assumedRps)).toBe('higher-is-worse');
    expect(polarityOf(keys.perRequestDuration)).toBe('higher-is-worse');
    expect(polarityOf(keys.payloadBytes)).toBe('higher-is-worse');
    // a caller's timeout/retry knobs have a genuinely two-sided cost ⇒ polarity is deliberately undefined
    expect(polarityOf(keys.timeoutMs)).toBeUndefined();
    expect(polarityOf(keys.retryCount)).toBeUndefined();
  });
});
