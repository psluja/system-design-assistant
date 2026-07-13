// FIDELITY LINTS + FRESHNESS (Phase 1 of the V&V strategy — doc: verification-and-validation.html §6, §10). The
// coverage matrix is a GENERATED artifact: the capability registry is the one home for the axis, the anchors are
// declared with test paths that MUST resolve, and the committed docs/FIDELITY.md must be byte-identical to a fresh
// `pnpm fidelity`. A capability added without an anchor-or-flag, or a claimed anchor pointing at a test that does
// not exist, fails here rather than passing silently. Repro/refresh for any failure: `pnpm fidelity`.
//
// Honesty guard (owner mandate): the matrix must show the REAL state — green ONLY with evidence. These tests pin
// that the artifact stays honest: the no-anchor solvers stay UNVALIDATED, the un-calibrated families never turn
// green, and the calibrated-family count is strictly below the total (the whole point is that gaps are visible).

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keys } from '@sda/content';
import { buildReport } from './report';
import { isFitted, loadCorpus } from './corpus';
import { buildCoverage, renderFidelity } from './coverage';
import { CAPABILITIES, GRID, type GridMetric, type GridRegime } from './capabilities';
import { fidelityPath, repoRoot } from './fidelity';

const entries = loadCorpus();
const report = buildReport(entries, false); // DES off — the fast, fully-deterministic fit-only lane
const matrix = buildCoverage(entries, report);

const resolves = (path: string): boolean => existsSync(join(repoRoot(), path));
const REGISTRY_KEYS = new Set(Object.values(keys).map(String));

describe('capability registry — the one honest home for the V&V axis', () => {
  it('every capability id is unique', () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size, 'duplicate capability id').toBe(ids.length);
  });

  it('every modeling-family config key is a real @sda/content registry key (the axis cannot claim a knob that does not exist)', () => {
    for (const c of CAPABILITIES) {
      if (c.kind !== 'modeling-family') continue;
      expect(c.configKeys.length, `${c.id} must name at least one config-key lever`).toBeGreaterThan(0);
      for (const k of c.configKeys) expect(REGISTRY_KEYS.has(k), `${c.id}: config key '${k}' is not a registry key`).toBe(true);
    }
  });

  it('a solver capability exposes no config keys (segregated from the modeling families)', () => {
    for (const c of CAPABILITIES) if (c.kind === 'solver') expect(c.configKeys, `${c.id}`).toEqual([]);
  });

  it('every declared anchor test path resolves (the matrix cannot claim an anchor no test carries)', () => {
    const paths = [
      ...CAPABILITIES.flatMap((c) => c.anchors.map((a) => a.test)),
      ...GRID.map((g) => g.anchor?.test).filter((p): p is string => p !== undefined),
    ];
    for (const p of new Set(paths)) expect(resolves(p), `anchor test does not resolve: ${p}`).toBe(true);
  });

  it('a config key belongs to exactly one modeling family (unambiguous corpus attribution)', () => {
    const seen = new Map<string, string>();
    for (const c of CAPABILITIES) {
      if (c.kind !== 'modeling-family') continue;
      for (const k of c.configKeys) {
        expect(seen.has(k), `config key '${k}' is claimed by both ${seen.get(k)} and ${c.id}`).toBe(false);
        seen.set(k, c.id);
      }
    }
  });

  it('every scored, fitted corpus tunable maps to SOME modeling family (measured evidence never vanishes from the by-nature breakdown)', () => {
    // Guards the coverage-attribution gap: coverage.ts attributes a corpus entry to a family ONLY via a fitted
    // tunable whose key is one of that family's configKeys. A scored entry that fits a key belonging to no family
    // (as Redis/Kafka's `throughput` did before it was added to queueingTail) would silently disappear from the
    // per-family / by-nature breakdown while still counting in the aggregate — an honesty gap. This fails CI first.
    const familyKeys = new Set(CAPABILITIES.filter((c) => c.kind === 'modeling-family').flatMap((c) => c.configKeys));
    for (const le of entries) {
      if (!le.entry.groundTruth.some((g) => g.measured !== null)) continue; // only scored entries feed the breakdown
      for (const t of le.entry.tunables) {
        if (!isFitted(t.fit)) continue; // only fitted tunables attribute to a family (coverage.ts corpusByFamily)
        expect(familyKeys.has(t.key), `corpus "${le.entry.name}" fits '${t.key}', which maps to NO modeling family — its measured evidence would vanish from the coverage breakdown`).toBe(true);
      }
    }
  });
});

describe('metrics × regimes grid — complete and unique', () => {
  it('covers all six metrics × three regimes exactly once', () => {
    const metrics: GridMetric[] = ['throughputCeiling', 'tail', 'bottleneck', 'cost', 'availability', 'transient'];
    const regimes: GridRegime[] = ['below-knee', 'at-knee', 'past-saturation'];
    expect(GRID.length).toBe(metrics.length * regimes.length);
    const seen = new Set(GRID.map((g) => `${g.metric}|${g.regime}`));
    expect(seen.size, 'duplicate grid cell').toBe(GRID.length);
    for (const m of metrics) for (const r of regimes) expect(seen.has(`${m}|${r}`), `missing grid cell ${m}|${r}`).toBe(true);
  });

  it('a cost/availability cell that is sourced OR a hole never carries a fitted-only claim', () => {
    for (const g of GRID) if (g.anchor === null) expect(g.note, `an anchorless cell must carry an honest note (${g.metric}|${g.regime})`).toBeDefined();
  });
});

