// Vendors the in-browser SOLVERS into public/ so a fresh clone works from `pnpm install && pnpm dev`
// (runs automatically via predev/prebuild; idempotent and fast).
//
//  • clingo  — copied from the lockfile-pinned `clingo-wasm` npm package (the package IS the source of
//              truth; never hand-edit public/clingo).
//  • minizinc — our CUSTOM MiniZinc+HiGHS wasm bundle. There is NO npm source for it (the official
//              package ships no MIP solver), so the bundle is COMMITTED to git and this script only
//              VERIFIES it, failing with honest guidance instead of letting the app degrade silently.
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', 'public');

// ── clingo: copy the web artifacts from the resolved package ─────────────────────────────────────────
const require = createRequire(import.meta.url);
// Resolve the package entry, then locate its dist/ (the entry may sit in dist/ or the package root).
const entry = require.resolve('clingo-wasm');
let dist = dirname(entry);
if (!existsSync(join(dist, 'clingo.wasm'))) dist = join(dist, 'dist');
if (!existsSync(join(dist, 'clingo.wasm'))) {
  console.error('vendor-solvers: cannot locate clingo-wasm dist/ (looked near ' + entry + ')');
  process.exit(1);
}
const clingoDir = join(publicDir, 'clingo');
mkdirSync(clingoDir, { recursive: true });
for (const f of ['clingo.wasm', 'clingo.web.js', 'clingo.web.worker.js']) {
  copyFileSync(join(dist, f), join(clingoDir, f));
}

// ── minizinc: verify the committed bundle is present ─────────────────────────────────────────────────
const mznDir = join(publicDir, 'minizinc');
const missing = ['minizinc.mjs', 'minizinc-worker.js', 'minizinc.wasm', 'minizinc.data'].filter(
  (f) => !existsSync(join(mznDir, f)),
);
if (missing.length > 0) {
  console.error(
    `vendor-solvers: the MiniZinc+HiGHS bundle is missing from public/minizinc (${missing.join(', ')}).\n` +
      'It is committed to git — restore it with `git checkout -- app/web/public/minizinc`,\n' +
      'or rebuild it reproducibly via tools/minizinc-wasm (requires Docker).',
  );
  process.exit(1);
}

console.log('vendor-solvers: clingo copied from clingo-wasm@npm; minizinc bundle verified.');
