import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, allManifests } from '@sda/content';
import { buildTools, type AnyTool, type ToolDef } from './tools';
import { buildSimTools } from './simulate';
import { buildReliabilityTools } from './reliability';
import { buildDocTools } from './document';
import { buildSearchTools } from './search';
import { buildSynthTools } from './synthesize';
import { buildUncertaintyTools } from './uncertainty';
import { buildAssumptionTools } from './assumptions';
import { buildFileTools, type FileSystemPort } from './file-io';
import { bindSolvers } from './composition';
import { SDA_INSTRUCTIONS } from './instructions';

// FLOW COVERAGE PIN (owner directive 2026-07-04, "ai nie wie co robić i jak") — the MCP instructions must document
// EVERY executable FLOW with concrete examples, because a FLOW (a start-to-finish call sequence), not a tool list,
// is what an agent lacks. This test makes that guarantee MECHANICAL so the guide cannot silently drift from the
// 55-tool surface:
//   (1) COVERAGE-BY-CONSTRUCTION — every tool the server registers appears in ≥1 documented flow.
//   (2) NO DRIFT — every tool a flow names actually exists (a renamed/removed tool can't be left dangling in a flow).
//   (3) STRUCTURE — every flow line is machine-parseable (a `calls:` chain and a `⇒` result), so the parser below
//       can keep policing (1) and (2) as flows are added.
//   (4) REAL ERROR STRINGS — the error-recovery flows quote the ACTUAL text the tools emit (sampled by calling the
//       tools), so an agent that pattern-matches the quoted error onto the doc lands on the right recovery calls.

const noFs: FileSystemPort = { exists: () => false, read: () => '', write: () => undefined, listSdaFiles: () => [] };

/** The whole tool surface every shell registers — the SAME assembly consistency.test.ts audits, so the two tests
 *  see one identical set (a tool added there is a tool this coverage pin must find in a flow). */
function allToolNames(): string[] {
  const s = new Studio(registry, allManifests);
  const solvers = bindSolvers(registry);
  const tools: AnyTool[] = [
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
  return tools.map((t) => t.name);
}

// The catalog's grammar (see instructions.ts NOTATION): a flow line is trimmed-to-start-with `▸`, carries a
// `calls:` chain of tool calls joined by `→`, and a `⇒` that ends the chain (result/sees text follows, unparsed).
// Everything that is NOT a `▸` line (the tool map's `•` bullets, group `── … ──` headers, the notation line,
// concepts) is ignored — so tool NAMES that appear in prose never count as coverage, only real flows do.
const FLOW_MARKER = '▸';
const CALL_SEP = '→';
const RESULT_MARKER = '⇒';

/** Every flow line (trimmed) in the instructions — the lines the parser treats as documented flows. */
function flowLines(): string[] {
  return SDA_INSTRUCTIONS.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(FLOW_MARKER));
}

/** The leading tool token of one `→`-separated call segment (`apply_design{…}` → `apply_design`; `evaluate` →
 *  `evaluate`), or undefined for an empty/non-tool-shaped segment. Stops at the first non-identifier char, so the
 *  args (`{…}`, `[…]`) never leak into the token. */
function leadingTool(segment: string): string | undefined {
  const m = segment.trim().match(/^([a-z][a-z0-9_]*)/);
  return m ? m[1] : undefined;
}

/** Parse ONE flow line into the ordered list of tool names its `calls:` chain invokes (empty if it has no chain). */
function toolsInFlow(line: string): string[] {
  const afterCalls = line.split('calls:')[1];
  if (afterCalls === undefined) return [];
  const chain = afterCalls.split(RESULT_MARKER)[0] as string; // stop at ⇒ — result/sees text is not part of the chain
  return chain
    .split(CALL_SEP)
    .map(leadingTool)
    .filter((t): t is string => t !== undefined && t.length > 0);
}

/** Every tool token referenced across the whole flow catalog. */
function toolsAcrossCatalog(): string[] {
  return flowLines().flatMap(toolsInFlow);
}

