import * as vscode from 'vscode';
import { delimiter } from 'node:path';
import { serialize, emptyProject } from '@sda/core';
import { PROMISES_TITLE } from '@sda/presenter';
import { newDesignName } from './pure';
import { SdaEditorProvider } from './editor-provider';
import { SdaDiagnostics } from './diagnostics';
import { SdaStatusBar } from './statusbar';
import { ActiveEditorRegistry } from './active-editor';
import { registerCommands } from './commands';
import { ComponentsTreeProvider, ComponentsDragController } from './views/components-tree';
import { SystemTreeProvider } from './views/system-tree';
import { InspectorTreeProvider } from './views/inspector-tree';
import { registerTextInsights } from './text-insights';
import { registerSloTests } from './slo-tests';
import type { H2W } from './protocol';

// Extension entry point. Wires the CustomTextEditorProvider, the three NATIVE views (Components / System /
// Inspector), the native Problems collection, the live-metrics status bar, and every `sda.*` command. The
// webview is CANVAS-ONLY; all other UX is native VS Code — the trees are fed by the webview's data messages
// (via the ActiveEditorRegistry) and the commands act host-side. Everything is registered on context
// subscriptions so VS Code disposes it on deactivate — no manual teardown, no leaks.

/** Canvas-GEOMETRY commands: they carry no host logic, they just tell the ACTIVE canvas to do the thing. Kept as
 *  a table so the command name and the forwarded protocol `cmd` cannot drift (the cmd channel is now geometry-only
 *  — every DATA mutation is a native host command in commands.ts). */
const CANVAS_COMMANDS = {
  'sda.tidy': 'tidy',
  'sda.fitView': 'fitView',
  'sda.addGroup': 'addGroup',
} as const satisfies Readonly<Record<string, Extract<H2W, { type: 'cmd' }>['cmd']>>;

/**
 * The extension's public API (the value `activate` returns → `vscode.extensions.getExtension(id).exports`). It is a
 * TEST-OBSERVABILITY seam only: VS Code exposes NO public API to enumerate a TreeDataProvider's items, so the real-VS-
 * Code e2e (test/suite) reads the LIVE System tree provider through this to assert its shape on the actual surface —
 * that "Add promise…" is a CHILD of the Promises section, never a floating root item. Nothing production consumes it.
 */
export interface SdaExtensionApi {
  /** The live System-view provider VS Code renders — `getChildren()` / `getTreeItem()` reflect the real tree. */
  readonly systemTree: SystemTreeProvider;
  /** The shared Promises-section title (from @sda/presenter) — so the e2e locates the section drift-proofly. */
  readonly promisesTitle: string;
}

