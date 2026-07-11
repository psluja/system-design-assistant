import type { Band, Transform } from '@sda/engine-core';
import { formatMs, formatMsDigits } from './format-ms';
import type {
  ArchEdge,
  ArchGroup,
  ArchNode,
  ArchitectureSection,
  AssumptionRow,
  CapacitySection,
  ChartSeries,
  CostDerivation,
  CostSection,
  DocModel,
  GlossarySection,
  GuaranteeReqRow,
  GuaranteesSection,
  LagReqRow,
  Provenance,
  ReliabilitySection,
  RequirementRow,
  RisksSection,
  ScenarioOverrideCell,
  ScenariosSection,
  ScenarioWorldRow,
  SectionKey,
  SimulationSection,
  SummarySection,
  TransformRow,
} from './doc-model';

// THE HTML RENDERER (doc: design-doc-v2 R2) — a PURE `renderHtml(DocModel) → string` that turns the DocModel data
// (R1) into ONE self-contained, standalone HTML document a senior architect hands to a review board. It renders
// ONLY what the model carries: sections walk `sectionOrder`, an absent optional section (alternatives, retry story,
// load sweep) renders NOTHING — no placeholder (§6 owner ruling: a scope statement is honesty, an empty template is
// filler). Charts are hand-rendered SVG from the model's ChartSeries; the C4 diagram is hand-rendered SVG from the
// architecture data (canvas positions the architect arranged). Same design-doc typography family as docs/design/*
// (paper/serif body, teal/amber accents, the .prov provenance badges) with its own identity as a GENERATED report.
//
// HARD INVARIANTS honoured here:
//  - PURE + DETERMINISTIC: no clock, no randomness. The timestamp is `model.generatedAt` (an input); charts sort/lay
//    out deterministically. The same model always renders the same bytes — golden-testable.
//  - ZERO NETWORK: inline CSS, inline SVG, system font stacks (no @font-face, no fetched fonts), no <script> needed.
//    The ONLY external URLs are provenance `source` links (plain <a href> to official docs) — the register's point.
//  - XSS-SAFE BY CONSTRUCTION: EVERY interpolation of a model-derived string goes through `esc()` (below). A node
//    label carrying `<script>` comes out as inert text. A test injects `<script>` and greps the output for it.
//  - RENDERING ONLY: this module computes NO metric the model did not already carry. It formats and lays out.

// ── escaping (the security keystone) ─────────────────────────────────────────────────────────────────────────

/**
 * Escape a string for safe interpolation into HTML text or a double-quoted attribute. Every model-derived string
 * (node labels, component types, group names, notes, protocols, source URLs used as link TEXT, glossary terms)
 * passes through this at EVERY site — XSS-safe by construction, not by review. `&` first so we never double-escape
 * an entity we just introduced. Covers `<>&"'` — enough for HTML text, attribute values (double- and single-quoted)
 * and inside SVG `<text>` (which is parsed as HTML/XML text). A test asserts an injected `<script>` is neutralised.
 */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape a URL for use in an `href`. A provenance source is meant to be an https link to official docs; we allow
 * ONLY http(s) URLs through as a live link (defence in depth against a `javascript:`/`data:` URL smuggled into a
 * manifest source). A non-http(s) string is rendered as escaped TEXT, never as a live href — honest and inert.
 */
function safeHref(url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? esc(url) : undefined;
}

// ── number formatting (thousands separators; deterministic) ──────────────────────────────────────────────────

/** A compact number with thousands separators: integers bare (`100,000`), else ≤2 decimals with trailing zeros
 *  stripped (`1.67`), `∞`/`−∞` for a non-finite value (a saturated tier's unbounded latency) — never JS "Infinity".
 *  `Intl`-free (deterministic, no locale surprises across environments): the grouping is done by hand. */
function num(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '−∞';
  const rounded = Number.isInteger(n) ? n : Number(n.toFixed(2));
  const neg = rounded < 0;
  const abs = Math.abs(rounded);
  const intPart = Math.trunc(abs);
  const frac = abs - intPart;
  const grouped = String(intPart).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fracStr = frac === 0 ? '' : String(Number(frac.toFixed(2))).slice(1); // ".67"
  return (neg ? '−' : '') + grouped + fracStr;
}

/** An availability/durability ratio as a percentage with enough nines to be meaningful (matches the MD renderer). */
function pct(a: number): string {
  return `${(a * 100).toFixed(a >= 0.9999 ? 4 : a >= 0.99 ? 3 : 2)}%`;
}

const money = (n: number): string => `$${num(n)}`;

/** A value + unit as display text: percentages for ratio units, money for USD, else `num unit`. A dimensionless
 *  unit (`'1'`, the registry's placeholder for a pure count like a concurrency or a retry count) renders as the
 *  bare number — never "30 1". Escapes the unit. */
function valueUnit(value: number, unit: string): string {
  if (unit === 'ratio') return pct(value);
  if (unit === 'USD/month') return `${money(value)}/mo`;
  if (unit === 'ms') return formatMs(value); // a TIME value rounds to whole ms (the canonical token carries the unit)
  return unit && unit !== '1' ? `${num(value)} ${esc(unit)}` : num(value);
}

/** A transform as a compact human phrase for the architecture edge pill + capacity table: "×100" (ratio), "1:100"
 *  (batch), a rate ceiling (cap/window), or "1%" (prob). Mirrors the MD renderer's verb, kept terse for an SVG pill. */
function transformVerb(t: Transform): string {
  switch (t.kind) {
    case 'ratio':
      return `×${num(t.value)}`;
    case 'batch':
      return `1:${num(t.value)}`;
    case 'cap':
      return `≤${num(t.value)}/s`;
    case 'window':
      return `≤${num(1000 / t.value)}/s`;
    case 'prob':
      return `${num(t.value * 100)}%`;
    case 'generate':
      return `⚡${num(t.level)}/s`; // a generator pill: the level it originates (the day's mean rate)
  }
}

/** A declared SLO band as a human requirement, e.g. "≥ 1,000", "≤ 300", "p99 ≤ 300", "≥ 99.99%". Ratio keys render
 *  as percentages so the requirement matches the computed column. `unit` decides the ratio rendering. */
function bandRequirement(band: Band, unit: string): string {
  // A TIME requirement (unit 'ms') rounds its declared target to whole ms — BARE digits (this column carries no unit).
  const isMs = unit === 'ms';
  const fmt = (n: number): string => (unit === 'ratio' ? pct(n) : isMs ? formatMsDigits(n) : num(n));
  if (band.shape === 'point') return `= ${fmt(band.target)}`;
  if (band.shape === 'percentiles') return [...band.targets].map(([p, t]) => `${esc(p)} ≤ ${isMs ? formatMsDigits(t) : num(t)}`).join(', ');
  const parts: string[] = [];
  if (band.min !== undefined) parts.push(`≥ ${fmt(band.min)}`);
  if (band.max !== undefined) parts.push(`≤ ${fmt(band.max)}`);
  if (band.target !== undefined) parts.push(`target ${fmt(band.target)}`);
  return parts.join(', ') || '(any)';
}

// ── SVG chart helpers (hand-rendered, deterministic, no library) ───────────────────────────────────────────────

/** The utilisation-bar tone (doc §5): teal below 0.7, amber 0.7–0.9, red above 0.9 — the ρ traffic-light. */
function utilTone(rho: number): string {
  if (rho > 0.9) return CHART.red;
  if (rho >= 0.7) return CHART.amber;
  return CHART.teal;
}

// The chart palette — the design-doc language (teal accent, amber accent2, a muted ink for axes/labels). Kept as
// constants so every chart is consistent and the tones are one place to tune.
const CHART = {
  teal: '#0b6e6e',
  amber: '#b4530a',
  red: '#a3322b',
  ink: '#1a1d23',
  ink2: '#4b5263',
  grid: '#e5e1d8',
  track: '#efede7',
} as const;

/** The EXACT figure width budget on the A4 page (2026-07-03 §1): the print content width (~794px A4 @96dpi) minus
 *  the `.w` side padding and a figure's own padding/border. Every chart and the C4 diagram size their intrinsic SVG
 *  width to this, so a figure fills the page column and never has to scroll or shrink. One constant, shared. */
const A4_FIGURE_BUDGET = 700;

/** Common horizontal-bar-chart geometry. A row per point: a label gutter, a value track, a coloured bar, a value
 *  caption. Returns a complete <svg>. `tone` maps a point's value → a bar colour (utilisation traffic-light, or a
 *  flat accent). `fmt` renders the value caption. Deterministic: no measured text, fixed gutter widths. */
function barChart(
  series: ChartSeries,
  opts: { readonly tone: (value: number) => string; readonly fmt: (value: number) => string; readonly max?: number; readonly refLine?: number },
): string {
  const points = series.points;
  const rowH = 30;
  const padTop = 14;
  const padBottom = 24; // room for the axis tick-label row
  const labelW = 150;
  const valueW = 88;
  const width = A4_FIGURE_BUDGET; // fill the exact A4 figure budget (§1)
  const trackW = width - labelW - valueW;
  const height = padTop + points.length * rowH + padBottom;
  const maxVal = opts.max ?? Math.max(1e-9, ...points.map((p) => p.value));
  const scale = trackW / maxVal;
  const axisBottom = padTop + points.length * rowH;

  // Vertical gridlines + tick labels behind the bars (owner review R2: a readable value scale, not just bare bars).
  const ticks = niceTicks(maxVal).filter((t) => t <= maxVal + 1e-9);
  const grid = ticks
    .map((tv) => {
      const x = labelW + tv * scale;
      return (
        `<line x1="${round(x)}" y1="${padTop}" x2="${round(x)}" y2="${axisBottom}" stroke="${CHART.grid}" stroke-width="1"/>` +
        `<text x="${round(x)}" y="${axisBottom + 14}" text-anchor="middle" class="cax">${esc(num(tv))}</text>`
      );
    })
    .join('');

  const rows = points
    .map((p, i) => {
      const y = padTop + i * rowH;
      const barLen = Math.max(0, Math.min(trackW, p.value * scale));
      const tone = opts.tone(p.value);
      return [
        `<text x="${labelW - 8}" y="${y + rowH / 2}" text-anchor="end" class="cl">${esc(p.label)}</text>`,
        `<rect x="${labelW}" y="${y + 5}" width="${trackW}" height="${rowH - 12}" rx="3" fill="${CHART.track}"/>`,
        `<rect x="${labelW}" y="${y + 5}" width="${round(barLen)}" height="${rowH - 12}" rx="3" fill="${tone}"/>`,
        `<text x="${labelW + trackW + 8}" y="${y + rowH / 2}" class="cv">${esc(opts.fmt(p.value))}</text>`,
      ].join('');
    })
    .join('');

  // An optional reference line (e.g. ρ = 1 saturation, or the target utilisation) drawn across the tracks.
  const ref =
    opts.refLine !== undefined && opts.refLine <= maxVal
      ? (() => {
          const x = labelW + opts.refLine * scale;
          return `<line x1="${round(x)}" y1="${padTop}" x2="${round(x)}" y2="${axisBottom}" stroke="${CHART.red}" stroke-width="1.4" stroke-dasharray="3 3"/>`;
        })()
      : '';

  return svg(width, height, grid + rows + ref);
}

/** The latency-budget waterfall (doc §5): per-tier own latency along the busiest flow, stacked so the reader sees
 *  both the contribution of each tier and the running total. Deterministic left-to-right cumulative layout. */
function waterfallChart(series: ChartSeries): string {
  const points = series.points;
  const rowH = 30;
  const padTop = 14;
  const padBottom = 40; // room for the axis tick row + the total caption
  const labelW = 150;
  const captionW = 74;
  const width = A4_FIGURE_BUDGET; // fill the exact A4 figure budget (§1)
  const barsW = width - labelW - captionW;
  const height = padTop + points.length * rowH + padBottom;
  const total = points.reduce((s, p) => s + p.value, 0);
  // The cumulative axis runs 0…total; nice ticks give the reader a scale for the running total (owner review R2).
  const ticks = niceTicks(total);
  const axisMax = Math.max(total, ticks[ticks.length - 1] ?? total);
  const scale = axisMax > 0 ? barsW / axisMax : 0;
  const axisBottom = padTop + points.length * rowH;

  // Vertical gridlines + tick labels behind the stacked bars — the cumulative-ms scale.
  const grid = ticks
    .map((tv) => {
      const x = labelW + tv * scale;
      return (
        `<line x1="${round(x)}" y1="${padTop}" x2="${round(x)}" y2="${axisBottom}" stroke="${CHART.grid}" stroke-width="1"/>` +
        `<text x="${round(x)}" y="${axisBottom + 14}" text-anchor="middle" class="cax">${esc(num(tv))}</text>`
      );
    })
    .join('');

  let cursor = 0;
  const rows = points
    .map((p, i) => {
      const y = padTop + i * rowH;
      const x = labelW + cursor * scale;
      const len = Math.max(1, p.value * scale);
      cursor += p.value;
      return [
        `<text x="${labelW - 8}" y="${y + rowH / 2}" text-anchor="end" class="cl">${esc(p.label)}</text>`,
        `<rect x="${round(x)}" y="${y + 5}" width="${round(len)}" height="${rowH - 12}" rx="3" fill="${CHART.teal}"/>`,
        `<text x="${labelW + barsW + 8}" y="${y + rowH / 2}" class="cv">${esc(formatMs(p.value))}</text>`,
      ].join('');
    })
    .join('');
  const totalLine = `<text x="${labelW}" y="${height - 6}" class="cax">end-to-end own latency: ${esc(formatMs(total))} (axis in ms)</text>`;
  return svg(width, height, grid + rows + totalLine);
}