describe('MCP instructions — flow catalog covers the whole tool surface', () => {
  it('every flow line is parseable: a `calls:` chain and a `⇒` result (structure holds)', () => {
    const lines = flowLines();
    expect(lines.length, 'the flow catalog has no `▸` flow lines — did the section get renamed?').toBeGreaterThan(30);
    for (const line of lines) {
      expect(line.includes('calls:'), `flow line has no \`calls:\` chain: ${line}`).toBe(true);
      expect(line.includes(RESULT_MARKER), `flow line has no \`⇒\` result marker: ${line}`).toBe(true);
      expect(toolsInFlow(line).length, `flow line names no tool in its chain: ${line}`).toBeGreaterThan(0);
    }
  });

  it('NO DRIFT: every tool a flow names actually exists in the registered surface', () => {
    const known = new Set(allToolNames());
    for (const line of flowLines()) {
      for (const tool of toolsInFlow(line)) {
        expect(known.has(tool), `flow names "${tool}", which is not a registered tool — fix the flow or the surface drifted:\n  ${line}`).toBe(true);
      }
    }
  });

  it('COVERAGE-BY-CONSTRUCTION: every registered tool appears in ≥1 documented flow', () => {
    const referenced = new Set(toolsAcrossCatalog());
    const missing = allToolNames().filter((name) => !referenced.has(name));
    expect(missing, `these tools appear in NO flow — document a flow that uses each (agents need the flow, not just the tool):\n  ${missing.join(', ')}`).toEqual([]);
  });

  // THE DISABLED-TOOL FALLBACK IS CANON (the owner's live Copilot transcript: save_design was disabled in the
  // client, so the agent improvised get_project → write-the-file — now documented, with the verbatim warning).
  // Both the FILES flow line and the FILES-vs-TEXT section must carry it, so an agent in a gated client has a
  // sanctioned path instead of a guess.
  it('the save_design-unavailable fallback is documented as a FILES flow (get_project → write VERBATIM)', () => {
    const fallback = flowLines().filter((l) => l.includes('save_design is unavailable/disabled'));
    expect(fallback.length, 'the FILES catalog must carry the save_design-unavailable fallback flow').toBe(1);
    expect(toolsInFlow(fallback[0] as string), 'the fallback flow is exactly one call: get_project').toEqual(['get_project']);
    expect(fallback[0], 'the fallback must warn to write the text VERBATIM (a reformatted file risks corrupting the design)').toContain('VERBATIM');
    // the FILES-vs-TEXT section documents the same fallback with the byte-for-byte warning
    expect(SDA_INSTRUCTIONS).toContain('FALLBACK — save_design is unavailable/disabled in your client');
    expect(SDA_INSTRUCTIONS).toContain('never reformat, reindent, reorder keys or hand-edit');
  });
});

// ── The error-recovery flows quote REAL error strings ──────────────────────────────────────────────────────────
// Sample the actual guided errors by CALLING the tools, and assert (a) the tool really emits the phrase and (b) the
// instructions quote that same phrase — so the doc's "after error X do Y" is anchored to text the agent will see,
// never a paraphrase that fails to match. Pure synchronous command tools (no solver), so this stays fast + stable.
describe('MCP instructions — error-recovery flows quote the real error text', () => {
  const call = (name: string, a: Record<string, unknown> = {}): string => {
    const s = new Studio(registry, allManifests);
    const tools = buildTools(s);
    const run = (n: string, args: Record<string, unknown>) => (tools.find((t) => t.name === n) as ToolDef).run(args); // buildTools tools are synchronous
    // seed a node when the tool under test needs one to exist first
    if (a.__seed) run('add_component', { id: 'db', type: 'db.postgres' });
    const { __seed, ...args } = a;
    return String(run(name, args).text);
  };

  // Each row: a real malformed call, the phrase the tool emits, and the ASSERTION that the instructions quote it.
  const samples: ReadonlyArray<{ what: string; text: string; phrase: string }> = [
    { what: 'originless evaluate', text: call('evaluate', { __seed: true }), phrase: 'no traffic origin' },
    { what: 'unknown component type', text: call('add_component', { id: 'x', type: 'lambda' }), phrase: 'did you mean' },
    {
      what: 'apply_design is atomic',
      text: call('apply_design', { instances: [{ id: 'x', type: 'lambda' }], wires: [] }),
      phrase: 'applied NOTHING',
    },
    { what: 'set_slo typo', text: call('set_slo', { __seed: true, node: 'db', key: 'latncy', max: 300 }), phrase: 'is not an SLO-able metric' },
    // A flow/node-scoped key REFUSES scope:'system' with the reason (owner ruling: only a truly global quantity —
    // cost — is a whole-system promise; latency belongs to a node or a flow, where it is actually judged).
    { what: 'set_slo system-scope on a flow key', text: call('set_slo', { __seed: true, key: 'latency', max: 300, scope: 'system' }), phrase: 'is not a system-scoped quantity' },
  ];

  for (const { what, text, phrase } of samples) {
    it(`${what}: the tool emits "${phrase}" AND the instructions quote it`, () => {
      expect(text, `${what}: the tool no longer emits "${phrase}" — update the sample and the doc together`).toContain(phrase);
      expect(SDA_INSTRUCTIONS, `the error-recovery catalog must quote "${phrase}" so an agent maps the error to its recovery calls`).toContain(phrase);
    });
  }
});
