import { deserialize } from '@sda/core';
import { registry, keys, allManifests, type Manifest } from '@sda/content';
import { Key } from '@sda/engine-core';
import { evaluateText } from './host-eval';

// Pure, vscode-free logic for the text INSIGHTS (hover + codelens over a `.sda.json` opened as TEXT). Everything
// here is a plain function of strings/values so it is unit-tested under vitest (which cannot load the `vscode`
// module). `text-insights.ts` imports these and maps vscode Positions/documents onto them — the same split as
// pure.ts vs the vscode-facing files, so the interesting behaviour stays covered and the glue stays thin.

// The `key` on a registry KeyDef and a manifest config entry is a branded string; at runtime it is the plain
// name, so `String(key)` is the label a human reads. A helper to make that intent explicit at call sites.
const keyName = (k: Key): string => String(k);

// A reverse index name→friendly-label for the well-known keys, taken straight from the content `keys` export
// (its property NAMES are the human labels: `throughput`, `perRequestDuration`, …). Content-driven: adding a
// registry key to `keys` extends this automatically, no edit here (the engine stays domain-agnostic).
const KEY_LABEL: ReadonlyMap<string, string> = new Map(Object.entries(keys).map(([label, k]) => [keyName(k), label]));

// ── HOVER (pure) ─────────────────────────────────────────────────────────────────────────────────────────────

/** The three things a hover can land on in the JSON, or nothing recognised. A tagged union so the provider's
 *  switch is exhaustive and each case renders from a dedicated pure function. */
export type HoverSubject =
  | { readonly kind: 'type'; readonly id: string }
  | { readonly kind: 'protocol'; readonly id: string }
  | { readonly kind: 'configKey'; readonly key: string }
  | undefined;

/** The quoted-string token a character offset sits inside, and its column span. We match the STRING between
 *  quotes so a multi-segment id like `db.postgres` returns whole (a plain word-range would stop at the dot). */
export interface WordSpan {
  readonly text: string;
  readonly startCol: number;
  readonly endCol: number;
}
export function wordAt(line: string, col: number): WordSpan | undefined {
  // Component types, protocol ids and config keys are all quoted strings — resolve the one the cursor is within.
  const strings = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)];
  for (const m of strings) {
    const open = m.index ?? 0;
    const innerStart = open + 1;
    const innerEnd = innerStart + m[1]!.length;
    // Inclusive of the closing-quote position so a cursor resting just after the last char still resolves.
    if (col >= innerStart && col <= innerEnd) return { text: m[1]!, startCol: innerStart, endCol: innerEnd };
  }
  return undefined;
}

/**
 * Classify what the hovered token IS, from the token text and the surrounding LINE only (lexical, no AST):
 *  • the value of a `"type": "<x>"` pair whose id is a known manifest        → a component type;
 *  • a string inside an `"accepts"`/`"speaks"` array that is a known protocol → a protocol;
 *  • a config KEY (a quoted key whose value is a number) that is a registry key → a config key.
 * Returns undefined when nothing is recognised (honest silence — we never invent a hover). `manifests` and the
 * `isProtocol`/`isRegistryKey` predicates are injected so this stays a pure function of data.
 */
export function classifyHover(
  line: string,
  span: WordSpan,
  deps: {
    readonly manifests: Readonly<Record<string, Manifest>>;
    readonly isProtocol: (id: string) => boolean;
    readonly isRegistryKey: (key: string) => boolean;
  },
): HoverSubject {
  // `wordAt` reports the span of the string CONTENT (between the quotes), so the token's own opening quote sits
  // at startCol-1 and its closing quote at endCol. Exclude both from the context slices so the regexes match the
  // surrounding JSON structure (the colon / bracket / comma) and never trip over the token's own quotes.
  const before = line.slice(0, Math.max(0, span.startCol - 1));
  const after = line.slice(span.endCol + 1);

  // A component type: the value of `"type"` — and only when it is a real manifest, so we never claim a hover for
  // a hand-typed unknown type.
  if (/"type"\s*:\s*$/.test(before) && span.text in deps.manifests) {
    return { kind: 'type', id: span.text };
  }

  // A protocol id: a string ELEMENT inside an accepts/speaks array. Detect the enclosing `accepts`/`speaks` key
  // to the LEFT and that the token is a bare array element (followed by `,` or the closing `]`).
  const inProtoArray = /"(?:accepts|speaks)"\s*:\s*\[[^\]]*$/.test(before) && /^\s*[,\]]/.test(after);
  if (inProtoArray && deps.isProtocol(span.text)) {
    return { kind: 'protocol', id: span.text };
  }

  // A config key: the token is a JSON KEY whose value is a number (`"concurrency": 500`) and is a registry key.
  const isKeyPosition = /^\s*:\s*-?\d/.test(after);
  if (isKeyPosition && deps.isRegistryKey(span.text)) {
    return { kind: 'configKey', key: span.text };
  }

  return undefined;
}

/** Render a component TYPE hover: the id, its config defaults as a table, and its ports with accepts/speaks. Pure
 *  string→markdown, unit-tested against the real manifest data. Returns undefined for an unknown type. */
