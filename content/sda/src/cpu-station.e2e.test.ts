import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { NodeId, type Node } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { simulate } from '@sda/engine-sim';
import { arbDesign, CATALOG } from './arbitrary';
import { cfg, cpuStation, PURE_DELAY, queueStation } from './graph-read';
import { nodeCapacityRps, nodeQueues } from './queueing';
import { allManifests, instantiate, keys, registry, toQueueingNetwork, type Instance, type Wire } from './index';

// THE CPU-BOUND CAPACITY PRIMITIVE (calibration TASK: TechEmpower single-query, DeathStarBench nginx). A node with
// `cpuCores` + `cpuTimePerRequestMs` forms a THIRD M/M/c queueing station (c = cores, μ = 1/cpuTime ⇒ capacity =
// cores/cpuTime), read through the SAME shared `queueStation` the analytic twin (queueing.ts) and the DES (sim.ts)
// both consume — so they cannot drift. These tests pin the three properties the design must uphold:
//   1. SACRED BYTE-IDENTITY — a node with NO cpu config is EXACTLY the pre-CPU station (property-tested);
//   2. MIN-BINDING — when several resources are declared, the lowest-capacity one owns the queue (with the honest
//      tandem-simplification caveat: two in-series resources modelled as the min, not a tandem network);
//   3. ANALYTIC ⇄ DES agreement on a CPU-bound design (the differential discipline — they share `queueStation`).

const evalQueues = (g: Parameters<typeof nodeQueues>[0]) => {
  const r = evaluate(g, registry);
  if (!r.ok) throw new Error(r.error.join('; '));
  return nodeQueues(g, (id, k) => r.value.value(NodeId(id), k));
};

// ── The ORIGINAL (pre-CPU) station logic, re-implemented independently. `queueStation` MUST equal this for any node
//    with no cpu config — that is the byte-identity guarantee, so this reference is the oracle. ──
const baseStationExpected = (node: Node): { servers: number; serviceMs: number } => {
  const concurrency = cfg(node, keys.concurrency);
  const fleet = cfg(node, keys.replicas) ?? cfg(node, keys.maxUnits) ?? 1;
  const servers = concurrency !== undefined ? concurrency * fleet : PURE_DELAY;
  const serviceMs = cfg(node, keys.perRequestDuration) ?? cfg(node, keys.latency) ?? 0;
  if (servers < PURE_DELAY) return { servers, serviceMs };
  const pool = cfg(node, keys.connectionPool);
  const heldMs = cfg(node, keys.connectionHeldMs);
  if (pool === undefined || !(pool > 0) || heldMs === undefined || !(heldMs > 0)) return { servers, serviceMs };
  return { servers: Math.max(1, Math.round(pool)), serviceMs: heldMs };
};

describe('CPU station — the sacred byte-identity pin (no cpu config ⇒ pre-CPU behaviour, bit-for-bit)', () => {
  it('over ANY generated design, a node with no cpu config keeps EXACTLY the original station + capacity', () => {
    fc.assert(
      fc.property(arbDesign, (design) => {
        const g = instantiate(CATALOG, design.instances, design.wires);
        if (!g.ok) return; // an invalid random wiring is not our concern here
        for (const node of g.value.nodes.values()) {
          // the generator NEVER emits cpu config ⇒ every node is on the byte-identity path
          expect(cpuStation(node)).toBeUndefined();
          expect(queueStation(node)).toEqual(baseStationExpected(node));
        }
      }),
      { numRuns: 300 },
    );
  });
});

// A tiny helper: build client → svc and read svc's station/capacity/ρ at a probe load.
const svcAt = (svcConfig: Record<string, number>, offered: number) => {
  const instances: Instance[] = [
    { id: 'client', type: 'client.web', config: { throughput: offered } },
    { id: 'svc', type: 'compute.service', config: svcConfig },
  ];
  const wires: Wire[] = [{ from: ['client', 'out'], to: ['svc', 'in'], semantics: 'sync' }];
  const g = instantiate(allManifests, instances, wires);
  if (!g.ok) throw new Error(JSON.stringify(g.error));
  const node = g.value.nodes.get(NodeId('svc'))!;
  return { node, graph: g.value, q: evalQueues(g.value).get('svc')! };
};

