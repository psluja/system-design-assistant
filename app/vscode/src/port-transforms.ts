import { deserialize } from '@sda/core';
import { allManifests, claimsFor, LOAD_STAGES_PRESETS, type LoadStagePreset, type Manifest } from '@sda/content';
import { cyclesProblem, type Cycle, type Stage, type Transform } from '@sda/engine-core';

// Pure, vscode-free catalog + helpers for NATIVE per-port TRANSFORM editing.
// `commands.ts` builds the `sda.setPortTransform` / `sda.clearPortTransform` QuickPick/InputBox flows from
// `TRANSFORM_KINDS`, and `inspector-tree.ts` renders a node's Ports section from `portRowsFor`. Everything
// decision-y lives here so it is unit-tested under vitest (which cannot load the `vscode` module); the vscode-facing
// files stay thin glue — the same division the SLO code uses (slo-requirements.ts).
//
// The transform set MIRRORS the closed engine set (engine/core Transform) and the web popover: ratio · batch · cap ·
// window · prob. Both surfaces write the SAME `instance.transforms` shape, so a transform set in the extension and
// one set on the web read identically (one meaning, two entry points).

/** One transform function the user can put on a port: its kind, the human label + value hint shown in the pick, and
 *  a validator mirroring engine-core's `validTransform` (value finite & > 0; prob additionally ≤ 1). */
export interface TransformKind {
  readonly kind: Transform['kind'];
  /** The friendly name shown in the QuickPick (e.g. "ratio — scale ×k"). */
  readonly label: string;
  /** The unit/meaning of the value, shown in the InputBox prompt (e.g. "× multiplier", "req/s ceiling"). */
  readonly hint: string;
  /** One-line description of the semantics (the QuickPick detail). */
  readonly detail: string;
}

/** The functions offered, in the order the QuickPick shows them — the same closed set as the web popover. `generate`
 *  (the sixth, load-stages §4) authors a traffic ORIGIN and appears only for OUT/BI ports; it takes the compact
 *  stages syntax (below), not a single value, so the command branches on it. */
export const TRANSFORM_KINDS: readonly TransformKind[] = [
  { kind: 'ratio', label: 'ratio — scale ×k', hint: '× multiplier (k)', detail: 'out = k × in. Log amplification (×100), fan-out (×3), sampling (×0.1).' },
  { kind: 'batch', label: 'batch — collapse n:1', hint: 'batch size (n)', detail: 'out = in ÷ n. Aggregators / batchers (100 requests → 1).' },
  { kind: 'cap', label: 'cap — rate ceiling', hint: 'req/s ceiling (r)', detail: 'out = min(in, r). Rate limiters/throttles; the excess becomes overflow.' },
  { kind: 'window', label: 'window — flush every ms', hint: 'window (ms)', detail: 'out = min(in, 1000/ms). Time-window aggregation (flush every 10 000 ms).' },
  { kind: 'prob', label: 'prob — fraction p', hint: 'probability p (0..1)', detail: 'out = p × in. Error/DLQ splits (p = 0.01), A/B routing.' },
  { kind: 'generate', label: 'generate — originate req/s (a traffic source)', hint: 'level=<req/s>; cycles…', detail: 'The port ORIGINATES load (a cron/emitter/migration/user traffic). A baseline level, optionally shaped by periodic k6-style cycles (a diurnal day, a launch spike).' },
];

/** Validate a value for a kind, mirroring engine-core `validTransform`. Returns an error string or null (valid). */
export function validateTransformValue(kind: Transform['kind'], value: number): string | null {
  // A generator's parameter is its LEVEL (req/s it originates) — ≥ 0, where 0 is a declared-but-silent origin
  //. The QuickPick does not yet author generators (a load-curves R4 surface); this keeps
  // the shared validator honest for documents that carry one.
  if (kind === 'generate') return Number.isFinite(value) && value >= 0 ? null : 'a generator level must be a number ≥ 0 (req/s it originates)';
  if (!Number.isFinite(value) || value <= 0) return 'must be a number greater than 0';
  if (kind === 'prob' && value > 1) return 'a probability must be ≤ 1';
  return null;
}

/** The transform-kind definition for a kind (for RE-EDITING an existing transform so the prompt seeds right). */
export function transformKindFor(kind: string): TransformKind | undefined {
  return TRANSFORM_KINDS.find((t) => t.kind === kind);
}

/** A transform's single display parameter: the five reshaping kinds carry `value`; a generator carries its
 *  `level` (req/s it originates — doc: load-curves §3). The one accessor every `kind(param)` label shares. */
export function transformParamOf(t: Transform): number {
  return t.kind === 'generate' ? t.level : t.value;
}

