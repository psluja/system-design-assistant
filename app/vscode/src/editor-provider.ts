import * as vscode from 'vscode';
import { readdirSync as readDirSync } from 'node:fs';
import { isW2H, type H2W, type W2H } from './protocol';
import { EchoGuard } from './pure';
import { readActiveLensFeed, stripActiveLensFeed } from './lens-feed';
import { SdaDiagnostics } from './diagnostics';
import { SdaStatusBar } from './statusbar';
import { openDesignDoc } from './doc-command';
import { replaceWholeDocument } from './document-write';
import type { ActiveEditorRegistry } from './active-editor';

// The CustomTextEditorProvider: it makes a `.sda.json` TextDocument open as the SDA canvas while VS Code keeps
// owning the file (native save / dirty / hot-exit / undo-redo). The webview is CANVAS-ONLY; every other view is a
// native VS Code control fed by the webview's data messages (summary → System tree, nodeDetail → Inspector tree,
// selection → command context), which this provider forwards into the ActiveEditorRegistry. The document is the
// single source of truth; this class is the whole host↔webview bridge for one editor, wired strictly to protocol.ts.

/** A codicon color-theme kind mapped to the webview's binary light/dark (protocol.ts theme message). */
function themeKind(kind: vscode.ColorThemeKind): 'light' | 'dark' {
  // Dark AND HighContrast (dark) render on a dark canvas; everything else is treated as light.
  return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast ? 'dark' : 'light';
}

/** One quick-add QuickPick item carrying the component type id it selects (protocol.ts PickerOptionWire). */
interface PickItem extends vscode.QuickPickItem {
  readonly type?: string; // absent on separator rows
}

/**
 * Build the QuickPick items for the quick-add picker (TASK-63): group the options BY KIND, with a native separator
 * heading each group, so a long whole-catalogue list stays scannable ("compute / db / cache / …"). The options
 * arrive pre-sorted by the shared `pickerOptions` (type id, ascending); a stable group order falls out of first
 * appearance. `label` is the type id (what the user picks), `description` is the kind (also searchable via
 * matchOnDescription). Kinds render in the order they first appear so the grouping matches the sorted input.
 */
function pickItems(options: readonly { type: string; kind: string }[]): PickItem[] {
  const byKind = new Map<string, { type: string; kind: string }[]>();
  for (const o of options) {
    const group = byKind.get(o.kind);
    if (group === undefined) byKind.set(o.kind, [o]);
    else group.push(o);
  }
  const items: PickItem[] = [];
  for (const [kind, group] of byKind) {
    items.push({ label: kind, kind: vscode.QuickPickItemKind.Separator });
    for (const o of group) items.push({ label: o.type, description: o.kind, type: o.type });
  }
  return items;
}

