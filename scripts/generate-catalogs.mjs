#!/usr/bin/env node
// CATALOG GENERATOR (owner-ordered routine, 2026-07: @algorithm/@feature headers → generated catalogs).
//
// Scans every production source under engine/ content/ app/ for the two machine-readable header forms
// and deterministically renders docs/ALGORITHMS.md + docs/FEATURES.md. The committed catalogs are
// GENERATED artifacts: the source of truth is the tag block at the top of each module, and a freshness
// test (scripts/generate-catalogs.test.ts) asserts generated == committed, so a tag edited without
// regeneration fails the suite rather than rotting silently.
//
// TAG GRAMMAR (one normalized form, parsed line-anchored — text inside strings cannot inject because a
// block only opens on a line that STARTS with `// @algorithm ` / `// @feature `):
//
//   // @algorithm <Display Name>
//   // @problem <text…>
//   // @approach <text…>
//   // @complexity <text…>
//   // @citations <text…>
//   // @invariants <text…>
//   // @where-tested <repo-relative test paths, comma-separated>
//
//   // @feature <Display Name>
//   // @story <one-line user story>
//   // @surfaces <where the user touches it>
//   // @algorithms <repo-relative @algorithm module paths, comma-separated, or `none (data/plumbing)`>
//   // @docs <docs/design pages, comma-separated, or `none`>
//   // @e2e <repo-relative e2e test paths, comma-separated, or `none`>
//   // @status <shipped | partial>
//
// A field's value may wrap: a following `//   <text>` line (two-plus spaces, no `@field`) continues the
// previous field. A block ends at the first line that is not a `//` comment.
//
// DETERMINISM: output depends only on the tagged files (sorted paths, fixed package order, LF endings,
// no timestamps) — rerunning on an unchanged tree is byte-identical, which is what the freshness test
// asserts. Run via `pnpm catalogs` from the repo root.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Roots that hold production source; everything else (docs, tools, examples, backlog) carries no tags. */
const SCAN_ROOTS = ['engine', 'content', 'app'];
/** Directories never scanned (dependencies, build output, vendored/downloaded artifacts). */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'coverage', '.vscode-test', '.turbo']);

const isSource = (name) =>
  (name.endsWith('.ts') || name.endsWith('.tsx')) &&
  !name.endsWith('.d.ts') &&
  !name.endsWith('.test.ts') &&
  !name.endsWith('.test.tsx');

/** All production source files under the scan roots, as repo-relative slash paths, sorted. */
export function sourceFiles(root = repoRoot) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(join(dir, entry.name));
      } else if (entry.isFile() && isSource(entry.name)) {
        files.push(relative(root, join(dir, entry.name)).replace(/\\/g, '/'));
      }
    }
  };
  for (const r of SCAN_ROOTS) walk(join(root, r));
  return files.sort();
}

export const ALGORITHM_FIELDS = ['problem', 'approach', 'complexity', 'citations', 'invariants', 'where-tested'];
export const FEATURE_FIELDS = ['story', 'surfaces', 'algorithms', 'docs', 'e2e', 'status'];

const OPEN_RE = /^\/\/ @(algorithm|feature) (.+)$/;
const FIELD_RE = /^\/\/ @([a-z][a-z0-9-]*) (.+)$/;
const CONT_RE = /^\/\/ {2,}(\S.*)$/;

/**
 * Parse every tag block in one file's text. Returns { kind, name, fields: {field: text}, line }.
 * Line-anchored: only a line beginning exactly with `// @algorithm ` or `// @feature ` opens a block,
 * so tag-shaped text inside string literals or indented comments cannot open one.
 */
export function parseTags(text, path) {
  const lines = text.split(/\r?\n/);
  const tags = [];
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN_RE.exec(lines[i]);
    if (!open) continue;
    const tag = { kind: open[1], name: open[2].trim(), fields: {}, path, line: i + 1 };
    let current = null;
    let j = i + 1;
    for (; j < lines.length && lines[j].startsWith('//'); j++) {
      if (OPEN_RE.test(lines[j])) break; // next block opens — close this one
      const field = FIELD_RE.exec(lines[j]);
      if (field) {
        current = field[1];
        tag.fields[current] = (tag.fields[current] ? tag.fields[current] + ' ' : '') + field[2].trim();
        continue;
      }
      const cont = current && CONT_RE.exec(lines[j]);
      if (cont) tag.fields[current] += ' ' + cont[1].trim();
      else current = null; // a plain comment line ends field continuation but not the block
    }
    tags.push(tag);
    i = j - 1;
  }
  return tags;
}

/** Collect all tags across the tree: { algorithms: Tag[], features: Tag[] } — each sorted for determinism. */
export function collectTags(root = repoRoot) {
  const algorithms = [];
  const features = [];
  for (const path of sourceFiles(root)) {
    for (const tag of parseTags(readFileSync(join(root, path), 'utf8'), path)) {
      (tag.kind === 'algorithm' ? algorithms : features).push(tag);
    }
  }
  algorithms.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  features.sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return { algorithms, features };
}

