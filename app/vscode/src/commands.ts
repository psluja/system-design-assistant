import * as vscode from 'vscode';
import { deserialize } from '@sda/core';
import type { H2W, KnobRow } from './protocol';
import type { ActiveEditorRegistry, ActiveEditorState } from './active-editor';
import { applyChanges, changeRanges, setConfigValue, setScenarioOverrideText, clearScenarioOverrideText, setSloText, setSystemPromiseText, setTransformText, setWireTransformText, setGuaranteeSloText, clearGuaranteeSloText, setRangeText, type KnobChange, type RangeEdit } from './document-edits';
import { knobOverridable } from './scenario-lens';
import { runResetScenario } from './scenario-host';
import { costPromise, requestFlows, type GuaranteeSlo, type ValueFn } from '@sda/content';
import { requirementOptions, parseRangeInput, formatRange, formatRangeInput, RANGE_INPUT_FORMS } from '@sda/presenter';
import { configKnobsFor, rangeRowsFor } from './ranges';
import { evaluateText } from './host-eval';
import { runSolve, type SolveRequest } from './solver-host';
import { runCompare, swapTypeText, type CompareOption } from './compare-host';
import { isDimensionlessUnit } from './pure';
import { SLO_REQUIREMENTS, requirementForKey, systemQuantityForKey, systemCostQuantity, sloRowsFor, type SloRequirement } from './slo-requirements';
import { TRANSFORM_KINDS, transformParamOf, validateTransformValue, portRowsFor, wireRowsFor, formatTransform, parseGeneratorInput, formatGeneratorInput, presetGeneratorInput, GENERATOR_PRESETS, type TransformKind } from './port-transforms';
import type { LoadStagePreset } from '@sda/content';
import type { Transform } from '@sda/engine-core';
import { replaceWholeDocument } from './document-write';
import { buildDesignDocText } from './design-doc-host';
import { writeDesignDocBesideSource } from './doc-command';

// The NATIVE command surface — the rework's heart. Every view except the canvas is a native control, so every
// DATA action (add / edit knob / improve / suggest / reveal) is a native VS Code flow here, editing the document
// HOST-side (native undo) or telling the canvas to do the geometry. Commands read the active editor from the
// registry; when none is active they say so honestly rather than failing silently. `applyDocumentEdit` is the
// ONE place a host-initiated edit reaches the document — see its note for the echo-guard contract the webview
// side must honour.

/** Register every native command and return the disposables (the caller pushes them onto context.subscriptions). */
export function registerCommands(active: ActiveEditorRegistry): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('sda.addComponent', (type: unknown) => addComponent(active, type)),
    vscode.commands.registerCommand('sda.revealNode', (node: unknown) => revealNode(active, node)),
    vscode.commands.registerCommand('sda.editKnob', (arg: unknown) => editKnob(active, arg)),
    vscode.commands.registerCommand('sda.clearScenarioOverride', (arg: unknown) => clearScenarioOverride(active, arg)),
    vscode.commands.registerCommand('sda.resetScenario', (arg: unknown) => resetScenario(active, arg)),
    vscode.commands.registerCommand('sda.setSlo', (arg: unknown) => setSlo(active, arg)),
    // The COMMAND ID keeps the historical `setSystemRequirement` name: ids are identifiers (stable API for
    // keybindings/automation), not human words. The human word for the band kind is "promise" everywhere —
    // the package.json TITLE says "Add Promise" (owner ruling: ONE form with the node — no scope in the verb).
    vscode.commands.registerCommand('sda.setSystemRequirement', (arg: unknown) => setSystemRequirement(active, arg)),
    vscode.commands.registerCommand('sda.removeSlo', (arg: unknown) => removeSlo(active, arg)),
    vscode.commands.registerCommand('sda.setGuaranteeSlo', (arg: unknown) => setGuaranteeSlo(active, arg)),
    vscode.commands.registerCommand('sda.clearGuaranteeSlo', (arg: unknown) => clearGuaranteeSlo(active, arg)),
    vscode.commands.registerCommand('sda.setPortTransform', (arg: unknown) => setPortTransform(active, arg)),
    vscode.commands.registerCommand('sda.clearPortTransform', (arg: unknown) => clearPortTransform(active, arg)),
    vscode.commands.registerCommand('sda.setWireTransform', (arg: unknown) => setWireTransform(active, arg)),
    vscode.commands.registerCommand('sda.setRange', (arg: unknown) => setRange(active, arg)),
    vscode.commands.registerCommand('sda.clearRange', (arg: unknown) => clearRange(active, arg)),
    vscode.commands.registerCommand('sda.suggest', (arg: unknown) => suggest(active, arg)),
    vscode.commands.registerCommand('sda.idealLayout', () => idealLayout(active)),
    vscode.commands.registerCommand('sda.improve', () => improve(active)),
    vscode.commands.registerCommand('sda.compareOptions', () => compareOptions(active)),
    vscode.commands.registerCommand('sda.generateDesignDoc', (arg: unknown) => generateDesignDoc(active, arg)),
  ];
}

/** The active editor, or undefined after showing an honest "open a design first" warning. */
function requireActive(active: ActiveEditorRegistry, action: string): ActiveEditorState | undefined {
  const state = active.current;
  if (state === undefined) {
    void vscode.window.showWarningMessage(`SDA: open a .sda.json design first — there is no active design to ${action}.`);
    return undefined;
  }
  return state;
}

/** Post an H2W message to the active editor's canvas. */
function post(state: ActiveEditorState, message: H2W): void {
  void state.webview.postMessage(message);
}

// ── Components palette → canvas ──────────────────────────────────────────────────────────────────────────────

/** Palette click: forward the chosen component type to the canvas, which picks a free spot and places it. The
 *  argument is the raw type id (row `command`) OR the tree element `{ kind:'type', type }` (the inline $(add)). */
function addComponent(active: ActiveEditorRegistry, arg: unknown): void {
  const type = asComponentType(arg);
  if (type === undefined) return; // defensive: only ever invoked by the tree with a type id
  const state = requireActive(active, 'add a component to');
  if (state === undefined) return;
  post(state, { type: 'addComponent', comp: type });
}

/** Coerce `sda.addComponent`'s argument to a type id: a bare string (row click) or the palette tree element. */
function asComponentType(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'object' && arg !== null) {
    const t = (arg as { type?: unknown }).type;
    if (typeof t === 'string') return t;
  }
  return undefined;
}

/** Inspector "reveal" / a future Problems jump: mirror the native selection onto the canvas. The argument is the
 *  raw node id OR the Inspector header tree element `{ kind:'node', detail }` (the inline $(target) action). */
function revealNode(active: ActiveEditorRegistry, arg: unknown): void {
  const node = asNodeId(arg);
  if (node === undefined) return;
  const state = requireActive(active, 'reveal a node in');
  if (state === undefined) return;
  post(state, { type: 'select', node });
}

/** Coerce `sda.revealNode`'s argument to a node id: a bare string or the Inspector header element `{ detail }`. */
function asNodeId(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'object' && arg !== null) {
    const detail = (arg as { detail?: { node?: unknown } }).detail;
    if (detail !== undefined && typeof detail.node === 'string') return detail.node;
  }
  return undefined;
}

// ── Inspector: edit a knob (native InputBox → host document edit → native undo) ──────────────────────────────

/** The argument the Inspector's knob leaf passes to `sda.editKnob`. */
interface EditKnobArg {
  readonly node: string;
  readonly knob: KnobRow;
}

function isEditKnobArg(arg: unknown): arg is EditKnobArg {
  if (typeof arg !== 'object' || arg === null) return false;
  const a = arg as { node?: unknown; knob?: unknown };
  if (typeof a.node !== 'string' || typeof a.knob !== 'object' || a.knob === null) return false;
  const k = a.knob as { key?: unknown; value?: unknown };
  return typeof k.key === 'string' && typeof k.value === 'number';
}

/**
 * Edit one config value: prompt with a native InputBox (validated numeric), then apply the change to the
 * document HOST-side so VS Code gives native undo. The InputBox seeds with the current value; a non-numeric or
 * empty entry is rejected inline; cancelling changes nothing.
 *
 * THE ACTIVE-WORLD LENS (assumption-model §7.1 — the consistency religion): when a world is the active lens AND this
 * knob is a fact-assumption (an overridable belief — offered load, a service time, a source client's throughput), the
 * edit lands INTO that world's overrides, NOT the shared base — exactly like the web shell's `commitConfig`, and with
 * the SAME freeze semantics (a manual edit over a live-derived value freezes it). A limit/computed knob is never a
 * world belief, so it always edits the base. The knob's seeded value is already the world's value (the Inspector
 * overlaid it), so re-editing pre-fills what the canvas shows. One form: what you see is what you edit.
 */
async function editKnob(active: ActiveEditorRegistry, arg: unknown): Promise<void> {
  if (!isEditKnobArg(arg)) return;
  const state = requireActive(active, 'edit');
  if (state === undefined) return;
  const { node, knob } = arg;

  const text = state.document.getText();
  // Route INTO the active world when a lens is on and this knob is a fact-assumption the scenario may legally override
  // (the SAME structural boundary the command core enforces). Else edit the shared base, as before.
  const world = state.activeScenario !== undefined && knobOverridable(text, node, knob.key) ? state.activeScenario : undefined;

  const unit = isDimensionlessUnit(knob.unit) ? '' : ` (${knob.unit})`;
  const input = await vscode.window.showInputBox({
    title: world !== undefined ? `Edit ${knob.label} · world "${world}"` : `Edit ${knob.label}`,
    prompt: world !== undefined ? `${knob.label}${unit} for ${node} in the "${world}" world (writes into that world, not the base)` : `${knob.label}${unit} for ${node}`,
    value: String(knob.value),
    validateInput: (raw) => {
      const n = Number(raw.trim());
      if (raw.trim() === '' || Number.isNaN(n)) return 'Enter a number.';
      if (!Number.isFinite(n)) return 'Enter a finite number.';
      return undefined;
    },
  });
  if (input === undefined) return; // cancelled

  const value = Number(input.trim());
  const edit = world !== undefined ? setScenarioOverrideText(text, world, node, knob.key, value) : setConfigValue(text, node, knob.key, value);
  if (!edit.ok) {
    void vscode.window.showErrorMessage(`SDA: could not edit ${knob.label} — ${edit.error}`);
    return;
  }
  await applyDocumentEdit(state.document, edit.text);
}

