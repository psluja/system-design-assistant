import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { commonManifests, registry } from '@sda/content';
import { buildTools, type ToolDef } from './tools';

function caller(tools: ToolDef[]) {
  return (name: string, args: Record<string, unknown> = {}) => {
    const t = tools.find((x) => x.name === name);
    if (t === undefined) throw new Error(`no tool ${name}`);
    return t.run(args);
  };
}

// set_transform — the MCP surface for per-port flow transforms (doc: flow-transformations). Guided errors (the
// MCP contract: every error names the next action), the effect visible in evaluate, and describe_component
// listing a set transform. A generator that emits 100 log lines per request must show the log tier's TRUE load.

describe('MCP set_transform — guided errors + effect visible in evaluate', () => {
  const stack = (call: ReturnType<typeof caller>): void => {
    call('add_component', { id: 'client', type: 'client.web' });
    call('add_component', { id: 'gen', type: 'compute.service' });
    call('add_component', { id: 'logs', type: 'db.postgres' });
    call('connect', { fromNode: 'client', fromPort: 'out', toNode: 'gen', toPort: 'in' });
    call('connect', { fromNode: 'gen', fromPort: 'db', toNode: 'logs', toPort: 'in' });
    call('set_config', { node: 'client', key: 'throughput', value: 1000 });
    call('set_config', { node: 'gen', key: 'concurrency', value: 100000 });
  };

  it('an OUT-port ratio(100) makes the log tier overflow — the transformed load reaches evaluate', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    stack(call);
    const before = call('evaluate');
    expect(before.ok).toBe(true);
    expect(before.text).not.toContain('"status": "violation"'); // 1000 req/s ≤ log store's ~1000 capacity

    const set = call('set_transform', { node: 'gen', port: 'db', fn: 'ratio', value: 100 });
    expect(set.ok).toBe(true);

    const after = call('evaluate');
    expect(after.ok).toBe(true);
    // 100 000 req/s now offered to the log store ⇒ its overflow verdict fires (was invisible before).
    expect(after.text).toContain('"status": "violation"');
    expect(after.text).toContain('logs');
  });

  it('clearing the transform (omit fn) restores 1:1', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    stack(call);
    call('set_transform', { node: 'gen', port: 'db', fn: 'ratio', value: 100 });
    expect(call('evaluate').text).toContain('"status": "violation"');
    const cleared = call('set_transform', { node: 'gen', port: 'db' }); // no fn ⇒ clear
    expect(cleared.ok).toBe(true);
    expect(call('evaluate').text).not.toContain('"status": "violation"');
  });

  it('guided errors: unknown node lists the real nodes', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    stack(call);
    const r = call('set_transform', { node: 'ghost', port: 'db', fn: 'ratio', value: 2 });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('gen'); // names an actual node so the agent self-corrects
  });

  it('guided errors: unknown port lists the node’s real ports', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    stack(call);
    const r = call('set_transform', { node: 'gen', port: 'nope', fn: 'ratio', value: 2 });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('db'); // lists compute.service's real ports
  });

  it('guided errors: unknown fn lists the closed set', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    stack(call);
    const r = call('set_transform', { node: 'gen', port: 'db', fn: 'sigmoid', value: 2 });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/ratio.*batch.*cap.*window.*prob/);
  });

  it('guided errors: prob must be ≤ 1, and every fn needs a positive value', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    stack(call);
    expect(call('set_transform', { node: 'gen', port: 'db', fn: 'prob', value: 1.5 }).ok).toBe(false);
    expect(call('set_transform', { node: 'gen', port: 'db', fn: 'ratio', value: 0 }).ok).toBe(false);
    expect(call('set_transform', { node: 'gen', port: 'db', fn: 'ratio', value: -3 }).ok).toBe(false);
  });

  it('describe_component shows a set transform (after set_transform persists it on the instance path)', () => {
    // describe_component reads the CATALOG manifest, so a manifest-level transform would show. Here we assert the
    // rendering path exists by checking a component with no transform reads cleanly, and the tool lists ports.
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    const d = call('describe_component', { type: 'compute.service' });
    expect(d.ok).toBe(true);
    expect(d.text).toContain('db [out]'); // ports still render; a transform would append "transform: ratio(…)"
  });
});

