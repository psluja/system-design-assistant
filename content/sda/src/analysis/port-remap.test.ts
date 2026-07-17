import { describe, expect, it } from 'vitest';
import { allManifests, keys, portNeedsOf, remapPorts, protocolCompat, specForNode, type Instance, type Manifest, type Wire } from '../index';

// port-remap — swappable components by DIRECTION + protocol, not by port NAME. Same-family
// members name their ports inconsistently (a function's egress is `out`; a service's are `db`/`cache`), so compare_options
// / synthesize must MATCH + REMAP a candidate's ports to the node's wiring rather than demand identical names. These
// lock: (a) a MULTI-OUTPUT node now offers same-family alternatives exact-name matching missed, over the REAL catalog;
// (b) a protocol-INCOMPATIBLE candidate stays excluded (no over-offer); (c) the assignment is deterministic; (d)
// name-identical matching is the trivial special case.
const catalog = allManifests;

// A generic stateless service (compute.service) talking to a SQL db AND a Redis cache over its SEPARATE `db`/`cache`
// out ports — the canonical multi-output node. Exact-name matching only offers members that ALSO own a `cache` port
// (just compute.service itself); the remap offers the whole compute family.
const multiOutput = (): { instances: Instance[]; wires: Wire[] } => ({
  instances: [
    { id: 'client', type: 'client.web' },
    { id: 'svc', type: 'compute.service' },
    { id: 'pg', type: 'db.postgres' },
    { id: 'redis', type: 'cache.redis' },
  ],
  wires: [
    { from: ['client', 'out'], to: ['svc', 'in'] },
    { from: ['svc', 'db'], to: ['pg', 'in'] },
    { from: ['svc', 'cache'], to: ['redis', 'in'] },
  ],
});

describe('specForNode — direction+protocol remap on a multi-output node (real catalog)', () => {
  it('offers same-family alternatives that exact-name matching missed, each with its per-candidate port remap', () => {
    const { instances, wires } = multiOutput();
    const spec = specForNode(catalog, instances, wires, 'svc', { node: 'svc', key: keys.cost, direction: 'min' });
    expect(spec.ok).toBe(true);
    if (!spec.ok) return;
    const slot = spec.value.slots[0] as { types: readonly string[]; portMap: Record<string, Record<string, string>> };

    // compute.fargate / compute.asg have a `db` out port but NO `cache` port, so exact-name matching (which reused the
    // wire's port names) excluded them. The remap wires their cache dependency onto the generic `out` port — an
    // INJECTIVE assignment (in→in, db→db, cache→out) — so they are real alternatives now.
    expect(slot.types).toContain('compute.fargate');
    expect(slot.types).toContain('compute.asg');
    expect(slot.portMap['compute.fargate']).toEqual({ in: 'in', db: 'db', cache: 'out' });

    // compute.faas / compute.vm own only `in` + a single generic `out`; the port model allows several wires on one
    // out port, so BOTH the db and cache dependencies ride `out` (the multi-wire fallback) — still legal.
    expect(slot.types).toContain('compute.faas');
    expect(slot.portMap['compute.faas']).toEqual({ in: 'in', db: 'out', cache: 'out' });

    // name-identical matching is the trivial special case: the same-family member with the same port names maps to itself.
    expect(slot.types).toContain('compute.service');
    expect(slot.portMap['compute.service']).toEqual({ in: 'in', db: 'db', cache: 'cache' });

    // every alternative is like-for-like (compute.*), never a proxy or a db.
    expect(slot.types.every((t) => t.startsWith('compute.'))).toBe(true);
  });

  it('is deterministic — same inputs produce the identical spec (types + per-candidate remap), twice', () => {
    const { instances, wires } = multiOutput();
    const obj = { node: 'svc', key: keys.cost, direction: 'min' as const };
    const a = specForNode(catalog, instances, wires, 'svc', obj);
    const b = specForNode(catalog, instances, wires, 'svc', obj);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.slots).toEqual(b.value.slots);
  });

  it('does NOT over-offer: a candidate protocol-incompatible with a peer stays excluded', () => {
    // A postgresql-ONLY producer (gateway.graphql's `db` out speaks just postgresql) feeding a relational db. The
    // remap must refuse a candidate whose in-port cannot accept postgresql — offering it would make the tool lie.
    const instances: Instance[] = [
      { id: 'gql', type: 'gateway.graphql' },
      { id: 'store', type: 'db.postgres' },
    ];
    const wires: Wire[] = [{ from: ['gql', 'db'], to: ['store', 'in'] }];
    const spec = specForNode(catalog, instances, wires, 'store', { node: 'store', key: keys.cost, direction: 'min' });
    expect(spec.ok).toBe(true);
    if (!spec.ok) return;
    const types = (spec.value.slots[0] as { types: readonly string[] }).types;

    expect(types).toContain('db.postgres'); // accepts postgresql (identity)
    expect(types).toContain('db.sql'); // accepts the SQL family incl. postgresql
    expect(types).not.toContain('db.mysql'); // accepts mysql only — cannot serve a postgresql producer
    expect(types).not.toContain('db.mongodb'); // accepts mongodb only
    expect(types).not.toContain('db.cassandra'); // accepts cql only
  });
});

describe('remapPorts — the shared assignment (real manifests)', () => {
  it('remaps a multi-output node onto a candidate whose ports differ, INJECTIVELY where possible', () => {
    const { instances, wires } = multiOutput();
    const needs = portNeedsOf(catalog, instances, wires, 'svc');
    // in→in, db→db, cache→out — three DISTINCT candidate ports (injective).
    expect(remapPorts(catalog['compute.fargate'] as Manifest, needs, protocolCompat)).toEqual({ in: 'in', db: 'db', cache: 'out' });
    // a Lambda's single generic out carries both dependencies (multi-wire).
    expect(remapPorts(catalog['compute.faas'] as Manifest, needs, protocolCompat)).toEqual({ in: 'in', db: 'out', cache: 'out' });
    // a db manifest cannot host a compute node's wiring (its in accepts sql, not http; it has no generic out) → null.
    expect(remapPorts(catalog['db.mysql'] as Manifest, needs, protocolCompat)).toBeNull();
  });

  it('refuses an OUT wire the candidate has no compatible port for (does not fit)', () => {
    // A postgres used as a QUEUE drains through its OUT port to an RDS proxy that accepts postgresql. Swapping it to
    // db.mysql (which has NO out port at all) cannot carry the drain wire — remapPorts returns null, so it is refused.
    const instances: Instance[] = [
      { id: 'pg', type: 'db.postgres' },
      { id: 'proxy', type: 'proxy.rds' },
    ];
    const wires: Wire[] = [{ from: ['pg', 'out'], to: ['proxy', 'in'] }];
    const needs = portNeedsOf(catalog, instances, wires, 'pg');
    expect(remapPorts(catalog['db.mysql'] as Manifest, needs, protocolCompat)).toBeNull(); // no out port
    expect(remapPorts(catalog['db.postgres'] as Manifest, needs, protocolCompat)).toEqual({ out: 'out' }); // hosts it (identity)
  });
});