/** The (node, key) the Inspector's knob "clear override" inline action targets — the tree ELEMENT `{ kind:'knob',
 *  node, knob:{ key } }`, or our own `{ node, key }` shape. */
function asKnobKeyArg(arg: unknown): { node?: string; key?: string } {
  if (typeof arg === 'object' && arg !== null) {
    const a = arg as { node?: unknown; key?: unknown; knob?: { key?: unknown } };
    const key = typeof a.key === 'string' ? a.key : typeof a.knob?.key === 'string' ? a.knob.key : undefined;
    return { ...(typeof a.node === 'string' ? { node: a.node } : {}), ...(key !== undefined ? { key } : {}) };
  }
  return {};
}

/**
 * Clear a knob's ACTIVE-WORLD override (the native un-freeze / remove — assumption-model §5.3), the twin of the web
 * Inspector's ↺ control. Only meaningful under a lens: it removes the override from the ACTIVE world, so the knob
 * falls back to its base value (or, on a FROZEN derived-trio value, un-freezes back to live derived tracking — the
 * @sda/core reducer decides). No active world, or no override on this knob, → an honest message rather than a no-op.
 */
async function clearScenarioOverride(active: ActiveEditorRegistry, arg: unknown): Promise<void> {
  const state = requireActive(active, 'clear a world override on');
  if (state === undefined) return;
  const world = state.activeScenario;
  if (world === undefined) {
    void vscode.window.showInformationMessage('SDA: no world is the active lens — a world override is cleared while viewing that world (pick a world in the canvas).');
    return;
  }
  const { node, key } = asKnobKeyArg(arg);
  if (node === undefined || key === undefined) return;

  const edit = clearScenarioOverrideText(state.document.getText(), world, node, key);
  if (!edit.ok) {
    void vscode.window.showErrorMessage(`SDA: could not clear the world override — ${edit.error}`);
    return;
  }
  await applyDocumentEdit(state.document, edit.text);
}

/**
 * RESET a named world (the "reset means reset" affordance — assumption-model §5.3), fully native: pick the world (a
 * QuickPick of the design's declared worlds, defaulting to the active lens) → run the reset HOST-side → apply as ONE
 * WorkspaceEdit (a single native undo). The reset is the NON-preserving twin of derive/✨: a derived-trio world is
 * wiped back to its freshly-derived values (any frozen number the architect typed is dropped, re-tracking the
 * envelope); a CUSTOM world has its overrides cleared (it falls back to base). The heavy lift (envelope + derive) runs
 * host-side via a throwaway Studio + the same solver bindings Improve/Compare use. Honest throughout — no worlds → a
 * message; a solver/parse failure → its own words.
 */
async function resetScenario(active: ActiveEditorRegistry, arg: unknown): Promise<void> {
  const state = requireActive(active, 'reset a world for');
  if (state === undefined) return;

  const parsed = deserialize(state.document.getText());
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(`SDA: the design is not valid — ${parsed.error}`);
    return;
  }
  const scenarios = parsed.value.scenarios;
  if (scenarios.length === 0) {
    void vscode.window.showInformationMessage('SDA: no named worlds are declared to reset — derive the trio first (✨ Worlds on the canvas).');
    return;
  }

  // A pre-scoped id (a future row action) is honoured; otherwise pick, defaulting to the active lens.
  const preId = typeof arg === 'string' ? arg : typeof arg === 'object' && arg !== null ? (arg as { id?: unknown }).id : undefined;
  let id = typeof preId === 'string' && scenarios.some((s) => s.id === preId) ? preId : undefined;
  if (id === undefined) {
    const activeId = state.activeScenario;
    const items = scenarios
      .map((s) => ({ label: s.name ?? s.id, description: s.id === activeId ? '$(check) active lens' : s.id, id: s.id }))
      .sort((a, b) => (a.id === activeId ? -1 : b.id === activeId ? 1 : 0));
    const pick = await vscode.window.showQuickPick(items, { title: 'SDA: Reset a world — wipe its overrides', placeHolder: 'A trio world resets to freshly-derived; a custom world clears to base' });
    if (pick === undefined) return; // cancelled
    id = pick.id;
  }

  const worldId = id; // narrowed to string — a const so the withProgress closure captures it cleanly
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `SDA: resetting "${worldId}"…`, cancellable: false },
    () => runResetScenario(state.document.getText(), worldId),
  );
  if (!result.ok) {
    void vscode.window.showErrorMessage(`SDA: could not reset "${worldId}" — ${result.error}`);
    return;
  }
  await applyDocumentEdit(state.document, result.text);
  void vscode.window.showInformationMessage(`SDA: ${result.note}`);
}

// ── Inspector: set / remove an SLO promise (native QuickPick → InputBox → host document edit) ────────────

/** The optional argument `sda.setSlo` accepts to PRE-TARGET a node/key (the Inspector's row/add actions pass it).
 *  A bare string is treated as the node id; the tree elements pass `{ node, key? }`. `key` pre-selects the
 *  promise (an Edit on an existing SLO row); its absence means "ask which promise" (the + Add row). */
interface SetSloArg {
  readonly node?: string;
  readonly key?: string;
}

function asSetSloArg(arg: unknown): SetSloArg {
  if (typeof arg === 'string') return { node: arg };
  if (typeof arg === 'object' && arg !== null) {
    // Two shapes reach here: our command's own `{ node, key? }` arg (from the row's `command`), and the tree ELEMENT
    // that VS Code hands a `view/item/context` inline action — `{ kind:'slo', node, row:{ key } }` for the pencil/
    // trash, or `{ kind:'addSlo', node }` for the + row. Resolve the key from either `key` or `row.key`.
    const a = arg as { node?: unknown; key?: unknown; row?: { key?: unknown } };
    const key = typeof a.key === 'string' ? a.key : typeof a.row?.key === 'string' ? a.row.key : undefined;
    return {
      ...(typeof a.node === 'string' ? { node: a.node } : {}),
      ...(key !== undefined ? { key } : {}),
    };
  }
  return {};
}

/**
 * State (add or edit) one SLO promise on a node, fully native: pick the TARGET node (a QuickPick of the
 * design's instances, defaulting to the current selection) → pick the promise (throughput ≥ · latency ≤ ·
 * availability ≥ · cost ≤ · p99 tail ≤) → enter the value in a validated InputBox → build the band and apply it
 * HOST-side (so VS Code owns native undo). Any step cancelled leaves the design untouched. Honest throughout: no
 * design → an "open a design first" message; an unreadable design → we don't invent a node list.
 *
 * Called two ways: from the Inspector (the "+ Add promise…" row, or an existing SLO's pencil which pre-targets
 * the node AND the key) and from the command palette (nothing pre-scoped — the user picks everything). A pre-set
 * key seeds the promise so re-editing an existing SLO skips straight to the value.
 */
async function setSlo(active: ActiveEditorRegistry, arg: unknown): Promise<void> {
  const state = requireActive(active, 'set a promise on');
  if (state === undefined) return;
  const scoped = asSetSloArg(arg);

  const node = await pickNode(state, scoped.node, 'Set a promise — pick the target node');
  if (node === undefined) return; // cancelled or no design

  // Resolve the promise: honour a pre-set key (an Edit on an existing row); otherwise ask.
  const req = scoped.key !== undefined ? requirementForKey(scoped.key) : await pickRequirement();
  if (req === undefined) return; // cancelled, or a pre-set key we don't offer (defensive)

  const value = await promptSloValue(node, req);
  if (value === undefined) return; // cancelled

  const band = req.build(value);
  const edit = setSloText(state.document.getText(), node, req.key, band);
  if (!edit.ok) {
    void vscode.window.showErrorMessage(`SDA: could not set the ${req.label} promise — ${edit.error}`);
    return;
  }
  await applyDocumentEdit(state.document, edit.text);
}

// ── System: add a promise (the system/flow twin of the node's Promises — the web System panel's Promises blocks) ──

/**
 * State the whole-system promise, fully native (owner ruling: the system 'Add promise…' offers ONLY cost — the
 * whole-design sum). Because there is exactly ONE quantity, the command AUTO-SELECTS it (no quantity pick),
 * mirroring how the node flow pre-targets its node: it goes straight to the value prompt and lands in the top-level
 * `doc.systemPromises` via `setSystemPromiseText` (the shared content `costPromise` form). NO flow is asked — the
 * quantity is global (every component summed, off-path branches included). throughput / latency / availability are
 * JOURNEY quantities that belong on a NODE — set through the node promise flow (`sda.setSlo`); an end-to-end
 * availability promise is simply an `availability` band on the flow's terminal.
 *
 * Called from the System view ("+ Add promise…" row / view title), the command palette, or with a pre-set `{ key }`
 * (a row edit) — all resolve to the cost quantity.
 */