describe('CPU station — the M/M/cores capacity and MIN-binding', () => {
  it('a generous-concurrency framework becomes CPU-bound: capacity = cores / cpuTime, and the CPU station owns the queue', () => {
    // concurrency 512 / 0.2 ms ⇒ ~2.56M rps (never binds); CPU 28 cores / 0.2692 ms ⇒ ~104k rps ⇒ CPU binds.
    const { node, q } = svcAt({ concurrency: 512, perRequestDuration: 0.2, latency: 0.2, cpuCores: 28, cpuTimePerRequestMs: 0.2692 }, 1000);
    expect(queueStation(node)).toEqual({ servers: 28, serviceMs: 0.2692 }); // the CPU station won (lower c·μ)
    expect(nodeCapacityRps(node)).toBeCloseTo(28_000 / 0.2692, 0); // ≈ 104,010 rps
    expect(q.servers).toBe(28); // the queue is on the CPU cores, not the 512-slot pool
    expect(q.rho).toBeCloseTo(1000 / (28_000 / 0.2692), 3);
  });

  it('MIN-binding: a LOWER concurrency ceiling wins over the CPU (the lowest capacity is the real bottleneck)', () => {
    // concurrency 4 / 10 ms ⇒ 400 rps (binds) vs CPU 28 / 1 ms ⇒ 28,000 rps ⇒ concurrency owns the queue, unchanged.
    const { node } = svcAt({ concurrency: 4, perRequestDuration: 10, latency: 10, cpuCores: 28, cpuTimePerRequestMs: 1 }, 100);
    expect(queueStation(node)).toEqual({ servers: 4, serviceMs: 10 }); // base concurrency station wins
    expect(nodeCapacityRps(node)).toBeCloseTo(400, 6);
  });

  it('absent EITHER cpu key ⇒ no CPU station (the ceiling is unmoved — the sacred pin at the unit level)', () => {
    const onlyCores = svcAt({ concurrency: 512, perRequestDuration: 0.2, latency: 0.2, cpuCores: 28 }, 1000);
    const onlyTime = svcAt({ concurrency: 512, perRequestDuration: 0.2, latency: 0.2, cpuTimePerRequestMs: 0.27 }, 1000);
    for (const s of [onlyCores, onlyTime]) {
      expect(cpuStation(s.node)).toBeUndefined();
      expect(queueStation(s.node)).toEqual({ servers: 512, serviceMs: 0.2 }); // concurrency station, untouched
    }
  });
});

describe('CPU station — a fixed-throughput front-end (no concurrency) binds on CPU below its declared throughput', () => {
  // nginx ships throughput 50,000 rps (a pure delay); a CPU station of 3 cores / 1 ms ⇒ 3,000 rps binds BELOW it.
  const nginxAt = (offered: number) => {
    const instances: Instance[] = [
      { id: 'client', type: 'client.web', config: { throughput: offered } },
      { id: 'nginx', type: 'proxy.nginx', config: { cpuCores: 3, cpuTimePerRequestMs: 1 } },
    ];
    const wires: Wire[] = [{ from: ['client', 'out'], to: ['nginx', 'in'], semantics: 'sync' }];
    const g = instantiate(allManifests, instances, wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    return { node: g.value.nodes.get(NodeId('nginx'))!, q: evalQueues(g.value).get('nginx')! };
  };

  it('capacity = min(declared throughput, CPU c·μ) and the CPU is the low-load bottleneck', () => {
    const { node, q } = nginxAt(2000);
    expect(nodeCapacityRps(node)).toBeCloseTo(3000, 6); // min(50000, 3 cores / 1 ms = 3000)
    expect(q.servers).toBe(3); // the M/M/3 CPU station drives the tail
    expect(q.rho).toBeCloseTo(2000 / 3000, 3); // ρ reflects the CPU ceiling, not the 50k throughput
    expect(q.rho).toBeGreaterThan(0.5); // it saturates at ~3000, so 2000 rps is real pressure (the paper's low-load bottleneck)
  });
});

describe('CPU station — analytic ⇄ DES agree on a CPU-bound tier (they share queueStation)', () => {
  it('the analytic sojourn matches the DES for an M/M/8 CPU station at ρ≈0.8', () => {
    // 8 cores, 10 ms CPU ⇒ capacity 800 rps; offered 640 ⇒ ρ = 0.8. proxy.nginx = a fixed-throughput node whose
    // ONLY finite station is the CPU one, so the whole end-to-end DES sojourn is this station's sojourn.
    const instances: Instance[] = [
      { id: 'client', type: 'client.web', config: { throughput: 640 } },
      { id: 'front', type: 'proxy.nginx', config: { cpuCores: 8, cpuTimePerRequestMs: 10 } },
    ];
    const wires: Wire[] = [{ from: ['client', 'out'], to: ['front', 'in'], semantics: 'sync' }];
    const g = instantiate(allManifests, instances, wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const q = evalQueues(g.value).get('front')!;
    expect(q.servers).toBe(8);
    expect(q.rho).toBeCloseTo(0.8, 2);
    const sim = simulate(toQueueingNetwork(g.value), { seed: 4242, warmupCompletions: 20000, measureCompletions: 200000 });
    expect(Math.abs(q.sojournMs - sim.meanSojourn * 1000) / (sim.meanSojourn * 1000)).toBeLessThan(0.08);
  });
});