export function activate(context: vscode.ExtensionContext): SdaExtensionApi {
  const diagnostics = new SdaDiagnostics();
  const statusBar = new SdaStatusBar();
  const active = new ActiveEditorRegistry();
  const provider = new SdaEditorProvider(context, diagnostics, statusBar, active);

  context.subscriptions.push(
    diagnostics,
    statusBar,
    active,
    // Retain each editor's state (undo/backing document) while it is hidden, so switching tabs does not reset the
    // canvas — the document is the source of truth and stays live.
    vscode.window.registerCustomEditorProvider(SdaEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
  );

  // The three native views. Components is static (content-driven); System + Inspector re-render off the active
  // editor's live feeds (they subscribe to the registry internally). We create the views with `createTreeView`
  // (rather than the simpler `registerTreeDataProvider`) because the System view carries an activity-bar BADGE —
  // the at-a-glance violation count — which only a TreeView handle exposes. The handles are disposed on teardown.
  const componentsView = vscode.window.createTreeView('sda.components', { treeDataProvider: new ComponentsTreeProvider(), dragAndDropController: new ComponentsDragController() });
  const systemTree = new SystemTreeProvider(active);
  const systemView = vscode.window.createTreeView('sda.system', { treeDataProvider: systemTree });
  const inspectorView = vscode.window.createTreeView('sda.inspector', { treeDataProvider: new InspectorTreeProvider(active) });
  context.subscriptions.push(componentsView, systemView, inspectorView);

  // The System view's activity-bar badge = the active design's violation count (0 / no editor → cleared). It
  // mirrors the status bar, but persists on the activity bar so a saturated design is visible even when the SDA
  // views are not focused. Recomputed on every registry change (a fresh status/summary or a focus change).
  const refreshBadge = (): void => {
    const violations = active.current?.violations ?? 0;
    systemView.badge = violations > 0 ? { value: violations, tooltip: `${violations} violation${violations === 1 ? '' : 's'}` } : undefined;
  };
  refreshBadge();
  context.subscriptions.push(active.onDidChange(refreshBadge));

  // The native DATA commands (add / edit knob / suggest / improve / reveal): they act host-side or drive the
  // canvas geometry, reading the active editor from the registry.
  context.subscriptions.push(...registerCommands(active));

  // Canvas-GEOMETRY commands forward to the focused SDA canvas; if none is focused the forward is a no-op (the
  // palette hides these unless `activeCustomEditorId == sda.designEditor`, but a keybinding could still fire).
  for (const [command, cmd] of Object.entries(CANVAS_COMMANDS)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => {
        void active.current?.webview.postMessage({ type: 'cmd', cmd } satisfies H2W);
      }),
    );
  }

  // The one command with host-side file logic: create a new design file and open it in the canvas.
  context.subscriptions.push(vscode.commands.registerCommand('sda.newDesign', () => newDesign()));

  // NATIVE text INSIGHTS for a `.sda.json` opened as PLAIN TEXT (Open With → Text Editor): a hover over
  // component types / protocol ids / config keys, and a per-node verdict codelens computed host-side. Read-only
  // and additive — the canvas stays the source of truth; these just surface the same engine facts on the text.
  context.subscriptions.push(...registerTextInsights());

  // The SLO Test Explorer: every user SLO (an instance band) on the active design becomes a native TEST in the
  // Testing view — Run judges each against the SAME queueing-aware verdict path the canvas uses (pass / fail with
  // the computed value + remediation / honest skip for unknown + tail SLOs). No auto-run; API-registered, so it
  // needs no package.json contribution. Additive — read-only over the document, the canvas stays the source of truth.
  context.subscriptions.push(registerSloTests());

  // NATIVE MCP: publish SDA's full toolset as an MCP server for Copilot / agent chat IN THIS EDITOR.
  registerMcpServer(context);

  // The test-observability API (see SdaExtensionApi) — the live System tree provider + the shared Promises title,
  // so the real-VS-Code e2e can assert the tree's parent/child shape on the actual surface. Production ignores it.
  return { systemTree, promisesTitle: PROMISES_TITLE };
}

/**
 * Register SDA's MCP server with VS Code's native MCP integration, so Copilot Chat / agent mode in the SAME editor
 * can design / evaluate / repair using SDA's tools (the command core + backward-search + synthesis + simulation +
 * reliability + design-doc). We spawn the BUNDLED stdio server (dist/mcp-server.cjs) with the editor's OWN Node
 * (`process.execPath`), so no external runtime is required — fully self-contained, no egress, matching the project's
 * "no required backend" invariant (the child is a plain local process the editor manages).
 *
 * HONEST SCOPE: the bundled server designs on its OWN in-memory Studio (like the standalone `@sda/mcp` binary). It is
 * NOT continuously bound to the live canvas — but its file-IO tools (import_design / save_design) read and
 * write the human's real workspace .sda.json files, and because saving to the OPEN file changes it on disk, the custom
 * editor live-reloads it (editor-provider docExternal). So an agent can move the human's canvas by saving the file it
 * imported. Paths are confined to the workspace folder(s), which we pass in via `SDA_WORKSPACE`. The continuous
 * live-canvas bridge remains app/bridge (Link AI).
 *
 * API: `vscode.lm.registerMcpServerDefinitionProvider` + the `contributes.mcpServerDefinitionProviders` manifest
 * point — FINALIZED (stable) in VS Code 1.101 (May 2025); package.json pins `engines.vscode` to `^1.101.0`
 * accordingly. The provider id here MUST match the id contributed in package.json.
 */
