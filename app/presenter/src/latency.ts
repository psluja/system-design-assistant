import type { Verdict } from '@sda/engine-core';
import { keys } from '@sda/content';
import { formatMs, formatMsDigits } from './format';
import type { NodeResponseView, SimTail } from './summary';

// SINGLE-TRUTH LATENCY (owner decree — "one number per surface, best-available-truth wins"). The policy is
// MEASURED-OR-NOTHING: every user-facing latency is the discrete-event simulation's MEASUREMENT, or nothing at
// all. The analytic scalars (responseLatency / latencyBreakdown / realCumulativeLatency) stay COMPUTED — the
// solver / ambient / envelope still need them — but they are the engine's internal approximation and appear as a
// SHOWN value on NO surface. There is no 'estimate' label and never two latencies as peers: if one value is more
// accurate (measured), the other is not shown at all.
//
// STALENESS follows the existing sim convention: the ambient DES re-runs ~1 s after any edit, and the shell keeps
// showing the LAST measurement (a subtle "refreshing" state) until the fresh one lands — never blanking, never
// swapping to an analytic value. With `sim === null` (no run yet, or a design the DES cannot drive — no traffic
// origin) there is simply nothing measured, and the surface's existing guided-emptiness shows instead.
//
// This is the ONE place the measured-latency policy is resolved for both shells (web + VS Code), so a latency can
// never render one way on one canvas and another way on the other (web-is-a-dumb-renderer). Pure: no shell state.

/** A verdict-derived tone for a latency readout. */
export type LatencyTone = 'ok' | 'warn' | 'bad';

/** The latency requirement keys whose verdicts colour a latency readout: the mean `latency` band and the
 *  `tailLatency` (percentile) band. A readout reads red exactly when one of these SLOs is being violated. */
const LATENCY_REQ_KEYS: ReadonlySet<string> = new Set([String(keys.latency), String(keys.tailLatency)]);

/**
 * Resolve a node's FRESH measured response, or `null` when there is nothing measured to show. Measured-or-nothing:
 * a `null` means the surface renders nothing (no analytic fallback) — before the first run (`sim === null`), when
 * the node was not a station in the run (no reservoir), or when the reservoir is empty / NaN (never reached, or
 * every request dropped). A non-null result is always finite with real samples.
 */
export function measuredResponseOf(sim: SimTail | null, id: string): NodeResponseView | null {
  if (!sim || sim.nodeResponse === undefined) return null;
  const r = sim.nodeResponse.find((n) => n.id === id);
  if (r === undefined) return null;
  if (!Number.isFinite(r.mean) || r.samples <= 0) return null;
  return r;
}

/** The worst tone of a node's own latency / tailLatency verdicts (violation → warn → ok), or `undefined` when it
 *  bears none — so a latency readout is verdict-aware: red when its SLO is violated, neutral when there is no SLO. */
export function latencyTone(verdicts: readonly Verdict[], id: string): LatencyTone | undefined {
  let worst: LatencyTone | undefined;
  const rank = { ok: 0, warn: 1, bad: 2 } as const;
  for (const v of verdicts) {
    if (String(v.scope) !== id || !LATENCY_REQ_KEYS.has(String(v.key))) continue;
    const t: LatencyTone | undefined = v.status === 'violation' ? 'bad' : v.status === 'warning' ? 'warn' : v.status === 'ok' ? 'ok' : undefined;
    if (t !== undefined && (worst === undefined || rank[t] > rank[worst])) worst = t;
  }
  return worst;
}

/**
 * The canvas node's latency BAR view-model — a MEASURED range anchored p50 → p99 (doc: single-truth-latency).
 * `typical` is the p50 anchor ("what a caller usually waits"), `tail` the p99 anchor ("the number a reviewer
 * judges by"); both are pre-formatted whole-ms tokens WITH their names so both shells render identical text. `tone`
 * is the node's verdict tone (the bar is verdict-aware). The shell paints `typical` in a calm tone and `tail` in a
 * tail/warning-leaning tone, and may gradient the fill between the two — no numbers or omission logic live in the
 * shell (web-is-a-dumb-renderer).
 */
export interface LatencyRangeBar {
  /** The p50 anchor, pre-formatted, e.g. `p50 81 ms` — the "typical" left anchor. */
  readonly typical: string;
  /** The p99 anchor, pre-formatted, e.g. `p99 213 ms` — the "tail" right anchor. */
  readonly tail: string;
  /** Bare whole-ms digits for the p50 anchor (no unit / no label) — for a shell that composes its own label. */
  readonly p50Digits: string;
  /** Bare whole-ms digits for the p99 anchor. */
  readonly p99Digits: string;
  /** The node's own latency/tailLatency verdict tone, or undefined (neutral). */
  readonly tone?: LatencyTone;
  /** The native-hover sentence naming the measured range + its provenance (simulated). */
  readonly tooltip: string;
}

/**
 * Build the canvas latency range bar from a node's MEASURED response. The caller resolves the response with
 * {@link measuredResponseOf} (so a `null` means "render nothing" — the bar is never built from an analytic value)
 * and the tone with {@link latencyTone}. Pure — no React, no shell state.
 */
export function latencyRangeBar(view: NodeResponseView, tone?: LatencyTone): LatencyRangeBar {
  const p50Digits = formatMsDigits(view.p50);
  const p99Digits = formatMsDigits(view.p99);
  return {
    typical: `p50 ${formatMs(view.p50)}`,
    tail: `p99 ${formatMs(view.p99)}`,
    p50Digits,
    p99Digits,
    ...(tone ? { tone } : {}),
    tooltip:
      `Measured request→response latency (discrete-event simulation): typical p50 ${formatMs(view.p50)} → ` +
      `tail p99 ${formatMs(view.p99)} (mean ${formatMs(view.mean)}, over ${view.samples.toLocaleString('en-US')} samples). ` +
      `What a caller of this service waits for — an async call is cut. Refreshes ~1 s after each edit.`,
  };
}
