import type { Graph, Registry, Result, Verdict } from '@sda/engine-core';
import { evaluate as evaluateGraph, type Evaluation, type RequestClass } from '@sda/engine-solve';
import { compileClasses, hasClasses, instantiate, originByNode, refreshDerivedScenarios, type AssumptionScenario, type ClassContext, type InstantiateError, type Manifest } from '@sda/content';
import { apply, type Command } from './commands';
import { emptyProject, type ProjectDoc } from './document';

/**
 * The command core: the single source of truth. Holds the document, applies commands (with
 * history for undo/redo), emits change events, and answers engine queries (graph / evaluate / verdicts)
 * by compiling the document through content + the engine. Headless — every client drives this.
 */
export class Studio {
  private doc: ProjectDoc;
  private readonly undoStack: ProjectDoc[] = [];
  private readonly redoStack: ProjectDoc[] = [];
  private readonly listeners = new Set<() => void>();
  /** THE ACTIVE-WORLD LENS — which named world scopes the view. Deliberately OUT of
   *  the ProjectDoc: "which world am I looking at" is a VIEW concern, not part of the saved design (it is never
   *  serialised, never undone). Both shells read it off the Studio and subscribe via the SAME `onChange` stream, so
   *  a lens change re-renders exactly like a doc change. undefined ⇒ the base lens (the design as authored). */
  private active: string | undefined;

  constructor(
    private readonly registry: Registry,
    private readonly catalog: Readonly<Record<string, Manifest>>,
    doc?: ProjectDoc,
  ) {
    this.doc = doc ?? emptyProject('p1', 'Untitled');
  }

  project(): ProjectDoc {
    return this.doc;
  }

