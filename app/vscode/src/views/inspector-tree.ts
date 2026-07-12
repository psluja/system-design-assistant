import * as vscode from 'vscode';
import { formatRange, knobGroupOf, KNOB_GROUP_TITLE, SECTION_CAPTIONS, PROMISES_TITLE, overrideProvenanceBadge, overrideProvenanceLabel } from '@sda/presenter';
import type { Range, ScenarioOverride } from '@sda/content';
import type { KnobRow, NodeDetail, SuggestRow } from '../protocol';
import { summaryRowLabel, toneDecor, kindIcon, kindOf, isDimensionlessUnit } from '../pure';
import { sloRowsFor, type SloRow } from '../slo-requirements';
import { portRowsFor, formatTransform, transformParamOf, type PortRow } from '../port-transforms';
import { rangeMapFor } from '../ranges';
import { worldOverridesFor } from '../scenario-lens';
import type { ActiveEditorRegistry } from '../active-editor';

// The native INSPECTOR view (`sda.inspector`), modelled on the debugger's VARIABLES pane: everything about the
// SELECTED node, fed by the webview's `nodeDetail`. Top item = the node header (kind icon + type id as the muted
// description + an inline reveal action); under it the sections, each with a codicon. The knob sections are GROUPED
// BY THE REGISTRY ROLE AXIS rather than a flat
// "Configuration" list, so a reader sees the difference that matters — a belief about the world vs a ceiling the
// design commits to:
//   • Assumptions (facts about your world) ($(globe)) — one leaf per `fact-assumption` knob (offered load, a
//     service-time estimate, a caller's retry policy). Like Variables, the LABEL is the knob name and the dimmed
//     `description` is `value unit`. An inline pencil edits it; clicking the row also opens the InputBox (native →
//     host document edit → native undo). This is the native editing loop.
//   • Resource limits ($(settings)) — one leaf per `resource-limit` knob (concurrency, replicas, a quota, a mode) —
//     same editing loop; a ceiling/sizing choice the design commits to, not a world belief.
//   • Promises ($(target)) — the node's USER SLOs (an `instance.bands` entry). One row per band with the comparator
//     text ("throughput ≥ 5,000 rps"), an inline pencil (edit) and trash (remove); plus a trailing
//     "+ Add promise…" row. THIS is where "where do I enter my SLOs?" is answered on every node. The rows come
//     from the DOCUMENT text (bands aren't in the webview feed) — parsed here on each refresh (cheap; the band set
//     is tiny). Always present when a node is selected, even with zero SLOs (the + row must be discoverable).
//   • Verdicts ($(checklist)) — the node's own status rows with Testing-palette icons (error/warning/pass, tinted
//     red/yellow/green), rendered VERBATIM (never re-derived). This is the COMPUTED read-back (the role axis's
//     `computed`/`promise-target` results); it stays here, never mixed into the input knob groups.
//   • Suggestions ($(plus)) — one leaf per open port; click runs the suggester QuickPick for that port.
// Nothing selected → a single honest placeholder (and viewsWelcome offers guidance). The host renders the feed; it
// computes nothing. Every item carries a STABLE id (node + kind + key) so expansion survives a refresh.

/** The Inspector tree node union: the node header, a section header, or a specific leaf carrying its payload. */
type Item =
  | { readonly kind: 'node'; readonly detail: NodeDetail }
  | { readonly kind: 'section'; readonly section: SectionKind; readonly detail: NodeDetail }
  | { readonly kind: 'knob'; readonly node: string; readonly knob: KnobRow; readonly range?: Range; readonly world?: ScenarioOverride }
  | { readonly kind: 'slo'; readonly node: string; readonly row: SloRow }
  | { readonly kind: 'addSlo'; readonly node: string }
  | { readonly kind: 'port'; readonly node: string; readonly row: PortRow }
  | { readonly kind: 'verdict'; readonly node: string; readonly index: number; readonly label: string; readonly tone: SummaryTone }
  | { readonly kind: 'suggest'; readonly node: string; readonly row: SuggestRow };

