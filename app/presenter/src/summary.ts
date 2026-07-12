import type { Key, Verdict } from '@sda/engine-core';
import { keys, systemSummary, hasTrafficOrigin, NO_ORIGIN_REASON, type CostBreakdown, type LagVerdict, type NodePeak, type NodeQueue, type RequestFlow, type SystemPromiseVerdict } from '@sda/content';
import { fmt, formatMs } from './format';
import { bandComparator } from './band-text';
import { measuredResponseOf } from './latency';
import { worstCaseRho } from './peak-view';

// The canonical System roll-up — the whole-design lens every shell shows: design counts, one section per request
// flow (throughput / MEASURED latency / availability / cost), the simulated tail, per-tier load ρ, and the cost
// breakdown. SINGLE-TRUTH LATENCY (owner decree): every latency here is the DES measurement or nothing — the
// analytic scalar is never shown. Base = app/vscode/webview/App.tsx's `summarySections` (which mirrored app/web's System
// panel). Extracting it here means the web System drawer and the VS Code native System tree render the SAME
// sections, titles, tones and PRE-FORMATTED values — one roll-up, zero drift.
//
// Values are pre-formatted with the SHARED `fmt` (∞ / '—' preserved honestly — never a faked number), so the host
// renders strings verbatim and can't re-derive them differently. The web can iterate these sections directly OR
// keep its richer inline panel reading the SAME underlying figures; the vscode host renders them into a tree.

/** One line of the System roll-up: a labelled, pre-formatted value with an optional severity tint. Structurally
 *  identical to the vscode `SummaryRow` (the presenter owns its OWN type; the shells map to theirs). */
export interface SummaryRow {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'ok' | 'warn' | 'bad';
}
export interface SummarySection {
  readonly title: string;
  readonly rows: readonly SummaryRow[];
}

/** The SHARED heading for a Promises section — the ONE title both the node Inspector's SLO-bands group and the
 *  whole-system Promises section render (owner ruling: one-form). Defined here (the System roll-up's home) so it is
 *  acyclic: node-detail already depends on this module, and re-exports this constant for its Inspector groups. Kept
 *  identical text on every surface so the node's Promises and the System's Promises are indistinguishable in FORM. */
export const PROMISES_TITLE = 'Promises';

/** What the one-line System VERDICT needs — the counts and headline numbers the shells already hold (owner-approved
 *  story, 2026-07-11). Pure inputs so both shells compute the identical verdict: the web renders it as the top pill,
 *  the VS Code System tree as its top item. */
export interface SystemVerdictInput {
  /** Node/flow SLO verdicts in the 'violation' state (system-promise violations INCLUDED by the caller). */
  readonly violations: number;
  /** Tiers whose worst-case load saturates (ρ ≥ 1) — a real breach even with no declared SLO. */
  readonly saturated: number;
  /** The ambient envelope ceiling (max sustainable req/s), when computed — for the "handles up to X" headline. */
  readonly capacityRps?: number | undefined;
  /** The simulated end-to-end p99 (ms), when a sim has measured it. */
  readonly p99Ms?: number | undefined;
  /** The whole-design monthly cost (USD) — shown only when > 0. */
  readonly costUsdMonth?: number | undefined;
}

/** The computed verdict: a status + the headline line + the three at-a-glance numbers (pre-formatted, joined). */
export interface SystemVerdictView {
  readonly status: 'ok' | 'problem';
  readonly headline: string;
  readonly numbers: string;
}

/** THE ONE-LINE SYSTEM VERDICT (owner-approved story, 2026-07-11) — does the design hold, and if not how many
 *  problems to fix + the enabling action, plus the three headline numbers a reviewer wants at a glance. Pure
 *  re-presentation of already-computed values; both shells feed the counts they already hold, so the web pill and the
 *  VS Code System-tree top item read identically. */