/** The cost-breakdown chart (doc §8): a horizontal bar per component (own compute/storage cost), flat amber tone,
 *  captioned with the dollar figure. Reuses barChart with a money formatter. */
function costChart(series: ChartSeries): string {
  return barChart(series, { tone: () => CHART.amber, fmt: (v) => `${money(v)}/mo` });
}

/**
 * "Nice" axis tick values from 0 to `max` (owner review R2: 4–6 labelled ticks). Rounds the step to a 1/2/5×10ⁿ
 * value so labels read cleanly (0, 50, 100, …), then returns every tick from 0 up to and including the smallest
 * nice tick ≥ max. Deterministic and dependency-free. An empty/degenerate max yields a single `[0]`.
 */
function niceTicks(max: number, targetCount = 5): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [0];
  const rawStep = max / targetCount;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const niceUnit = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const step = niceUnit * mag;
  const ticks: number[] = [];
  for (let t = 0; t <= max + step * 1e-9; t += step) ticks.push(Number(t.toFixed(6)));
  return ticks;
}

/**
 * The per-hop PROPAGATION mini-chart (owner review R2): a compact horizontal-bar pair per transformed edge showing
 * the rate ENTERING (muted) and the rate LEAVING (teal) the transform, so the reader SEES load grow or shrink across
 * each shaping wire. Scaled to the largest rate across all rows, with nice gridlines behind the bars. Deterministic.
 */
function propagationChart(transforms: readonly TransformRow[]): string {
  const rows = transforms.filter((t) => t.enteringRps !== undefined && t.resultingRps !== undefined);
  if (rows.length === 0) return '';
  const rowH = 34;
  const padTop = 22;
  const padBottom = 20;
  const labelW = 150;
  const captionW = 96;
  const width = A4_FIGURE_BUDGET; // fill the exact A4 figure budget (§1)
  const trackW = width - labelW - captionW;
  const height = padTop + rows.length * rowH + padBottom;
  const maxRate = Math.max(1e-9, ...rows.flatMap((t) => [t.enteringRps as number, t.resultingRps as number]));
  const ticks = niceTicks(maxRate);
  const tickMax = ticks[ticks.length - 1] ?? maxRate;
  const scale = trackW / tickMax;

  // Gridlines + tick labels behind the bars (the shared axis furniture the owner asked for).
  const grid = ticks
    .map((tv) => {
      const x = labelW + tv * scale;
      return (
        `<line x1="${round(x)}" y1="${padTop - 6}" x2="${round(x)}" y2="${padTop + rows.length * rowH}" stroke="${CHART.grid}" stroke-width="1"/>` +
        `<text x="${round(x)}" y="${height - 6}" text-anchor="middle" class="cax">${esc(num(tv))}</text>`
      );
    })
    .join('');

  const bars = rows
    .map((t, i) => {
      const y = padTop + i * rowH;
      const enter = t.enteringRps as number;
      const leave = t.resultingRps as number;
      const enterLen = Math.max(1, enter * scale);
      const leaveLen = Math.max(1, leave * scale);
      return [
        `<text x="${labelW - 8}" y="${y + rowH / 2}" text-anchor="end" class="cl">${esc(t.from)} → ${esc(t.to)}</text>`,
        // entering (muted) above, leaving (teal) below — a thin stacked pair reads as "before → after".
        `<rect x="${labelW}" y="${y + 3}" width="${round(enterLen)}" height="9" rx="2" fill="${CHART.ink2}" opacity="0.35"/>`,
        `<rect x="${labelW}" y="${y + 15}" width="${round(leaveLen)}" height="9" rx="2" fill="${CHART.teal}"/>`,
        `<text x="${labelW + trackW + 8}" y="${y + rowH / 2}" class="cv">${esc(num(enter))} → ${esc(num(leave))}/s</text>`,
      ].join('');
    })
    .join('');

  const legend =
    `<rect x="${labelW}" y="6" width="10" height="9" rx="2" fill="${CHART.ink2}" opacity="0.35"/><text x="${labelW + 14}" y="14" class="cax">entering</text>` +
    `<rect x="${labelW + 78}" y="6" width="10" height="9" rx="2" fill="${CHART.teal}"/><text x="${labelW + 92}" y="14" class="cax">leaving</text>`;

  return figure(svg(width, height, grid + bars + legend), 'Per-hop propagation: the request rate entering each shaping wire (grey) and the rate leaving it (teal).');
}

/** The optional load→latency sweep (doc §5): a line chart, offered-load on X, end-to-end latency on Y, with axis
 *  labels and a plotted point per sweep sample. Deterministic polyline; axes drawn from the data extent. */
function sweepChart(series: ChartSeries): string {
  const points = series.points;
  const width = A4_FIGURE_BUDGET; // fill the exact A4 figure budget (§1)
  const height = 260;
  const padL = 56;
  const padR = 18;
  const padT = 16;
  const padB = 40;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const xs = points.map((p) => Number(p.label));
  const ys = points.map((p) => p.value);
  const xMax = Math.max(1e-9, ...xs);
  // A saturated sample carries an UNBOUNDED (∞) latency (ρ ≥ 1) — real, but unplottable. We scale the axis to the
  // largest FINITE latency and pin any ∞ point at the plot top (the honest "off the chart — the tier saturated,
  // latency runs away" cliff), so one saturated factor never collapses the whole chart into NaN.
  const finiteYs = ys.filter((y) => Number.isFinite(y));
  const yMaxData = Math.max(1e-9, ...finiteYs);
  // Nice ticks on BOTH axes (owner review R2: 4–6 labelled ticks + gridlines). We scale the plot to the largest
  // nice tick so the top/right gridline lands exactly on the axis end and the labels read cleanly (0, 200, 400…).
  const xTicks = niceTicks(xMax);
  const yTicks = niceTicks(yMaxData);
  const xAxisMax = Math.max(xMax, xTicks[xTicks.length - 1] ?? xMax);
  const yMax = Math.max(yMaxData, yTicks[yTicks.length - 1] ?? yMaxData);
  const xOf = (x: number): number => padL + (x / xAxisMax) * plotW;
  const yOf = (y: number): number => (Number.isFinite(y) ? padT + plotH - (Math.min(y, yMax) / yMax) * plotH : padT);

  // Gridlines + tick labels first (behind the data line). Horizontal for Y (latency), vertical for X (offered load).
  const yGrid = yTicks
    .map((tv) => {
      const y = yOf(tv);
      return (
        `<line x1="${padL}" y1="${round(y)}" x2="${padL + plotW}" y2="${round(y)}" stroke="${CHART.grid}" stroke-width="1"/>` +
        `<text x="${padL - 8}" y="${round(y) + 4}" text-anchor="end" class="cax">${esc(num(tv))}</text>`
      );
    })
    .join('');
  const xGrid = xTicks
    .map((tv) => {
      const x = xOf(tv);
      return (
        `<line x1="${round(x)}" y1="${padT}" x2="${round(x)}" y2="${padT + plotH}" stroke="${CHART.grid}" stroke-width="1"/>` +
        `<text x="${round(x)}" y="${padT + plotH + 16}" text-anchor="middle" class="cax">${esc(num(tv))}</text>`
      );
    })
    .join('');

  const axes = [
    `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="${CHART.ink2}" stroke-width="1"/>`,
    `<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="${CHART.ink2}" stroke-width="1"/>`,
    `<text x="${padL - 8}" y="${padT + 4}" text-anchor="end" class="cax">ms</text>`,
    `<text x="${padL + plotW / 2}" y="${height - 6}" text-anchor="middle" class="cax">offered load (req/s)</text>`,
  ].join('');

  const poly = points.map((p) => `${round(xOf(Number(p.label)))},${round(yOf(p.value))}`).join(' ');
  const line = `<polyline points="${poly}" fill="none" stroke="${CHART.teal}" stroke-width="2"/>`;
  const dots = points.map((p) => `<circle cx="${round(xOf(Number(p.label)))}" cy="${round(yOf(p.value))}" r="3" fill="${CHART.teal}"/>`).join('');
  return svg(width, height, yGrid + xGrid + axes + line + dots);
}

/** Round a coordinate to 2 decimals to keep the SVG compact and deterministic (no long float tails). */
function round(n: number): number {
  return Number(n.toFixed(2));
}

/** Wrap chart body in an <svg> with the shared chart CSS classes (defined once in the document <style>). The
 *  viewBox makes it scale responsively; `max-width` caps it so a wide chart scrolls, never overflows the page. */
