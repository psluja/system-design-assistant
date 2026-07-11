// Pure, vscode-free logic — everything here is a plain function of its inputs so it can be unit-tested under
// vitest (which cannot load the `vscode` module). The modules that DO import `vscode` (editor-provider,
// diagnostics, statusbar) delegate their non-trivial decisions here, so the interesting behaviour is covered
// by tests and the vscode-facing files stay thin glue.

import { formatMs, PROMISES_TITLE } from '@sda/presenter';
import type { SummaryRow, SummarySection, WireStatus } from './protocol';

/** A zero-based text span for a diagnostic: the line, and the column range to underline on it. */
export interface TextRange {
  readonly line: number;
  readonly startCol: number;
  readonly endCol: number;
}

/**
 * Locate a node's `"id": "<node>"` declaration in the serialized project JSON and return the span of the id
 * VALUE (the part between the quotes), so the Problems panel underlines the offending node's id — the anchor a
 * reader recognises. We search the whole text (not per-line regex) so both spacing styles are handled, then
 * derive line/column from the match offset.
 *
 * Why a text search rather than a JSON walk: the diagnostic must point at a RANGE in the exact document text the
 * user sees and edits; a re-serialization would drift from their formatting. `node === ''` means a whole-design
 * problem (a build error with no owning node) — the caller ranges it at 0,0, so we return null here.
 *
 * Returns null when the node id is absent from the text (e.g. it lives only in a derived value, or the document
 * was hand-edited) — the caller falls back to 0,0 rather than inventing a misleading location.
 */
export function findNodeIdRange(text: string, node: string): TextRange | null {
  if (node === '') return null;
  // Match `"id"` then `:` then the quoted value, tolerating any run of whitespace on either side of the colon
  // (covers both `"id": "x"` from JSON.stringify(…, 2) and a hand-minified `"id":"x"`). The node id is embedded
  // as a literal — it is a component id (safe token), but escape it defensively so a regex metachar can't break
  // the search or match the wrong place.
  const needle = new RegExp(idPairPattern(node));
  const m = needle.exec(text);
  if (m === null) return null;
  // Offset of the id VALUE's first character = match start + length of the `"id" : "` prefix before the value.
  const prefix = m[0].length - (node.length + 1); // +1 for the closing quote that m[0] includes after the value
  const valueStart = m.index + prefix;
  const before = text.slice(0, valueStart);
  const line = countNewlines(before);
  const lastNl = before.lastIndexOf('\n');
  const startCol = valueStart - (lastNl + 1); // chars since the start of this line
  return { line, startCol, endCol: startCol + node.length };
}

/** Escape a literal so it can be embedded safely inside a `RegExp` (any metachar becomes inert). Shared by every
 *  lexical search over the design text (node-id and config-key locators) so the same escaping rule is applied once. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The regex SOURCE that matches a node's `"id": "<node>"` member, tolerating any whitespace around the colon (so
 *  both the pretty `"id": "x"` and the minified `"id":"x"` spacing resolve). The one place this shape is defined —
 *  the diagnostics range finder and the document-edit instance locator both build from it, so they never drift. */
export function idPairPattern(node: string): string {
  return `"id"\\s*:\\s*"${escapeRegExp(node)}"`;
}

/** True when a registry unit carries no dimension to display — the empty string or the canonical dimensionless
 *  `'1'`. Shared so every native surface (Inspector knobs, the palette tooltip, SLO failure text) suppresses a
 *  stray "1"/"" the same way, rather than each re-deriving the rule. */
export function isDimensionlessUnit(unit: string): boolean {
  return unit === '' || unit === '1';
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10 /* \n */) n++;
  return n;
}

/**
 * The echo guard as a tiny state machine (protocol.ts "DOCUMENT SYNC"). The host and the webview each apply the
 * other's text; without a guard, applying an incoming text triggers a change event that would be echoed straight
 * back, ping-ponging forever. Rule: remember the exact text we last SENT to the webview or APPLIED to the
 * document; ignore any subsequent message whose text equals it (that message is our own change coming back).
 *
 * It is a class (not a bare string) so the intent is explicit at every call site — `remember(text)` on the way
 * out, `isEcho(text)` on the way in — and so it is trivially unit-testable in isolation.
 */
export class EchoGuard {
  private last: string | undefined;

  /** Record text we just sent/applied, so its echo can be recognised and dropped (EOL-insensitively). */
  remember(text: string): void {
    this.last = canonicalEol(text);
  }

  /** True when `text` matches what we last remembered UP TO LINE ENDINGS — our own change coming back,
   *  possibly EOL-normalized by the TextDocument (see canonicalEol); drop it. */
  isEcho(text: string): boolean {
    return this.last !== undefined && canonicalEol(text) === this.last;
  }
}

