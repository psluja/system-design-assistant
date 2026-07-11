import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { instantiate, commonManifests, registry, keys, type Instance, type Wire } from './index';

// Overload modelling: a component reports the load OFFERED to it beyond its capacity (req/s
// rejected/dropped/throttled). This relies on the engine's `inflow(throughput)` primitive — the demand
// arriving from upstream, before the node clamps it to capacity. Banded ≤ 0 ⇒ a verdict when overloaded.
const wires: Wire[] = [{ from: ['client', 'out'], to: ['pg', 'in'] }];
const design = (clientRps: number): Instance[] => [
  { id: 'client', type: 'client.web', config: { throughput: clientRps } },
  { id: 'pg', type: 'db.postgres' }, // capacity = 100 / (50/1000) = 2000 req/s (connection-bound)
];
function evalDesign(clientRps: number) {
  const g = instantiate(commonManifests, design(clientRps), wires);
  if (!g.ok) throw new Error(JSON.stringify(g.error));
  const r = evaluate(g.value, registry);
  if (!r.ok) throw new Error(r.error.join('; '));
  return r.value;
}

describe('content pack ⇄ overload / overflow (inflow primitive)', () => {
  it('measures load offered beyond capacity = offered − capacity', () => {
    expect(evalDesign(5000).value(NodeId('pg'), keys.overflow)).toBeCloseTo(3000, 4); // 5000 offered − 2000 cap
  });

  it('is zero when the offered load fits capacity', () => {
    expect(evalDesign(1500).value(NodeId('pg'), keys.overflow)).toBeCloseTo(0, 6);
  });

  it('raises a verdict when a component is pushed past its ceiling', () => {
    const v = evalDesign(5000).verdicts.find((x) => x.scope === NodeId('pg') && x.key === keys.overflow);
    expect(v?.status).toBe('violation');
    expect(v?.computed.value).toBeCloseTo(3000, 4);
  });
});