async function setSystemRequirement(active: ActiveEditorRegistry, arg: unknown): Promise<void> {
  const state = requireActive(active, 'set a promise on');
  if (state === undefined) return;
  const text = state.document.getText();

  // ONE quantity only — a pre-set key (a row edit) is honoured, otherwise cost is auto-selected (no pick).
  const scopedKey = typeof arg === 'object' && arg !== null && typeof (arg as { key?: unknown }).key === 'string' ? (arg as { key: string }).key : undefined;
  const q = scopedKey !== undefined ? systemQuantityForKey(scopedKey) : systemCostQuantity();
  if (q === undefined) return; // defensive: a pre-set key we don't offer

  // The value prompt names the whole system; the promise lands in doc.systemPromises through the core reducer
  // (native undo). No flow is asked — the quantity is global (every component summed, off-path branches included).
  const value = await promptSloValue('the whole system', q);
  if (value === undefined) return; // cancelled
  const edit = setSystemPromiseText(text, costPromise(value));
  if (!edit.ok) {
    void vscode.window.showErrorMessage(`SDA: could not set the whole-system ${q.label} promise — ${edit.error}`);
    return;
  }
  await applyDocumentEdit(state.document, edit.text);
  void vscode.window.showInformationMessage(`SDA: promise set — Cost ${q.cmp} ${value} ${q.unit} · whole system (every component summed, off-path branches included).`);
}

/**
 * Remove one SLO promise from a node, fully native: pick the TARGET node (defaulting to the selection) → pick
 * which of that node's existing promises to drop → apply the removal HOST-side (native undo). A node with no
 * promises says so honestly rather than showing an empty picker. Called from the Inspector's trash action
 * (which pre-targets the node + key, skipping straight to the apply) or the palette (pick both).
 */
async function removeSlo(active: ActiveEditorRegistry, arg: unknown): Promise<void> {
  const state = requireActive(active, 'remove a promise from');
  if (state === undefined) return;
  const scoped = asSetSloArg(arg);

  const node = await pickNode(state, scoped.node, 'Remove a promise — pick the node');
  if (node === undefined) return; // cancelled or no design

  const rows = sloRowsFor(state.document.getText(), node);
  if (rows.length === 0) {
    void vscode.window.showInformationMessage(`SDA: ${node} has no promises to remove.`);
    return;
  }

  // A pre-set key (the inline trash action) targets one row directly; otherwise let the user pick which to drop.
  let key = scoped.key !== undefined && rows.some((r) => r.key === scoped.key) ? scoped.key : undefined;
  if (key === undefined) {
    const pick = await vscode.window.showQuickPick(
      rows.map((r) => ({ label: r.label, key: r.key })),
      { title: `Remove a promise from ${node}`, placeHolder: 'Pick the promise to remove' },
    );
    if (pick === undefined) return; // cancelled
    key = pick.key;
  }

  const edit = setSloText(state.document.getText(), node, key, null);
  if (!edit.ok) {
    void vscode.window.showErrorMessage(`SDA: could not remove the promise — ${edit.error}`);
    return;
  }
  await applyDocumentEdit(state.document, edit.text);
}

// ── Guarantee promises (per-flow, doc: guarantee-propagation §4) ──────────────────────────────────────────────
//
// The categorical twin of setSlo/removeSlo. A guarantee is a property of a PATH (source→terminal), so the target is
// a FLOW, not a node — the QuickPick chain is flow → dimension → minimum token, then the edit lands in the top-level
// doc.guaranteeSlos via `setGuaranteeSloText` (native undo). Dimensions + tokens come from the SHARED presenter
// `requirementOptions()` (the SAME outsider-legible vocabulary the web renders), so the two shells offer identical choices.

/** The optional argument the guarantee commands accept to PRE-TARGET a flow + dimension (a System-tree/Problems row
 *  action passes it). A bare string is unused; the tree/rows pass `{ source, terminal, dimension? }`. */
interface GuaranteeArg {
  readonly source?: string;
  readonly terminal?: string;
  readonly dimension?: string;
}
function asGuaranteeArg(arg: unknown): GuaranteeArg {
  if (typeof arg === 'object' && arg !== null) {
    const a = arg as { source?: unknown; terminal?: unknown; dimension?: unknown; row?: { source?: unknown; terminal?: unknown; dimension?: unknown } };
    const src = typeof a.source === 'string' ? a.source : typeof a.row?.source === 'string' ? a.row.source : undefined;
    const term = typeof a.terminal === 'string' ? a.terminal : typeof a.row?.terminal === 'string' ? a.row.terminal : undefined;
    const dim = typeof a.dimension === 'string' ? a.dimension : typeof a.row?.dimension === 'string' ? a.row.dimension : undefined;
    return { ...(src !== undefined ? { source: src } : {}), ...(term !== undefined ? { terminal: term } : {}), ...(dim !== undefined ? { dimension: dim } : {}) };
  }
  return {};
}

/**
 * Declare (add or edit) one per-FLOW guarantee promise, fully native: pick the FLOW (a QuickPick of the design's
 * request flows source→terminal) → pick the DIMENSION (consistency / ordering / delivery, from the shared
 * `requirementOptions`) → pick the minimum TOKEN (strongest→weakest, each with its outsider-legible gloss) → apply
 * HOST-side (native undo). Any step cancelled leaves the design untouched. The flow list comes from `requestFlows`
 * over a host evaluation (the SAME flows the System panel shows); a design that does not build falls back to picking
 * any two connected nodes, so a promise can still be declared before every knob is set.
 */
async function setGuaranteeSlo(active: ActiveEditorRegistry, arg: unknown): Promise<void> {
  const state = requireActive(active, 'set a guarantee promise on');
  if (state === undefined) return;
  const scoped = asGuaranteeArg(arg);

  const flow = await pickFlow(state, scoped);
  if (flow === undefined) return; // cancelled or no flow

  const dimension = await pickGuaranteeDimension(scoped.dimension);
  if (dimension === undefined) return; // cancelled

  const atLeast = await pickGuaranteeToken(dimension);
  if (atLeast === undefined) return; // cancelled

  const slo: GuaranteeSlo = { source: flow.source, terminal: flow.terminal, dimension: dimension.dimension, atLeast };
  const edit = setGuaranteeSloText(state.document.getText(), slo);
  if (!edit.ok) {
    void vscode.window.showErrorMessage(`SDA: could not set the guarantee promise — ${edit.error}`);
    return;
  }
  await applyDocumentEdit(state.document, edit.text);
}

/**
 * Remove one per-FLOW guarantee promise, fully native: pick which declared promise to drop (a QuickPick of
 * the design's `guaranteeSlos`, each shown as "<flow> · <dimension> ≥ <token>") → apply the removal HOST-side. A
 * design with no declared guarantee promises says so honestly rather than showing an empty picker. A pre-scoped
 * triple (a row action) skips straight to the apply.
 */
async function clearGuaranteeSlo(active: ActiveEditorRegistry, arg: unknown): Promise<void> {
  const state = requireActive(active, 'clear a guarantee promise from');
  if (state === undefined) return;
  const scoped = asGuaranteeArg(arg);

  const parsed = deserialize(state.document.getText());
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(`SDA: the design is not valid — ${parsed.error}`);
    return;
  }
  const slos = parsed.value.guaranteeSlos;
  if (slos.length === 0) {
    void vscode.window.showInformationMessage('SDA: no guarantee promises are declared to remove.');
    return;
  }

  // A fully pre-scoped triple (a row's inline trash) targets one promise directly; otherwise let the user pick.
  let target: GuaranteeSlo | undefined =
    scoped.source !== undefined && scoped.terminal !== undefined && scoped.dimension !== undefined
      ? slos.find((s) => s.source === scoped.source && s.terminal === scoped.terminal && s.dimension === scoped.dimension)
      : undefined;
  if (target === undefined) {
    const pick = await vscode.window.showQuickPick(
      slos.map((s) => ({ label: `${s.source} → ${s.terminal}`, description: `${s.dimension} ≥ ${s.atLeast}`, slo: s })),
      { title: 'Remove a guarantee promise', placeHolder: 'Pick the promise to remove' },
    );
    if (pick === undefined) return; // cancelled
    target = pick.slo;
  }

  const edit = clearGuaranteeSloText(state.document.getText(), target.source, target.terminal, target.dimension);
  if (!edit.ok) {
    void vscode.window.showErrorMessage(`SDA: could not remove the guarantee promise — ${edit.error}`);
    return;
  }
  await applyDocumentEdit(state.document, edit.text);
}

/** A flow the guarantee promise can target: its source + terminal node ids (the promise's key). */
interface FlowChoice {
  readonly source: string;
  readonly terminal: string;
}

/**
 * Resolve the FLOW a guarantee promise targets. A fully pre-scoped (source, terminal) is honoured as-is. Else we
 * offer a QuickPick of the design's request flows (`requestFlows` over a host evaluation — the SAME flows the System
 * panel shows). When the design does not build (so there is no solved flow list), we fall back to a two-step
 * source→terminal node pick, so a promise can be declared BEFORE every capacity knob is set (it reads `unknown`
 * until wired, never a silent drop). Returns the chosen flow, or undefined when cancelled / nothing to pick.
 */
