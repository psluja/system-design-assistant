import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// THE RENAME GUARD (owner-ordered atomic renames originRps → demandRps → assumedRps). A lint-as-test in the codebase's
// convention of asserting architecture invariants mechanically (there is no ESLint rule for this). The universal
// traffic-origin registry key was renamed TWICE; BOTH legacy names — `originRps` and `demandRps` — must NOT reappear
// anywhere in the SHIPPED SOURCE (every .ts/.tsx under engine/, content/ and app/). The ONLY files permitted to name
// them are the backward-compat migration mapping (document.ts) and its test, which MUST name the old keys to keep
// every historical export loading forever (client-persistence). Historical DOCS (docs/design/*.html, backlog/*.md)
// are a record of what the names once were and are deliberately out of scope — this guard walks source, not
// documentation. So an old name can never creep back into a manifest, a projector, a shell label, an MCP tool text or
// a test.

const LEGACY_KEYS = ['originRps', 'demandRps'] as const;
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', '.vite', 'out', '.vscode-test']);

/** The workspace roots whose source is HELD to the new name. Scanning these three package trees is the shipped-code
 *  surface; docs/backlog/examples/tools are intentionally excluded (see the header). */
const SOURCE_ROOTS = ['engine', 'content', 'app'];

/** The two files that MUST name a legacy key (the migration mapping + its test), plus this guard itself (it names the
 *  keys to define the check). Any OTHER file naming `originRps`/`demandRps` is a regression. */
const ALLOWLIST = new Set([
  'app/core/src/document.ts',
  'app/core/src/document.migration.test.ts',
  'app/core/src/demand-key-rename.guard.test.ts',
]);

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('repo root (pnpm-workspace.yaml) not found from ' + start);
}

function allSourceFiles(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) allSourceFiles(full, out);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const files = SOURCE_ROOTS.flatMap((r) => allSourceFiles(join(ROOT, r), [])).map((f) => ({
  rel: relative(ROOT, f).replace(/\\/g, '/'),
  text: readFileSync(f, 'utf8'),
}));

describe('rename guard — neither legacy demand key name can creep back into the code', () => {
  for (const legacy of LEGACY_KEYS) {
    it(`\`${legacy}\` appears ONLY in the migration mapping + its test (nowhere else in engine/, content/, app/)`, () => {
      const offenders = files.filter((f) => !ALLOWLIST.has(f.rel) && f.text.includes(legacy)).map((f) => f.rel);
      expect(
        offenders,
        `the old registry key "${legacy}" reappeared in shipped source — rename it to "assumedRps" (only the persistence migration may name it):\n${offenders.join('\n')}`,
      ).toEqual([]);
    });
  }

  it('the guard is not vacuous: it scanned the tree and the migration mapping still names BOTH legacy keys', () => {
    expect(files.length).toBeGreaterThan(100); // the three package trees really were walked
    const doc = files.find((f) => f.rel === 'app/core/src/document.ts');
    expect(doc, 'app/core/src/document.ts must be present in the scan').toBeDefined();
    for (const legacy of LEGACY_KEYS) {
      expect(doc!.text.includes(legacy), `the migration mapping must still name the legacy key "${legacy}" it maps from`).toBe(true);
    }
  });

  // THE CHAIN'S FOURTH LINK (doc: load-curves §3): `assumedRps` is now SUGAR for a generator port function. The key
  // itself REMAINS legal source vocabulary — it is the reconciled level cell worlds/MC/the sweep address — so it is
  // not banned like the renamed keys. What the guard pins instead is that the SUGAR-TO-GENERATOR migration stays
  // wired: document.ts must keep compiling a source's assumedRps config to `generate` on load, forever.
  it('the origin-to-generator migration (link #4) is still wired in document.ts', () => {
    const doc = files.find((f) => f.rel === 'app/core/src/document.ts');
    expect(doc).toBeDefined();
    expect(doc!.text.includes('migrateOriginToGenerator'), 'document.ts must keep the assumedRps → generate migration (the chain\'s fourth link)').toBe(true);
    expect(doc!.text.includes("kind: 'generate'"), 'the migration must compile the sugar to a generate transform').toBe(true);
  });
});