export function manifestHoverMarkdown(typeId: string, manifests: Readonly<Record<string, Manifest>>): string | undefined {
  const m = manifests[typeId];
  if (m === undefined) return undefined;
  const lines: string[] = [`**\`${typeId}\`** — SDA component`, ''];

  const config = m.config ?? [];
  if (config.length > 0) {
    lines.push('Config defaults:', '', '| Key | Default | Unit |', '| --- | ---: | --- |');
    for (const c of config) {
      const label = KEY_LABEL.get(keyName(c.key)) ?? keyName(c.key);
      lines.push(`| ${label} | ${String(c.value)} | ${c.unit} |`);
    }
    lines.push('');
  }

  if (m.ports.length > 0) {
    lines.push('Ports:', '');
    for (const p of m.ports) {
      const facets: string[] = [];
      if (p.accepts && p.accepts.length > 0) facets.push(`accepts ${p.accepts.map((x) => `\`${x}\``).join(', ')}`);
      if (p.speaks && p.speaks.length > 0) facets.push(`speaks ${p.speaks.map((x) => `\`${x}\``).join(', ')}`);
      lines.push(`- \`${p.name}\` (${p.dir})${facets.length > 0 ? ' — ' + facets.join('; ') : ''}`);
    }
  }
  return lines.join('\n');
}

/** Render a registry-key hover from the registry metadata that ACTUALLY exists (label + unit + input/derived;
 *  there is no description field, so we do not invent one). Returns undefined when the key is not registered. */
export function registryKeyHoverMarkdown(key: string): string | undefined {
  const def = registry.get(Key(key));
  if (def === undefined) return undefined;
  const label = KEY_LABEL.get(key) ?? key;
  const kind = def.kind === 'input' ? 'config knob (input)' : 'derived value';
  return `**\`${key}\`** — ${label}\n\nUnit: \`${String(def.unit)}\` · ${kind}`;
}

// ── CODELENS (pure) ──────────────────────────────────────────────────────────────────────────────────────────

/** A verdict roll-up for ONE node: how it reads and the worst breaching key (undefined when clean). Pure data. */
export interface NodeRollup {
  readonly node: string;
  readonly violations: number;
  readonly warnings: number;
  readonly worstKey: string | undefined;
}

/**
 * Compute a per-node verdict roll-up for the WHOLE design text, by building a throwaway Studio and running the
 * SAME queueing-aware verdict path every other surface uses (`realAwareVerdicts` fed by `nodeQueues`) — so the
 * codelens can never disagree with the canvas/Problems/status bar. Returns null when the document does not parse
 * or does not evaluate: the caller then shows NO lenses (honest — no fabricated ok/violation states).
 *
 * Pure of vscode. Deterministic (no clock/randomness): the same text always yields the same roll-ups.
 */
export function nodeRollups(text: string): Map<string, NodeRollup> | null {
  const parsed = deserialize(text);
  if (!parsed.ok) return null;

  // The SAME host evaluation the SLO tests use — build once, share the queueing-aware verdict list, so the codelens
  // and the Testing view can never disagree (or with the canvas). Null when the design does not build → no lenses.
  const ev = evaluateText(text);
  if (ev === null) return null;
  const verdicts = ev.verdicts;

  // Seed every declared instance so a clean node still gets a lens (an absent node = no lens, but a node with no
  // breaching verdict must read ✓ ok, not vanish).
  const rollups = new Map<string, NodeRollup>();
  for (const inst of parsed.value.instances) rollups.set(inst.id, { node: inst.id, violations: 0, warnings: 0, worstKey: undefined });

  for (const v of verdicts) {
    const id = String(v.scope);
    const cur = rollups.get(id);
    if (cur === undefined) continue; // edge-scoped or unknown node — not an instance lens anchor
    if (v.status === 'violation') {
      rollups.set(id, { node: id, violations: cur.violations + 1, warnings: cur.warnings, worstKey: cur.worstKey ?? String(v.key) });
    } else if (v.status === 'warning') {
      // A warning becomes the worst key only when no violation has claimed it (violations rank above warnings).
      const worstKey = cur.violations > 0 ? cur.worstKey : cur.worstKey ?? String(v.key);
      rollups.set(id, { node: id, violations: cur.violations, warnings: cur.warnings + 1, worstKey });
    }
  }
  return rollups;
}

/** The one-line lens TITLE for a node's roll-up: `✓ ok`, or `✖ N violation(s) · <key>` / a warnings variant.
 *  Pure so the exact wording is unit-tested and stays honest (it names the worst breaching key, never invents one). */
export function rollupTitle(r: NodeRollup): string {
  if (r.violations > 0) {
    const plural = r.violations === 1 ? '' : 's';
    return `✖ ${r.violations} violation${plural}${r.worstKey ? ` · ${r.worstKey}` : ''}`;
  }
  if (r.warnings > 0) {
    const plural = r.warnings === 1 ? '' : 's';
    return `⚠ ${r.warnings} warning${plural}${r.worstKey ? ` · ${r.worstKey}` : ''}`;
  }
  return '✓ ok';
}

/** A node id declared in the text and the line its `"id"` anchor sits on (the codelens goes above it). */
export interface IdAnchor {
  readonly node: string;
  readonly line: number;
}
/**
 * Locate every `"id": "<x>"` line and return each node id with its line number. We scan line-by-line with the
 * SAME id-pair regex the diagnostics use, so both spacing styles work; we don't try to prove the line is inside
 * the `instances` array (a wire has no `"id"`; a group carries one but only ids with a matching rollup get a
 * lens, so a non-instance id simply yields none downstream).
 */
export function findInstanceIdAnchors(text: string): IdAnchor[] {
  const anchors: IdAnchor[] = [];
  const lines = text.split('\n');
  const idPair = /"id"\s*:\s*"((?:[^"\\]|\\.)*)"/;
  for (let i = 0; i < lines.length; i++) {
    const m = idPair.exec(lines[i]!);
    if (m !== null) anchors.push({ node: m[1]!, line: i });
  }
  return anchors;
}