export function systemVerdict(input: SystemVerdictInput): SystemVerdictView {
  const n = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
  const problem = input.violations > 0
    ? `${n(input.violations, 'promise', 'promises')} not met — open Problems`
    : input.saturated > 0
      ? `${n(input.saturated, 'tier', 'tiers')} overloaded — open Problems`
      : null;
  const nums: string[] = [];
  if (input.capacityRps !== undefined) nums.push(`handles up to ${fmt(input.capacityRps)} req/s`);
  if (input.p99Ms !== undefined) nums.push(`p99 ${formatMs(input.p99Ms)}`);
  if (input.costUsdMonth !== undefined && input.costUsdMonth > 0) nums.push(`$${fmt(input.costUsdMonth)}/mo`);
  return {
    status: problem ? 'problem' : 'ok',
    headline: problem ?? 'Design holds — every promise met, no tier overloaded',
    numbers: nums.join(' · '),
  };
}

/** A tone that is definitely present — so `tone?` (exactOptionalPropertyTypes) is set only when we have one. */
type Tint = NonNullable<SummaryRow['tone']>;
// The ρ tones the web System panel uses — above ~70% the queue grows, at ≥100% the tier saturates (drops load).
const rhoTone = (rho: number, dropped: boolean): Tint | undefined => (dropped || rho >= 1 ? 'bad' : rho >= 0.7 ? 'warn' : undefined);

/**
 * The precise simulated tail (p50/p95/p99), from the background DES — undefined until the sim has run.
 *
 * RETRY OUTCOME. Past saturation real systems don't plateau — clients time out, retry,
 * and the retries pile more load onto an already-saturated tier, so USEFUL work (goodput) falls BELOW capacity
 * while total attempts explode. When the design declares a retry policy, the DES measures that honestly and the
 * summary shows it: `goodputRps` = requests that actually SUCCEED, `errorRate` = requests that FAIL after every
 * retry is spent, `amplification` = attempts ÷ arrivals (×1 = no retry traffic; higher = a retry storm). These
 * are OPTIONAL and only carried when the sim ran on a design with a retry story — with no policy anywhere the
 * shell leaves them undefined and the summary adds no rows (never advertise a feature that isn't in play).
 */
export interface SimTail {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly goodputRps?: number;
  readonly errorRate?: number;
  readonly amplification?: number;
  /** True when a node declared a live retry policy (timeoutMs > 0) — so the rows show even at ×1 amplification
   *  (a policy that hasn't kicked in yet is still worth reporting: goodput = offered, 0 failed). */
  readonly retryPolicy?: boolean;
  /** LATENCY SEMANTICS v2 (doc §4): every node's OWN response tail (ms) from the same run — a node's view is a
   *  SUFFIX of the same journeys, so one run yields all N perspectives. Feeds the per-node tail verdict (drops the
   *  sink gate — any node's own response tail, matching MCP), the canvas response chip and the System/Inspector
   *  rows. Absent ⇒ no per-node data yet ⇒ a tail SLO stays the honest `unknown` the scalar pass left it. */
  readonly nodeResponse?: readonly NodeResponseView[];
  /** Every DECLARED flow-scoped lag pair's async-INCLUSIVE distribution (ms) from the same run (doc §3). Absent/empty
   *  ⇒ no pair was declared / measured — the lag verdict falls back to the scalar lower bound (honest `unknown`). */
  readonly pairLag?: readonly PairLagView[];
}

/** One node's simulated RESPONSE tail as plain shell↔presenter data (ms). The DES twin of the scalar
 *  `responseLatency`: a node's own queued sojourn plus the responses of what it synchronously calls (async cut).
 *  `mean` is exact over every recorded response; the percentiles come from a bounded reservoir. `NaN` ⇒ the node had
 *  no recorded response (never reached, or every request dropped) ⇒ honest `unknown`, never a fabricated 0. */
export interface NodeResponseView {
  readonly id: string;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly samples: number;
}

/** One declared lag pair's async-INCLUSIVE distribution as plain data (ms) — the DES twin of the scalar
 *  `lagLowerBoundMs`. `NaN` ⇒ the terminal was never reached from the source in this run ⇒ honest `unknown`. */
export interface PairLagView {
  readonly source: string;
  readonly terminal: string;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly samples: number;
}

/** The latency requirement keys that make a node "requirement-bearing" for the response surfaces (doc §1 display
 *  rule): a mean `latency` band or a `tailLatency` (percentile) band. The engine computes a response perspective
 *  for EVERY node; the DISPLAY commits continuous numbers only where one of these was asked for (+ the selection). */
