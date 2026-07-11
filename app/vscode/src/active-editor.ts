import * as vscode from 'vscode';
import type { NodeDetail, SummarySection } from './protocol';

// The one place the "which SDA editor is the user looking at, and what has it computed" question is answered.
// The custom-editor provider OWNS the webview and the document, but the native trees (Components / System /
// Inspector) and the native commands (Improve / Suggest / editKnob) are created ONCE at activation and must
// reach WHATEVER editor is currently active — a moving target as the user switches tabs. This module is that
// seam: the provider PUBLISHES the active editor's live state here; the trees and commands CONSUME it and
// re-render on its change event. Keeping it separate (not on the provider) means a tree never holds a
// provider reference and the wiring stays one-directional (provider → registry → views).

/** The webview-computed display feeds for one design (rendered VERBATIM — the host never re-derives them). */
interface Feeds {
  /** The last `summary` the webview posted (System tree). Undefined until the first evaluation. */
  readonly summary?: readonly SummarySection[];
  /** The last `nodeDetail` the webview posted (Inspector tree). Undefined until a selection has detail. */
  readonly detail?: NodeDetail;
  /** The canvas's current selection (Inspector context for Suggest/editKnob). null = nothing selected. */
  readonly selection: string | null;
  /** The ACTIVE-WORLD LENS id the webview is showing (assumption-model §7.1), read off the summary feed's reserved
   *  section (see lens-feed.ts) — undefined ⇒ the base lens. This is the ONE piece of view state the frozen protocol
   *  does not otherwise carry; the native Inspector reads it to show the active world's values and route a
   *  fact-assumption edit INTO that world (the consistency religion), never to the shared base. `| undefined` is
   *  explicit so a lens switch back to base can CLEAR it through `updateFeed` (a present-undefined patch overwrites). */
  readonly activeScenario?: string | undefined;
  /** The last violation count from the webview's `status` feed — drives the System view's activity-bar BADGE.
   *  Undefined until the first status arrives (badge cleared). */
  readonly violations?: number;
}

/**
 * The live state of the currently-active SDA editor: its document + webview (so a command can edit the document
 * and talk to the canvas), plus the webview's latest display feeds. `undefined` for the whole state means no SDA
 * editor is active (a design was closed or focus moved to a non-SDA editor).
 */
export interface ActiveEditorState extends Feeds {
  readonly document: vscode.TextDocument;
  readonly webview: vscode.Webview;
}

/**
 * A tiny observable holder for the active editor's state. The provider publishes as focus/feeds change; views and
 * commands read `.current` and subscribe to `.onDidChange`. It is deliberately dumb — no vscode surface beyond the
 * event emitter — so it never becomes a second source of truth (the document is THE source; this only mirrors the
 * webview's derived display feeds).
 *
 * Feeds are cached PER DOCUMENT so they survive a blur: a webview only re-posts summary/nodeDetail on evaluation,
 * so wiping them on every focus change would flash the System/Inspector trees to their placeholders when the user
 * merely tabs away and back. The cache is purged when a design's editor is disposed (`forget`), so a closed file
 * never leaves stale feeds behind.
 */
export class ActiveEditorRegistry {
  private state: ActiveEditorState | undefined;
  private readonly feeds = new Map<vscode.TextDocument, Feeds>();
  private readonly emitter = new vscode.EventEmitter<void>();

  /** Fires whenever the active editor OR any of its feeds changes, so views can refresh. */
  readonly onDidChange = this.emitter.event;

  /** The active SDA editor's state, or undefined when no design is focused. */
  get current(): ActiveEditorState | undefined {
    return this.state;
  }

  /** Make `document`/`webview` the active editor (a panel gained focus), restoring its cached feeds. */
  activate(document: vscode.TextDocument, webview: vscode.Webview): void {
    const feeds = this.feeds.get(document) ?? { selection: null };
    this.state = { document, webview, ...feeds };
    this.emitter.fire();
  }

  /**
   * Clear the ACTIVE editor IF it is `document` (a design lost focus). Guarded by identity so a background
   * editor's blur can't wipe the state of the one the user is actually looking at. The document's feeds stay
   * CACHED (it may regain focus) — only `forget` drops them, when the editor is disposed.
   */
  deactivate(document: vscode.TextDocument): void {
    if (this.state?.document === document) {
      this.state = undefined;
      this.emitter.fire();
    }
  }

  /** Drop a document's cached feeds entirely (its editor was disposed) — no stale rows for a closed design. */
  forget(document: vscode.TextDocument): void {
    this.feeds.delete(document);
    this.deactivate(document);
  }

  /**
   * Record new feed data for `document` (from its webview) into the cache, and — if that document is the active
   * one — into the live state so the trees refresh. Feeds arrive out of band; caching them per document (not only
   * on the active state) is what lets a re-focused tab restore instantly. A message for a document with no cache
   * entry yet seeds one (its webview posts before the panel is necessarily marked active).
   */
  updateFeed(document: vscode.TextDocument, patch: Partial<Feeds>): void {
    const prior = this.feeds.get(document) ?? { selection: null };
    const merged: Feeds = { ...prior, ...patch };
    this.feeds.set(document, merged);
    if (this.state?.document === document) {
      this.state = { ...this.state, ...merged };
      this.emitter.fire();
    }
  }

  dispose(): void {
    this.feeds.clear();
    this.emitter.dispose();
  }
}