/** Line-ending–insensitive canonical form for document-sync comparisons. VS Code NORMALIZES text inserted by
 *  a WorkspaceEdit to the DOCUMENT's end-of-line — a file authored with CRLF (e.g. by an AI agent's file
 *  tools on Windows) stays CRLF even though our serializer emits LF. Raw-string comparison therefore saw
 *  every echo as a foreign change, and the docChanged⇄docExternal loop spun forever: constant re-evaluation,
 *  a permanently dirty document, a frozen editor. JSON content is EOL-agnostic, so canonicalizing to LF for
 *  COMPARISON (never for what we write) is lossless and kills the loop for any mix of file EOLs. */
export function canonicalEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Format the status-bar text from the live metrics (protocol.ts WireStatus). We show only what the engine
 * actually computed — a missing metric is OMITTED, never rendered as 0 or "—" (the tool must not lie). Numbers
 * use thousands separators for readability. The violations segment carries a codicon: `$(error) N` when there
 * are any, `$(check)` when the design is clean.
 *
 * Example: `$(pulse) 2,000 rps · 71 ms · $285/mo · $(error) 2`
 */
export function formatStatus(status: WireStatus): string {
  const parts: string[] = [];
  if (status.throughputRps !== undefined) parts.push(`${formatNumber(Math.round(status.throughputRps))} rps`);
  if (status.latencyMs !== undefined) parts.push(formatMs(status.latencyMs));
  if (status.costUsdMonth !== undefined) parts.push(`$${formatNumber(Math.round(status.costUsdMonth))}/mo`);
  parts.push(status.violations > 0 ? `$(error) ${status.violations}` : '$(check)');
  return `$(pulse) ${parts.join(' · ')}`; // · = middle dot ·
}

/** A tooltip that explains each segment of the status bar, so the compact line is self-describing on hover. */
export function statusTooltip(status: WireStatus): string {
  const lines: string[] = ['SDA — live system metrics'];
  lines.push(status.throughputRps !== undefined ? `Throughput: ${formatNumber(Math.round(status.throughputRps))} req/s` : 'Throughput: unknown');
  lines.push(status.latencyMs !== undefined ? `Latency (worst flow): ${formatMs(status.latencyMs)}` : 'Latency: unknown');
  lines.push(status.costUsdMonth !== undefined ? `Cost: $${formatNumber(Math.round(status.costUsdMonth))}/month` : 'Cost: unknown');
  lines.push(status.violations > 0 ? `${status.violations} violation${status.violations === 1 ? '' : 's'} — click to fix all` : 'No violations — click to open Problems');
  return lines.join('\n');
}

/**
 * The label a native tree LEAF shows for one summary/verdict row: `label: value`. A row with no value (rare,
 * e.g. a section note) degrades to just the label rather than a dangling colon. Kept pure so the System and
 * Inspector trees render identically and the mapping is unit-tested (they must not each re-invent the format).
 */
export function summaryRowLabel(row: SummaryRow): string {
  return row.value === '' ? row.label : `${row.label}: ${row.value}`;
}

/**
 * The codicon ID for a summary/verdict row's tone, or undefined for a row that carries no problem. `bad` →
 * `error`, `warn` → `warning`; `ok`/absent tone → no icon (a clean row shouldn't shout for attention — the
 * native trees stay quiet unless something is wrong, matching the "no absent-feature filler" principle).
 * Returns the bare codicon NAME (e.g. 'error'); the vscode-facing tree wraps it in a ThemeIcon.
 */
export function toneIcon(tone: SummaryRow['tone']): string | undefined {
  switch (tone) {
    case 'bad':
      return 'error';
    case 'warn':
      return 'warning';
    default:
      return undefined; // 'ok' or no tone — render no icon
  }
}

/**
 * The full status DECORATION for a summary/verdict row — the codicon NAME plus the `ThemeColor` id, mirroring the
 * native Testing view's palette so a design's health reads at a glance the way test results do:
 *   • `bad`  → `error`   + `charts.red`    (a violation — unmissable)
 *   • `warn` → `warning` + `charts.yellow` (a caution)
 *   • `ok`   → `pass`    + `charts.green`  (verified — the green tick the Testing view uses)
 *   • absent → undefined                   (a plain note/value row with no health signal; render no icon)
 *
 * `color` is a workbench `ThemeColor` id (the vscode-facing tree wraps it in a `vscode.ThemeColor`). We DO surface
 * the green `ok` tick here (unlike the quieter `toneIcon`): in the System/Inspector trees a passing check is
 * meaningful signal — it tells the architect the design MEETS that requirement, not merely that nothing is wrong.
 */