async function pickFlow(state: ActiveEditorState, scoped: GuaranteeArg): Promise<FlowChoice | undefined> {
  if (scoped.source !== undefined && scoped.terminal !== undefined) return { source: scoped.source, terminal: scoped.terminal };

  const text = state.document.getText();
  const parsed = deserialize(text);
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(`SDA: the design is not valid — ${parsed.error}`);
    return undefined;
  }
  const { instances, wires } = parsed.value;
  if (instances.length === 0) {
    void vscode.window.showInformationMessage('SDA: add and connect components first — there is no flow to set a guarantee on.');
    return undefined;
  }

  // The real request flows (source→terminal), from a host evaluation — the SAME decomposition the System panel and
  // the guarantee verdicts use. When the design does not build we get none and fall back to the raw node pick below.
  const ev = evaluateText(text);
  const value: ValueFn | undefined = ev ? (id, k) => ev.value(id, k) : undefined;
  const flows = value ? requestFlows(instances, wires, value) : [];
  if (flows.length > 0) {
    const selected = state.selection ?? state.detail?.node ?? undefined;
    const items = flows.map((f) => ({
      label: `${f.source} → ${f.terminal}`,
      ...(f.source === selected || f.terminal === selected ? { description: '$(check) involves the selected node' } : {}),
      flow: { source: f.source, terminal: f.terminal } as FlowChoice,
    }));
    const pick = await vscode.window.showQuickPick(items, { title: 'Set a guarantee promise — pick the flow', placeHolder: 'Pick the request flow (source → terminal)' });
    return pick?.flow;
  }

  // Fallback: pick source then terminal from the raw node list (the design has no solved flows yet).
  const source = await pickNode(state, undefined, 'Guarantee promise — pick the flow SOURCE node');
  if (source === undefined) return undefined;
  const terminal = await pickNode(state, undefined, 'Guarantee promise — pick the flow TERMINAL node');
  if (terminal === undefined) return undefined;
  return { source, terminal };
}

type GuaranteeDimensionOptions = ReturnType<typeof requirementOptions>;

/** Ask which guarantee DIMENSION to require, as a QuickPick over the shared `requirementOptions` (consistency /
 *  ordering / delivery), each with its one-line "what it is about" detail. A pre-set dimension skips the picker. */
async function pickGuaranteeDimension(preset: string | undefined): Promise<GuaranteeDimensionOptions[number] | undefined> {
  const options = requirementOptions();
  if (preset !== undefined) {
    const found = options.find((o) => o.dimension === preset);
    if (found !== undefined) return found;
  }
  const pick = await vscode.window.showQuickPick(
    options.map((o) => ({ label: o.label, description: o.detail, option: o })),
    { title: 'SDA: Guarantee promise — pick the dimension', placeHolder: 'Consistency · ordering · delivery' },
  );
  return pick?.option;
}

/** Ask for the minimum TOKEN (the floor) for the chosen dimension, strongest→weakest, each with its outsider-legible
 *  gloss ("strong — reads always see the latest write"). Returns the raw token the promise stores, or undefined. */
async function pickGuaranteeToken(dimension: GuaranteeDimensionOptions[number]): Promise<string | undefined> {
  const pick = await vscode.window.showQuickPick(
    dimension.tokens.map((t) => ({ label: t.token, description: t.label.replace(`${t.token} — `, ''), token: t.token })),
    { title: `SDA: ${dimension.label} — pick the minimum floor`, placeHolder: 'Strongest at the top' },
  );
  return pick?.token;
}

/**
 * Resolve the node an SLO command targets. A pre-scoped node (from an Inspector action) is honoured as-is. Else we
 * offer a QuickPick of every instance in the design, DEFAULTING the picker to the current canvas selection so the
 * common case (act on the node I'm looking at) is one Enter away. A design with no instances → an honest message
 * and undefined; an unreadable design → likewise (we never fabricate a node list). Returns the chosen node id, or
 * undefined when there is nothing to pick or the user cancelled.
 */
async function pickNode(state: ActiveEditorState, preset: string | undefined, title: string): Promise<string | undefined> {
  if (preset !== undefined) return preset;
  const parsed = deserialize(state.document.getText());
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(`SDA: the design is not valid — ${parsed.error}`);
    return undefined;
  }
  const instances = parsed.value.instances;
  if (instances.length === 0) {
    void vscode.window.showInformationMessage('SDA: add a component to the design first — there is no node to set a promise on.');
    return undefined;
  }

  const selected = state.selection ?? state.detail?.node ?? undefined;
  // Order the SELECTED node first (its picker item marked "selected") so the default landing is the node in focus.
  const items = instances
    .map((i) => ({ label: i.id, description: i.id === selected ? '$(check) selected' : i.type, node: i.id }))
    .sort((a, b) => (a.node === selected ? -1 : b.node === selected ? 1 : 0));
  const pick = await vscode.window.showQuickPick(items, { title, placeHolder: 'Pick the node' });
  return pick?.node;
}

/** Ask which promise to state, as a QuickPick over the catalog (throughput ≥ · latency ≤ · availability ≥ ·
 *  cost ≤ · p99 tail ≤). The description spells out the comparator + unit so the choice is unambiguous. */
