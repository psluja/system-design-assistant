import { serialize, deserialize, apply, type Command, type ProjectDoc } from '@sda/core';
import { quantizeKnob, type GuaranteeSlo, type ManifestBand, type Range, type SystemPromise } from '@sda/content';
import { parseRangeInput } from '@sda/presenter';
import { Key, type Band, type Transform } from '@sda/engine-core';
import { escapeRegExp, idPairPattern } from './pure';

// The native EDITING core (vscode-free, pure). The Inspector's "edit value" and Improve's "apply" both mutate a
// node's config; this module turns the CURRENT document text + an edit intent into the NEW full document text.
// The editor-provider then writes that text as a single WorkspaceEdit — so VS Code owns the undo step natively.
//
// Why round-trip through @sda/core `serialize`/`deserialize` and NOT `JSON.stringify(doc, null, 2)`:
//   • a percentile (p99) SLO band carries its `targets` as a Map; a naive JSON round-trip SILENTLY DROPS it
//     (see document.ts) — the reopened design would lose the SLO. `deserialize` revives the tagged Map and
//     `serialize` re-tags it, so any node's percentile SLO survives an edit to a DIFFERENT node.
//   • it also guarantees we re-emit the EXACT on-disk format (2-space indent, tagged Maps), so the diff after an
//     edit is minimal and the file stays the diffable backup the project promises.
// Every function is a pure `(text, intent) → Result<text>` — no vscode, no IO — so it is unit-tested directly.

/** A single knob change from the Improve apply: set `node`.`key` to `to` (the solved, pre-quantization value). */
export interface KnobChange {
  readonly node: string;
  readonly key: string;
  readonly to: number;
}

/** A half-open character span [start, end) in the document text, and the exact replacement text for it. Returned
 *  by `changeRanges` so the caller (native refactor preview) can build ONE TextEdit per change instead of a
 *  whole-document replacement — the user then ticks individual changes in VS Code's native preview panel. */
export interface RangeEdit {
  readonly change: KnobChange;
  /** Character offset (0-based) of the first char of the located value (a JSON number). */
  readonly start: number;
  /** Character offset just past the last char of the located value. */
  readonly end: number;
  /** The QUANTIZED value to write (deployable — same `quantizeKnob` rule `applyChanges` uses). */
  readonly value: number;
}

/** The outcome of an edit: the new full document text, or an honest reason it could not be produced. */
export type EditResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string };

/**
 * Set one config knob on one node and return the re-serialized document. `value` is written verbatim (the caller
 * already validated/parsed it from the InputBox); Improve's quantization lives in `applyChanges`, not here, so a
 * hand-typed inspector value is respected as-is. Fails honestly when the text isn't a valid project or the node
 * doesn't exist — the caller surfaces the message rather than writing a corrupt document.
 */
export function setConfigValue(text: string, node: string, key: string, value: number): EditResult {
  const parsed = deserialize(text);
  if (!parsed.ok) return { ok: false, error: `the design is not valid JSON: ${parsed.error}` };
  const next = withConfig(parsed.value, node, key, value);
  if (!next.ok) return next;
  return { ok: true, text: serialize(next.value) };
}

/**
 * Set one FACT-ASSUMPTION override in a NAMED WORLD (the active-world lens routing — assumption-model §7.1), and
 * return the re-serialized document. The native counterpart to `setConfigValue` when a lens is on: instead of editing
 * the shared base config, the value lands in `doc.scenarios[scenario].overrides` for the active world.
 *
 * Runs through the EXACT @sda/core `setScenarioOverride` command reducer (via `apply`), so the native edit inherits
 * — byte-for-byte — the command's freeze semantics (a manual edit over a live-`derived` value freezes it to
 * `architect`, doc §5.3) and its role boundary (a limit/computed/promise key is refused with the same guided message
 * the canvas + MCP surface). Zero drift: the host can never route a world edit the canvas would reject. Fails honestly
 * on invalid JSON, an undeclared world, or a non-overridable key — the caller surfaces the message.
 */