function svg(width: number, height: number, body: string): string {
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="chart" role="img" preserveAspectRatio="xMinYMin meet">${body}</svg>`;
}

// ── the C4 container diagram (hand-rendered SVG from architecture data) ─────────────────────────────────────────

/**
 * Render the C4 container view as SVG from the architecture section: nodes as rounded rects at their canvas
 * positions (normalised + scaled to fit a fixed frame, aspect preserved), a label + type each; group rectangles
 * behind their members; edges as orthogonal-ish lines with an arrowhead and a protocol + rate pill; a small legend.
 * When no positions are supplied, auto-lay-out on a simple grid (deterministic order = the node order in the model).
 * EVERY string (labels, types, protocols, group labels) is escaped.
 */
function c4Diagram(arch: ArchitectureSection): string {
  const nodes = arch.nodes;
  if (nodes.length === 0) return '<p class="muted">No components to diagram.</p>';

  const NODE_H = 52;
  // The C4 nominal frame is a TALL portrait canvas (owner review 2026-07-03: the figure gets its OWN report page, so
  // WIDTH is capped at the A4 budget but HEIGHT is free). We start from a ~700×950 frame and let the layout GROW it
  // further when the collision pass or the min-edge-length rescale spread nodes apart. Width never exceeds the budget;
  // height is used generously so connections are long enough to carry their protocol·rate pills.
  const frameW = C4_FRAME_W;
  const frameH = C4_FRAME_H;
  const pad = 40;

  // Each node's rect width is LABEL-AWARE (2026-07-03 §2): derived from the longer of its label/type by character
  // count × a font factor (deterministic — no DOM measurement), so a long-named container gets a wider box instead of
  // overflowing a fixed rect. Computed once; threaded through layout, collision, groups and edges.
  const widthOf = (n: ArchNode): number => nodeWidth(n.label, n.type);

  // Position each node: use canvas positions when present; else a deterministic grid fallback (model order). The
  // layout returns the FRAME it actually needs — a collision pass + a min-edge-length rescale may have GROWN it past
  // the nominal frame so no two rects overlap and every attached edge is at least MIN_EDGE_LEN long (so its pill fits).
  const laid = layoutNodes(nodes, arch.edges, { frameW, frameH, pad, nodeH: NODE_H, widthOf });
  const positioned = laid.nodes;
  const posById = new Map(positioned.map((p) => [p.id, p]));
  const viewW = laid.frameW;
  const viewH = laid.frameH;

  // Group rectangles behind the members (drawn first). A group's box = the bounding box of its members + padding.
  const groupRects = arch.groups
    .map((g) => groupRect(g, posById, NODE_H))
    .filter((r): r is string => r !== undefined)
    .join('');

  // Edges: an orthogonal connector from source rect to target rect + an arrowhead (drawn first, under the pills). The
  // pills are laid out SEPARATELY (below) after a collision pass so they never sit on top of a node or each other.
  const edgeGeoms = arch.edges.map((e, i) => edgeGeom(e, i, posById, NODE_H)).filter((g): g is EdgeGeom => g !== undefined);
  const edgeLines = edgeGeoms.map((g) => g.line).join('');

  // Pills: deterministic width from the label, placed with ALTERNATING perpendicular offsets per edge index, then a
  // light collision pass pushes any pill off a node or another pill (owner review §3). Drawn ABOVE the node rects so a
  // pill pushed over a container is still legible, with a leader line back to its edge when it had to move.
  const nodeBoxes = positioned.map((p) => ({ x: p.x, y: p.y, w: p.w, h: NODE_H }));
  const pillSvg = layoutPills(edgeGeoms, nodeBoxes).map(pillSvgOf).join('');

  // Nodes between the edge lines and the pills: an edge never occludes a container, a pill never hides behind one.
  const nodeSvg = positioned
    .map((p) => {
      const label = esc(p.label);
      const type = esc(p.type);
      return [
        `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${NODE_H}" rx="8" fill="#e9f5f2" stroke="${CHART.teal}" stroke-width="1.5"/>`,
        `<text x="${round(p.x + p.w / 2)}" y="${p.y + 21}" text-anchor="middle" class="nn">${label}</text>`,
        `<text x="${round(p.x + p.w / 2)}" y="${p.y + 38}" text-anchor="middle" class="nt">${type}</text>`,
      ].join('');
    })
    .join('');

  // A small legend: sync vs async edge, and the rate-pill meaning. Pinned to the BOTTOM of the (possibly grown) frame.
  const legend = [
    `<line x1="${pad}" y1="${viewH - 14}" x2="${pad + 26}" y2="${viewH - 14}" stroke="${CHART.ink2}" stroke-width="1.6" marker-end="url(#arrow)"/>`,
    `<text x="${pad + 32}" y="${viewH - 10}" class="lg">sync</text>`,
    `<line x1="${pad + 84}" y1="${viewH - 14}" x2="${pad + 110}" y2="${viewH - 14}" stroke="${CHART.ink2}" stroke-width="1.6" stroke-dasharray="4 3" marker-end="url(#arrow)"/>`,
    `<text x="${pad + 116}" y="${viewH - 10}" class="lg">async</text>`,
  ].join('');

  const defs = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="${CHART.ink2}"/></marker></defs>`;
  return `<svg viewBox="0 0 ${viewW} ${viewH}" width="${viewW}" height="${viewH}" class="c4" role="img" preserveAspectRatio="xMinYMin meet">${defs}${groupRects}${edgeLines}${nodeSvg}${pillSvg}${legend}</svg>`;
}

/** The C4 nominal frame width = the shared A4 figure budget (2026-07-03 §1), so the diagram fills the page column. */
const C4_FRAME_W = A4_FIGURE_BUDGET;

/** The C4 nominal frame HEIGHT (owner review 2026-07-03): the diagram owns its OWN report page (`break-before` +
 *  `break-after`), so WIDTH is the A4 budget but HEIGHT is free — a tall portrait canvas lets connections be long
 *  enough to carry their pills. The layout GROWS this further as needed; it is only the starting/minimum height. */
const C4_FRAME_H = 950;

/** A C4 node rect's LABEL-AWARE width (2026-07-03 §2): sized to hold the LONGER of its label/type text plus side
 *  padding, so no glyph spills the box — measured DETERMINISTICALLY by character count × an average glyph width (no
 *  DOM, no canvas), clamped to a sane min/max so a one-letter node is not tiny and a pathological label cannot blow
 *  the frame. The label is 11px semibold, the type 11px; ~6.2px/char is a safe average for the Segoe UI stack. */
function nodeWidth(label: string, type: string): number {
  const CHAR_W = 6.2; // average glyph advance at the (now 11px) node font sizes (deterministic estimate; no measuring)
  const SIDE_PAD = 22; // 11px breathing room each side of the widest line
  const longest = Math.max(label.length, type.length);
  const ideal = SIDE_PAD + longest * CHAR_W;
  // Clamp: min 108 (owner review — a bit smaller now that spacing does the work), never absurdly wide.
  return round(Math.max(108, Math.min(320, ideal)));
}

interface Placed {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  /** This node's LABEL-AWARE rect width (2026-07-03 §2) — carried per-node so collision/groups/edges use the real box. */
  readonly w: number;
}

/** The result of laying out the C4 nodes: the placed rects PLUS the frame dimensions they need. The frame may be
 *  LARGER than the nominal input frame when the collision pass had to spread nodes apart (owner review R1: never
 *  shrink a node to fit — grow the viewBox instead), so `c4Diagram` sizes its viewBox from these, not the constants. */
interface Layout {
  readonly nodes: Placed[];
  readonly frameW: number;
  readonly frameH: number;
}

// The minimum gap between two node rects (owner review R1). Two containers the architect placed 10px apart on the
// canvas must not render as intersecting rects; after normalising, the collision pass pushes any pair closer than
// this apart. Chosen so a pill/edge still reads between adjacent containers.
const MIN_GAP = 22;

// The minimum LENGTH of any edge between the two attached node BORDERS (owner review 2026-07-03 §2). A connection
// shorter than this cannot visibly carry its protocol·rate pill, so when the normalised layout violates it ANYWHERE
// we scale the WHOLE layout up (vertically, and horizontally within the width budget) rather than compressing — the
// height is free (the figure owns its page), so lengthening every wire is the honest fix.
const MIN_EDGE_LEN = 90;

/** The layout frame parameters. `widthOf` gives each node its LABEL-AWARE rect width (2026-07-03 §2); there is no
 *  single `nodeW` any more — every rect carries its own `w`. */
interface Frame {
  readonly frameW: number;
  readonly frameH: number;
  readonly pad: number;
  readonly nodeH: number;
  readonly widthOf: (n: ArchNode) => number;
}

/** Place nodes: normalise the architect's canvas bounding box into the frame (aspect preserved), or a grid when no
 *  positions exist, run a deterministic collision pass so no two rects overlap (owner review R1), THEN scale the whole
 *  layout up until every attached edge is at least MIN_EDGE_LEN long (owner review §2), re-separating after the scale.
 *  Deterministic — the input order, positions and edges fully determine the output (and the frame the output needs). */
function layoutNodes(nodes: readonly ArchNode[], edges: readonly ArchEdge[], frame: Frame): Layout {
  const placed = placeInitial(nodes, frame);
  // R1 + §2: enforce a minimum pitch that ACCOUNTS FOR each rect's own (label-derived) width, so wide-labelled
  // neighbours never render intersecting. We push overlapping pairs apart (never shrink a node), which can move a
  // rect past the nominal frame — so we recompute the frame from the final extent below, GROWING the viewBox.
  separate(placed, frame.nodeH);
  // Owner review §2: if any attached edge is now shorter than MIN_EDGE_LEN, spread the whole layout apart (scale node
  // POSITIONS about the centroid — the boxes keep their size) so connections grow long enough to carry their pills.
  // Height is free; width scaling is capped so the layout never exceeds the budget. A final separation pass keeps the
  // rescaled (and any newly-close) rects apart.
  enforceMinEdgeLength(placed, edges, frame.nodeH);
  separate(placed, frame.nodeH);
  return withFrame(placed, frame);
}

/**
 * Scale node POSITIONS apart (about their centroid) until the shortest attached edge — measured border-to-border —
 * reaches MIN_EDGE_LEN (owner review §2: grow the canvas rather than compress connections). Deterministic and pure:
 * one uniform scale factor from the worst offending edge, so the same layout always yields the same spread. The box
 * SIZES are untouched (only their gaps grow); the vertical axis takes the full factor (height is free) while the
 * horizontal axis is capped so the widened layout still fits the width budget after the final re-anchor + separation.
 */
function enforceMinEdgeLength(placed: Placed[], edges: readonly ArchEdge[], nodeH: number): void {
  const n = placed.length;
  if (n < 2 || edges.length === 0) return;
  const byId = new Map(placed.map((p) => [p.id, p]));
  // The worst (smallest) attached-edge length across all edges with both endpoints placed.
  let shortest = Infinity;
  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    shortest = Math.min(shortest, edgeBorderLength(a, b, nodeH));
  }
  if (!Number.isFinite(shortest) || shortest <= 0 || shortest >= MIN_EDGE_LEN) return;
  // The centre-distance scale that lifts the shortest edge to the target. We scale CENTRES (not the border gap
  // directly), which is a slight over-spread — safe, since longer-than-minimum edges only help the pills. Capped so a
  // pathological near-coincident pair can't blow the frame to infinity.
  const factor = Math.min(4, MIN_EDGE_LEN / shortest);
  // Centroid of the box centres — scaling about it keeps the layout roughly in place (no big translation to undo).
  const cx = placed.reduce((s, p) => s + (p.x + p.w / 2), 0) / n;
  const cy = placed.reduce((s, p) => s + (p.y + nodeH / 2), 0) / n;
  // Horizontal factor is capped so the spread layout still fits the width budget once re-anchored; vertical takes the
  // full factor (the figure owns its page — height is free). withFrame() re-anchors and grows the frame after this.
  const spanX = Math.max(1e-9, Math.max(...placed.map((p) => p.x + p.w / 2)) - Math.min(...placed.map((p) => p.x + p.w / 2)));
  const maxHFactor = spanX > 0 ? Math.max(1, (C4_FRAME_W - 2 * 40 - Math.max(...placed.map((p) => p.w))) / spanX) : factor;
  const fx = Math.min(factor, maxHFactor);
  for (let i = 0; i < n; i++) {
    const p = placed[i] as Placed;
    const pcx = p.x + p.w / 2;
    const pcy = p.y + nodeH / 2;
    const nx = cx + (pcx - cx) * fx;
    const ny = cy + (pcy - cy) * factor;
    placed[i] = { ...p, x: round(nx - p.w / 2), y: round(ny - nodeH / 2) };
  }
}

/** The straight-line distance between the two node BORDERS along the centre-to-centre segment (the visible length of
 *  the connector's diagonal reach) — centre distance minus each rectangle's border intercept toward the other. */
function edgeBorderLength(a: Placed, b: Placed, nodeH: number): number {
  const acx = a.x + a.w / 2;
  const acy = a.y + nodeH / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + nodeH / 2;
  const [ax, ay] = borderPoint(a, nodeH, bcx, bcy);
  const [bx, by] = borderPoint(b, nodeH, acx, acy);
  return Math.hypot(bx - ax, by - ay);
}

/** The initial placement — normalise the architect's canvas box into the frame (aspect preserved), or a grid. Each
 *  placed rect carries its LABEL-AWARE width from `frame.widthOf`. */
function placeInitial(nodes: readonly ArchNode[], frame: Frame): Placed[] {
  // The widest node governs the horizontal budget (a top-left corner must leave room for the WIDEST rect + pad).
  const maxNodeW = Math.max(120, ...nodes.map((n) => frame.widthOf(n)));
  const withPos = nodes.filter((n) => n.x !== undefined && n.y !== undefined);
  const usePositions = withPos.length === nodes.length && nodes.length > 0;
  if (usePositions) {
    const xs = nodes.map((n) => n.x as number);
    const ys = nodes.map((n) => n.y as number);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = Math.max(1e-9, maxX - minX);
    const spanY = Math.max(1e-9, maxY - minY);
    // Inner area the node TOP-LEFT corners may occupy (leave room for the WIDEST node body + padding).
    const innerW = frame.frameW - 2 * frame.pad - maxNodeW;
    const innerH = frame.frameH - 2 * frame.pad - frame.nodeH - 20; // -20 leaves room for the legend row
    // Preserve aspect: one scale for both axes = the tighter fit, so the diagram mirrors the canvas proportions.
    const scale = Math.min(innerW / spanX, innerH / spanY);
    return nodes.map((n) => ({
      id: n.id,
      label: n.label,
      type: n.type,
      x: round(frame.pad + ((n.x as number) - minX) * scale),
      y: round(frame.pad + ((n.y as number) - minY) * scale),
      w: frame.widthOf(n),
    }));
  }
  // Grid fallback: deterministic columns, model order left→right, top→bottom. Column pitch = widest node + gutter,
  // so even a grid of long-labelled nodes never overlaps before the collision pass runs.
  const cols = Math.max(1, Math.floor((frame.frameW - 2 * frame.pad) / (maxNodeW + 40)));
  const gapX = maxNodeW + 40;
  const gapY = frame.nodeH + 44;
  return nodes.map((n, i) => ({
    id: n.id,
    label: n.label,
    type: n.type,
    x: frame.pad + (i % cols) * gapX,
    y: frame.pad + Math.floor(i / cols) * gapY,
    w: frame.widthOf(n),
  }));
}

/**
 * Deterministic collision resolution (owner review R1 + §2 label-aware): mutate `placed` in place so every pair of
 * node rects is separated by at least MIN_GAP, using EACH rect's own width (the half-width sum, not a single fixed
 * box). For each overlapping pair (in stable index order) we push the two rects apart along the axis of LEAST
 * penetration by half the shortfall each — the classic minimum-translation-vector separation. A bounded number of
 * relaxation passes converges for the small container counts a C4 view has; the loop is capped so it always
 * terminates. Pure w.r.t. the inputs (no clock/random), so the same model always yields the same layout.
 */
function separate(placed: Placed[], nodeH: number): void {
  const n = placed.length;
  if (n < 2) return;
  // Enough passes to untangle a dense cluster; each pass resolves the worst overlaps and later passes settle the
  // knock-on ones. Capped so a pathological input can never spin (determinism + termination over perfection).
  const PASSES = Math.min(60, 4 * n);
  for (let pass = 0; pass < PASSES; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = placed[i] as Placed;
        const b = placed[j] as Placed;
        // The min horizontal centre distance = the two half-widths + the gap (so LABEL-WIDE rects need more room).
        const minDX = (a.w + b.w) / 2 + MIN_GAP;
        const minDY = nodeH + MIN_GAP;
        const dx = a.x + a.w / 2 - (b.x + b.w / 2);
        const dy = a.y + nodeH / 2 - (b.y + nodeH / 2);
        const overlapX = minDX - Math.abs(dx);
        const overlapY = minDY - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue; // separated on at least one axis ⇒ no collision
        moved = true;
        // Push apart along the axis of LEAST penetration (smallest move that clears them), half each. A perfectly
        // coincident pair (dx=dy=0) is split horizontally by index order so the result stays deterministic.
        if (overlapX <= overlapY) {
          const push = overlapX / 2;
          const dir = dx === 0 ? (i < j ? 1 : -1) : Math.sign(dx);
          placed[i] = { ...a, x: round(a.x + dir * push) };
          placed[j] = { ...b, x: round(b.x - dir * push) };
        } else {
          const push = overlapY / 2;
          const dir = dy === 0 ? (i < j ? 1 : -1) : Math.sign(dy);
          placed[i] = { ...a, y: round(a.y + dir * push) };
          placed[j] = { ...b, y: round(b.y - dir * push) };
        }
      }
    }
    if (!moved) break; // a clean pass ⇒ converged
  }
}

/** Shift the placed rects back inside a padded origin and compute the frame they need (grown past the nominal frame
 *  when the collision pass spread them out). Uses each rect's own width. Keeps the legend row's clearance. */
function withFrame(placed: Placed[], frame: Frame): Layout {
  if (placed.length === 0) return { nodes: placed, frameW: frame.frameW, frameH: frame.frameH };
  const minX = Math.min(...placed.map((p) => p.x));
  const minY = Math.min(...placed.map((p) => p.y));
  // Re-anchor to the pad origin (separation may have pushed a rect to a negative coordinate), so nothing clips left/top.
  const shiftX = frame.pad - minX;
  const shiftY = frame.pad - minY;
  const nodes = placed.map((p) => ({ ...p, x: round(p.x + shiftX), y: round(p.y + shiftY) }));
  const maxX = Math.max(...nodes.map((p) => p.x + p.w));
  const maxY = Math.max(...nodes.map((p) => p.y + frame.nodeH));
  // Grow the frame GENEROUSLY to hold every (label-wide) rect + the right/bottom pad + the legend row; never below
  // the nominal size (§2: grow the frame rather than clip a wide label).
  const frameW = Math.max(frame.frameW, round(maxX + frame.pad));
  const frameH = Math.max(frame.frameH, round(maxY + frame.pad + 20));
  return { nodes, frameW, frameH };
}

/** The group rectangle behind a group's members (a tier / VPC / AZ boundary), with its label at the top-left. Uses
 *  each member's own (label-aware) width for the right edge. */
function groupRect(g: ArchGroup, pos: Map<string, Placed>, nodeH: number): string | undefined {
  const members = g.members.map((id) => pos.get(id)).filter((p): p is Placed => p !== undefined);
  if (members.length === 0) return undefined;
  const minX = Math.min(...members.map((m) => m.x)) - 12;
  const minY = Math.min(...members.map((m) => m.y)) - 24;
  const maxX = Math.max(...members.map((m) => m.x + m.w)) + 12;
  const maxY = Math.max(...members.map((m) => m.y + nodeH)) + 12;
  return [
    `<rect x="${round(minX)}" y="${round(minY)}" width="${round(maxX - minX)}" height="${round(maxY - minY)}" rx="10" fill="#faf8f3" stroke="${CHART.grid}" stroke-width="1.5" stroke-dasharray="5 4"/>`,
    `<text x="${round(minX + 10)}" y="${round(minY + 15)}" class="gl">${esc(g.label)}</text>`,
  ].join('');
}

/** The geometry of one drawn edge: its connector `line` SVG, plus (when the edge carries a label) the pill's anchor on
 *  the edge, the edge's direction, its border-to-border length, and the pill's deterministic box size. `c4Diagram`
 *  draws the lines first, then lays the pills out (offset + collision pass) so no pill sits on a node or another. */
interface EdgeGeom {
  readonly index: number;
  readonly line: string;
  /** Present only when the edge has a protocol/rate label. */
  readonly pill?: {
    readonly text: string;
    /** The pill anchor on the edge (the elbow midpoint). */
    readonly ax: number;
    readonly ay: number;
    /** The unit perpendicular to the edge direction, for the alternating offset + leader line. */
    readonly nx: number;
    readonly ny: number;
    /** Border-to-border edge length — an edge too short for its pill gets a leader line beside it (§3). */
    readonly len: number;
    /** Deterministic pill box size from the label char count (no text measurement). */
    readonly w: number;
    readonly h: number;
  };
}

/** One edge's connector line + (optionally) its pill geometry. An orthogonal "elbow" between the nearest rect edges
 *  with an arrowhead; async edges are dashed. The pill is NOT drawn here — its box is laid out later so it can dodge
 *  nodes and other pills (owner review §3). Returns undefined when an endpoint is missing. */
function edgeGeom(e: ArchEdge, index: number, pos: Map<string, Placed>, nodeH: number): EdgeGeom | undefined {
  const a = pos.get(e.from);
  const b = pos.get(e.to);
  if (!a || !b) return undefined;
  const acx = a.x + a.w / 2;
  const acy = a.y + nodeH / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + nodeH / 2;
  // Attach points on the rectangle borders (so lines touch edges, not centres).
  const [x1, y1] = borderPoint(a, nodeH, bcx, bcy);
  const [x2, y2] = borderPoint(b, nodeH, acx, acy);
  // Orthogonal elbow: horizontally to the midpoint X, then vertically, then into the target. Reads tidier than a
  // diagonal for a container diagram. Degenerate (near-aligned) edges collapse to a straight segment.
  const midX = round((x1 + x2) / 2);
  const path = `M ${round(x1)} ${round(y1)} L ${midX} ${round(y1)} L ${midX} ${round(y2)} L ${round(x2)} ${round(y2)}`;
  const dash = e.semantics === 'async' ? ' stroke-dasharray="4 3"' : '';
  const line = `<path d="${path}" fill="none" stroke="${CHART.ink2}" stroke-width="1.6"${dash} marker-end="url(#arrow)"/>`;

  const text = edgeLabel(e);
  if (text === undefined) return { index, line };
  // The pill anchors at the edge's border-to-border midpoint; its perpendicular (for the alternating offset) is normal
  // to the straight source→target direction (the elbow only affects the drawn line, not where the label reads best).
  const ax = round((x1 + x2) / 2);
  const ay = round((y1 + y2) / 2);
  const dirx = x2 - x1;
  const diry = y2 - y1;
  const dlen = Math.hypot(dirx, diry) || 1;
  // Perpendicular unit vector (rotate the direction 90°). A near-zero-length edge falls back to a vertical normal.
  const nx = dlen > 1e-6 ? -diry / dlen : 0;
  const ny = dlen > 1e-6 ? dirx / dlen : 1;
  const len = edgeBorderLength(a, b, nodeH);
  return { index, line, pill: { text, ax, ay, nx, ny, len, w: pillWidth(text), h: PILL_H } };
}

/** A pill box's deterministic width from its label's character count (owner review §3: no text measurement). The
 *  10px pill font averages ~5.8px/char; plus the rounded-end padding. Never wider than the width budget. */
function pillWidth(text: string): number {
  return round(Math.min(C4_FRAME_W - 8, 12 + text.length * 5.8));
}
/** The pill box height (fits the 10px pill font with vertical padding). */
const PILL_H = 18;

/** The edge pill's text (unescaped; the caller escapes): protocol and/or the computed rate as "N/s" or "N k/s". */
function edgeLabel(e: ArchEdge): string | undefined {
  const parts: string[] = [];
  if (e.protocol !== undefined) parts.push(e.protocol);
  if (e.rateRps !== undefined) parts.push(`${rateLabel(e.rateRps)}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** An axis-aligned box, for pill/node collision. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** A placed pill: its box + the edge anchor it belongs to (for the leader line when it moved off the edge). */