const LATENCY_REQ_KEYS: ReadonlySet<string> = new Set([String(keys.latency), String(keys.tailLatency)]);

/** Does this node carry a latency / tailLatency requirement? (the no-filler gate for the continuous response rows). */
export function bearsLatencyRequirement(bands: readonly unknown[] | undefined): boolean {
  return (bands ?? []).some((b) => LATENCY_REQ_KEYS.has(String((b as { key?: unknown }).key)));
}

/** Format one node's MEASURED response tail as a single legible line — just the three percentiles a reviewer judges
 *  by: "p50 90 ms · p95 260 ms · p99 310 ms", or the honest "no data" when the node had no recorded response (NaN).
 *  The mean is already shown on the node's Latency row and the sample count is engine detail, so both are left off
 *  here to keep the line readable. The numbers are the DES's own — the single-truth measured latency. */
export function formatResponseTail(r: NodeResponseView): string {
  if (!Number.isFinite(r.mean) || r.samples === 0) return 'no data — the node had no recorded response (never reached, or every request dropped)';
  return `p50 ${formatMs(r.p50)} · p95 ${formatMs(r.p95)} · p99 ${formatMs(r.p99)}`;
}

/** The System rows for per-node RESPONSE latency — one row per REQUIREMENT-BEARING
 *  node (a latency/tailLatency band), read off the last DES run's per-node tail. Empty until a sim has run OR when
 *  no node bears a latency requirement (no-filler). SHARED by both shells so the web System drawer and the VS Code
 *  System tree show the identical rows. `tone` mirrors the node's own latency/tailLatency verdict (what is judged
 *  equals what is shown); a node with no verdict reads neutrally (an informational measurement). */
export function responseRows(
  sim: SimTail | null,
  instances: SummaryInput['instances'],
  verdicts: readonly Verdict[],
  labelOf: (id: string, type: string) => string,
  typeOf: (id: string) => string,
): SummaryRow[] {
  if (!sim || sim.nodeResponse === undefined || sim.nodeResponse.length === 0) return [];
  const byId = new Map(sim.nodeResponse.map((n) => [n.id, n]));
  const rows: SummaryRow[] = [];
  for (const inst of instances) {
    if (!bearsLatencyRequirement(inst.bands)) continue;
    const r = byId.get(inst.id);
    if (r === undefined) continue; // the node is not in the run (a source with no station) — nothing honest to show
    const tone = latencyVerdictTone(verdicts, inst.id);
    rows.push({ label: labelOf(inst.id, typeOf(inst.id)), value: formatResponseTail(r), ...(tone ? { tone } : {}) });
  }
  return rows;
}

/** The worst tone of a node's own latency / tailLatency verdicts (violation → warn → ok), or undefined when it has
 *  none — so a response row reads red exactly when the tail/mean SLO it measures is being violated. */
function latencyVerdictTone(verdicts: readonly Verdict[], id: string): Tint | undefined {
  let worst: Tint | undefined;
  const rank = { ok: 0, warn: 1, bad: 2 } as const;
  for (const v of verdicts) {
    if (String(v.scope) !== id || !LATENCY_REQ_KEYS.has(String(v.key))) continue;
    const t: Tint | undefined = v.status === 'violation' ? 'bad' : v.status === 'warning' ? 'warn' : v.status === 'ok' ? 'ok' : undefined;
    if (t !== undefined && (worst === undefined || rank[t] > rank[worst])) worst = t;
  }
  return worst;
}

/** The System rows for declared flow-scoped LAG deadlines — one per {@link LagVerdict}, its requirement + honest
 *  read-back (measured mean incl. queue wait / lower-bound violation / `unknown` pointing at the sim). Exported so
 *  both shells render the SAME rows (the web renders them in its System drawer; the VS Code tree via `summarySections`). */
export function lagRows(
  lag: readonly LagVerdict[] | undefined,
  labelOf: (id: string, type: string) => string,
  typeOf: (id: string) => string,
): SummaryRow[] {
  return (lag ?? []).map((v) => lagRow(v, labelOf, typeOf));
}