export function setScenarioOverrideText(text: string, scenario: string, node: string, key: string, value: number): EditResult {
  return applyCommandText(text, { kind: 'setScenarioOverride', scenario, node, key, value });
}

/**
 * Clear one override from a named world (the native un-freeze / remove — assumption-model §5.3), and return the
 * re-serialized document. Through the SAME @sda/core `clearScenarioOverride` reducer, so the native path inherits the
 * command's semantics exactly: clearing a FROZEN (`architect`) override in a derived-trio world UN-FREEZES it back to
 * `derived` tracking (it re-derives from the envelope on the next ambient pass); clearing a hand-authored/derived one
 * REMOVES it (the value falls back to the base layer). Fails honestly when the world or the override does not exist.
 */
export function clearScenarioOverrideText(text: string, scenario: string, node: string, key: string): EditResult {
  return applyCommandText(text, { kind: 'clearScenarioOverride', scenario, node, key });
}

/** Apply ONE @sda/core command to the document text through the pure `apply` reducer, re-serializing on success —
 *  the losslessness + zero-drift path the scenario edits share (the command IS the single source of the semantics).
 *  `knownTypes` is derived from the document; the scenario reducers do not consult it, so it is only a safe default. */
function applyCommandText(text: string, cmd: Command): EditResult {
  const parsed = deserialize(text);
  if (!parsed.ok) return { ok: false, error: `the design is not valid JSON: ${parsed.error}` };
  const knownTypes = new Set(parsed.value.instances.map((i) => i.type));
  const r = apply(parsed.value, cmd, knownTypes);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, text: serialize(r.value.doc) };
}

/**
 * Set (upsert) OR remove one SLO band on one node, and return the re-serialized document. This is the native
 * promise-editing counterpart to `setConfigValue`: the Inspector's "Add/Edit promise" and "Remove
 * promise" both land here. `band === null` REMOVES the band for `key` (leaving no empty artifact — an
 * instance whose last band goes away simply has no `bands` field, which `deserialize` reads back cleanly);
 * a non-null band UPSERTS by key (replacing an existing band for that key, or appending a new one).
 *
 * We round-trip through @sda/core `serialize`/`deserialize` for the SAME reason `setConfigValue` does — and it
 * matters MORE here: a percentile (p99) band's `targets` is a Map, which a naive `JSON.stringify` silently drops.
 * `deserialize` revives the tagged Map on the way in and `serialize` re-tags it on the way out, so writing a
 * tailLatency SLO (and preserving any percentile SLO already on another node) is lossless. Fails honestly when the
 * text isn't a valid project or the node doesn't exist — the caller surfaces the message rather than corrupting the file.
 */
export function setSloText(text: string, node: string, key: string, band: Band | null): EditResult {
  const parsed = deserialize(text);
  if (!parsed.ok) return { ok: false, error: `the design is not valid JSON: ${parsed.error}` };
  const next = withBand(parsed.value, node, key, band);
  if (!next.ok) return next;
  return { ok: true, text: serialize(next.value) };
}

/**
 * Return a copy of `doc` with `node`'s SLO band for `key` upserted (band !== null) or removed (band === null).
 * The instance's `bands` array is rebuilt immutably (the ProjectDoc and its arrays are readonly). Upsert replaces
 * an existing entry for the key in place (preserving order) or appends a new one; removal drops that entry and, if
 * it was the last band, omits the `bands` field entirely so no empty `[]` artifact is written. Mirrors the `setSLO`
 * / `clearSLO` command reducers in @sda/core so a native edit and a canvas edit produce identical documents.
 */
function withBand(doc: ProjectDoc, node: string, key: string, band: Band | null): { ok: true; value: ProjectDoc } | { ok: false; error: string } {
  const inst = doc.instances.find((i) => i.id === node);
  if (inst === undefined) return { ok: false, error: `node "${node}" is not in the design` };
  const priorBands: readonly ManifestBand[] = inst.bands ?? [];
  const kept = priorBands.filter((b) => String(b.key) !== key);
  const nextBands: readonly ManifestBand[] = band === null ? kept : [...kept, { key: Key(key), band }];
  const instances = doc.instances.map((i) => (i.id === node ? withBandsField(i, nextBands) : i));
  return { ok: true, value: { ...doc, instances } };
}

