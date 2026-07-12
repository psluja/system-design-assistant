import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { commonManifests, instantiate, registry, keys, type Instance, type Wire } from '../index';

// A classic cached web stack from the well-known catalog: client → nginx → app → Postgres, with a
// Redis cache on the side. Postgres is connection-bound (max_connections 100); with ~50 ms queries
// that caps it at 100 / 0.05 s = 2000 req/s — below the 5000 demanded, so it bottlenecks the design.
describe('well-known components: classic nginx → app → Postgres (+ Redis) stack', () => {
  const instances: Instance[] = [
    { id: 'client', type: 'client.web' },
    { id: 'nginx', type: 'proxy.nginx' },
    { id: 'app', type: 'compute.service' },
    { id: 'pg', type: 'db.postgres', bands: [{ key: keys.throughput, band: { shape: 'minTargetMax', min: 5000 } }] },
    { id: 'redis', type: 'cache.redis' },
  ];
  const wires: Wire[] = [
    { from: ['client', 'out'], to: ['nginx', 'in'] },
    { from: ['nginx', 'out'], to: ['app', 'in'] },
    { from: ['app', 'db'], to: ['pg', 'in'] },
    { from: ['app', 'cache'], to: ['redis', 'in'] },
  ];

  it('finds Postgres as the connection-bound bottleneck', () => {
    const built = instantiate(commonManifests, instances, wires);
    if (!built.ok) throw new Error('graph build failed');
    const r = evaluate(built.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));

    const pg = NodeId('pg');
    expect(r.value.value(pg, keys.throughput)).toBe(2000); // 100 connections / 50 ms
    expect(r.value.value(pg, keys.latency)).toBe(71); // nginx 1 + app 20 + pg 50

    const v = r.value.verdicts.find((x) => x.scope === pg && x.key === keys.throughput);
    expect(v?.status).toBe('violation'); // 2000 < 5000
    expect(v?.cause.some((l) => l.scope === pg)).toBe(true);
    expect(v?.remediations[0]?.action).toContain('Increase');
    expect(v?.remediations[0]?.action).toContain('pg');
  });

  it('every well-known manifest is structurally valid content', () => {
    for (const type of Object.keys(commonManifests)) {
      const g = instantiate(commonManifests, [{ id: 'n', type }], []);
      expect(g.ok).toBe(true);
    }
  });
});