/** Amplification above this reads as a retry STORM worth warning about — attempts meaningfully exceed arrivals
 *  (20% more work in flight than requests). Below it, a ×1.0–1.2 policy is informational, not alarming. */
const AMPLIFICATION_WARN = 1.2;

/** Whether a sim carries a RETRY STORY worth surfacing: a declared policy, OR the DES already measured retry
 *  traffic (amplification past unity) or real failures. No story ⇒ no rows (ui-no-absent-feature-filler). */
function hasRetryStory(sim: SimTail): boolean {
  return sim.retryPolicy === true || (sim.amplification !== undefined && sim.amplification > 1) || (sim.errorRate !== undefined && sim.errorRate > 0);
}

/** Everything `summarySections` needs, all already computed by the shell (the presenter re-derives nothing that
 *  the engine/content didn't — it only calls `systemSummary` for the cost/flow depth, exactly as both shells do). */
export interface SummaryInput {
  readonly instances: ReadonlyArray<{ readonly id: string; readonly type?: string; readonly bands?: readonly unknown[] }>;
  readonly wires: ReadonlyArray<{ readonly from: readonly [string, string]; readonly to: readonly [string, string] }>;
  /** The engine's solved value reader (adapted to string ids) — null when the design has build errors. */
  readonly value: ((id: string, key: Key) => number | undefined) | null;
  readonly flows: readonly RequestFlow[];
  readonly queues: ReadonlyMap<string, NodeQueue>;
  readonly saturated: ReadonlyMap<string, number>; // id → dropped rps (only ρ≥1 tiers)
  readonly totalCost: number; // whole-design monthly cost (the footer/SLO figure)
  readonly costBreak: CostBreakdown | null; // the cost depth (compute + egress + committed); null with build errors
  readonly verdicts: readonly Verdict[];
  readonly evalOk: boolean;
  readonly evalErrorCount: number;
  readonly sim: SimTail | null; // the background DES tail, or null (honest "measuring…" row)
  /** Declared flow-scoped LAG verdicts, already computed by the shell via
   *  `lagVerdicts`. Absent/empty ⇒ no lag section (the no-filler rule). On the live edit path these carry the
   *  SCALAR verdict (a provable violation or an honest `unknown` pointing at the sim); the DES-measured resolution
   *  is the MCP `simulate` surface (and the R3 canvas). */
  readonly lag?: readonly LagVerdict[];
  /** Declared SYSTEM-scoped promise verdicts (owner ruling: cost is for THE WHOLE SYSTEM), already computed by the
   *  shell via content `systemPromiseVerdicts` — the ONE judge every surface shares. Absent/empty ⇒ no section
   *  (no-filler). Rendered as a SYSTEM row with NO flow context: the quantity belongs to the whole design. */
  readonly systemPromises?: readonly SystemPromiseVerdict[];
  /** Friendly label for a node id (the shell's `labelOf`). */
  readonly labelOf: (id: string, type: string) => string;
  /** Type id for a node id (the shell's `typeOf`). */
  readonly typeOf: (id: string) => string;
  /** PEAK-AWARE: each node's WORST-WINDOW ρ + instant from the Tier-1 sweep (content
   *  `peakLoadByNode`). When present, the `Load per tier · ρ` rows read the peak beside the steady ρ (and a
   *  saturating isolated origin, absent from `queues`, gets its own row). Absent (no shaped generator) ⇒ the
   *  section is byte-identical to today (the no-filler / sacred-pin rule). */
  readonly peakByNode?: ReadonlyMap<string, NodePeak>;
}

/** The System-row tone for a lag verdict status (a violation is bad; an unknown is informational, not alarming —
 *  it means "the scalar cannot see the queue wait; run the sim", never a failure). */
const lagTone = (status: LagVerdict['status']): Tint | undefined => (status === 'violation' ? 'bad' : undefined);

/** The System rows for declared WHOLE-SYSTEM promises — one per {@link SystemPromiseVerdict}: the promised band
 *  (the shared `bandComparator` grammar) as the label, the honest read-back (`now $X/mo ✓|✗`, or the verdict's own
 *  note for an `unknown`) as the value. THE one composition both shells render (a System row with NO flow context —
 *  the quantity is global), so the web System panel and the VS Code System tree can never word it differently. */