/** Attach a `bands` array to an instance — or OMIT the field when the array is empty (so removing the last SLO
 *  leaves no `"bands": []` artifact, keeping the on-disk doc identical to one that never had a band). */
function withBandsField(inst: ProjectDoc['instances'][number], bands: readonly ManifestBand[]): ProjectDoc['instances'][number] {
  if (bands.length === 0) {
    const { bands: _drop, ...rest } = inst;
    return rest;
  }
  return { ...inst, bands };
}

/**
 * Set (upsert) one SYSTEM-scoped promise (owner ruling: cost is for THE WHOLE SYSTEM), and return the re-serialized
 * document. The native counterpart to the core `setSystemPromise` command — the quantity-first
 * `sda.setSystemRequirement` flow lands here for the system-scoped quantities (v1: cost). Runs through the EXACT
 * @sda/core reducer (via `applyCommandText`), so the native edit inherits the command's semantics byte-for-byte:
 * replace-in-place per key (one system promise per key), the v1 vocabulary guard (a flow/node quantity is refused
 * with the guided message naming the covered set), and the top-level `doc.systemPromises` container — NEVER a node
 * band in disguise. Fails honestly on invalid JSON or an out-of-vocabulary key.
 */
export function setSystemPromiseText(text: string, promise: SystemPromise): EditResult {
  return applyCommandText(text, { kind: 'setSystemPromise', promise });
}

/** Remove one SYSTEM-scoped promise by its key — the clear twin of {@link setSystemPromiseText}, through the SAME
 *  core `clearSystemPromise` reducer (an honest error when none is declared, never a silent no-op). */
export function clearSystemPromiseText(text: string, key: string): EditResult {
  return applyCommandText(text, { kind: 'clearSystemPromise', key });
}

/**
 * Set (upsert) OR remove one per-FLOW guarantee requirement (doc: guarantee-propagation §4), and return the
 * re-serialized document. The native counterpart to the core `setGuaranteeSlo`/`clearGuaranteeSlo` commands — the VS
 * Code guarantee QuickPick (flow → dimension → minimum token) lands here. Unlike an SLO band (per-INSTANCE, numeric),
 * a guarantee requirement is a property of a PATH, so it lives in the TOP-LEVEL `doc.guaranteeSlos` array keyed by
 * the triple (source, terminal, dimension): `slo !== null` UPSERTS by that triple; `slo === null` REMOVES it.
 *
 * Round-trips through @sda/core `serialize`/`deserialize` for the SAME losslessness reason as `setSloText` (a
 * percentile SLO on some node must survive this edit). Endpoint EXISTENCE is NOT enforced (mirroring the core
 * reducer): a requirement whose flow does not yet exist is reported honestly as `unknown` at verdict time, never a
 * silent drop — so a declare-then-wire authoring order is legal. Fails honestly only on invalid JSON.
 */
export function setGuaranteeSloText(text: string, slo: GuaranteeSlo): EditResult {
  const parsed = deserialize(text);
  if (!parsed.ok) return { ok: false, error: `the design is not valid JSON: ${parsed.error}` };
  const doc = parsed.value;
  // Replace-in-place by the (source, terminal, dimension) triple — one requirement per flow per dimension, the same
  // discipline as the core reducer (app/core/src/commands.ts `setGuaranteeSlo`), so native + canvas produce identical docs.
  const kept = (doc.guaranteeSlos ?? []).filter((s) => !(s.source === slo.source && s.terminal === slo.terminal && s.dimension === slo.dimension));
  const guaranteeSlos: readonly GuaranteeSlo[] = [...kept, slo];
  return { ok: true, text: serialize({ ...doc, guaranteeSlos }) };
}

