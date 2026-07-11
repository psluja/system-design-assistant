import * as vscode from 'vscode';
import { registry, allManifests, protocolNote } from '@sda/content';
import { Key } from '@sda/engine-core';
import {
  wordAt, classifyHover, manifestHoverMarkdown, registryKeyHoverMarkdown,
  nodeRollups, rollupTitle, findInstanceIdAnchors, type NodeRollup,
} from './text-insights-pure';

// NATIVE text INSIGHTS for a `.sda.json` opened as PLAIN TEXT (Open With → Text Editor). Two providers — a HOVER
// over the raw JSON and a per-node CODELENS — bring the same honest engine facts to the text surface that the
// canvas already shows. Both are READ-ONLY: they never edit the document, so they cannot change any existing
// behaviour; the canvas remains the source of truth. All the decisions live in the pure module; these classes are
// thin glue mapping a vscode Position/document onto those pure functions.

/** Hover provider: maps a Position onto the pure classifiers/renderers. Registered only for the sda.json pattern. */
export class SdaHoverProvider implements vscode.HoverProvider {
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const line = document.lineAt(position.line).text;
    const span = wordAt(line, position.character);
    if (span === undefined) return undefined;

    const subject = classifyHover(line, span, {
      manifests: allManifests,
      isProtocol: (id) => protocolNote(id) !== undefined,
      isRegistryKey: (key) => registry.has(Key(key)),
    });
    if (subject === undefined) return undefined;

    let md: string | undefined;
    switch (subject.kind) {
      case 'type':
        md = manifestHoverMarkdown(subject.id, allManifests);
        break;
      case 'protocol': {
        const note = protocolNote(subject.id);
        md = note === undefined ? undefined : `**\`${subject.id}\`** — protocol\n\n${note}`;
        break;
      }
      case 'configKey':
        md = registryKeyHoverMarkdown(subject.key);
        break;
    }
    if (md === undefined) return undefined;

    const range = new vscode.Range(position.line, span.startCol, position.line, span.endCol);
    return new vscode.Hover(new vscode.MarkdownString(md), range);
  }
}

/**
 * CodeLens provider: one lens above each node's `"id"` line showing its live verdict roll-up (computed host-side
 * by the pure `nodeRollups`). Recompute is gated on `document.version` (cached otherwise) so hovering/scrolling
 * never re-evaluates; an edit fires `onDidChangeCodeLenses` and VS Code re-pulls lazily. Read-only and additive.
 */
export class SdaCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  // Per-document cache keyed by the document version — recompute only when the text actually changed.
  private readonly cache = new Map<string, { version: number; rollups: Map<string, NodeRollup> | null }>();
  private readonly subscription: vscode.Disposable;

  constructor() {
    // An edit to any open `.sda.json` invalidates its cached lenses; firing the event makes VS Code re-pull.
    this.subscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.fsPath.endsWith('.sda.json')) {
        this.cache.delete(e.document.uri.toString());
        this.changed.fire();
      }
    });
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const key = document.uri.toString();
    const cached = this.cache.get(key);
    const rollups = cached?.version === document.version ? cached.rollups : nodeRollups(document.getText());
    if (cached?.version !== document.version) this.cache.set(key, { version: document.version, rollups });
    // Parse/eval failed → no lenses (never a fabricated state; the Problems panel already carries the build error).
    if (rollups === null) return [];

    const lenses: vscode.CodeLens[] = [];
    for (const anchor of findInstanceIdAnchors(document.getText())) {
      const r = rollups.get(anchor.node);
      if (r === undefined) continue; // an id that is not an evaluated instance (e.g. a group) — no lens
      const range = new vscode.Range(anchor.line, 0, anchor.line, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: rollupTitle(r),
          command: 'sda.revealNode', // reveals on the canvas when it is open; no-ops honestly otherwise
          arguments: [anchor.node],
        }),
      );
    }
    return lenses;
  }
}

/** Register both text-insight providers for `.sda.json` files. Returns the disposables to push onto the
 *  extension's subscriptions. Called from `activate` — purely additive to the existing registration. */
export function registerTextInsights(): vscode.Disposable[] {
  const selector: vscode.DocumentSelector = { pattern: '**/*.sda.json' };
  const codeLens = new SdaCodeLensProvider();
  return [
    vscode.languages.registerHoverProvider(selector, new SdaHoverProvider()),
    vscode.languages.registerCodeLensProvider(selector, codeLens),
    codeLens,
  ];
}
