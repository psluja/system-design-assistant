import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALGORITHM_FIELDS,
  FEATURE_FIELDS,
  collectTags,
  generateCatalogs,
  repoRoot,
} from './generate-catalogs.mjs';

// CATALOG LINTS + FRESHNESS (owner-ordered routine; the structure.test pattern — engine/solver-contract/src/
// structure.test.ts). The @algorithm/@feature headers are machine-readable contracts: tagged => every field
// present, every link resolvable, and the committed docs/ALGORITHMS.md + docs/FEATURES.md byte-identical to what
// the generator produces from the tags. A tag edited without regeneration — or a link that rots — fails CI
// rather than passing silently. Repro/refresh command for any failure here: `pnpm catalogs` (then commit the
// regenerated docs).

const { algorithms, features } = collectTags();

/** Split a comma-separated tag field into items, dropping each item's trailing `(annotation)`. */
const items = (value: string): string[] =>
  value
    .split(',')
    .map((s) => s.trim().replace(/\s*\([^)]*\)$/, ''))
    .filter(Boolean);

const isNone = (value: string): boolean => value.trim().toLowerCase().startsWith('none');
const resolves = (path: string): boolean => existsSync(join(repoRoot, path));

describe('catalog lints — every @algorithm header is complete and its links resolve', () => {
  it('the owner-named algorithmic modules are tagged (the catalog cannot silently shrink)', () => {
    const tagged = new Set(algorithms.map((t) => t.path));
    const roster = [
      'app/presenter/src/edge-routing.ts', //     A* orthogonal router
      'app/presenter/src/layout-ports.ts', //     PAVA port slide
      'engine/sim/src/profile.ts', //             NHPP inversion
      'engine/sim/src/transient.ts', //           windowed transient run
      'engine/sim/src/des.ts', //                 DES + Vitter reservoirs
      'engine/sim/src/rng.ts', //                 mulberry32 home 1
      'engine/solver-contract/src/harness/generator.ts', // mulberry32 home 2
      'engine/solve/src/network/__fixtures__/no-class-corpus.ts', // PRNG home 3 (LCG)
      'engine/solver-contract/src/native/search.ts', // native search descent
      'engine/solve/src/network/build.ts', //     processor-sharing split
      'engine/solver-contract/src/gpu/webgpu.ts', // solver GPU kernel
      'app/presenter/src/layout-gpu/webgpu.ts', //  layout GPU kernel
      'content/sda/src/envelope.ts', //           envelope inversion
    ];
    for (const path of roster) {
      expect(tagged.has(path), `${path} must carry an @algorithm header (owner roster)`).toBe(true);
    }
  });

  it('there is at least one algorithm and no duplicate (path, name) entry', () => {
    expect(algorithms.length).toBeGreaterThan(0);
    const seen = new Set(algorithms.map((t) => `${t.path} :: ${t.name}`));
    expect(seen.size, 'duplicate @algorithm entries').toBe(algorithms.length);
  });

  for (const tag of algorithms) {
    describe(`${tag.path} — ${tag.name}`, () => {
      it('carries every field of the ONE header form', () => {
        for (const field of ALGORITHM_FIELDS) {
          expect(tag.fields[field], `@${field} missing or empty (form: @algorithm + ${ALGORITHM_FIELDS.join('/')})`).toBeTruthy();
        }
        const unknown = Object.keys(tag.fields).filter((f) => !ALGORITHM_FIELDS.includes(f));
        expect(unknown, `unknown fields ${unknown.join(', ')} — the header form has exactly ${ALGORITHM_FIELDS.length} fields`).toEqual([]);
      });

      it('@where-tested paths resolve', () => {
        const tests = items(tag.fields['where-tested'] ?? '');
        expect(tests.length, '@where-tested must name at least one test file').toBeGreaterThan(0);
        for (const t of tests) expect(resolves(t), `@where-tested link does not resolve: ${t}`).toBe(true);
      });
    });
  }
});

describe('catalog lints — every @feature header is complete and its links resolve', () => {
  it('there is at least one feature and feature names are unique', () => {
    expect(features.length).toBeGreaterThan(0);
    const names = new Set(features.map((t) => t.name));
    expect(names.size, 'duplicate @feature names').toBe(features.length);
  });

  for (const tag of features) {
    describe(`${tag.path} — ${tag.name}`, () => {
      it('carries every field of the ONE header form', () => {
        for (const field of FEATURE_FIELDS) {
          expect(tag.fields[field], `@${field} missing or empty (form: @feature + ${FEATURE_FIELDS.join('/')})`).toBeTruthy();
        }
        const unknown = Object.keys(tag.fields).filter((f) => !FEATURE_FIELDS.includes(f));
        expect(unknown, `unknown fields ${unknown.join(', ')} — the header form has exactly ${FEATURE_FIELDS.length} fields`).toEqual([]);
      });

      it('@algorithms links >=1 real tagged @algorithm module, or states none (data/plumbing)', () => {
        const value = tag.fields['algorithms'] ?? '';
        if (isNone(value)) return; // explicitly algorithm-free (data/plumbing) — honest and allowed
        const links = items(value);
        expect(links.length, '@algorithms must link at least one module or state `none (data/plumbing)`').toBeGreaterThan(0);
        const taggedAlgorithms = new Set(algorithms.map((t) => t.path));
        for (const link of links) {
          expect(resolves(link), `@algorithms link does not resolve: ${link}`).toBe(true);
          expect(taggedAlgorithms.has(link), `@algorithms link is not an @algorithm-tagged module: ${link}`).toBe(true);
        }
      });

      it('@docs pages exist (or none)', () => {
        const value = tag.fields['docs'] ?? '';
        if (isNone(value)) return;
        for (const page of items(value)) expect(resolves(page), `@docs page does not exist: ${page}`).toBe(true);
      });

      it('@e2e tests exist (or none, naming the covering suites)', () => {
        const value = tag.fields['e2e'] ?? '';
        if (isNone(value)) return;
        for (const t of items(value)) expect(resolves(t), `@e2e link does not resolve: ${t}`).toBe(true);
      });

      it('@status is shipped or partial', () => {
        expect(tag.fields['status'] ?? '', '@status must start with `shipped` or `partial`').toMatch(/^(shipped|partial)\b/);
      });
    });
  }
});

describe('catalog freshness — generated == committed (regenerate with `pnpm catalogs`)', () => {
  const committed = (name: string): string =>
    readFileSync(join(repoRoot, 'docs', name), 'utf8').replace(/\r\n/g, '\n');

  it('docs/ALGORITHMS.md is exactly what the tags generate', () => {
    const { algorithmsMd } = generateCatalogs();
    expect(committed('ALGORITHMS.md'), 'docs/ALGORITHMS.md is stale — run `pnpm catalogs` and commit').toBe(algorithmsMd);
  });

  it('docs/FEATURES.md is exactly what the tags generate', () => {
    const { featuresMd } = generateCatalogs();
    expect(committed('FEATURES.md'), 'docs/FEATURES.md is stale — run `pnpm catalogs` and commit').toBe(featuresMd);
  });
});
