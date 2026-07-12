import { shapeSeries, type TwoTierResult, type Tier2Result } from '@sda/content';
import type { Cycle } from '@sda/engine-core';
import { fmt, formatMs } from './format';
import type { SummaryRow, SummarySection } from './summary';

// @algorithm Max-pool sparkline downsampling (a series to unicode) + the two-tier composition
// @problem The ambient two-tier evaluation must render as ONE compact block both shells
//   show identically: the Tier-1 ρ-envelope across the season, the worst-window callout, the cost integral and
//   the %-in-violation (basis analytic), plus — when Tier 2 has run — the survival verdict (basis measured), with
//   the backlog peak (the fact a verdict hinges on) never disappearing in a compact strip.
// @approach Max-pooling any series into <= 32 buckets (max, not mean, so downsampling preserves every peak),
//   rendered as an 8-level unicode block ramp; the composition reads ONLY the values content's two-tier produced
//   (two labelled bases), never re-deriving. Pure string, so the identical chart renders in a web span and a VS
//   Code tree item.
// @complexity O(series length) per sparkline.
// @citations Max-pooling as peak-preserving decimation; unicode block sparklines after Holman's `spark`.
// @invariants The global maximum always survives bucketing; all-zero series render a flat baseline; the two bases
//   are never blurred; Tier-2 rows appear only when Tier 2 has run (the resting handshake's confirm).
// @where-tested app/presenter/src/two-tier-view.test.ts

// THE TWO-TIER SECTION — the ONE composition of the ambient two-tier read-out both shells render (the summary.ts
// discipline): the web System panel prints these rows, the VS Code System tree renders them beneath the summary —
// same labels, same tones, same pre-formatted values, zero drift. The numbers come exclusively from content's
// two-tier evaluation; the presenter only words and formats them (whole-ms tails via `formatMs`, whole-second
// span/phase times via `secs`), never re-derives.

/** The block glyph ramp for a sparkline — 8 levels, ▁ is the zero/floor glyph (a visible baseline). */
const SPARK_GLYPHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/** Sparkline width cap — a System row stays one compact line even for a long observation window. */
const SPARK_MAX_BUCKETS = 32;

/**
 * A compact unicode sparkline of a numeric series: values max-pooled into ≤ `maxBuckets` buckets (a peak must
 * never disappear in downsampling — max, not mean), scaled to the series maximum. All-zero ⇒ a flat baseline.
 * Pure string, so the same chart renders identically in a web `<span>` and a VS Code tree-item description.
 */
export function backlogSparkline(series: readonly number[], maxBuckets: number = SPARK_MAX_BUCKETS): string {
  if (series.length === 0) return '';
  const buckets: number[] = [];
  const per = Math.ceil(series.length / maxBuckets);
  for (let i = 0; i < series.length; i += per) {
    let mx = 0;
    for (let j = i; j < Math.min(i + per, series.length); j++) mx = Math.max(mx, series[j] as number);
    buckets.push(mx);
  }
  const top = Math.max(...buckets);
  if (top <= 0) return SPARK_GLYPHS[0].repeat(buckets.length);
  return buckets
    .map((v) => SPARK_GLYPHS[v <= 0 ? 0 : Math.min(SPARK_GLYPHS.length - 1, 1 + Math.floor((v / top) * (SPARK_GLYPHS.length - 1) - 1e-9))])
    .join('');
}

/** The node-chip shape glyph is a SHORT sparkline — a canvas chip stays one glance-able token. */
const ORIGIN_GLYPH_BUCKETS = 7;

/**
 * A compact unicode glyph of a shaped generator's TIME SHAPE — the `⚡` origin chip's shape hint on the canvas node
 *. It max-pools the SAME λ̂ shape the sweep/DES play ({@link shapeSeries},
 * content's one sampler) into a ≤7-glyph sparkline, so the chip's silhouette IS the evaluated shape — a diurnal
 * hump, a spike's stab, a square burst — never a decorative wiggle. A FLAT generator (no cycles) yields a flat
 * baseline; the caller shows the chip ONLY for a shaped origin (no-filler), so a flat generator's node is unchanged.
 */
export function originShapeGlyph(cycles: readonly Cycle[]): string {
  return backlogSparkline(shapeSeries(cycles, ORIGIN_GLYPH_BUCKETS), ORIGIN_GLYPH_BUCKETS);
}

/** Retry amplification at/below this is no story — the row appears only when retries measurably multiplied work. */
const AMPLIFICATION_VISIBLE = 1.005;

/** A whole-second figure for phase-scale times (recovery, peak instant); latencies stay whole-ms. */
const secs = (n: number): string => `${fmt(Math.round(n))} s`;

/** A season-scale absolute time (seconds into the span) as a compact whole-unit label — the worst instant reads
 *  "1d 6h" over a quarter, "18h" over a couple of days, "35m" over a burst; never fractional. */
