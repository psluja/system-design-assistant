import { describe, expect, it } from 'vitest';
import type { PickerOption } from '@sda/presenter';
import { filterOptions, groupOptions } from './quick-picker';

// The quick-add picker's PURE filter/grouping logic (TASK-63). The candidate list itself + its legality are
// tested in @sda/presenter's picker.test.ts; here we cover only what the popover adds: a substring filter that
// preserves the shared list's order, and stable kind-grouping. Anything DOM-heavy is left to the browser smoke.

const OPTS: PickerOption[] = [
  { type: 'cache.redis', kind: 'cache' },
  { type: 'cache.memcached', kind: 'cache' },
  { type: 'db.postgres', kind: 'db' },
  { type: 'db.dynamodb', kind: 'db' },
  { type: 'compute.faas', kind: 'compute' },
];

describe('filterOptions', () => {
  it('an empty query returns every option, in the given order (a copy, not the same array)', () => {
    const r = filterOptions(OPTS, '');
    expect(r.map((o) => o.type)).toEqual(OPTS.map((o) => o.type));
    expect(r).not.toBe(OPTS); // never hands back the caller's array
  });

  it('substring, case-insensitive, matching the type id — order preserved', () => {
    expect(filterOptions(OPTS, 'DB').map((o) => o.type)).toEqual(['db.postgres', 'db.dynamodb']);
    expect(filterOptions(OPTS, 'redis').map((o) => o.type)).toEqual(['cache.redis']);
    expect(filterOptions(OPTS, '  cache  ').map((o) => o.type)).toEqual(['cache.redis', 'cache.memcached']);
  });

  it('no match yields an empty list (drives the honest empty-state), never a guess', () => {
    expect(filterOptions(OPTS, 'kafka')).toEqual([]);
  });
});

describe('groupOptions', () => {
  it('buckets by kind, preserving first-seen order of both kinds and members', () => {
    const g = groupOptions(OPTS);
    expect(g.map((x) => x.kind)).toEqual(['cache', 'db', 'compute']);
    expect(g[0]!.options.map((o) => o.type)).toEqual(['cache.redis', 'cache.memcached']);
    expect(g[1]!.options.map((o) => o.type)).toEqual(['db.postgres', 'db.dynamodb']);
  });

  it('every option appears exactly once across the groups (no loss, no dupe)', () => {
    const g = groupOptions(OPTS);
    const flat = g.flatMap((x) => x.options.map((o) => o.type));
    expect(flat.sort()).toEqual(OPTS.map((o) => o.type).sort());
  });

  it('empty in → empty out', () => {
    expect(groupOptions([])).toEqual([]);
  });
});
