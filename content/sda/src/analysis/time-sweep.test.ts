import { describe, expect, it } from 'vitest';
import { evaluate } from '@sda/engine-solve';
import { NodeId, type Cycle } from '@sda/engine-core';
import {
  allManifests,
  instantiate,
  keys,
  LOAD_STAGES_DEFAULTS,
  LOAD_STAGES_PRESETS,
  peakLoadByNode,
  registry,
  timeSweep,
  type EvaluateGraph,
  type Instance,
  type Wire,
} from '../index';

// TIER-1 ANALYTIC TIME-SWEEP — the quasi-static sweep proposes the worst window and the
// cost integral over the auto-derived span. These pin: the ρ envelope tracks the shape, the worst window is the
// argmax, and a design with no shaped generator is silent (undefined — the no-filler rule).

/** The injected forward evaluator — the sync Evaluate capability, exactly as the worlds loop is wired. */
const evalDI: EvaluateGraph = (graph) => {
  const r = evaluate(graph, registry);
  return r.ok ? r.value : undefined;
};

/** A generator source (diurnal-shaped) feeding a throughput-limited store, so ρ tracks the instantaneous load. */
function diurnalDesign(): { instances: Instance[]; wires: Wire[] } {
  return {
    instances: [
      { id: 'src', type: 'compute.service', transforms: { out: { kind: 'generate', level: 400, cycles: LOAD_STAGES_PRESETS.diurnal } }, config: { concurrency: 100000 } },
      { id: 'db', type: 'db.postgres' },
    ],
    wires: [{ from: ['src', 'out'], to: ['db', 'in'] }],
  };
}