interface PlacedPill {
  readonly text: string;
  readonly box: Box;
  /** The edge anchor the pill labels — a leader line is drawn when the pill had to be DISPLACED by the collision pass
   *  (a genuinely too-short/crowded edge), not for the routine perpendicular offset every pill carries. */
  readonly ax: number;
  readonly ay: number;
  /** True when the collision pass pushed the pill ALONG the edge off its natural midpoint — draw a leader (§3). */
  readonly displaced: boolean;
}

/** Do two boxes overlap on BOTH axes (a shared edge is not an overlap)? Shared with the node-rect test's semantics. */
function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Place every edge pill (owner review §3): start each at its edge midpoint with an ALTERNATING perpendicular offset
 * (even edges to one side, odd to the other, so parallel wires don't stack their labels), then run a LIGHT collision
 * pass that pushes any pill off a node rect and off another pill — along the edge direction first, then perpendicular —
 * so no pill covers a container or another pill. Deterministic: fixed offsets, stable index order, a capped pass count.
 * An edge too short for its pill still gets one; the pass simply moves it beside the wire (a leader line is drawn when
 * the final box no longer covers the anchor). Pure w.r.t. inputs (no clock/random).
 */
function layoutPills(edges: readonly EdgeGeom[], nodes: readonly Box[]): PlacedPill[] {
  const pills: PlacedPill[] = [];
  const placedBoxes: Box[] = [];
  // The perpendicular offset that lifts a pill's CENTRE just clear of the edge line, so its box straddles the wire and
  // reads as attached (half the pill height + a hair). A pill placed here sits ON its edge — no leader line is needed.
  const BASE_OFFSET = PILL_H / 2 + 1;
  for (const e of edges) {
    if (!e.pill) continue;
    const p = e.pill;
    const side = e.index % 2 === 0 ? 1 : -1;
    const along = perpToDir(p.nx, p.ny); // the edge's unit direction (the normal rotated back 90°)
    const at = (dPerp: number, dAlong: number): Box => ({
      x: round(p.ax + p.nx * dPerp + along.x * dAlong - p.w / 2),
      y: round(p.ay + p.ny * dPerp + along.y * dAlong - p.h / 2),
      w: p.w,
      h: p.h,
    });
    const clear = (b: Box): boolean => !nodes.some((nb) => boxesOverlap(b, nb)) && !placedBoxes.some((pb) => boxesOverlap(b, pb));
    // CANDIDATE POSITIONS in priority order (owner review §3): first the on-wire straddle (alternating side); then
    // GROWING PERPENDICULAR lifts into the abundant vertical/normal space (the tall page has room off the wire); then
    // ALONG-edge walks both ways as a last resort for a genuinely short edge. The first collision-free candidate wins.
    // The straddle is the ONLY non-displaced position — any other counts as a moved pill and earns a leader line.
    const candidates: { box: Box; displaced: boolean }[] = [{ box: at(BASE_OFFSET * side, 0), displaced: false }];
    for (let k = 1; k <= 6; k++) {
      const lift = BASE_OFFSET + k * (p.h - 2); // stack pills one box-height apart, alternating up/down first-tried side
      candidates.push({ box: at(lift * side, 0), displaced: true });
      candidates.push({ box: at(-lift * side, 0), displaced: true });
    }
    for (let k = 1; k <= 6; k++) {
      const step = k * (p.w / 2 + 8);
      candidates.push({ box: at(BASE_OFFSET * side, step), displaced: true });
      candidates.push({ box: at(BASE_OFFSET * side, -step), displaced: true });
    }
    const chosen = candidates.find((c) => clear(c.box)) ?? candidates[0]!;
    placedBoxes.push(chosen.box);
    pills.push({ text: p.text, box: chosen.box, ax: p.ax, ay: p.ay, displaced: chosen.displaced });
  }
  return pills;
}

/** Rotate a unit normal 90° to recover the edge direction (used to push a colliding pill ALONG its wire). */
function perpToDir(nx: number, ny: number): { x: number; y: number } {
  return { x: ny, y: -nx };
}

/** One pill's SVG: a rounded white box + centred label, plus a 1px leader line back to the edge anchor when the pill
 *  had to move off it (owner review §3: a too-short edge gets its pill BESIDE it with a leader). Escaped text. */
function pillSvgOf(p: PlacedPill): string {
  const cx = round(p.box.x + p.box.w / 2);
  const cy = round(p.box.y + p.box.h / 2);
  // A leader is drawn ONLY when the pill was displaced by the collision pass (§3) — a faint 1px line from its centre
  // back to the edge anchor, so the reader can still tell which wire a moved pill labels.
  const leader = p.displaced
    ? `<line x1="${cx}" y1="${cy}" x2="${round(p.ax)}" y2="${round(p.ay)}" stroke="${CHART.grid}" stroke-width="1"/>`
    : '';
  return (
    leader +
    `<rect x="${round(p.box.x)}" y="${round(p.box.y)}" width="${round(p.box.w)}" height="${round(p.box.h)}" rx="9" fill="#fff" stroke="${CHART.grid}"/>` +
    `<text x="${cx}" y="${cy + 3}" text-anchor="middle" class="pill">${esc(p.text)}</text>`
  );
}

/** A req/s rate as a compact pill figure: `100k/s` above 10,000, else `N/s` with thousands separators. */
function rateLabel(rps: number): string {
  if (rps >= 10000) return `${num(Number((rps / 1000).toFixed(rps >= 100000 ? 0 : 1)))}k/s`;
  return `${num(rps)}/s`;
}

/** The point on a node's border on the segment toward (tx,ty) — so an edge line touches the rectangle edge. Uses the
 *  node's OWN (label-aware) width `n.w`; the height is uniform. */
function borderPoint(n: Placed, h: number, tx: number, ty: number): [number, number] {
  const cx = n.x + n.w / 2;
  const cy = n.y + h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  // Scale the direction to the rectangle border (the smaller of the x/y intercepts).
  const scaleX = dx === 0 ? Infinity : n.w / 2 / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : h / 2 / Math.abs(dy);
  const s = Math.min(scaleX, scaleY);
  return [cx + dx * s, cy + dy * s];
}

// ── provenance badges (doc §3) ─────────────────────────────────────────────────────────────────────────────────

// The CSS class + human label per provenance (the .prov badge family from the design docs: src/est/usr/def tones).
const PROV: Record<Provenance, { cls: string; label: string }> = {
  documented: { cls: 'src', label: 'documented' },
  estimate: { cls: 'est', label: 'estimate' },
  architect: { cls: 'usr', label: 'architect' },
  default: { cls: 'def', label: 'default' },
};

/** A provenance badge span. When `documented` with a valid http(s) source, the badge label links the source (the
 *  register's whole point). A non-http source degrades to a plain badge + escaped text (never a live unsafe link). */
function provBadge(p: Provenance, source?: string): string {
  const { cls, label } = PROV[p];
  const badge = `<span class="prov ${cls}">${label}</span>`;
  if (p === 'documented' && source !== undefined) {
    const href = safeHref(source);
    return href !== undefined ? `<a class="prov src" href="${href}" target="_blank" rel="noopener noreferrer">${label} ↗</a>` : `${badge} <span class="muted">${esc(source)}</span>`;
  }
  return badge;
}

// ── small HTML helpers ─────────────────────────────────────────────────────────────────────────────────────────

/** A table from a header row + body rows (each an array of ALREADY-rendered cell HTML). Header cells are escaped as
 *  they are static strings we control, but we escape anyway for uniformity. Body cells are passed through verbatim —
 *  callers are responsible for escaping their content (they do, via esc/valueUnit/provBadge). */
function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const thead = `<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>`;
  return `<div class="tw"><table>${thead}${tbody}</table></div>`;
}