/** A compact label for an active transform, matching the web pill/inspector grammar (×100 · ÷100 · cap 500/s · …). */
export function formatTransform(t: Transform): string {
  switch (t.kind) {
    case 'ratio':
      return `×${t.value}`;
    case 'batch':
      return `÷${t.value}`;
    case 'cap':
      return `cap ${t.value}/s`;
    case 'window':
      return `window ${t.value}ms`;
    case 'prob':
      return `p=${t.value}`;
    case 'generate':
      return `⚡${t.level}/s${t.cycles !== undefined ? ' + cycles' : ''}`; // a generator: the baseline level it originates
  }
}

/** One declared GUARANTEE contribution on a port: the dimension, the token this port contributes, and its provenance badge — read-only, from
 *  the sourced catalog data. `documented` carries the primary-source URL; `est` is an honest estimate; `default`
 *  is a plain declared token with neither. */
export interface PortGuarantee {
  readonly dimension: string;
  readonly token: string;
  readonly provenance: 'documented' | 'estimate' | 'default';
  /** The primary-doc URL when `documented` (so the Inspector can link the source), else undefined. */
  readonly source?: string;
}

/** One port row for the Inspector Ports section: the port, its direction and protocols, the ACTIVE transform
 *  (if any) plus whether it is an instance OVERRIDE (vs a manifest catalog default) — so the tree can mark it
 *  "modified" GitLens-style — and any DECLARED guarantee contributions (read-only, with provenance). */
export interface PortRow {
  readonly port: string;
  readonly dir: 'in' | 'out' | 'bi';
  readonly protocols: readonly string[];
  /** The active transform on this port (instance override ?? manifest default), or null for identity. */
  readonly transform: Transform | null;
  /** True when the active transform is a per-instance OVERRIDE (in the document), not the manifest default. */
  readonly override: boolean;
  /** The declared guarantee contributions on this port (consistency/ordering/delivery), each with its provenance —
   *  read-only, sourced from the catalog. Empty when the port makes no guarantee claim (the common case). */
  readonly guarantees: readonly PortGuarantee[];
}

/**
 * Every port of `node`'s component with its active transform, read from the design TEXT (for the instance overrides)
 * and the shared catalog (for the manifest ports + their defaults). Resolution mirrors `instantiate`:
 * instance override WINS over the manifest port's default; neither ⇒ identity (null). Returns an empty list for an
 * unknown node, a node whose type is absent from the catalog, or text that does not parse — never a fabricated row.
 *
 * Project-scoped custom components (the document's own `components`) are merged OVER the built-in catalog so a
 * custom type's ports resolve too — exactly the merge the shells do.
 */
export function portRowsFor(text: string, node: string): readonly PortRow[] {
  const parsed = deserialize(text);
  if (!parsed.ok) return [];
  const inst = parsed.value.instances.find((i) => i.id === node);
  if (inst === undefined) return [];
  const catalog: Record<string, Manifest> = { ...allManifests };
  for (const m of parsed.value.components) catalog[m.type] = m; // custom project components win, like the shells
  const man = catalog[inst.type];
  if (man === undefined) return [];
  const overrides = inst.transforms ?? {};
  return man.ports.map((p) => {
    const override = overrides[p.name];
    const transform: Transform | null = override ?? p.transform ?? null;
    const protocols = p.dir === 'in' ? (p.accepts ?? []) : p.dir === 'out' ? (p.speaks ?? []) : [...(p.accepts ?? []), ...(p.speaks ?? [])];
    // The port's DECLARED guarantee contributions with provenance — recovered from the
    // catalog by identity via `claimsFor`, exactly like the design-doc register + the MCP describe_component. Read-only.
    const claims = claimsFor(p.guarantees) ?? [];
    const guarantees: PortGuarantee[] = claims.map((c) => ({
      dimension: String(c.dimension),
      token: String(c.token),
      provenance: c.source !== undefined ? 'documented' : c.est === true ? 'estimate' : 'default',
      ...(c.source !== undefined ? { source: c.source } : {}),
    }));
    return { port: p.name, dir: p.dir, protocols, transform, override: override !== undefined, guarantees };
  });
}

/** One wire row for the `sda.setWireTransform` QuickPick: the wire's endpoints and
 *  its ACTIVE OUT-side transform — a per-WIRE override if set (`override: true`), else the source out-port's default.
 *  The endpoints are the stable key `setWireTransformText` addresses the wire by. */
export interface WireRow {
  readonly from: readonly [string, string];
  readonly to: readonly [string, string];
  /** The active OUT-side transform on this wire (wire override > source out-port default), or null for identity. */
  readonly transform: Transform | null;
  /** True when the active transform is the wire's OWN override (in the document), not the source port default. */
  readonly override: boolean;
}

