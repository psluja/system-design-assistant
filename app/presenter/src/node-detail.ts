import { NodeId, type Verdict } from '@sda/engine-core';
import { isFactAssumption, keys, type Instance, type Manifest } from '@sda/content';
import { fmt, formatMs } from './format';
import { keyInfo } from './meta';
import type { Suggestion } from './suggest';
import { formatResponseTail, PROMISES_TITLE, type NodeResponseView } from './summary';

// The Promises heading is defined in ./summary (the System roll-up's home) so the dependency stays acyclic — this
// module already imports from ./summary. Re-exported here so the Inspector's group heading and every `./node-detail`
// consumer keep the SAME import surface; it is the SHARED constant the whole-system Promises section also uses.
export { PROMISES_TITLE };

// The canonical Inspector data for ONE selected node: its manifest config KNOBS (labelled via the shared keyInfo),
// the node's VERDICT rows (pre-formatted value + tone) and the engine SUGGESTIONS for its open ports. Base =
// app/vscode/webview/App.tsx's `nodeDetail` memo. Extracting it here means the web Inspector and the VS Code
// native Inspector tree label knobs, format verdicts and offer suggestions IDENTICALLY — one Inspector model.
//
// The web Inspector renders richer controls (editable SyncedField knobs, cost breakdown) on top of the SAME
// underlying data; the vscode host renders these fields into a native tree. This module is the shared spine.

/** A tone that is definitely present — so `tone?` (exactOptionalPropertyTypes) is set only when we have one. */
type Tint = NonNullable<VerdictRow['tone']>;

/** One config knob of the selected node — the web renders an editable field, the vscode host an InputBox. */
export interface KnobRow {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly unit: string;
}
/** One verdict row for the node (a labelled, pre-formatted value + status + optional tone). */
export interface VerdictRow {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'ok' | 'warn' | 'bad';
}
/** One "what fits" suggestion for an open port (component type ids that legally attach). */
export interface SuggestRow {
  readonly port: string;
  readonly dir: 'in' | 'out' | 'bi';
  readonly options: readonly string[];
}
/** The full Inspector model for a selection. `node === ''` means nothing is selected (empty inspector). */
export interface NodeDetail {
  readonly node: string;
  readonly label: string;
  readonly typeId: string;
  readonly knobs: readonly KnobRow[];
  readonly verdicts: readonly VerdictRow[];
  readonly suggestions: readonly SuggestRow[];
  /** The selected node's MEASURED response tail (the single-truth latency home): p50 / p95 / p99 first, mean +
   *  samples as detail, or an honest "no data" when the node had no recorded response. Present ONLY when a sim has run
   *  and the node was part of it (no-filler); the canvas bar shows the compact p50→p99 range, this the full set. */
  readonly response?: VerdictRow;
  /** A QUIET engine-health diagnostic: the internal analytic MODEL's estimate for this node's response and its drift
   *  from the measured mean ("model estimate 54 ms · drift +27 ms"). The analytic scalar appears on NO architect
   *  surface — this is the ONE place it may surface, as a model-vs-reality detail. Present only when BOTH a measured
   *  response and a finite analytic estimate exist. */
  readonly drift?: VerdictRow;
}

// ─── THE INSPECTOR'S ROLE AXIS (doc: assumption-model §2) ──────────────────────────────────────────────────────
// The registry role axis projected onto the Inspector: a node's config KNOBS are grouped by the role of their key,
// so the surface reads by the difference that matters (a belief about your world vs a ceiling the design commits to)
// rather than a flat "Configuration" list. Both shells partition/label knobs THROUGH these helpers, so the section
// headings + order are one form and can never drift. A config knob is always an INPUT, hence fact-assumption |
// resource-limit (the role↔kind partition is proven in content roles.test.ts); computed & promise-target keys are
// never knobs — computed values live in the verdict/cost readouts, promises in the `Promises` (SLO bands) section.

/** The Inspector's INPUT-knob groups, in canonical display order. */
export type KnobGroupId = 'assumptions' | 'limits';

/** The role-titled headings both shells render (identical text ⇒ zero drift). */
export const KNOB_GROUP_TITLE: Readonly<Record<KnobGroupId, string>> = {
  assumptions: 'Assumptions (facts about your world)',
  limits: 'Resource limits',
};

/** A one-line plain caption for each Inspector section (the two knob groups + Promises), so a first-time reader
 *  knows WHAT to fill, WHEN and WHY. SHARED by both shells (owner ask 2026-07-11): the web renders it under the
 *  section title, the VS Code Inspector tree as the section item's description — one text, zero drift. */