/** A figure with an SVG (or arbitrary HTML) body + an escaped caption. An optional `cls` adds a modifier class (the C4
 *  diagram uses it to claim its OWN report page — a tall figure that must not share a page with prose). */
function figure(body: string, caption: string, cls?: string): string {
  const c = cls !== undefined ? ` ${cls}` : '';
  return `<figure class="fig${c}"><div class="svgc">${body}</div><figcaption>${esc(caption)}</figcaption></figure>`;
}

/** A section wrapper: an `<section>` (a print page-break boundary) with a numbered <h2>. The number comes from the
 *  section's position in `sectionOrder`, so it always matches the rendered order. */
function section(no: number, id: SectionKey, title: string, body: string): string {
  return `<section id="sec-${id}"><h2><span class="no">${no}</span>${esc(title)}</h2>${body}</section>`;
}

const STATUS_LABEL: Record<RequirementRow['status'], string> = {
  ok: '✓ met',
  warning: '⚠ warning',
  violation: '✗ violated',
  unknown: '? unknown',
  'did-not-converge': '? did-not-converge',
  unstated: '—',
};
const statusCls = (s: RequirementRow['status']): string =>
  s === 'ok' ? 'st-ok' : s === 'violation' ? 'st-bad' : s === 'warning' ? 'st-warn' : 'st-muted';

// ── section renderers (each reads ONLY its slice of the model; absent optional data ⇒ nothing) ───────────────────

function renderSummary(s: SummarySection): string {
  const load = s.offeredRps !== undefined ? `${num(s.offeredRps)} req/s` : 'an unstated load';
  const cost = s.headlineCostUsdMonth !== undefined ? ` at about <b>${money(s.headlineCostUsdMonth)}/month</b>` : '';
  const slo =
    s.slosDeclared === 0
      ? 'No SLOs are declared yet, so the promises below report the computed picture without a pass/fail judgment.'
      : s.meetsAllSlos
        ? `It meets all <b>${num(s.slosDeclared)}</b> declared promise(s).`
        : `It does <b>not</b> meet all <b>${num(s.slosDeclared)}</b> declared promise(s) — see Risks below.`;
  const lead =
    `<p class="lead"><b>${esc(s.name)}</b> is a ${num(s.componentCount)}-component design carrying ${num(s.flowCount)} ` +
    `request flow(s) at ${load}${cost}. ${slo}</p>`;
  // THE one honest scope sentence (§6 owner ruling) — verbatim, every surface. Never an empty template section.
  const scope = `<div class="callout scope"><b>Scope.</b> ${esc(s.scope)}</div>`;
  return lead + scope;
}

function renderRequirements(rows: readonly RequirementRow[]): string {
  if (rows.length === 0) return `<p class="muted">No SLOs declared. The capacity and reliability sections below still report the computed picture.</p>`;
  const body = rows.map((r) => {
    const unit = r.computedUnit ?? '';
    const computed = r.computedValue !== undefined ? valueUnit(r.computedValue, unit || bandUnitHint(r)) : '—';
    // SCOPE HONESTY (F4, extended by the SYSTEM scope — owner ruling: cost is for THE WHOLE SYSTEM): an
    // availability promise is NODE-scoped — say so; a SYSTEM promise is judged against the whole-graph total
    // (every component summed, off-path branches included) — say that too, and name the component cell
    // "whole system" (it belongs to no node).
    const isAvail = r.key === 'availability';
    const isSystem = r.scope === 'system';
    const metric = isSystem
      ? `${esc(keyDisplay(r.key))} <span class="muted">· system-scoped</span>`
      : isAvail
        ? `${esc(keyDisplay(r.key))} <span class="muted">· node-scoped</span>`
        : esc(keyDisplay(r.key));
    const computedCell = isAvail ? computed + endToEndAvailabilityHtml(r) : computed;
    return [
      isSystem ? '<i>whole system</i>' : esc(r.node),
      metric,
      bandRequirement(r.band, bandUnitHint(r)),
      computedCell,
      `<span class="${statusCls(r.status)}">${STATUS_LABEL[r.status]}</span>`,
    ];
  });
  return table(['Component', 'Metric', 'Promise', 'Computed', 'Status'], body);
}

/** The end-to-end availability contrast for a node-scoped availability requirement (F4): beneath the node-local
 *  figure, each crossing flow's honest cumulative — tinted red when it falls short of the node's own promise, so the
 *  "≥ 99.9% ✓ 99.99%" green can never hide a 99.58% path. Empty (the node is every crossing flow's terminal) ⇒ ''. */
function endToEndAvailabilityHtml(r: RequirementRow): string {
  const e2e = r.endToEndAvailability ?? [];
  if (e2e.length === 0) return '';
  const lines = e2e.map(
    (e) => `<span class="${e.belowPromise ? 'st-bad' : 'muted'}">end-to-end ${pct(e.availability)}${e.belowPromise ? ' ✗' : ''} <span class="muted">via ${esc(e.source)} → ${esc(e.terminal)}</span></span>`,
  );
  return `<br>${lines.join('<br>')}`;
}

/** The unit hint for a requirement's band rendering (ratio keys ⇒ percentages). Availability/durability are ratios. */
function bandUnitHint(r: RequirementRow): string {
  if (r.computedUnit) return r.computedUnit;
  return r.key === 'availability' || r.key === 'durability' ? 'ratio' : '';
}

/** A human-ish metric name from a registry key id (the model carries raw key ids). Title-cases unknown keys. */
function keyDisplay(k: string): string {
  const known: Record<string, string> = {
    throughput: 'Throughput',
    latency: 'Latency',
    tailLatency: 'Tail latency (p99)',
    availability: 'Availability',
    durability: 'Durability',
    cost: 'Cost',
  };
  return known[k] ?? k.charAt(0).toUpperCase() + k.slice(1);
}

// ── §scenarios — the world-comparison table (assumption-model doc §8, "the budget-defence slide") ────────────────

/** One override cell in a world row: "origin.throughput = 1,200 req/s" with the derived/frozen badge (§5.3). A time
 *  value rounds to whole ms via `valueUnit`; a ratio reads as a percentage. Every model string is escaped. */
function scenarioOverrideHtml(o: ScenarioOverrideCell): string {
  const badge =
    o.provenance === 'derived'
      ? ' <span class="prov est">derived</span>'
      : o.provenance === 'architect'
        ? ' <span class="prov usr">frozen</span>'
        : '';
  return `${esc(o.node)}.${esc(o.key)} = ${valueUnit(o.value, o.unit)}${badge}`;
}

/** The provenance MIX of a world's overrides (doc §8): "3 derived · 1 frozen", so a reader sees at a glance how many
 *  values still await a measurement. Base (no overrides) reads "—". */