function spanTime(s: number): string {
  const t = Math.round(s);
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.round(t / 60)}m`;
  if (t < 86_400) return `${Math.floor(t / 3600)}h ${Math.round((t % 3600) / 60)}m`;
  return `${Math.floor(t / 86_400)}d ${Math.round((t % 86_400) / 3600)}h`;
}

/** ρ tone: saturated (≥1) is a violation, ≥0.85 a warning, below that healthy. */
function rhoTone(rho: number): SummaryRow['tone'] | undefined {
  if (rho >= 1) return 'bad';
  if (rho >= 0.85) return 'warn';
  return undefined;
}

/** The Tier-2 survival rows (re-homed from the deleted stress probe) — the measured proof at the worst window. */
function tier2Rows(t2: Tier2Result, labelOf: (id: string) => string): SummaryRow[] {
  const v = t2.verdict;
  const rows: SummaryRow[] = [];
  rows.push({ label: 'Worst window · verdict', value: v.note, tone: v.survives && !t2.budget.truncated ? 'ok' : 'bad' });
  rows.push({
    label: 'Peak backlog',
    value:
      v.peakBacklog === null
        ? 'none — no queue ever formed'
        : `${fmt(v.peakBacklog.value)} waiting · ${labelOf(v.peakBacklog.node)} · at +${secs(v.peakBacklog.atS)}`,
    ...(v.peakBacklog !== null && !v.survives ? { tone: 'bad' as const } : {}),
  });
  rows.push({ label: 'p99 rising to peak', value: formatMs(v.p99DuringMs) });
  rows.push({ label: 'p99 after peak', value: formatMs(v.p99AfterMs), ...(v.survives ? {} : { tone: 'bad' as const }) });
  rows.push({ label: 'Lost requests', value: fmt(v.lostRequests), ...(v.lostRequests > 0 ? { tone: 'bad' as const } : {}) });
  if (Number.isFinite(v.amplificationPeak) && v.amplificationPeak > AMPLIFICATION_VISIBLE) {
    rows.push({ label: 'Retry amplification · peak', value: `×${fmt(v.amplificationPeak)}`, tone: 'warn' });
  }
  // The compact backlog chart of the WORST queue (max-pooled — a peak never disappears). No-filler: only when a
  // queue actually formed.
  if (v.peakBacklog !== null) {
    const worst = t2.backlog.find((b) => b.node === (v.peakBacklog as { node: string }).node);
    if (worst !== undefined) {
      rows.push({ label: `Backlog · ${labelOf(worst.node)}`, value: `${backlogSparkline(worst.perWindow)} peak ${fmt(worst.peak)}` });
    }
  }
  rows.push({
    label: 'Event budget',
    value: `~${fmt(t2.budget.estimatedEvents)} estimated · ${fmt(t2.budget.eventsProcessed)} processed${t2.budget.truncated ? ` · PARTIAL — stopped at +${secs(t2.budget.endS)}` : ''}`,
    ...(t2.budget.truncated ? { tone: 'warn' as const } : {}),
  });
  return rows;
}

/**
 * The ambient two-tier SummarySection. Tier-1 rows (basis analytic, always present once a
 * generator declares cycles): the ρ-envelope strip across the season, the worst-window callout (its instant, ρ and
 * the node that peaked), the cost integral (the honest mean bill) and the fraction of the span over capacity. Then
 * — only when Tier 2 has run (the resting handshake's DES confirm) — the survival verdict rows (basis measured).
 * Both bases are named in the closing row so they are never blurred (the tool must not lie).
 */
export function twoTierSection(result: TwoTierResult, labelOf: (id: string) => string): SummarySection {
  const { tier1, tier2 } = result;
  const rows: SummaryRow[] = [];

  const peakRho = tier1.rhoEnvelope.length > 0 ? Math.max(...tier1.rhoEnvelope) : 0;
  const tone = rhoTone(peakRho);
  rows.push({ label: 'Load envelope · ρ(t)', value: `${backlogSparkline(tier1.rhoEnvelope)} peak ρ ${peakRho.toFixed(2)}`, ...(tone !== undefined ? { tone } : {}) });

  // The worst window: its absolute instant in the span, its ρ, and the node that peaked (argmax ρ at that window).
  const worstWindow = tier1.windows[tier1.worstWindowIndex];
  const worstNode = worstWindow ? Object.entries(worstWindow.rhoByNode).reduce((mx, [id, r]) => (r > mx.r ? { id, r } : mx), { id: '', r: -1 }).id : '';
  const worstAtS = worstWindow ? worstWindow.tStartS + tier1.windowS / 2 : 0;
  rows.push({
    label: 'Worst window',
    value: `at ${spanTime(worstAtS)} · ρ ${peakRho.toFixed(2)}${worstNode !== '' ? ` · ${labelOf(worstNode)}` : ''}`,
    ...(tone !== undefined ? { tone } : {}),
  });

  rows.push({ label: 'Cost · mean over span', value: `$${fmt(tier1.costIntegral)}/mo` });
  const pctViol = tier1.pctWindowsViolating * 100;
  rows.push({ label: 'Over capacity', value: pctViol <= 0 ? 'never in the season' : `${pctViol.toFixed(pctViol < 1 ? 1 : 0)}% of the span`, ...(pctViol > 0 ? { tone: 'warn' as const } : {}) });

  if (tier2 !== undefined) rows.push(...tier2Rows(tier2, labelOf));

  rows.push({ label: 'Basis', value: tier2 !== undefined ? 'Tier 1 analytic (quasi-static) · Tier 2 measured (transient)' : 'Tier 1 analytic (quasi-static) · Tier 2 measuring…' });

  return { title: 'Load stages · transient', rows };
}
