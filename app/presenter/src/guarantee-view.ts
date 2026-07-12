import { DimensionId, DimensionToken, NodeId, type Graph, type Status } from '@sda/engine-core';
import { propagateFlowEdges, type EdgeMeet } from '@sda/engine-solve';
import {
  categorical,
  dims,
  flowGuarantees,
  guaranteeVerdicts,
  type FlowGuaranteeSummary,
  type GuaranteeSlo,
  type GuaranteeVerdict,
  type Instance,
  type Manifest,
  type ValueFn,
  type Wire,
} from '@sda/content';

// The SHARED GUARANTEE view-model — the qualitative-guarantee (consistency / ordering / delivery) counterpart of
// the numeric `summary`/`problems`/`node-detail` view-models. Both shells (web canvas + System panel, VS Code
// System tree + Inspector) render THESE, so the guarantee line, the canvas strip and the requirement editor can
// never drift between the surfaces — and, the anti-drift invariant this module is pinned on, a surface's tokens,
// root causes and verdicts are ALWAYS the engine's own `propagateFlowEdges` / content's `guaranteeVerdicts` /
// `flowGuarantees`, never a re-derivation. The presenter formats and colours; it computes no guarantee arithmetic.
//
// NO-FILLER: everything here stays empty until the design DECLARES a guarantee requirement (a `GuaranteeSlo`). The
// per-flow summary line only carries dimensions a flow actually degrades, is honestly unknown about, or has a
// requirement on; the canvas STRIP is produced ONLY for a flow that HAS a requirement AND a computed result. With
// no requirement anywhere and no degradation, every function here returns nothing — zero pixels on the canvas,
// zero rows in the panels.

// ── outsider-legible token labels (the requirement editor + hovers read these, never a bare token) ──────────────
//
// A token like `strong`/`per-key`/`may-duplicate` is jargon to the outside reader the owner's bars name. Each is
// paired with ONE plain-English gloss ("strong — reads always see the latest write") so the requirement popover,
// the System-line hover and the strip hover all speak the same legible language. These are CONTENT phrasing (the
// engine's tokens stay opaque); kept here — a presenter concern — because a gloss is a UI label, not a lattice fact.

/** The per-token glosses (outsider-legible), keyed by the raw token string; a token with no gloss falls back to
 *  its bare id (never a lie — just less prose). The declared-unknown tokens are intentionally absent: they are a
 *  sentinel, never a requirement floor a picker should offer. */
const TOKEN_GLOSS: Readonly<Record<string, string>> = {
  // consistency
  strong: 'reads always see the latest write',
  eventual: 'reads may briefly lag behind the latest write',
  // ordering
  total: 'all messages keep one global order',
  'per-key': 'messages keep their order within a key / partition',
  none: 'messages may arrive in any order',
  // delivery (as a floor an architect declares)
  clean: 'no duplicates and nothing lost',
  'may-duplicate': 'a message may be delivered more than once',
};

/** The legible label for a token: "<token> — <gloss>", or the bare token when there is no gloss. */
export function tokenLabel(token: string): string {
  const gloss = TOKEN_GLOSS[token];
  return gloss === undefined ? token : `${token} — ${gloss}`;
}

/** The human name + one-line description per dimension (the requirement-picker header). Content phrasing; the
 *  engine's dimension ids stay opaque. Only the three seed dimensions are named — an unknown dimension falls back. */
const DIMENSION_META: Readonly<Record<string, { label: string; detail: string }>> = {
  [String(dims.consistency)]: { label: 'Consistency (read freshness)', detail: 'how fresh a read is along the path' },
  [String(dims.ordering)]: { label: 'Ordering', detail: 'whether messages keep their order along the path' },
  [String(dims.delivery)]: { label: 'Delivery', detail: 'whether a message can be duplicated along the path' },
};

/** One selectable token (a minimum floor) for the requirement editor: the raw token the command writes + a legible
 *  label the picker/hover shows ("strong — reads always see the latest write"). */
export interface TokenOption {
  readonly token: string;
  readonly label: string;
}

/** One selectable dimension for the requirement editor: its id + an outsider-legible name + a one-line "what it is
 *  about" + the tokens (strongest → weakest) an architect can require. */