export function systemPromiseRows(verdicts: readonly SystemPromiseVerdict[] | undefined): SummaryRow[] {
  return (verdicts ?? []).map((v) => {
    const tone: Tint | undefined = v.status === 'violation' ? 'bad' : v.status === 'warning' ? 'warn' : v.status === 'ok' ? 'ok' : undefined;
    const value =
      v.computed === undefined || v.status === 'unknown'
        ? v.note
        : `now $${fmt(v.computed)}/mo ${v.status === 'violation' ? '✗' : '✓'}`;
    return { label: `${bandComparator(v.key, v.band, 'system')} · whole system`, value, ...(tone ? { tone } : {}) };
  });
}

/** One System row for a declared lag deadline — the requirement, and the honest read-back of how far the tool got.
 *  MEASURED ⇒ the true async-inclusive mean; a lower-bound violation ⇒ the queue-free floor already breaches;
 *  `unknown` ⇒ within the floor but the queue wait is invisible to the scalar (run the sim). Never a guess. */
function lagRow(v: LagVerdict, labelOf: (id: string, type: string) => string, typeOf: (id: string) => string): SummaryRow {
  const label = `${labelOf(v.source, typeOf(v.source))} → ${labelOf(v.terminal, typeOf(v.terminal))}`;
  const req = `≤ ${formatMs(v.maxMs)}`;
  let detail: string;
  if (v.basis === 'measured' && v.measuredMeanMs !== undefined) {
    detail = `${formatMs(v.measuredMeanMs)} ${v.status === 'violation' ? '✗' : '✓'} (incl. queue wait)`;
  } else if (v.status === 'violation') {
    detail = Number.isFinite(v.lowerBoundMs) ? `lower bound ${formatMs(v.lowerBoundMs)} already over ✗` : 'saturated tier ⇒ unbounded ✗';
  } else {
    detail = 'run the simulation for the true lag (queue wait unseen)';
  }
  const tone = lagTone(v.status);
  return { label, value: `${req} · ${detail}`, ...(tone ? { tone } : {}) };
}

/**
 * Build the System roll-up sections. EXACTLY app/vscode/webview/App.tsx's `summarySections` (which mirrors the web
 * System panel):
 *   1. "Design" — component / connection / flow / SLO counts + a violation count (bad/ok tone);
 *   2. one section PER flow — throughput, MEASURED latency (mean · p99, omitted until the DES measures it), availability, cost;
 *   3. "Response time · end-to-end" — p50/p95/p99, or an honest pending row when no sim yet;
 *   4. "Load per component" — every queued node's utilisation %, toned by the web thresholds (≥70% warn, ≥100% bad);
 *   5. "Cost" — the compute/egress/total + committed-pricing breakdown (only when there is real cost).
 */