async function pickRequirement(): Promise<SloRequirement | undefined> {
  const items = SLO_REQUIREMENTS.map((r) => ({
    label: `${r.label} ${r.cmp}`,
    description: r.isRatio ? `${r.cmp} ratio (0–1)` : `${r.cmp} value (${r.unit})`,
    req: r,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title: 'SDA: Add a promise (SLO)',
    placeHolder: 'Pick what to promise',
  });
  return pick?.req;
}

/** Prompt for an SLO value in a validated InputBox: a finite number, and for a ratio (availability) strictly within
 *  [0, 1]. Returns the parsed value, or undefined when cancelled. The prompt names the node + comparator so it is
 *  self-describing (e.g. "Throughput ≥ … for pg (rps)"). */
async function promptSloValue(node: string, r: SloRequirement): Promise<number | undefined> {
  const unit = r.isRatio ? '' : isDimensionlessUnit(r.unit) ? '' : ` (${r.unit})`;
  const input = await vscode.window.showInputBox({
    title: `${r.label} ${r.cmp} … for ${node}`,
    prompt: r.isRatio ? `Availability as a ratio 0–1 (e.g. 0.999) for ${node}` : `${r.label} ${r.cmp} value${unit} for ${node}`,
    validateInput: (raw) => {
      const n = Number(raw.trim());
      if (raw.trim() === '' || Number.isNaN(n)) return 'Enter a number.';
      if (!Number.isFinite(n)) return 'Enter a finite number.';
      if (n < 0) return 'Enter a non-negative number.';
      if (r.isRatio && (n <= 0 || n > 1)) return 'Availability is a ratio in (0, 1] — e.g. 0.999.';
      return undefined;
    },
  });
  if (input === undefined) return undefined; // cancelled
  return Number(input.trim());
}

// ── Inspector: per-port TRANSFORM editing (native, doc: flow-transformations-r2 §4) ───────────────────────────

/** The (node, port) an inspector Ports action targets. Two shapes reach here: our command's own `{ node, port }`
 *  (from the row's `command`) and the tree ELEMENT VS Code hands an inline action — `{ kind:'port', node, row:{ port } }`. */
function asPortArg(arg: unknown): { node?: string; port?: string } {
  if (typeof arg === 'object' && arg !== null) {
    const a = arg as { node?: unknown; port?: unknown; row?: { port?: unknown } };
    const port = typeof a.port === 'string' ? a.port : typeof a.row?.port === 'string' ? a.row.port : undefined;
    return { ...(typeof a.node === 'string' ? { node: a.node } : {}), ...(port !== undefined ? { port } : {}) };
  }
  return {};
}

/** Resolve the port a transform command targets: a pre-scoped port (from the Ports row) is honoured; otherwise the
 *  user picks from the node's ports (each showing its direction + active transform). Undefined ⇒ cancelled / none. */
async function pickPort(state: ActiveEditorState, node: string, preset: string | undefined, title: string): Promise<string | undefined> {
  if (preset !== undefined) return preset;
  const rows = portRowsFor(state.document.getText(), node);
  if (rows.length === 0) {
    void vscode.window.showInformationMessage(`SDA: ${node} has no ports to transform.`);
    return undefined;
  }
  const items = rows.map((r) => ({
    label: `${r.port} [${r.dir}]`,
    description: r.transform ? `${r.transform.kind}(${transformParamOf(r.transform)})${r.override ? ' · modified' : ''}` : 'identity',
    port: r.port,
  }));
  const pick = await vscode.window.showQuickPick(items, { title, placeHolder: 'Pick the port' });
  return pick?.port;
}

/** Ask which transform function to apply, a QuickPick over the closed set (ratio · batch · cap · window · prob ·
 *  generate). The detail spells out the semantics so the choice is unambiguous. `generate` is offered only when the
 *  target port can ORIGINATE flow (out/bi) — an in-port generator is refused at build, so it is never shown. */
async function pickTransformKind(allowGenerate: boolean): Promise<TransformKind | undefined> {
  // NOTE: the payload field is `tk`, NOT `kind` — `kind` on a QuickPickItem is VS Code's own separator enum.
  const items = TRANSFORM_KINDS.filter((t) => t.kind !== 'generate' || allowGenerate).map((t) => ({ label: t.label, detail: t.detail, tk: t }));
  const pick = await vscode.window.showQuickPick(items, {
    title: 'SDA: Set a port transform',
    placeHolder: 'Pick the traffic transfer function',
  });
  return pick?.tk;
}

/**
 * Author a GENERATOR on `node`.`port` natively (doc: load-stages §11) — the native counterpart to the web stages
 * table. First an optional PRESET pick (the on-ramp: `diurnal`, `quarterly-report`, a `spike` that reproduces the
 * deleted probe on one node…) pre-fills the compact syntax; then ONE InputBox where the user tweaks the line, parsed
 * + validated by the SHARED `parseGeneratorInput`/`cyclesProblem` so a guided error names the exact rule. Returns the
 * generate transform, or undefined when any step is cancelled. Seeds from the CURRENT generator so re-editing pre-fills.
 */
async function promptGenerator(node: string, port: string, current: Transform | null): Promise<Transform | undefined> {
  const currentLevel = current?.kind === 'generate' ? current.level : undefined;
  const currentSeed = current?.kind === 'generate' ? formatGeneratorInput(current.level, current.cycles) : undefined;

  // The preset on-ramp — a QuickPick that pre-fills the line. "Keep current / blank" starts from the existing shape
  // (or a bare level) so the picker is optional, never forced.
  const KEEP = current?.kind === 'generate' ? 'Keep the current shape' : 'Start from a level only';
  const presetItems = [
    { label: KEEP, preset: undefined as LoadStagePreset | undefined },
    ...GENERATOR_PRESETS.map((p) => ({ label: `Preset: ${p}`, preset: p })),
  ];
  const presetPick = await vscode.window.showQuickPick(presetItems, {
    title: `Author a traffic generator on ${node}.${port}`,
    placeHolder: 'Pre-fill from a preset (or keep the current shape), then edit the stages',
  });
  if (presetPick === undefined) return undefined; // cancelled

  // The level a preset pre-fill uses: the current baseline if any, else a sensible 200 req/s starter (fully editable).
  const seedLevel = currentLevel ?? 200;
  const seed = presetPick.preset !== undefined ? presetGeneratorInput(presetPick.preset, seedLevel) : (currentSeed ?? `level=${seedLevel}`);

  const input = await vscode.window.showInputBox({
    title: `Generator — ${node}.${port}`,
    prompt: 'level=<req/s>; <cycle>: <time×mult>, …  (cumulative times off the ×1 baseline; the last time is the period)',
    value: seed,
    valueSelection: [0, seed.length],
    validateInput: (raw) => {
      const r = parseGeneratorInput(raw.trim());
      return r.ok ? undefined : r.error;
    },
  });
  if (input === undefined) return undefined; // cancelled
  const parsed = parseGeneratorInput(input.trim());
  if (!parsed.ok) return undefined; // validateInput already blocked this, but stay honest
  return { kind: 'generate', level: parsed.level, ...(parsed.cycles.length > 0 ? { cycles: parsed.cycles } : {}) };
}

/** Prompt for a transform value in a validated InputBox (mirrors engine-core `validTransform`: finite & > 0; prob
 *  additionally ≤ 1). Seeds with the current value when re-editing. Returns the parsed value, or undefined (cancel). */
async function promptTransformValue(node: string, port: string, kind: TransformKind, current: number | undefined): Promise<number | undefined> {
  const input = await vscode.window.showInputBox({
    title: `${kind.label} — ${node}.${port}`,
    prompt: `${kind.hint} for ${node}.${port}`,
    ...(current !== undefined ? { value: String(current) } : {}),
    validateInput: (raw) => {
      const n = Number(raw.trim());
      if (raw.trim() === '' || Number.isNaN(n)) return 'Enter a number.';
      return validateTransformValue(kind.kind, n) ?? undefined;
    },
  });
  if (input === undefined) return undefined; // cancelled
  return Number(input.trim());
}

/**
 * Set (or edit) one port's traffic TRANSFORM, fully native: pick the target node (defaulting to the selection) →
 * pick the port (or honour a pre-targeted one) → pick the function (ratio/batch/cap/window/prob) → enter its value
 * in a validated InputBox → apply the transform HOST-side (native undo). Any step cancelled leaves the design
 * untouched. Honest throughout — no design → a warning; an unreadable design → we don't invent a port list.
 *
 * Called from the Inspector's Ports row (the pencil, pre-targeting node + port) and from the command palette
 * (nothing pre-scoped). A pre-targeted port seeds the flow so editing an existing transform skips the port pick.
 */
async function setPortTransform(active: ActiveEditorRegistry, arg: unknown): Promise<void> {
  const state = requireActive(active, 'set a transform on');
  if (state === undefined) return;
  const scoped = asPortArg(arg);

  const node = await pickNode(state, scoped.node, 'Set a port transform — pick the node');
  if (node === undefined) return;

  const port = await pickPort(state, node, scoped.port, `Set a transform on ${node} — pick the port`);
  if (port === undefined) return;

  // Seed from the CURRENT transform on this port (override or catalog default) so re-editing pre-fills.
  const currentRow = portRowsFor(state.document.getText(), node).find((r) => r.port === port);
  const current = currentRow?.transform ?? null;

  // `generate` originates flow, so it is offered only on an out/bi port (an in-port generator is refused at build).
  const canGenerate = currentRow !== undefined && currentRow.dir !== 'in';
  const kind = await pickTransformKind(canGenerate);
  if (kind === undefined) return;

  // GENERATE takes the compact stages syntax (a preset pre-fill + one InputBox), not a single value; the five
  // reshaping kinds take one validated number. Both write the SAME `instance.transforms` shape.
  const transform =
    kind.kind === 'generate'
      ? await promptGenerator(node, port, current)
      : await promptReshapingValue(node, port, kind, current);
  if (transform === undefined) return;

  const edit = setTransformText(state.document.getText(), node, port, transform);
  if (!edit.ok) {
    void vscode.window.showErrorMessage(`SDA: could not set the transform — ${edit.error}`);
    return;
  }
  await applyDocumentEdit(state.document, edit.text);
}

/** Prompt for a reshaping kind's single value and build its transform — the five-kind path of {@link setPortTransform},
 *  seeded from the current transform when re-editing the same kind. Returns undefined on cancel. */
async function promptReshapingValue(node: string, port: string, kind: TransformKind, current: Transform | null): Promise<Transform | undefined> {
  const seed = current != null && current.kind !== 'generate' && current.kind === kind.kind ? current.value : undefined;
  const value = await promptTransformValue(node, port, kind, seed);
  if (value === undefined) return undefined;
  return { kind: kind.kind, value } as Transform;
}

/**
 * Clear one port's per-instance transform override (the port falls back to its manifest default / identity), fully
 * native. Called from the Inspector's discard action (pre-targeting node + port) or the palette (pick both). A port
 * with no override says so honestly rather than writing a no-op edit.
 */
async function clearPortTransform(active: ActiveEditorRegistry, arg: unknown): Promise<void> {
  const state = requireActive(active, 'clear a transform on');
  if (state === undefined) return;
  const scoped = asPortArg(arg);

  const node = await pickNode(state, scoped.node, 'Clear a port transform — pick the node');
  if (node === undefined) return;

  // Only offer ports that actually carry a per-instance OVERRIDE (a catalog default is not the user's to clear here).
  const overridden = portRowsFor(state.document.getText(), node).filter((r) => r.override);
  if (overridden.length === 0) {
    void vscode.window.showInformationMessage(`SDA: ${node} has no transform overrides to clear.`);
    return;
  }
  let port = scoped.port !== undefined && overridden.some((r) => r.port === scoped.port) ? scoped.port : undefined;
  if (port === undefined) {
    const pick = await vscode.window.showQuickPick(
      overridden.map((r) => ({ label: `${r.port} [${r.dir}]`, description: r.transform ? `${r.transform.kind}(${transformParamOf(r.transform)})` : '', port: r.port })),
      { title: `Clear a transform on ${node}`, placeHolder: 'Pick the override to clear' },
    );
    if (pick === undefined) return;
    port = pick.port;
  }

  const edit = setTransformText(state.document.getText(), node, port, null);
  if (!edit.ok) {
    void vscode.window.showErrorMessage(`SDA: could not clear the transform — ${edit.error}`);
    return;
  }
  await applyDocumentEdit(state.document, edit.text);
}

// ── Inspector: per-instance uncertainty RANGE editing (native, doc: uncertainty-monte-carlo §2) ───────────────
//
// The categorical twin of setPortTransform for SOFT INPUTS: a config knob is not always a point, so `sda.setRange`
// declares a ± range (uniform "lo-hi" or triangular "lo-mode-hi") the Monte-Carlo run samples, and `sda.clearRange`
// removes it. Both edit the DOCUMENT host-side (native undo), and the ambient uncertainty loop then re-runs naturally
// (: a range change is just a document change — no special wiring). The grammar + validation are the SHARED
// presenter `parseRangeInput`, so a range typed in this InputBox and one entered in the web Inspector are interpreted
// IDENTICALLY (one meaning, two entry points). The base forward pass is unchanged — a range is invisible until sampled.

/** The (node, key) an Inspector range action targets. Two shapes reach here: our command's own `{ node, key }`
 *  and the tree ELEMENT VS Code hands an inline action — the knob leaf `{ kind:'knob', node, knob:{ key } }`. */
function asRangeArg(arg: unknown): { node?: string; key?: string } {
  if (typeof arg === 'object' && arg !== null) {
    const a = arg as { node?: unknown; key?: unknown; knob?: { key?: unknown } };
    const key = typeof a.key === 'string' ? a.key : typeof a.knob?.key === 'string' ? a.knob.key : undefined;
    return { ...(typeof a.node === 'string' ? { node: a.node } : {}), ...(key !== undefined ? { key } : {}) };
  }
  return {};
}

/** The unit suffix a knob picker/InputBox shows for a value, or '' for a dimensionless knob (concurrency/replicas). */
function knobUnit(unit: string): string {
  return isDimensionlessUnit(unit) ? '' : ` ${unit}`;
}

/**
 * Set (or edit) one config knob's uncertainty RANGE, fully native: pick the target node (defaulting to the selection)
 * → pick the knob (or honour a pre-targeted one) → enter the range in a validated InputBox (blank ⇒ clear; "lo-hi" ⇒
 * uniform; "lo-mode-hi" ⇒ triangular) → apply the range HOST-side (native undo). Any step cancelled leaves the design
 * untouched. The InputBox validates with the SHARED `parseRangeInput`, so an unsound range (lo>hi, or a triangular
 * mode outside [lo,hi]) is rejected inline with `rangeProblem`'s exact reason — never a silent clamp.
 *
 * Called from the Inspector's knob row (the ± inline action, pre-targeting node + key, seeding any current range) and
 * from the command palette (nothing pre-scoped — the user picks node + knob). A pre-targeted knob skips the knob pick.
 */
async function setRange(active: ActiveEditorRegistry, arg: unknown): Promise<void> {
  const state = requireActive(active, 'set an uncertainty range on');
  if (state === undefined) return;
  const scoped = asRangeArg(arg);

  const node = await pickNode(state, scoped.node, 'Set an uncertainty range — pick the node');
  if (node === undefined) return;

  const knobs = configKnobsFor(state.document.getText(), node);
  // Resolve the knob: honour a pre-targeted key (the Inspector ± action); otherwise ask which config value to range.
  let key = scoped.key;
  if (key === undefined) {
    if (knobs.length === 0) {
      void vscode.window.showInformationMessage(`SDA: ${node} has no config values to put a range on.`);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      knobs.map((k) => ({ label: k.label, description: k.range ? formatRange(k.range) : `${k.value}${knobUnit(k.unit)}`, key: k.key })),
      { title: `Set an uncertainty range on ${node} — pick the config value`, placeHolder: 'Pick the soft input to range' },
    );
    if (pick === undefined) return; // cancelled
    key = pick.key;
  }

  // Seed the InputBox with the current range's editable seed (`lo-hi` / `lo-mode-hi`) so re-editing pre-fills exactly.
  const current = knobs.find((k) => k.key === key)?.range;
  const knob = knobs.find((k) => k.key === key);
  const input = await vscode.window.showInputBox({
    title: `Uncertainty range — ${node}.${key}`,
    prompt: `${knob ? `${knob.label} (point ${knob.value}${knobUnit(knob.unit)}). ` : ''}Enter ${RANGE_INPUT_FORMS}`,
    ...(current !== undefined ? { value: formatRangeInput(current) } : {}),
    validateInput: (raw) => {
      const r = parseRangeInput(raw);
      return r.kind === 'error' ? r.message : undefined; // blank ⇒ clear, a sound range ⇒ ok, else the guided reason
    },
  });
  if (input === undefined) return; // cancelled

  const edit = setRangeText(state.document.getText(), node, key, input);
  if (!edit.ok) {
    void vscode.window.showErrorMessage(`SDA: could not set the range — ${edit.error}`);
    return;
  }
  await applyDocumentEdit(state.document, edit.text);
}

/**
 * Clear one config knob's uncertainty range (the knob falls back to its point config value — the base evaluation),
 * fully native. Called from the Inspector's discard action (pre-targeting node + key) or the palette (pick both). A
 * node with no declared ranges says so honestly rather than writing a no-op edit. The clear goes through the shared
 * `setRangeText` with a BLANK input (the same clear path the web uses), so both shells drop the range identically.
 */
async function clearRange(active: ActiveEditorRegistry, arg: unknown): Promise<void> {
  const state = requireActive(active, 'clear an uncertainty range on');
  if (state === undefined) return;
  const scoped = asRangeArg(arg);

  const node = await pickNode(state, scoped.node, 'Clear an uncertainty range — pick the node');
  if (node === undefined) return;

  const ranged = rangeRowsFor(state.document.getText(), node);
  if (ranged.length === 0) {
    void vscode.window.showInformationMessage(`SDA: ${node} has no uncertainty ranges to clear.`);
    return;
  }
  let key = scoped.key !== undefined && ranged.some((r) => r.key === scoped.key) ? scoped.key : undefined;
  if (key === undefined) {
    const pick = await vscode.window.showQuickPick(
      ranged.map((r) => ({ label: r.key, description: r.display, key: r.key })),
      { title: `Clear an uncertainty range on ${node}`, placeHolder: 'Pick the range to clear' },
    );
    if (pick === undefined) return; // cancelled
    key = pick.key;
  }

  const edit = setRangeText(state.document.getText(), node, key, ''); // blank input ⇒ clear (the shared clear path)
  if (!edit.ok) {
    void vscode.window.showErrorMessage(`SDA: could not clear the range — ${edit.error}`);
    return;
  }
  await applyDocumentEdit(state.document, edit.text);
}

// ── Command palette: per-WIRE TRANSFORM editing (native, doc: flow-transformations-r2 §5) ─────────────────────

/**
 * Set (or edit) ONE WIRE's OUT-side traffic TRANSFORM — a ROUTING SPLIT a per-port transform cannot express (one
 * out port feeding several wires with different shares, e.g. 70/30). Fully native: pick the wire (a QuickPick of
 * every wire, showing its endpoints + active transform) → pick the function → enter its value in a validated
 * InputBox → apply HOST-side (native undo). Any step cancelled leaves the design untouched. The pill click on the
 * canvas already SELECTS the edge (protocol.ts untouched); this palette command is the native path to EDIT it.
 *
 * Called only from the command palette (no pre-scoped context) — the wire is chosen from the QuickPick.
 */
async function setWireTransform(active: ActiveEditorRegistry, _arg: unknown): Promise<void> {
  const state = requireActive(active, 'set a wire transform on');
  if (state === undefined) return;

  const rows = wireRowsFor(state.document.getText());
  if (rows.length === 0) {
    void vscode.window.showInformationMessage('SDA: this design has no wires — connect two components first.');
    return;
  }
  const wirePick = await vscode.window.showQuickPick(
    rows.map((r, i) => ({
      label: `${r.from[0]}.${r.from[1]} → ${r.to[0]}.${r.to[1]}`,
      description: r.transform ? `${formatTransform(r.transform)}${r.override ? ' · wire override' : ' · from port'}` : 'identity',
      idx: i,
    })),
    { title: 'Set a wire transform — pick the wire (routing split)', placeHolder: 'Pick the wire' },
  );
  if (wirePick === undefined) return;
  const row = rows[wirePick.idx]!;

  // Seed from the wire's CURRENT effective OUT transform so re-editing pre-fills.
  const current = row.transform;

  // A wire cannot ORIGINATE traffic (a generator is a PORT function — refused on an edge at build), so `generate`
  // is not offered here; a routing split reshapes the flow the source port already emits.
  const kind = await pickTransformKind(false);
  if (kind === undefined) return;

  const seed = current != null && current.kind !== 'generate' && current.kind === kind.kind ? current.value : undefined;
  const value = await promptWireTransformValue(row, kind, seed);
  if (value === undefined) return;

  const transform = { kind: kind.kind, value } as Transform;
  const edit = setWireTransformText(state.document.getText(), row.from, row.to, transform);
  if (!edit.ok) {
    void vscode.window.showErrorMessage(`SDA: could not set the wire transform — ${edit.error}`);
    return;
  }
  await applyDocumentEdit(state.document, edit.text);
}

/** Prompt for a wire transform value in a validated InputBox (mirrors engine-core `validTransform`: finite & > 0;
 *  prob additionally ≤ 1). Seeds with the current value when re-editing. Returns the parsed value, or undefined (cancel). */
async function promptWireTransformValue(row: { from: readonly [string, string]; to: readonly [string, string] }, kind: TransformKind, current: number | undefined): Promise<number | undefined> {
  const label = `${row.from[0]} → ${row.to[0]}`;
  const input = await vscode.window.showInputBox({
    title: `${kind.label} — wire ${label}`,
    prompt: `${kind.hint} for the wire ${label}`,
    ...(current !== undefined ? { value: String(current) } : {}),
    validateInput: (raw) => {
      const n = Number(raw.trim());
      if (raw.trim() === '' || Number.isNaN(n)) return 'Enter a number.';
      return validateTransformValue(kind.kind, n) ?? undefined;
    },
  });
  if (input === undefined) return undefined; // cancelled
  return Number(input.trim());
}

// ── Inspector: suggest what fits an open port (native QuickPick) ─────────────────────────────────────────────

/** The optional argument the Inspector's suggestion leaf passes (pre-scopes to one port). */
interface SuggestArg {
  readonly node: string;
  readonly port: string;
}

function asSuggestArg(arg: unknown): SuggestArg | undefined {
  if (typeof arg !== 'object' || arg === null) return undefined;
  // Two shapes reach here: the Inspector leaf's `command` arg `{ node, port }`, and the inline-action tree element
  // `{ kind:'suggest', node, row:{ port } }` (VS Code passes the data element to a `view/item/context` command).
  const a = arg as { node?: unknown; port?: unknown; row?: { port?: unknown } };
  const port = typeof a.port === 'string' ? a.port : typeof a.row?.port === 'string' ? a.row.port : undefined;
  return typeof a.node === 'string' && port !== undefined ? { node: a.node, port } : undefined;
}

/**
 * "What fits" as a native QuickPick over the selected node's `suggestions` feed. Called two ways: from the
 * Inspector leaf (pre-scoped to one port) or from the palette (pick the port first when several are open). Once
 * a port and a component are chosen, post `wireSuggestion` — the CANVAS places the component and draws the wire.
 */
async function suggest(active: ActiveEditorRegistry, arg: unknown): Promise<void> {
  const state = requireActive(active, 'suggest for');
  if (state === undefined) return;
  const detail = state.detail;
  if (detail === undefined || detail.node === '' || detail.suggestions.length === 0) {
    void vscode.window.showInformationMessage('SDA: select a node with an open port to see what fits.');
    return;
  }

  // Resolve the port: honour a pre-scoped arg; otherwise ask when more than one port is open, else take the one.
  const scoped = asSuggestArg(arg);
  const rows = detail.suggestions;
  let row = scoped !== undefined ? rows.find((r) => r.port === scoped.port) : rows.length === 1 ? rows[0] : undefined;
  if (row === undefined && scoped === undefined && rows.length > 1) {
    const pick = await vscode.window.showQuickPick(
      rows.map((r) => ({ label: r.port, description: `${r.options.length} option${r.options.length === 1 ? '' : 's'}`, port: r.port })),
      { title: `Open ports on ${detail.label || detail.node}`, placeHolder: 'Pick a port to wire' },
    );
    if (pick === undefined) return; // cancelled
    row = rows.find((r) => r.port === pick.port);
  }
  if (row === undefined) {
    void vscode.window.showInformationMessage('SDA: that port has no suggestions.');
    return;
  }
  if (row.options.length === 0) {
    void vscode.window.showInformationMessage(`SDA: nothing in the catalog legally attaches to ${row.port}.`);
    return;
  }

  const comp = await vscode.window.showQuickPick([...row.options], {
    title: `What fits ${detail.label || detail.node} · ${row.port}`,
    placeHolder: 'Pick a component to add and wire',
  });
  if (comp === undefined) return; // cancelled
  post(state, { type: 'wireSuggestion', node: detail.node, port: row.port, comp });
}

// ── Improve: native backward-solve (QuickPick goal → progress → multi-select apply) ──────────────────────────

/** The three Improve goals, mapped to the solver's goal + the honest label/detail the QuickPick shows. */
const IMPROVE_GOALS: ReadonlyArray<{ readonly goal: SolveRequest['goal']; readonly label: string; readonly detail: string }> = [
  { goal: 'feasible', label: 'Meet every SLO — minimal change', detail: 'Smallest resize that satisfies every promise (repair).' },
  { goal: 'cheapest', label: 'Cheapest under SLOs', detail: 'Minimize cost while still meeting every SLO (optimize).' },
  { goal: 'fastest', label: 'Fastest (max throughput)', detail: 'Maximize throughput while still meeting every SLO (optimize).' },
];

/** The normalized solve body the host relays (see solver-host.ts `normalizeBody`). `engine` names WHICH solver
 *  answered — present and `'reference-mip'` when the in-process solver declined a budget-coupled trade-off and the
 *  exact reference MIP was escalated to (docs: honest escalation), so the panel can label the result honestly. */
interface NormalizedSolve {
  readonly changes: readonly KnobChange[];
  readonly note?: string;
  readonly engine?: string;
}

/**
 * Improve, fully native: pick a goal → run the host solver under a progress notification → present the proposed
 * changes in VS Code's NATIVE REFACTOR PREVIEW (one tickable TextEdit per change, each `needsConfirmation`), so the
 * user reviews and confirms each edit in the same panel a "Rename Symbol" preview uses. Empty result shows the
 * solver's own note (e.g. "already within SLOs"); any error surfaces verbatim — the solver never lies, and neither
 * do we. When a change's exact range can't be located (a hand-mangled document), we fall back HONESTLY to the
 * whole-document edit for ALL changes and say so (never a half-applied mix of preview + fallback).
 */
async function improve(active: ActiveEditorRegistry): Promise<void> {
  const state = requireActive(active, 'improve');
  if (state === undefined) return;

  const goalPick = await vscode.window.showQuickPick(
    IMPROVE_GOALS.map((g) => ({ label: g.label, detail: g.detail, goal: g.goal })),
    { title: 'SDA: Improve — solve backwards', placeHolder: 'Pick a goal' },
  );
  if (goalPick === undefined) return; // cancelled

  const projectJson = state.document.getText();
  const response = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'SDA: solving…', cancellable: false },
    () => runSolve({ goal: goalPick.goal, projectJson }),
  );

  if (!response.ok) {
    void vscode.window.showErrorMessage(`SDA: Improve failed — ${response.body}`);
    return;
  }

  const parsed = parseSolveBody(response.body);
  if (parsed === undefined) {
    void vscode.window.showErrorMessage('SDA: Improve returned an unreadable result.');
    return;
  }
  if (parsed.changes.length === 0) {
    void vscode.window.showInformationMessage(`SDA: ${parsed.note ?? 'no change needed — the design already meets its SLOs.'}`);
    return;
  }

  // HONEST ESCALATION (docs: honest escalation): when the exact reference MIP answered a budget-coupled trade-off
  // the in-process solver declined, say so BEFORE the refactor preview — the sizing is the exact optimizer's, and it
  // took a longer solve. Never a silent swap of engines.
  if (parsed.engine === 'reference-mip') {
    void vscode.window.showInformationMessage(`SDA: ${parsed.note ?? 'sized by the exact reference MIP (a longer solve than the in-process solver).'}`);
  }

  await applyImprove(state.document, parsed.changes);
}