export interface DimensionOption {
  readonly dimension: string;
  readonly label: string;
  readonly detail: string;
  readonly tokens: readonly TokenOption[];
}

/**
 * The dimension + token options for the requirement editor (the flow-picker → dimension → minimum-token popover
 * every shell reuses). Built from the CONTENT categorical vocabulary, so the picker offers exactly the dimensions
 * and tokens the engine can judge — an architect can never require a token outside the lattice. The declared-unknown
 * token (consistency's weak-end sentinel) is EXCLUDED as a floor: a requirement is a promise to keep, not a floor of
 * "unknown". Deterministic order: dimensions follow the vocabulary; tokens follow strongest → weakest.
 */
export function requirementOptions(): readonly DimensionOption[] {
  return categorical.dimensions.map((id) => {
    const lattice = categorical.get(id);
    const meta = DIMENSION_META[String(id)] ?? { label: String(id), detail: '' };
    const tokens: TokenOption[] = (lattice?.tokens ?? [])
      // a declared-unknown token is a sentinel, never a requirement floor — do not offer it in the picker
      .filter((t) => lattice?.unknown === undefined || t !== lattice.unknown)
      .map((t) => ({ token: String(t), label: tokenLabel(String(t)) }));
    return { dimension: String(id), label: meta.label, detail: meta.detail, tokens };
  });
}

// ── per-flow summary line (the System panel line + the VS Code System tree rows) ────────────────────────────────

/** One dimension's cell on a flow's guarantee line: the computed token, the root-cause node (clickable to reveal),
 *  the declared floor (or null), and a tone. A dimension the flow REQUIRES shows its ok/violation/unknown verdict
 *  and a ✓/✗/? mark; a dimension merely DEGRADED with no requirement reads neutrally (informational). */
export interface GuaranteeCell {
  readonly dimension: string;
  /** The end-to-end computed token (the meet of every hop), e.g. 'eventual'. */
  readonly token: string;
  /** The provable root-cause node id (the first hop that dropped below the floor / below TOP), or null. Clickable
   *  in a shell → select + reveal that node. */
  readonly rootCauseNode: string | null;
  /** The declared floor for this dimension on this flow, or null when the flow declares no requirement here
   *  (the cell is then informational — a computed degradation shown without a pass/fail claim). */
  readonly required: string | null;
  /** ok / violation / unknown against the requirement; undefined when there is no requirement (informational). */
  readonly status?: Status;
  /** The glanceable tone: 'ok' (meets its floor), 'bad' (violates), 'warn' (unknown — honestly indeterminate),
   *  or undefined (informational degradation with no requirement). */
  readonly tone?: 'ok' | 'warn' | 'bad';
  /** The compact, legible cell text, e.g. "consistency eventual (replica1)" or "ordering per-key ✓". */
  readonly text: string;
}

/** One flow's guarantee line: its source/terminal (for the "<source> → <terminal>" heading a shell shows) and the
 *  per-dimension cells. Present only when the flow has SOMETHING to say (a declared requirement OR a computed
 *  degradation) — a flow that preserves every guarantee and declares no requirement yields no line (no-filler). */
export interface FlowGuaranteeLine {
  readonly source: string;
  readonly terminal: string;
  readonly cells: readonly GuaranteeCell[];
  /** The whole-line one-liner a compact surface shows, e.g. "consistency eventual (replica1) · ordering per-key ✓". */
  readonly text: string;
}

/** Everything the guarantee view-models need — the built engine graph, the design's instances/wires, the solved
 *  value reader, the merged catalog (for the swap remediations) and the declared requirements. All already computed
 *  by the shell (the same handles `summary` takes); the presenter re-derives nothing the engine/content did not. */
export interface GuaranteeViewInput {
  readonly graph: Graph;
  readonly instances: readonly Instance[];
  readonly wires: readonly Wire[];
  readonly value: ValueFn;
  readonly catalog: Readonly<Record<string, Manifest>>;
  /** The declared per-flow guarantee requirements (doc.guaranteeSlos). Empty ⇒ the whole feature is silent. */
  readonly slos: readonly GuaranteeSlo[];
}

