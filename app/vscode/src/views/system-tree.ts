import * as vscode from 'vscode';
import { toneDecor, sectionIcon, systemRootItems, systemSectionChildren, type SystemItem as Item } from '../pure';
import type { ActiveEditorRegistry } from '../active-editor';

// The native SYSTEM view (`sda.system`), modelled on the TESTING view: the whole-design summary the webview
// computes after each evaluation (Design / promises / flows / tail latency / load / cost). It renders the `summary`
// feed VERBATIM — the host never re-derives a number the human doesn't already see (web-is-a-dumb-renderer). Each
// SummarySection is a collapsible parent with a codicon (topology / promises / flow / time / load / cost); each
// SummaryRow is a leaf whose LABEL is the metric name and whose dimmed `description` is the VALUE — with a
// Testing-palette tone icon (error/warning/pass tinted red/yellow/green). A `bad` row is unmissable (red error
// glyph). Sections default EXPANDED (the summary is the point of the view) and every item has a STABLE id so
// expansion survives a refresh.
//
// ONE FORM (owner ruling — the consistency religion): the whole-system Promises section is STRUCTURALLY IDENTICAL to
// the node Inspector's Promises section. The presenter always emits a 'Promises' section (title = the shared
// PROMISES_TITLE, even with zero rows), and the "Add promise…" action is its LAST CHILD — never a floating top-level
// item. The parent/child DECISION lives in pure.ts (`systemRootItems` / `systemSectionChildren`, unit-tested); this
// provider is thin glue that maps each item to its `TreeItem` (icon + command).

export class SystemTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly active: ActiveEditorRegistry) {
    // Re-render whenever the active editor or its summary feed changes.
    this.active.onDidChange(() => this.emitter.fire(undefined));
  }

  getChildren(element?: Item): Item[] {
    // Root → one parent per summary section (no floating action row); a section → its rows + (for Promises) the
    // "Add promise…" child. Both decisions are the pure helpers, so the shape is proven vscode-free. An absent/empty
    // summary yields no roots, so the contributed `viewsWelcome` empty-state shows its guidance instead.
    if (element === undefined) return systemRootItems(this.active.current?.summary);
    if (element.kind === 'section') return systemSectionChildren(element.section);
    return [];
  }

  getTreeItem(element: Item): vscode.TreeItem {
    if (element.kind === 'addRequirement') {
      // The always-present entry point, rendered as the LAST CHILD of the Promises section (one form with the node
      // Inspector's "+ Add promise…", which sits inside its Promises group) — never a floating top-level item.
      // QUANTITY-FIRST (owner ruling: pick WHAT is promised first; cost is for THE WHOLE SYSTEM): Cost lands in the
      // design's top-level systemPromises (judged against the full bill — every component, off-path branches
      // included) and NEVER asks for a flow; the flow quantities (throughput / latency / availability / p99) land on
      // the picked flow's terminal, like the web System panel.
      const item = new vscode.TreeItem('Add promise…', vscode.TreeItemCollapsibleState.None);
      item.id = 'action:addSystemRequirement';
      item.iconPath = new vscode.ThemeIcon('add');
      item.tooltip = 'Declare an end-to-end promise — pick WHAT to promise first. Cost covers the WHOLE system (no flow to pick; judged against the full monthly bill); throughput, latency, availability and the p99 tail are checked on a request flow (auto-picked when there is one).';
      item.command = { command: 'sda.setSystemRequirement', title: 'Add Promise' };
      return item;
    }
    if (element.kind === 'section') {
      // Sections open by default with a glyph per group (Testing-view grammar): the summary is the point of the
      // view, so the user shouldn't have to expand it. A stable id keeps a manually-collapsed section collapsed.
      const item = new vscode.TreeItem(element.section.title, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `section:${element.section.title}`;
      item.iconPath = new vscode.ThemeIcon(sectionIcon(element.section.title));
      return item;
    }
    // A value row: the LABEL is the metric name; the dimmed `description` is the value (Testing-view leaf grammar).
    const { row } = element;
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.id = `row:${element.section}:${element.index}`;
    if (row.value !== '') item.description = row.value;
    const decor = toneDecor(row.tone);
    if (decor !== undefined) {
      item.iconPath = new vscode.ThemeIcon(decor.icon, new vscode.ThemeColor(decor.color));
      // A violation must be unmissable: repeat the tone in the tooltip so hover confirms the red glyph's meaning.
      // `supportThemeIcons` lets the `$(…)` codicon render inside the markdown tooltip.
      if (row.tone === 'bad' || row.tone === 'warn') {
        const glyph = row.tone === 'bad' ? '$(error) **Violation**' : '$(warning) **Warning**';
        const md = new vscode.MarkdownString(`${glyph} — ${row.label}: ${row.value}`, true);
        item.tooltip = md;
      }
    }
    return item;
  }
}