export interface ToneDecor {
  readonly icon: string;
  readonly color: string;
}
export function toneDecor(tone: SummaryRow['tone']): ToneDecor | undefined {
  switch (tone) {
    case 'bad':
      return { icon: 'error', color: 'charts.red' };
    case 'warn':
      return { icon: 'warning', color: 'charts.yellow' };
    case 'ok':
      return { icon: 'pass', color: 'charts.green' };
    default:
      return undefined; // no tone → a plain value/note row, no health decoration
  }
}

/**
 * The PROVIDER a component type belongs to, for the palette's dimmed right-hand hint (GitLens lists show the
 * remote/source this way). It is a display facet only — the engine stays domain-agnostic and the type id carries
 * no provider segment, so we recognise the well-known technology in the id's SECOND segment ('db.aurora' → aws,
 * 'db.postgres' → oss). Anything unrecognised returns undefined (no guess) and the row simply shows no provider —
 * honest silence over an invented label. Case-folded so 'DB.Postgres' and 'db.postgres' agree.
 */
const AWS_TECH: ReadonlySet<string> = new Set([
  'sqs', 'sns', 'dynamodb', 'lambda', 'aurora', 'cloudfront', 'alb', 'nlb', 'elb', 'waf', 'rest', 'transcribe',
  'bedrock', 'polly', 'fargate', 'ecs', 'eks', 's3', 'rds', 'kinesis', 'sfn', 'apigw', 'cloudwatch', 'route53',
]);
const OSS_TECH: ReadonlySet<string> = new Set([
  'nginx', 'haproxy', 'postgres', 'mysql', 'mongodb', 'redis', 'memcached', 'kafka', 'rabbitmq', 'nats',
  'elasticsearch', 'k8s', 'grpc', 'websocket', 'graphql', 'cloudrun',
]);
export function providerOf(typeId: string): 'aws' | 'oss' | undefined {
  const dot = typeId.indexOf('.');
  const tech = (dot === -1 ? '' : typeId.slice(dot + 1)).toLowerCase();
  // The tech may itself be dotted ('queue.sqs.fifo' → 'sqs.fifo'); the family is its first segment.
  const family = tech.indexOf('.') === -1 ? tech : tech.slice(0, tech.indexOf('.'));
  if (AWS_TECH.has(family)) return 'aws';
  if (OSS_TECH.has(family)) return 'oss';
  return undefined;
}

/** The KIND of a component type is the segment before the FIRST dot ('queue.sqs.fifo' → 'queue'). Shared by the
 *  Components palette (group headers) and the Inspector header (node icon) so the two never drift. */
export function kindOf(typeId: string): string {
  const dot = typeId.indexOf('.');
  return dot === -1 ? typeId : typeId.slice(0, dot);
}

/**
 * A themed built-in codicon per component KIND, so both the palette and the Inspector header read at a glance.
 * DISPLAY hints only (no semantics) — a kind with no explicit mapping falls back to a neutral `package` icon
 * rather than guessing wrong. Icons are chosen from the built-in codicon set for an intuitive fit.
 */
const KIND_ICON: Readonly<Record<string, string>> = {
  client: 'device-desktop',
  compute: 'server-process',
  db: 'database',
  cache: 'zap',
  queue: 'inbox',
  topic: 'megaphone',
  stream: 'broadcast',
  gateway: 'plug',
  apigw: 'plug',
  lb: 'server-environment',
  proxy: 'arrow-swap',
  cdn: 'globe',
  storage: 'archive',
  search: 'search',
  security: 'shield',
  ai: 'sparkle',
};
export function kindIcon(kind: string): string {
  return KIND_ICON[kind] ?? 'package';
}

/**
 * The codicon for a System-summary SECTION, chosen from the section TITLE the webview feeds (the titles are
 * partly dynamic — a flow section is `System · A → B` / `Flow 2 · A → B` — so we match on a keyword rather than an
 * exact string). Mirrors the Testing view's per-group glyphs:
 *   • Design           → `symbol-structure` (the topology)
 *   • Promises         → `target`           (the SLOs — the SAME glyph the node Inspector's Promises section uses)
 *   • a flow section   → `arrow-right`      (a request path)
 *   • Response time    → `watch`            (time / percentiles — end-to-end and per component)
 *   • Load limits      → `dashboard`        (the ambient capacity envelope — the default answer)
 *   • Load per …       → `pulse`            (offered load / utilisation)
 *   • Cost             → `credit-card`      (the bill)
 *   • anything else    → `list-flat`        (a neutral group)
 * The match is case-insensitive on the leading keyword so a title tweak upstream degrades gracefully.
 */
