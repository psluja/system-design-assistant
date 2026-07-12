// ── time (whole-millisecond) formatting — the content-side MIRROR of the presenter's canonical formatter ────────
// OWNER RULE (display-consistency sweep): every DISPLAYED time value is WHOLE milliseconds — rounded, thousands-
// grouped, no fractions, no sub-ms noise. The underlying DATA keeps full precision (engine / sim / JSON untouched);
// this is DISPLAY-ONLY. One-form-per-kind: `formatMs` is the canonical token (carries the ' ms' unit); `formatMsDigits`
// is the SAME rounding WITHOUT the unit, for a context that renders the unit itself (a trailing shared unit, a
// segmented bar, an axis). Honesty (the tool must not lie): unknown / NaN → '—' (never a fabricated 0); a saturated
// tier's unbounded latency → '∞' / '−∞'; a NONZERO value below 0.5 ms — which would round to 0 — → '<1' / '<1 ms'
// (never a false '0 ms'). The '<1' guard holds for a STANDALONE duration (a lone value, where a bare '0 ms' would
// lie); this formatter stays context-free (always the honest '<1'). Grouping is Intl-free (hand-grouped) so it is
// deterministic across environments.
//
// WHY A MIRROR, not an import: the design-doc / HTML renderers live in @sda/content, which the presenter DEPENDS ON
// (presenter → content). Importing the presenter here would invert the dependency. So this is a byte-for-byte copy of
// app/presenter/src/format.ts's time formatters — kept in lock-step, and PINNED equal by a cross-package consistency
// test (see app/presenter/src/format-ms.test.ts). Any change here MUST be mirrored there, and vice versa.

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
 *  is shown so a figure reads identically on the generated doc and every other surface. */
export function formatMs(value: number | undefined): string {
  const d = formatMsDigits(value);
  return d === '—' || d === '∞' || d === '−∞' ? d : `${d} ms`;
}
