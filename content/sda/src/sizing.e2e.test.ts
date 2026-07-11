import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { instantiate, commonManifests, registry, keys, type Instance, type Wire } from './index';

// Demand-driven sizing (Fargate/ECS): given the offered load (read via inflow) and per-task capacity,
// the component computes HOW MANY tasks are needed and the resulting cost — and flags overflow when the
// load exceeds the task ceiling. This is what makes "how big does my system need to be" answerable.
const wires: Wire[] = [{ from: ['client', 'out'], to: ['svc', 'in'] }];
function size(svcType: string, clientRps: number) {
  const insts: Instance[] = [
    { id: 'client', type: 'client.web', config: { throughput: clientRps } },
    { id: 'svc', type: svcType },
  ];
  const g = instantiate(commonManifests, insts, wires);
  if (!g.ok) throw new Error(JSON.stringify(g.error));
  const r = evaluate(g.value, registry);
  if (!r.ok) throw new Error(r.error.join('; '));
  return r.value;
}
const evalFargate = (clientRps: number) => size('compute.fargate', clientRps); // per-task capacity = 40/(25/1000) = 1600 req/s

describe('content pack ⇄ Fargate/ECS demand-driven sizing', () => {
  it('computes how many tasks the offered load needs (and the cost)', () => {
    const v = evalFargate(5000);
    expect(v.value(NodeId('svc'), keys.requiredUnits)).toBeCloseTo(3.125, 3); // 5000 / 1600 req/s per task
    expect(v.value(NodeId('svc'), keys.cost)).toBeCloseTo(93.75, 2); // 3.125 tasks × $30/task·month
  });

  it('flags overflow when the load exceeds the task ceiling', () => {
    const v = evalFargate(200000); // capacity = 100 tasks × 1600 = 160000 req/s
    expect(v.value(NodeId('svc'), keys.overflow)).toBeCloseTo(40000, 1); // 200000 − 160000 rejected
    expect(v.value(NodeId('svc'), keys.requiredUnits)).toBeCloseTo(125, 1); // would need 125 > 100 ceiling
  });

  it('is a reusable role across services (Cloud Run: 80 conc, $12/unit)', () => {
    const v = size('compute.cloudrun', 5000); // per-unit capacity = 80/(25/1000) = 3200 req/s
    expect(v.value(NodeId('svc'), keys.requiredUnits)).toBeCloseTo(5000 / 3200, 4); // ≈ 1.5625 instances
    expect(v.value(NodeId('svc'), keys.cost)).toBeCloseTo((5000 / 3200) * 12, 3); // ≈ $18.75
  });
});