/** The section groups under a node header, in display order (the role-grouped knobs → promises → ports → verdicts →
 *  suggestions). `assumptions`/`limits` are the two INPUT-knob groups of the registry role axis (presenter
 *  `knobGroupOf`); `promises` is the node's SLO bands. */
type SectionKind = 'assumptions' | 'limits' | 'promises' | 'ports' | 'verdicts' | 'suggestions';

/** The tone a verdict row carries (SummaryRow['tone'] — kept local so the union above stays readable). */
type SummaryTone = 'ok' | 'warn' | 'bad' | undefined;

/** The codicon + title for each section header, echoing the Variables/Testing grammar (a glyph per group). The
 *  knob-group + Promises titles come from the SHARED presenter constants so the two shells' headings never drift. */
const SECTION_META: Readonly<Record<SectionKind, { readonly title: string; readonly icon: string }>> = {
  assumptions: { title: KNOB_GROUP_TITLE.assumptions, icon: 'globe' },
  limits: { title: KNOB_GROUP_TITLE.limits, icon: 'settings' },
  promises: { title: PROMISES_TITLE, icon: 'target' },
  ports: { title: 'Ports', icon: 'plug' },
  verdicts: { title: 'Verdicts', icon: 'checklist' },
  suggestions: { title: 'Suggestions', icon: 'plus' },
};

