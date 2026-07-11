import { describe, expect, it } from 'vitest';
import { NodeId, type Key } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { instantiate, manifests, registry, keys, nodeQueues, realCumulativeLatency, realAwareVerdicts, type Instance, type Wire } from './index';

// REAL-AWARE VERDICTS — the queueing coherence fix (autonomous test loop, BO-1/A#3). The engine alone judges a
// latency SLO against the IDEAL cumulative latency and only flags a drop via overflow (offered − capacity), which
// is EXACTLY 0 at the ρ=1 knife-edge — so a saturated design could read "Verified · 0 issues". realAwareVerdicts
// recomputes latency against the real M/M/c latency and raises an explicit saturation violation at ρ≥1.

const build = (inst: Instance[], w: Wire[]) => {
  const g = instantiate(manifests, inst, w);
  if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
  const ev = evaluate(g.value, registry);
  if (!ev.ok) throw new Error(ev.error.join('; '));
  const val = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
  return { g: g.value, verdicts: ev.value.verdicts, val };
};

describe('real-aware verdicts (queueing coherence)', () => {
  it('the ρ=1 knife-edge is a violation even though overflow is exactly 0 (BO-1)', () => {
    // capacity = 250 / 0.05s = 5000 rps; offered 5000 ⇒ ρ = 1.0 EXACTLY ⇒ overflow 0 but the wait is unbounded.
    const inst: Instance[] = [
      { id: 'client', type: 'client.source', config: { throughput: 5000 } },
      { id: 'svc', type: 'compute.faas', config: { concurrency: 250 } },
    ];
    const w: Wire[] = [{ from: ['client', 'out'], to: ['svc', 'in'] }];
    const { g, verdicts, val } = build(inst, w);

    // The engine alone sees no problem: overflow is exactly 0, no band is breached.
    expect(val('svc', keys.overflow) ?? 0).toBeCloseTo(0, 6);
    expect(verdicts.some((v) => v.status === 'violation')).toBe(false);
    expect(nodeQueues(g, val).get('svc')?.sojournMs).toBe(Infinity);

    // Real-aware: the ρ=1 tier surfaces as a saturation violation.
    const v = realAwareVerdicts(verdicts, g, val);
    const sat = v.find((x) => String(x.scope) === 'svc' && x.status === 'violation');
    expect(sat).toBeDefined();
    expect(sat?.computed.value).toBe(Infinity);
    expect(sat?.remediations[0]?.action).toContain('svc');
  });

  it('recomputes a latency SLO against the REAL latency — ideal passes, real fails — replacing (not duplicating) it', () => {
    // svc capacity = 50 / 0.05 = 1000 rps; offered 5000 ⇒ ρ = 5. Ideal end-to-end latency ≈ 50 ms ✓ ≤ 500; real ∞ ✗.
    const inst: Instance[] = [
      { id: 'client', type: 'client.source', config: { throughput: 5000 } },
      { id: 'svc', type: 'compute.faas', config: { concurrency: 50 }, bands: [{ key: keys.latency, band: { shape: 'minTargetMax', max: 500 } }] },
    ];
    const w: Wire[] = [{ from: ['client', 'out'], to: ['svc', 'in'] }];
    const { g, verdicts, val } = build(inst, w);

    const ideal = verdicts.find((x) => String(x.scope) === 'svc' && String(x.key) === 'latency');
    expect(ideal?.status).toBe('ok'); // the engine judged the IDEAL 50 ms ≤ 500

    const v = realAwareVerdicts(verdicts, g, val);
    const latVerdicts = v.filter((x) => String(x.scope) === 'svc' && String(x.key) === 'latency');
    expect(latVerdicts.length).toBe(1); // replaced, not duplicated
    expect(latVerdicts[0]?.status).toBe('violation'); // real ∞ > 500
    expect(latVerdicts[0]?.computed.value).toBe(Infinity);
  });

  it('leaves a healthy design (ρ<1) unchanged: finite real latency, no saturation violation', () => {
    const inst: Instance[] = [
      { id: 'client', type: 'client.source', config: { throughput: 500 } },
      { id: 'svc', type: 'compute.faas', config: { concurrency: 100 } }, // capacity 2000 ⇒ ρ = 0.25
    ];
    const w: Wire[] = [{ from: ['client', 'out'], to: ['svc', 'in'] }];
    const { g, verdicts, val } = build(inst, w);

    const v = realAwareVerdicts(verdicts, g, val);
    expect(v.some((x) => x.status === 'violation')).toBe(false);
    expect(Number.isFinite(realCumulativeLatency(g, val).get('svc') ?? Infinity)).toBe(true);
  });
});

