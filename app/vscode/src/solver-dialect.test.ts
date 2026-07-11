import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SEARCH_MESSAGES, type SolverMessage } from '@sda/mcp/search';
import { serialize, Studio } from '@sda/core';
import { allManifests, keys, registry } from '@sda/content';
import { runSolve } from './solver-host';

// THE HUMAN DIALECT PIN (owner finding): every solver message the VS Code shell surfaces must speak UI language
// — "the System panel", "a node's Promises section", "Improve" — NEVER MCP tool syntax, which means nothing to a
// human who has no tool prompt (`set_slo {node, key, max/min}` was surfaced verbatim by Improve). The shared
// message table (app/mcp/src/messages.ts) carries ONE form per kind with an agent and a human rendering;
// solver-host builds the search tools with audience 'human'. This file pins BOTH layers: the table's human
// column is swept clean of tool syntax, and the real Improve host path (runSolve) is driven end-to-end over a
// design with no requirements — the exact case that used to leak `set_slo {`.

/** MCP tool syntax that must never reach a human surface: tool names, and the brace-argument idiom. */
const TOOL_SYNTAX = [
  /set_slo\s*\{/, // the exact leak the owner found
  /\bset_slo\b/,
  /\bapply_solution\b/,
  /\bexplain_infeasible\b/,
  /\bset_config\b/,
  /\bcall envelope\b/,
  /\bcall evaluate\b/,
  /\{node\b/, // a brace-argument shape (e.g. "{node, key, max/min}")
];

describe('the solver message table — one form per kind, two dialects (audience axis)', () => {
  it('no HUMAN rendering contains MCP tool syntax', () => {
    for (const [kind, m] of Object.entries<SolverMessage>(SEARCH_MESSAGES)) {
      for (const pattern of TOOL_SYNTAX) {
        expect(m.human, `SEARCH_MESSAGES.${kind}.human must not speak MCP tool syntax (${pattern})`).not.toMatch(pattern);
      }
    }
  });

  it('every kind states BOTH renderings, non-empty (a new message must choose its human words deliberately)', () => {
    for (const [kind, m] of Object.entries<SolverMessage>(SEARCH_MESSAGES)) {
      expect(m.agent.length, `SEARCH_MESSAGES.${kind}.agent`).toBeGreaterThan(0);
      expect(m.human.length, `SEARCH_MESSAGES.${kind}.human`).toBeGreaterThan(0);
    }
  });
});

describe('the Improve host path (runSolve) speaks the human dialect', () => {
  /** A tiny valid design with NO requirement declared — the case whose repair decline used to leak tool syntax. */
  const noSloProject = (): string => {
    const s = new Studio(registry, allManifests);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
    s.dispatch({ kind: 'addComponent', id: 'app', type: 'compute.service' });
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['app', 'in'] });
    return serialize(s.project());
  };

  it('goal "feasible" with no requirement declines in UI language (System panel / Promises), never `set_slo {`', async () => {
    const res = await runSolve({ goal: 'feasible', projectJson: noSloProject() });
    expect(res.ok).toBe(false);
    expect(res.body).toContain('System panel');
    expect(res.body).toContain('Promises');
    for (const pattern of TOOL_SYNTAX) expect(res.body, `Improve surfaced tool syntax: ${res.body}`).not.toMatch(pattern);
  });

  it('goal "cheapest" minimizes the WHOLE-DESIGN total: an off-path priced pool is resized too (dogfood F8)', async () => {
    // client(1000 rps) fans out to appA (throughput SLO) AND appB (no SLO — the off-path branch a single node's
    // cumulative cost cell cannot see). The system-total objective must propose a change on BOTH pools; before
    // F8 the off-path pool had no objective gradient at all.
    const s = new Studio(registry, allManifests);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
    s.dispatch({ kind: 'addComponent', id: 'appA', type: 'compute.service' });
    s.dispatch({ kind: 'addComponent', id: 'appB', type: 'compute.service' });
    s.dispatch({ kind: 'setConfig', node: 'client', key: 'throughput', value: 1000 });
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['appA', 'in'] });
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['appB', 'in'] });
    s.dispatch({ kind: 'setSLO', node: 'appA', key: keys.throughput, band: { shape: 'minTargetMax', min: 800 } });

    const res = await runSolve({ goal: 'cheapest', projectJson: serialize(s.project()) });
    expect(res.ok, res.body).toBe(true);
    const body = JSON.parse(res.body) as { changes: Array<{ node: string; key: string; to: number }> };
    const offPath = body.changes.find((c) => c.node === 'appB' && c.key === 'concurrency');
    expect(offPath, 'the off-path pool must be part of the cheapest sizing (system-total objective)').toBeDefined();
    // Hand-computed least feasible pool under the ρ ≤ 80% headroom: 1000 rps · 20 ms / 0.8 = 25 workers.
    expect(offPath!.to).toBeCloseTo(25, 1);
  });
});