export function sectionIcon(title: string): string {
  const t = title.toLowerCase();
  // THE VERDICT section (the top item — a ✓/✗-prefixed headline the webview prepends): a pass / error glyph, so the
  // one-line answer reads green-ok / red-problem at a glance, the native-tree twin of the web's verdict pill.
  if (title.startsWith('✓')) return 'pass';
  if (title.startsWith('✗')) return 'error';
  if (t.startsWith('design')) return 'symbol-structure';
  // The whole-system Promises section shares the node Inspector's Promises glyph ($(target)) — one form (the two
  // Promises surfaces read identically). Matched exactly (not a prefix) so a future "Promises · …" title is deliberate.
  if (title === PROMISES_TITLE) return 'target';
  if (t.startsWith('system') || t.startsWith('flow')) return 'arrow-right';
  if (t.startsWith('response')) return 'watch'; // Response time · end-to-end / per component (time / percentiles)
  if (t.startsWith('load limits')) return 'dashboard'; // the ambient capacity envelope — the default answer (assumption-model §3)
  if (t.startsWith('load')) return 'pulse'; // Load per component (offered load / utilisation)
  if (t.startsWith('cost')) return 'credit-card';
  if (t.startsWith('uncertainty')) return 'graph-scatter'; // the Monte-Carlo distribution block (TASK-81)
  if (t.startsWith('worlds') || t.startsWith('demand')) return 'versions'; // the named-worlds comparison matrix (assumption-model §7)
  return 'list-flat';
}

// ── The System tree's SHAPE (pure) ──────────────────────────────────────────────────────────────────────────────
// The parent/child structure the native System view renders, kept here (vscode-free) so it is unit-tested and can
// never silently drift. The KEY invariant (owner ruling: ONE FORM with the node Inspector's Promises section): the
// "Add promise…" affordance is the LAST CHILD of the Promises section — never a floating top-level sibling. The
// presenter always emits the Promises section (even empty) so this home is always present. The vscode-facing
// SystemTreeProvider only maps these items to `TreeItem`s (icons, commands); the decision of what goes where is here.

/** One node of the System tree: a summary SECTION parent, a value ROW leaf, or the ADD-PROMISE action row. The row
 *  carries a stable coordinate (section title + index) so ids never collide; the action is a singleton. Reuses the
 *  frozen protocol's SummarySection/SummaryRow — the host adds no domain shape. */
export type SystemItem =
  | { readonly kind: 'section'; readonly section: SummarySection }
  | { readonly kind: 'row'; readonly section: string; readonly index: number; readonly row: SummaryRow }
  | { readonly kind: 'addRequirement' };

/** The ROOT items of the System tree: one parent per summary section, in feed order — and NOTHING else. The
 *  "Add promise…" action is deliberately NOT here (it lives inside the Promises section, `systemSectionChildren`);
 *  an empty/absent summary yields no rows (the contributed viewsWelcome empty-state shows instead). */
export function systemRootItems(summary: readonly SummarySection[] | undefined): SystemItem[] {
  if (summary === undefined || summary.length === 0) return [];
  return summary.map((section) => ({ kind: 'section', section }));
}

/** The children of one System section: its value rows, plus — for the Promises section ONLY — the "Add promise…"
 *  action as the LAST child (mirroring the node Inspector's Promises section, where "+ Add promise…" sits inside).
 *  The presenter guarantees a Promises section always exists (even with zero rows), so this home never disappears. */
export function systemSectionChildren(section: SummarySection): SystemItem[] {
  const rows: SystemItem[] = section.rows.map((row, index) => ({ kind: 'row', section: section.title, index, row }));
  if (section.title === PROMISES_TITLE) rows.push({ kind: 'addRequirement' });
  return rows;
}

/** The design NAME derived from a chosen file PATH — its base name minus the `.sda.json`/`.json` suffix (so the
 *  on-disk project's name matches its file), falling back to "design" for an empty/degenerate name. Pure (vscode-free)
 *  so the New-Design flow's naming is unit-tested here. Handles both `\` (Windows) and `/` path separators. */
export function newDesignName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? 'design';
  return base.replace(/\.sda\.json$/i, '').replace(/\.json$/i, '').trim() || 'design';
}

/** Thousands separators using a locale-independent grouping (so tests are stable across machines/locales). */
export function formatNumber(n: number): string {
  const sign = n < 0 ? '-' : '';
  const digits = Math.abs(n).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + grouped;
}
