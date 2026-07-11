import type { UncertaintyResult } from '@sda/content';
import { fmt, formatMs, formatMsDigits } from './format';
import { keyInfo } from './meta';
import type { SummaryRow, SummarySection } from './summary';

// THE UNCERTAINTY VIEW-MODEL — the ONE composition both shells render for the ambient Monte-Carlo block
// (doc: uncertainty-monte-carlo §4). The real-time loop recomputes an {@link UncertaintyResult} in the background
// on every design change; this turns that result + the resting-handshake STATE into System-panel rows: metric
// rows `median (p5–p95)`, SLO rows `% scenarios ✓`, the seed + N, and a STATE TAG that distinguishes an fp32 GPU
// PREVIEW from a CPU-CONFIRMED (verdict-grade) pass — fp32 is never shown as final truth (AC#6). Pure view-model:
// no shell state, values pre-formatted with the shared `fmt` (∞ / '—' preserved honestly).

/** The resting-handshake state a result is shown in (AC#6): computing (in flight), a live fp32 PREVIEW cloud, or
 *  the CPU-CONFIRMED verdict-grade pass the design settled to. */
export type UncertaintyState = 'computing' | 'preview' | 'confirmed';

/** Everything the block needs: the latest result (null while the FIRST pass is still in flight), its handshake
 *  state, which backend produced it (fp32 GPU vs fp64 CPU), and the measured compute time (the ambient cadence). */
export interface UncertaintyPresentation {
  readonly result: UncertaintyResult | null;
  readonly state: UncertaintyState;
  readonly backend?: 'gpu' | 'cpu';
  /** The last run's measured wall time (ms) — the ambient cadence the surface can show honestly. */
  readonly elapsedMs?: number;
}

/** The confidence tone for an SLO's satisfied fraction: a comfortable margin is ok, a slipping one warns, a
 *  frequently-broken one is bad — the same three-tone grammar every System row uses. Always one of the three. */
const confidenceTone = (fraction: number): NonNullable<SummaryRow['tone']> => (fraction >= 0.95 ? 'ok' : fraction >= 0.8 ? 'warn' : 'bad');

/** The state-tag row text — the honest preview-vs-confirmed distinction (AC#6). A PREVIEW names its fp32/GPU
 *  provenance so no reader mistakes it for verdict-grade; a CONFIRMED pass carries the seed + N for reproducibility. */
function stateRow(p: UncertaintyPresentation, result: UncertaintyResult | null): SummaryRow {
  const cadence = p.elapsedMs !== undefined ? ` · ${formatMs(p.elapsedMs)}` : '';
  if (p.state === 'computing' || result === null) {
    return { label: 'State', value: `computing…${p.backend === 'gpu' ? ' (GPU preview)' : ''}` };
  }
  const repro = `seed ${result.seed} · ${fmt(result.scenarios)} scenarios`;
  if (p.state === 'preview') {
    // fp32 preview — explicitly NOT verdict-grade. The backend note tells the reader why (GPU fp32).
    return { label: 'State', value: `preview · fp32${p.backend === 'gpu' ? ' (GPU)' : ''} · ${repro}${cadence}` };
  }
  return { label: 'State', value: `confirmed · ${repro}${cadence}`, tone: 'ok' };
}

/**
 * Build the "Uncertainty · Monte Carlo" System section for the ambient loop, or `null` when there is nothing to
 * show (no result and not computing — the no-filler rule; the loop only ever runs when ranges are declared). One
 * section, rendered identically by both shells: a state-tag row, one row per metric (`median (p5–p95) unit`), one
 * row per forward-judgeable SLO (`XX% scenarios ✓`), and a ranged-inputs line. `labelOf` maps a node id to its
 * friendly label (the shell's own), defaulting to the id.
 */
export function uncertaintySection(p: UncertaintyPresentation, labelOf: (id: string) => string = (id) => id): SummarySection | null {
  const result = p.result;
  if (result === null && p.state !== 'computing') return null;
  const rows: SummaryRow[] = [stateRow(p, result)];

  if (result !== null) {
    // Metric distributions: the board-room "median (p5–p95)" the doc §3 calls for. A zero-spread metric still
    // reads honestly (p5 == median == p95). Units ride inline via the shared formatter.
    for (const m of result.metrics) {
      // A TIME metric (unit 'ms') rounds to whole ms per the display rule; every other unit keeps `fmt`. The unit
      // rides once at the end, so the median/p5/p95 use the BARE whole-ms digits (never a per-value ' ms').
      const isMs = m.unit === 'ms';
      const n = (x: number): string => (isMs ? formatMsDigits(x) : fmt(x));
      const unit = m.unit === 'ratio' ? '' : ` ${m.unit}`;
      const band = m.p5 === m.p95 ? `${n(m.median)}${unit}` : `${n(m.median)} (${n(m.p5)}–${n(m.p95)})${unit}`;
      rows.push({ label: m.name, value: band });
    }
    // SLO confidence: "% of scenarios satisfied", the queueing-aware v2 verdict (the same one every surface reads).
    for (const s of result.sloConfidence) {
      const pct = s.satisfiedFraction * 100;
      rows.push({ label: `${labelOf(s.scope)} · ${keyInfo(String(s.key)).label}`, value: `${pct.toFixed(pct >= 99.95 || pct <= 0.05 ? 0 : 1)}% scenarios ✓`, tone: confidenceTone(s.satisfiedFraction) });
    }
    // The register line: which inputs are ranged (what the distribution is over) — the reproducibility footer.
    if (result.rangedInputs.length > 0) {
      rows.push({ label: 'Ranged inputs', value: result.rangedInputs.map((r) => `${labelOf(r.node)}·${keyInfo(String(r.key)).label}`).join(', ') });
    }
  }

  return { title: 'Uncertainty · Monte Carlo', rows };
}
