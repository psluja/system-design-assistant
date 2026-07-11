import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { commonManifests, registry } from '@sda/content';
import { buildTools, type ToolResult } from './tools';
import { buildSearchTools } from './search';
import { bindSolvers } from './composition';

// REQUEST CLASSES over the MCP surface (doc: request-classes §7.1). An agent must be able to split an each-to-each
// mesh into named acyclic classes, read each back, and — crucially — be TOLD, not silently misled, that a
// multi-class backward search is not yet available (the oracle class axis has not certified the native solver).

/** A cyclic A↔B drawing: A→B and B→A. One river refuses it; two classes compute it. */
function mesh(): Studio {
  const s = new Studio(registry, commonManifests);
  for (const cmd of [
    { kind: 'addComponent', id: 'A', type: 'compute.service' },
    { kind: 'addComponent', id: 'B', type: 'compute.service' },
    { kind: 'connect', from: ['A', 'out'], to: ['B', 'in'] },
    { kind: 'connect', from: ['B', 'out'], to: ['A', 'in'] },
  ] as const) {
    const r = s.dispatch(cmd);
    if (!r.ok) throw new Error(r.error);
  }
  return s;
}

const run = (s: Studio, name: string, args: Record<string, unknown> = {}): ToolResult => {
  const t = buildTools(s).find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t.run(args);
};

describe('MCP request-class tools', () => {
  it('declares two acyclic classes over the cyclic mesh, edits membership/origins, and lists them', () => {
    const s = mesh();
    expect(run(s, 'declare_class', { id: 'order', origins: [{ node: 'A', rps: 800 }], wires: [['A', 'B']] }).ok).toBe(true);
    // build "report" incrementally to exercise the membership + origin edit tools
    expect(run(s, 'declare_class', { id: 'report', origins: [], wires: [] }).ok).toBe(true);
    expect(run(s, 'set_class_membership', { class: 'report', wire: ['B', 'A'], member: true }).ok).toBe(true);
    expect(run(s, 'set_class_origin', { class: 'report', node: 'B', rps: 500 }).ok).toBe(true);

    const listed = JSON.parse(run(s, 'list_classes').text) as Array<{ id: string; wires: string[]; origins: Array<{ node: string; rps: number }> }>;
    expect(listed.map((c) => c.id)).toEqual(['order', 'report']);
    expect(listed[1]?.wires).toEqual(['B → A']);
    expect(listed[1]?.origins).toEqual([{ node: 'B', rps: 500 }]);

    // a wire that is not drawn is refused with a guided message (membership is structural)
    expect(run(s, 'set_class_membership', { class: 'order', wire: ['A', 'Z'], member: true }).text).toContain('no wire');

    // EVALUATE the mesh PER CLASS — the honest per-class scalar picture (the single river would refuse the cycle),
    // never a lying single-river roll-up. Each class's served throughput is reported along its own wires.
    const ev = run(s, 'evaluate');
    expect(ev.ok).toBe(true);
    const out = JSON.parse(ev.text) as {
      feasible: boolean;
      classes: string[];
      perClassThroughput: Array<{ class: string; throughput: Record<string, number> }>;
      note: string;
    };
    expect(out.feasible).toBe(true);
    expect(out.classes).toEqual(['order', 'report']);
    const order = out.perClassThroughput.find((p) => p.class === 'order');
    expect(order?.throughput['B']).toBe(800); // A originates order → B serves 800 along the order wire
    const report = out.perClassThroughput.find((p) => p.class === 'report');
    expect(report?.throughput['A']).toBe(500); // B originates report → A serves 500 along the report wire
    expect(out.note).toContain('per-class');

    expect(run(s, 'remove_class', { id: 'order' }).ok).toBe(true);
    expect((JSON.parse(run(s, 'list_classes').text) as unknown[]).length).toBe(1);
  });

  it('backward search DECLINES honestly under declared classes — no silent single-river fallback', async () => {
    const s = mesh();
    run(s, 'declare_class', { id: 'order', origins: [{ node: 'A', rps: 800 }], wires: [['A', 'B']] });
    run(s, 'declare_class', { id: 'report', origins: [{ node: 'B', rps: 500 }], wires: [['B', 'A']] });
    const search = buildSearchTools(s, bindSolvers(registry));
    for (const name of ['optimize', 'repair', 'explain_infeasible']) {
      const t = search.find((x) => x.name === name);
      if (t === undefined) throw new Error(`no tool ${name}`);
      const r = await t.run({ node: 'B', key: 'cost' });
      expect(r.ok, `${name} declines`).toBe(false);
      expect(r.text, `${name} says why`).toContain('multi-class');
    }
  });
});