export const SECTION_CAPTIONS: Readonly<Record<KnobGroupId | 'promises', string>> = {
  assumptions: 'What you assume about the outside world — offered load, response times, retries. Fill what you know; the engine takes these as given.',
  limits: "The sizing this design commits to — concurrency, replicas, quotas. Fill what you're provisioning; capacity is computed from these.",
  promises: 'The targets this node must meet. Set one only where you care; the engine checks it and computes everything else.',
};

/** Which INPUT group a config knob belongs to, by the registry role of its key: a `fact-assumption` key is an
 *  Assumption (a belief about the outside world); every other input role (resource-limit) is a Resource limit. A knob
 *  is never dropped — a key with no fact-assumption role falls to `limits`. */
export function knobGroupOf(key: string): KnobGroupId {
  return isFactAssumption(key) ? 'assumptions' : 'limits';
}

// ─── HIDDEN KNOBS (owner: hide `assumedRps` from every human-facing surface — "for now, then we'll see") ─────────
// A HIDDEN knob is one whose HUMAN-FACING display is suppressed while its MECHANISM stays fully live: the registry
// cell, its role/aggregate, the engine origin fold, and the worlds / Monte-Carlo / envelope addressing of the cell
// are all UNTOUCHED. `assumedRps` (the traffic-origin cell) is now AUTHORED via a port `generate` transform — R1
// sugar writes the very same cell — so the raw 'Assumed traffic' knob is redundant and hidden pending the full
// assumedRps→generator consolidation. It lives HERE, the ONE knob composition both shells render through, so the web
// Inspector, the VS Code Inspector tree AND the native range picker all suppress it from a SINGLE list (each consults
// `isHiddenKnob`) — the value can never leak onto a knob row on one surface while hidden on another.
export const HIDDEN_KNOB_KEYS: ReadonlySet<string> = new Set<string>([String(keys.assumedRps)]);

/** Whether a config knob is HIDDEN from every human-facing knob surface (its mechanism is unaffected — only the
 *  rendered knob is suppressed). Both shells filter their knob lists through this, so hiding stays ONE decision. */
export function isHiddenKnob(key: string): boolean {
  return HIDDEN_KNOB_KEYS.has(key);
}

/** One role-titled group of knobs for the Inspector. */
export interface KnobGroup {
  readonly id: KnobGroupId;
  readonly title: string;
  readonly knobs: readonly KnobRow[];
}

/** Partition a node's knobs into the role-titled groups in canonical order (Assumptions, then Resource limits),
 *  DROPPING an empty group (no-filler). Both shells iterate this so section order + headings are identical. */
export function knobGroups(knobs: readonly KnobRow[]): readonly KnobGroup[] {
  const order: readonly KnobGroupId[] = ['assumptions', 'limits'];
  return order
    .map((id) => ({ id, title: KNOB_GROUP_TITLE[id], knobs: knobs.filter((k) => knobGroupOf(k.key) === id) }))
    .filter((g) => g.knobs.length > 0);
}

/** Inputs for `nodeDetail`, all already computed by the shell. */
export interface NodeDetailInput {
  readonly sel: string | null; // the selected node id (null = nothing selected)
  readonly instance: Instance | undefined; // the selected instance
  readonly manifest: Manifest | undefined; // the selected instance's manifest (custom-override aware)
  readonly verdicts: readonly Verdict[]; // the ONE real-aware verdict list
  readonly suggestions: readonly Suggestion[]; // suggestFor(...) for the selected node's open ports
  readonly labelOf: (id: string, type: string) => string; // the shell's friendly-name resolver
  /** The selected node's response tail from the last DES run (its entry in `sim.nodeResponse`), or undefined when no
   *  sim has run / the node was not in it. When present, `nodeDetail` emits the full `response` row (honest 'no data'
   *  for a NaN reservoir). The engine computes a perspective for every node; the display commits it on the selection. */
  readonly response?: NodeResponseView | undefined;
  /** The engine's INTERNAL analytic response estimate for this node (the shell's `responseLatency` map value), used
   *  ONLY to compute the quiet model-drift diagnostic — never shown as a latency in its own right. */
  readonly analyticResponseMs?: number | undefined;
}

const verdTone = (status: string): Tint | undefined => (status === 'violation' ? 'bad' : status === 'warning' ? 'warn' : status === 'ok' ? 'ok' : undefined);

