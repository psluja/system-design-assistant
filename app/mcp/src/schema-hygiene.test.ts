import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, allManifests } from '@sda/content';
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

/** A no-op filesystem — schema hygiene only inspects tool inputSchemas, never touches disk. */
const noFs: FileSystemPort = { exists: () => false, read: () => '', write: () => undefined, listSdaFiles: () => [] };

// STRICT MCP clients (VS Code Copilot validates every tool schema on /init) reject any JSON-Schema
// `"type": "array"` that lacks `items` — one bad tool disables the WHOLE server for the agent. This
// walker pins the rule for every tool we expose, at any nesting depth, so the regression can't return.

function assertArraysHaveItems(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => assertArraysHaveItems(v, `${path}[${i}]`));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if (o['type'] === 'array') {
    expect(o['items'], `${path}: an array schema must declare \`items\` (Copilot rejects the tool otherwise)`).toBeDefined();
  }
  for (const [k, v] of Object.entries(o)) assertArraysHaveItems(v, `${path}.${k}`);
}

/** The whole tool surface (same assembly consistency.test.ts audits) — both hygiene lints walk one identical set. */
function allTools(): AnyTool[] {
  const s = new Studio(registry, allManifests);
  return [
    ...buildTools(s),
    ...buildFileTools(s, noFs, [process.cwd()]),
    ...buildSimTools(s, registry),
    ...buildReliabilityTools(s),
    ...buildDocTools(s),
    ...buildSearchTools(s, bindSolvers(registry)),
    ...buildSynthTools(s, bindSolvers(registry)),
    ...buildUncertaintyTools(s, bindSolvers(registry)),
    ...buildAssumptionTools(s, registry, bindSolvers(registry)),
  ];
}

describe('MCP tool schema hygiene', () => {
  it('every array in every tool inputSchema declares items', () => {
    const tools = allTools();
    expect(tools.length).toBeGreaterThan(15);
    for (const t of tools) assertArraysHaveItems(t.inputSchema, t.name);
  });

  // MCP TOOL ANNOTATIONS (spec ToolAnnotations) — some clients gate on them: a tool with NO annotations must be
  // assumed destructive + open-world (the spec defaults) and may be confirmation-gated or disabled outright. So
  // EVERY tool must declare them, with the SDA invariants: openWorldHint is always false (no tool has any egress —
  // even the file tools are confined to the workspace roots), and a non-read-only tool must state destructive +
  // idempotent explicitly (never inherit the aggressive defaults). The type system enforces the shape at compile
  // time; this walker pins it at runtime so a cast or an untyped registration path can never ship a bare tool.
  it('every tool declares MCP annotations: openWorldHint false everywhere; mutating tools state destructive/idempotent', () => {
    for (const t of allTools()) {
      const a = t.annotations as Record<string, unknown> | undefined;
      expect(a, `${t.name}: MUST declare \`annotations\` (a bare tool reads as destructive+open-world to strict clients)`).toBeDefined();
      const ann = a as Record<string, unknown>;
      expect(ann.openWorldHint, `${t.name}: openWorldHint must be false — no SDA tool has any egress`).toBe(false);
      expect(typeof ann.readOnlyHint, `${t.name}: readOnlyHint must be an explicit boolean`).toBe('boolean');
      if (ann.readOnlyHint === false) {
        expect(typeof ann.destructiveHint, `${t.name}: a mutating tool must state destructiveHint explicitly`).toBe('boolean');
        expect(typeof ann.idempotentHint, `${t.name}: a mutating tool must state idempotentHint explicitly`).toBe('boolean');
      }
    }
  });

  // Spot-pins for the annotations that carry the most behavioral weight (the audit's exemplars): the pure-read
  // verdict/inspection surfaces are read-only; save_design is the idempotent NON-destructive overwrite of the
  // design file; the import tools are the one honestly destructive kind (studio.load clears the undo history).
  it('the load-bearing annotations hold: reads are read-only, save is non-destructive idempotent, imports are destructive', () => {
    const byName = new Map(allTools().map((t) => [t.name, t.annotations as Record<string, unknown>]));
    for (const name of ['list_components', 'describe_component', 'list_protocols', 'get_project', 'evaluate', 'simulate', 'envelope', 'generate_doc', 'reliability', 'uncertainty', 'compare_options', 'explain_infeasible']) {
      expect(byName.get(name)?.readOnlyHint, `${name} is a pure read`).toBe(true);
    }
    expect(byName.get('save_design'), 'save_design: idempotent non-destructive overwrite of the design file').toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    for (const name of ['import_design', 'import_project']) {
      expect(byName.get(name)?.destructiveHint, `${name} replaces the session design and clears undo history — honestly destructive`).toBe(true);
    }
    for (const name of ['undo', 'redo']) {
      expect(byName.get(name)?.idempotentHint, `${name} steps one frame per call — not idempotent`).toBe(false);
    }
  });
});
