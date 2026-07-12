import { describe, expect, it } from 'vitest';
import { buildLoadSweep, SWEEP_FACTORS } from './sweep';
import { registry } from './registry';
import { allManifests } from './all-manifests';
import type { Instance, Wire } from './manifest';

// THE LOAD SWEEP — pure-function tests. The sweep is a generation-time computation, so its
// value is that it (a) reproduces the baseline latency at factor 1.0, (b) rises with offered load (the queueing
// knee), and (c) is HONEST — an empty series when there is no traffic origin (never a fabricated workload).

const chain = (): { instances: Instance[]; wires: Wire[] } => ({
  // A client → service → postgres chain: the client's `throughput` preset is the offered load the sweep scales.
  instances: [
    { id: 'client', type: 'client.source', config: { throughput: 1000 } },
    { id: 'svc', type: 'compute.service' },
    { id: 'db', type: 'db.postgres' },
  ],
  wires: [
    { from: ['client', 'out'], to: ['svc', 'in'] },
    { from: ['svc', 'out'], to: ['db', 'in'] },
  ],
});

describe('buildLoadSweep — the §5 load→latency series', () => {
  it('returns one point per factor, sorted by offered load, with the 1.0× point at the current offered load', () => {
    const { instances, wires } = chain();
    const points = buildLoadSweep({ instances, wires, registry, catalog: allManifests });
    expect(points.length).toBe(SWEEP_FACTORS.length);
    // Sorted ascending by offered load.
    for (let i = 1; i < points.length; i++) expect(points[i]!.offeredRps).toBeGreaterThan(points[i - 1]!.offeredRps);
    // The 1.0× point reproduces the design's current offered load (1000 rps).
    expect(points.some((p) => p.offeredRps === 1000)).toBe(true);
    // The factor extremes are present (0.5 → 500, 1.5 → 1500).
    expect(points[0]!.offeredRps).toBe(500);
    expect(points.at(-1)!.offeredRps).toBe(1500);
  });

  it('latency is non-decreasing as offered load rises (the queueing knee — more load never lowers real latency)', () => {
    const { instances, wires } = chain();
    const points = buildLoadSweep({ instances, wires, registry, catalog: allManifests });
    for (let i = 1; i < points.length; i++) {
      // Real (queueing-aware) latency is monotone non-decreasing in offered load: a busier tier waits longer.
      expect(points[i]!.latencyMs).toBeGreaterThanOrEqual(points[i - 1]!.latencyMs - 1e-9);
    }
  });

  it('honours an explicit assumedRps origin (a client-less design still sweeps its declared source)', () => {
    // A DB-to-DB migration: the source declares assumedRps (no client.* node). The sweep must scale that.
    const instances: Instance[] = [
      { id: 'src', type: 'db.postgres', config: { assumedRps: 400 } },
      { id: 'dst', type: 'db.postgres' },
    ];
    const wires: Wire[] = [{ from: ['src', 'out'], to: ['dst', 'in'] }];
    const points = buildLoadSweep({ instances, wires, registry, catalog: allManifests });
    expect(points.length).toBe(SWEEP_FACTORS.length);
    expect(points.some((p) => p.offeredRps === 400)).toBe(true); // the 1.0× point
  });

  it('returns an EMPTY series when there is NO traffic origin (never a fabricated workload)', () => {
    // A wired-out DB with no assumedRps is a bare capacity source, NOT a traffic origin (a DB does not emit its
    // ceiling as load) — so there is nothing to sweep and the doc omits the chart.
    const instances: Instance[] = [
      { id: 'a', type: 'db.postgres' },
      { id: 'b', type: 'db.postgres' },
    ];
    const wires: Wire[] = [{ from: ['a', 'out'], to: ['b', 'in'] }];
    expect(buildLoadSweep({ instances, wires, registry, catalog: allManifests })).toEqual([]);
  });

  it('is a pure function — two runs of the same design are identical', () => {
    const { instances, wires } = chain();
    const a = buildLoadSweep({ instances, wires, registry, catalog: allManifests });
    const b = buildLoadSweep({ instances, wires, registry, catalog: allManifests });
    expect(a).toEqual(b);
  });
});