export function summarySections(input: SummaryInput): SummarySection[] {
  const { instances, wires, value, flows, queues, saturated, totalCost, costBreak, verdicts, evalOk, evalErrorCount, sim, lag, systemPromises, labelOf, typeOf, peakByNode } = input;
  const sections: SummarySection[] = [];
  const summary = value ? systemSummary(instances, wires, value) : null;
  // A design with NO traffic origin (no client and no node with assumedRps > 0) has no flow to simulate — the tail
  // section must SAY WHY rather than sit on a client-specific hint that a client-less migration would never satisfy.
  const noOrigin = value ? !hasTrafficOrigin(instances, wires, value) : false;

  // A declared whole-system promise counts as a promise and its violation as a violation — the Design roll-up must
  // never under-count the global promises relative to the node bands. (An end-to-end availability promise is a NODE
  // band on the terminal, already counted in the node bands / node verdicts — one home.)
  const systemViolations = (systemPromises ?? []).filter((v) => v.status === 'violation').length;
  sections.push({
    title: 'Design',
    rows: [
      { label: 'Components', value: String(instances.length) },
      { label: 'Connections', value: String(wires.length) },
      { label: 'Independent flows', value: String(flows.length) },
      { label: 'Promises (SLO)', value: String(instances.reduce((n, i) => n + (i.bands?.length ?? 0), 0) + (systemPromises?.length ?? 0)) },
      { label: 'Violations', value: String(verdicts.filter((v) => v.status === 'violation').length + systemViolations + (evalOk ? 0 : evalErrorCount)), tone: verdicts.some((v) => v.status === 'violation') || systemViolations > 0 || !evalOk ? 'bad' : 'ok' },
    ],
  });

  // Promises (owner ruling: ONE FORM — structurally identical to the node Inspector's 'Promises' section). The
  // declared SYSTEM-scoped promises (judged against the one whole-graph total) render as the rows; each carries its
  // scope INLINE (the whole-system row ends "· whole system"), so scope lives PER-ROW, never in the header. The
  // section is ALWAYS emitted (even with zero rows) — the deliberate exception to no-filler that the node's Promises
  // group also makes: it is the HOME the shell hangs its always-present "Add promise…" affordance on, so there is
  // always somewhere to declare the first system promise. Title = the SHARED PROMISES_TITLE (never a literal), so the
  // System Promises and the node Promises can never drift apart.
  sections.push({ title: PROMISES_TITLE, rows: systemPromiseRows(systemPromises) });

  flows.forEach((fl, i) => {
    const fm = summary?.flows.find((f) => f.terminal === fl.terminal);
    const avail = fm?.availability;
    const tp = fm?.throughputRps;
    const rows: SummaryRow[] = [{ label: 'Throughput', value: `${fmt(tp)} rps` }];
    // SINGLE-TRUTH LATENCY (owner decree): the flow's latency is the terminal's MEASURED response (mean + p99 tail),
    // or nothing at all — never the analytic scalar. It is omitted until the DES has measured it (the "Tail latency ·
    // simulated" and per-node sections below stay the fuller home); the tone is the terminal's own latency verdict.
    const measured = measuredResponseOf(sim, fl.terminal);
    if (measured !== null) {
      const tone = latencyVerdictTone(verdicts, fl.terminal);
      rows.push({ label: 'Latency (measured)', value: `${formatMs(measured.mean)} · p99 ${formatMs(measured.p99)}`, ...(tone ? { tone } : {}) });
    }
    rows.push({ label: 'Availability', value: avail !== undefined ? `${(avail * 100).toFixed(2)}%` : '—' });
    rows.push({ label: 'Cost', value: totalCost > 0 ? `$${fmt(totalCost)}/mo` : '—' });
    sections.push({ title: `${flows.length > 1 ? `Flow ${i + 1} · ` : 'System · '}${labelOf(fl.source, typeOf(fl.source))} → ${labelOf(fl.terminal, typeOf(fl.terminal))}`, rows });
  });

  // Response time · end-to-end (the background DES). With a real sim, show p50/p95/p99. Otherwise an honest pending
  // row — and when there is NO traffic origin at all, say WHY (a client-less design cannot be told to "set a client
  // throughput"; the fix is assumedRps on any node or a client).
  const tailRows: SummaryRow[] = sim
    ? [
        { label: 'p50', value: formatMs(sim.p50) },
        { label: 'p95', value: formatMs(sim.p95) },
        { label: 'p99 · tail', value: formatMs(sim.p99) },
      ]
    : [{ label: 'status', value: noOrigin ? NO_ORIGIN_REASON : 'set a client throughput to simulate the tail' }];
  // RETRY OUTCOME rows — ONLY when the sim ran on a design with a retry story (a declared policy or measured retry
  // traffic). These come from the SAME DES run and belong next to the tail (both are time-domain truths the scalar
  // pass can't see). Self-explanatory labels for an outsider: what succeeded, what failed, how much the retries
  // multiplied the work. Failures > 0 is a real breach (violation tone); heavy amplification is a warning.
  if (sim && hasRetryStory(sim)) {
    if (sim.goodputRps !== undefined) tailRows.push({ label: 'Goodput (succeeded)', value: `${fmt(sim.goodputRps)} req/s` });
    if (sim.errorRate !== undefined) {
      tailRows.push({ label: 'Failed after retries', value: `${fmt(sim.errorRate)} req/s`, ...(sim.errorRate > 0 ? { tone: 'bad' as const } : {}) });
    }
    if (sim.amplification !== undefined) {
      tailRows.push({ label: 'Retry amplification', value: `×${fmt(sim.amplification)}`, ...(sim.amplification > AMPLIFICATION_WARN ? { tone: 'warn' as const } : {}) });
    }
  }
  sections.push({ title: 'Response time · end-to-end', rows: tailRows });

  // Response latency · per node — the request→response tail a caller of each
  // REQUIREMENT-BEARING node (a latency/tailLatency band) actually feels, measured from the same DES run. One row
  // per such node with its mean + p50/p95/p99; ONLY when a sim has run and at least one node bears a latency
  // requirement (no-filler — a design with no latency SLO adds no section). This is the whole-design roll-up of the
  // per-node number the canvas chip shows and the Inspector expands.
  const respRows = responseRows(sim, instances, verdicts, labelOf, typeOf);
  if (respRows.length > 0) sections.push({ title: 'Response time · per component', rows: respRows });

  // Propagation lag · flow-scoped — one row per declared CDC/replication deadline
  // (source → terminal, async queue waits INCLUDED), with the honest read-back. ONLY when the design declares one
  // (no-filler); a design with no lag SLO adds no section.
  if (lag && lag.length > 0) {
    sections.push({ title: 'Propagation lag · flow-scoped', rows: lag.map((v) => lagRow(v, labelOf, typeOf)) });
  }

  // Load per component — every queued node, tone by the same thresholds the web System panel uses. WORST-CASE LOAD
  // (owner ruling: a peak is just traffic in a given environment): each row reads the WORST load the declared
  // environment produces — the worst-window ρ when a generator is shaped, else the steady ρ (byte-identical to
  // today). A violation is a violation, red when ρ saturates, with no separate 'peak' / '@HH:MM' framing.
  const loadRows: SummaryRow[] = [];
  for (const [id, q] of queues) {
    const drop = saturated.get(id);
    const rho = worstCaseRho(q.rho, peakByNode?.get(id)) ?? q.rho;
    const pct = rho * 100;
    const tone = rhoTone(rho, drop !== undefined);
    loadRows.push({
      label: labelOf(id, typeOf(id)),
      value: drop !== undefined ? `saturated · drops ${fmt(drop)}/s` : `${pct >= 1000 ? '≥1000' : pct.toFixed(0)}%`,
      ...(tone ? { tone } : {}),
    });
  }
  // A saturating ISOLATED ORIGIN (a generator with no downstream) is absent from `queues` (nodeQueues skips a
  // source), but the self-origin sweep ρ still catches it — surface it here too when its worst load saturates, so a
  // node the design declares breaks never vanishes from the load section (never green while a tier saturates).
  if (peakByNode !== undefined) {
    for (const [id, peak] of peakByNode) {
      if (queues.has(id)) continue;
      const rho = worstCaseRho(undefined, peak);
      if (rho === undefined || rho < 1) continue;
      const pct = rho * 100;
      loadRows.push({ label: labelOf(id, typeOf(id)), value: `${pct >= 1000 ? '≥1000' : pct.toFixed(0)}%`, tone: 'bad' });
    }
  }
  if (loadRows.length > 0) sections.push({ title: 'Load per component', rows: loadRows });

  // Cost breakdown — the CostBreakdown fields, exactly as the web System panel shows them.
  if (costBreak && costBreak.totalUsdMonth > 0.005) {
    sections.push({
      title: 'Cost',
      rows: [
        { label: 'Compute / storage', value: `$${fmt(costBreak.computeUsdMonth)}/mo` },
        { label: 'Data transfer (egress)', value: `$${fmt(costBreak.egressUsdMonth)}/mo` },
        { label: 'Total · on-demand', value: `$${fmt(costBreak.totalUsdMonth)}/mo` },
        { label: '1-yr commit', value: `$${fmt(costBreak.committed1yrUsdMonth)}/mo`, tone: 'ok' },
        { label: '3-yr commit', value: `$${fmt(costBreak.committed3yrUsdMonth)}/mo`, tone: 'ok' },
      ],
    });
  }
  return sections;
}
