import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { checkTailBands, evaluate, type TailProvider } from '@sda/engine-solve';
import { simulate } from '@sda/engine-sim';
import { instantiate, manifests, registry, keys, toQueueingNetwork, type Instance, type Wire } from './index';

// Wiring the time engine back into the verdict: a percentile (tail) SLO on end-to-end latency. The
// scalar forward pass MUST answer 'unknown' for it (a mean can't judge a tail); the DES-fed tail
// checker upgrades it to a real ok/violation (doc-4 §3b, §6).
describe('content pack ⇄ tail-latency verdicts (DES → verdict)', () => {
  const wires: Wire[] = [
    { from: ['client', 'out'], to: ['gw', 'in'] },
    { from: ['gw', 'out'], to: ['compute', 'in'] },
    { from: ['compute', 'out'], to: ['db', 'in'] },
  ];
  const design = (p99TargetMs: number): Instance[] => [
    { id: 'client', type: 'client.source' },
    { id: 'gw', type: 'gateway.api' },
    { id: 'compute', type: 'compute.faas', config: { concurrency: 60 } },
    { id: 'db', type: 'db.sql', bands: [{ key: keys.latency, band: { shape: 'percentiles', targets: new Map([['p99', p99TargetMs]]) } }] },
  ];

  function build(p99TargetMs: number) {
    const r = instantiate(manifests, design(p99TargetMs), wires);
    if (!r.ok) throw new Error('graph build failed');
    return r.value;
  }

  it('the scalar forward pass returns unknown for a percentile band', () => {
    const g = build(200);
    const r = evaluate(g, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    const v = r.value.verdicts.find((x) => x.scope === NodeId('db') && x.key === keys.latency);
    expect(v?.status).toBe('unknown');
  });

  it('the DES-fed tail checker produces a real p99 verdict', () => {
    const g = build(200);
    const sim = simulate(toQueueingNetwork(g), { seed: 7, warmupCompletions: 20000, measureCompletions: 100000 });
    const tail: TailProvider = (node, key, q) =>
      node === NodeId('db') && key === keys.latency ? sim.sojournPercentile(q) * 1000 : undefined; // s → ms

    const generous = checkTailBands(build(1e9), registry, tail).find((v) => v.scope === NodeId('db'));
    expect(generous?.status).toBe('ok');
    expect(generous?.computed.value).toBeGreaterThan(0); // a real measured p99, not unknown

    const tight = checkTailBands(build(0.001), registry, tail).find((v) => v.scope === NodeId('db'));
    expect(tight?.status).toBe('violation');
    expect(tight?.remediations[0]?.action).toContain('add capacity');
  });
});