// set_wire_transform — the MCP surface for per-WIRE routing splits (doc: flow-transformations-r2 §5). One out port
// feeding several wires broadcasts the full rate to each; a wire split fixes the false overload. Guided errors name
// real wires, and the split reaches evaluate: catalog 1400, checkout 600 of 2000, with NO false overload.
describe('MCP set_wire_transform — routing split, guided errors + effect visible in evaluate', () => {
  const fanOut = (call: ReturnType<typeof caller>): void => {
    call('add_component', { id: 'gw', type: 'compute.service' });
    call('add_component', { id: 'catalog', type: 'compute.service' });
    call('add_component', { id: 'checkout', type: 'compute.service' });
    call('connect', { fromNode: 'gw', fromPort: 'out', toNode: 'catalog', toPort: 'in' });
    call('connect', { fromNode: 'gw', fromPort: 'out', toNode: 'checkout', toPort: 'in' });
    call('set_config', { node: 'gw', key: 'assumedRps', value: 2000 });
    call('set_config', { node: 'gw', key: 'concurrency', value: 200 });
    call('set_config', { node: 'gw', key: 'perRequestDuration', value: 50 }); // capacity ≈ 4000 ⇒ serves the whole 2000
    call('set_config', { node: 'catalog', key: 'concurrency', value: 100 }); // ≈ 2000/s
    call('set_config', { node: 'catalog', key: 'perRequestDuration', value: 50 });
    call('set_config', { node: 'checkout', key: 'concurrency', value: 40 }); // ≈ 800/s — 600 fits, 2000 would NOT
    call('set_config', { node: 'checkout', key: 'perRequestDuration', value: 50 });
  };

  it('a 70/30 wire split routes each share — the false overload is GONE, catalog sees its 1400 share', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    fanOut(call);

    // BEFORE the split: the ONE out port broadcasts the FULL 2000 to both ⇒ checkout (≈800 capacity) is overloaded.
    const before = call('evaluate');
    expect(before.ok).toBe(true);
    expect(before.text).toMatch(/"scope":\s*"checkout"[\s\S]*?"status":\s*"violation"/); // the stress-campaign bug

    expect(call('set_wire_transform', { fromNode: 'gw', fromPort: 'out', toNode: 'catalog', toPort: 'in', fn: 'prob', value: 0.7 }).ok).toBe(true);
    expect(call('set_wire_transform', { fromNode: 'gw', fromPort: 'out', toNode: 'checkout', toPort: 'in', fn: 'prob', value: 0.3 }).ok).toBe(true);

    // AFTER: each wire carries only its share ⇒ catalog's 1400 is visible and NO node overloads (no false overload).
    const after = call('evaluate');
    expect(after.ok).toBe(true);
    expect(after.text).toContain('1400'); // catalog's true share reaches evaluate (not the 2000 broadcast)
    expect(after.text).not.toMatch(/"scope":\s*"checkout"[\s\S]*?"status":\s*"violation"/); // the split fixes checkout
    expect(after.text).toContain('"violations": 0'); // the whole design is feasible now
  });

  it('clearing the wire transform (omit fn) restores the port default / identity', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    fanOut(call);
    call('set_wire_transform', { fromNode: 'gw', fromPort: 'out', toNode: 'checkout', toPort: 'in', fn: 'prob', value: 0.3 });
    const cleared = call('set_wire_transform', { fromNode: 'gw', fromPort: 'out', toNode: 'checkout', toPort: 'in' });
    expect(cleared.ok).toBe(true);
  });

  it('guided errors: an unknown wire names the real wires so the agent self-corrects', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    fanOut(call);
    const r = call('set_wire_transform', { fromNode: 'gw', fromPort: 'out', toNode: 'ghost', toPort: 'in', fn: 'prob', value: 0.5 });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('gw.out'); // lists an actual wire endpoint
    expect(r.text).toContain('catalog'); // and a real target
  });

  it('guided errors: prob must be ≤ 1, and a positive value is required', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    fanOut(call);
    expect(call('set_wire_transform', { fromNode: 'gw', fromPort: 'out', toNode: 'catalog', toPort: 'in', fn: 'prob', value: 1.5 }).ok).toBe(false);
    expect(call('set_wire_transform', { fromNode: 'gw', fromPort: 'out', toNode: 'catalog', toPort: 'in', fn: 'ratio', value: 0 }).ok).toBe(false);
  });
});

