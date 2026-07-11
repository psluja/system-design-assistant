import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LOAD_STAGES_DEFAULTS } from './load-stages';

// NO-MAGIC-NUMBERS lint (doc: load-stages §16.3 — "change any of them in ONE line"; the pricing-identity lint
// pattern, content/sda/src/catalogs.test.ts). LOAD_STAGES_DEFAULTS is the SINGLE HOME of the two-tier evaluator's
// tunables. This scoped STRUCTURE test reads the sweep / two-tier / worker surfaces AS TEXT and asserts each
// distinctive tunable is read through `LOAD_STAGES_DEFAULTS.<key>` and NEVER re-literaled — so a tuning change is
// one line, and a copy that would silently drift fails CI. Repro on failure: replace the bare number in the named
// file with `LOAD_STAGES_DEFAULTS.<key>` (import it from ./load-stages). The values are read from the object itself,
// so this lint auto-tracks a retuning (change 96 → 100 in the home and the ban follows) — never a second copy.

// content/sda/src → ../../.. is the repo root (the same climb the catalog generator uses).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// The surfaces that CONSUME the numeric tunables — the analytic sweep, the two-tier composition, and the two
// ambient workers that pass the live-vs-rest resolution. (The editor / presenter surfaces carry their OWN display
// constants — a warn floor, hours-in-a-day — which are a different concern and legitimately local, so they are not
// policed here; the tunable HOME is what this lint pins.)
const CONSUMER_FILES = [
  'content/sda/src/time-sweep.ts',
  'content/sda/src/two-tier.ts',
  'app/web/src/two-tier-worker.ts',
  'app/vscode/webview/two-tier-worker.ts',
] as const;

// The tunables whose value is DISTINCTIVE enough that its bare literal in a consumer surface can only be a
// re-literaled copy of the one home (the small shared values — spanRepeats:2, tier2WarmupFraction:0.5 — legitimately
// coincide with unrelated arithmetic like `windowS / 2`, so they are proven positively below, not banned).
const ENFORCED: ReadonlyArray<keyof typeof LOAD_STAGES_DEFAULTS> = [
  'restPointsPerCycle',
  'livePointsPerCycle',
  'liveWindowTarget',
  'liveTier2Events',
];

/** Strip block + line comments so a rationale NUMBER inside a comment never trips the lint (a `://` URL is kept). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Read a consumer surface with comments stripped and numeric `_` separators folded (so `500_000` reads as the bare
 *  literal `500000`), leaving identifier underscores (LOAD_STAGES_DEFAULTS) intact — the digit-only fold. */
const consumerCode = (rel: string): string => stripComments(readFileSync(join(repoRoot, rel), 'utf8')).replace(/(\d)_(\d)/g, '$1$2');

describe('load-stages tunables — ONE home (LOAD_STAGES_DEFAULTS), never re-literaled in the surfaces', () => {
  const bodies = CONSUMER_FILES.map((file) => ({ file, code: consumerCode(file) }));

  for (const key of ENFORCED) {
    const value = LOAD_STAGES_DEFAULTS[key];
    // A standalone occurrence of the value — not part of a longer number (1024 ⊅ 24) or an identifier.
    const literal = new RegExp(`(?<![\\w.])${value}(?![\\w.])`);
    for (const { file, code } of bodies) {
      it(`${file}: does not re-literal ${key} (${value})`, () => {
        expect(literal.test(code), `${file} contains the bare literal ${value} — read LOAD_STAGES_DEFAULTS.${key} instead`).toBe(false);
      });
    }
    it(`${key} (${value}) is actually READ via LOAD_STAGES_DEFAULTS in a consumer (the home is not bypassed)`, () => {
      const used = bodies.some((b) => b.code.includes(`LOAD_STAGES_DEFAULTS.${key}`));
      expect(used, `no consumer reads LOAD_STAGES_DEFAULTS.${key} — is the tunable inlined somewhere the ban missed?`).toBe(true);
    });
  }

  // Non-distinctive tunables — small values that legitimately coincide with unrelated arithmetic (a `/ 4`, a `* 2`)
  // — are proven POSITIVELY (read through the home) rather than banned as bare literals. `stagePointsFactor` drives
  // the §16.3 A feature-resolution rule (windowS ≤ shortestFeatureStage / stagePointsFactor), so it must read the home.
  const POSITIVE_READ: ReadonlyArray<keyof typeof LOAD_STAGES_DEFAULTS> = ['stagePointsFactor'];
  for (const key of POSITIVE_READ) {
    it(`${key} (${LOAD_STAGES_DEFAULTS[key]}) is READ via LOAD_STAGES_DEFAULTS in a consumer (the resolution rule reads the home)`, () => {
      const used = bodies.some((b) => b.code.includes(`LOAD_STAGES_DEFAULTS.${key}`));
      expect(used, `no consumer reads LOAD_STAGES_DEFAULTS.${key} — is the tunable inlined as a bare literal?`).toBe(true);
    });
  }

  it('the consumer surfaces reference the tunable home enough to be non-vacuous (≥ 6 reads)', () => {
    const total = bodies.reduce((n, b) => n + (b.code.match(/LOAD_STAGES_DEFAULTS\./g)?.length ?? 0), 0);
    expect(total).toBeGreaterThanOrEqual(6);
  });
});