/**
 * Remove one per-FLOW guarantee requirement by its (source, terminal, dimension) triple, and return the re-serialized
 * document. The clear counterpart of `setGuaranteeSloText` (and the twin of the core `clearGuaranteeSlo` command).
 * Fails honestly when no such requirement is declared — so the caller never implies it cleared something that was
 * never there (the tool must not lie about what it did). When the last requirement goes away the `guaranteeSlos`
 * array becomes empty; the round-trip re-serializes it as `[]` (the same shape `emptyProject` writes), which
 * `deserialize` reads back cleanly — so the guarantee feature is silent again with no dangling artifact.
 */
export function clearGuaranteeSloText(text: string, source: string, terminal: string, dimension: string): EditResult {
  const parsed = deserialize(text);
  if (!parsed.ok) return { ok: false, error: `the design is not valid JSON: ${parsed.error}` };
  const doc = parsed.value;
  const before = (doc.guaranteeSlos ?? []).length;
  const guaranteeSlos = (doc.guaranteeSlos ?? []).filter((s) => !(s.source === source && s.terminal === terminal && s.dimension === dimension));
  if (guaranteeSlos.length === before) return { ok: false, error: `no guarantee promise ${dimension} on ${source} → ${terminal} in the design` };
  return { ok: true, text: serialize({ ...doc, guaranteeSlos }) };
}

/**
 * Set (upsert) OR clear one PORT TRANSFORM override on one node (doc: flow-transformations-r2 §4), and return the
 * re-serialized document. The native counterpart to the R1 `setTransform` command: the Inspector's "Set transform"
 * / "Clear transform" both land here. `transform === null` CLEARS the override for `port` (the port falls back to
 * its manifest default / identity); a non-null transform UPSERTS by port name. Round-trips through @sda/core
 * `serialize`/`deserialize` for the same losslessness reason as `setSloText` (a percentile SLO on ANOTHER node must
 * survive this edit). Fails honestly on invalid JSON or an unknown node — never a corrupt write.
 *
 * NOTE: port EXISTENCE is validated at instantiate time (an override naming a missing port surfaces as a build
 * problem there, exactly like the canvas path) — so this edit, like the core reducer, only touches the document.
 */
export function setTransformText(text: string, node: string, port: string, transform: Transform | null): EditResult {
  const parsed = deserialize(text);
  if (!parsed.ok) return { ok: false, error: `the design is not valid JSON: ${parsed.error}` };
  const next = withTransform(parsed.value, node, port, transform);
  if (!next.ok) return next;
  return { ok: true, text: serialize(next.value) };
}

/**
 * Return a copy of `doc` with `node`'s per-instance `transforms[port]` upserted (transform !== null) or removed
 * (transform === null). The `transforms` record is rebuilt immutably; when the last override goes away the field is
 * OMITTED (no empty `"transforms": {}` artifact), the same discipline as `withBandsField`. Mirrors the `setTransform`
 * reducer in @sda/core so a native edit and a canvas edit produce identical documents (one behaviour, two entries).
 */
function withTransform(doc: ProjectDoc, node: string, port: string, transform: Transform | null): { ok: true; value: ProjectDoc } | { ok: false; error: string } {
  const inst = doc.instances.find((i) => i.id === node);
  if (inst === undefined) return { ok: false, error: `node "${node}" is not in the design` };
  const transforms: Record<string, Transform> = { ...(inst.transforms ?? {}) };
  if (transform === null) delete transforms[port];
  else transforms[port] = transform;
  const instances = doc.instances.map((i) => (i.id === node ? withTransformsField(i, transforms) : i));
  return { ok: true, value: { ...doc, instances } };
}

/** Attach a `transforms` record to an instance — or OMIT the field when it is empty (so clearing the last override
 *  leaves no `"transforms": {}` artifact, keeping the on-disk doc identical to one that never had a transform). */
function withTransformsField(inst: ProjectDoc['instances'][number], transforms: Record<string, Transform>): ProjectDoc['instances'][number] {
  if (Object.keys(transforms).length === 0) {
    const { transforms: _drop, ...rest } = inst;
    return rest;
  }
  return { ...inst, transforms };
}

