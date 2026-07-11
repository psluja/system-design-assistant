// THE STANDING FIDELITY GUARD (TASK-93, Job 4) — runs under `pnpm test`. It runs the whole harness deterministically
// and FAILS if a corpus entry's post-fit residual REGRESSES beyond tolerance, so calibration fidelity is guarded the
// way the solver oracle guards solver agreement. It also pins the harness's honesty invariants: determinism (the fit
// is a pure function of the corpus), the CPU-primitive finding (the framework CPU station CLOSES the single-vs-20-query
// residual in the full fit, while leave-one-out honestly shows the CPU value is constrained only by single-query), and Job 3— the harness READS + FITS + REPORTS but NEVER mutates a shipped content default.

import { describe, expect, it } from 'vitest';
import { allManifests, keys } from '@sda/content';
import { buildReport, desCorroboration, fit, leaveOneOut, loadCorpus, predictMetric } from './index';
import { BASELINE, TOLERANCE_PCT, checkAgainstBaseline } from './baseline';

const entries = loadCorpus();
// DES off in the guard (deterministic + fast); the analytic scored metrics are what the baseline guards. A separate
// test exercises the seeded DES corroboration path.
const report = buildReport(entries, false);

const findEntry = (needle: string): (typeof entries)[number] => {
  const e = entries.find((x) => x.entry.name.includes(needle));
  if (e === undefined) throw new Error(`corpus entry not found: ${needle}`);
  return e;
};

describe('calibration harness — fidelity guard (TASK-93 Job 4)', () => {
  it('every scored entry stays within the pinned residual baseline (no fidelity regression)', () => {
    const violations = checkAgainstBaseline(report);
    expect(violations, `residual regressions: ${JSON.stringify(violations)}`).toEqual([]);
  });

  it('the aggregate post-fit error is at (or below) the pinned baseline', () => {
    expect(report.fit.objective * 100).toBeLessThanOrEqual(BASELINE.aggregatePct + TOLERANCE_PCT);
  });

  it('the corpus has the nine ground-truth points and the fitted tunables it should', () => {
    const scored = entries.flatMap((e) => e.entry.groundTruth.filter((g) => g.measured !== null));
    expect(scored.length).toBe(9); // TE single + 20-query, DSB latency share, Redis SET + LPUSH, Kafka no-repl + 3x-async, RabbitMQ AMQP 0.9.1 + 1.0
    // The framework CPU station (compute.service.cpuTimePerRequestMs) is a fitted tunable alongside the DB service
    // time and the Mongo hold time. V&V corpus Wave A adds three shared throughput tunables: cache.redis.throughput
    // (Redis SET + LPUSH), stream.kafka.throughput (Kafka no-replication + 3x-async), and queue.rabbitmq.throughput
    // (RabbitMQ classic queue over AMQP 0.9.1 + AMQP 1.0) — each a same-architecture pair sharing one over-determined
    // capacity. All three are capacity-ceiling validations, not modeling-family flips.
    expect(report.recommendations.map((r) => `${r.selector}.${r.key}`).sort()).toEqual([
      'cache.redis.throughput',
      'compute.service.cpuTimePerRequestMs',
      'db.mongodb.connectionHeldMs',
      'db.postgres.perRequestDuration',
      'queue.rabbitmq.throughput',
      'stream.kafka.throughput',
    ]);
  });

  it('the CPU-bound primitive CLOSES the TechEmpower single-vs-20-query residual (the calibration finding)', () => {
    // Before: single + 20-query shared ONE db.postgres service time, so the joint fit could not satisfy both (~+6%
    // each — the framework's per-request CPU, a resource the model could not express). With a SEPARATE framework CPU
    // station the single-query ceiling binds on the CPU (~104.5k) and the 20-query on the DB (5,858), INDEPENDENTLY,
    // so both residuals collapse to <2% and the TechEmpower pair's own aggregate from ~5.2% to <1%. This is the
    // measurement the primitive was built to make; pinning it here prevents a regression that would silently re-open
    // the gap. (The whole-corpus aggregate is now ~3.1% because the V&V Wave A ceiling pairs add genuine residuals —
    // Redis command-spread ~±2%, Kafka replication ~±2%, and RabbitMQ's larger AMQP-protocol spread ~±6% — none of
    // which re-open the TechEmpower gap, which the two per-entry checks below pin.)
    const single = report.fit.residuals.find((r) => r.name.includes('Single'));
    const multi = report.fit.residuals.find((r) => r.name.includes('Multiple'));
    expect(single?.rmsFittedPct, 'single-query residual should be closed (<2%)').toBeLessThan(2);
    expect(multi?.rmsFittedPct, '20-query residual should be closed (<2%)').toBeLessThan(2);
    expect(report.fit.objective * 100, 'aggregate should stay well below the old 5.2% TechEmpower gap').toBeLessThan(4);
  });
});