/**
 * Turn the solved changes into a NATIVE refactor preview: ONE `TextEdit` per change with per-edit confirmation
 * metadata, so VS Code shows its refactor-preview panel and the user ticks the changes to apply. Falls back to the
 * whole-document edit (with an honest notification) when any change's range can't be located in the current text.
 */
async function applyImprove(document: vscode.TextDocument, changes: readonly KnobChange[]): Promise<void> {
  const ranges = changeRanges(document.getText(), changes);
  if (ranges === null) {
    // A hand-edited/minified document defeated the per-change locator. Rather than a partial preview, apply the
    // whole set as ONE document edit (the original path) and tell the user WHY the native preview wasn't offered.
    const edit = applyChanges(document.getText(), changes);
    if (!edit.ok) {
      void vscode.window.showErrorMessage(`SDA: could not apply the changes — ${edit.error}`);
      return;
    }
    await applyDocumentEdit(document, edit.text);
    void vscode.window.showInformationMessage(
      `SDA: applied ${changes.length} change${changes.length === 1 ? '' : 's'} (couldn't locate exact ranges for a per-change preview, so applied them together).`,
    );
    return;
  }

  // Build ONE WorkspaceEdit with a per-change confirmation entry. `needsConfirmation: true` makes VS Code present
  // the refactor-PREVIEW panel (the user reviews and toggles each edit); the `label` names the concrete change so a
  // reviewer reads exactly what each tick does. The metadata is registered once and shared by every edit of a change.
  const edit = new vscode.WorkspaceEdit();
  for (const r of ranges) {
    const range = new vscode.Range(document.positionAt(r.start), document.positionAt(r.end));
    const metadata: vscode.WorkspaceEditEntryMetadata = {
      needsConfirmation: true,
      label: refactorLabel(document.getText(), r),
      description: 'SDA Improve',
    };
    edit.replace(document.uri, range, String(r.value), metadata);
  }
  // With confirmation metadata present, `applyEdit` opens the native preview; the returned boolean reflects whether
  // the user confirmed any edits (false = they dismissed it). We stay quiet on dismiss — the preview panel already
  // gave the user their answer; a notification would be noise.
  await vscode.workspace.applyEdit(edit);
}

