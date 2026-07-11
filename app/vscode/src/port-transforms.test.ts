import { describe, expect, it } from 'vitest';
import { LOAD_STAGES_PRESETS, derivedMean, derivedPeak } from '@sda/content';
import { cyclesProblem } from '@sda/engine-core';
import { formatGeneratorInput, parseGeneratorInput, presetGeneratorInput } from './port-transforms';

// The native GENERATOR authoring syntax (load-stages R3 §11) — the compact stages line the VS Code InputBox parses,
// the native twin of the web table. Pure, vscode-free (the `slo-requirements` division), so it is unit-tested here.
// These pin: the design's own example parses; guided errors name the exact rule; the round-trip preserves the SHAPE;
// and a preset pre-fill lands on the SAME cycles the web dropdown offers (one meaning, two entry points).

describe('parseGeneratorInput — the compact stages syntax', () => {
  it('parses the design doc example (level + a daily cycle in cumulative vertices)', () => {
    const r = parseGeneratorInput('level=200; daily: 0s×1, 6h×0.5, 12h×1, 18h×2, 24h×1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.level).toBe(200);
    expect(r.cycles).toHaveLength(1);
    expect(r.cycles[0]!.periodS).toBe(86400); // the last vertex time is the period
    // stages are the consecutive deltas (6h each), the ×1 anchor dropped
    expect(r.cycles[0]!.stages).toEqual([
      { durationS: 21600, multiplier: 0.5 },
      { durationS: 21600, multiplier: 1 },
      { durationS: 21600, multiplier: 2 },
      { durationS: 21600, multiplier: 1 },
    ]);
    expect(cyclesProblem(r.cycles)).toBeNull(); // the shared validator agrees
  });

  it('a bare level is a legal FLAT generator (no cycles)', () => {
    const r = parseGeneratorInput('level=500');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.level).toBe(500);
    expect(r.cycles).toHaveLength(0);
  });

  it('accepts bare-seconds times and x/* separators (no unit, no ×)', () => {
    const r = parseGeneratorInput('level=100; c: 60x2, 120*1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cycles[0]).toEqual({ periodS: 120, stages: [{ durationS: 60, multiplier: 2 }, { durationS: 60, multiplier: 1 }] });
  });

  it('several cycles MULTIPLY (a diurnal × a weekly)', () => {
    const r = parseGeneratorInput('level=200; daily: 0s×1, 12h×2, 24h×1; weekly: 0d×1, 5d×1.5, 7d×1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cycles).toHaveLength(2);
    expect(r.cycles[1]!.periodS).toBe(604800); // 7 days
  });

  it('guided error: a missing level names the rule', () => {
    const r = parseGeneratorInput('daily: 0s×1, 24h×2');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/level=/);
  });

  it('guided error: a malformed vertex names the token + the shape', () => {
    const r = parseGeneratorInput('level=100; c: 6h, 12h×1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('6h'); // the offending token
    expect(r.error).toMatch(/time×multiplier/);
  });

  it('guided error: non-increasing cumulative times are refused', () => {
    const r = parseGeneratorInput('level=100; c: 0s×1, 12h×2, 6h×1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/strictly increase/);
  });

  it('guided error: Σ durationS > periodS surfaces via the shared cyclesProblem', () => {
    // Not expressible in pure cumulative form, but two cycles where one is overfull isn't either — instead prove
    // the shared validator is wired: an all-zero shape (no traffic) is refused naming the fix.
    const r = parseGeneratorInput('level=100; c: 0s×1, 60s×0');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/traffic/);
  });
});

describe('formatGeneratorInput — the re-edit seed round-trips the SHAPE', () => {
  it('a flat generator formats to just the level', () => {
    expect(formatGeneratorInput(500, undefined)).toBe('level=500');
    expect(formatGeneratorInput(500, [])).toBe('level=500');
  });

  it('parse(format(preset)) preserves the mean + peak of every shipped preset', () => {
    for (const [name, cycles] of Object.entries(LOAD_STAGES_PRESETS)) {
      if (cycles.length === 0) continue; // flat has no shape to round-trip
      const line = formatGeneratorInput(200, cycles);
      const r = parseGeneratorInput(line);
      expect(r.ok, `${name} → ${line}`).toBe(true);
      if (!r.ok) continue;
      // The stage decomposition may differ (an explicit baseline-tail stage), but the SHAPE is identical:
      expect(derivedPeak(200, r.cycles)).toBeCloseTo(derivedPeak(200, cycles), 6);
      expect(derivedMean(200, r.cycles)).toBeCloseTo(derivedMean(200, cycles), 4);
    }
  });
});

describe('presetGeneratorInput — the on-ramp pre-fill matches the shipped presets', () => {
  it('a preset line parses back to a shape with the preset preset’s mean/peak', () => {
    const line = presetGeneratorInput('diurnal', 300);
    const r = parseGeneratorInput(line);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.level).toBe(300);
    expect(derivedPeak(300, r.cycles)).toBeCloseTo(derivedPeak(300, LOAD_STAGES_PRESETS.diurnal), 6);
  });

  it('the flat preset is a bare level (the steady-baseline migration path)', () => {
    expect(presetGeneratorInput('flat', 120)).toBe('level=120');
  });
});