function provenanceMix(w: ScenarioWorldRow): string {
  const parts: string[] = [];
  if (w.derivedCount > 0) parts.push(`${num(w.derivedCount)} <span class="prov est">derived</span>`);
  if (w.architectCount > 0) parts.push(`${num(w.architectCount)} <span class="prov usr">frozen</span>`);
  const plain = w.overrides.length - w.derivedCount - w.architectCount;
  if (plain > 0) parts.push(`${num(plain)} manual`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/** The scenario-comparison section: the base world + every named world side by side (cost · worst-tier ρ · verdict ·
 *  the fact-assumption deltas + their provenance) plus a per-world cost bar — the budget-defence table SDA now
 *  authors. Reads ONLY the model's ScenariosSection; formats, computes nothing. */
function renderScenarios(s: ScenariosSection): string {
  const rows = s.worlds.map((w) => {
    const overrides =
      w.overrides.length > 0
        ? w.overrides.map(scenarioOverrideHtml).join('<br>')
        : `<span class="muted">${w.isBase ? 'as authored' : 'no overrides'}</span>`;
    const stale = w.staleOverrides.length > 0 ? `<br><span class="muted">stale skipped: ${esc(w.staleOverrides.join(', '))}</span>` : '';
    const rho =
      w.peakRho !== undefined
        ? `<span class="${w.peakRho > 0.9 ? 'st-bad' : w.peakRho >= 0.7 ? 'st-warn' : 'st-ok'}">${num(w.peakRho)}</span>`
        : '—';
    const verdict = w.feasible
      ? '<span class="st-ok">✓ ok</span>'
      : `<span class="st-bad">✗ ${num(w.violations)} violation${w.violations === 1 ? '' : 's'}</span>` +
        (w.brokenSlos.length > 0 ? ` <span class="muted">(${esc(w.brokenSlos.join(', '))})</span>` : '');
    return [`<b>${esc(w.name)}</b>`, overrides + stale, w.isBase ? '—' : provenanceMix(w), `${money(w.costUsdMonth)}/mo`, rho, verdict];
  });
  const intro =
    `<p>Each declared world is the SAME design under a different set of fact-assumption beliefs (offered load, ` +
    `service times), evaluated side by side — so a reviewer sees how cost and the SLO verdicts move between a ` +
    `quiet-launch, a steady-state and a stress world. Values badged <span class="prov est">derived</span> are ` +
    `placeholders sized from this design's own capacity envelope; replace them with measurements as they arrive.</p>`;
  const worldTable = table(['World', 'Overrides (fact-assumptions)', 'Provenance', 'Cost', 'Peak ρ', 'Verdict'], rows);
  const chart = s.costSeries.points.length > 0 ? figure(costChart(s.costSeries), 'Monthly cost by world — the budget-defence view: what each world would cost, side by side.') : '';
  return intro + worldTable + chart;
}

function renderAssumptions(rows: readonly AssumptionRow[]): string {
  if (rows.length === 0) return `<p class="muted">The design rests on no non-default parameters — an empty register is an honest register.</p>`;
  const body = rows.map((r) => {
    const level = r.transformLevel ? ` <span class="muted">(${esc(r.transformLevel)}-level)</span>` : '';
    return [
      `${esc(r.label)}${level}`,
      assumptionValue(r),
      provBadge(r.provenance, r.source),
      esc(r.where),
    ];
  });
  return `<p>Every number the computation rests on, one row each, with where it came from. The register lists what IS; it never pads.</p>${table(['Assumption', 'Value', 'Provenance', 'Where'], body)}`;
}

/** The register's value cell. A FLOW-TRANSFORM row (identified by `transformLevel`) carries the transform's `kind`
 *  in `unit` and its parameter in `value` — render it as the transform verb ("×100", "1:100"), NOT as a percentage
 *  (a ×100 fan-out is a multiplier, not a 10,000% ratio). Every other row renders `value + unit`. */
function assumptionValue(r: AssumptionRow): string {
  // A categorical assumption (a guarantee contribution — "ordering: none") shows its token verbatim; a token is
  // not a quantity, so `display` wins over the numeric value+unit formatting.
  if (r.display !== undefined) return esc(r.display);
  if (r.transformLevel !== undefined && isTransformKind(r.unit)) {
    return esc(transformVerb({ kind: r.unit, value: r.value } as Transform));
  }
  return valueUnit(r.value, r.unit);
}

/** Whether a register row's `unit` is actually a transform kind (a transform row stores `unit = t.kind`). */
function isTransformKind(unit: string): unit is Transform['kind'] {
  return unit === 'ratio' || unit === 'batch' || unit === 'cap' || unit === 'window' || unit === 'prob';
}

function renderArchitecture(arch: ArchitectureSection): string {
  // One plain-English sentence under the heading (owner review R3) — the outsider reader must not mistake a C4
  // "container" for a  container. Static copy, escaped for uniformity.
  const explain =
    `<p class="muted">${esc('C4 is Simon Brown’s standard notation for describing software architecture at ')}` +
    `${esc('four zoom levels; this is the container level. A container = a separately runnable unit — an application, ')}` +
    `${esc('a database — a separately deployable unit.')}</p>`;
  // The C4 figure claims its OWN report page (owner review 2026-07-03 §1: `c4page` = break-before + break-after in
  // print) with a tall canvas, so the (now long) connections and their pills have room and never share a page with
  // prose. On screen it simply renders as a tall figure centred in the column.
  const diagram = figure(
    c4Diagram(arch),
    'C4 container view, generated from the canvas layout: each component a container, protocols and post-transform rates label the wires, dashed edges are asynchronous.',
    'c4page',
  );
  return explain + diagram;
}

function renderCapacity(cap: CapacitySection): string {
  const parts: string[] = [];

  // Per-tier capacity table: offered / capacity / utilisation ρ / saturation.
  if (cap.tiers.length > 0) {
    const rows = cap.tiers.map((t) => [
      esc(t.node),
      t.offeredRps !== undefined ? `${num(t.offeredRps)} req/s` : '—',
      t.capacityRps !== undefined ? `${num(t.capacityRps)} req/s` : '—',
      t.utilization !== undefined ? `<span class="${t.utilization > 0.9 ? 'st-bad' : t.utilization >= 0.7 ? 'st-warn' : 'st-ok'}">${num(t.utilization)}</span>` : '—',
      t.saturated ? '<span class="st-bad">saturated (ρ ≥ 1)</span>' : '<span class="st-ok">has headroom</span>',
    ]);
    parts.push(table(['Tier', 'Offered', 'Capacity', 'Utilisation ρ', 'State'], rows));
  }

  // Utilisation-bar chart (traffic-light tones), with the ρ = 1 saturation reference line.
  if (cap.utilizationSeries.points.length > 0) {
    parts.push(
      figure(
        barChart(cap.utilizationSeries, { tone: utilTone, fmt: (v) => num(v), max: Math.max(1, ...cap.utilizationSeries.points.map((p) => p.value)), refLine: 1 }),
        'Utilisation (ρ = offered ÷ capacity) per tier. Teal < 0.7, amber 0.7–0.9, red > 0.9; the dashed line is ρ = 1, where a tier saturates and its queue grows without bound.',
      ),
    );
  }

  // Latency-budget waterfall.
  if (cap.latencyWaterfall.points.length > 0) {
    parts.push(figure(waterfallChart(cap.latencyWaterfall), 'Latency budget: each tier’s own service latency along the busiest flow, stacked to the end-to-end total.'));
  }

  // Flow rows: end-to-end throughput / MEASURED latency / availability / cost.
  if (cap.flows.length > 0) {
    const rows = cap.flows.map((f) => [
      `${esc(f.source)} → ${esc(f.terminal)}`,
      f.throughputRps !== undefined ? `${num(f.throughputRps)} req/s` : '—',
      latencyCell(f.measuredLatencyMs),
      f.availability !== undefined ? pct(f.availability) : '—',
      f.costUsdMonth !== undefined ? `${money(f.costUsdMonth)}/mo` : '—',
    ]);
    parts.push(`<h3>End-to-end per flow</h3><p class="muted">Latency is measured by the discrete-event simulation (seed 7); a flow whose terminal the simulation never timed reads no data (never an estimate).</p>${table(['Flow', 'Throughput', 'Latency', 'Availability', 'Branch cost'], rows)}`);
  }

  // Per-node SIMULATED response PERCENTILES (doc: latency-semantics-v2 §4): the request→response tail (p50/p95/p99) a
  // caller of each REQUIREMENT-BEARING node actually feels — the distribution the per-tier response mean cannot show.
  // Present ONLY when a sim ran and the design has a latency/tailLatency SLO (no-filler); a node with no recorded
  // response reads "no data" (honest, never a fabricated number).
  if (cap.responsePercentiles && cap.responsePercentiles.length > 0) {
    const respCell = (v: number): string => (Number.isFinite(v) ? formatMs(v) : '<span class="muted">no data</span>');
    const rows = cap.responsePercentiles.map((r) => [esc(r.node), respCell(r.mean), respCell(r.p50), respCell(r.p95), respCell(r.p99), num(r.samples)]);
    parts.push(
      `<h3>Response-time percentiles per promise-bearing node — simulated</h3>` +
        `<p class="muted">Each node's OWN request→response tail from the discrete-event simulation (async calls are cut — it is what a caller of that service waits for). The mean can look fine while p99 is on fire; this shows the tail. Samples back the percentiles.</p>` +
        table(['Node', 'Mean', 'p50', 'p95', 'p99', 'Samples'], rows),
    );
  }

  // PROPAGATION LAG (doc: latency-semantics-v2 §3): the async-INCLUSIVE end-to-end view beside the flow table —
  // each declared source→terminal deadline and its verdict. Unlike the caller-facing latency above, this COUNTS the
  // async queue waits (a CDC/replication SLO). Present only when the design declares a lag SLO (no-filler).
  if (cap.lag && cap.lag.length > 0) {
    const rows = cap.lag.map((r) => [
      `${esc(r.source)} → ${esc(r.terminal)}`,
      `≤ ${formatMs(r.maxMs)}`,
      r.measuredMeanMs !== undefined
        ? `${formatMs(r.measuredMeanMs)} <span class="muted">(measured)</span>`
        : Number.isFinite(r.lowerBoundMs ?? NaN)
          ? `≥ ${formatMs(r.lowerBoundMs as number)} <span class="muted">(lower bound)</span>`
          : '—',
      lagStatusHtml(r.status),
    ]);
    parts.push(
      `<h3>Propagation lag — flow-scoped</h3>` +
        `<p class="muted">The async-inclusive journey time from a source to a terminal, queue waits COUNTED (unlike the caller-facing latency above). A simulation measures the true mean; without one the scalar can only prove a violation, otherwise it reports unknown.</p>` +
        table(['Flow', 'Deadline', 'Measured / bound', 'Status'], rows),
    );
  }

  // Active flow transforms (a port not relaying 1:1 — the real downstream pressure). PROPAGATION (owner review R2):
  // every transformed edge shows the rate ENTERING the transform, the transform, and the rate LEAVING it, so the
  // reader can trace load hop by hop instead of guessing the downstream pressure. Section language stays plain.
  if (cap.transforms.length > 0) {
    const rows = cap.transforms.map((t) => [
      `${esc(t.from)} → ${esc(t.to)}`,
      t.enteringRps !== undefined ? `${num(t.enteringRps)} req/s` : '—',
      t.side === 'out' ? `emits ${esc(transformVerb(t.transform))}` : `intakes ${esc(transformVerb(t.transform))}`,
      t.resultingRps !== undefined ? `${num(t.resultingRps)} req/s` : '—',
    ]);
    parts.push(
      `<h3>Flow transforms — how the request rate changes hop by hop</h3>` +
        `<p class="muted">A wire that does not carry traffic one-for-one. Read each row left to right: the rate arriving, what the port does to it, and the rate leaving.</p>` +
        table(['Wire', 'Rate entering', 'Transform', 'Rate leaving'], rows) +
        propagationChart(cap.transforms),
    );
  }

  // The OPTIONAL load→latency sweep — renders NOTHING when the caller supplied no sweep (§6 no padding).
  if (cap.loadSweep && cap.loadSweep.points.length > 0) {
    parts.push(figure(sweepChart(cap.loadSweep), 'End-to-end latency as offered load rises — the knee is where queueing latency starts to dominate.'));
  }

  return parts.join('');
}

/** A flow-scoped lag verdict status as a tinted pill — the same tones the tier state uses (a violation is red, an
 *  `ok` teal; `unknown` is muted, honest about the queue wait the scalar cannot see). */
function lagStatusHtml(s: LagReqRow['status']): string {
  if (s === 'violation') return '<span class="st-bad">✗ violation</span>';
  if (s === 'ok') return '<span class="st-ok">✓ ok</span>';
  if (s === 'warning') return '<span class="st-warn">⚠ warning</span>';
  return '<span class="muted">? unknown (run the simulation)</span>';
}

/** The capacity/flow latency cell under the SINGLE-TRUTH MEASURED-OR-NOTHING policy (owner ruling): the discrete-event
 *  simulation's measurement (seed 7). Absent (the run never timed this flow's terminal) ⇒ `no data` — never an analytic
 *  scalar (the queue-model latency is computed but shown on no surface). */
function latencyCell(measuredMs: number | undefined): string {
  if (measuredMs === undefined || !Number.isFinite(measuredMs)) return '<span class="muted">no data</span>';
  return formatMs(measuredMs);
}

function renderSimulation(sim: SimulationSection): string {
  const parts: string[] = [];
  if (sim.tail) {
    parts.push(
      `<p>Tail latency from the discrete-event simulation of the busiest flow — the number a reviewer judges by, not the mean:</p>` +
        `<p class="tail">p50 <b>${formatMs(sim.tail.p50)}</b> · p95 <b>${formatMs(sim.tail.p95)}</b> · p99 <b>${formatMs(sim.tail.p99)}</b></p>`,
    );
  }
  // The retry story renders ONLY when the model carries one (a declared policy AND a measured outcome). No policy ⇒
  // nothing here (§6): goodput/errors/amplification are vacuous without a policy, so we never invent them.
  if (sim.retry) {
    const r = sim.retry;
    const callers = r.callers.map((c) => `<b>${esc(c.node)}</b> (timeout ${formatMs(c.timeoutMs)}, ${num(c.retryCount)} retr${c.retryCount === 1 ? 'y' : 'ies'})`).join(', ');
    const offered = r.offeredRps !== undefined ? ` of ~${num(r.offeredRps)} req/s offered` : '';
    const honest =
      r.errorRate > 0 || r.amplification > 1
        ? 'Past saturation these retries are new load on an already-busy tier — they lower goodput, they never raise it. Add capacity at the bottleneck or shed load.'
        : 'The system is below saturation: retries are not yet firing.';
    parts.push(
      `<div class="callout warn"><b>Retry policy.</b> ${callers} retry on timeout.` +
        ` Simulated goodput: <b>${num(r.goodputRps)} req/s succeed</b>${offered}, <b>${num(r.errorRate)} req/s fail</b> after retries, attempts ×${num(r.amplification)} the arrivals. ${honest}</div>`,
    );
  }
  if (parts.length === 0) return `<p class="muted">No simulation results were supplied for this design.</p>`;
  return parts.join('');
}

function renderReliability(rel: ReliabilitySection): string {
  if (rel.flows.length === 0) return `<p class="muted">No availability could be computed for any flow.</p>`;
  const rows = rel.flows.map((f) => {
    const tier = f.tier ? `${pct(f.tier.availability)} tier <span class="muted">(≤ ${esc(f.tier.maxDowntimePerYear)}/yr; ${esc(f.tier.applicationCategories)})</span>` : '<span class="muted">below the 99% tier</span>';
    const weakest = f.weakestDependency ? `${esc(f.weakestDependency.node)} (${pct(f.weakestDependency.availability)})` : '—';
    const target = f.targetAvailability !== undefined ? `${pct(f.targetAvailability)} <span class="${f.meetsTarget ? 'st-ok' : 'st-bad'}">${f.meetsTarget ? '✓' : '✗'}</span>` : '—';
    return [`${esc(f.source)} → ${esc(f.terminal)}`, pct(f.availability), tier, weakest, target];
  });
  const src = safeHref(rel.source);
  const sourceLine = src !== undefined
    ? `<p class="muted">Source: AWS Well-Architected Reliability Pillar — Availability (<a href="${src}" target="_blank" rel="noopener noreferrer">${esc(rel.source)}</a>).</p>`
    : `<p class="muted">Source: AWS Well-Architected Reliability Pillar — Availability (${esc(rel.source)}).</p>`;
  return table(['Flow', 'Availability', 'Meets tier', 'Weakest dependency', 'Target'], rows) + sourceLine;
}

function renderGuarantees(g: GuaranteesSection): string {
  if (g.rows.length === 0) return `<p class="muted">No qualitative guarantee promises are declared.</p>`;
  const guaranteeStatus: Record<GuaranteeReqRow['status'], string> = {
    ok: '✓ met',
    warning: '⚠ warning',
    violation: '✗ violated',
    unknown: '? unknown',
    'did-not-converge': '? unknown',
  };
  const rows = g.rows.map((r) => {
    // The computed token, badged against the requirement; the root cause + the computed fix (or the honest reason
    // none exists). Every cell is DATA the model carried — the renderer formats, computes nothing.
    const computed = `<span class="${statusCls(r.status)}">${esc(r.computed)}</span>`;
    const status = `<span class="${statusCls(r.status)}">${esc(guaranteeStatus[r.status])}</span>`;
    const cause = r.rootCauseNode !== null ? esc(r.rootCauseNode) : '—';
    const fix = r.remediation !== undefined ? esc(r.remediation) : r.noRemediationReason !== undefined ? `<span class="muted">${esc(r.noRemediationReason)}</span>` : '—';
    return [`${esc(r.source)} → ${esc(r.terminal)}`, esc(r.dimension), `≥ ${esc(r.required)}`, computed, status, cause, fix];
  });
  const intro =
    `<p>Qualitative promises each request flow makes about its data — read freshness (consistency), message order (ordering) ` +
    `and delivery — as computed verdicts. A guarantee only ever DEGRADES along a path, so the first hop that drops below the ` +
    `promise is the provable root cause; the fix is the cheapest same-family component swap whose documented labels restore it.</p>`;
  return intro + table(['Flow', 'Dimension', 'Required', 'Computed', 'Status', 'Root cause', 'Remediation'], rows);
}

function renderCost(cost: CostSection): string {
  const b = cost.breakdown;
  const rows = [
    ['Compute / storage / managed', money(b.computeUsdMonth)],
    ['Data transfer (egress)', money(b.egressUsdMonth)],
    ['<b>Total (on-demand)</b>', `<b>${money(b.totalUsdMonth)}</b>`],
    [`With 1-yr commitment`, `${money(b.committed1yrUsdMonth)} <span class="muted">(−${money(b.totalUsdMonth - b.committed1yrUsdMonth)})</span>`],
    [`With 3-yr commitment`, `${money(b.committed3yrUsdMonth)} <span class="muted">(−${money(b.totalUsdMonth - b.committed3yrUsdMonth)})</span>`],
  ];
  const totals = table(['Line', 'Monthly'], rows);
  const chart =
    cost.perComponentSeries.points.length > 0
      ? figure(costChart(cost.perComponentSeries), 'Monthly cost by component (own compute/storage), largest first.')
      : '';
  return totals + costDerivations(cost.derivations) + chart;
}

/** The per-component cost DERIVATIONS table (2026-07-03 §3): each priced component's arithmetic shown inline, so the
 *  reader sees HOW a figure was reached, not just the number. The DocModel carries the operands (driver, unit price,
 *  deployment factor) as DATA; this only formats them. Empty ⇒ nothing (no padding). */
function costDerivations(derivations: readonly CostDerivation[]): string {
  if (derivations.length === 0) return '';
  const rows = derivations.map((d) => [esc(d.node), costModelLabel(d.model), costArithmetic(d)]);
  return (
    `<h3>How each component's cost is derived</h3>` +
    `<p class="muted">Every priced tier bills by one model: a fixed monthly price, a provisioned capacity, a per-unit count, or pay-per-use on the offered load. The arithmetic is shown so the figure is auditable, not asserted.</p>` +
    table(['Component', 'Model', 'Derivation'], rows)
  );
}

/** A human name for the cost model (behaviors.ts THE COST MODEL), for the derivation table's "Model" column. */
function costModelLabel(model: CostDerivation['model']): string {
  switch (model) {
    case 'flat':
      return 'fixed';
    case 'provisioned':
      return 'provisioned';
    case 'pay-per-use':
      return 'pay-per-use';
    case 'per-unit':
      return 'per-unit';
  }
}

/**
 * The inline arithmetic for one cost row, e.g. "2,000 req/s × $2/(req/s)·mo = $4,000/mo" (pay-per-use / provisioned /
 * per-unit) or "$50/mo (fixed)" (flat). A Multi-AZ / multi-region surcharge appends "× 2 (Multi-AZ)" between the base
 * product and the total, mirroring `withDeploymentCost`. All operands come from the DocModel; the equals-side is the
 * engine's own cost value, so the shown product and the printed total always agree. The unit-price label is the
 * catalog's own rate string (e.g. "USD/(req/s)·month"), compacted to "$…/(req/s)·mo" for the reader.
 */
function costArithmetic(d: CostDerivation): string {
  const price = `${unitPriceMoney(d.unitPrice)} <span class="muted">${esc(compactRateUnit(d.unitPriceUnit))}</span>`;
  const surcharge = d.deploymentFactor !== undefined && d.deploymentLabel !== undefined
    ? ` × ${num(d.deploymentFactor)} <span class="muted">(${esc(d.deploymentLabel)})</span>`
    : '';
  const total = `<b>${money(d.totalUsdMonth)}/mo</b>`;
  // `flat` has no driver — the base price IS the figure (a deployment surcharge may still multiply it).
  if (d.model === 'flat' || d.driverValue === undefined) {
    return surcharge !== '' ? `${price}${surcharge} = ${total}` : `${total} <span class="muted">(fixed)</span>`;
  }
  const driver = `${num(d.driverValue)} ${esc(d.driverUnit ?? '')}`.trim();
  return `${driver} × ${price}${surcharge} = ${total}`;
}

/** A UNIT PRICE as money — like `money` but keeping SUB-CENT precision (a per-req/s rate is often $0.005). The
 *  standard 2-decimal `num` would round $0.005 to $0.01, misrepresenting the rate; here we keep up to 4 significant
 *  decimals, trailing zeros stripped, so "$0.005" and "$0.1" both read true. Used ONLY for the derivation's rate. */
function unitPriceMoney(n: number): string {
  if (!Number.isFinite(n)) return money(n);
  if (Number.isInteger(n)) return `$${num(n)}`;
  // Up to 4 decimals is enough for the catalog's finest rate ($0.005); strip trailing zeros for a clean read.
  const s = Number(n.toFixed(4)).toString();
  return `$${s}`;
}

/** Compact the catalog's verbose USD rate string for inline display, dropping the leading "USD" (the price token
 *  right before it already shows the "$"): "USD/(req/s)·month" → "/(req/s)·mo", "USD/conc·month" → "/conc·mo". So the
 *  cell reads "$2 /(req/s)·mo", not a doubled "$2 $/(req/s)·mo". Purely cosmetic (the exact rate is in the register). */
function compactRateUnit(unit: string): string {
  return unit.replace(/^USD/, '').replace(/month\b/, 'mo').replace(/\bmonth$/, 'mo');
}

// Alternatives is optional in the model (undefined when the caller opted out). This renderer is only CALLED when the
// section is present — the walk in renderHtml gates it — so it never emits a placeholder for an absent section.
function renderAlternatives(alts: NonNullable<DocModel['alternatives']>): string {
  return alts.sets
    .map((set) => {
      const rows = set.options.map((o) => [
        esc(o.label),
        esc(o.type),
        o.costUsdMonth !== undefined ? `${money(o.costUsdMonth)}/mo` : '—',
        o.costDeltaUsdMonth !== undefined ? `${o.costDeltaUsdMonth < 0 ? '−' : '+'}${money(Math.abs(o.costDeltaUsdMonth))}/mo` : '—',
        o.meetsSlos === undefined ? '—' : o.meetsSlos ? '<span class="st-ok">✓ meets SLOs</span>' : '<span class="st-bad">✗ misses an SLO</span>',
        o.note !== undefined ? esc(o.note) : '—',
      ]);
      // THE HONESTY RULE (owner review R4): if the ranking above holds an option that BOTH meets every SLO AND is
      // cheaper than the current choice (a negative cost delta), the doc must say so out loud — a staff architect
      // does not leave a strictly-better option on the table silently. Only fires when such an option is present.
      const dominatesCurrent = set.options.some((o) => o.meetsSlos === true && o.costDeltaUsdMonth !== undefined && o.costDeltaUsdMonth < 0);
      const honesty = dominatesCurrent
        ? `<p class="callout warn"><b>Cheaper option available.</b> The ranking above contains an option that meets the promises at lower cost — adopt it or record the reason for staying.</p>`
        : '';
      return `<h3>Alternatives for ${esc(set.node)}</h3><p class="muted">Method: ${esc(set.method)}.</p>${table(['Option', 'Type', 'Cost', 'Δ vs current', 'Meets SLOs', 'Trade-off'], rows)}${honesty}`;
    })
    .join('');
}

function renderRisks(risks: RisksSection): string {
  if (risks.items.length === 0) return `<p class="muted">No violations, warnings or unknowns — every checked property is within band and computed.</p>`;
  const sevCls: Record<RisksSection['items'][number]['severity'], string> = { violation: 'st-bad', warning: 'st-warn', unknown: 'st-muted' };
  const sevLabel: Record<RisksSection['items'][number]['severity'], string> = { violation: '✗ violation', warning: '⚠ warning', unknown: '? unknown' };
  const rows = risks.items.map((it) => {
    const resolution = it.fix ?? it.resolvedBy ?? '—';
    return [
      `<span class="${sevCls[it.severity]}">${sevLabel[it.severity]}</span>`,
      `${esc(it.node)} · ${esc(keyDisplay(it.key))}`,
      esc(it.note),
      esc(resolution),
    ];
  });
  return table(['Severity', 'Where', 'Issue', 'Resolution'], rows);
}

function renderGlossary(g: GlossarySection): string {
  const legend = g.provenanceLegend
    .map((e) => `<tr><td>${provBadge(e.badge)}</td><td>${esc(e.meaning)}</td></tr>`)
    .join('');
  const legendTable = `<h3>Provenance legend</h3><div class="tw"><table><tbody>${legend}</tbody></table></div>`;
  const entries = g.entries.map((e) => `<tr><td class="term">${esc(e.term)}</td><td>${esc(e.definition)}</td></tr>`).join('');
  const glossaryTable = `<h3>Glossary</h3><div class="tw"><table><tbody>${entries}</tbody></table></div>`;
  return legendTable + glossaryTable;
}

// ── the section titles (§2 canon) + the dispatch ─────────────────────────────────────────────────────────────

const SECTION_TITLE: Record<SectionKey, string> = {
  summary: 'Summary',
  requirements: 'Promises (SLOs)',
  assumptions: 'Assumptions & parameters register',
  scenarios: 'Scenarios — world comparison',
  architecture: 'Architecture — C4 container view',
  capacity: 'Capacity & flow analysis',
  simulation: 'Time behaviour (simulation)',
  reliability: 'Reliability',
  guarantees: 'Guarantees (consistency · ordering · delivery)',
  cost: 'Cost',
  alternatives: 'Alternatives considered',
  risks: 'Risks & open questions',
  glossary: 'Glossary & provenance legend',
};

/** Dispatch a section key to its rendered body. Absent optional data inside a section renders nothing (each renderer
 *  guards). `alternatives` is only in `sectionOrder` when the model carries it, so its `!` is safe here. */
function sectionBody(key: SectionKey, model: DocModel): string {
  switch (key) {
    case 'summary':
      return renderSummary(model.summary);
    case 'requirements':
      return renderRequirements(model.requirements);
    case 'assumptions':
      return renderAssumptions(model.assumptions);
    case 'scenarios':
      // Present in sectionOrder ⇒ the model carries the data (buildDocModel only appends the key when it does).
      return renderScenarios(model.scenarios as NonNullable<DocModel['scenarios']>);
    case 'architecture':
      return renderArchitecture(model.architecture);
    case 'capacity':
      return renderCapacity(model.capacity);
    case 'simulation':
      return renderSimulation(model.simulation);
    case 'reliability':
      return renderReliability(model.reliability);
    case 'guarantees':
      // Present in sectionOrder ⇒ the model carries the data (buildDocModel only appends the key when it does).
      return renderGuarantees(model.guarantees as NonNullable<DocModel['guarantees']>);
    case 'cost':
      return renderCost(model.cost);
    case 'alternatives':
      // Present in sectionOrder ⇒ the model carries the data (buildDocModel only appends the key when it does).
      return renderAlternatives(model.alternatives as NonNullable<DocModel['alternatives']>);
    case 'risks':
      return renderRisks(model.risks);
    case 'glossary':
      return renderGlossary(model.glossary);
  }
}

// ── the document shell (inline CSS + print stylesheet) ───────────────────────────────────────────────────────

// All styling inline — the document is a single self-contained file with ZERO external requests: system font stacks
// (no @font-face), inline SVG, no JS. The design-doc language: a paper body in a serif, teal/amber accents, the .prov
// provenance badges.
//
// LAYOUT (2026-07-03 §1): the document is a REPORT, not a responsive web page — a FIXED A4-width sheet (~794px @96dpi)
// centred on a neutral "desk", so on any screen it is the SAME page and NEVER reflows. On a phone the meta viewport
// pins the layout width to the sheet (794px) and permits pinch-zoom, so the browser scales the whole page down to fit
// — the reader sees a miniature of the exact printed page, not a re-laid-out mobile view. `@page A4` + a hard page
// break before each section make a browser "Print → Save as PDF" a clean, paginated deliverable; a print-only running
// header/footer carries the project name, the generated date and the page number where the print engine supports it.
const PAGE_W = 794; // A4 width at 96dpi — the fixed content sheet width
const STYLE = `
:root{--ink:#1a1d23;--ink2:#4b5263;--paper:#fbfaf7;--card:#fff;--accent:#0b6e6e;--accent2:#b4530a;--line:#e5e1d8;--ok:#176b37;--warn:#8a5a00;--bad:#a3322b;--desk:#e7e4dc}
*{box-sizing:border-box}
/* The screen "desk" behind the sheet; the sheet itself is the fixed-width white page. */
body{margin:0;background:var(--desk);color:var(--ink);font:16px/1.6 Georgia,Charter,'Times New Roman',serif}
.page{width:${PAGE_W}px;margin:0 auto;background:var(--paper);box-shadow:0 2px 18px rgba(0,0,0,.14)}
/* The content column inside the sheet — its inner width is the figure budget (~${A4_FIGURE_BUDGET}px) so charts/C4 fit exactly. */
.w{margin:0 auto;padding:0 ${Math.round((PAGE_W - A4_FIGURE_BUDGET) / 2)}px 56px}
header{background:linear-gradient(135deg,#094f4f,#0b6e6e);color:#fff;padding:40px 0 30px}
header .w{padding-top:0;padding-bottom:0}
h1{font:600 30px/1.2 'Avenir Next','Segoe UI',system-ui,sans-serif;margin:0 0 8px;letter-spacing:-.01em}
.sub{font:400 15px/1.5 'Segoe UI',system-ui,sans-serif;opacity:.92;max-width:600px}
.meta{font:12px/1.4 'Segoe UI',system-ui,sans-serif;opacity:.78;margin-top:16px;text-transform:uppercase;letter-spacing:.12em}
h2{font:600 22px/1.3 'Avenir Next','Segoe UI',system-ui,sans-serif;margin:40px 0 12px;color:#094f4f}
h2 .no{color:var(--accent2);margin-right:10px;font-variant-numeric:tabular-nums}
h3{font:600 16px/1.3 'Avenir Next','Segoe UI',system-ui,sans-serif;margin:24px 0 8px;color:var(--ink)}
p{margin:0 0 12px}
.lead{font-size:18px;color:var(--ink2)}
.muted{color:var(--ink2);font-size:14px}
/* Wide content (tables) scrolls INSIDE its own box; the page body itself never scrolls horizontally. */
.tw{overflow-x:auto;margin:16px 0}
table{border-collapse:collapse;width:100%;font:14px/1.5 'Segoe UI',system-ui,sans-serif;background:var(--card)}
th{background:#094f4f;color:#fff;text-align:left;padding:9px 13px;font-weight:600;white-space:nowrap}
td{border-bottom:1px solid var(--line);padding:9px 13px;vertical-align:top}
tr:nth-child(even) td{background:#faf8f3}
td.term{white-space:nowrap;font-weight:600}
.callout{border-left:4px solid var(--accent);background:var(--card);padding:14px 18px;margin:20px 0;border-radius:0 8px 8px 0;box-shadow:0 1px 3px rgba(0,0,0,.05);font:15px/1.55 'Segoe UI',system-ui,sans-serif}
.callout.warn{border-left-color:var(--accent2)}
.callout.scope{border-left-color:var(--ink2)}
.callout b:first-child{font-weight:700}
figure{margin:22px 0;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;box-shadow:0 2px 8px rgba(0,0,0,.04)}
figcaption{font:12.5px/1.5 'Segoe UI',system-ui,sans-serif;color:var(--ink2);margin-top:10px;text-align:center}
/* The C4 diagram is a tall figure that owns its own report page in print (see @media print) — on screen it just fills the column. */
.c4page{margin:22px 0}
/* Figures fill the exact budget; a chart never has to scroll (it is drawn to the budget), but the guard stays. */
.svgc{display:flex;justify-content:center;overflow-x:auto}
.chart,.c4{max-width:100%;height:auto}
.prov{display:inline-block;font:600 11px/1 'Segoe UI',sans-serif;padding:3px 8px;border-radius:999px;text-decoration:none}
a.prov{cursor:pointer}
.src{background:#e2f2e8;color:#176b37}.est{background:#fdf2e2;color:#8a5a00}.usr{background:#e8eefc;color:#2c4a9a}.def{background:#efede7;color:#6b6659}
.st-ok{color:var(--ok);font-weight:600}.st-warn{color:var(--warn);font-weight:600}.st-bad{color:var(--bad);font-weight:600}.st-muted{color:var(--ink2)}
.tail{font:16px/1.5 'Segoe UI',system-ui,sans-serif}
.chart .cl{font:12px 'Segoe UI',sans-serif;fill:#1a1d23;dominant-baseline:middle}
.chart .cv{font:12px 'Segoe UI',sans-serif;fill:#4b5263;dominant-baseline:middle}
.chart .cax{font:11px 'Segoe UI',sans-serif;fill:#4b5263}
.c4 .nn{font:600 11px 'Segoe UI',sans-serif;fill:#1a1d23}
.c4 .nt{font:11px 'Segoe UI',sans-serif;fill:#4b5263}
.c4 .gl{font:600 11px 'Segoe UI',sans-serif;fill:#6b6659}
.c4 .pill{font:10px 'Segoe UI',sans-serif;fill:#4b5263}
.c4 .lg{font:11px 'Segoe UI',sans-serif;fill:#4b5263;dominant-baseline:middle}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--line);font:12.5px/1.5 'Segoe UI',sans-serif;color:var(--ink2)}
/* The print running header/footer — shown ONLY on paper (a screen reader sees the header band instead). */
.runhead,.runfoot{display:none}
@page{size:A4;margin:16mm 14mm}
@media print{
  body{background:#fff}
  /* On paper the browser owns the page size; the sheet becomes full-width within the @page margin box. */
  .page{width:auto;box-shadow:none;background:#fff}
  .w{padding-left:0;padding-right:0}
  header{background:#094f4f!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  section{break-before:page;page-break-before:always}
  section#sec-summary{break-before:auto;page-break-before:auto}
  section{break-inside:auto}
  figure,table,.callout{break-inside:avoid}
  figure,.callout{box-shadow:none}
  /* The C4 figure gets its OWN page (owner review §1): a hard break before AND after, so the tall diagram — with its
     long, pill-carrying connections — never shares a printed page with the surrounding prose. */
  .c4page{break-before:page;page-break-before:always;break-after:page;page-break-after:always}
  th{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .tw,.svgc{overflow:visible}
  /* A repeating running header/footer on every printed page (position:fixed repeats per page in print). */
  .runhead,.runfoot{display:block;position:fixed;left:0;right:0;font:10px/1.3 'Segoe UI',sans-serif;color:var(--ink2);-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .runhead{top:0;border-bottom:1px solid var(--line);padding-bottom:3px}
  .runfoot{bottom:0;border-top:1px solid var(--line);padding-top:3px;text-align:center}
}
`.trim();

/**
 * Render the DocModel as ONE self-contained HTML document string. PURE: the only time source is `model.generatedAt`
 * (an input). ZERO network: inline CSS + SVG, system fonts, no JS. Sections render in `model.sectionOrder`; an absent
 * optional section (never in the order) is simply not there (§6). XSS-safe: every model string is `esc()`'d at its
 * interpolation site.
 */
export function renderHtml(model: DocModel): string {
  const generated = model.generatedAt !== undefined ? esc(model.generatedAt) : undefined;
  const metaBits = ['SDA design document', generated, 'for review'].filter((x): x is string => x !== undefined).join(' · ');

  const sections = model.sectionOrder.map((key, i) => section(i + 1, key, SECTION_TITLE[key], sectionBody(key, model))).join('');

  const footer =
    `<footer>Generated by SDA as a pure function of the verified model — every number is computed, every assumption carries its origin. ` +
    `This document covers the quantitative envelope only (capacity, latency, availability, cost); it is a report of the model, not a hand-written narrative.</footer>`;

  // The print RUNNING header/footer (2026-07-03 §1): shown only on paper, they carry the project name + generated
  // date on every page. A page number is added where the print engine renders CSS page counters (browsers vary), so
  // we keep the footer text stable and let the engine append the number in its own margin box when it supports it.
  const runContext = [model.name, generated].filter((x): x is string => x !== undefined).map(esc).join(' · ');
  const runHead = `<div class="runhead">${runContext} — SDA design document</div>`;
  const runFoot = `<div class="runfoot">Generated by SDA — the quantitative envelope of the design</div>`;

  // The viewport pins the layout width to the FIXED sheet (2026-07-03 §1): a phone scales the whole 794px page down
  // to fit its screen (a faithful miniature of the printed page) instead of reflowing; `user-scalable=yes` +
  // `maximum-scale` let the reader pinch-zoom in to read. On desktop the sheet sits centred on the neutral desk.
  const viewport = `<meta name="viewport" content="width=${PAGE_W}, initial-scale=1, minimum-scale=0.1, maximum-scale=5, user-scalable=yes">`;

  // The <head> is written by the caller/publisher in some environments, but this renderer emits a COMPLETE document
  // so it can be saved as a standalone .html and mailed/archived. lang="en" (English-only project convention).
  return (
    `<!DOCTYPE html>\n<html lang="en">\n<head>\n` +
    `<meta charset="utf-8">\n${viewport}\n` +
    `<title>Design Document — ${esc(model.name)}</title>\n` +
    `<style>${STYLE}</style>\n</head>\n<body>\n` +
    `${runHead}${runFoot}\n` +
    `<div class="page">\n` +
    `<header><div class="w"><h1>Design Document — ${esc(model.name)}</h1>` +
    `<div class="sub">The written deliverable, generated from the verified model — computed, assumption-honest, self-contained.</div>` +
    `<div class="meta">${esc(metaBits)}</div></div></header>\n` +
    `<div class="w">\n${sections}\n${footer}\n</div>\n</div>\n</body>\n</html>\n`
  );
}
