import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { evaluate, illegalEdges } from '@sda/engine-solve';
import { commonManifests, fargateManifests, instantiate, registry, keys, type Instance, type Wire } from './index';

// The SECOND real CDK case: classic 3-tier web stack
//   client → WAF → API Gateway → ALB → ECS Fargate (1× 0.25 vCPU) → Aurora Postgres.
// The single small Fargate task (desiredCount 1) is both the throughput bottleneck and the
// availability drag — the engine must call both out.
const catalog = { ...commonManifests, ...fargateManifests };

describe('REAL case: ALB → ECS Fargate → Aurora (ArchitectureAsAServiceStack)', () => {
  const instances: Instance[] = [
    { id: 'client', type: 'client.web', config: { throughput: 1000 } },
    { id: 'waf', type: 'security.waf' },
    { id: 'apigw', type: 'apigw.rest' },
    { id: 'alb', type: 'lb.alb' },
    // The single 0.25 vCPU task = the demand-sized compute.fargate configured as a one-task fleet.
    { id: 'fargate', type: 'compute.fargate', config: { maxUnits: 1, concurrency: 20, perRequestDuration: 50, latency: 50, availability: 0.99 } },
    { id: 'aurora', type: 'db.aurora', bands: [{ key: keys.throughput, band: { shape: 'minTargetMax', min: 1000 } }] },
  ];
  const wires: Wire[] = [
    { from: ['client', 'out'], to: ['waf', 'in'] },
    { from: ['waf', 'out'], to: ['apigw', 'in'] },
    { from: ['apigw', 'out'], to: ['alb', 'in'] },
    { from: ['alb', 'out'], to: ['fargate', 'in'] },
    { from: ['fargate', 'db'], to: ['aurora', 'in'] }, // sized fleet's out port is `db`
  ];

  const built = instantiate(catalog, instances, wires);
  if (!built.ok) throw new Error('graph build failed');
  const graph = built.value;
  const aurora = NodeId('aurora');

  it('is protocol-legal (http front tier, pg to the database)', () => {
    expect(illegalEdges(graph, [])).toEqual([]);
  });

  it('the single 0.25 vCPU Fargate task caps throughput and drags availability', () => {
    const r = evaluate(graph, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    expect(r.value.converged).toBe(true);

    expect(r.value.value(aurora, keys.throughput)).toBe(400); // concurrency 20 / 50 ms
    expect(r.value.value(aurora, keys.latency)).toBe(84); // 2 + 10 + 2 + 50 + 20
    expect(r.value.value(aurora, keys.availability)).toBeCloseTo(0.9888, 3); // single 0.99 task dominates; ALB 99.99% + Aurora 99.95% (sourced SLAs)

    const v = r.value.verdicts.find((x) => x.scope === aurora && x.key === keys.throughput);
    expect(v?.status).toBe('violation'); // 400 < 1000
    expect(v?.cause.some((l) => l.scope === NodeId('fargate'))).toBe(true);
    expect(v?.remediations[0]?.action).toContain('Increase');
    expect(v?.remediations[0]?.action).toContain('fargate');
  });
});