/**
 * Set (upsert) OR clear one per-instance uncertainty RANGE on a config key (doc: uncertainty-monte-carlo §2), from
 * a single "lo-hi" / "lo-mode-hi" text `input`, and return the re-serialized document. The native counterpart to the
 * core `setRange`/`clearRange` commands: the Inspector's "Set/edit range" InputBox lands here. `input` is parsed with
 * the SHARED `parseRangeInput` (the same grammar + `rangeProblem` sanity the web field uses), so:
 *   • a BLANK input CLEARS the range for `key` (the node falls back to its point config value — the base evaluation);
 *   • a well-formed `lo-hi` / `lo-mode-hi` UPSERTS a uniform / triangular range by key;
 *   • a malformed or UNSOUND entry (lo>hi, mode outside [lo,hi]) fails with the GUIDED reason — never a silent clamp.
 *
 * Round-trips through @sda/core `serialize`/`deserialize` for the SAME losslessness reason as `setTransformText` (a
 * percentile SLO on ANOTHER node must survive this edit). Fails honestly on invalid JSON or an unknown node — never a
 * corrupt write. Ranges never change the base forward pass, so this edit is invisible until a Monte-Carlo run samples.
 */
export function setRangeText(text: string, node: string, key: string, input: string): EditResult {
  const parsed = deserialize(text);
  if (!parsed.ok) return { ok: false, error: `the design is not valid JSON: ${parsed.error}` };
  const r = parseRangeInput(input);
  if (r.kind === 'error') return { ok: false, error: r.message };
  const next = withRange(parsed.value, node, key, r.kind === 'clear' ? null : r.range);
  if (!next.ok) return next;
  return { ok: true, text: serialize(next.value) };
}

/**
 * Return a copy of `doc` with `node`'s uncertainty `ranges[key]` upserted (range !== null) or removed (range === null).
 * The `ranges` record is rebuilt immutably; when the last range goes away the field is OMITTED (no empty `"ranges": {}`
 * artifact), the same discipline as `withTransformsField`. Mirrors the `setRange`/`clearRange` reducers in @sda/core so
 * a native edit and a canvas edit produce identical documents. Clearing an absent key is an idempotent no-op.
 */
function withRange(doc: ProjectDoc, node: string, key: string, range: Range | null): { ok: true; value: ProjectDoc } | { ok: false; error: string } {
  const inst = doc.instances.find((i) => i.id === node);
  if (inst === undefined) return { ok: false, error: `node "${node}" is not in the design` };
  const ranges: Record<string, Range> = { ...(inst.ranges ?? {}) };
  if (range === null) delete ranges[key];
  else ranges[key] = range;
  const instances = doc.instances.map((i) => (i.id === node ? withRangesField(i, ranges) : i));
  return { ok: true, value: { ...doc, instances } };
}

/** Attach a `ranges` record to an instance — or OMIT the field when it is empty (so clearing the last range leaves no
 *  `"ranges": {}` artifact, keeping the on-disk doc identical to one that never had a range — the no-filler byte rule). */
function withRangesField(inst: ProjectDoc['instances'][number], ranges: Record<string, Range>): ProjectDoc['instances'][number] {
  if (Object.keys(ranges).length === 0) {
    const { ranges: _drop, ...rest } = inst;
    return rest;
  }
  return { ...inst, ranges };
}

/**
 * Set (upsert) OR clear one per-WIRE transform override (doc: flow-transformations-r2 §5), and return the
 * re-serialized document. The native counterpart to the `setWireTransform` command: a routing split a per-port
 * transform cannot express (one out port, several wires, different shares). The wire is addressed by its from/to
 * port tuples — the SAME stable key the core command uses. `transform === null` CLEARS the override (the wire falls
 * back to the source out-port's transform / identity); a non-null transform UPSERTS it. Round-trips through @sda/core
 * `serialize`/`deserialize` for the same losslessness reason as the other native edits (a percentile SLO on a node
 * must survive this edit). Fails honestly on invalid JSON or an unknown wire — never a corrupt write.
 */
