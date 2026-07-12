import type { Verdict } from '@sda/engine-core';
import { NO_ORIGIN_REASON } from '@sda/content';

// The headline STATUS figures the web footer and the VS Code status bar (WireStatus) SHARE. Extracted so both
// shells read ONE definition of "the system's live numbers" — the web bottom bar and the native status bar can
// never show a different throughput/latency/cost/violation count for the same design (they were copied once and
// would otherwise drift). Values are RAW numbers here; each shell formats them with the shared `fmt`.
//
// Canonical source = app.tsx's footer: throughput at the SLO endpoint (or last node), the MEASURED headline
// latency (the DES tail — single-truth, never the analytic scalar), the whole-design cost, and the violation
// count. The vscode WireStatus mirrored this exactly (finite-latency gate, cost>0 gate, violations incl. build errors).

/** The live headline metrics. Optional fields are OMITTED (not `undefined`) when there is nothing honest to
 *  show — matching the strict-optional WireStatus contract the vscode host renders. */
export interface StatusLine {
  readonly throughputRps?: number; // served throughput at the flow terminal / SLO endpoint
  readonly latencyMs?: number; // MEASURED headline latency (the DES tail) — single-truth; omitted until a sim measures it
  readonly costUsdMonth?: number; // whole-design monthly cost; omitted when ~0 (nothing costed yet)
  readonly violations: number; // failing verdicts + build errors — always present (0 is meaningful: "verified")
  // Present ONLY when the design has NO traffic origin (no client and no node with assumedRps > 0): the honest
  // reason the flow figures are blank, so the shell can show WHY instead of a silent empty status. Omitted otherwise.
  readonly reason?: string;
}

/**
 * Compute the status line from the already-evaluated design state — the app.tsx footer, distilled:
 *   • throughputRps = the served throughput at `sinkId` (the SLO endpoint, else the last node);
 *   • latencyMs     = the MEASURED headline latency (the DES tail the shell passes) — SINGLE-TRUTH, omitted until a
 *                     sim measures it (and when non-finite / undefined); the analytic scalar is never shown here;
 *   • costUsdMonth  = `totalCost` when > 0 (else omitted — nothing has a cost yet);
 *   • violations    = failing verdicts PLUS build errors (a design that won't compile has ≥1 problem).
 *
 * @param throughput  valueOf(sinkId, throughput) — the shell reads it off the evaluation (sinkId chosen its way).
 * @param measuredLatency the DES-measured headline latency (e.g. the sim tail p50) — undefined until a sim has run.
 * @param totalCost   the whole-design summed monthly cost.
 * @param verdicts    the ONE real-aware verdict list.
 * @param evalOk      whether the design compiled; when false, `evalErrorCount` build errors add to the count.
 * @param evalErrorCount how many build-error strings the failed evaluation produced.
 * @param hasOrigin   whether the design has ANY traffic origin (a client OR a node with assumedRps > 0). When
 *                    false (and the design compiled), `reason` explains why the flow figures are blank.
 */
export function statusLine(
  throughput: number | undefined,
  measuredLatency: number | undefined,
  totalCost: number,
  verdicts: readonly Verdict[],
  evalOk: boolean,
  evalErrorCount: number,
  hasOrigin = true,
): StatusLine {
  const latencyMs = measuredLatency !== undefined && Number.isFinite(measuredLatency) ? measuredLatency : undefined;
  const violations = verdicts.filter((v) => v.status === 'violation').length + (evalOk ? 0 : evalErrorCount);
  return {
    ...(throughput !== undefined ? { throughputRps: throughput } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(totalCost > 0 ? { costUsdMonth: totalCost } : {}),
    violations,
    // Only when the design compiles but nothing drives it — a build error is its own, louder problem.
    ...(evalOk && !hasOrigin ? { reason: NO_ORIGIN_REASON } : {}),
  };
}