describe('the matrix is HONEST — green only where evidence exists (owner mandate)', () => {
  it('only 2 of 8 modeling families are validated — the other six are NOT green', () => {
    expect(matrix.headline.totalFamilies).toBe(8);
    expect(matrix.headline.calibratedFamilies).toBe(2);
    expect(matrix.headline.calibratedFamilies, 'gaps must be visible: calibrated < total').toBeLessThan(matrix.headline.totalFamilies);
  });

  it('the hot-path solvers (evaluate, evaluateBatch) are oracle-graded (differential) yet NOT greened without a measured residual', () => {
    // V&V phase-1 P0: evaluate is now anchored by a differential against an INDEPENDENT re-derivation of the flow
    // algebra (evaluate.differential.test.ts), and evaluateBatch inherits it via a batch-consistency law. The
    // honest state is `verified` (an anchor, no measured residual) — NEVER `validated`, which would require a
    // measured system. This lint pins that the anchor is real AND that the cell was not greened to look better.
    for (const id of ['evaluate', 'evaluateBatch']) {
      const row = matrix.rows.find((r) => r.id === id);
      expect(row?.anchored, `${id} must now carry its real oracle anchor`).toBe(true);
      expect(row?.oracles, `${id} must be anchored by the independent differential`).toContain('differential');
      expect(row?.calibrated, `${id} has no measured residual — it must NOT be greened`).toBe(false);
      expect(row?.status, `${id} is verified (anchor, no measured residual), not validated`).toBe('verified');
    }
  });

  it('a validated row has BOTH an anchor and a measured residual; a verified row has an anchor but no residual', () => {
    for (const r of matrix.rows) {
      if (r.status === 'validated') { expect(r.anchored).toBe(true); expect(r.calibrated).toBe(true); }
      if (r.status === 'verified') { expect(r.anchored).toBe(true); expect(r.calibrated).toBe(false); }
      if (r.status === 'unvalidated') expect(r.calibrated).toBe(false);
    }
  });

  it('the capability status counts partition the whole axis (no cell uncounted)', () => {
    const h = matrix.headline;
    expect(h.validated + h.verified + h.sourced + h.unvalidated).toBe(h.totalCapabilities);
    expect(h.totalCapabilities).toBe(CAPABILITIES.length);
  });

  it('exactly three metrics×regimes cells are corpus-validated (throughput at-knee, bottleneck below-knee, tail below-knee)', () => {
    // adds the corpus's first meanLatencyMsAtLoad points (MongoDB Atlas + ScyllaDB, benchANT YCSB), which
    // flips `tail|below-knee` from an honest "awaits one" hole to corpus-validated.
    const validatedCells = matrix.grid.filter((g) => g.status === 'validated').map((g) => `${g.metric}|${g.regime}`).sort();
    expect(validatedCells).toEqual(['bottleneck|below-knee', 'tail|below-knee', 'throughputCeiling|at-knee']);
  });
});

describe('evidence natures — the honest reframe (each nature carries its OWN appropriate bar)', () => {
  const familyRows = matrix.rows.filter((r) => r.kind === 'modeling-family');

  it('every modeling family declares an evidence nature (solvers do not)', () => {
    for (const r of familyRows) expect(r.nature, `family ${r.id} must declare a nature`).toBeDefined();
    for (const r of matrix.rows.filter((x) => x.kind === 'solver')) expect(r.nature, `solver ${r.id} has no nature`).toBeUndefined();
  });

  it('a family is `sourced-algebra` IFF its validationKind is `sourced` (declared consistency, robust to corpus growth)', () => {
    for (const r of familyRows) expect(r.nature === 'sourced-algebra', `nature/validationKind mismatch for ${r.id}`).toBe(r.validationKind === 'sourced');
  });

  it('the three natures partition the 8 families exactly (2 measured-capacity · 3 theory-dynamics · 3 sourced-algebra)', () => {
    const counts = Object.fromEntries(matrix.headline.byNature.map((g) => [g.nature, g.families.length]));
    expect(counts).toEqual({ 'measured-capacity': 2, 'theory-dynamics': 3, 'sourced-algebra': 3 });
    const total = matrix.headline.byNature.reduce((s, g) => s + g.families.length, 0);
    expect(total, 'every family lands in exactly one nature group').toBe(matrix.headline.totalFamilies);
  });

  it('only measured-capacity families can be `validated`; theory-dynamics stay `verified`, sourced-algebra stay `sourced` (the reframe, not a gap)', () => {
    for (const g of matrix.headline.byNature) {
      if (g.nature === 'theory-dynamics') for (const f of g.families) expect(f.status, `${f.name} is theory-anchored, honestly verified`).toBe('verified');
      if (g.nature === 'sourced-algebra') for (const f of g.families) expect(f.status, `${f.name} is deterministic algebra, honestly sourced`).toBe('sourced');
      if (g.nature === 'measured-capacity') expect(g.validatedCount, 'both measured-capacity families are validated').toBe(g.families.length);
    }
  });
});

describe('fidelity freshness — committed docs/FIDELITY.md == a fresh `pnpm fidelity`', () => {
  it('docs/FIDELITY.md is exactly what the generator emits (regenerate with `pnpm fidelity` and commit)', () => {
    const committed = readFileSync(fidelityPath(), 'utf8').replace(/\r\n/g, '\n');
    const fresh = renderFidelity(matrix, report) + '\n';
    expect(committed, 'docs/FIDELITY.md is stale — run `pnpm fidelity` and commit').toBe(fresh);
  });
});
