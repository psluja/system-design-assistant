import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// F3 (readiness audit): the bundled MCP server the extension spawns is `dist/mcp-server.cjs`. The audit caught it
// STALE — built ~13 min before HEAD, so it was missing that week's tools (run_uncertainty, every scenario tool) and
// an agent driving the "named MCP path" got an old toolset. `dist/` is gitignored (not a committed artifact, so it
// cannot rot IN the repo), and `pnpm package` now rebuilds before packaging (so the shipped .vsix is always fresh).
// This test is the mechanism that CANNOT SILENTLY LIE about a LOCAL stale build: if `dist/mcp-server.cjs` exists but
// predates any production source it bundles, the suite goes RED — you cannot run a stale server past a green board.
// When the bundle is absent (a fresh clone that has not built the extension) the test passes with a note: that is
// "not built", not "stale", and forcing a build to run unit tests would be the wrong coupling.

const here = dirname(fileURLToPath(import.meta.url)); // app/vscode/src
const distServer = resolve(here, '..', 'dist', 'mcp-server.cjs');
// The two most-edited layers that bundle into the server and define its TOOL SURFACE (the audit's drift axis): the
// extension's own server entry (this package's src) and the shared MCP tool implementations (@sda/mcp src).
const bundledSourceRoots = [here, resolve(here, '..', '..', 'mcp', 'src')];

/** The newest mtime (ms) of a PRODUCTION `.ts` under `dir` (recursively) — tests/type-decls excluded, since they do
 *  not bundle into the server, so editing a test after a build must not read as the server being stale. */
function newestSourceMtime(dir: string): number {
  let newest = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(resolve(d, e.name));
      } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.e2e.test.ts')) {
        newest = Math.max(newest, statSync(resolve(d, e.name)).mtimeMs);
      }
    }
  };
  walk(dir);
  return newest;
}

describe('dist/mcp-server.cjs freshness (F3)', () => {
  it('is at least as new as the tool-surface source it bundles (or absent = unbuilt, not stale)', () => {
    if (!existsSync(distServer)) {
      // Unbuilt working tree (fresh clone) — nothing to be stale. `pnpm build` produces it; the vsix `package`
      // script rebuilds before packaging so a released artifact is never stale.
      // eslint-disable-next-line no-console
      console.warn('dist/mcp-server.cjs not built yet — freshness check skipped (run `pnpm build` before the e2e / to ship).');
      return;
    }
    const built = statSync(distServer).mtimeMs;
    const newestSrc = Math.max(...bundledSourceRoots.map(newestSourceMtime));
    expect(
      built,
      'dist/mcp-server.cjs is STALE — rebuild it (`pnpm --filter sda-vscode build`) so the MCP server an agent runs reflects the current tools',
    ).toBeGreaterThanOrEqual(newestSrc);
  });
});
