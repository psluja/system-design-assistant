import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { evaluate, illegalEdges } from '@sda/engine-solve';
import { instantiate, manifests, registry, keys, type Instance, type Wire } from './index';

// End-to-end: a real little architecture compiled from content manifests and solved by the
// domain-agnostic engine. client → API gateway → serverless compute → SQL database.
// The serverless tier is deliberately under-provisioned (concurrency 30 ⇒ 30 / 0.05s = 600 req/s),
// so it bottlenecks the 1000 req/s of demand — and the engine must SAY SO, tracing the cause to it.
describe('content pack ⇄ engine (end-to-end)', () => {
  const instances: Instance[] = [
    { id: 'client', type: 'client.source' },
    { id: 'gw', type: 'gateway.api' },
    { id: 'compute', type: 'compute.faas', config: { concurrency: 30 } },
    { id: 'db', type: 'db.sql', bands: [{ key: keys.throughput, band: { shape: 'minTargetMax', target: 1000 } }] },
  ];
  const wires: Wire[] = [
    { from: ['client', 'out'], to: ['gw', 'in'] },
    { from: ['gw', 'out'], to: ['compute', 'in'] },
    { from: ['compute', 'out'], to: ['db', 'in'] },
  ];

  const built = instantiate(manifests, instances, wires);
  if (!built.ok) throw new Error('graph build failed');
  const graph = built.value;

  it('wiring is protocol-legal (http→http, sql→sql)', () => {
    expect(illegalEdges(graph, [])).toEqual([]);
  });

  it('computes the whole chain: bottleneck throughput, summed latency, compounded availability, summed cost', () => {
    const r = evaluate(graph, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    expect(r.value.converged).toBe(true);

    const db = NodeId('db');
    expect(r.value.value(db, keys.throughput)).toBe(600); // bottlenecked by the 600 req/s compute tier
    expect(r.value.value(db, keys.latency)).toBe(63); // 0 + 5 + 50 + 8
    expect(r.value.value(db, keys.availability)).toBeCloseTo(0.9989, 3); // 0.9995·0.9995·0.9999 (gw · Lambda SLA · db)
    expect(r.value.value(db, keys.cost)).toBe(295); // 50 + 30·1.5 + 200
  });

  it('the throughput SLO miss is blamed on the compute tier, with a remediation', () => {
    const r = evaluate(graph, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    const v = r.value.verdicts.find((x) => x.scope === NodeId('db') && x.key === keys.throughput);
    expect(v?.status).toBe('warning'); // 600 < target 1000
    expect(v?.cause.some((l) => l.scope === NodeId('compute'))).toBe(true);
    expect(v?.remediations[0]?.action).toContain('Increase');
    expect(v?.remediations[0]?.action).toContain('compute');
  });
});