/** The refactor-preview LABEL for one change: `<node>.<key>: <from> → <to>` (the from read from the located span so
 *  it is the exact current text, the to the quantized deployable value). Honest and self-describing in the panel. */
function refactorLabel(text: string, r: RangeEdit): string {
  const from = text.slice(r.start, r.end);
  return `${r.change.node}.${r.change.key}: ${from} → ${r.value}`;
}

/** Parse the normalized `{ changes:[{node,key,to}], note?, engine? }` body into typed changes; undefined if unreadable. */
function parseSolveBody(body: string): NormalizedSolve | undefined {
  try {
    const raw: unknown = JSON.parse(body);
    if (typeof raw !== 'object' || raw === null) return undefined;
    const o = raw as { changes?: unknown; note?: unknown; engine?: unknown };
    if (!Array.isArray(o.changes)) return undefined;
    const changes: KnobChange[] = [];
    for (const c of o.changes) {
      const x = c as { node?: unknown; key?: unknown; to?: unknown };
      if (typeof x.node !== 'string' || typeof x.key !== 'string' || typeof x.to !== 'number' || Number.isNaN(x.to)) continue;
      changes.push({ node: x.node, key: x.key, to: x.to });
    }
    return { changes, ...(typeof o.note === 'string' ? { note: o.note } : {}), ...(typeof o.engine === 'string' ? { engine: o.engine } : {}) };
  } catch {
    return undefined;
  }
}

// ── Compare options: native "run backwards for ONE node" (Alternatives) ──────────────────────────────────────

/**
 * Alternatives, fully native: for the SELECTED node, enumerate every component type that fits its wiring (clingo),
 * size each to meet its SLOs at the cheapest config (the in-process solver), and rank the survivors — then let the user pick one
 * and apply it as a `set_type` swap via the NATIVE refactor preview. The whole compare runs HOST-side (the webview
 * ships no clingo/MIP solver): a throwaway Studio from the current document text, exactly like Improve. No selection
 * → honest information message; the solver/tool's own error text surfaces verbatim; an empty result shows the tool's
 * own note. Read-only until the user accepts a swap in the preview.
 */
async function compareOptions(active: ActiveEditorRegistry): Promise<void> {
  const state = requireActive(active, 'compare options for');
  if (state === undefined) return;

  // The context is the canvas selection. `detail` is the Inspector's node (kept in sync with the selection); we
  // prefer `selection` and fall back to `detail.node`, so the command works whether the user clicked the canvas or
  // is inspecting a node. No node selected at all → say so honestly rather than compare an arbitrary node.
  const node = state.selection ?? state.detail?.node ?? '';
  if (node === '') {
    void vscode.window.showInformationMessage('SDA: select a node on the canvas to compare component alternatives for it.');
    return;
  }

  const projectJson = state.document.getText();
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `SDA: comparing options for ${node}…`, cancellable: false },
    () => runCompare({ node, projectJson }),
  );

  if (!result.ok) {
    void vscode.window.showErrorMessage(`SDA: Compare options failed — ${result.error}`);
    return;
  }
  if (result.options.length === 0) {
    // The tool ran but found nothing to rank — surface its OWN words (e.g. "No alternative component type fits …").
    void vscode.window.showInformationMessage(`SDA: ${'note' in result ? result.note : `no alternatives for ${node}.`}`);
    return;
  }

  // The node's CURRENT type marks the "current" row (and is skipped as a swap target — swapping to itself is a
  // no-op). Read it from the document text so it's authoritative even if the feeds lag the selection by a frame.
  const currentType = state.detail?.node === node ? state.detail.typeId : undefined;
  const items = result.options.map((o) => toQuickPickItem(o, result.objectiveKey, currentType));
  const pick = await vscode.window.showQuickPick(items, {
    title: `SDA: Alternatives for ${node} — ranked cheapest-first`,
    placeHolder: 'Pick a component type to swap in (keeps wiring + SLOs; resizes to defaults)',
    matchOnDescription: true,
  });
  if (pick === undefined) return; // cancelled
  if (pick.type === currentType) {
    void vscode.window.showInformationMessage(`SDA: ${node} already uses ${pick.type}.`);
    return;
  }

  await applySwap(state.document, node, pick.type);
}