describe('timeSweep — Tier-1 quasi-static sweep over the auto-derived span', () => {
  it('sweeps the diurnal span, and its ρ envelope tracks the ×0.5…×1.8 shape', () => {
    const d = diurnalDesign();
    const g = instantiate(allManifests, d.instances, d.wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const sweep = timeSweep({ graph: g.value, evaluate: evalDI });
    expect(sweep).toBeDefined();
    if (sweep === undefined) return;

    expect(sweep.basis).toBe('analytic (quasi-static)');
    expect(sweep.spanS).toBe(86_400 * 2); // slowest period (a day) × spanRepeats (2)
    expect(sweep.windows.length).toBeGreaterThan(100); // ~192 windows at 900 s each over 2 days

    // The worst window is the argmax of the envelope — the seam Tier-2 (R2) zooms.
    const maxRho = Math.max(...sweep.rhoEnvelope);
    expect(sweep.rhoEnvelope[sweep.worstWindowIndex]).toBeCloseTo(maxRho, 9);

    // ρ ∝ the instantaneous origin multiplier (db offered = 400 × mult, capacity fixed), so the envelope's
    // peak-to-trough ratio recovers the diurnal ×1.8 / ×0.5 = 3.6 shape (within sampling tolerance).
    const positive = sweep.rhoEnvelope.filter((r) => r > 0);
    const minRho = Math.min(...positive);
    expect(maxRho / minRho).toBeGreaterThan(3.0);
    expect(maxRho / minRho).toBeLessThan(4.2);

    expect(sweep.costIntegral).toBeGreaterThan(0); // the honest bill = mean cost over the span
    expect(sweep.pctWindowsViolating).toBeGreaterThanOrEqual(0);
    expect(sweep.pctWindowsViolating).toBeLessThanOrEqual(1);
  });

  it('is SILENT (undefined) for a design with no shaped generator (the no-filler rule)', () => {
    const instances: Instance[] = [
      { id: 'src', type: 'compute.service', transforms: { out: { kind: 'generate', level: 400 } }, config: { concurrency: 100000 } },
      { id: 'db', type: 'db.postgres' },
    ];
    const wires: Wire[] = [{ from: ['src', 'out'], to: ['db', 'in'] }];
    const g = instantiate(allManifests, instances, wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    expect(timeSweep({ graph: g.value, evaluate: evalDI })).toBeUndefined();
  });
});

// SELF-ORIGIN ρ (R4 fix — the R3 flag). `nodeQueues` skips a topological SOURCE (it receives no inbound load), so
// an isolated saturating GENERATOR — a node that originates its own λ(t) and must serve it — used to read ρ≈0 in
// Tier 1 while the Tier-2 DES formed a real backlog. The sweep now folds each shaped origin's OWN generated load
// against its own capacity, so an unconnected generator reads honestly.
describe('timeSweep — self-origin ρ (an isolated saturating generator reads honestly)', () => {
  it('an UNCONNECTED generator whose own λ(t) exceeds its own capacity reads ρ ≥ 1 (not ≈0)', () => {
    // A generator on a small M/M/c (concurrency 1, 100 ms service ⇒ 10 rps capacity) with NO downstream wire. Its
    // diurnal peak is 400 × 1.8 = 720 rps ≫ 10, so it saturates itself — the flagged case.
    const instances: Instance[] = [
      { id: 'gen', type: 'compute.service', transforms: { out: { kind: 'generate', level: 400, cycles: LOAD_STAGES_PRESETS.diurnal } }, config: { concurrency: 1, perRequestDuration: 100 } },
    ];
    const g = instantiate(allManifests, instances, []);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const sweep = timeSweep({ graph: g.value, evaluate: evalDI });
    expect(sweep).toBeDefined();
    if (sweep === undefined) return;

    // The isolated origin appears in EVERY window's ρ map (nodeQueues alone would omit it), and its worst ρ is
    // hugely saturated — the honest read of a generator overrunning its own service, not the ≈0.07 underread.
    const peak = peakLoadByNode(sweep).get('gen');
    expect(peak).toBeDefined();
    expect(peak?.rho ?? 0).toBeGreaterThan(1);
    expect(sweep.pctWindowsViolating).toBeGreaterThan(0); // the self-saturation is counted as over capacity
    expect(sweep.windows.every((w) => w.rhoByNode['gen'] !== undefined)).toBe(true);
  });

  it('an origin whose capacity comfortably exceeds its own load reads a SUB-saturation ρ (never a false peak)', () => {
    // A high-concurrency origin serving its own 400×mult rps has a real but tiny self-ρ — honest, and far below 1,
    // so it never fabricates a saturation and never overtakes the throughput-limited store as the worst window.
    const instances: Instance[] = [
      { id: 'src', type: 'compute.service', transforms: { out: { kind: 'generate', level: 400, cycles: LOAD_STAGES_PRESETS.diurnal } }, config: { concurrency: 100000 } },
      { id: 'db', type: 'db.postgres' },
    ];
    const g = instantiate(allManifests, instances, [{ from: ['src', 'out'], to: ['db', 'in'] }]);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const sweep = timeSweep({ graph: g.value, evaluate: evalDI });
    expect(sweep).toBeDefined();
    if (sweep === undefined) return;
    const srcPeak = peakLoadByNode(sweep).get('src');
    expect(srcPeak?.rho ?? 0).toBeLessThan(1); // never a fabricated saturation for a well-provisioned origin
    // The metered store still owns the worst window (its ρ ≫ the origin's), so the envelope is unchanged.
    expect(peakLoadByNode(sweep).get('db')?.rho ?? 0).toBeGreaterThan(srcPeak?.rho ?? 0);
  });
});

// WINDOW RESOLUTION resolves the shortest FEATURE, not only the fastest PERIOD. The bug:
// a one-shot spike was encoded with a HUGE periodS (30 days), so the observation span was ~60 days and the window
// (period / restPointsPerCycle) was ~7.5 HOURS — a 120 s spike fell entirely between two samples and VANISHED (the
// ρ envelope read a flat baseline). The fix: the one-shot preset's period is now its own SHORT duration, and the
// window is additionally bounded to shortestFeatureStage / stagePointsFactor. These pin the owner's exact case.
describe('timeSweep — a declared spike is now VISIBLE (the window resolves the shortest feature, §16.3 A)', () => {
  const spikeStages = LOAD_STAGES_PRESETS.spike[0]!.stages;
  const shapeDurationS = spikeStages.reduce((t, st) => t + st.durationS, 0); // 160 s — the one-shot's own period
  const baselineEndS = spikeStages[0]!.durationS; // 30
  const holdS = spikeStages[2]!.durationS; // 120 — the ×3 spike hold
  const spikeEndS = baselineEndS + spikeStages[1]!.durationS + holdS; // 155

  it("reproduces the owner's EXACT case: client.source generate(500) + spike → compute.service, spike now VISIBLE", () => {
    // BEFORE the fix the sweep spanned 60 days at 7.5-hour windows and the 120 s spike fell between two samples ⇒ a
    // FLAT ρ ≡ 0.5 envelope (the reported bug: "saw NO impact"). AFTER: the span is a few multiples of the shape and
    // the window resolves the spike, so the ×3 peak drives svc from its 0.5 baseline to saturation (the client's own
    // documented 1000-rps ceiling clips 1500→1000, so svc — cap 1000 — reads ρ = 1.0 at the peak, ≫ the 0.5 baseline).
    const g = instantiate(
      allManifests,
      [
        { id: 'client', type: 'client.source', transforms: { out: { kind: 'generate', level: 500, cycles: LOAD_STAGES_PRESETS.spike } } },
        { id: 'svc', type: 'compute.service', config: { concurrency: 100, perRequestDuration: 100, latency: 100 } },
      ],
      [{ from: ['client', 'out'], to: ['svc', 'in'] }],
    );
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const sweep = timeSweep({ graph: g.value, evaluate: evalDI });
    expect(sweep).toBeDefined();
    if (sweep === undefined) return;

    // The span is now a FEW MULTIPLES of the shape (~320 s), not 30–60 days: the one-shot is a SHORT cycle.
    expect(sweep.spanS).toBe(shapeDurationS * LOAD_STAGES_DEFAULTS.spanRepeats);
    expect(sweep.spanS).toBeLessThan(1000);
    // The window resolves the spike: ≤ the 120 s hold / stagePointsFactor (≥4 samples across the feature).
    expect(sweep.windowS).toBeLessThanOrEqual(holdS / LOAD_STAGES_DEFAULTS.stagePointsFactor);

    // THE FIX: the envelope is no longer flat — the spike drives svc from its baseline to saturation.
    const maxRho = Math.max(...sweep.rhoEnvelope);
    const minRho = Math.min(...sweep.rhoEnvelope.filter((r) => r > 0));
    expect(minRho).toBeCloseTo(0.5, 3); // baseline 500 / 1000
    expect(maxRho).toBeGreaterThanOrEqual(1); // the ×3 spike saturates svc — was ρ ≡ 0.5 (flat) before
    expect(sweep.pctWindowsViolating).toBeGreaterThan(0); // the spike windows are over capacity

    // The worst window lands DURING the spike (inside [baseline start, one shape]), not a bogus mid-span baseline.
    const worst = sweep.windows[sweep.worstWindowIndex]!;
    const worstAtS = worst.tStartS + sweep.windowS / 2;
    expect(worstAtS).toBeGreaterThanOrEqual(baselineEndS);
    expect(worstAtS).toBeLessThanOrEqual(shapeDurationS);
    const peak = peakLoadByNode(sweep).get('svc');
    expect(peak?.atS ?? -1).toBeGreaterThanOrEqual(baselineEndS);
    expect(peak?.atS ?? -1).toBeLessThanOrEqual(spikeEndS);
  });

  it('recovers the full ×3 multiplier when nothing upstream clips (peak = multiplier × baseline ÷ capacity)', () => {
    // A high-concurrency compute.service ORIGIN (no 1000-rps client ceiling) generate(500) + spike, into a sink whose
    // capacity (3000 rps) exceeds the 1500 peak — so the ×3 is unclipped and the envelope reads the multiplier exactly.
    const g = instantiate(
      allManifests,
      [
        { id: 'src', type: 'compute.service', transforms: { out: { kind: 'generate', level: 500, cycles: LOAD_STAGES_PRESETS.spike } }, config: { concurrency: 100000 } },
        { id: 'sink', type: 'compute.service', config: { concurrency: 300, perRequestDuration: 100, latency: 100 } },
      ],
      [{ from: ['src', 'out'], to: ['sink', 'in'] }],
    );
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const sweep = timeSweep({ graph: g.value, evaluate: evalDI });
    expect(sweep).toBeDefined();
    if (sweep === undefined) return;
    const sinkRho = sweep.windows.map((w) => w.rhoByNode['sink'] ?? 0);
    const maxRho = Math.max(...sinkRho);
    const minRho = Math.min(...sinkRho.filter((r) => r > 0));
    expect(maxRho).toBeCloseTo((500 * 3) / 3000, 3); // 1500/3000 = 0.5 — the ×3 peak read at capacity
    expect(minRho).toBeCloseTo(500 / 3000, 3); //                       500/3000 ≈ 0.167 — the baseline
    expect(maxRho / minRho).toBeGreaterThan(2.8); // the ×3 spike, recovered cleanly from the envelope
    expect(maxRho / minRho).toBeLessThan(3.2);
  });

  it('a SHORT stage inside a LONG period is resolved too (§16.3 A general case, not only the preset)', () => {
    // A user-authored diurnal-scale cycle (period a day) with a brief ×5 burst stage — the burst must not fall
    // between two 15-min period-samples. The stage bound forces ≤ burst / stagePointsFactor windows around it.
    const burstS = 60;
    const burstInDay: Cycle[] = [{ periodS: 86_400, stages: [{ durationS: 43_000, multiplier: 1 }, { durationS: burstS, multiplier: 5 }, { durationS: 43_340, multiplier: 1 }] }];
    const g = instantiate(
      allManifests,
      [
        { id: 'client', type: 'client.source', transforms: { out: { kind: 'generate', level: 200, cycles: burstInDay } } },
        { id: 'svc', type: 'compute.service', config: { concurrency: 300, perRequestDuration: 100, latency: 100 } },
      ],
      [{ from: ['client', 'out'], to: ['svc', 'in'] }],
    );
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const sweep = timeSweep({ graph: g.value, evaluate: evalDI });
    expect(sweep).toBeDefined();
    if (sweep === undefined) return;
    // The window is fine enough to sample the 60 s burst (≥4 samples), far below the 900 s period resolution.
    expect(sweep.windowS).toBeLessThanOrEqual(burstS / LOAD_STAGES_DEFAULTS.stagePointsFactor);
    // Cap honesty: the fine resolution over a full 2-day span would exceed the budget, so the SPAN shrank (fewer
    // periods) rather than coarsening the window past the burst — a shorter span than the raw slowest×spanRepeats.
    expect(sweep.spanS).toBeLessThan(86_400 * LOAD_STAGES_DEFAULTS.spanRepeats);
    // The burst is visible: a window reaches ≈ ×5 the baseline (200×5=1000 into 3000 ⇒ ρ≈0.33 vs baseline ≈0.067).
    const maxRho = Math.max(...sweep.rhoEnvelope);
    const minRho = Math.min(...sweep.rhoEnvelope.filter((r) => r > 0));
    expect(maxRho / minRho).toBeGreaterThan(4); // the ×5 burst emerges from the envelope
  });

  it('a periodic diurnal cycle is UNCHANGED — ~15-min windows over a 2-day span (byte-identical to before)', () => {
    const d = diurnalDesign();
    const g = instantiate(allManifests, d.instances, d.wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const sweep = timeSweep({ graph: g.value, evaluate: evalDI });
    expect(sweep).toBeDefined();
    if (sweep === undefined) return;
    expect(sweep.spanS).toBe(86_400 * LOAD_STAGES_DEFAULTS.spanRepeats); // 2 days
    expect(sweep.windowS).toBe(86_400 / LOAD_STAGES_DEFAULTS.restPointsPerCycle); // 900 s = 15 min (period resolution wins)
    expect(sweep.windows.length).toBe(192);
  });
});

// PEAK-AWARE PER-NODE LOAD. peakLoadByNode projects, per node, its worst ρ over the season and
// WHEN — the read every per-node surface uses to judge the PEAK, not just the steady baseline.
describe('peakLoadByNode — the per-node worst-window ρ + instant', () => {
  it('returns each metered node its worst ρ over the span, at the diurnal peak instant', () => {
    const d = diurnalDesign();
    const g = instantiate(allManifests, d.instances, d.wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const sweep = timeSweep({ graph: g.value, evaluate: evalDI });
    expect(sweep).toBeDefined();
    if (sweep === undefined) return;

    const dbPeak = peakLoadByNode(sweep).get('db');
    expect(dbPeak).toBeDefined();
    if (dbPeak === undefined) return;
    // The db's worst ρ is the envelope maximum (it is the only metered tier), and it peaks in the evening rush
    // (the diurnal ×1.8 window spans 10 h–18 h ⇒ its mid-instant falls inside one day).
    expect(dbPeak.rho).toBeCloseTo(Math.max(...sweep.rhoEnvelope), 9);
    const todS = dbPeak.atS % 86_400;
    expect(todS).toBeGreaterThanOrEqual(10 * 3600);
    expect(todS).toBeLessThanOrEqual(18 * 3600);
  });
});

// PEAK-AWARE TASK COUNT (the '⊞ N tasks' chip). requiredUnits is node-local sizing (units/tasks to serve the load);
// its steady value is the baseline the chip showed before, but ρ went PEAK-aware, so the chip must too. peakLoadByNode
// now carries, per node, the requiredUnits at its worst window — the units the generation scaled to at its HIGHEST
// point — coherent with the peak ρ (both from the same worst window, ρ = requiredUnits ÷ maxUnits). A node with no
// shaped generator peaks at its steady value ⇒ the presenter shows no change (the sacred pin lives in worstCaseUnits).
describe('peakLoadByNode — the per-node worst-window requiredUnits (the peak task count)', () => {
  // A high-concurrency shaped ORIGIN (nothing upstream clips) generate(2000) + ×3 spike → a demand-sized fleet whose
  // per-task capacity is 40 / 25 ms = 1600 req/s (compute.fargate). Baseline units = 2000/1600 = 1.25; the ×3 hold
  // drives the offered load to 6000 ⇒ 6000/1600 = 3.75 units — well under the 100-task ceiling, so no clipping.
  const PER_TASK_RPS = 40 / (25 / 1000); // 1600 — the fargate manifest's concurrency ÷ perRequestDuration
  function shapedIntoFargate(level: number): { instances: Instance[]; wires: Wire[] } {
    return {
      instances: [
        { id: 'gen', type: 'compute.service', transforms: { out: { kind: 'generate', level, cycles: LOAD_STAGES_PRESETS.spike } }, config: { concurrency: 100000 } },
        { id: 'svc', type: 'compute.fargate' },
      ],
      wires: [{ from: ['gen', 'out'], to: ['svc', 'in'] }],
    };
  }

  it('captures the WORST-window requiredUnits — strictly above the steady baseline the chip showed before', () => {
    const level = 2000;
    const d = shapedIntoFargate(level);
    const g = instantiate(allManifests, d.instances, d.wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));

    // The steady requiredUnits (the baseline the chip read today): the ×1 baseline load 2000 ÷ 1600 = 1.25.
    const steady = evalDI(g.value)?.value(NodeId('svc'), keys.requiredUnits);
    expect(steady).toBeCloseTo(level / PER_TASK_RPS, 6); // 1.25

    const sweep = timeSweep({ graph: g.value, evaluate: evalDI });
    expect(sweep).toBeDefined();
    if (sweep === undefined) return;
    const svcPeak = peakLoadByNode(sweep).get('svc');
    expect(svcPeak).toBeDefined();
    if (svcPeak === undefined) return;

    // The peak task count is the ×3 spike load 6000 ÷ 1600 = 3.75 — STRICTLY above the 1.25 baseline, and coherent
    // with the peak ρ (ρ = requiredUnits ÷ maxUnits, maxUnits = 100 ⇒ 3.75/100 = 0.0375 = svcPeak.rho).
    expect(svcPeak.requiredUnits).toBeDefined();
    expect(svcPeak.requiredUnits!).toBeCloseTo((level * 3) / PER_TASK_RPS, 4); // 3.75
    expect(svcPeak.requiredUnits!).toBeGreaterThan(steady!); // the peak is the higher point — the chip must show it
    expect(svcPeak.rho).toBeCloseTo(svcPeak.requiredUnits! / 100, 6); // ρ and the task count read the SAME window
    // The chip rounds up: baseline ⌈1.25⌉ = 2 tasks BEFORE; peak ⌈3.75⌉ = 4 tasks AFTER — the visible change.
    expect(Math.ceil(svcPeak.requiredUnits!)).toBe(4);
    expect(Math.ceil(steady!)).toBe(2);
  });

  it('SACRED PIN: a FLAT (no-shape) fleet peaks at its steady requiredUnits — no separate peak count', () => {
    // Same fleet, a FLAT generator (no cycles): the sweep is silent, so the chip keeps reading the steady baseline.
    const flat: Instance[] = [
      { id: 'gen', type: 'compute.service', transforms: { out: { kind: 'generate', level: 2000 } }, config: { concurrency: 100000 } },
      { id: 'svc', type: 'compute.fargate' },
    ];
    const g = instantiate(allManifests, flat, [{ from: ['gen', 'out'], to: ['svc', 'in'] }]);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    expect(timeSweep({ graph: g.value, evaluate: evalDI })).toBeUndefined(); // no shaped generator ⇒ no peak read at all
  });
});