  /** Replace the whole document (initial OPEN). Clears history and notifies subscribers. */
  load(doc: ProjectDoc): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.doc = doc;
    this.emit();
  }

  /**
   * Replace the whole document UNDOABLY (import over an existing project). Like `dispatch`, the current
   * document is pushed onto the undo stack and the redo stack is cleared — so an import never silently
   * discards unsaved work: Undo restores the pre-import design. Use `load()` only for the initial open.
   */
  replaceDoc(doc: ProjectDoc): void {
    this.undoStack.push(this.doc);
    this.redoStack.length = 0;
    this.doc = doc;
    this.emit();
  }

  /** Subscribe to document changes (the event stream the UI / live spec / animated canvas use). Also fires on an
   *  active-world lens change and on a derived-scenario reconcile — so a `useSyncExternalStore` over `activeScenario`
   *  re-renders on the same stream. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** The active-world lens (doc §7.1), or undefined for the base lens. SELF-HEALING: if the active world has since
   *  been removed, this reads undefined (the base lens) — a consumer never sees a stale/dangling active id. */
  activeScenario(): string | undefined {
    return this.active !== undefined && this.doc.scenarios.some((s) => s.id === this.active) ? this.active : undefined;
  }

  /** Select the active world (undefined ⇒ base lens). Idempotent (no needless emit), and validated: selecting a
   *  world the design does not declare falls back to the base lens rather than pinning a dangling id. Emits so both
   *  shells re-scope the canvas + System panel to that world (doc §7.1). NOT undoable — it is a view choice. */
  setActiveScenario(id: string | undefined): void {
    const next = id !== undefined && this.doc.scenarios.some((s) => s.id === id) ? id : undefined;
    if (next === this.active) return;
    this.active = next;
    this.emit();
  }

  /**
   * Re-track the LIVE-derived scenario values against a freshly-derived trio (doc §9, tension #5). The ambient loop
   * computes the envelope, calls `deriveDefaultScenarios`, and passes the result here; `refreshDerivedScenarios`
   * updates the values of provenance=`derived` overrides and leaves every `architect`/frozen value untouched.
   * NON-UNDOABLE and idempotent: it is a derived reconciliation, not a user edit, so it never pushes an undo frame,
   * and when nothing changed it does NOT emit (so it cannot drive an ambient feedback loop). Returns whether the
   * document changed. Absent any derived overrides this is a cheap no-op.
   */
  reconcileDerivedScenarios(fresh: readonly AssumptionScenario[]): boolean {
    const next = refreshDerivedScenarios(this.doc.scenarios, fresh);
    if (!next.some((s, i) => s !== this.doc.scenarios[i])) return false; // reference-equal everywhere ⇒ nothing changed
    this.doc = { ...this.doc, scenarios: next };
    this.emit();
    return true;
  }

  /** All component types available to place (catalogue + project-embedded definitions). */
  componentTypes(): string[] {
    return [...this.knownTypes()];
  }
  private knownTypes(): Set<string> {
    return new Set([...Object.keys(this.catalog), ...this.doc.components.map((m) => m.type)]);
  }
  /** The merged catalogue — the built-in catalog plus the project's own embedded component definitions (the latter
   *  win on a type collision). Used to build the project's graph and by tools that assemble hypothetical graphs. */
  mergedCatalog(): Record<string, Manifest> {
    const merged: Record<string, Manifest> = { ...this.catalog };
    for (const m of this.doc.components) merged[m.type] = m; // project-embedded definitions win
    return merged;
  }

  /** Apply a command; on success it becomes undoable. Returns the change summary or an error. */
  dispatch(cmd: Command): Result<string, string> {
    const r = apply(this.doc, cmd, this.knownTypes());
    if (!r.ok) return r;
    this.undoStack.push(this.doc);
    this.redoStack.length = 0;
    this.doc = r.value.doc;
    this.emit();
    return { ok: true, value: r.value.event.summary };
  }

  /**
   * Apply several commands as ONE undoable unit — all-or-nothing. The optimizer's "Apply" (or a Compare swap)
   * resizes several knobs at once; that is a SINGLE user action, so a single Undo must restore the whole prior
   * design, never a hybrid intermediate (e.g. one tier reverted, another left at an optimizer value the user
   * never chose). If any command fails the document is left untouched and the error is returned.
   */
  dispatchBatch(cmds: readonly Command[]): Result<string, string> {
    if (cmds.length === 0) return { ok: true, value: 'no changes' };
    let next = this.doc;
    const summaries: string[] = [];
    for (const cmd of cmds) {
      const r = apply(next, cmd, this.knownTypes());
      if (!r.ok) return r; // nothing committed yet — the live document is unchanged
      next = r.value.doc;
      summaries.push(r.value.event.summary);
    }
    this.undoStack.push(this.doc);
    this.redoStack.length = 0;
    this.doc = next;
    this.emit();
    return { ok: true, value: summaries.join('; ') };
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (prev === undefined) return false;
    this.redoStack.push(this.doc);
    this.doc = prev;
    this.emit();
    return true;
  }
  redo(): boolean {
    const next = this.redoStack.pop();
    if (next === undefined) return false;
    this.undoStack.push(this.doc);
    this.doc = next;
    this.emit();
    return true;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** The declared request classes lowered to the engine's `RequestClass[]`, or undefined
   *  when none are declared — the single implicit river, where every downstream evaluation is byte-for-byte today.
   *  `compileClasses` resolves each membership wire ref to the SAME edge id `instantiate` assigns (wires[i] → e{i}). */
  private compiledClasses(): readonly RequestClass[] | undefined {
    return hasClasses(this.doc.requestClasses) ? compileClasses(this.doc.wires, this.doc.requestClasses) : undefined;
  }
  /** The per-instance class context content needs at instantiate time: present ONLY
   *  under declared classes, carrying the reconciled per-node total origin so content supplies pure capacity and a
   *  class-blind `assumedRps`. Absent ⇒ the origin fold runs exactly as today. */
  private classContext(): ClassContext | undefined {
    return hasClasses(this.doc.requestClasses) ? { originByNode: originByNode(this.doc.requestClasses) } : undefined;
  }

  /** Compile the document into an engine graph (instantiate over the merged catalogue). */
  graph(): Result<Graph, readonly InstantiateError[]> {
    return instantiate(this.mergedCatalog(), this.doc.instances, this.doc.wires, this.classContext());
  }

  /** Forward evaluation: solved values + verdicts, or build errors as strings. */
  evaluate(): Result<Evaluation, readonly string[]> {
    const g = this.graph();
    if (!g.ok) {
      // Human/agent-readable build errors: the unknown-type case is the one a hand-written or AI-authored
      // document hits most, so it gets a sentence naming the fix instead of a JSON blob.
      return {
        ok: false,
        error: g.error.map((e) =>
          e.kind === 'unknown-type'
            ? `node "${e.id}": unknown component type "${e.type}" — not in the installed catalogs; use a palette type (list_components over MCP) or define it in the document's components[]`
            : e.kind === 'generate-on-in-port'
              ? `port "${String(e.port)}": a generator (generate) originates traffic, so it lives on an OUT port — move it to one of the node's out ports`
              : e.kind === 'generate-on-edge'
                ? `wire: a generator (generate) is a PORT function — set it on the source out port (set_transform), not on a wire`
                : JSON.stringify(e),
        ),
      };
    }
    return evaluateGraph(g.value, this.registry, this.compiledClasses());
  }

  verdicts(): readonly Verdict[] {
    const e = this.evaluate();
    return e.ok ? e.value.verdicts : [];
  }
}
