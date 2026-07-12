import { deserialize } from '@sda/core';
import { keys } from '@sda/content';
import type { Band } from '@sda/engine-core';
import { sloComparator } from './slo-tests-pure';

// Pure, vscode-free catalog + helpers for NATIVE SLO (promise) editing. `commands.ts` builds the `sda.setSlo`
// / `sda.removeSlo` QuickPick/InputBox flows from `SLO_REQUIREMENTS`, and `inspector-tree.ts` renders a node's
// existing SLOs from `sloRowsFor`. Everything decision-y lives here so it is unit-tested under vitest (which
// cannot load the `vscode` module); the vscode-facing files stay thin glue.
//
// The promise set MIRRORS the web app's "PROMISES (END-TO-END)" surface (app/web/src/app.tsx `SLO_KEYS`):
// throughput ≥, latency ≤, availability ≥ (a ratio), cost ≤, plus the p99 tail (a `percentiles` band). Both
// surfaces write the SAME `instance.bands` shape, so an SLO set in the extension and one set on the web read
// identically (one meaning, two entry points).

/** One requirement the user can state on a node: the registry key it bounds, the natural comparator, and the
 *  human label + unit shown in the QuickPick. `build` turns a validated numeric value into the band that encodes
 *  the requirement — a `minTargetMax` min/max per comparator, or a `percentiles` p99 target for the tail. */
export interface SloRequirement {
  /** The registry key id (string) the band bounds — e.g. `throughput`, `latency`, `tailLatency`. */
  readonly key: string;
  /** The natural bound direction: `≥` (a floor, e.g. throughput/availability) or `≤` (a ceiling, e.g. latency/cost). */
  readonly cmp: '≥' | '≤';
  /** The friendly metric name shown in the pick (e.g. "Throughput", "p99 tail latency"). */
  readonly label: string;
  /** The unit shown next to the value in the pick/prompt (e.g. `rps`, `ms`, `ratio`, `USD/mo`). */
  readonly unit: string;
  /** True when the value is a ratio in [0, 1] (availability) — the InputBox validates the tighter range. */
  readonly isRatio: boolean;
  /** Build the SLO band for a validated numeric value. `minTargetMax` for a scalar floor/ceiling; a `percentiles`
   *  Map ([['p99', v]]) for the tail — the exact shape the web writes, so the two surfaces stay interchangeable. */
  readonly build: (value: number) => Band;
}

/** The requirements offered on a NODE, in the order the QuickPick shows them — mirroring the web's `SLO_KEYS`
 *  semantics (throughput ≥ · latency ≤ · availability ≥ · branch cost ≤ · p99 tail ≤). `tailLatency` carries a
 *  `percentiles` band (its own SLO key, judged against the DES tail), so it is listed distinctly from the mean
 *  `latency`. COST here is honestly "Branch cost" (owner ruling: cost is for THE WHOLE SYSTEM): a node's cost band
 *  bounds that node's CUMULATIVE cost cell — the spend of its branch (the paths into it), blind to off-path tiers —
 *  while the whole-bill promise is the SYSTEM quantity (`SYSTEM_QUANTITIES` below / `doc.systemPromises`). */
export const SLO_REQUIREMENTS: readonly SloRequirement[] = [
  { key: String(keys.throughput), cmp: '≥', label: 'Throughput', unit: 'rps', isRatio: false, build: (v) => ({ shape: 'minTargetMax', min: v }) },
  { key: String(keys.latency), cmp: '≤', label: 'Latency (mean)', unit: 'ms', isRatio: false, build: (v) => ({ shape: 'minTargetMax', max: v }) },
  { key: String(keys.availability), cmp: '≥', label: 'Availability', unit: 'ratio', isRatio: true, build: (v) => ({ shape: 'minTargetMax', min: v }) },
  { key: String(keys.cost), cmp: '≤', label: 'Branch cost', unit: 'USD/mo', isRatio: false, build: (v) => ({ shape: 'minTargetMax', max: v }) },
  { key: String(keys.tailLatency), cmp: '≤', label: 'p99 tail latency', unit: 'ms', isRatio: false, build: (v) => ({ shape: 'percentiles', targets: new Map([['p99', v]]) }) },
];

/** The requirement definition for a key, or undefined for a key not in the catalog (e.g. a band written by a
 *  future surface). Used when RE-EDITING an existing band so the InputBox seeds with the right prompt/validation. */
export function requirementForKey(key: string): SloRequirement | undefined {
  return SLO_REQUIREMENTS.find((r) => r.key === key);
}

/** One quantity the SYSTEM 'Add promise…' flow offers. There is exactly ONE (owner ruling): COST — the WHOLE-DESIGN
 *  promise, judged against the sum of every component's own cost (off-path branches included). It lives in
 *  `doc.systemPromises` and NEVER asks for a flow, because the quantity is global. The other quantities
 *  (throughput / latency / availability) are JOURNEY quantities that belong on a NODE — every node carries its
 *  cumulative journey, and an end-to-end availability promise IS an `availability` band on the flow's terminal
 *  (judged against the terminal's cumulative, the serial product over the path) — so they are set through the
 *  NODE promise flow (`sda.setSlo`), not here. */
export interface SystemQuantity extends SloRequirement {
  readonly scope: 'system';
}

/** The catalog for `sda.setSystemRequirement` — exactly ONE entry: COST, the whole-system sum. Because there is one,
 *  the command auto-selects it (no quantity pick), mirroring how the node flow pre-targets its node. The band a
 *  system cost promise stores is built by content's shared `costPromise` (the one form both shells and the MCP
 *  share), not by `build` here. */
export const SYSTEM_QUANTITIES: readonly SystemQuantity[] = SLO_REQUIREMENTS
  .filter((r) => r.key === String(keys.cost))
  .map((r) => ({ ...r, label: 'Cost (whole system)', scope: 'system' as const }));

/** The sole system quantity (cost) — the WHOLE-SYSTEM promise the 'Add promise…' flow declares. */
export function systemCostQuantity(): SystemQuantity | undefined {
  return SYSTEM_QUANTITIES[0];
}

/** The system quantity for a key (a pre-set `{ key }` argument — a row edit), or undefined when not offered. */
export function systemQuantityForKey(key: string): SystemQuantity | undefined {
  return SYSTEM_QUANTITIES.find((q) => q.key === key);
}

/** One existing SLO on a node, ready for the Inspector row + the remove picker: the key it bounds and the human
 *  comparator text (e.g. `throughput ≥ 5,000 rps`) borrowed from `sloComparator` so the row reads exactly like the
 *  SLO Test Explorer's label (one comparator grammar across every native surface). */
export interface SloRow {
  readonly key: string;
  readonly label: string;
}

/** Every SLO declared on `node` in the design TEXT, as `SloRow`s in declaration order (a stable list). Returns an
 *  empty list for a node with no bands, an unknown node, or text that does not parse — the caller then shows only
 *  the "+ Add promise…" entry, never a fabricated row. Pure and deterministic. */
export function sloRowsFor(text: string, node: string): readonly SloRow[] {
  const parsed = deserialize(text);
  if (!parsed.ok) return [];
  const inst = parsed.value.instances.find((i) => i.id === node);
  if (inst === undefined) return [];
  return (inst.bands ?? []).map((b) => ({ key: String(b.key), label: sloComparator(String(b.key), b.band) }));
}
