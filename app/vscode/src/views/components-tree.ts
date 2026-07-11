import * as vscode from 'vscode';
import { allManifests, type Manifest } from '@sda/content';
import { kindOf, kindIcon, providerOf, isDimensionlessUnit } from '../pure';

// The native COMPONENTS palette (view `sda.components`), modelled on GitLens' grouped trees: every placeable
// component TYPE from the content catalog, grouped by KIND (the type-id prefix before the first dot: 'compute',
// 'db', 'cache', …). A KIND group shows a themed codicon AND a dimmed `description` = its member COUNT (GitLens
// grammar). A component row shows the type id as its label, the PROVIDER (aws/oss, when derivable) as its dimmed
// description, an inline $(add) action, and a rich tooltip = the manifest's config-defaults table (key | default |
// unit). Clicking a row runs `sda.addComponent` → the active editor's webview places it. Pure content-driven data:
// the host lists what @sda/content offers and knows nothing about any specific service (the engine/host stay
// domain-agnostic; the meaning is all in the catalog). Every item has a STABLE id so expansion survives a refresh.

/** The tree node union: a KIND group (collapsible) or a component TYPE leaf (adds to the design on click). */
type Item = { readonly kind: 'group'; readonly name: string } | { readonly kind: 'type'; readonly type: string };

/**
 * A PLAIN, string-valued mime the webview can read back off `event.dataTransfer.getData(...)`. VS Code exposes a
 * tree drag over a webview as a standard HTML5 drag; the built-in tree mime
 * (`application/vnd.code.tree.sda.components`) carries only an OPAQUE list of internal handles, not our data — so
 * we ALSO publish this custom mime whose value is simply the component TYPE id. The webview's canvas `onDrop`
 * reads exactly this. Kept distinct from the web shell's own palette mime (`application/sda`) so the two DnD
 * sources never collide; the webview handles both.
 */
export const COMPONENT_DND_MIME = 'application/x-sda-component';

/**
 * Drag a palette leaf onto the canvas to place it — the native counterpart to clicking the row / the inline
 * `$(add)`. VS Code's `TreeDragAndDropController` is the only way a native tree contributes DnD: `handleDrag`
 * writes the dragged component's TYPE id into the DataTransfer under our custom mime, and the webview reads that
 * id on drop (there is NO host round-trip — the drop lands as a DOM event inside the webview). Groups are not
 * draggable (dropping a whole kind is meaningless); dragging one yields nothing, so it is a harmless no-op.
 * There is no `handleDrop` because this tree never RECEIVES a drop — it is a drag SOURCE only.
 */
export class ComponentsDragController implements vscode.TreeDragAndDropController<Item> {
  // We produce our custom mime; the implicit tree mime is added by VS Code automatically. No drop target here.
  readonly dropMimeTypes: readonly string[] = [];
  readonly dragMimeTypes: readonly string[] = [COMPONENT_DND_MIME];

  handleDrag(source: readonly Item[], dataTransfer: vscode.DataTransfer): void {
    // Only a single component leaf carries a placeable id; ignore multi-select and group headers honestly.
    const leaf = source.find((s): s is { readonly kind: 'type'; readonly type: string } => s.kind === 'type');
    if (leaf === undefined) return;
    dataTransfer.set(COMPONENT_DND_MIME, new vscode.DataTransferItem(leaf.type));
    // PLATFORM LIMIT (vscode#182449): during a workbench-internal drag every webview is DISABLED as a drop
    // target (an overlay eats the events) — VERIFIED with a CDP-instrumented real drag: zero drag events reach
    // the canvas document. Holding SHIFT re-enables webviews (vscode PR #209211). We can't lift the limit, so
    // we surface the trick the moment a drag starts; the message retires itself with the drag.
    void vscode.window.setStatusBarMessage(`$(info) Hold Shift to drop ${leaf.type} onto the canvas`, 8000);
  }
}