/** Canonical package order (architecture order: engine → content → app); unknown groups sort last, alphabetically. */
const PACKAGE_ORDER = [
  'engine/core',
  'engine/sim',
  'engine/solve',
  'engine/solver-contract',
  'content/sda',
  'app/core',
  'app/presenter',
  'app/web',
  'app/vscode',
  'app/mcp',
  'app/bridge',
];

const packageOf = (path) => path.split('/').slice(0, 2).join('/');
const packageRank = (pkg) => {
  const i = PACKAGE_ORDER.indexOf(pkg);
  return i === -1 ? PACKAGE_ORDER.length : i;
};

/**
 * Render a comma-separated path list as inline code spans; plain values (e.g. `none`) stay as text.
 * An item may carry a trailing parenthetical annotation — `path (what it covers)` — which stays as
 * plain text after the code span (the lint strips it the same way before resolving the path).
 */
const codeList = (value) =>
  value
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((item) => {
      const m = /^([^\s(]+)(\s+\(.*\))?$/.exec(item);
      return m && m[1].includes('/') ? '`' + m[1] + '`' + (m[2] ?? '') : item;
    })
    .join(', ');

const GENERATED_BANNER = (kind) =>
  `<!-- GENERATED FILE — do not edit. Source of truth: \`${kind}\` headers in the listed modules. ` +
  'Regenerate with `pnpm catalogs`; freshness is asserted by scripts/generate-catalogs.test.ts. -->';

export function renderAlgorithms(algorithms) {
  const out = [];
  out.push('# Algorithm Catalog');
  out.push('');
  out.push(GENERATED_BANNER('@algorithm'));
  out.push('');
  out.push(
    `Every algorithmic module in the codebase, cataloged from its \`@algorithm\` header: ` +
      `the problem it solves, the approach, its complexity, citations, the invariants it maintains, ` +
      `and where it is tested. ${algorithms.length} algorithms.`,
  );
  let currentPkg = null;
  for (const tag of [...algorithms].sort(
    (a, b) => packageRank(packageOf(a.path)) - packageRank(packageOf(b.path)) || (a.path < b.path ? -1 : 1),
  )) {
    const pkg = packageOf(tag.path);
    if (pkg !== currentPkg) {
      out.push('', `## ${pkg}`);
      currentPkg = pkg;
    }
    out.push('', `### ${tag.name}`, '', '`' + tag.path + '`', '');
    out.push(`- **Problem:** ${tag.fields['problem'] ?? ''}`);
    out.push(`- **Approach:** ${tag.fields['approach'] ?? ''}`);
    out.push(`- **Complexity:** ${tag.fields['complexity'] ?? ''}`);
    out.push(`- **Citations:** ${tag.fields['citations'] ?? ''}`);
    out.push(`- **Invariants:** ${tag.fields['invariants'] ?? ''}`);
    out.push(`- **Tested:** ${codeList(tag.fields['where-tested'] ?? '')}`);
  }
  out.push('');
  return out.join('\n');
}

export function renderFeatures(features) {
  const out = [];
  out.push('# Feature Catalog');
  out.push('');
  out.push(GENERATED_BANNER('@feature'));
  out.push('');
  out.push(
    `Every shipped domain feature, cataloged from the \`@feature\` header on its seam module: ` +
      `the user story, the surfaces it ships on, the algorithms it rides on, its design docs, ` +
      `and where it is tested end-to-end. ${features.length} features.`,
  );
  for (const tag of features) {
    out.push('', `### ${tag.name}`, '', `Seam: \`${tag.path}\``, '');
    out.push(`- **Story:** ${tag.fields['story'] ?? ''}`);
    out.push(`- **Surfaces:** ${tag.fields['surfaces'] ?? ''}`);
    out.push(`- **Algorithms:** ${codeList(tag.fields['algorithms'] ?? '')}`);
    out.push(`- **Docs:** ${codeList(tag.fields['docs'] ?? '')}`);
    out.push(`- **E2E:** ${codeList(tag.fields['e2e'] ?? '')}`);
    out.push(`- **Status:** ${tag.fields['status'] ?? ''}`);
  }
  out.push('');
  return out.join('\n');
}

/** Generate both catalogs from the tree. Pure w.r.t. the tree state — no clock, no environment. */
export function generateCatalogs(root = repoRoot) {
  const { algorithms, features } = collectTags(root);
  return {
    algorithms,
    features,
    algorithmsMd: renderAlgorithms(algorithms),
    featuresMd: renderFeatures(features),
  };
}

// CLI entry: write the two catalogs. (Import-safe: tests import the functions without triggering writes.)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { algorithms, features, algorithmsMd, featuresMd } = generateCatalogs();
  writeFileSync(join(repoRoot, 'docs', 'ALGORITHMS.md'), algorithmsMd, 'utf8');
  writeFileSync(join(repoRoot, 'docs', 'FEATURES.md'), featuresMd, 'utf8');
  console.log(`docs/ALGORITHMS.md — ${algorithms.length} algorithms`);
  console.log(`docs/FEATURES.md — ${features.length} features`);
}
