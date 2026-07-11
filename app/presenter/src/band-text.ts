import { registry, keys } from '@sda/content';
import { Key, type Band } from '@sda/engine-core';

// The CANONICAL human comparator for an SLO band — the ONE grammar every SDA surface uses to render a promise
// (a `Promises` row in either shell, the SLO Test Explorer label, the design doc). Lives in the
// presenter so the text can never drift between shells: the VS Code native Inspector's Promises rows and the web
// Inspector's Promises rows both read `throughput ≥ 5,000 req/s` from HERE. Pure and deterministic; the unit comes
// from the engine registry (the engine is domain-agnostic — we read the declared unit, never invent one).
//
// Moved verbatim from app/vscode/src/slo-tests-pure.ts (which now re-exports these) so there is a single source of
// truth; the vscode SLO tests that pin the exact strings still pass unchanged (identical output).

/** The human comparator for an SLO band, prefixed by the metric name, e.g. `latency ≤ 120 ms`, `throughput ≥ 5,000
 *  req/s`, `tailLatency · p99 ≤ 300 ms`, `availability ≥ 99.9900%`. Ratio keys (availability/durability) render as a
 *  percentage; every other key uses its registry unit.
 *
 *  `scope` (owner ruling: cost is for THE WHOLE SYSTEM): a NODE-scoped cost band bounds that node's cumulative
 *  cost cell — the cost of its BRANCH (the paths into it), blind to off-path spend — so it is honestly named
 *  `branch cost` on every node row (no silent migration: the band stays, only the label tells the truth). The
 *  whole-design quantity is the SYSTEM promise (`scope: 'system'`), which keeps the plain `cost` name. */
export function bandComparator(key: string, band: Band, scope: 'node' | 'system' = 'node'): string {
  const unit = unitOf(key);
  const metric = scope === 'node' && key === String(keys.cost) ? 'branch cost' : keyName(key);
  const isRatio = key === String(keys.availability) || key === String(keys.durability);
  const fmt = (n: number): string => (isRatio ? pct(n) : withUnit(num(n), unit));

  if (band.shape === 'point') return `${metric} = ${fmt(band.target)}`;
  if (band.shape === 'percentiles') {
    // A tail band carries one or more percentile targets (p50/p95/p99…). Render each `pN ≤ target`, unit on each.
    const parts = [...band.targets].map(([p, t]) => `${p} ≤ ${fmt(t)}`);
    return `${metric} · ${parts.join(', ')}`;
  }
  // minTargetMax: a lower bound, an upper bound, or both (with an optional soft target).
  const parts: string[] = [];
  if (band.min !== undefined) parts.push(`≥ ${fmt(band.min)}`);
  if (band.max !== undefined) parts.push(`≤ ${fmt(band.max)}`);
  if (band.target !== undefined) parts.push(`target ${fmt(band.target)}`);
  return `${metric} ${parts.join(', ') || '(any)'}`;
}

/** A reverse index name→registry key, so a key id can be shown by its friendly metric name where they differ. The
 *  `keys` export's OWN property names are the human labels; here the id already IS the label for the seed keys, so
 *  this is mostly identity — kept so a future rename in `keys` flows through without editing this file. */
const KEY_LABEL: ReadonlyMap<string, string> = new Map(Object.entries(keys).map(([label, k]) => [String(k), label]));
const keyName = (key: string): string => KEY_LABEL.get(key) ?? key;

/** The declared unit for a registry key, or '' when the key is unknown / dimensionless ('1'). Read from the
 *  registry so it is always the engine's own unit (the tool must not invent units). */
function unitOf(key: string): string {
  const def = registry.get(Key(key));
  if (def === undefined) return '';
  const u = String(def.unit);
  return u === '1' ? '' : u;
}

/** A number with its unit appended (a bare number when dimensionless). Thousands-grouped for readability. */
function withUnit(n: string, unit: string): string {
  return unit === '' ? n : `${n} ${unit}`;
}

/** A compact number with thousands separators; integers bare, else ≤2 decimals with trailing zeros stripped. */
export function num(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '−∞';
  const rounded = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
  // Group the integer part; keep any fractional part untouched.
  const dot = rounded.indexOf('.');
  const intPart = dot === -1 ? rounded : rounded.slice(0, dot);
  const frac = dot === -1 ? '' : rounded.slice(dot);
  const sign = intPart.startsWith('-') ? '-' : '';
  const digits = sign === '-' ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + grouped + frac;
}

/** An availability/durability ratio as a percentage with enough nines to be meaningful. */
function pct(a: number): string {
  return `${(a * 100).toFixed(a >= 0.9999 ? 4 : a >= 0.99 ? 3 : 2)}%`;
}