/**
 * Every wire in the design with its active OUT-side transform, read from the design TEXT (wire overrides + instance
 * port overrides) and the shared catalog (manifest port defaults). Resolution mirrors the engine seam:
 * WIRE override > instance out-port override > manifest out-port default > identity (null). Returns an empty list for
 * text that does not parse — never a fabricated row.
 */
export function wireRowsFor(text: string): readonly WireRow[] {
  const parsed = deserialize(text);
  if (!parsed.ok) return [];
  const catalog: Record<string, Manifest> = { ...allManifests };
  for (const m of parsed.value.components) catalog[m.type] = m;
  const instById = new Map(parsed.value.instances.map((i) => [i.id, i]));
  return parsed.value.wires.map((w) => {
    if (w.transform !== undefined) return { from: w.from, to: w.to, transform: w.transform, override: true };
    const srcInst = instById.get(w.from[0]);
    const portDefault = srcInst?.transforms?.[w.from[1]] ?? catalog[srcInst?.type ?? '']?.ports.find((p) => p.name === w.from[1])?.transform ?? null;
    return { from: w.from, to: w.to, transform: portDefault, override: false };
  });
}

// ── The GENERATOR authoring syntax (load-stages R3 §11) — the native counterpart to the web stages TABLE. A k6-style
// table is a grid on the canvas; in the tree it is a COMPACT LINE the user types in one InputBox, mirroring `setRange`'s
// single-field grammar (`parseRangeInput`): `level=<req/s>` then, per periodic cycle, a label and a comma-separated list
// of `time×multiplier` VERTICES at cumulative times off t=0 (which is the ×1 baseline). Several cycles MULTIPLY (§5).
//   e.g.  level=200; daily: 0s×1, 6h×0.5, 12h×1, 18h×2, 24h×1
// The last vertex's time is the cycle's periodS (the wrap boundary); the anchor `0s×1` is optional. Time units: bare =
// seconds, or s/m/h/d. The SAME `cyclesProblem` the engine build enforces validates the result, so a line typed here and
// a table filled on the web are interpreted IDENTICALLY (one meaning, two entry points), and every error names its rule.

/** Seconds per time-unit suffix in the compact stages syntax (a bare number is seconds). */
const UNIT_SECONDS: Readonly<Record<string, number>> = { s: 1, sec: 1, m: 60, min: 60, h: 3600, hr: 3600, d: 86_400 };

/** One `time×multiplier` vertex: a decimal time with an optional unit suffix, a `×`/`x`/`*` separator, a decimal ≥ 0. */
const VERTEX_RE = /^([0-9]*\.?[0-9]+)\s*(sec|min|hr|[smhd])?\s*[×xX*]\s*([0-9]*\.?[0-9]+)$/;

/** The outcome of parsing the compact generator line: the level + well-formed cycles, or a guided reason. */
export type ParsedGenerator = { readonly ok: true; readonly level: number; readonly cycles: readonly Cycle[] } | { readonly ok: false; readonly error: string };

/**
 * Parse the compact generator syntax into a level + {@link Cycle}s. Guided-error throughout —
 * every failure names the exact rule and shows the offending token, the `setRange`/`cyclesProblem` discipline. The
 * cycles are validated by the SHARED `cyclesProblem` (periodS > 0, durationS > 0, multiplier ≥ 0, Σ durationS ≤ periodS,
 * at least one multiplier > 0), so the native line and the web table can never diverge. An input of just `level=200`
 * is a legal FLAT generator (no cycles). Pure — vitest-tested directly (the `slo-requirements` division).
 */
export function parseGeneratorInput(input: string): ParsedGenerator {
  const segments = input.split(';').map((s) => s.trim());
  const head = segments[0] ?? '';
  const levelMatch = /^level\s*=\s*([0-9]*\.?[0-9]+)$/i.exec(head);
  if (levelMatch === null) return { ok: false, error: `start with the baseline level — \`level=<req/s>\` (e.g. \`level=200\`); got "${head || '(empty)'}"` };
  const level = Number(levelMatch[1]);
  if (!Number.isFinite(level) || level < 0) return { ok: false, error: `the level must be a number ≥ 0 (req/s the port originates); got ${levelMatch[1]}` };

  const cycles: Cycle[] = [];
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i] as string;
    if (seg === '') continue; // a trailing `;` is harmless
    const parsed = parseCycleSegment(seg, i);
    if (!parsed.ok) return parsed;
    cycles.push(parsed.cycle);
  }
  const problem = cycles.length > 0 ? cyclesProblem(cycles) : null;
  if (problem !== null) return { ok: false, error: problem };
  return { ok: true, level, cycles };
}

/** Parse ONE cycle segment (`[label:] v0, v1, …`) into a {@link Cycle} — vertices are cumulative times off the ×1
 *  baseline; the last vertex's time is periodS; stages are the consecutive time deltas. A leading `0…` anchor is
 *  dropped (t=0 is always the baseline). Guided errors name the cycle position and the offending token. */