export function setWireTransformText(
  text: string,
  from: readonly [string, string],
  to: readonly [string, string],
  transform: Transform | null,
): EditResult {
  const parsed = deserialize(text);
  if (!parsed.ok) return { ok: false, error: `the design is not valid JSON: ${parsed.error}` };
  const next = withWireTransform(parsed.value, from, to, transform);
  if (!next.ok) return next;
  return { ok: true, text: serialize(next.value) };
}

/**
 * Return a copy of `doc` with the wire (`from` → `to`)'s `transform` upserted (transform !== null) or removed
 * (transform === null). The wire is matched by both endpoint port tuples; when the override is cleared the field is
 * OMITTED (no `"transform": null` artifact), the same discipline as `withTransformsField`. Mirrors the
 * `setWireTransform` reducer in @sda/core so a native edit and a canvas edit produce identical documents.
 */
function withWireTransform(
  doc: ProjectDoc,
  from: readonly [string, string],
  to: readonly [string, string],
  transform: Transform | null,
): { ok: true; value: ProjectDoc } | { ok: false; error: string } {
  let found = false;
  const wires = doc.wires.map((w) => {
    if (w.from[0] === from[0] && w.from[1] === from[1] && w.to[0] === to[0] && w.to[1] === to[1]) {
      found = true;
      if (transform === null) {
        const { transform: _drop, ...rest } = w;
        return rest;
      }
      return { ...w, transform };
    }
    return w;
  });
  if (!found) return { ok: false, error: `no wire ${from[0]}.${from[1]} → ${to[0]}.${to[1]} in the design` };
  return { ok: true, value: { ...doc, wires } };
}

/**
 * Apply several solved knob changes as ONE re-serialization (the Improve "Apply") — all-or-nothing, so a single
 * native undo restores the whole prior design (never a half-applied hybrid the user never chose). Each value is
 * QUANTIZED to what is deployable via `quantizeKnob` (whole-unit knobs — concurrency/replicas/maxUnits — ceil UP,
 * so we never under-provision below the solver's continuous optimum; others round to 2 dp). An unknown node in a
 * change fails the whole batch honestly rather than silently skipping it (the tool must not lie about what it did).
 */
export function applyChanges(text: string, changes: readonly KnobChange[]): EditResult {
  const parsed = deserialize(text);
  if (!parsed.ok) return { ok: false, error: `the design is not valid JSON: ${parsed.error}` };
  let doc = parsed.value;
  for (const c of changes) {
    const quantized = quantizeKnob(c.key, c.to);
    const next = withConfig(doc, c.node, c.key, quantized);
    if (!next.ok) return next;
    doc = next.value;
  }
  return { ok: true, text: serialize(doc) };
}

/**
 * Return a copy of `doc` with `node`.config[`key`] = `value` (adding the config object / the key if absent).
 * The instance is replaced immutably — the ProjectDoc and its arrays are readonly, so we never mutate in place.
 * Mirrors the `setConfig` command reducer in @sda/core so the native edit and a canvas edit produce identical
 * documents (one behaviour, two entry points).
 */
function withConfig(doc: ProjectDoc, node: string, key: string, value: number): { ok: true; value: ProjectDoc } | { ok: false; error: string } {
  const inst = doc.instances.find((i) => i.id === node);
  if (inst === undefined) return { ok: false, error: `node "${node}" is not in the design` };
  const instances = doc.instances.map((i) => (i.id === node ? { ...i, config: { ...(i.config ?? {}), [key]: value } } : i));
  return { ok: true, value: { ...doc, instances } };
}

// ── Per-change ranges (native refactor preview) ──────────────────────────────────────────────────────────────
//
// The native refactor-preview flow needs the EXACT text span of each knob's current value in the ON-DISK JSON, so
// it can offer ONE tickable TextEdit per change (rather than one opaque whole-document replacement). That means
// locating `"<key>": <number>` INSIDE the right instance's object — a knob that appears on two nodes must resolve
// within the node whose `"id"` matches. We do this lexically on the exact document text (never a re-serialization)
// so the offered range lands on the character the user sees; a hand-mangled document where a range can't be found
// returns null and the caller falls back HONESTLY to the whole-document path for ALL changes (never a half mix).

