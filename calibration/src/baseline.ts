// THE FIDELITY BASELINE — pinned post-fit residuals the standing test and `calibrate --check` guard (// Job 4). Fidelity is guarded exactly like the solver oracle guards solver agreement: if a content/engine change
// makes a corpus entry's post-fit residual REGRESS beyond tolerance, the guard fails and names the entry. The
// numbers below are pinned from a real `pnpm calibrate` run; update them (with review) only when a change is a
// deliberate, understood improvement. Tolerance is absolute percentage points of error, generous enough to absorb
// floating-point noise but tight enough to catch a real fidelity regression.

import type { CalibrationReport } from './report';

export interface Baseline {
  /** Post-fit aggregate error (RMS of relative errors over all scored points), in percent. */
  readonly aggregatePct: number;
  /** Per-entry post-fit residual (RMS of |fitted error|), in percent, keyed by entry name. */
  readonly entryRmsPct: Readonly<Record<string, number>>;
}

/** Pinned from the run captured in CALIBRATION-REPORT.md (regenerate with `pnpm calibrate`). The TechEmpower pair
 *  used to carry an IRREDUCIBLE ~6% residual: single-vs-20-query shared ONE db.postgres service time, so no fit made
 *  both ceilings exact — the leftover was the framework's per-request CPU, a resource the model could not express.
 *  Adding the CPU-bound capacity primitive (compute.service.cpuCores + cpuTimePerRequestMs → an M/M/cores station,
 *  capacity = cores/cpuTime) gave the framework a SEPARATE ceiling, so single-query now binds on the framework CPU
 *  (~104.5k) and 20-query on the DB (5,858 = 117k/20) INDEPENDENTLY — the residual COLLAPSED from ~6% to <1% (both
 *  entries) and the aggregate from 5.2% to 0.6%. DeathStarBench's latency-share anchor is unchanged (its nginx CPU
 *  station preserves the low-load per-hop sojourn, so the Mongo share stays ~0.4%).
 *
 *  V&V corpus Wave A — two capacity-ceiling validations, each a same-architecture pair sharing ONE over-determined
 *  throughput tunable (the TechEmpower single/multi pattern): Redis (redis-benchmark SET + LPUSH, sharing
 *  cache.redis:throughput) and Kafka (Kreps 2014 producer write, no-replication + 3x-async, sharing
 *  stream.kafka:throughput). These are the third and fourth distinct architectures and the first single-node
 *  datastore / streaming capacity validations. NOT a regression: the existing entries' residuals are unchanged;
 *  the aggregate RISES from 0.6% to 1.7% because the four new points carry genuine ~±2% residuals — the honest
 *  command-spread (Redis) and replication-overhead (Kafka) one capacity value cannot remove. In exchange the
 *  out-of-sample leave-one-out FALLS from 12.1% to ~7.8%: each pair shares an over-determined tunable, so every new
 *  point is a genuine out-of-sample prediction (~4%) that the single-capacity model generalizes across the config
 *  variation. NOTE ON SCOPE: both validate the throughput CEILING (driven by the `throughput` cell), NOT a modeling
 *  family — Kafka does NOT flip act-as-a-queue (that family is theory-anchored dynamics the corpus cannot score;
 *  its honest evidence is verification, not a measured residual). Baseline raised to pin the new honest state; the
 *  TechEmpower ±12% remains the hard residual the corpus roadmap still targets.
 *
 *  V&V corpus Wave A, third pair — RabbitMQ (a fifth distinct architecture; the second message-broker after Kafka):
 *  the RabbitMQ 4.0 single classic queue over AMQP 0.9.1 (88,534 msg/s) and AMQP 1.0 (99,413 msg/s) on the SAME
 *  broker share ONE over-determined queue.rabbitmq:throughput. The catalog ships 20,000 msg/s (an ~78% UNDER-
 *  prediction the fit removes → 93,190 msg/s). The aggregate RISES from 1.7% to 3.1% because RabbitMQ's protocol
 *  spread is LARGER than Redis's command-spread or Kafka's replication overhead: AMQP 1.0 is ~12% more efficient
 *  than AMQP 0.9.1 on the identical queue, so one modeled capacity leaves a genuine ±~6% residual per protocol —
 *  the honest cost of validating a real out-of-sample point (the leave-one-out — fit one protocol, predict the
 *  other — lands at ±11–13%, the true protocol gap, no longer a disjoint fallback). NOT a modeling regression: the
 *  seven prior residuals are unchanged; the rise is entirely the new pair's honest protocol spread. */
export const BASELINE: Baseline = {
  aggregatePct: 3.1,
  entryRmsPct: {
    'TechEmpower — Single Database Query': 0.5,
    'TechEmpower — Multiple Queries (20 per request)': 0.7,
    'DeathStarBench — Social Network': 0.4,
    'Redis — SET (single node, non-pipelined)': 2.3,
    'Redis — LPUSH (single node, non-pipelined)': 2.1,
    'Kafka — producer write, no replication (Kreps 2014)': 2.8,
    'Kafka — producer write, 3x async replication (Kreps 2014)': 1.5,
    'RabbitMQ — classic queue (single node, AMQP 0.9.1)': 5.3,
    'RabbitMQ — classic queue (single node, AMQP 1.0)': 6.3,
  },
};

/** Absolute percentage-point slack before a residual counts as a regression. */
export const TOLERANCE_PCT = 1.5;

export interface Violation {
  readonly what: string;
  readonly baseline: number;
  readonly actual: number;
}

/** Compare a fresh report against the pinned baseline; return the residuals that REGRESSED beyond tolerance. */
export function checkAgainstBaseline(report: CalibrationReport): Violation[] {
  const out: Violation[] = [];
  const aggregate = report.fit.objective * 100;
  if (aggregate > BASELINE.aggregatePct + TOLERANCE_PCT) out.push({ what: 'aggregate', baseline: BASELINE.aggregatePct, actual: aggregate });
  for (const er of report.fit.residuals) {
    const base = BASELINE.entryRmsPct[er.name];
    if (base === undefined) continue; // an entry not yet baselined is not a regression (add it after review)
    if (er.rmsFittedPct > base + TOLERANCE_PCT) out.push({ what: er.name, baseline: base, actual: er.rmsFittedPct });
  }
  return out;
}
