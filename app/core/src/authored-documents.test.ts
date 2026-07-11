import { describe, expect, it } from 'vitest';
import { Studio } from './index';
import { deserialize } from './document';
import { registry, allManifests } from '@sda/content';

// Hand-written and AI-authored documents are FIRST-CLASS inputs (user finding, 2026-07-02: an agent saved a
// minimal .sda.json that the canvas refused to open, and an unknown type crashed instantiate with a THROW).
// These tests pin the two contracts: absent containers are legal (empty), and an unknown type is an honest
// build ERROR — data, never an exception, with the fix named in the message.

const MINIMAL = JSON.stringify({
  schema: 3,
  id: 'min',
  name: 'minimal hand-written doc',
  instances: [{ id: 'a', type: 'client.web' }, { id: 'db', type: 'db.oracle-nonexistent' }],
  wires: [],
});

describe('a minimal authored document (no layout/labels/descriptions/groups/components)', () => {
  it('deserializes with empty defaults instead of refusing to open', () => {
    const r = deserialize(MINIMAL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.components).toEqual([]);
    expect(r.value.layout).toEqual({});
    expect(r.value.groups).toEqual([]);
  });
});

describe('an unknown component type in a loaded document', () => {
  it('is a build ERROR carried as data — instantiate must not throw', () => {
    const s = new Studio(registry, allManifests);
    const r = deserialize(MINIMAL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    s.load(r.value);
    const g = s.graph();
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.error[0]).toEqual({ kind: 'unknown-type', id: 'db', type: 'db.oracle-nonexistent' });
  });

  it('evaluate() names the node, the type and the fix in one sentence', () => {
    const s = new Studio(registry, allManifests);
    const r = deserialize(MINIMAL);
    if (!r.ok) return;
    s.load(r.value);
    const e = s.evaluate();
    expect(e.ok).toBe(false);
    if (e.ok) return;
    expect(e.error[0]).toContain('unknown component type "db.oracle-nonexistent"');
    expect(e.error[0]).toContain('node "db"');
    expect(e.error[0]).toMatch(/list_components|components\[\]/);
  });
});
