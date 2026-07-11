import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, allManifests, commonManifests } from '@sda/content';
import { buildTools, type AnyTool } from './tools';
import { buildSimTools } from './simulate';
import { buildReliabilityTools } from './reliability';
import { buildDocTools } from './document';
import { buildSearchTools } from './search';
import { buildSynthTools } from './synthesize';
import { buildUncertaintyTools } from './uncertainty';
import { buildAssumptionTools } from './assumptions';
import { buildFileTools, type FileSystemPort } from './file-io';
import { bindSolvers } from './composition';
import { json } from './tool-kit';

// CONSISTENCY LINT (MCP tool-surface audit) — the mechanically-checkable half of "no burdel, no niespójności":
// one naming scheme, least-input arg ordering, a concrete example in every description, and one JSON result
// envelope. These are the rules a human reviewer would otherwise have to police by eye on every new tool; pinning
// them here means the surface cannot silently drift back into inconsistency (a stray `run_`/`create_` prefix, an
// optional arg jumping ahead of a required one, a description with no example, a bespoke JSON stringify).

const noFs: FileSystemPort = { exists: () => false, read: () => '', write: () => undefined, listSdaFiles: () => [] };

/** The whole tool surface every shell (CLI index.ts / bundled VS Code mcp-server.ts) registers — audited as one set. */
function allTools(): AnyTool[] {
  const s = new Studio(registry, allManifests);
  const solvers = bindSolvers(registry);
  return [
    ...buildTools(s),
    ...buildFileTools(s, noFs, [process.cwd()]),
    ...buildSimTools(s, registry),
    ...buildReliabilityTools(s),
    ...buildDocTools(s, solvers),
    ...buildSearchTools(s, solvers),
    ...buildSynthTools(s, solvers),
    ...buildUncertaintyTools(s, solvers),
    ...buildAssumptionTools(s, registry, solvers),
  ];
}

// The APPROVED naming vocabulary — the leading token (the part before the first `_`, or the whole name) of every
// tool must be one of these. This is the "one form per verb-kind" contract made mechanical: a new tool with a novel
// prefix (`run_`, `create_`, `delete_`, `fetch_`…) fails here and forces a deliberate naming decision instead of
// quietly widening the scheme. Grouped by kind so the intent is legible.
const APPROVED_LEADING_TOKENS = new Set<string>([
  // reads
  'list', 'describe', 'get',
  // property writes / removals (paired: set_X ↔ clear_X, add_X ↔ remove_X)
  'set', 'clear', 'add', 'remove', 'rename', 'group', 'define',
  // named-overlay upsert / wipe (request class / world): declare = upsert, derive = author the trio, reset = wipe a
  // world back to derived/base (the non-preserving twin of derive — assumption-model §5.3)
  'declare', 'derive', 'reset',
  // whole-design & solution application / IO
  'apply', 'import', 'save',
  // analyses & backward search (bare-verb or verb_object). The load-stages TRANSIENT is not a tool of its own —
  // it rides `simulate`'s output (doc: load-stages §2, the net-negative ledger: the old `stress_probe` is deleted).
  'connect', 'evaluate', 'simulate', 'envelope', 'reliability', 'uncertainty',
  'repair', 'optimize', 'explain', 'compare', 'synthesize', 'auto', 'generate',
  'undo', 'redo',
]);

describe('MCP tool-surface consistency', () => {
  it('every tool name is snake_case, unique, and uses an approved leading token (one naming scheme)', () => {
    const tools = allTools();
    const names = tools.map((t) => t.name);
    // unique
    expect(new Set(names).size, `duplicate tool name(s): ${names.filter((n, i) => names.indexOf(n) !== i).join(', ')}`).toBe(names.length);
    for (const name of names) {
      expect(name, `"${name}" must be snake_case (lowercase words joined by _)`).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
      const lead = name.split('_')[0] as string;
      expect(APPROVED_LEADING_TOKENS.has(lead), `"${name}" leads with "${lead}", which is not an approved verb-kind — extend the scheme deliberately, don't drift it`).toBe(true);
    }
  });

  it('least-input ordering: every schema lists its REQUIRED args before any optional one', () => {
    for (const t of allTools()) {
      const schema = t.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      const props = Object.keys(schema.properties ?? {});
      const required = schema.required ?? [];
      // the required keys must occupy the first `required.length` positions (in any order among themselves), so an
      // agent reads the mandatory inputs first and can stop — an optional arg never sits ahead of a required one.
      const head = props.slice(0, required.length).slice().sort();
      expect(head, `${t.name}: required args ${JSON.stringify(required)} must come first in the schema, before optionals (got order ${JSON.stringify(props)})`).toEqual([...required].sort());
    }
  });

  it('every description carries a concrete example arg set (e.g. { … })', () => {
    for (const t of allTools()) {
      expect(t.description.length, `${t.name}: description is too thin`).toBeGreaterThan(40);
      expect(t.description.includes('e.g. {'), `${t.name}: description must carry one concrete example, written "e.g. { … }"`).toBe(true);
    }
  });

  it('the shared JSON envelope is the ONE structured-result form (2-space pretty JSON, via tool-kit `json`)', () => {
    // The helper every structured tool routes through — pinned so the JSON form cannot drift tool to tool.
    const r = json({ a: 1, b: [2, 3] });
    expect(r.ok).toBe(true);
    expect(r.text).toBe(JSON.stringify({ a: 1, b: [2, 3] }, null, 2));
    expect(r.text).toContain('\n  '); // indented (not a single minified line)
    // And a real structured read returns that envelope: evaluate on a built design parses as JSON.
    const s = new Studio(registry, commonManifests);
    const call = (name: string, a: Record<string, unknown> = {}) => (buildTools(s).find((t) => t.name === name) as AnyTool).run(a);
    call('add_component', { id: 'client', type: 'client.web' });
    call('add_component', { id: 'db', type: 'db.postgres' });
    call('connect', { fromNode: 'client', fromPort: 'out', toNode: 'db', toPort: 'in' });
    const ev = call('evaluate') as { ok: boolean; text: string };
    expect(ev.ok).toBe(true);
    expect(() => JSON.parse(ev.text)).not.toThrow();
  });

  it('the renamed tools are present under their canonical names (remove_node, uncertainty)', () => {
    const names = new Set(allTools().map((t) => t.name));
    expect(names.has('remove_node')).toBe(true);
    expect(names.has('uncertainty')).toBe(true);
    // the pre-audit names are gone (no aliases kept — the surface is pre-release, no compat debt)
    expect(names.has('remove')).toBe(false);
    expect(names.has('run_uncertainty')).toBe(false);
  });
});