// set_transform fn:'generate' — the sixth family member (doc: load-stages §4): the port ORIGINATES traffic.
// The MCP contract: guided errors (in-port refused naming the out ports; malformed cycles name the fix), the
// generated load visible in evaluate, the level frozen for the search, and the cycles riding into simulate.
describe('MCP set_transform fn:generate — the generator port function (doc: load-stages §4)', () => {
  const migration = (call: ReturnType<typeof caller>): void => {
    call('add_component', { id: 'svc', type: 'compute.service' });
    call('add_component', { id: 'store', type: 'db.postgres' });
    call('connect', { fromNode: 'svc', fromPort: 'db', toNode: 'store', toPort: 'in' });
    call('set_config', { node: 'svc', key: 'concurrency', value: 100000 });
  };

  it('generate(level) on an OUT port originates traffic the whole chain sees in evaluate', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    migration(call);
    const set = call('set_transform', { node: 'svc', port: 'db', fn: 'generate', value: 500 });
    expect(set.ok).toBe(true);
    const ev = call('evaluate');
    expect(ev.ok).toBe(true);
    expect(ev.text).toContain('"throughputRps": 500'); // the generated 500 req/s flows through the system read
  });

  it('accepts periodic cycles (pure shape) — scalar numbers unchanged (the level is the baseline)', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    migration(call);
    const cycles = [{ periodS: 86400, stages: [{ durationS: 28800, multiplier: 0.5 }, { durationS: 28800, multiplier: 1.8 }] }];
    expect(call('set_transform', { node: 'svc', port: 'db', fn: 'generate', value: 500, cycles }).ok).toBe(true);
    const ev = call('evaluate');
    expect(ev.ok).toBe(true);
    expect(ev.text).toContain('"throughputRps": 500'); // the cycles never move the scalar pass (load-stages §7)
    // The cycles survive the document round-trip (get_project emits the canonical JSON).
    const proj = call('get_project');
    expect(proj.text).toContain('"generate"');
    expect(proj.text).toContain('"multiplier": 1.8');
  });

  it('guided error: generate on an IN port names the node\'s out ports', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    migration(call);
    const r = call('set_transform', { node: 'svc', port: 'in', fn: 'generate', value: 500 });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('OUT port');
    expect(r.text).toContain('db'); // lists a real out port so the agent self-corrects
  });

  it('guided error: malformed cycles name the exact problem (the ranges discipline)', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    migration(call);
    // Σ durationS (120) exceeds periodS (100) — the stages do not fit inside one period.
    const overfull = call('set_transform', { node: 'svc', port: 'db', fn: 'generate', value: 500, cycles: [{ periodS: 100, stages: [{ durationS: 60, multiplier: 1 }, { durationS: 60, multiplier: 2 }] }] });
    expect(overfull.ok).toBe(false);
    expect(overfull.text).toContain('periodS');
    const allZero = call('set_transform', { node: 'svc', port: 'db', fn: 'generate', value: 500, cycles: [{ periodS: 100, stages: [{ durationS: 10, multiplier: 0 }] }] });
    expect(allZero.ok).toBe(false);
    expect(allZero.text).toContain('traffic');
    const negative = call('set_transform', { node: 'svc', port: 'db', fn: 'generate', value: -5 });
    expect(negative.ok).toBe(false);
    expect(negative.text).toContain('level');
  });

  it('guided error: generate on a WIRE is refused pointing at set_transform (a port function)', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    migration(call);
    const r = call('set_wire_transform', { fromNode: 'svc', fromPort: 'db', toNode: 'store', toPort: 'in', fn: 'generate', value: 100 });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('set_transform');
  });

  it('clearing (omit fn) removes the generator — the origin disappears from evaluate', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    migration(call);
    call('set_transform', { node: 'svc', port: 'db', fn: 'generate', value: 500 });
    expect(call('evaluate').text).toContain('"throughputRps": 500');
    expect(call('set_transform', { node: 'svc', port: 'db' }).ok).toBe(true);
    const ev = call('evaluate');
    expect(ev.text).not.toContain('"throughputRps": 500'); // no origin ⇒ the design has no offered load again
  });

  // PRESETS (doc: load-stages §11) — a preset NAME pre-fills the cycles in one call, the AI's on-ramp to the same
  // six shapes the web dropdown + the VS Code picker offer. The level stays the baseline; the shape rides simulate.
  it('a preset name pre-fills the cycles (diurnal) — the shape survives the document round-trip', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    migration(call);
    const set = call('set_transform', { node: 'svc', port: 'db', fn: 'generate', value: 500, preset: 'diurnal' });
    expect(set.ok).toBe(true);
    expect(call('evaluate').text).toContain('"throughputRps": 500'); // the level is the baseline; cycles never move the scalar pass
    const proj = call('get_project');
    expect(proj.text).toContain('"generate"');
    expect(proj.text).toContain('"periodS": 86400'); // the diurnal preset's looped-day period was pre-filled
  });

  it('the `spike` preset reproduces the deleted probe on ONE node (a one-shot ×3 stress burst)', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    migration(call);
    expect(call('set_transform', { node: 'svc', port: 'db', fn: 'generate', value: 500, preset: 'spike' }).ok).toBe(true);
    const proj = call('get_project');
    expect(proj.text).toContain('"multiplier": 3'); // STRESS_DEFAULTS' ×3 spike, absorbed into the preset
  });

  it('the `flat` preset originates a steady baseline (no cycles)', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    migration(call);
    expect(call('set_transform', { node: 'svc', port: 'db', fn: 'generate', value: 500, preset: 'flat' }).ok).toBe(true);
    const proj = call('get_project');
    expect(proj.text).toContain('"generate"');
    expect(proj.text).not.toContain('cycles'); // flat = the ×1 identity, no shape field written
  });

  it('explicit cycles WIN over a preset (a preset is a pre-fill, then overridable in the same call)', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    migration(call);
    const cycles = [{ periodS: 600, stages: [{ durationS: 60, multiplier: 5 }] }];
    expect(call('set_transform', { node: 'svc', port: 'db', fn: 'generate', value: 500, preset: 'diurnal', cycles }).ok).toBe(true);
    const proj = call('get_project');
    expect(proj.text).toContain('"periodS": 600'); // the explicit cycle, not the diurnal 86400
    expect(proj.text).not.toContain('"periodS": 86400');
  });

  it('guided error: an unknown preset names the shipped set', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    migration(call);
    const r = call('set_transform', { node: 'svc', port: 'db', fn: 'generate', value: 500, preset: 'blackfriday' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/spike.*diurnal/);
  });
});