// ═══ THE PROMISES WORD (owner ruling, vocabulary round) ══════════════════════════════════════════════════════════
//
// The band-the-design-must-hold KIND (an SLO band: numeric, tail, guarantee, lag) speaks ONE human word on every
// human-facing surface: **Promises** — matching the registry role `promise-target` and the Inspector's Promises
// section. "requirement" is banned from human surfaces for this kind; it survives only in
//   • the AGENT dialect (MCP fail() texts, SEARCH_MESSAGES.agent, instructions.ts — tool ids like set_slo are that
//     dialect's identifiers),
//   • code identifiers (requirementForKey, SLO_REQUIREMENTS, the 'requirements' SectionKey id — ids are identifiers,
//     not human words; same reason the command ID sda.setSystemRequirement is unchanged),
//   • comments, and historical docs/design/*.html.
// This sweep pins BOTH directions: the banned word is absent from the surfaces, and the three renamed labels exist.

const BANNED = /\brequirements?\b/i;

/** Repo-root-relative → absolute path (this test lives at app/vscode/src/). */
const repoPath = (rel: string): string => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

/** Strip block + line comments (JSX comments are block comments). Line comments only strip when `//` is not part
 *  of a URL-ish `://` — good enough for a deterministic lint over our own sources. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
}

/** Additionally blank MODULE SPECIFIERS (`from './slo-requirements'`) — file names are identifiers (like command
 *  ids), not human words, so a path may keep its historical name without tripping the surface sweep. */
