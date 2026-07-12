import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, manifests, commonManifests } from '@sda/content';
import { buildTools, type ToolResult } from './tools';

// apply_design must NOT silently swallow a broken graph. A wire to a non-existent port is rejected
// (naming the real ports), and a valid build returns the SAME rich {feasible, system, verdicts} as evaluate.
const catalog = { ...manifests, ...commonManifests };
const mk = () => {
  const s = new Studio(registry, catalog);
  const tools = buildTools(s);
  return (name: string, a: Record<string, unknown> = {}): ToolResult => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.run(a);
  };
};

describe('apply_design — validates ports, never a silent false green', () => {
  it('a wire to a non-existent port is rejected, naming the real ports', () => {
    const call = mk();
    // compute.faas has out port "out", not "db" — naming "db" must error, not build a broken graph then return ok+empty.
    const r = call('apply_design', { instances: [{ id: 'fn', type: 'compute.faas' }, { id: 'store', type: 'db.postgres' }], wires: [['fn', 'db', 'store']] });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('no out port "db"');
    expect(r.text).toContain('out'); // lists the node's actual out ports
  });

  it('a valid design returns {feasible, violations, system, verdicts}', () => {
    const call = mk();
    const r = call('apply_design', { instances: [{ id: 'client', type: 'client.web', config: { throughput: 100 } }, { id: 'gw', type: 'gateway.api' }, { id: 'fn', type: 'compute.faas' }], wires: [['client', 'gw'], ['gw', 'fn']] });
    expect(r.ok).toBe(true);
    const out = JSON.parse(r.text) as { feasible: boolean; violations: number; system: { flows: unknown[]; totalCostUsdMonth: number }; verdicts: unknown[] };
    expect(typeof out.feasible).toBe('boolean');
    expect(out.system.flows.length).toBeGreaterThan(0); // the end-to-end roll-up rides along, same as evaluate
    expect(out.system.totalCostUsdMonth).toBeGreaterThanOrEqual(0);
    expect(out.verdicts.length).toBeGreaterThan(0);
  });

  it('is ATOMIC — a mid-apply failure leaves the existing design untouched (no half-applied canvas)', () => {
    const s = new Studio(registry, catalog);
    const tools = buildTools(s);
    const call = (name: string, a: Record<string, unknown> = {}): ToolResult => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`no tool ${name}`);
      return t.run(a);
    };
    // seed a valid design
    expect(call('apply_design', { instances: [{ id: 'client', type: 'client.web' }, { id: 'gw', type: 'gateway.api' }], wires: [['client', 'gw']] }).ok).toBe(true);
    const beforeIds = s.project().instances.map((i) => i.id).sort();
    // a REPLACE apply that fails on a bad port partway through: it must NOT have cleared + half-built the canvas.
    const r = call('apply_design', { instances: [{ id: 'fn', type: 'compute.faas' }, { id: 'store', type: 'db.postgres' }], wires: [['fn', 'db', 'store']] });
    expect(r.ok).toBe(false);
    // the ORIGINAL design survives intact — the failed apply mutated nothing (dispatchBatch commits all-or-nothing).
    expect(s.project().instances.map((i) => i.id).sort()).toEqual(beforeIds);
  });

  it('a successful apply_design is a SINGLE undo (the whole design reverts at once, not one sub-step)', () => {
    const s = new Studio(registry, catalog);
    const tools = buildTools(s);
    const call = (name: string, a: Record<string, unknown> = {}): ToolResult => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`no tool ${name}`);
      return t.run(a);
    };
    call('apply_design', { instances: [{ id: 'client', type: 'client.web' }, { id: 'gw', type: 'gateway.api' }], wires: [['client', 'gw']] });
    expect(s.project().instances.length).toBe(2);
    call('undo', {});
    expect(s.project().instances.length).toBe(0); // one undo reverts the entire batch
  });
});
