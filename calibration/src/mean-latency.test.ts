// THE `meanLatencyMsAtLoad` PLUMBING FIXTURE (Phase A). This proves the new metric kind's whole path —
// parse (an in-memory corpus entry) → predict (evaluate → nodeQueues → responseLatency at a stated load) → error
// (the fit/score objective) → report (the rendered residual table) — WITHOUT any fake "measured reality". The
// ground truth is derived from a design the engine solves EXACTLY: a client → single M/M/1 compute tier, whose mean
// request→response latency at a sub-saturation load is the textbook M/M/1 sojourn W = (1/μ)/(1−ρ), computed here
// INDEPENDENTLY of the engine (never read back from it). If the predictor reproduces that closed form and the fitter
// drives a deliberately-wrong default to it, the plumbing is sound.
//
// ISOLATION (asserted below): this fixture is built in-memory and is NOT a file under calibration/corpus/. It must
// NEVER enter the real corpus, the scored-points count, or docs/FIDELITY.md — the real corpus stays at its ten
// scored points and this fixture's provenance string appears in neither the corpus nor the generated report.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Instance, Wire } from '@sda/content';
import { loadCorpus, type CalibrationEntry, type LoadedEntry, type LoadedModel } from './corpus';
import { predictMetric } from './predict';
import { fit, objective } from './fit';
import { buildReport, renderReport } from './report';
import { fidelityPath } from './fidelity';

// ── the closed form the fixture is derived from (M/M/1, c = 1), computed WITHOUT the engine ────────────────────
const LAMBDA_RPS = 50; //     the stated offered load the latency is "measured" at (sub-saturation)
const TRUE_D_MS = 10; //      the service time that produces the "measured" mean (μ = 100/s ⇒ ρ = 0.5)
const DEFAULT_D_MS = 5; //    a deliberately-WRONG catalog default the fitter must correct to score the metric
/** M/M/1 mean sojourn W (ms) at load λ for a service time d (ms): W = (1/μ)/(1−ρ) = d / (1 − λ·d/1000). */
const wMs = (d: number): number => d / (1 - (LAMBDA_RPS * d) / 1000);
const MEASURED_MS = wMs(TRUE_D_MS); // 20 ms — the ground truth, an independent closed form (NOT read from the engine)

// A plumbing-fixture provenance string that must NEVER leak into the real corpus or the generated report.
const FIXTURE_PROVENANCE = 'PLUMBING FIXTURE — engine self-consistency, NOT a measured system';
const FIXTURE_NAME = 'PLUMBING FIXTURE — M/M/1 mean-latency-at-load';

/** The in-memory design: a client source driving one single-server (M/M/1) compute tier — nothing else binds. */
const fixtureModel: LoadedModel = {
  instances: [
    { id: 'client', type: 'client.web', config: { throughput: LAMBDA_RPS } },
    { id: 'svc', type: 'compute.service', config: { concurrency: 1 } }, // perRequestDuration comes from the tunable
  ] as Instance[],
  wires: [{ from: ['client', 'out'], to: ['svc', 'in'], semantics: 'sync' }] as Wire[],
};

/** The in-memory corpus entry: sweeps the client, fits the svc service time, scores the mean latency at LAMBDA_RPS. */
const fixtureEntry: CalibrationEntry = {
  name: FIXTURE_NAME,
  modelPath: '(in-memory — never read from disk)',
  notes: FIXTURE_PROVENANCE,
  sources: [{ url: FIXTURE_PROVENANCE, note: 'M/M/1 W = (1/μ)/(1−ρ); no external source, no measured reality' }],
  workloadSweep: { node: 'client', key: 'throughput', points: [LAMBDA_RPS] },
  tunables: [
    {
      key: 'perRequestDuration',
      selector: { node: 'svc' },
      unit: 'ms',
      catalogDefault: DEFAULT_D_MS,
      fit: { min: 1, max: 100 },
      note: 'the M/M/1 service time; the fitter must move it from the wrong default to the closed-form value',
    },
  ],
  groundTruth: [
    {
      metric: 'meanLatencyMsAtLoad',
      measured: MEASURED_MS,
      unit: 'ms',
      probeLoadRps: LAMBDA_RPS,
      latencyNode: 'svc',
      sourceUrl: FIXTURE_PROVENANCE,
      note: 'the analytic M/M/1 mean sojourn at the stated load — plumbing ground truth, not a benchmark',
    },
  ],
};
const fixtureLoaded: LoadedEntry = { entry: fixtureEntry, model: fixtureModel };