const toneOfStatus = (status: Status | undefined): 'ok' | 'warn' | 'bad' | undefined =>
  status === 'violation' ? 'bad' : status === 'unknown' ? 'warn' : status === 'ok' ? 'ok' : undefined;

/** The mark a cell carries next to its token: ✓ (ok), ✗ (violation), ? (unknown), or '' (informational). */
const markOf = (status: Status | undefined): string =>
  status === 'ok' ? ' ✓' : status === 'violation' ? ' ✗' : status === 'unknown' ? ' ?' : '';

/** Order a set of dimension ids by the vocabulary order (consistency, ordering, delivery), unknown dims last. */
function orderedDims(ids: Iterable<string>): string[] {
  const order = new Map(categorical.dimensions.map((d, i) => [String(d), i]));
  return [...ids].sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999) || a.localeCompare(b));
}

/**
 * Build the per-flow guarantee LINES for a design. The anti-drift keystone: it reads content's own `flowGuarantees`
 * (the degraded/unknown dimensions per flow, engine-propagated) AND `guaranteeVerdicts` (the judged requirements),
 * then MERGES them per (flow, dimension) — so a dimension the architect required shows its ok/violation/unknown
 * verdict, and a dimension merely degraded (no requirement) still shows informationally with its root cause. Nothing
 * computed here beyond formatting; the tokens/root-causes/verdicts are all the engine's / content's.
 *
 * A flow appears ONLY when it has at least one cell (a requirement OR a degradation). With no requirement anywhere
 * AND no degradation, the result is empty — the System panel then shows no guarantee section (no-filler).
 */
export function flowGuaranteeLines(input: GuaranteeViewInput): FlowGuaranteeLine[] {
  const { graph, instances, wires, value, catalog, slos } = input;
  const summaries: readonly FlowGuaranteeSummary[] = flowGuarantees(graph, instances, wires, value);
  const verdicts: readonly GuaranteeVerdict[] = slos.length > 0 ? guaranteeVerdicts(graph, catalog, instances, wires, value, slos) : [];
  const key = (s: string, t: string, d: string): string => `${s}\x00${t}\x00${d}`;
  const verdictBy = new Map<string, GuaranteeVerdict>();
  for (const v of verdicts) verdictBy.set(key(v.source, v.terminal, v.dimension), v);

  const lines: FlowGuaranteeLine[] = [];
  const seen = new Set<string>();

  const emit = (source: string, terminal: string, degradedDims: FlowGuaranteeSummary['dimensions']): void => {
    const flowKey = `${source}\x00${terminal}`;
    if (seen.has(flowKey)) return;
    seen.add(flowKey);
    // Every dimension that either degrades on this flow OR carries a requirement on this flow gets a cell.
    const dimIds = new Set<string>(degradedDims.map((d) => d.dimension));
    for (const v of verdicts) if (v.source === source && v.terminal === terminal) dimIds.add(v.dimension);
    const cells: GuaranteeCell[] = [];
    for (const dimension of orderedDims(dimIds)) {
      const degraded = degradedDims.find((d) => d.dimension === dimension);
      const verdict = verdictBy.get(key(source, terminal, dimension));
      // Prefer the verdict's computed token — it covers a preserved-strong flow that still has a requirement (where
      // `degraded` is absent). Fall back to the degradation's token.
      const token = verdict?.computed ?? degraded?.token ?? '';
      const rootCauseNode = verdict?.rootCauseNode ?? degraded?.rootCauseNode ?? null;
      const required = verdict?.required ?? null;
      const status = verdict?.status;
      const tone = toneOfStatus(status);
      const cause = rootCauseNode !== null ? ` (${rootCauseNode})` : '';
      const text = `${dimension} ${token}${cause}${markOf(status)}`;
      cells.push({
        dimension,
        token,
        rootCauseNode,
        required,
        ...(status !== undefined ? { status } : {}),
        ...(tone !== undefined ? { tone } : {}),
        text,
      });
    }
    if (cells.length === 0) return;
    lines.push({ source, terminal, cells, text: cells.map((c) => c.text).join(' · ') });
  };

  // Degrading flows first (busiest-first, from `flowGuarantees`), then any requirement-only flow not already shown.
  for (const s of summaries) emit(s.source, s.terminal, s.dimensions);
  for (const v of verdicts) emit(v.source, v.terminal, []);

  return lines;
}

