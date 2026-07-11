import { deserialize } from '@sda/core';
import { formatRange, formatRangeInput, keyInfo, isHiddenKnob } from '@sda/presenter';
import { allManifests, type Manifest, type Range } from '@sda/content';

// Pure, vscode-free helpers for NATIVE uncertainty-RANGE editing (doc: uncertainty-monte-carlo §2). `commands.ts`
// builds the `sda.setRange` / `sda.clearRange` InputBox flow, and `inspector-tree.ts` annotates each Configuration
// knob with its declared range — both read the current ranges from the DESIGN TEXT via `rangeMapFor` (like SLOs via
// `sloRowsFor` and ports via `portRowsFor`, NOT the webview feed, which carries no range data). The grammar +
// display live in the shared @sda/presenter (`parseRangeInput`/`formatRange`), so the extension and the web Inspector
// interpret a range identically (one meaning, two entry points); this module is the thin document-reading glue.

/** One declared range on a node, ready for the Inspector + the InputBox seed: the config KEY it sits on, the range
 *  itself, the compact DISPLAY (`±(lo–hi)`) shown beside the value, and the editable SEED (`lo-hi`) the InputBox
 *  pre-fills with when re-editing. Display + seed come from the shared presenter formatters. */
export interface RangeRow {
  readonly key: string;
  readonly range: Range;
  /** `±(lo–hi)` / `±(lo–mode–hi)` — the collapsed indicator, identical to the web Inspector's. */
  readonly display: string;
  /** `lo-hi` / `lo-mode-hi` — the editable seed that round-trips through `parseRangeInput`. */
  readonly seed: string;
}

/** Every uncertainty range declared on `node` in the design TEXT, as `RangeRow`s sorted by key (a stable list).
 *  Returns an empty list for a node with no ranges, an unknown node, or text that does not parse — never a
 *  fabricated row. Pure and deterministic (the same discipline as `sloRowsFor`). */
export function rangeRowsFor(text: string, node: string): readonly RangeRow[] {
  const parsed = deserialize(text);
  if (!parsed.ok) return [];
  const inst = parsed.value.instances.find((i) => i.id === node);
  if (inst === undefined || inst.ranges === undefined) return [];
  return Object.keys(inst.ranges)
    .sort()
    .map((key) => {
      const range = inst.ranges![key]!;
      return { key, range, display: formatRange(range), seed: formatRangeInput(range) };
    });
}

/** A key → `Range` lookup for `node` from the design TEXT, so the Inspector can annotate each knob row with its
 *  range in O(1) and the command can seed the InputBox from the current range. Empty for an unknown node / unparseable
 *  text — the caller then treats every knob as un-ranged (never a guessed range). */
export function rangeMapFor(text: string, node: string): ReadonlyMap<string, Range> {
  const map = new Map<string, Range>();
  for (const row of rangeRowsFor(text, node)) map.set(row.key, row.range);
  return map;
}

/** One config KNOB on a node, for the `sda.setRange` command-palette knob picker: its config KEY, the human label
 *  (shared `keyInfo`), the current value (instance override ?? manifest default) + unit, and its declared range (if
 *  any) so the picker can mark an already-ranged knob and seed the InputBox. The catalog-backed twin of `portRowsFor`. */
export interface KnobChoice {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly unit: string;
  /** The uncertainty range already declared on this knob, or undefined when it is a plain point value. */
  readonly range?: Range;
}

/**
 * Every config knob of `node`'s component, read from the design TEXT (for instance overrides + ranges) and the shared
 * catalog (for the manifest config list + defaults) — the source of choices when `sda.setRange` is invoked WITHOUT a
 * pre-scoped knob (the command palette). Resolution mirrors the Inspector: instance config override ?? manifest default
 * for the value; a per-instance range annotates the knob. Returns an empty list for an unknown node, a node whose type
 * is absent from the catalog, or text that does not parse — never a fabricated knob. Project-scoped custom components
 * win over the built-in catalog, exactly like `portRowsFor`.
 */
export function configKnobsFor(text: string, node: string): readonly KnobChoice[] {
  const parsed = deserialize(text);
  if (!parsed.ok) return [];
  const inst = parsed.value.instances.find((i) => i.id === node);
  if (inst === undefined) return [];
  const catalog: Record<string, Manifest> = { ...allManifests };
  for (const m of parsed.value.components) catalog[m.type] = m; // custom project components win, like the shells
  const man = catalog[inst.type];
  if (man === undefined) return [];
  // HIDDEN knobs (e.g. `assumedRps`) are suppressed from the picker too — the same `isHiddenKnob` decision the
  // Inspector uses, so a hidden knob offers no 'Assumed traffic' choice on any human-facing surface.
  return (man.config ?? []).filter((c) => !isHiddenKnob(String(c.key))).map((c) => {
    const key = String(c.key);
    const info = keyInfo(key);
    const value = Number(inst.config?.[key] ?? c.value);
    const range = inst.ranges?.[key];
    return { key, label: info.label, value, unit: info.unit, ...(range !== undefined ? { range } : {}) };
  });
}
