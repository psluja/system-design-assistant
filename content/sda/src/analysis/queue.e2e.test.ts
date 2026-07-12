import { describe, expect, it } from 'vitest';
import { NodeId, type Verdict } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { instantiate, commonManifests, registry, keys, type Instance, type Wire } from '../index';

// "Act as queue": backlog = (producer write IN, via inflow, capped by ingest) − (consumer drain). The
// drain is read from the WIRED consumer on the right (via outflow) — producer-faster-than-consumer is
// detected end to end from the topology. With no consumer connected it falls back to manual drainRate.
function backlogAt(qType: string, producerRps: number, consumerType: string | null, extra: Record<string, number> = {}): Verdict | undefined {
  const insts: Instance[] = [
    { id: 'producer', type: 'client.web', config: { throughput: producerRps } },
    { id: 'q', type: qType, config: { ...extra } },
  ];
  const wires: Wire[] = [{ from: ['producer', 'out'], to: ['q', 'in'] }];
  if (consumerType !== null) {
    insts.push({ id: 'c', type: consumerType });
    wires.push({ from: ['q', 'out'], to: ['c', 'in'] });
  }
  const g = instantiate(commonManifests, insts, wires);
  if (!g.ok) throw new Error(JSON.stringify(g.error));
  const r = evaluate(g.value, registry);
  if (!r.ok) throw new Error(r.error.join('; '));
  return r.value.verdicts.find((x) => x.key === keys.backlog && x.scope === NodeId('q'));
}

describe('content pack ⇄ queue behaviour (producer vs consumer, from the topology)', () => {
  it('reads the consumer drain from the right: pile-up = producer − consumer capacity', () => {
    // Redis as a queue (ingest ~100k), producer 5000, consumer = Postgres (capacity 2000).
    const v = backlogAt('cache.redis', 5000, 'db.postgres', { queueMode: 1 });
    expect(v?.status).toBe('violation');
    expect(v?.computed.value).toBeCloseTo(3000, 4); // 5000 in − 2000 drained
  });

  it('is stable when the consumer is faster than the producer', () => {
    const v = backlogAt('cache.redis', 5000, 'proxy.nginx', { queueMode: 1 }); // nginx drains 50k ≥ 5000
    expect(v?.status).toBe('ok');
    expect(v?.computed.value).toBeCloseTo(0, 6);
  });

  it('falls back to manual drainRate when no consumer is wired', () => {
    const v = backlogAt('cache.redis', 5000, null, { queueMode: 1, drainRate: 1000 });
    expect(v?.computed.value).toBeCloseTo(4000, 4); // 5000 − 1000 (manual)
  });

  it('a store only queues when queueMode is on', () => {
    expect(backlogAt('cache.redis', 5000, 'db.postgres')?.status).toBe('ok'); // queueMode 0 ⇒ inert
  });
});
