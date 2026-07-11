import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, allManifests } from '@sda/content';
import { pickerOptions, addPickedComponent, mintId } from './picker';

// The quick-add picker contract: every shell's "drop a wire → pick → placed AND wired" flow goes
// through these functions, so the offers are legality-filtered identically everywhere.

const setup = (): Studio => {
  const s = new Studio(registry, allManifests);
  const r = s.dispatch({ kind: 'addComponent', id: 'svc1', type: 'compute.service', x: 100, y: 100 });
  if (!r.ok) throw new Error(r.error);
  return s;
};

describe('pickerOptions', () => {
  it('with a PORT context offers only what legally attaches (a cache port offers caches, never postgres)', () => {
    const s = setup();
    const opts = pickerOptions(s, allManifests, { node: 'svc1', port: 'cache' }).map((o) => o.type);
    expect(opts).toContain('cache.redis');
    expect(opts).toContain('cache.memcached'); // the cache port speaks BOTH resp and memcached
    expect(opts).not.toContain('db.postgres'); // a cache client cannot talk to postgres
  });

  it('without context offers the whole catalog, sorted, with kind groups', () => {
    const s = setup();
    const opts = pickerOptions(s, allManifests);
    expect(opts.length).toBe(Object.keys(allManifests).length);
    expect(opts.map((o) => o.type)).toEqual([...opts.map((o) => o.type)].sort());
    expect(opts.find((o) => o.type === 'db.postgres')?.kind).toBe('db');
  });

  it('unknown node/port yields an EMPTY list — honest, never a guess', () => {
    const s = setup();
    expect(pickerOptions(s, allManifests, { node: 'ghost', port: 'out' })).toEqual([]);
    expect(pickerOptions(s, allManifests, { node: 'svc1', port: 'no-such-port' })).toEqual([]);
  });
});

describe('addPickedComponent', () => {
  it('places AND wires from an OUT-port context (svc.db → new postgres.in), minting a fresh id', () => {
    const s = setup();
    const r = addPickedComponent(s, allManifests, 'db.postgres', { x: 420, y: 120 }, { node: 'svc1', port: 'db' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.id).toBe('db1');
    const wires = s.project().wires;
    expect(wires.some((w) => w.from[0] === 'svc1' && w.from[1] === 'db' && w.to[0] === 'db1')).toBe(true);
    expect(s.project().layout['db1']).toEqual({ x: 420, y: 120 });
  });

  it('wires the REVERSE direction from an IN-port context (new client.out → svc.in)', () => {
    const s = setup();
    const r = addPickedComponent(s, allManifests, 'client.web', { x: 0, y: 100 }, { node: 'svc1', port: 'in' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const wires = s.project().wires;
    expect(wires.some((w) => w.from[0] === r.id && w.to[0] === 'svc1' && w.to[1] === 'in')).toBe(true);
  });

  it('without context just places (the ghost-CTA / N-key path)', () => {
    const s = setup();
    const r = addPickedComponent(s, allManifests, 'queue.sqs', { x: 300, y: 300 });
    expect(r.ok && s.project().wires.length === 0).toBe(true);
  });

  it('mintId skips taken ids', () => {
    const s = setup();
    expect(mintId(s, 'compute')).toBe('compute1'); // svc1 does not collide with the kind prefix
    s.dispatch({ kind: 'addComponent', id: 'compute1', type: 'compute.faas', x: 0, y: 0 });
    expect(mintId(s, 'compute')).toBe('compute2');
  });
});