export class InspectorTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly active: ActiveEditorRegistry) {
    this.active.onDidChange(() => this.emitter.fire(undefined));
  }

  getChildren(element?: Item): Item[] {
    if (element === undefined) {
      const detail = this.active.current?.detail;
      // `node === ''` is the webview's "nothing selected" sentinel; a missing feed is the same. Return NOTHING so
      // the contributed `viewsWelcome` empty-state renders (its friendly guidance replaces a bare placeholder row).
      if (detail === undefined || detail.node === '') return [];
      return [{ kind: 'node', detail }];
    }
    if (element.kind === 'node') {
      const d = element.detail;
      const sections: Item[] = [];
      // Only offer a section that has content — an empty "Suggestions" row would be absent-feature filler. The
      // EXCEPTION is Promises: it is ALWAYS shown for a selected node (even with zero SLOs) because its
      // "+ Add promise…" row is the entry point the user is looking for — hiding it when empty would be the
      // very gap this feature closes (there'd be nowhere to click to add the first SLO).
      // The knobs split by the registry role axis (presenter `knobGroupOf`): Assumptions (facts about your world)
      // then Resource limits, each shown only when it has a knob (no-filler). The two headings + order are the same
      // form the web Inspector renders.
      if (d.knobs.some((k) => knobGroupOf(k.key) === 'assumptions')) sections.push({ kind: 'section', section: 'assumptions', detail: d });
      if (d.knobs.some((k) => knobGroupOf(k.key) === 'limits')) sections.push({ kind: 'section', section: 'limits', detail: d });
      sections.push({ kind: 'section', section: 'promises', detail: d });
      // Ports is shown for a selected node with ports: it is the per-component transform knob the owner required on
      // EVERY component, so the entry point must be discoverable even when identity.
      const text = this.active.current?.document.getText() ?? '';
      if (portRowsFor(text, d.node).length > 0) sections.push({ kind: 'section', section: 'ports', detail: d });
      if (d.verdicts.length > 0) sections.push({ kind: 'section', section: 'verdicts', detail: d });
      if (d.suggestions.length > 0) sections.push({ kind: 'section', section: 'suggestions', detail: d });
      return sections;
    }
    if (element.kind === 'section') {
      const d = element.detail;
      if (element.section === 'assumptions' || element.section === 'limits') {
        // The knobs of THIS role group (Assumptions = fact-assumption keys; Resource limits = the rest). A knob's
        // uncertainty RANGE (if any) rides on the DESIGN TEXT, not the webview feed (which carries no range data —
        // protocol.ts is frozen), exactly like SLOs and ports. Read the node's ranges once and annotate each knob row
        // with its own, so a ranged knob renders distinctly + offers the clear action.
        const group = element.section;
        const rangeText = this.active.current?.document.getText() ?? '';
        const ranges = rangeMapFor(rangeText, d.node);
        // THE ACTIVE-WORLD LENS (assumption-model §7.1) — when a world is the active lens, an overridable knob READS
        // THAT world's value (a derived/frozen number), badged by provenance, so the native Inspector shows exactly
        // what the canvas shows (the consistency religion). Read off the DESIGN TEXT (like ranges/SLOs/ports — the
        // webview feed is frozen). No lens ⇒ the base values, bit-for-bit as before.
        const activeScenario = this.active.current?.activeScenario;
        const overrides = activeScenario !== undefined ? worldOverridesFor(rangeText, activeScenario, d.node) : undefined;
        return d.knobs
          .filter((knob) => knobGroupOf(knob.key) === group)
          .map((knob) => {
            const range = ranges.get(knob.key);
            const world = overrides?.get(knob.key);
            // The knob READS its world value when overridden (the base value stays in the document; the override rides
            // on the world) — so display + the edit-seed both show what the canvas shows.
            const shown = world !== undefined ? { ...knob, value: world.value } : knob;
            return { kind: 'knob', node: d.node, knob: shown, ...(range !== undefined ? { range } : {}), ...(world !== undefined ? { world } : {}) };
          });
      }
      if (element.section === 'promises') {
        // Bands aren't in the webview feed — read them straight from the active document text (cheap: the band set
        // is tiny). Each existing SLO becomes an editable/removable row; a trailing "+ Add promise…" row is the
        // always-present entry point (so a node with no SLOs still shows exactly where to add its first one).
        const text = this.active.current?.document.getText() ?? '';
        const rows: Item[] = sloRowsFor(text, d.node).map((row) => ({ kind: 'slo', node: d.node, row }));
        rows.push({ kind: 'addSlo', node: d.node });
        return rows;
      }
      if (element.section === 'ports') {
        // Ports (with their active transform) come from the DOCUMENT text + the catalog (like SLOs, not the feed):
        // instance override ?? manifest default ?? identity. One editable/clearable row per port.
        const text = this.active.current?.document.getText() ?? '';
        return portRowsFor(text, d.node).map((row) => ({ kind: 'port', node: d.node, row }));
      }
      if (element.section === 'verdicts') {
        return d.verdicts.map((row, index) => ({ kind: 'verdict', node: d.node, index, label: summaryRowLabel(row), tone: row.tone }));
      }
      return d.suggestions.map((row) => ({ kind: 'suggest', node: d.node, row }));
    }
    return []; // leaves
  }

  getTreeItem(element: Item): vscode.TreeItem {
    switch (element.kind) {
      case 'node': {
        const d = element.detail;
        // Header: the friendly label, the type id as the muted description, an icon by component KIND (the
        // type-id prefix), and an inline $(target) reveal action (contributed for `viewItem == sda.inspectorNode`).
        const item = new vscode.TreeItem(d.label || d.node, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `node:${d.node}`;
        item.description = d.typeId;
        item.iconPath = new vscode.ThemeIcon(kindIcon(kindOf(d.typeId)));
        item.contextValue = 'sda.inspectorNode';
        item.tooltip = new vscode.MarkdownString(`**${d.label || d.node}**\n\n\`${d.typeId}\`\n\nReveal on the canvas with the target action.`);
        return item;
      }

      case 'section': {
        const meta = SECTION_META[element.section];
        const item = new vscode.TreeItem(meta.title, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `section:${element.detail.node}:${element.section}`;
        item.iconPath = new vscode.ThemeIcon(meta.icon);
        // The SHARED one-line caption (what to fill, when, why) as the section tooltip — the native-tree equivalent
        // of the web Inspector's caption under the title. Same text (SECTION_CAPTIONS) on both shells ⇒ zero drift.
        if (element.section === 'assumptions' || element.section === 'limits' || element.section === 'promises') {
          item.tooltip = SECTION_CAPTIONS[element.section];
        }
        return item;
      }

      case 'knob': {
        // VARIABLES-pane grammar: the LABEL is the knob name; the dimmed `description` is `value unit`. A unit of
        // '1'/'' is dimensionless, so we show the bare number rather than a stray "1". A declared uncertainty RANGE
        // is appended as `· ±(lo–hi)` so a ranged knob reads distinctly, and the
        // range-aware contextValue swaps in the inline $(discard) clear action.
        const { knob, range, world } = element;
        const unit = isDimensionlessUnit(knob.unit) ? '' : ` ${knob.unit}`;
        const item = new vscode.TreeItem(knob.label, vscode.TreeItemCollapsibleState.None);
        item.id = `knob:${element.node}:${knob.key}`;
        // Under an active lens the value shown IS the world's value; its provenance badge (derived / frozen / manual)
        // rides the description so a derived placeholder reads distinctly from a hand-set one (doc §5.3).
        const worldBadge = world !== undefined ? ` · ${overrideProvenanceBadge(world.provenance)}` : '';
        item.description = `${knob.value}${unit}${range !== undefined ? ` · ${formatRange(range)}` : ''}${worldBadge}`;
        // A world-overridden knob tints its glyph "modified" (GitLens grammar) — it differs from the base in this world.
        item.iconPath = new vscode.ThemeIcon('symbol-numeric', world !== undefined ? new vscode.ThemeColor('gitDecoration.modifiedResourceForeground') : undefined);
        // Actions: Edit value + Set range always; Clear range when ranged; Clear world override (↺) when this knob is
        // overridden in the active world. The `.world` suffix drives the extra inline action (see package.json `=~`).
        const baseCtx = range !== undefined ? 'sda.knobRanged' : 'sda.knob';
        item.contextValue = world !== undefined ? `${baseCtx}.world` : baseCtx;
        item.tooltip = knobTooltip(element.node, knob, range, world);
        // Clicking the ROW also edits the VALUE (the pencil is a shortcut) → native InputBox → host edits the document.
        item.command = { command: 'sda.editKnob', title: 'Edit Value', arguments: [{ node: element.node, knob }] };
        return item;
      }

      case 'slo': {
        // One existing promise: the comparator text is the LABEL (e.g. "throughput ≥ 5,000 rps"), a $(target)
        // glyph marks it as an SLO. The inline pencil ($(edit)) re-opens the value InputBox (contextValue → the
        // contributed `view/item/context` actions); the inline trash removes it. Clicking the row edits it too.
        const { row } = element;
        const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
        item.id = `slo:${element.node}:${row.key}`;
        item.iconPath = new vscode.ThemeIcon('target');
        item.contextValue = 'sda.slo'; // → the inline $(edit) + $(trash) actions (contributed in package.json)
        item.tooltip = new vscode.MarkdownString(`Promise on **${element.node}**: ${row.label}\n\nEdit the value with the pencil, or remove it with the trash.`);
        // Pre-target the node AND the key so an edit skips straight to the value prompt for THIS promise.
        item.command = { command: 'sda.setSlo', title: 'Edit Promise', arguments: [{ node: element.node, key: row.key }] };
        return item;
      }

      case 'addSlo': {
        // The always-present entry point: "+ Add promise…" opens the promise QuickPick pre-targeted at this
        // node. This is the answer to "where do I enter my SLOs?" — one row under every selected node.
        const item = new vscode.TreeItem('Add promise…', vscode.TreeItemCollapsibleState.None);
        item.id = `addSlo:${element.node}`;
        item.iconPath = new vscode.ThemeIcon('add');
        item.tooltip = new vscode.MarkdownString(`State an SLO on **${element.node}** — throughput ≥, latency ≤, availability ≥, cost ≤, or a p99 tail ≤.`);
        item.command = { command: 'sda.setSlo', title: 'Add Promise', arguments: [{ node: element.node }] };
        return item;
      }

      case 'port': {
        // One port row: the LABEL is "name [dir]" (the port + its direction), the dimmed description is its
        // protocols and the ACTIVE transform (e.g. "https · ×100"). An OVERRIDE is marked with a GitLens-style
        // decoration — an $(edit)-glyph icon tinted for "modified" and a "· modified" description suffix — so a
        // per-instance transform reads as distinct from an identity/catalog port. Inline $(edit) sets/edits the
        // transform; inline $(discard) clears an override (contributed for `viewItem == sda.port`). Click also edits.
        const { row } = element;
        const protos = row.protocols.length > 0 ? row.protocols.slice(0, 2).join(', ') + (row.protocols.length > 2 ? '…' : '') : '';
        const tf = row.transform ? formatTransform(row.transform) : '';
        // The port's DECLARED guarantee contributions (read-only, doc: guarantee-propagation §4 "Inspector · a
        // Guarantees block on every port"). Shown compactly in the description as "<dimension>:<token>"; the full
        // provenance badge (documented / est.) rides the tooltip so a reviewer sees WHY each token is trusted.
        const gtee = row.guarantees.map((g) => `${g.dimension}:${g.token}`).join(', ');
        const parts = [protos, tf, gtee].filter((s) => s.length > 0);
        const item = new vscode.TreeItem(`${row.port} [${row.dir}]`, vscode.TreeItemCollapsibleState.None);
        item.id = `port:${element.node}:${row.port}`;
        // A transform present ⇒ a filled arrow-swap glyph (structural); an override additionally tints it "modified".
        item.iconPath = row.transform
          ? new vscode.ThemeIcon('arrow-swap', row.override ? new vscode.ThemeColor('gitDecoration.modifiedResourceForeground') : undefined)
          : new vscode.ThemeIcon('plug');
        item.description = parts.join(' · ') + (row.override ? ' · modified' : '');
        // The contextValue distinguishes a port WITH an override (offers clear) from one without — so the inline
        // $(discard) only appears where there is something to clear (see the two package.json menu `when` clauses).
        item.contextValue = row.override ? 'sda.portOverride' : 'sda.port';
        item.tooltip = portTooltip(element.node, row);
        item.command = { command: 'sda.setPortTransform', title: 'Set Transform', arguments: [{ node: element.node, port: row.port }] };
        return item;
      }

      case 'verdict': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.id = `verdict:${element.node}:${element.index}`;
        const decor = toneDecor(element.tone);
        if (decor !== undefined) item.iconPath = new vscode.ThemeIcon(decor.icon, new vscode.ThemeColor(decor.color));
        // The full verdict text as a tooltip too (the row may be truncated in a narrow view).
        item.tooltip = new vscode.MarkdownString(element.label);
        return item;
      }

      case 'suggest': {
        const { row } = element;
        // `port → option, option…` — the open port and the component types that legally attach (both from the
        // webview's "what fits" query). Click opens the suggester QuickPick pre-scoped to THIS port.
        const preview = row.options.length > 0 ? row.options.join(', ') : 'nothing fits';
        const item = new vscode.TreeItem(row.port, vscode.TreeItemCollapsibleState.None);
        item.id = `suggest:${element.node}:${row.port}`;
        item.description = preview;
        item.iconPath = new vscode.ThemeIcon('plug');
        item.tooltip = new vscode.MarkdownString(`Open port **${row.port}** (${row.dir})\n\nWhat fits: ${row.options.length > 0 ? row.options.map((o) => `\`${o}\``).join(', ') : '_nothing in the catalog_'}`);
        item.contextValue = 'sda.suggestion';
        item.command = { command: 'sda.suggest', title: 'Suggest What Fits', arguments: [{ node: element.node, port: row.port }] };
        return item;
      }
    }
  }
}

/**
 * A rich MarkdownString tooltip for a knob row: the knob's name, its stable registry KEY, and the current value in
 * its unit. The engine is domain-agnostic (there is no authored prose for a key), so we describe what we honestly
 * know — the human label, the machine key, and the live value — rather than invent an explanation.
 */
function knobTooltip(node: string, knob: KnobRow, range: Range | undefined, world: ScenarioOverride | undefined): vscode.MarkdownString {
  const unit = isDimensionlessUnit(knob.unit) ? '' : ` ${knob.unit}`;
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${knob.label}** — \`${knob.key}\`\n\n`);
  md.appendMarkdown(`Current value on **${node}**: \`${knob.value}${unit}\`\n\n`);
  // THE ACTIVE-WORLD LENS (doc §5.3): when this knob is overridden in the world being viewed, say so — the value is
  // the world's, its provenance, and that an edit writes into the world (not the base), with how to clear it.
  if (world !== undefined) {
    md.appendMarkdown(`In the active world: \`${world.value}${unit}\` — ${overrideProvenanceLabel(world.provenance)}.\n\n`);
    md.appendMarkdown(`Editing writes into this world (not the base); the ↺ action clears the override.\n\n`);
  }
  // The declared uncertainty RANGE — the honest admission this soft input is not a
  // point. Present only when set (no-filler); the base evaluation still uses the point value until a Monte-Carlo run.
  if (range !== undefined) {
    md.appendMarkdown(`Uncertainty range: \`${formatRange(range)}\` — sampled by the Monte-Carlo run; the base value stays \`${knob.value}\`.\n\n`);
    md.appendMarkdown(`Click the row or the pencil to edit the value; use the range actions to change or clear the ± range.`);
  } else {
    md.appendMarkdown(`Click the row or the pencil to edit. Use the ± action to declare an uncertainty range (a soft input like "1,500–3,000").`);
  }
  return md;
}

/**
 * A tooltip for a port row: the port + direction, its protocols, and the active traffic TRANSFORM (with whether it
 * is a per-instance override vs the catalog default). Describes only what we honestly know — no invented prose.
 */
function portTooltip(node: string, row: PortRow): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${row.port}** — port on **${node}** (${row.dir})\n\n`);
  if (row.protocols.length > 0) md.appendMarkdown(`Protocols: ${row.protocols.map((p) => `\`${p}\``).join(', ')}\n\n`);
  // The DECLARED guarantee contributions on this port, with provenance. Read-only,
  // sourced from the catalog: a `documented` token links its primary source; an `est.` token is badged as an honest
  // estimate. Only present when the port makes a guarantee claim (a plain sync/relay port has none — no filler).
  if (row.guarantees.length > 0) {
    md.appendMarkdown(`**Guarantees** (declared, read-only):\n\n`);
    for (const g of row.guarantees) {
      const badge = g.provenance === 'documented' && g.source ? `[documented](${g.source})` : g.provenance === 'estimate' ? '_est._' : '_declared_';
      md.appendMarkdown(`- \`${g.dimension}\`: **${g.token}** — ${badge}\n`);
    }
    md.appendMarkdown(`\n`);
  }
  if (row.transform) {
    md.appendMarkdown(`Transform: \`${row.transform.kind}(${transformParamOf(row.transform)})\` — ${formatTransform(row.transform)}${row.override ? ' _(overrides the catalog default)_' : ' _(catalog default)_'}\n\n`);
    md.appendMarkdown(`Edit with the pencil${row.override ? ', or clear the override with discard' : ''}.`);
  } else {
    md.appendMarkdown(`No transform (identity — passes traffic 1:1). Click the pencil to shape the rate this port carries.`);
  }
  return md;
}
