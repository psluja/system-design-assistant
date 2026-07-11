import { deserialize } from '@sda/core';
import { type ManifestBand } from '@sda/content';
import { type Band, type Verdict } from '@sda/engine-core';
import { bandComparator, num } from '@sda/presenter';

// The band → comparator text and the compact number formatter are the SHARED presenter grammar (one form across
// every SDA surface). Re-exported under their historical names so this module's public API (and the tests that pin
// the exact strings) is unchanged — `sloComparator` IS `bandComparator`.
export { num };
export const sloComparator = bandComparator;

// Pure, vscode-free mapping for the SLO Test Explorer (one native TEST per USER SLO). Everything here is a plain
// function of the design text / a band / a verdict, so the interesting behaviour is unit-tested under vitest (which
// cannot load the `vscode` module). The vscode-facing `slo-tests.ts` maps a TestController + Run profile onto these.
//
// A USER SLO is an entry in `instance.bands` (the requirements the architect states on a node) — NOT a manifest's
// built-in band. We list exactly those, render each as a test item label + comparator, decide when a percentile
// (tail) SLO must be answered by the simulation rather than the host, and match each SLO to its verdict.

/** One user-declared SLO on a node: the node it belongs to, the registry key it bounds, and its band. A stable
 *  `id` (node + key) identifies the test item across refreshes. */
export interface SloItem {
  /** The node the SLO is declared on (the test item's parent grouping + range anchor). */
  readonly node: string;
  /** The registry key the band bounds (e.g. `latency`, `throughput`, `tailLatency`) — the verdict match key. */
  readonly key: string;
  /** The band (min/max/target or percentiles) — drives the comparator text. */
  readonly band: Band;
  /** A stable, unique test-item id: `<node>::<key>`. */
  readonly id: string;
  /** The rendered label, e.g. `pg · latency ≤ 120 ms` or `pg · tailLatency · p99 ≤ 300 ms`. */
  readonly label: string;
  /** True when this SLO is a tail (percentile) band — the host has no DES tail, so it is answered by the sim. */
  readonly isPercentile: boolean;
}

/** Extract every user-declared SLO from the design TEXT, as ordered `SloItem`s (design order → stable list). Returns
 *  an empty list for a design with no `instance.bands` (and for text that does not parse — the caller shows nothing,
 *  never a fabricated SLO). Pure and deterministic. */
export function sloItems(text: string): readonly SloItem[] {
  const parsed = deserialize(text);
  if (!parsed.ok) return [];
  const out: SloItem[] = [];
  for (const inst of parsed.value.instances) {
    for (const b of inst.bands ?? []) {
      out.push(toSloItem(inst.id, b));
    }
  }
  return out;
}

/** Build one `SloItem` from a node id + a manifest band (a user SLO). Exposed for direct unit testing of the label
 *  mapping (bands → labels) without going through the full document. */
export function toSloItem(node: string, mb: ManifestBand): SloItem {
  const key = String(mb.key);
  const isPercentile = mb.band.shape === 'percentiles';
  return {
    node,
    key,
    band: mb.band,
    id: `${node}::${key}`,
    label: `${node} · ${sloComparator(key, mb.band)}`,
    isPercentile,
  };
}

/** The verdict that answers an SLO: the one scoped to the SLO's node and keyed to the SLO's key. Undefined when the
 *  design produced no verdict for it (e.g. it did not build, or the key has no forward value) — the caller then
 *  reports honestly (skipped/unknown), never a fabricated pass/fail. */
export function verdictForSlo(slo: SloItem, verdicts: readonly Verdict[]): Verdict | undefined {
  return verdicts.find((v) => String(v.scope) === slo.node && String(v.key) === slo.key);
}