export class SdaEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'sda.designEditor';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly diagnostics: SdaDiagnostics,
    private readonly statusBar: SdaStatusBar,
    /** The shared registry the native trees + commands consume; the provider publishes the active editor here. */
    private readonly active: ActiveEditorRegistry,
  ) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const distWebview = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    panel.webview.options = {
      enableScripts: true,
      // Lock the webview to its own bundle directory — it may load nothing else from disk.
      localResourceRoots: [distWebview],
    };
    panel.webview.html = this.buildHtml(panel.webview, distWebview);

    // The echo guard breaks the docChanged ⇄ docExternal loop (protocol.ts): we remember every text we push to
    // the webview or apply on the webview's behalf, and ignore the identical text when it comes back. NOTE: a
    // HOST-initiated edit (Inspector knob, Improve apply — done in commands.ts) deliberately does NOT arm this
    // guard, so its change flows through onDocChange as `docExternal` and the canvas reloads. See commands.ts
    // `applyDocumentEdit` for that contract.
    const echo = new EchoGuard();

    // Whole-document applies must be SEQUENCED: vscode.workspace.applyEdit is async, and two rapid docChanged
    // posts (e.g. an atomic add+wire arriving next to another edit) fired as fire-and-forget could complete
    // OUT OF ORDER — the stale snapshot would win and docExternal would revert the newer state on the canvas
    // (the user saw a fresh connection "flash" and vanish). A promise chain keeps applies strictly FIFO.
    let applyChain: Promise<unknown> = Promise.resolve();
    const applyInOrder = (text: string): void => {
      applyChain = applyChain.then(() => replaceWholeDocument(document, text)).catch(() => undefined);
    };

    // --- quick-add picker (TASK-63) -----------------------------------------------------------------------
    // The webview computes the LEGALITY-FILTERED options (shared @sda/presenter `pickerOptions`) and posts `pick`;
    // we present them as a NATIVE QuickPick and answer with `pickResult {token, picked}`. Only ONE picker is ever on
    // screen: a newer `pick` (a second drop, or N pressed while the first is still open) supersedes the previous by
    // hiding it — the hide's own `onDidHide` resolves the stale token with `null`, so the webview drops it.
    let activePick: vscode.QuickPick<PickItem> | undefined;
    const answerPick = (token: number, picked: string | null): void => {
      void panel.webview.postMessage({ type: 'pickResult', token, picked } satisfies H2W);
    };
    const showPick = (token: number, options: readonly { type: string; kind: string }[], placeholder: string): void => {
      // Supersede any picker still on screen — the user has started a new add. Clearing the reference first stops the
      // old picker's onDidHide from also answering the NEW token.
      if (activePick !== undefined) { const prev = activePick; activePick = undefined; prev.dispose(); }
      if (options.length === 0) {
        // An empty options list means nothing legally attaches here. A QuickPick with no items looks broken, so be
        // honest: answer null immediately and say why in the status bar (auto-clears).
        answerPick(token, null);
        vscode.window.setStatusBarMessage('SDA: nothing attaches to this port', 4000);
        return;
      }
      const qp = vscode.window.createQuickPick<PickItem>();
      qp.placeholder = placeholder;
      qp.matchOnDescription = true; // let the user filter by kind ("db", "compute") as well as by type id
      qp.items = pickItems(options);
      let answered = false;
      const done = (picked: string | null): void => {
        if (answered) return;
        answered = true;
        if (activePick === qp) activePick = undefined;
        answerPick(token, picked);
        qp.dispose();
      };
      qp.onDidAccept(() => done(qp.selectedItems[0]?.type ?? null));
      qp.onDidHide(() => done(null)); // dismissed (Esc / focus loss) or superseded → null, exactly once
      activePick = qp;
      qp.show();
    };

    // --- webview → host -----------------------------------------------------------------------------------
    const onMessage = panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (!isW2H(raw)) return;
      const msg = raw as W2H;
      switch (msg.type) {
        case 'ready': {
          // The webview booted; send it the document text to load its Studio from (protocol.ts docInit).
          const text = document.getText();
          echo.remember(text);
          void panel.webview.postMessage({ type: 'docInit', text } satisfies H2W);
          // Send the initial theme too, so first paint matches the editor.
          void panel.webview.postMessage({ type: 'theme', kind: themeKind(vscode.window.activeColorTheme.kind) } satisfies H2W);
          break;
        }
        case 'docChanged': {
          // The user edited on the canvas: write the full serialized project back into the TextDocument as a
          // WorkspaceEdit, which gives us native dirty state, save and undo/redo for free. Remember the text so
          // the resulting onDidChangeTextDocument is recognised as our own echo and not bounced back.
          if (echo.isEcho(msg.text)) break;
          echo.remember(msg.text);
          applyInOrder(msg.text);
          break;
        }
        case 'problems':
          this.diagnostics.publish(document, msg.items);
          break;
        case 'status':
          this.statusBar.update(msg.status);
          // Also feed the violation count to the registry so the System view's activity-bar badge tracks it
          // (the status bar shows it for the active editor; the badge is the persistent, at-a-glance signal).
          this.active.updateFeed(document, { violations: msg.status.violations });
          break;
        case 'summary':
          // Feed the native System tree. Ignored unless THIS editor is the active one (guarded in the registry). The
          // summary also RIDES the active-world lens id in a reserved section (lens-feed.ts — the frozen protocol has
          // no field for it): read it off for the native Inspector's world-aware routing, and STRIP it so the reserved
          // control section never renders as a System row.
          this.active.updateFeed(document, { summary: stripActiveLensFeed(msg.sections), activeScenario: readActiveLensFeed(msg.sections) });
          break;
        case 'nodeDetail':
          // Feed the native Inspector tree + the Suggest/editKnob command context.
          this.active.updateFeed(document, { detail: msg.detail, selection: msg.detail.node === '' ? null : msg.detail.node });
          break;
        case 'selection':
          // The canvas selection changed (without necessarily a fresh nodeDetail yet) — track it for commands.
          this.active.updateFeed(document, { selection: msg.node });
          break;
        case 'pick':
          // The QUICK-ADD picker (TASK-63): the webview computed the legality-filtered options; show them as a
          // NATIVE QuickPick and answer with `pickResult`. Correlation + supersession are handled by `showPick`.
          showPick(msg.token, msg.options, msg.placeholder);
          break;
        case 'designDoc':
          void openDesignDoc(msg.markdown, msg.title);
          break;
        case 'requestUndo':
          // Ctrl+Z inside the webview → run the NATIVE undo. With a custom text editor active, VS Code routes the
          // built-in undo/redo to the underlying document; the resulting text change flows back as docExternal.
          void vscode.commands.executeCommand('undo');
          break;
        case 'requestRedo':
          void vscode.commands.executeCommand('redo');
          break;
      }
    });

    // --- document → webview -------------------------------------------------------------------------------
    // Any change to THIS document that we did not just apply on the webview's behalf (native undo/redo, git
    // checkout, a manual text edit, ANOTHER host command like Improve/editKnob) is pushed to the webview so its
    // Studio reloads (protocol.ts docExternal). A HOST-initiated command edit is intentionally NOT echo-armed, so
    // it lands here and the canvas reloads to reflect it.
    const onDocChange = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      const text = e.document.getText();
      if (echo.isEcho(text)) return; // our own docChanged coming back — already reflected in the webview
      echo.remember(text);
      void panel.webview.postMessage({ type: 'docExternal', text } satisfies H2W);
    });

    // --- theme --------------------------------------------------------------------------------------------
    const onTheme = vscode.window.onDidChangeActiveColorTheme((theme) => {
      void panel.webview.postMessage({ type: 'theme', kind: themeKind(theme.kind) } satisfies H2W);
    });

    // --- active-editor tracking ---------------------------------------------------------------------------
    // Only the focused SDA editor should own the native views (Components/System/Inspector), the status bar and
    // the palette commands. Publish this panel as active while it has focus; clear it (and hide the status bar)
    // when focus leaves. Feed state (summary/detail/selection) is preserved by re-publishing nothing on blur —
    // the registry simply drops to `undefined`, and the trees show their placeholders.
    const applyActive = (isActive: boolean): void => {
      if (isActive) {
        this.active.activate(document, panel.webview);
        this.statusBar.show();
      } else {
        this.active.deactivate(document);
        this.statusBar.hide();
      }
    };
    applyActive(panel.active);
    const onViewState = panel.onDidChangeViewState((e) => applyActive(e.webviewPanel.active));

    // --- teardown -----------------------------------------------------------------------------------------
    panel.onDidDispose(() => {
      onMessage.dispose();
      onDocChange.dispose();
      onTheme.dispose();
      onViewState.dispose();
      // A closing editor must not leave a quick-add picker floating (its onDidHide would answer a webview that is
      // already gone — harmless, but dispose cleanly).
      if (activePick !== undefined) { const p = activePick; activePick = undefined; p.dispose(); }
      // A closed design leaves no stale Problems rows, no orphaned status bar, and no cached feeds.
      this.diagnostics.clear(document.uri);
      this.active.forget(document);
      this.statusBar.hide();
    });
  }

  /**
   * Build the webview HTML: a strict-CSP page that loads the vite-built bundle (webview.js + its CSS) from
   * dist/webview via asWebviewUri. Asset names are DISCOVERED from the dist directory (vite emits `webview.js`
   * and a `[name][extname]` CSS whose exact name is the webview author's choice), so this host never hardcodes a
   * name it cannot verify.
   */
  private buildHtml(webview: vscode.Webview, distWebview: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distWebview, 'webview.js'));
    const cssName = this.findCssAsset(distWebview);
    const styleTag = cssName === undefined ? '' : `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(distWebview, cssName))}" />`;
    // A per-load nonce would be ideal, but vite emits a plain <script src>; we instead trust ONLY the webview's
    // own cspSource for scripts/styles/img/font — nothing else may load, and there is no inline script at all.
    const csp = [
      `default-src 'none'`,
      `script-src ${webview.cspSource}`,
      // Styles allow 'unsafe-inline': React/xyflow set inline element styles for node positioning; the source is
      // still restricted to our bundle. No inline <style> block with untrusted content is ever injected.
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      // The DES runs in a Web Worker (a synchronous sim froze the whole workbench at high request rates).
      // Workers are SAME-ORIGIN-only and webview resources live on a different origin than the page, so the
      // webview FETCHES the worker chunk (hence connect-src) and boots it from a blob URL (hence blob:).
      `worker-src ${webview.cspSource} blob:`,
      `connect-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${styleTag}
  <title>SDA Design Canvas</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /**
   * Find the CSS asset vite emitted in dist/webview. Vite's `assetFileNames: '[name][extname]'` keeps the source
   * stylesheet's name, which the webview author controls — so we scan for the first `.css` file rather than
   * assume a name. Returns undefined if the bundle ships no stylesheet (a valid state; the page just has none).
   */
  private findCssAsset(distWebview: vscode.Uri): string | undefined {
    try {
      // Synchronous read is fine here — a webview resolve is not a hot path, and the directory is tiny.
      const entries = readDirSync(distWebview.fsPath);
      return entries.find((name) => name.endsWith('.css'));
    } catch {
      // dist/webview not built yet (dev before a webview build) — degrade to no stylesheet rather than throw.
      return undefined;
    }
  }
}