export class ComponentsTreeProvider implements vscode.TreeDataProvider<Item> {
  /** Groups → their sorted member type ids, built once from the catalog (content is static for the session). */
  private readonly groups: ReadonlyMap<string, readonly string[]>;

  constructor() {
    const byKind = new Map<string, string[]>();
    for (const type of Object.keys(allManifests)) {
      const k = kindOf(type);
      const list = byKind.get(k) ?? [];
      list.push(type);
      byKind.set(k, list);
    }
    for (const list of byKind.values()) list.sort();
    // A stable, alphabetical group order so the palette layout never jitters between sessions.
    this.groups = new Map([...byKind.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  getChildren(element?: Item): Item[] {
    if (element === undefined) {
      return [...this.groups.keys()].map((name) => ({ kind: 'group', name }));
    }
    if (element.kind === 'group') {
      return (this.groups.get(element.name) ?? []).map((type) => ({ kind: 'type', type }));
    }
    return []; // a type leaf has no children
  }

  getTreeItem(element: Item): vscode.TreeItem {
    if (element.kind === 'group') {
      const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `group:${element.name}`;
      const count = this.groups.get(element.name)?.length ?? 0;
      // GitLens grammar: a dimmed COUNT on the right of the group header (just the number).
      item.description = String(count);
      item.iconPath = new vscode.ThemeIcon(kindIcon(element.name));
      item.tooltip = new vscode.MarkdownString(`**${element.name}** — ${count} component${count === 1 ? '' : 's'}`);
      item.contextValue = 'sda.componentGroup';
      return item;
    }
    // A component type: label = the full type id (the stable identifier the user places); description = the
    // PROVIDER (aws/oss) when we can honestly derive it from the id — otherwise nothing (no invented label).
    const item = new vscode.TreeItem(element.type, vscode.TreeItemCollapsibleState.None);
    // NOTE: this id doubles as the DnD PAYLOAD. VS Code strips the value of extension-custom mimes when a
    // tree drag becomes a native drag (vscode#245816), but the built-in tree mime keeps the item HANDLES —
    // which embed this id. The webview's dropType() parses "type:<id>" back out; keep the scheme in sync.
    item.id = `type:${element.type}`;
    const provider = providerOf(element.type);
    if (provider !== undefined) item.description = provider;
    item.tooltip = componentTooltip(element.type);
    item.iconPath = new vscode.ThemeIcon(kindIcon(kindOf(element.type)));
    item.contextValue = 'sda.component'; // → the inline $(add) action (contributed in package.json)
    // Deliberately NO click command: a plain row click used to add the component — the same action as the
    // inline "+" — and users added nodes ACCIDENTALLY while browsing the palette (user finding, 2026-07-02).
    // Adding is explicit now: the inline "+" action or a drag onto the canvas.
    return item;
  }
}

/**
 * A rich MarkdownString tooltip for a component type: its id, provider, and the manifest's CONFIG-DEFAULTS table
 * (key | default | unit) — the real, sourced numbers the block ships with, so an architect can see what they get
 * before placing it. Rendered VERBATIM from the manifest data (never re-derived). A block with no config knobs
 * (e.g. a pure client) shows just the header — honest, not a fabricated table.
 */
function componentTooltip(typeId: string): vscode.MarkdownString {
  const manifest: Manifest | undefined = allManifests[typeId];
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${typeId}**`);
  const provider = providerOf(typeId);
  if (provider !== undefined) md.appendMarkdown(`  ·  _${provider}_`);
  md.appendMarkdown('\n\n');

  const config = manifest?.config ?? [];
  if (config.length === 0) {
    md.appendMarkdown('_No configuration knobs — click to add to the design._');
    return md;
  }
  md.appendMarkdown('| Key | Default | Unit |\n| --- | ---: | --- |\n');
  for (const c of config) {
    const unit = isDimensionlessUnit(c.unit) ? '—' : c.unit;
    md.appendMarkdown(`| ${String(c.key)} | ${c.value} | ${unit} |\n`);
  }
  return md;
}