// ── System-panel sections (the shared SummarySection shape both shells' System views render) ─────────────────────

/** One labelled, pre-formatted System-panel row — structurally the presenter's `SummaryRow` (title/value/tone), so
 *  the guarantee lines slot into the SAME System view the numeric roll-up feeds, with no protocol change. */
export interface GuaranteeSummaryRow {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'ok' | 'warn' | 'bad';
  /** The root-cause node id a shell can make clickable (select + reveal), or null. */
  readonly rootCauseNode: string | null;
}
export interface GuaranteeSummarySection {
  readonly title: string;
  readonly rows: readonly GuaranteeSummaryRow[];
}

/**
 * The per-flow guarantee lines as System-panel SECTIONS — one section per flow ("Guarantees · <source> → <terminal>"),
 * one row per dimension (label = the dimension, value = the computed token + root cause, tone by verdict). This is the
 * bridge into both shells' System views (the web System drawer + the VS Code System tree render the SAME shape). Empty
 * when no flow has anything to say — the System view then shows no guarantee section (no-filler).
 */
export function guaranteeSummarySections(input: GuaranteeViewInput): GuaranteeSummarySection[] {
  return flowGuaranteeLines(input).map((line) => ({
    title: `Guarantees · ${line.source} → ${line.terminal}`,
    rows: line.cells.map((c) => ({
      label: c.dimension,
      value: `${c.token}${c.rootCauseNode !== null ? ` (${c.rootCauseNode})` : ''}${markOf(c.status)}`.trim(),
      ...(c.tone !== undefined ? { tone: c.tone } : {}),
      rootCauseNode: c.rootCauseNode,
    })),
  }));
}

// ── per-edge canvas strip (the slim guarantee band under a wire) ─────────────────────────────────────────────────

/** A tone for one edge segment of a guarantee strip: 'ok' (teal — the running meet still satisfies the floor at
 *  this edge), 'bad' (red — this edge is AT/AFTER the degrading hop, the promise is broken from here on), 'unknown'
 *  (gray — the path touched a declared-unknown contribution, so the promise is honestly indeterminate). */
export type StripTone = 'ok' | 'bad' | 'unknown';

/** One edge's strip segment for a selected requirement: the wire index (`w${i}` on the canvas), the tone, and a
 *  legible hover naming the transition ("ordering: per-key → none — fan-out keeps no order", or the holding state). */
export interface StripSegment {
  /** Index into `wires` (the `w${i}` id the canvas uses) — addresses the same edge the shell draws. */
  readonly wire: number;
  readonly tone: StripTone;
  readonly hover: string;
}

/** The guarantee strip for ONE selected requirement over ONE flow: the dimension, the required floor, the computed
 *  end-to-end token, the verdict status + root cause, and a tone per participating edge. Produced ONLY for a flow
 *  that declares the requirement AND has a computed result — otherwise the canvas draws zero strip pixels. */
export interface GuaranteeStrip {
  readonly source: string;
  readonly terminal: string;
  readonly dimension: string;
  readonly required: string;
  readonly computed: string;
  readonly status: Status;
  /** The root-cause node id (the degrading hop), or null when the floor holds all the way. */
  readonly rootCauseNode: string | null;
  /** One segment per wire that participates in the flow's path(s); a wire not on any path carries no segment. */
  readonly segments: readonly StripSegment[];
}

/** Parse the wire index out of an engine edge id (`instantiate` mints `e${i}` where i is the index in doc.wires,
 *  and the canvas keys the same edge `w${i}`), so a strip segment addresses the exact wire the shell draws. Returns
 *  undefined for an id that is not the `e<number>` form (defensive — never a wrong wire). */
function wireIndexOfEdge(edgeId: string): number | undefined {
  const m = /^e(\d+)$/.exec(edgeId);
  return m ? Number(m[1]) : undefined;
}

