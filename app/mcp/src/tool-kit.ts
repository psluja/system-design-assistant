import type { ToolAnnotations, ToolResult } from './tools';

// Shared plumbing for the MCP tool builders — the `ok`/`fail`/`obj`/`round`/`str` helpers were copy-pasted into
// every tool module; this is the single definition they all import. (The `ToolResult`/`ToolAnnotations` imports
// are type-only, so there is no runtime cycle with tools.ts.)

// ── The FOUR annotation forms every SDA tool declares (spec ToolAnnotations; lint: schema-hygiene.test.ts). One
// named form per behavior kind — never an ad-hoc inline object — so the whole surface reads uniformly and a new
// tool must pick its kind deliberately. `openWorldHint` is always false: no SDA tool has any egress; even the
// file tools are confined to the workspace roots.
/** A pure read — touches neither the design, the session, nor a file. Clients may auto-approve it. */
export const READS: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
/** An idempotent, NON-destructive write: an undoable design edit (a single undo restores the whole prior design;
 *  no file is touched until save_design), a session-state write (a stored backward-search proposal), or
 *  save_design's overwrite of the tracked design file (re-running writes the identical bytes). */
export const EDITS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** A history step (undo/redo) — non-destructive (the other stack keeps what it displaces) but NOT idempotent:
 *  each repeat steps one frame further. */
export const EDITS_HISTORY: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** A whole-session replace (import_design / import_project): `studio.load` swaps the document AND clears the
 *  undo history, so an unsaved in-session design is genuinely unrecoverable — the one honestly DESTRUCTIVE kind.
 *  Idempotent: re-importing the same file/text lands the same state. */
export const REPLACES_SESSION: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

/** A successful tool result carrying text output. */
export const ok = (text: string): ToolResult => ({ ok: true, text });
/** A successful tool result carrying a JSON VALUE — the ONE canonical envelope every JSON-returning tool shares:
 *  pretty-printed with a 2-space indent (stable, diffable, agent-parseable). Routing every structured result
 *  through this single spot is how the JSON form can never drift tool-to-tool (the audit's "one form per result
 *  kind": discovery tools speak compact text; every structured read/analysis speaks this envelope). */
export const json = (value: unknown): ToolResult => ok(JSON.stringify(value, null, 2));
/** A failed tool result, prefixed 'error: '. */
export const fail = (text: string): ToolResult => ({ ok: false, text: `error: ${text}` });
/** A JSON-Schema object node for a tool's inputSchema: `{ type:'object', properties, required }`. */
export const obj = (props: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties: props, required });
/** Round to 2 decimals for human-facing numeric output. */
export const round = (n: number): number => Math.round(n * 100) / 100;
/** Round a MILLISECOND time value to whole ms for tool-result TEXT (owner rule: no sub-ms noise in agent-facing
 *  text — never "10636.42 ms", always "10636 ms"). Raw distribution data kept elsewhere may retain full precision;
 *  this is the single spot every tool routes a rendered ms value through. `∞`/NaN pass to the caller to format. */
export const roundMs = (n: number): number => Math.round(n);
/** Coerce an unknown tool argument to a string (empty for null/undefined). */
export const str = (v: unknown): string => String(v ?? '');

/** Levenshtein edit distance (small strings — key/type ids), used to power "did you mean" self-correction. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j] as number;
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j] as number, row[j - 1] as number);
      prev = tmp;
    }
  }
  return row[n] as number;
}

/** The closest candidates to a mistyped id — so an unknown-key/type error self-corrects instead of forcing a
 *  discovery round-trip (the MCP contract: every error names the next action). Ranks by edit distance, keeps only
 *  genuinely-near matches (distance ≤ max(2, ⌈len/2⌉)), case-insensitive. Empty when nothing is close. */
export function didYouMean(bad: string, candidates: readonly string[], limit = 3): string[] {
  const b = bad.toLowerCase();
  const threshold = Math.max(2, Math.ceil(b.length / 2));
  return candidates
    .map((c) => [c, editDistance(b, c.toLowerCase())] as const)
    .filter(([, d]) => d <= threshold)
    .sort((x, y) => x[1] - y[1])
    .slice(0, limit)
    .map(([c]) => c);
}