// WORST-CASE LOAD (owner ruling: a peak is just traffic in a given environment). realAwareVerdicts is fed the
// sweep's per-node worst-window ρ (peakLoadByNode) and judges each node against the WORST load its declared
// environment produces. A node calm at the steady mean but saturated at its worst window reads the SAME saturation
// violation as a steady-saturated one — no 'peak' basis, no instant, no dual reading. This is the ONE list MCP, the
// design doc and the worlds matrix all read, so none can report steady-green while the canvas shows the tier red.
describe('real-aware verdicts — worst-case (worst-window) saturation', () => {
  const healthy: Instance[] = [
    { id: 'client', type: 'client.source', config: { throughput: 500 } },
    { id: 'svc', type: 'compute.faas', config: { concurrency: 100 } }, // capacity 2000 ⇒ steady ρ = 0.25 (calm)
  ];
  const wire: Wire[] = [{ from: ['client', 'out'], to: ['svc', 'in'] }];

  it('a node calm at the steady mean but saturated at its worst window emits an ORDINARY saturation violation (no peak vocabulary)', () => {
    const { g, verdicts, val } = build(healthy, wire);
    // Steady: nothing is over capacity, so the steady list is clean.
    expect(realAwareVerdicts(verdicts, g, val).some((x) => String(x.scope) === 'svc' && x.status === 'violation')).toBe(false);

    // Fed the sweep's worst-window ρ≥1 for svc, it now reads a saturation violation — ∞ real latency, latency-key.
    const peak = new Map([['svc', { rho: 1.5, atS: 64_800 }]]);
    const v = realAwareVerdicts(verdicts, g, val, undefined, peak);
    const sat = v.find((x) => String(x.scope) === 'svc' && x.status === 'violation');
    expect(sat).toBeDefined();
    expect(sat?.computed.value).toBe(Infinity);
    expect(String(sat?.key)).toBe(String(keys.latency));
    // No 'peak' basis field and no 'peak' vocabulary anywhere — a violation is a violation (owner ruling).
    expect('basis' in (sat as object)).toBe(false);
    expect(JSON.stringify(sat).toLowerCase()).not.toContain('peak');
    expect(JSON.stringify(sat)).not.toContain('@');
  });

  it('SACRED PIN: an undefined peak — or a worst-window ρ below 1 — is BYTE-IDENTICAL to the steady verdicts', () => {
    const knife: Instance[] = [
      { id: 'client', type: 'client.source', config: { throughput: 5000 } },
      { id: 'svc', type: 'compute.faas', config: { concurrency: 250 } }, // capacity 5000 ⇒ steady ρ = 1.0 (saturated)
    ];
    const { g, verdicts, val } = build(knife, wire);
    const steady = realAwareVerdicts(verdicts, g, val);
    // Passing an explicit undefined peak changes nothing.
    expect(realAwareVerdicts(verdicts, g, val, undefined, undefined)).toEqual(steady);
    // A worst-window ρ below 1 adds no new saturation (the node is already judged by its steady load).
    expect(realAwareVerdicts(verdicts, g, val, undefined, new Map([['svc', { rho: 0.8, atS: 100 }]]))).toEqual(steady);
    // A worst-window ρ≥1 on an ALREADY steady-saturated node does not DUPLICATE its violation (the set is idempotent).
    expect(realAwareVerdicts(verdicts, g, val, undefined, new Map([['svc', { rho: 2, atS: 100 }]]))).toEqual(steady);
  });

  it('an isolated saturating ORIGIN — absent from the steady queues — surfaces its saturation through the peak map', () => {
    const { g, verdicts, val } = build(healthy, wire);
    // `client` is a topological source (no inbound load ⇒ no steady queue), so only the sweep's self-origin ρ can
    // catch it. Fed a worst-window ρ≥1 for it, the shared list flags it — never a node the design says breaks that
    // vanishes from the truth.
    const v = realAwareVerdicts(verdicts, g, val, undefined, new Map([['client', { rho: 1.3, atS: 100 }]]));
    expect(v.some((x) => String(x.scope) === 'client' && x.status === 'violation')).toBe(true);
  });
});
