// RPS — ONE FORM (the rate row). Every flow-node renders its request rate in the SAME slot/typography, so a source,
// a pure-delay hop and a capacity-limited tier all read as one family (no ad-hoc "rps chip" on some, a ρ meter on
// others). This is the ONE place both shells (web + VS Code) build that row, so it can never drift — the shell only
// paints what this returns (web-is-a-dumb-renderer). Pure: no React, no shell state; values come straight from
// content's already-computed nodeQueues + forward pass.
//
// The two shapes of the one form:
//   • capacity-BEARING tier (a finite, positive M/M/c or throughput ceiling) — the ρ utilisation meter: rate · % · fill.
//   • capacity-LESS tier (a source/origin, or a pure-delay hop with no finite ceiling) — the SAME row, rate alone,
//     verdict-toned. An `assumedRps`-declared origin shows its declared rate here too (its throughput carries it).

import type { NodePeak } from '@sda/content';
import { worstCaseRho } from './peak-view';

/** A rate-row tone (verdict-derived); '' = neutral. */
export type RateTone = 'ok' | 'warn' | 'bad' | '';

/** The rate row a node renders, or nothing when it has no rate to show. `capacity`+`rho` present ⇒ the ρ meter;
 *  absent ⇒ the rate-only row (a source / pure-delay tier), then `tone` colours the rate. */
export interface RateRow {
  /** The rate shown in the row (rps): the REAL offered load for a metered tier, else the node's declared throughput. */
  readonly offered: number;
  /** The tier's real capacity ceiling (rps) — present only for a capacity-bearing tier (finite & positive). */
  readonly capacity?: number;
  /** Utilisation ρ = offered ÷ capacity — present iff `capacity` is. */
  readonly rho?: number;
  /** Verdict tone for a capacity-LESS rate (the % + fill carry the tone when metered instead). */
  readonly tone?: RateTone;
}

/** A node's queue entry from content's `nodeQueues` (structural subset — only the fields the rate row reads). A
 *  topological source has none (it offers load, it does not receive it), so this is `undefined` there. */
export interface RateQueue {
  readonly offered: number;
  readonly capacity: number;
  readonly rho: number;
}

/** The node's own worst verdict status, the tone reads from (matches the shells' `statusOf`). */
export type RateStatus = 'ok' | 'warning' | 'violation' | 'unknown' | undefined;

/** Verdict status → rate tone (violation ⇒ bad, warning ⇒ warn, else neutral-ish ok). */
const toneOf = (status: RateStatus): RateTone => (status === 'violation' ? 'bad' : status === 'warning' ? 'warn' : 'ok');

/**
 * The rate row for one node, or `undefined` when it has no rate to show (no queue AND no declared throughput). A
 * capacity-bearing tier — a queue entry with a finite, positive capacity — yields the ρ utilisation meter; every
 * other node with a rate (a source/origin, or a pure-delay hop whose capacity is infinite) yields the rate-only row
 * toned by its status. `q` is the node's `nodeQueues` entry (absent for a source); `throughput` is its forward-pass
 * throughput (the served/emitted rate, which already folds an `assumedRps` origin in at a source).
 */
export function rateRow(q: RateQueue | undefined, throughput: number | undefined, status: RateStatus, peak?: NodePeak): RateRow | undefined {
  const metered = q !== undefined && Number.isFinite(q.capacity) && q.capacity > 0;
  if (metered) {
    // The ρ shown is the WORST-CASE load (owner ruling): the larger of the steady ρ and the worst-window (shaped) ρ
    // — the number that decides whether the tier breaks. When the worst window strains this tier more than the
    // steady baseline, both the ρ and the offered load read the worst case (offered = ρ × capacity; capacity is
    // config, invariant); with no shape (or a peak ≤ steady) the row is byte-identical to today.
    const cap = (q as RateQueue).capacity;
    const steady = (q as RateQueue).rho;
    const rho = worstCaseRho(steady, peak) ?? steady;
    if (rho === steady) return { offered: (q as RateQueue).offered, capacity: cap, rho };
    return { offered: rho * cap, capacity: cap, rho };
  }
  // Capacity-less: a source / pure-delay hop reads its rate alone, toned by its OWN verdict — and a self-originating
  // generator the sweep found saturates at its worst window carries that saturation through the shared verdict list
  // (its `status` is then a violation ⇒ toned red), so no separate peak read is needed here.
  if (throughput !== undefined) return { offered: throughput, tone: toneOf(status) };
  return undefined;
}