function registerMcpServer(context: vscode.ExtensionContext): void {
  const serverPath = context.asAbsolutePath('dist/mcp-server.cjs');
  // The workspace root(s) the server confines its file IO to — path-delimiter-joined so the child reads them back
  // (file-io.ts `workspaceRoots`). Recomputed on every provide so a folder added later is picked up.
  const roots = (): string => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath).join(delimiter);
  // Re-announce the definition when the workspace folders change, so SDA_WORKSPACE stays correct after a folder add/remove.
  const didChange = new vscode.EventEmitter<void>();
  context.subscriptions.push(didChange, vscode.workspace.onDidChangeWorkspaceFolders(() => didChange.fire()));
  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider('sda.mcpServers', {
      onDidChangeMcpServerDefinitions: didChange.event,
      provideMcpServerDefinitions: () => [
        // Constructor is positional: (label, command, args?, env?, version?). `process.execPath` is the editor's
        // bundled Node — the recommended way to run a Node-based server without assuming one is on PATH. `version`
        // tracks the extension so a rebuild prompts the editor to refresh the tools.
        new vscode.McpStdioServerDefinition(
          'System Design Assistant (edits your workspace .sda.json files)',
          process.execPath,
          [serverPath],
          { SDA_WORKSPACE: roots() },
          context.extension.packageJSON.version as string,
        ),
      ],
    }),
  );
}

export function deactivate(): void {
  // All disposables are on context.subscriptions; VS Code releases them. Nothing else to do.
}

/**
 * Create a NEW `.sda.json` design and open it in the canvas (owner: "there was nowhere to create a new project").
 * We ask WHERE to save it (a real file from the first keystroke, so native save/undo/hot-exit work), DEFAULTING to
 * the workspace root with the `.sda.json` extension enforced, then write a minimal VALID EMPTY project — the
 * canonical `emptyProject` at the current schema, NAMED from the chosen filename — and open it with the SDA custom
 * editor. Honest guards: a location OUTSIDE the workspace is steered back (a stray file is easy to lose); a write
 * failure surfaces its reason. The save dialog itself handles the overwrite confirmation. A blank canvas, not a demo:
 * the seeded sample is a first-run affordance elsewhere, never forced onto a design the user just named.
 */
async function newDesign(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  const root = folders !== undefined && folders.length > 0 ? folders[0]!.uri : undefined;
  const target = await vscode.window.showSaveDialog({
    title: 'New SDA Design',
    ...(root !== undefined ? { defaultUri: vscode.Uri.joinPath(root, 'design.sda.json') } : {}),
    filters: { 'SDA Design': ['sda.json'] },
    saveLabel: 'Create Design',
  });
  if (target === undefined) return; // user cancelled

  // A file outside every workspace folder is easy to lose — steer the user back into the project (guided, not silent).
  if (folders !== undefined && folders.length > 0 && !folders.some((f) => target.fsPath.startsWith(f.uri.fsPath))) {
    void vscode.window.showWarningMessage('SDA: save the design inside your workspace so it stays with the project.');
    return;
  }

  const name = newDesignName(target.path);
  const json = serialize(emptyProject(name, name));
  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(json, 'utf8'));
  } catch (e) {
    void vscode.window.showErrorMessage(`SDA: could not create the design — ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  // Open with OUR editor explicitly (a .sda.json also matches the default JSON editor by extension).
  await vscode.commands.executeCommand('vscode.openWith', target, SdaEditorProvider.viewType);
}