/** A signed whole-ms drift token — `+27 ms` / `−13 ms` (the model vs the measurement). */
const signedMs = (delta: number): string => `${delta >= 0 ? '+' : '−'}${formatMs(Math.abs(delta))}`;

/**
 * Build the Inspector model for the current selection. EXACTLY app/vscode/webview/App.tsx's `nodeDetail`:
 *   • knobs   = the manifest's config, each `{ key, label (keyInfo), value (instance override ?? default), unit }`;
 *   • verdicts = the node's own verdict rows, `value` = "<fmt> <unit> · <status>", toned by status;
 *   • suggestions = the engine's open-port suggestions mapped to `{ port, dir, options }`.
 * Returns the empty model (node '') when nothing valid is selected — the host shows an empty inspector.
 */
export function nodeDetail(input: NodeDetailInput): NodeDetail {
  const { sel, instance: inst, manifest: man, verdicts, suggestions, labelOf, response, analyticResponseMs } = input;
  if (!sel || !inst || !man) return { node: '', label: '', typeId: '', knobs: [], verdicts: [], suggestions: [] };

  // Hidden knobs (e.g. `assumedRps`) are dropped from the rendered list so NO shell that reads this model — the VS
  // Code Inspector tree, any nodeDetail consumer — shows them; the underlying cell/mechanism is untouched.
  const knobs: KnobRow[] = (man.config ?? []).filter((c) => !isHiddenKnob(String(c.key))).map((c) => {
    const ck = String(c.key);
    const info = keyInfo(ck);
    const cur = inst.config?.[c.key] ?? c.value;
    return { key: ck, label: info.label, value: Number(cur), unit: info.unit };
  });

  const verdRows: VerdictRow[] = verdicts
    .filter((v) => v.scope === NodeId(sel))
    .map((v) => {
      const tone = verdTone(v.status);
      // A TIME verdict (unit 'ms') renders as a whole-ms token; every other unit keeps the generic `value unit` form.
      const isMs = String(v.computed.unit) === 'ms';
      const shown = isMs ? formatMs(v.computed.value) : `${fmt(v.computed.value)}${v.computed.unit ? ` ${String(v.computed.unit)}` : ''}`;
      return {
        label: keyInfo(String(v.key)).label,
        value: `${shown} · ${v.status}`,
        ...(tone ? { tone } : {}),
      };
    });

  // WORST-CASE LOAD (owner ruling: a peak is just traffic in a given environment). A node saturated at its worst
  // load — the steady baseline, or the worst window when a generator is shaped — carries an ordinary saturation
  // VIOLATION in the shared verdict list (`realAwareVerdicts`, fed the sweep's per-node peak), which the verdict
  // rows above already render. So a node calm at the mean but broken at its declared peak reads a violation here,
  // matching the canvas — with no separate 'peak' row, no '@HH:MM', and no dual reading (the consolidate rule).

  const suggRows: SuggestRow[] = suggestions.map((s) => ({ port: s.port, dir: s.dir, options: s.options }));

  // The MEASURED RESPONSE tail row (the single-truth latency home) — present only when a sim ran and this node was
  // in it. `formatResponseTail` renders p50/p95/p99 first + mean + samples, or the honest "no data" for a NaN
  // reservoir. Untoned: it is an informational measurement, not a pass/fail (the tail SLO's verdict is its own row).
  const responseRow: VerdictRow | undefined = response !== undefined ? { label: 'Response tail (simulated)', value: formatResponseTail(response) } : undefined;

  // The QUIET model-drift diagnostic (engine health, not architect info): how far the internal analytic estimate is
  // from the measured mean. The analytic scalar surfaces ONLY here, as a "model vs reality" detail — never as a
  // latency in its own right. Present only when the node was actually measured and a finite estimate exists.
  const measured = response !== undefined && Number.isFinite(response.mean) && response.samples > 0;
  const driftRow: VerdictRow | undefined =
    measured && analyticResponseMs !== undefined && Number.isFinite(analyticResponseMs)
      ? { label: 'Model estimate', value: `${formatMs(analyticResponseMs)} · drift ${signedMs((response as NodeResponseView).mean - analyticResponseMs)} (engine model vs measured)` }
      : undefined;

  return {
    node: inst.id,
    label: labelOf(inst.id, inst.type),
    typeId: inst.type,
    knobs,
    verdicts: verdRows,
    suggestions: suggRows,
    ...(responseRow ? { response: responseRow } : {}),
    ...(driftRow ? { drift: driftRow } : {}),
  };
}