/**
 * Locate the value span of each change's `"<key>": <number>` within its OWN instance object, and quantize the
 * target with the same rule `applyChanges` uses. Returns null if ANY change cannot be located (the caller then
 * takes the whole-document fallback) — all-or-nothing, so the preview never shows a partial set that would apply
 * a different edit than the user believes. Only knobs whose current value is a JSON NUMBER are handled (config
 * values are numbers); a key absent from the instance, or present only as a string, yields null.
 */
export function changeRanges(text: string, changes: readonly KnobChange[]): readonly RangeEdit[] | null {
  const out: RangeEdit[] = [];
  for (const c of changes) {
    const block = instanceBlockBounds(text, c.node);
    if (block === null) return null; // node's object not found in the text (hand-edited / minified beyond recognition)
    const span = numberValueSpan(text, c.key, block.start, block.end);
    if (span === null) return null; // the key is not a numeric member of THIS instance object
    out.push({ change: c, start: span.start, end: span.end, value: quantizeKnob(c.key, c.to) });
  }
  return out;
}

/** The half-open character bounds [start, end) of the JSON object that declares `"id": "<node>"`: from its opening
 *  `{` to the matching `}` (brace-depth scan, string-aware). Null when the id is absent. Used to scope a knob
 *  search to ONE instance so a key shared by two nodes resolves within the correct block. */
function instanceBlockBounds(text: string, node: string): { readonly start: number; readonly end: number } | null {
  const idMatch = new RegExp(idPairPattern(node)).exec(text);
  if (idMatch === null) return null;
  // The object's opening brace is the LAST `{` before the `"id"` member (members are unordered, so `"id"` may not
  // be first). Walk back over whitespace/other members to the brace that opens this object — a depth scan from the
  // id position backwards: the first `{` we reach at net depth 0 (having closed any nested objects/arrays we pass).
  const open = openingBraceBefore(text, idMatch.index);
  if (open === null) return null;
  const close = matchingBrace(text, open);
  if (close === null) return null;
  return { start: open, end: close + 1 }; // end is exclusive
}

/** Scan backwards from `idx` to the `{` that opens the object the id belongs to (net brace/bracket depth 0),
 *  ignoring braces inside strings. Null if none found (malformed text). */
function openingBraceBefore(text: string, idx: number): number | null {
  let depth = 0;
  let inString = false;
  for (let i = idx - 1; i >= 0; i--) {
    const ch = text[i]!;
    // Detect a string boundary by an unescaped quote (count preceding backslashes for oddness).
    if (ch === '"' && !isEscaped(text, i)) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '}' || ch === ']') depth++;
    else if (ch === '{' || ch === '[') {
      if (depth === 0) return ch === '{' ? i : null; // reached this object's own opener; a `[` here means we mis-scanned
      depth--;
    }
  }
  return null;
}

/** The index of the `}` that matches the `{` at `open` (string-aware depth scan forward). Null if unbalanced. */
function matchingBrace(text: string, open: number): number | null {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' && !isEscaped(text, i)) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/** The span [start, end) of the NUMBER that is the value of `"<key>"` within [from, to). We match the key as a
 *  JSON member (`"key"` then `:` then a number) so it never matches the same token used as an array element or a
 *  string value. Null when the key is absent in this range or its value is not a number. */
function numberValueSpan(text: string, key: string, from: number, to: number): { readonly start: number; readonly end: number } | null {
  const slice = text.slice(from, to);
  // `"key"` : <number> — the number may be integer, decimal, signed, or exponential. We capture only the number's
  // span; the `:` and surrounding whitespace are consumed but excluded from the returned range.
  const re = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`);
  const m = re.exec(slice);
  if (m === null || m.index === undefined) return null;
  const numStart = from + m.index + m[0].length - m[1]!.length;
  return { start: numStart, end: numStart + m[1]!.length };
}

/** True when the character at `i` is escaped by an ODD number of immediately-preceding backslashes. */
function isEscaped(text: string, i: number): boolean {
  let backslashes = 0;
  for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) backslashes++;
  return backslashes % 2 === 1;
}
