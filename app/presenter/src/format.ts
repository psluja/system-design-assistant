// Pure formatting helpers shared by EVERY SDA shell (web footer/panels, VS Code native trees). Living in the
// presenter — not in one shell — is the anti-drift guarantee: both shells format a number the SAME way, so a
// figure can never read "71 ms" in one and "71.0 ms" in the other. No React, no app state, trivially testable.
// Moved verbatim from app/web/src/format.ts (which is now a re-export stub).

/** A compact number: '—' for undefined/NaN, ∞ for non-finite, thousands-grouped at ≥1000, else ≤2 decimals. */
export const fmt = (n: number | undefined): string =>
  n === undefined || Number.isNaN(n) ? '—' : !Number.isFinite(n) ? (n > 0 ? '∞' : '−∞') : Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : `${Math.round(n * 100) / 100}`;

// ── time (whole-millisecond) formatting — the ONE way every SDA surface renders a duration ─────────────────────
// OWNER RULE (display-consistency sweep): every DISPLAYED time value is WHOLE milliseconds — rounded, thousands-
// grouped, no fractions, no sub-ms noise. The underlying DATA keeps full precision (engine / sim / JSON untouched);
// this is DISPLAY-ONLY. One-form-per-kind: `formatMs` is the canonical token (carries the ' ms' unit); `formatMsDigits`
// is the SAME rounding WITHOUT the unit, for a context that renders the unit itself (a trailing shared unit, a
// segmented bar, an axis). Honesty (the tool must not lie): unknown / NaN → '—' (never a fabricated 0); a saturated
// tier's unbounded latency → '∞' / '−∞'; a NONZERO value below 0.5 ms — which would round to 0 — → '<1' / '<1 ms'
// (never a false '0 ms'). The '<1' guard holds for a STANDALONE duration (a lone value, where a bare '0 ms' would
// lie); this formatter stays context-free (it always renders the honest '<1').
// Grouping is Intl-free (hand-grouped) so it is deterministic across environments and byte-identical to the content-side
// mirror (content cannot import the presenter — a cross-package test pins them equal).
// SPEC MIRROR: content/sda/src/format-ms.ts carries the identical implementation; keep the two in lock-step.

/** The whole-ms rounding as BARE digits (no unit) — for a context that renders the unit itself. `—` unknown / NaN,
 *  `∞`/`−∞` non-finite, `<1` a nonzero sub-½-ms value (never a false `0`), else a whole thousands-grouped integer. */
export function formatMsDigits(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—';
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '−∞';
  if (value > 0 && Math.round(value) === 0) return '<1'; // nonzero but rounds to 0 — honest, never '0'
  const r = Math.round(value);
  const grouped = String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return r < 0 ? `−${grouped}` : grouped;
}

/** The canonical TIME token: a whole, thousands-grouped millisecond value WITH its unit (`1,234 ms`); a nonzero
 *  sub-ms value → `<1 ms`; unknown → `—`; a saturated tier's unbounded latency → `∞`. Use this EVERYWHERE a duration
 *  is shown so a figure can never read `71 ms` on one surface and `71.0 ms` (or `71 ms` vs `70.6 ms`) on another. */
export function formatMs(value: number | undefined): string {
  const d = formatMsDigits(value);
  return d === '—' || d === '∞' || d === '−∞' ? d : `${d} ms`;
}

/** "1 issue" / "2 issues" — count + noun with a regular plural, so the UI never reads "1 issues". */
export const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** A cost-equation operand: integers grouped (100,000), fractions to 4 significant figures (3.125) — so the shown
 *  `operand × base = total` is arithmetically EXACT, never a rounded-looking lie. */
export const opnd = (n: number): string => (Number.isInteger(n) ? n.toLocaleString('en-US') : String(Number(n.toPrecision(4))));

/** A unit-cost rate: small per-unit prices keep their significant digits ($0.0009) instead of rounding to $0. */
export const rate = (n: number): string => (n >= 1 ? `$${n.toLocaleString('en-US')}` : `$${Number(n.toPrecision(2))}`);

/** Render a cost relation expression human-readably: strip the engine's self()/inflow()/outflow() plumbing (a
 *  reader wants the keys) and show multiplication as ×. e.g. `self(requiredUnits) * self(unitCost)` → `requiredUnits × unitCost`. */
export const prettyExpr = (expr: string): string =>
  expr
    .replace(/\b(?:self|inflow|outflow)\(([^()]+)\)/g, '$1')
    .replace(/\s*\*\s*/g, ' × ')
    .replace(/\s+/g, ' ')
    .trim();