function stripModuleSpecifiers(source: string): string {
  return source.replace(/\bfrom\s+(['"])[^'"\n]*\1/g, 'from _');
}

/** Human-shell sources (rendered labels, tooltips, QuickPick titles, toasts, JSX text): after comments go, the
 *  banned word must be gone — identifiers like `requirementForKey` never match the standalone-word regex. */
const HUMAN_SHELL_SOURCES = [
  'app/vscode/src/commands.ts',
  'app/vscode/src/slo-requirements.ts',
  'app/vscode/src/slo-tests.ts',
  'app/vscode/src/slo-tests-pure.ts',
  'app/vscode/src/document-edits.ts',
  'app/vscode/src/views/system-tree.ts',
  'app/vscode/src/views/inspector-tree.ts',
  'app/vscode/webview/App.tsx',
  'app/web/src/app.tsx',
  // The TASK-89 extractions — the human-facing sections app.tsx used to hold inline, swept the same way.
  'app/web/src/top-bar.tsx',
  'app/web/src/inspector.tsx',
  'app/web/src/system-panel.tsx',
  'app/web/src/improve-panel.tsx',
  'app/web/src/problems-panel.tsx',
  'app/web/src/flow-nodes.tsx',
  'app/presenter/src/summary.ts',
  'app/presenter/src/band-text.ts',
  'app/presenter/src/guarantee-view.ts',
  'app/presenter/src/node-detail.ts',
  'app/presenter/src/meta.ts',
];

/** The generated-deliverable renderers emit ONLY through string literals — sweep those literals (the SectionKey id
 *  literal 'requirements' is an identifier by contract and is the single allowed exact literal). */
const DOC_RENDERER_SOURCES = ['content/sda/src/design-doc.ts', 'content/sda/src/render-html.ts'];

/** Every string literal's text content, with `${…}` interpolations removed (an expression is code, not prose). */
function stringLiterals(source: string): string[] {
  let code = stripComments(source);
  for (let i = 0; i < 3; i += 1) code = code.replace(/\$\{[^{}]*\}/g, '');
  const literals = code.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];
  return literals.map((l) => l.slice(1, -1));
}

describe('the Promises word — the band kind speaks ONE human word on every human surface', () => {
  it('no SEARCH_MESSAGES human rendering says "requirement" (the agent column is the agent dialect)', () => {
    for (const [kind, m] of Object.entries<SolverMessage>(SEARCH_MESSAGES)) {
      expect(m.human, `SEARCH_MESSAGES.${kind}.human must say "promise", never "requirement"`).not.toMatch(BANNED);
    }
  });

  it('no human-shell source surfaces the banned word outside comments/identifiers', () => {
    for (const rel of HUMAN_SHELL_SOURCES) {
      const swept = stripModuleSpecifiers(stripComments(readFileSync(repoPath(rel), 'utf8')));
      const hit = BANNED.exec(swept);
      expect(hit, `${rel} surfaces "${hit?.[0] ?? ''}" — the human word for the band kind is "promise"`).toBeNull();
    }
  });

  it('no walkthrough page says "requirement" (pure human prose — no comment/identifier escape hatch)', () => {
    const dir = repoPath('app/vscode/media/walkthrough');
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
      expect(readFileSync(`${dir}/${name}`, 'utf8'), `walkthrough ${name}`).not.toMatch(BANNED);
    }
  });

  it('no generated-doc renderer literal says "requirement" (both deliverable renderers, markdown + html)', () => {
    for (const rel of DOC_RENDERER_SOURCES) {
      const offending = stringLiterals(readFileSync(repoPath(rel), 'utf8'))
        .filter((text) => text !== 'requirements') // the SectionKey id — an identifier, not a human word
        .filter((text) => BANNED.test(text));
      expect(offending, `${rel} renders: ${offending.join(' | ')}`).toEqual([]);
    }
  });

  it('every contributed command TITLE says promise; the command IDS are unchanged identifiers', () => {
    const pkg = JSON.parse(readFileSync(repoPath('app/vscode/package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string; title: string }> };
    };
    for (const c of pkg.contributes.commands) {
      expect(c.title, `${c.command} title`).not.toMatch(BANNED);
    }
    // The id stays `sda.setSystemRequirement` (an identifier — a rename would break keybindings/automation);
    // its human TITLE is the node's ONE FORM: "Add Promise" (owner ruling — no scope in the action verb). Pinned
    // exactly so neither half regresses, and its scope words never creep back into the title.
    const setSystem = pkg.contributes.commands.find((c) => c.command === 'sda.setSystemRequirement');
    expect(setSystem?.title).toBe('SDA: Add Promise');
    expect(setSystem?.title).not.toMatch(/end-to-end|whole system/i);
  });

  it('no MCP tool DESCRIPTION says "requirement" (fail() texts + instructions stay agent dialect)', () => {
    const dir = repoPath('app/mcp/src');
    const files = readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && n !== 'instructions.ts');
    for (const name of files) {
      const source = stripComments(readFileSync(`${dir}/${name}`, 'utf8'));
      for (const m of source.matchAll(/description:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)) {
        expect(m[1], `app/mcp/src/${name} tool description`).not.toMatch(BANNED);
      }
    }
  });

  // ═══ THE ONE PROMISE FORM (owner ruling, consistency round) ════════════════════════════════════════════════════
  //
  // A promise reads the SAME on a node and on the system/flow surfaces: section header **Promises**, action **Add
  // promise…**, and the SCOPE (system vs flow) shown PER-QUANTITY inside the picker + as an inline per-row tag —
  // NEVER baked into the header word or the action verb. The old scope-in-name forms ('Promises (whole system)',
  // 'Promises (end-to-end)', 'Add end-to-end promise…', 'Set End-to-End Promise') are banned as HEADER/ACTION
  // strings. The scope WORDS survive only as inline detail: a picker entry's description, a tooltip, a row tag —
  // so these assertions pin the exact label/section literals rather than blanket-banning 'whole system'/'end-to-end'
  // (which the honest scope tooltips + the per-quantity 'Cost (whole system)' label legitimately keep).
  it('pins the ONE promise FORM — header "Promises" + action "Add promise…" — on the node AND the system/flow surfaces', () => {
    const web = readFileSync(repoPath('app/web/src/system-panel.tsx'), 'utf8');
    // The web System panel keeps ONLY the whole-system promise (cost) — its header WORD is the SHARED PROMISES_TITLE
    // (one form with the node Inspector, never a literal that can drift), scope as a small inline tag. Per-node
    // promises (throughput / latency / p99 / availability) moved to the Inspector (owner ruling 2026-07-11), which
    // renders the SAME PROMISES_TITLE header — so the one-form invariant holds across BOTH surfaces.
    expect(web).toContain('>{PROMISES_TITLE} <span className="tagmode">system</span>'); // the whole-system (cost) block
    expect(web).not.toContain('>{PROMISES_TITLE} <span className="tagmode">flow</span>'); // flow promises left the System panel
    const inspector = readFileSync(repoPath('app/web/src/inspector.tsx'), 'utf8');
    expect(inspector).toContain('{PROMISES_TITLE}'); // the node Inspector's per-node Promises section uses the shared header
    expect(web).not.toContain('Promises (whole system)'); // the old scope-in-header form is gone (header, comments, tooltips)
    expect(web).not.toContain('Promises (end-to-end)');

    // The VS Code System-tree ACTION row is byte-identical to the node's Inspector action row ('Add promise…').
    const systemTree = readFileSync(repoPath('app/vscode/src/views/system-tree.ts'), 'utf8');
    expect(systemTree).toContain("'Add promise…'");
    expect(systemTree).not.toContain("'Add end-to-end promise…'");
    expect(systemTree).not.toContain("title: 'Add End-to-End Promise'"); // the Command.title mirrors the node's 'Add Promise'
    expect(readFileSync(repoPath('app/vscode/src/views/inspector-tree.ts'), 'utf8')).toContain("'Add promise…'");

    // The shared presenter renders ONE Promises section from the SHARED PROMISES_TITLE (scope PER-ROW) — the same
    // heading the node uses; the old scope-in-header section titles are gone. The constant is DEFINED here (summary.ts
    // is its acyclic home), and node-detail re-exports it — so the node's Promises group and this section can't drift.
    const summary = readFileSync(repoPath('app/presenter/src/summary.ts'), 'utf8');
    expect(summary).toContain("export const PROMISES_TITLE = 'Promises'"); // the shared constant resolves to 'Promises'
    expect(summary).toContain('title: PROMISES_TITLE'); // the ONE section composed from the shared constant (no literal drift)
    expect(summary).toContain("'Promises (SLO)'"); // the Design roll-up COUNT row (a count label, not a section header) is unchanged
    expect(summary).not.toContain("'Promises · whole system'");
    expect(summary).not.toContain("'Promises (end-to-end)'");

    // The command palette entry: the ONE-form title, no scope in the verb.
    const pkg = JSON.parse(readFileSync(repoPath('app/vscode/package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string }> } };
    expect(pkg.contributes.commands.find((c) => c.command === 'sda.setSystemRequirement')?.title).toBe('SDA: Add Promise');
  });
});
