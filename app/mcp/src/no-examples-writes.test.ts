import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// GUARD (owner directive 2026-07-04) — NO test in this package may WRITE under examples/. Those are the owner's
// live, hand-edited .sda.json design files (often carrying uncommitted bands); a test that serializes a design back
// over one shows up all day as a spurious "owner file modified" and can clobber real work (it did, twice). Tests may
// READ an example (a copyFileSync/readFileSync SOURCE) but must WRITE only to a temp/workspace path. This lint pins
// that mechanically across the whole suite, so no future test can quietly reintroduce the foot-gun.

const here = dirname(fileURLToPath(import.meta.url)); // app/mcp/src

/** Every *.test.ts in this package, as {file, text}. */
function testSources(): { file: string; text: string }[] {
  return readdirSync(here)
    .filter((n) => n.endsWith('.test.ts'))
    .map((n) => ({ file: n, text: readFileSync(resolve(here, n), 'utf8') }));
}

/** The DESTINATION expression of every write sink in `text` — the thing a test could clobber a file THROUGH:
 *  writeFileSync's 1st arg, copyFileSync's 2nd (dest) arg, and a save_design tool call's args object. Read SOURCES
 *  (readFileSync, copyFileSync's 1st arg) are deliberately excluded — reading an example is fine. */
function writeDestinations(text: string): string[] {
  const dests: string[] = [];
  for (const m of text.matchAll(/writeFileSync\s*\(\s*([^,]+),/g)) dests.push(m[1] as string);
  for (const m of text.matchAll(/copyFileSync\s*\([^,]+,\s*([^)]+)\)/g)) dests.push(m[1] as string); // dest only
  for (const m of text.matchAll(/save_design'\s*,\s*(\{[^}]*\})/g)) dests.push(m[1] as string); // {path?} arg
  return dests;
}

describe('owner example files are read-only to the mcp test suite', () => {
  it('no test writes under examples/: every write destination targets a temp/workspace path', () => {
    for (const { file, text } of testSources()) {
      if (file === 'no-examples-writes.test.ts') continue; // this guard's own regex literals are not write calls
      for (const dest of writeDestinations(text)) {
        expect(
          /examples/i.test(dest),
          `${file}: a write targets examples/ — redirect it to a temp path (os tmpdir) or the workspace, never the owner's live files: ${dest.trim()}`,
        ).toBe(false);
      }
    }
  });

  it('the finale timing test loads the owner design from a TEMP COPY (so it structurally cannot write examples/)', () => {
    const unc = testSources().find((s) => s.file === 'uncertainty.test.ts');
    expect(unc, 'uncertainty.test.ts not found').toBeDefined();
    // it reads the example only to COPY it into the temp dir, then loads the temp copy — no write handle on examples/
    expect(unc!.text).toMatch(/copyFileSync/);
    expect(unc!.text).toMatch(/tmpdir\(\)/);
  });
});