/**
 * Build the canvas guarantee STRIP for a SELECTED requirement (a `GuaranteeSlo`). It reads the engine's own
 * per-edge propagation (`propagateFlowEdges` — the SAME walker `propagateFlow`/the verdicts use) for the required
 * dimension, and paints, per edge:
 *   • teal while the running meet at that edge still satisfies the floor,
 *   • red from the first edge whose running meet drops below the floor onward (the promise broken),
 *   • gray for every edge on a path that touched a declared-unknown contribution (indeterminate).
 * The authoritative verdict + root cause come from `guaranteeVerdicts` (identical to the panels). Returns null when
 * the requirement's flow does not exist / is not connected (nothing honest to paint) — the caller draws no strip.
 *
 * When a wire is on several paths (a fan-out shares its early edges), the WORST tone wins (bad > unknown > ok) — the
 * honest floor a consumer could see, matching `guaranteeVerdicts`' worst-case merge.
 */
export function guaranteeStrip(input: GuaranteeViewInput, slo: GuaranteeSlo): GuaranteeStrip | null {
  const { graph, instances, wires, value, catalog } = input;
  const dimId = DimensionId(slo.dimension);
  const lattice = categorical.get(dimId);
  if (lattice === undefined) return null; // an unknown dimension — nothing to paint
  const need = lattice.rank(DimensionToken(slo.atLeast));
  if (need === undefined) return null; // a malformed floor — nothing to paint

  const verdict = guaranteeVerdicts(graph, catalog, instances, wires, value, [slo])[0];
  if (verdict === undefined) return null;

  const paths = propagateFlowEdges(graph, categorical, dimId, NodeId(slo.source), NodeId(slo.terminal));
  if (paths.length === 0) return null; // not connected — no wire to colour (the panel already states the reason)

  const toneRank: Record<StripTone, number> = { ok: 0, unknown: 1, bad: 2 };
  const worst = new Map<number, { tone: StripTone; hover: string }>();
  const paint = (wire: number, tone: StripTone, hover: string): void => {
    const prev = worst.get(wire);
    if (prev === undefined || toneRank[tone] > toneRank[prev.tone]) worst.set(wire, { tone, hover });
  };

  for (const path of paths) {
    let broke = false; // has the running meet dropped below the floor on this path yet?
    for (const em of path.edges) {
      const wire = wireIndexOfEdge(String(em.edge));
      if (wire === undefined) continue; // an edge the shell does not draw (defensive)
      const rank = lattice.rank(em.to) ?? 0;
      if (rank > need) broke = true; // running is weaker than the floor from here on
      const tone: StripTone = em.touchedUnknown ? 'unknown' : broke ? 'bad' : 'ok';
      paint(wire, tone, stripHover(slo.dimension, em, tone));
    }
  }

  const segments: StripSegment[] = [...worst.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([wire, { tone, hover }]) => ({ wire, tone, hover }));

  return {
    source: slo.source,
    terminal: slo.terminal,
    dimension: slo.dimension,
    required: slo.atLeast,
    computed: verdict.computed,
    status: verdict.status,
    rootCauseNode: verdict.rootCauseNode,
    segments,
  };
}

/** The legible hover for a strip segment: names the DEGRADING transition ("ordering: per-key → none"), the honest
 *  unknown, or the still-holding state ("ordering ✓ per-key"). Uses the engine's per-edge `from`/`to` tokens so the
 *  hover is the exact transition that hop caused — never a re-derivation. */
function stripHover(dimension: string, em: EdgeMeet, tone: StripTone): string {
  if (tone === 'unknown') return `${dimension}: unknown — a hop's ${dimension} is not knowable, so this promise is honestly unverified`;
  const dropped = String(em.from) !== String(em.to);
  if (tone === 'bad') {
    // Below the floor here. If THIS edge is where it dropped, name the transition; else it is downstream of the drop.
    return dropped
      ? `${dimension}: ${String(em.from)} → ${String(em.to)} — the promise breaks at this hop`
      : `${dimension}: ${String(em.to)} — below the required floor from here on`;
  }
  // ok: still satisfies. Name the holding token (a re-statement of the same strong token still reads as ✓).
  return `${dimension} ✓ ${String(em.to)}`;
}