function parseCycleSegment(segment: string, index: number): { ok: true; cycle: Cycle } | { ok: false; error: string } {
  const colon = segment.indexOf(':');
  const body = (colon >= 0 ? segment.slice(colon + 1) : segment).trim();
  const tokens = body.split(',').map((t) => t.trim()).filter((t) => t !== '');
  if (tokens.length === 0) return { ok: false, error: `cycle ${index} has no stages — list vertices like \`0s×1, 6h×0.5, 24h×1\` (the last time is the period)` };

  const verts: { readonly t: number; readonly m: number }[] = [];
  for (const tok of tokens) {
    const m = VERTEX_RE.exec(tok);
    if (m === null) return { ok: false, error: `cycle ${index}: "${tok}" is not a \`time×multiplier\` vertex — e.g. \`6h×0.5\` (time units: s/m/h/d, bare = seconds)` };
    const t = Number(m[1]) * (m[2] !== undefined ? (UNIT_SECONDS[m[2].toLowerCase()] as number) : 1);
    verts.push({ t, m: Number(m[3]) });
  }

  // t=0 is the ×1 baseline anchor; a leading vertex at 0 only restates it, so drop it (its multiplier is ignored —
  // the shape always starts at ×1, doc: load-stages §4). What remains are the stage END times, strictly increasing.
  const rest = verts[0]?.t === 0 ? verts.slice(1) : verts;
  if (rest.length === 0) return { ok: false, error: `cycle ${index} has only the t=0 baseline — add at least one later vertex, e.g. \`0s×1, 24h×2\`` };

  const stages: Stage[] = [];
  let prev = 0;
  for (const v of rest) {
    if (v.t <= prev) return { ok: false, error: `cycle ${index}: vertex times must strictly increase (cumulative) — ${v.t}s is not after ${prev}s` };
    stages.push({ durationS: v.t - prev, multiplier: v.m });
    prev = v.t;
  }
  return { ok: true, cycle: { periodS: prev, stages } };
}

/** Render a generator (level + cycles) back to the compact syntax for RE-EDITING — the seed the InputBox shows so an
 *  existing shape pre-fills (the `formatTransform`/`parseRangeInput` round-trip discipline). Emits the `0s×1` anchor,
 *  a vertex per stage at its cumulative end time, and a trailing `<periodS>×1` wrap vertex when a baseline tail exists
 *  (Σ durationS < periodS) so the period survives the round-trip. Times use whole d/h/m/s units where they divide. */
export function formatGeneratorInput(level: number, cycles: readonly Cycle[] | undefined): string {
  const head = `level=${level}`;
  if (cycles === undefined || cycles.length === 0) return head;
  const segs = cycles.map((c, i) => {
    const verts = ['0s×1'];
    let cum = 0;
    for (const s of c.stages) {
      cum += s.durationS;
      verts.push(`${humanDuration(cum)}×${s.multiplier}`);
    }
    if (cum < c.periodS) verts.push(`${humanDuration(c.periodS)}×1`); // the baseline tail → the wrap boundary
    return `c${i + 1}: ${verts.join(', ')}`;
  });
  return [head, ...segs].join('; ');
}

/** A duration in seconds as a whole-unit token (`1d`, `6h`, `30m`, `45s`) — the largest unit it divides evenly. */
function humanDuration(seconds: number): string {
  if (seconds > 0 && seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds > 0 && seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds > 0 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** A preset's cycles as the compact syntax — the seed a preset pick pre-fills the
 *  InputBox with, then the user tweaks every value. `flat` yields just `level=…` (no cycles), the migration path for a
 *  steady origin; `spike` reproduces the deleted probe on ONE node. `level` is the user's baseline, untouched. */
export function presetGeneratorInput(preset: LoadStagePreset, level: number): string {
  return formatGeneratorInput(level, LOAD_STAGES_PRESETS[preset]);
}

/** The generator RE-EDIT seed (the `editKnob` discipline: edit shows the current value directly, never a picker
 *  that could silently discard it). A generator already on the port formats to the InputBox seed it must open
 *  with DIRECTLY, no preset QuickPick interposed; `undefined` means no generator exists yet, so the preset on-ramp
 *  still applies (INITIAL authoring only). */
export function generatorReeditSeed(current: Transform | null): string | undefined {
  return current?.kind === 'generate' ? formatGeneratorInput(current.level, current.cycles) : undefined;
}

/** The preset names offered in the native picker, in the shipped order (`flat` first — the steady baseline). */
export const GENERATOR_PRESETS: readonly LoadStagePreset[] = ['flat', 'spike', 'ramp-up', 'diurnal', 'on-off-burst', 'quarterly-report'];