/** One QuickPick row for a compare option: the component TYPE as the label (the current one flagged), and the
 *  cost/feasibility trade-offs as the description — mirroring the columns the compare_options tool returns so the
 *  choice is informed BEFORE it is applied. `type` rides along so the accepted item maps straight to a swap. */
function toQuickPickItem(o: CompareOption, objectiveKey: string, currentType: string | undefined): vscode.QuickPickItem & { readonly type: string } {
  const isCurrent = o.type === currentType;
  const parts: string[] = [];
  if (Number.isFinite(o.value)) parts.push(`${objectiveKey}: ${o.value}`);
  // Overflow > 0 means the option cannot fully serve the load at any sizing the optimiser found — an honest,
  // load-bearing warning that a cheaper option is cheaper because it drops requests.
  parts.push(o.overflow > 0.01 ? `overflow ${o.overflow} req/s — cannot meet load` : 'feasible');
  if (o.availability !== undefined) parts.push(`avail ${o.availability}`);
  if (o.throughput !== undefined) parts.push(`tput ${o.throughput} req/s`);
  return {
    label: isCurrent ? `$(check) ${o.type}` : o.type,
    description: parts.join(' · '),
    ...(isCurrent ? { detail: 'current type' } : {}),
    type: o.type,
  };
}

/**
 * Apply an accepted alternative as a `set_type` swap via the NATIVE refactor preview. The new document text is built
 * by the SAME @sda/core `setType` command the web uses (see compare-host.ts) — keeps id/wires/SLOs, resets capacity
 * config — then written as ONE WorkspaceEdit carrying `needsConfirmation` metadata, so VS Code shows its refactor-
 * preview panel and the user confirms the swap there (never a silent host mutation). A whole-document replace is the
 * right granularity: a type swap rewrites the instance object AND drops its config, which no single-value TextEdit
 * captures — so we replace the full range and let the preview label say exactly what changes.
 */
async function applySwap(document: vscode.TextDocument, node: string, newType: string): Promise<void> {
  const swap = swapTypeText(document.getText(), node, newType);
  if (!swap.ok) {
    void vscode.window.showErrorMessage(`SDA: could not swap ${node} to ${newType} — ${swap.error}`);
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  const metadata: vscode.WorkspaceEditEntryMetadata = {
    needsConfirmation: true,
    label: `${node}: ${swap.from} → ${newType}`,
    description: 'SDA Compare options',
  };
  edit.replace(document.uri, fullRange, swap.text, metadata);
  // With confirmation metadata present, `applyEdit` opens the native preview; the user confirms or dismisses there.
  // We stay quiet on dismiss — the preview panel already gave the user their answer; a notification would be noise.
  await vscode.workspace.applyEdit(edit);
}

// ── Generate design doc: host-side build → write `<name>-design-doc.<ext>` next to the .sda.json → open ─────────

/** The two output formats offered, HTML first (the human deliverable — the default a review-board author wants). */
const DOC_FORMATS: ReadonlyArray<{ readonly format: 'html' | 'markdown'; readonly label: string; readonly detail: string }> = [
  { format: 'html', label: 'HTML report', detail: 'Self-contained report — C4 diagram, capacity/utilisation charts, load→latency sweep, assumptions register. Opens in your browser.' },
  { format: 'markdown', label: 'Markdown', detail: 'Diffable Markdown (Mermaid C4). Paste into an RFC / commit; opens beside the design.' },
];

/** Coerce a command argument to a valid doc format, or undefined (⇒ ask). A keybinding / test can pass 'html' |
 *  'markdown' (bare or as `{ format }`) to skip the QuickPick; anything else falls through to the picker. */
function asDocFormat(arg: unknown): 'html' | 'markdown' | undefined {
  const raw = typeof arg === 'string' ? arg : typeof arg === 'object' && arg !== null ? (arg as { format?: unknown }).format : undefined;
  return raw === 'html' || raw === 'markdown' ? raw : undefined;
}

/** Ask which format to generate, HTML first (the deliverable). Returns the chosen format, or undefined (cancelled). */
async function pickDocFormat(): Promise<'html' | 'markdown' | undefined> {
  const pick = await vscode.window.showQuickPick(
    DOC_FORMATS.map((f) => ({ label: f.label, detail: f.detail, format: f.format })),
    { title: 'SDA: Generate design doc — pick a format', placeHolder: 'HTML report (the deliverable) or Markdown (diffable)' },
  );
  return pick?.format;
}

// The stress probe (the global-spike command) is DELETED (doc: load-stages §2, the net-negative ledger). The
// transient question is now answered by the AMBIENT two-tier read-out surfaced in the System tree summary (composed
// in the webview via the shared presenter `twoTierSection`, fed by the two-tier worker) — no command, no button.

/**
 * Generate the architect's DELIVERABLE from the active design and WRITE it as `<name>-design-doc.<ext>` next to the
 * source `.sda.json`. Fully HOST-SIDE (design-doc-host.ts): protocol.ts's `designDoc` message field is literally
 * named `markdown` (frozen), so a webview round-trip could ship only Markdown — building host-side from the document
 * text (the same seam CodeLens/SLO tests use) frees the format AND gives us the file path. Works whether the design
 * is open as the canvas or as plain text.
 *
 * UX: a QuickPick chooses the format (HTML first — the deliverable), ONE surface, no format-per-command sprawl. An
 * unsaved/untitled design has no path to write beside, so we ask honestly (a design not yet saved cannot anchor a
 * sibling file). A design that does not build gets an honest error, never an empty document.
 */
async function generateDesignDoc(active: ActiveEditorRegistry, arg: unknown): Promise<void> {
  const state = requireActive(active, 'generate a design doc for');
  if (state === undefined) return;

  // The sibling file needs a real on-disk anchor. An untitled/unsaved design has none — say so rather than write to
  // a surprising temp location; the fix (Save the design) is one action away.
  if (state.document.isUntitled || state.document.uri.scheme !== 'file') {
    void vscode.window.showWarningMessage('SDA: save the design to a .sda.json file first — the design doc is written next to it.');
    return;
  }

  // A pre-supplied format (a keybinding arg, or the e2e test) skips the picker; otherwise ask (HTML first — the
  // deliverable). `asDocFormat` accepts only the two valid ids, so a stray arg falls through to the QuickPick.
  const preset = asDocFormat(arg);
  const format = preset ?? (await pickDocFormat());
  if (format === undefined) return; // cancelled

  const generated = buildDesignDocText(state.document.getText(), format);
  if (generated === null) {
    void vscode.window.showErrorMessage('SDA: the design does not build — fix the errors (see Problems) before generating the doc.');
    return;
  }

  try {
    await writeDesignDocBesideSource(state.document.uri, generated.text, generated.format);
  } catch (e) {
    void vscode.window.showErrorMessage(`SDA: could not write the design doc — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Apply new document text as ONE whole-document WorkspaceEdit — the single path for a HOST-initiated edit. The
 * whole-document write itself is `replaceWholeDocument`; this wrapper exists to document THE ECHO-GUARD CONTRACT.
 *
 * THE ECHO-GUARD CONTRACT (integrator note): unlike a webview-originated `docChanged`, we do NOT arm the
 * provider's echo guard here. The guard exists to stop the webview's OWN change echoing back to it; a host edit
 * is a genuinely external change the webview has not seen, so it MUST flow through the provider's
 * onDidChangeTextDocument handler as a `docExternal` and the canvas reloads. Leaving the guard un-armed is
 * exactly what lets that happen. The webview's `docExternal` handler then records the text as its last-synced,
 * so it will not bounce a `docChanged` straight back (no ping-pong).
 */
async function applyDocumentEdit(document: vscode.TextDocument, text: string): Promise<void> {
  await replaceWholeDocument(document, text);
}

/**
 * Ideal layout (doc: ideal-layout) — the command-palette / keybinding power alias of the CANVAS's single 'Tidy'
 * button (which now runs this same ideal pipeline). It runs IN THE WEBVIEW (webview/ideal-layout.ts), exactly like the web shell, because the
 * port-anchor math is MEASURED-HEIGHT-dependent: anchors sit at height × portFraction, and only the canvas knows
 * the footprints that actually render. (A retired HOST-side implementation optimised from DEFAULT heights —
 * anchors aligned that did not exist on screen, broken lines shipped — the silent wrong fallback the
 * tool-must-not-lie rule forbids. It must never come back here.)
 *
 * So this command is the ONE-WORD `cmd` forward over the geometry channel Tidy rides — the protocol union's one
 * deliberate evolution (owner ruling: a visible command must RUN the layout; the interim signpost toast was a
 * dead affordance). The webview's command router triggers exactly the Tidy button path: measured sizes,
 * floor→polish, one native undo step per stage. With no active canvas the palette / editor-title / keybinding
 * entries are already hidden by their `when` clauses (activeCustomEditorId == sda.designEditor), so the honest
 * warning from `requireActive` is the programmatic-only last resort, never a shipped surface.
 */
function idealLayout(active: ActiveEditorRegistry): void {
  const state = requireActive(active, 'lay out');
  if (state === undefined) return;
  post(state, { type: 'cmd', cmd: 'idealLayout' });
}