describe('calibration harness — determinism (seeded, no clock/RNG)', () => {
  it('a second fit yields byte-identical tunable values', () => {
    const a = [...fit(entries).values.entries()].sort();
    const b = [...fit(entries).values.entries()].sort();
    expect(a).toEqual(b);
  });
});

describe('calibration harness — leave-one-out exposes the structural residual', () => {
  it('holding out TechEmpower single-query reproduces the CPU-bound over-prediction out-of-sample (~+13%)', () => {
    const loo = leaveOneOut(entries);
    const single = loo.find((l) => l.heldOut.includes('Single'));
    expect(single?.constrained, 'single-query must be a genuine out-of-sample test (its tunable is fit on the 20-query point)').toBe(true);
    const err = single?.errors[0]?.errorPct ?? 0;
    // Leave-one-out is the honesty foil to the closed FULL-fit gap. Holding out single-query removes the ONLY point
    // that constrains the framework CPU time (it is inert on the 20-query fold-in, which is DB-bound), so the CPU
    // ceiling falls back toward non-binding and the held-out single-query is predicted DB-bound again — the same
    // ~+13% over-prediction. So the primitive closes the gap when its resource IS calibrated (the full fit), and the
    // cross-validation honestly shows the CPU value is what closes it (constrained only by single-query itself).
    expect(err).toBeGreaterThan(8);
    expect(err).toBeLessThan(18);
  });

  it('holding out DeathStarBench is an honest disjoint-fallback, not a true out-of-sample test', () => {
    const loo = leaveOneOut(entries);
    const dsb = loo.find((l) => l.heldOut.includes('DeathStarBench'));
    expect(dsb?.constrained).toBe(false); // its Mongo tunable is disjoint from the TechEmpower fold-in set
  });
});

describe('calibration harness — Job 3: never mutates shipped content defaults', () => {
  it('the out-of-box (catalog-default) prediction is stable across a full fit', () => {
    const single = findEntry('Single');
    const gt = single.entry.groundTruth[0];
    expect(gt).toBeDefined();
    const before = predictMetric(single.entry, single.model, gt!, 'default', new Map());
    buildReport(entries, false); // run the whole fit again
    const after = predictMetric(single.entry, single.model, gt!, 'default', new Map());
    expect(after).toBeCloseTo(before, 6);
    // db.postgres ships 100 connections / 50 ms => 2,000 op/s; single query => a 2,000 req/s ceiling, un-calibrated.
    expect(after).toBeCloseTo(2000, 0);
  });

  it('the shipped db.postgres manifest default is untouched after fitting (~0.239 ms is a recommendation only)', () => {
    const cfg = allManifests['db.postgres']?.config?.find((c) => String(c.key) === String(keys.perRequestDuration));
    expect(cfg?.value).toBe(50); // the catalog still ships 50 ms — the fit's ~0.239 ms lives only in the report
  });
});

describe('calibration harness — DES corroboration (seeded)', () => {
  it('produces a monotone tail (p50 <= p95 <= p99) at a sub-saturation load', () => {
    const full = fit(entries);
    const te = findEntry('Single');
    const gt = te.entry.groundTruth.find((g) => g.metric === 'capacityCeilingRps');
    expect(gt).toBeDefined();
    const ceiling = predictMetric(te.entry, te.model, gt!, 'fitted', full.values);
    const tail = desCorroboration(te.entry, te.model, full.values, ceiling);
    expect(tail, 'DES corroboration should run on the fitted single-query design').toBeDefined();
    expect(tail!.p50).toBeLessThanOrEqual(tail!.p95);
    expect(tail!.p95).toBeLessThanOrEqual(tail!.p99);
  });
});
