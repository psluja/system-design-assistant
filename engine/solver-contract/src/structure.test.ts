import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// MECHANICAL STRUCTURE TEST (owner rule 2026-07-03: code as if machine-generated). Every capability module
// follows ONE repeated template and every source has a mirrored test. This walks the package and asserts the
// complete mirrored file set exists, so a capability added without its test — or a template drift — fails CI
// rather than passing silently. The rule is enforced by a machine, not by review.

const here = dirname(fileURLToPath(import.meta.url));
const capabilityDir = join(here, 'capability');
const harnessDir = join(here, 'harness');

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts');

describe('package structure — every capability mirrors one template', () => {
  const capabilities = sourceFiles(capabilityDir);

  it('there is at least one capability module', () => {
    expect(capabilities.length).toBeGreaterThan(0);
  });

  it('every capability source has a co-located mirrored test', () => {
    const files = new Set(readdirSync(capabilityDir));
    for (const src of capabilities) {
      const test = src.replace(/\.ts$/, '.test.ts');
      expect(files.has(test), `missing test for capability ${src}: expected ${test}`).toBe(true);
    }
  });

  it('every capability module follows the repeated template (WHY header + interface + two-implementations note)', () => {
    for (const src of capabilities) {
      const text = readFileSync(join(capabilityDir, src), 'utf8');
      // 1. A file-header WHY block naming the capability and referencing the design doc.
      expect(text.startsWith('// CAPABILITY:'), `${src}: must open with a "// CAPABILITY:" header`).toBe(true);
      expect(text.includes('docs/design/solver-contract.html'), `${src}: must reference the design doc`).toBe(true);
      // 2. An exported capability interface (the function-call interface the adapter implements).
      expect(/export interface [A-Z]\w+ \{\s*\(req:/.test(text), `${src}: must export a call-style capability interface`).toBe(true);
      // 3. The two-implementations justification (the §1 rule: an interface exists only if exercised twice).
      expect(text.includes('Two implementations'), `${src}: must name its two implementations`).toBe(true);
    }
  });

  it('the capability barrel re-exports every capability (no orphan module)', () => {
    const barrel = readFileSync(join(capabilityDir, 'index.ts'), 'utf8');
    for (const src of capabilities) {
      const base = src.replace(/\.ts$/, '');
      expect(barrel.includes(`./${base}'`), `barrel must re-export ./${base}`).toBe(true);
    }
  });
});

describe('package structure — the conformance suite mirrors the capabilities', () => {
  it('the conformance suite names a clause block for each §4 clause', () => {
    const suite = readFileSync(join(here, 'conformance', 'index.ts'), 'utf8');
    for (const clause of ['exactness', 'honest non-convergence', 'hard time-bound', 'determinism under seed', 'cancellation']) {
      expect(suite.includes(clause), `conformance suite must have a "${clause}" clause block`).toBe(true);
    }
  });
});

describe('package structure — each solver ADAPTER mirrors the co-located-test template (incumbent + native)', () => {
  // the native adapter mirrors the incumbent file-for-file — every source (INCLUDING the entry
  // index.ts) has a co-located test, so an adapter module added without its test fails CI rather than passing
  // silently. Held to the SAME machine-enforced rule as the capability + harness modules ("code as if machine-
  // generated"). Both adapters are checked, so the rule that admitted native admits any future adapter identically.
  for (const dir of ['incumbent', 'native'] as const) {
    const adapterDir = join(here, dir);
    const sources = readdirSync(adapterDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    it(`every ${dir}/ source (entry included) has a co-located mirrored test`, () => {
      expect(sources.length, `${dir}/ must have at least an index source`).toBeGreaterThan(0);
      const files = new Set(readdirSync(adapterDir));
      for (const src of sources) {
        const test = src.replace(/\.ts$/, '.test.ts');
        expect(files.has(test), `missing test for ${dir}/${src}: expected ${dir}/${test}`).toBe(true);
      }
    });
  }
});

describe('package structure — the oracle harness mirrors the same template', () => {
  // The harness (generator/oracle/harness) is held to the SAME machine-enforced mirror rule as the capability
  // modules: every source has a co-located test, so a harness module added without its test — or deleted — fails
  // CI rather than passing silently. This is the owner's "code as if machine-generated" rule extended to phase 1.
  const harnessSources = sourceFiles(harnessDir);

  it('there is a harness (generator + oracle + runner)', () => {
    expect(harnessSources.length).toBeGreaterThanOrEqual(3);
  });

  it('every harness source has a co-located mirrored test', () => {
    const files = new Set(readdirSync(harnessDir));
    for (const src of harnessSources) {
      const test = src.replace(/\.ts$/, '.test.ts');
      expect(files.has(test), `missing test for harness module ${src}: expected ${test}`).toBe(true);
    }
  });

  it('the harness runner names its two layers (differential + properties) and the sanity gate', () => {
    const runner = readFileSync(join(harnessDir, 'harness.ts'), 'utf8');
    for (const marker of ['differential', 'properties', 'determinism under seed', 'monotonicity', 'per-instance budget']) {
      expect(runner.includes(marker), `the harness runner must name "${marker}"`).toBe(true);
    }
  });
});