describe('meanLatencyMsAtLoad — the metric-kind plumbing (Phase A, synthetic fixture)', () => {
  it('predicts the engine analytic mean = the independent M/M/1 closed form at the DEFAULT service time', () => {
    const gt = fixtureEntry.groundTruth[0]!;
    const predicted = predictMetric(fixtureEntry, fixtureModel, gt, 'default', new Map());
    // At the (wrong) default d = 5 ms the engine's responseLatency must equal the independent closed form W(5).
    expect(predicted).toBeCloseTo(wMs(DEFAULT_D_MS), 6); // ≈ 6.667 ms
    expect(predicted).not.toBeCloseTo(MEASURED_MS, 3); // the default is deliberately far from the measured 20 ms
  });

  it('the fitter drives the wrong default to the closed-form service time and the residual collapses to ~0', () => {
    const result = fit([fixtureLoaded]);
    const fitted = result.values.get('svc:perRequestDuration');
    expect(fitted, 'the fitted service time must recover the closed-form value').toBeCloseTo(TRUE_D_MS, 1);
    // The scored point is exact under the model, so the post-fit objective (RMS relative error) is ~0.
    expect(result.objective).toBeLessThan(1e-3);
    const predictedFitted = predictMetric(fixtureEntry, fixtureModel, fixtureEntry.groundTruth[0]!, 'fitted', result.values);
    expect(predictedFitted).toBeCloseTo(MEASURED_MS, 2); // ≈ 20 ms
    // and the raw objective helper agrees the fitted values score the point exactly.
    expect(objective([fixtureLoaded], result.values)).toBeLessThan(1e-3);
  });

  it('renders through the report path (residual table carries the mean-latency row)', () => {
    const md = renderReport(buildReport([fixtureLoaded], false)); // DES off — pure, fast plumbing check
    expect(md).toContain(FIXTURE_NAME);
    expect(md).toContain('meanLatencyMsAtLoad');
    expect(md).toContain('20 ms'); // the whole-ms measured value the shared formatter renders
  });
});

describe('meanLatencyMsAtLoad — the fixture is ISOLATED from the shipped corpus (Phase A)', () => {
  const realCorpus = loadCorpus();

  it('the real corpus still has exactly twelve scored points and does not contain the fixture', () => {
    const scored = realCorpus.flatMap((e) => e.entry.groundTruth.filter((g) => g.measured !== null));
    // 10 pre- points + the 2 real meanLatencyMsAtLoad entries this task adds (MongoDB Atlas + ScyllaDB,
    // benchANT YCSB) — the plumbing fixture itself must NOT change this count.
    expect(scored.length, 'the plumbing fixture must NOT change the scored-points count').toBe(12);
    expect(realCorpus.some((e) => e.entry.name === FIXTURE_NAME), 'the fixture must not be a shipped corpus entry').toBe(false);
    const provenances = realCorpus.flatMap((e) => [e.entry.notes, ...e.entry.sources.map((s) => s.url), ...e.entry.groundTruth.map((g) => g.sourceUrl)]);
    expect(provenances.some((p) => p.includes('PLUMBING FIXTURE')), 'the fixture provenance must not appear in the corpus').toBe(false);
  });

  it('docs/FIDELITY.md — the shipped generated report — never mentions the fixture', () => {
    const fidelity = readFileSync(fidelityPath(), 'utf8');
    expect(fidelity.includes(FIXTURE_NAME), 'the fixture must not leak into the generated fidelity report').toBe(false);
    expect(fidelity.includes('PLUMBING FIXTURE'), 'the fixture provenance must not leak into the generated report').toBe(false);
  });
});
