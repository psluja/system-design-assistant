import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

// MECHANICAL DEPENDENCY LINT (owner rule 1, 2026-07-03: meta-model portability). Two invariants, enforced by a
// machine rather than by review because there is no ESLint/dependency-cruiser in this repo (the codebase's
// convention is to assert architecture invariants as tests):
//   (A) the contract CORE imports ONLY @sda/engine-core — never @sda/engine-solve, @sda/content or any app
//       package — so the contract is portable to a second solver with no engine coupling;
//   (B) the SOLVER ADAPTERS (src/incumbent/ and src/native/) are the ONLY places @sda/engine-solve may be
//       imported, so the heavy solver loaders (incumbent: MiniZinc/clingo WASM) and the cell-network evaluator
//       (native) stay behind dedicated dynamically-importable entries (bundle separation, docs §6). Both adapters
//       are reached via their own package entry (@sda/solver-contract/incumbent, /native), never a static import
//       from a runtime composition root, so neither is in the core's static graph — hence both are scoped OUT of
// the pure-core checks below by the same rule (added native under the incumbent's discipline).
//   (C) the contract carries ZERO cloud/domain vocabulary — grep it for aws/lambda/latency ⇒ zero (docs §8).

const here = dirname(fileURLToPath(import.meta.url));

/** Every .ts file under src/, as paths relative to src/ (posix slashes for stable matching). */
function allTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = allTsFiles(here).map((f) => ({ rel: relative(here, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8') }));

/** The module specifiers a file imports (both `import … from 'x'` and `import('x')`). */
function importsOf(text: string): string[] {
  const specs: string[] = [];
  const staticRe = /(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/g;
  const dynRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [staticRe, dynRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) specs.push(m[1] as string);
  }
  return specs;
}

// The CORE is everything except the solver ADAPTERS. incumbent/, native/ and gpu/ are each reached only through
// their own dynamically-imported package entry (never a static runtime import), so — exactly like the incumbent —
// they may import @sda/engine-solve and are excluded from the pure-core checks. gpu/ is the WebGPU
// EvaluateBatch backend: the SECOND implementation of the batch capability behind the same seam; it compiles the
// engine's cell network (buildNetwork) and reuses native's CPU reference as its fallback, so it lives under the
// same adapter discipline. Everything else is held to @sda/engine-core only.
const isCore = (rel: string): boolean => !rel.startsWith('incumbent/') && !rel.startsWith('native/') && !rel.startsWith('gpu/');
const isTest = (rel: string): boolean => rel.endsWith('.test.ts');
// A "suite" file imports vitest as a describe/it factory (dev-only in spirit) even though it lives in src/: the
// conformance suite (conformance/) and the oracle-harness RUNNER (harness/harness.ts). Both are engine-core-pure
// otherwise; the pure-core check below excludes them exactly as it excludes .test.ts files. (The harness's
// generator/oracle modules are NOT suites — they import no vitest — so only harness.ts is named, not harness/.)
const isTestOrSuite = (rel: string): boolean => isTest(rel) || rel.startsWith('conformance/') || rel === 'harness/harness.ts';

// The invariant these lints protect is BUNDLE SEPARATION (docs §6): no SHIPPED RUNTIME module may statically
// import @sda/engine-solve (the heavy WASM loaders) outside the ./incumbent entry. A `.test.ts` file is neither
// shipped nor in any runtime bundle's static graph, so it is exempt — exactly as the incumbent adapter's OWN
// test imports @sda/engine-solve to wire the native solvers (incumbent/index.test.ts), and as the engine's
// differential tests do. The exemption is the honest scope of the rule (runtime surface), not a weakening:
// every NON-test core module below is still held strictly to @sda/engine-core only.
describe('dependency lint (A) — the contract core imports only @sda/engine-core', () => {
  it('no NON-TEST core module imports @sda/engine-solve, @sda/content, or an app package', () => {
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      if (!isCore(rel) || isTest(rel)) continue; // .test.ts files are dev-only (see the bundle-separation note above)
      for (const spec of importsOf(text)) {
        if (!spec.startsWith('@sda/')) continue;
        // The core may only depend on @sda/engine-core. Test files (excluded above) additionally reach the
        // corpus and the incumbent to wire the oracle — those are dev-only and never in a runtime bundle.
        if (spec === '@sda/engine-core') continue;
        offenders.push(`${rel} → ${spec}`);
      }
    }
    expect(offenders, `non-test core modules may import only @sda/engine-core:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('non-test core modules import no third-party runtime package (pure types + engine-core)', () => {
    // The interfaces and models are pure — they pull in nothing but @sda/engine-core. (Test files may import
    // vitest and node builtins; suite files import vitest as a describe/it factory — those are dev-only.)
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      if (!isCore(rel) || isTestOrSuite(rel)) continue;
      for (const spec of importsOf(text)) {
        const bare = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
        const local = spec.startsWith('.') || spec.startsWith('@sda/engine-core');
        if (!local) offenders.push(`${rel} → ${spec} (${bare})`);
      }
    }
    expect(offenders, `non-test core modules must be pure:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('dependency lint (B) — @sda/engine-solve is imported ONLY from the solver adapters (incumbent + native + gpu)', () => {
  it('no NON-ADAPTER, NON-TEST module imports @sda/engine-solve (it lives behind the ./incumbent, ./native and ./gpu entries)', () => {
    // Runtime surface only: .test.ts files are dev-only and may wire the incumbent/native solvers to build the
    // oracle (harness/*.test.ts, exactly as incumbent/index.test.ts does) — they are never in a runtime bundle.
    // incumbent/, native/ and gpu/ are excluded via `isCore` (all three are dynamically-imported adapter entries).
    const offenders = files
      .filter(({ rel, text }) => isCore(rel) && !isTest(rel) && importsOf(text).some((s) => s === '@sda/engine-solve' || s.startsWith('@sda/engine-solve/')))
      .map(({ rel }) => rel);
    expect(offenders, `only src/incumbent/ + src/native/ + src/gpu/ (and dev-only .test.ts) may import @sda/engine-solve:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('each solver adapter IS reached via its own dedicated package entry (./incumbent, ./native, ./gpu), never statically re-exported by the core barrel', () => {
    const barrel = readFileSync(join(here, 'index.ts'), 'utf8');
    expect(barrel.includes('./incumbent')).toBe(false);
    expect(barrel.includes('./native')).toBe(false);
    expect(barrel.includes('./gpu')).toBe(false);
  });
});

describe('dependency lint (C) — zero cloud/domain vocabulary in the contract', () => {
  it('grep the whole package for cloud/product names ⇒ zero (the engine-agnostic invariant, docs §8)', () => {
    // Unambiguous cloud/product identifiers only. The engine deliberately tolerates generic performance words
    // like "latency" in WHY-comments (see engine/solve/src/facade.ts, search.ts) — those are queueing-theory
    // terms, not domain vocabulary — so they are NOT on this list. This test file names the forbidden words to
    // define the check, so it excludes itself from the scan (it is not shipped contract surface).
    const domain = /\b(aws|lambda|iam|fargate|dynamodb|kafka|postgres|redis)\b/i;
    const hits: string[] = [];
    for (const { rel, text } of files) {
      if (rel === 'dependency.test.ts') continue;
      for (const line of text.split('\n')) {
        if (domain.test(line)) hits.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(hits, `cloud/product vocabulary must not appear in the contract:\n${hits.join('\n')}`).toEqual([]);
  });
});
