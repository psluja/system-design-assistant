// @feature Design-doc generator (the authored deliverable)
// @story Turn the verified model into the architect's actual deliverable — a Markdown or
//   self-contained HTML design document with COMPUTED NFR numbers (promises, capacity, C4, cost,
//   reliability, bottlenecks, assumption register); nothing hand-entered, author-required sections
//   flagged.
// @surfaces mcp (generate_doc, app/mcp/src/document.ts), vscode (sda.generateDesignDoc,
//   app/vscode/src/design-doc-host.ts), web (export button in app/web/src/app.tsx — the same pure
//   function, identical output)
// @algorithms content/sda/src/analysis/system.ts, content/sda/src/analysis/queueing.ts, content/sda/src/analysis/sweep.ts,
//   engine/sim/src/des.ts (measured verdicts via doc-sim)
// @docs none
// @e2e none (golden: content/sda/src/doc/design-doc.golden.test.ts and the render/model suites)
// @status shipped

import { applyTransform, type Band, type Transform, type Verdict } from '@sda/engine-core';
import { keys } from '../vocabulary/registry';
import { localContribution, localOwnAvailability, requestFlows, systemSummary, type ValueFn } from '../analysis/system';
import { systemPromiseVerdicts, type SystemPromise } from '../analysis/system-promise';
import { availabilityTier, RELIABILITY_SOURCES, reliabilityAdvice } from '../analysis/reliability';
import type { Instance, Manifest, ManifestBand, Wire } from '../vocabulary/manifest';
import {
  buildDocModel,
  pathAvailabilityFor,
  type AssumptionRow,
  type DocAlternativeSet,
  type DocGroup,
  type DocModelInput,
  type DocSweepPoint,
  type DocWorldsInput,
  type EndToEndAvailability,
  type GuaranteeReqRow,
  type GuaranteesSection,
  type LagReqRow,
  type NodeResponsePercentiles,
  type Provenance,
  type RiskItem,
  type ScenarioOverrideCell,
  type ScenariosSection,
  type ScenarioWorldRow,
} from './doc-model';
import { renderHtml } from './render-html';
import { formatMs, formatMsDigits } from './format-ms';

// DESIGN-DOC GENERATOR — turns the VERIFIED model into the architect's actual deliverable: a Markdown
// design document with the computed NFR numbers filled in, a C4 container view, a
// capacity table and a cost table. It is a PURE function of the model (structure + solved values +
// verdicts), so the web "export" and the MCP `generate_doc` tool emit the IDENTICAL document — the human
// and the AI author one truth. Every number here is COMPUTED (read off the engine), never hand-entered;
// sections the tool does not model are flagged "author required". It lives in content, not the engine,
// because it knows domain meaning (what "availability" or "the bottleneck" is).

// DocGroup (a visual boundary — a tier / VPC / AZ) is defined once in doc-model and re-exported here (via the
// import above), so the two modules never diverge on its shape and callers keep importing it unchanged.
export type { DocGroup };

/** Everything the generator reads — the design's structure + the engine's solved answer. The caller (web
 *  or MCP) supplies it from one `evaluate()`; the generator computes nothing the engine didn't. */
export interface DesignDocInput {
  readonly name: string;
  readonly instances: readonly Instance[];
  readonly wires: readonly Wire[];
  readonly groups?: readonly DocGroup[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly descriptions?: Readonly<Record<string, string>>;
  /** Real-aware verdicts (run `realAwareVerdicts` first): the latency verdict is queueing-aware and ρ≥1 tiers
   *  carry an explicit saturation violation — so §3/§8 never claim "no breach" over a saturated tier. */
  readonly verdicts: readonly Verdict[];
  /** The engine's solved value lookup, `(nodeId, key) => value` (the same one the System roll-up uses). */
  readonly value: ValueFn;
  /** Per-node REAL (queueing-aware) cumulative latency in ms — `realCumulativeLatency(...)`. Infinity at a
   *  saturated tier. Optional: when absent the capacity table falls back to the ideal latency (clearly labelled). */
  readonly realLatencyByNode?: Readonly<Record<string, number>> | undefined;
  /** Per-node REAL request→response latency in ms — `responseLatency(...)`: a tier's own wait plus the
   *  responses of what it synchronously calls; ∞ at a saturated sync dependency. Optional; when present, §4 lists
   *  the per-tier response time so the doc shows the same figure as the canvas ⟳ line and the MCP evaluate. */
  readonly responseLatencyByNode?: Readonly<Record<string, number>> | undefined;
  /** Node ids whose utilisation ρ ≥ 1 (saturated). Surfaced in §4 so the doc names the bottleneck honestly even
   *  at the ρ=1 knife-edge, where overflow is exactly 0 but the real wait is already unbounded. */
  readonly saturated?: readonly string[] | undefined;
  /** The busiest flow's simulated tail (DES), so §4 reports the p99 a reviewer cares about — not just the mean. */
  readonly tail?: { readonly p50: number; readonly p95: number; readonly p99: number } | undefined;
  /** The RETRY OUTCOME the DES measured, present ONLY when a retry policy is declared:
   *  goodput (requests that succeed/s), error rate (failures/s), amplification (attempts ÷ arrivals). §4 reports
   *  goodput vs offered + the error rate HONESTLY — past saturation retries LOWER goodput, and the doc says so. */
  readonly retry?: { readonly goodputRps: number; readonly errorRate: number; readonly amplification: number } | undefined;
  // ── DocModel v2 extensions. All OPTIONAL, so every existing caller keeps compiling; a
  //    caller that passes `catalog` unlocks the assumptions register (provenance is derived against the catalog)
  //    and the risks section in the Markdown output. Absent `catalog` ⇒ those new sections are simply omitted —
  //    byte-for-byte the pre-v2 document. ──────────────────────────────────────────────────────────────────────
  /** The MERGED catalog — needed to derive assumption PROVENANCE (instance config vs manifest default + the
   *  manifest's `source`/`est` data). Available on every surface via `studio.mergedCatalog()`. */
  readonly catalog?: Readonly<Record<string, Manifest>> | undefined;
  /** Canvas node positions — carried into the DocModel's architecture view for the future C4 SVG (R2). */
  readonly layout?: Readonly<Record<string, { readonly x: number; readonly y: number }>> | undefined;
  /** Optional load→latency sweep points the caller computed at generation time (§5 chart series). */
  readonly sweep?: readonly DocSweepPoint[] | undefined;
  /** Optional computed alternatives per swappable tier (§9) — DATA in, never computed here (solvers are DI'd). */
  readonly alternatives?: readonly DocAlternativeSet[] | undefined;
  /** Per-flow guarantee verdicts — DATA in (the caller runs `guaranteeVerdicts`
   *  over the graph + declared requirements). Absent/empty ⇒ the guarantees section is omitted (no-filler). */
  readonly guaranteeVerdicts?: readonly GuaranteeReqRow[] | undefined;
  /** Per-flow LAG verdicts — DATA in (the caller runs `lagVerdicts`). Absent/empty
   *  ⇒ the propagation-lag block is omitted (no-filler). The async-inclusive end-to-end view, beside §4's flow table. */
  readonly lagVerdicts?: readonly LagReqRow[] | undefined;
  /** Per-node SIMULATED response percentiles (ms) from a DES run — DATA in (the caller
   *  reads `sim.nodeResponse`). §4 lists them for the REQUIREMENT-BEARING nodes (a latency/tailLatency band) — the
   *  tail a mean cannot show. Absent (no sim) ⇒ omitted (no-filler); a NaN entry renders as "no data", never a fake. */
  readonly responsePercentilesByNode?: Readonly<Record<string, NodeResponsePercentiles>> | undefined;
  /** The evaluated NAMED WORLDS (assumption-model doc §8) — DATA in (the caller runs `evaluateWorlds` + passes the
   *  declarations). Absent, or only the base world, ⇒ the scenario-comparison section is omitted (no-filler). */
  readonly worlds?: DocWorldsInput | undefined;
  /** The declared SYSTEM-scoped promises (owner ruling: cost is for THE WHOLE SYSTEM) — judged here by the shared
   *  `systemPromiseVerdicts` against the whole-graph total and rendered in §2/§3 with the honest `system` scope
   * label (the scope-labelling extended). Absent/empty ⇒ both sections render exactly as before. */
  readonly systemPromises?: readonly SystemPromise[] | undefined;
  /** The generation timestamp AS AN INPUT (purity: no clock in the model). */
  readonly generatedAt?: string | undefined;
}

// ── formatting ───────────────────────────────────────────────────────────────────────────────────────

/** A compact number: integers bare, else ≤2 decimals with trailing zeros stripped; ∞ for a non-finite value
 *  (a saturated tier's unbounded latency) — never the JS string "Infinity". */
const num = (n: number): string => (!Number.isFinite(n) ? (n > 0 ? '∞' : '−∞') : Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))));
/** An availability/durability ratio as a percentage with enough nines to be meaningful. */
const pct = (a: number): string => `${(a * 100).toFixed(a >= 0.9999 ? 4 : a >= 0.99 ? 3 : 2)}%`;
const money = (n: number): string => `$${num(n)}`;
/** A transform as a human verb phrase for the capacity narrative: "×100" (ratio), "1:100 (÷100)" (batch), a rate
 *  ceiling (cap/window), or "1% (p=0.01)" (prob). Reads the way an architect describes the shaping, not the tag. */
const transformVerb = (t: Transform): string => {
  switch (t.kind) {
    case 'ratio':
      return `×${num(t.value)}`;
    case 'batch':
      return `1:${num(t.value)} (÷${num(t.value)})`;
    case 'cap':
      return `capped at ${num(t.value)} req/s`;
    case 'window':
      return `windowed (≤ ${num(1000 / t.value)} req/s)`;
    case 'prob':
      return `${num(t.value * 100)}% (p=${num(t.value)})`;
    case 'generate':
      // A generator ORIGINATES flow — the narrative names the level (the day's mean rate).
      return `generates ${num(t.level)} req/s`;
  }
};

const STATUS_ICON: Record<Verdict['status'], string> = {
  ok: '✓ ok',
  warning: '⚠ warning',
  violation: '✗ violation',
  unknown: '? unknown',
  'did-not-converge': '? did-not-converge',
};

/** Humanised metric names for the keys an architect reads; unknown keys fall back to the raw id. */
const KEY_LABEL: Record<string, string> = {
  throughput: 'Throughput',
  latency: 'Latency',
  tailLatency: 'Tail latency (p99)',
  availability: 'Availability',
  durability: 'Durability',
  cost: 'Cost',
  overflow: 'Overflow',
  backlog: 'Backlog',
  concurrency: 'Concurrency',
  requiredUnits: 'Required units',
};
const keyLabel = (k: string): string => KEY_LABEL[k] ?? k.charAt(0).toUpperCase() + k.slice(1);

/** The §4 flow latency cell under the SINGLE-TRUTH MEASURED-OR-NOTHING policy (owner ruling): the value is the
 *  discrete-event simulation's MEASUREMENT (seed 7) — the flow terminal's response mean when the run recorded one,
 *  else the busiest-flow measured p50 for a single-flow design, else `no data`. NEVER an analytic scalar: a tier the
 *  simulation never timed reads `no data`, not a queue-model figure (the analytic latency is computed but shown nowhere). */
function measuredLatencyCell(
  terminal: string,
  responsePercentilesByNode: DesignDocInput['responsePercentilesByNode'],
  tail: DesignDocInput['tail'],
  flowCount: number,
): string {
  const node = responsePercentilesByNode?.[terminal];
  if (node !== undefined && Number.isFinite(node.mean)) return formatMs(node.mean);
  if (flowCount === 1 && tail !== undefined && Number.isFinite(tail.p50)) return formatMs(tail.p50);
  return 'no data';
}

/** Render a metric value with its unit, percentage for ratio keys. */
function showValue(key: string, v: number | undefined, unit?: string): string {
  if (v === undefined) return '—';
  if (key === keys.availability || key === keys.durability) return pct(v);
  if (key === keys.cost) return `${money(v)}/mo`;
  if (unit === 'ms') return formatMs(v); // a TIME metric rounds to whole ms (the canonical token carries the unit)
  return unit ? `${num(v)} ${unit}` : num(v);
}

/** A declared SLO band as a human requirement, e.g. "≥ 1000", "≤ 300", "p99 ≤ 300", "≥ 99.99%". Ratio keys
 *  (availability/durability) render as percentages so the requirement matches the computed column. */
function bandRequirement(key: string, band: Band): string {
  // A TIME key (latency / tailLatency) rounds its declared target to whole ms — BARE digits (the requirement column
  // carries no unit); ratio keys render as percentages; everything else keeps the compact `num`.
  const isTime = key === String(keys.latency) || key === String(keys.tailLatency);
  const fmt = (n: number): string => (key === keys.availability || key === keys.durability ? pct(n) : isTime ? formatMsDigits(n) : num(n));
  if (band.shape === 'point') return `= ${fmt(band.target)}`;
  if (band.shape === 'percentiles') return [...band.targets].map(([p, t]) => `${p} ≤ ${isTime ? formatMsDigits(t) : num(t)}`).join(', ');
  const parts: string[] = [];
  if (band.min !== undefined) parts.push(`≥ ${fmt(band.min)}`);
  if (band.max !== undefined) parts.push(`≤ ${fmt(band.max)}`);
  if (band.target !== undefined) parts.push(`target ${fmt(band.target)}`);
  return parts.join(', ') || '(any)';
}

// ── the document ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Generate the Markdown design document. Pure and deterministic (no clock, no randomness) so it is
 * golden-testable and identical across surfaces; a caller that wants a timestamp prepends its own.
 */
export function generateDesignDoc(input: DesignDocInput): string {
  const { name, instances, wires, verdicts, value } = input;
  const labels = input.labels ?? {};
  const descriptions = input.descriptions ?? {};
  const groups = input.groups ?? [];
  const display = (id: string): string => labels[id] || id;
  const verdictFor = (node: string, key: string): Verdict | undefined =>
    verdicts.find((v) => String(v.scope) === node && String(v.key) === key);

  const sys = systemSummary(instances, wires, value);
  const out: string[] = [];
  const h = (...lines: string[]): void => void out.push(...lines);

  h(`# Design Document — ${name}`);
  h('');
  h(
    '> Generated from the verified SDA model. Every metric below is **computed by the engine** from the live ' +
      'design — not hand-entered. Sections marked *author required* are narrative the tool does not model; they ' +
      'are listed so the gating hallmarks (resilience, security, cost, alternatives) are never silently missing.',
  );
  h('');

  // §1 Context — the one fact the model knows: scale of the system. Business context is the author's.
  h('## 1. Context & background');
  h('');
  h(`**${name}** — ${instances.length} components, ${sys.flows.length} independent request flow(s).`);
  if (Object.keys(descriptions).length > 0) {
    h('');
    for (const inst of instances) if (descriptions[inst.id]) h(`- **${display(inst.id)}** — ${descriptions[inst.id]}`);
  }
  h('');
  h('_Business context, drivers and scope: author required._');
  h('');

  // §2 Goals & non-goals — the goals ARE the declared SLOs (node bands + the SYSTEM-scoped promises).
  const slos = instances.flatMap((i) => (i.bands ?? []).map((b): { node: string; band: ManifestBand } => ({ node: i.id, band: b })));
  // The SYSTEM promises (owner ruling: cost is for THE WHOLE SYSTEM), judged by the ONE shared judge against the
  // whole-graph total — the same sum the System panel, the MCP evaluate and the backward search read.
  const sysProms = systemPromiseVerdicts(instances, wires, value, input.systemPromises ?? []);
  h('## 2. Goals & non-goals');
  h('');
  if (slos.length > 0 || sysProms.length > 0) {
    h(`**Goals** — meet the ${slos.length + sysProms.length} declared SLO(s):`);
    for (const p of sysProms) h(`- ${keyLabel(p.key)} for the **whole system** ${bandRequirement(p.key, p.band)} _(system-scoped: every component summed, off-path branches included)_`);
    for (const { node, band } of slos) h(`- ${keyLabel(String(band.key))} at **${display(node)}** ${bandRequirement(String(band.key), band.band)}`);
  } else {
    h('**Goals** — none declared yet (set SLOs to make the promises verifiable).');
  }
  h('');
  h('_Non-goals: author required._');
  h('');

  // §3 Promises (NFR / SLOs) — declared band vs computed value vs verified status. "Promises" is the product's ONE
  // human word for the band kind (owner ruling); "non-functional / SLOs" beside it keeps the industry pointer.
  h('## 3. Promises (non-functional / SLOs)');
  h('');
  if (slos.length > 0 || sysProms.length > 0) {
    // AVAILABILITY SCOPE HONESTY (F4): an availability band is a NODE-scoped promise. Beside it we surface the honest
    // end-to-end availability of each flow that CROSSES the node, so a node-local green never hides a lower path
    // figure. Additive — a node that is every crossing flow's terminal (the common single-flow case) has no contrast
    // and renders exactly as before (the byte-compat golden is preserved).
    const flowsForAvail = requestFlows(instances, wires, value);
    const availFloor = (band: Band): number | undefined => (band.shape === 'point' ? band.target : band.shape === 'minTargetMax' ? band.min ?? band.target : undefined);
    h('| Node | Metric | Promise | Computed | Status |');
    h('|---|---|---|---|---|');
    // SYSTEM-scoped rows FIRST (the global promises lead — scope labelling extended with `system`):
    // the computed column is the whole-graph total (every component summed, off-path branches included), never
    // one branch's accumulated cell. An `unknown` prints the judge's own note, never a fabricated number.
    for (const p of sysProms) {
      const computed = p.computed !== undefined ? showValue(p.key, p.computed, p.unit) + ' _(system-scoped)_' : `— _(system-scoped)_ · ${p.note}`;
      h(`| _whole system_ | ${keyLabel(p.key)} | ${bandRequirement(p.key, p.band)} | ${computed} | ${STATUS_ICON[p.status]} |`);
    }
    for (const { node, band } of slos) {
      const k = String(band.key);
      const v = verdictFor(node, k);
      const e2e: readonly EndToEndAvailability[] = k === String(keys.availability) ? pathAvailabilityFor(node, flowsForAvail, value, availFloor(band.band)) : [];
      const scope = e2e.length > 0
        ? ` _(node-scoped)_ · ${e2e.map((e) => `end-to-end ${pct(e.availability)}${e.belowPromise ? ' ✗' : ''} via ${display(e.source)} → ${display(e.terminal)}`).join('; ')}`
        : '';
      const computed = showValue(k, v?.computed.value, v?.computed.unit) + scope;
      h(`| ${display(node)} | ${keyLabel(k)} | ${bandRequirement(k, band.band)} | ${computed} | ${v ? STATUS_ICON[v.status] : '—'} |`);
    }
  } else {
    h('_No SLOs declared. The capacity and reliability sections below still report the computed NFR picture._');
  }
  h('');

  // §4 Capacity & back-of-the-envelope — the verified end-to-end per flow + per-node throughput/overflow.
  h('## 4. Capacity & estimation');
  h('');
  h('End-to-end per request flow — **Latency is measured** (discrete-event simulation, seed 7); a flow whose terminal the simulation never timed reads _no data_ (never an estimate):');
  h('');
  h('| Flow | Throughput | Latency | Availability | Branch cost |');
  h('|---|---|---|---|---|');
  for (const f of sys.flows) {
    h(
      `| ${display(f.source)} → ${display(f.terminal)} | ${showValue(keys.throughput, f.throughputRps, 'req/s')} | ` +
        `${measuredLatencyCell(f.terminal, input.responsePercentilesByNode, input.tail, sys.flows.length)} | ${showValue(keys.availability, f.availability)} | ${showValue(keys.cost, f.costUsdMonth)} |`,
    );
  }
  h('');
  // PROPAGATION LAG — the async-INCLUSIVE end-to-end view BESIDE the flow table: each
  // declared source→terminal deadline and its verdict (a DES-measured mean, a scalar lower-bound violation, or an
  // honest `unknown` pending the sim — the queue wait the terminal-cumulative latency above deliberately excludes).
  // Present ONLY when the design declares a lag SLO (no-filler); the terminal-cumulative row above stays correct.
  if (input.lagVerdicts && input.lagVerdicts.length > 0) {
    h('**Propagation lag (flow-scoped — async queue waits included):**');
    h('');
    h('| Flow | Deadline | Measured / bound | Status |');
    h('|---|---|---|---|');
    for (const r of input.lagVerdicts) {
      const measured = r.measuredMeanMs !== undefined
        ? `${formatMs(r.measuredMeanMs)} _(measured)_`
        : Number.isFinite(r.lowerBoundMs ?? NaN)
          ? `≥ ${formatMs(r.lowerBoundMs as number)} _(lower bound; queue wait unseen)_`
          : '—';
      h(`| ${display(r.source)} → ${display(r.terminal)} | ≤ ${formatMs(r.maxMs)} | ${measured} | ${STATUS_ICON[r.status]} |`);
    }
    h('');
  }
  if (input.tail) {
    h(`**Tail latency (simulated, busiest flow):** p50 ${formatMs(input.tail.p50)} · p95 ${formatMs(input.tail.p95)} · **p99 ${formatMs(input.tail.p99)}** — the number a reviewer judges by, not the mean.`);
    h('');
  }
  // RETRY POLICY & GOODPUT. A retry policy is declared as caller-side config (timeoutMs > 0)
  // on a node that originates traffic. When present the doc NAMES it — a reviewer must know the design retries —
  // and, when the DES has measured the outcome, reports goodput vs the offered load + the error rate HONESTLY:
  // past saturation retries LOWER goodput (congestion collapse), never raise it, and the document must not pretend
  // otherwise. With no policy anywhere this whole block is absent (nothing to report — no invented resilience).
  const timeoutKey = String(keys.timeoutMs), retryKey = String(keys.retryCount);
  const retryCallers = instances.filter((i) => Number(i.config?.[timeoutKey] ?? 0) > 0);
  if (retryCallers.length > 0) {
    const names = retryCallers.map((i) => `**${display(i.id)}** (timeout ${formatMs(Number(i.config?.[timeoutKey]))}, ${num(Number(i.config?.[retryKey] ?? 0))} retr${Number(i.config?.[retryKey] ?? 0) === 1 ? 'y' : 'ies'})`).join(', ');
    h(`**Retry policy:** ${names} retr${retryCallers.length === 1 ? 'ies' : 'y'} on timeout. Retries are new load on an already-busy tier — past saturation they LOWER useful throughput (goodput), they never raise it. Their effect is a question about time, so it is measured by the simulation, not the instant pass.`);
    if (input.retry) {
      const offered = sys.flows.reduce((s, f) => s + (f.throughputRps ?? 0), 0);
      h('');
      h(
        `**Goodput under the retry policy (simulated):** **${num(input.retry.goodputRps)} req/s succeed**` +
          `${offered > 0 ? ` of ~${num(offered)} req/s offered` : ''} · **${num(input.retry.errorRate)} req/s fail** after retries · ` +
          `attempts ×${num(input.retry.amplification)} the arrivals. ${input.retry.errorRate > 0 || input.retry.amplification > 1 ? 'The retry storm is wasting the saturated tier on doomed attempts — add capacity at the bottleneck or shed load.' : 'The system is below saturation: retries are not yet firing.'}`,
      );
    }
    h('');
  }
  // Saturation & overflow — a tier AT or beyond capacity. Overflow (offered − capacity) catches ρ>1 drops; ρ=1
  // exactly drops nothing yet queues without bound, so we list saturated tiers too — never claim "no bottleneck".
  const overflowMap = new Map(instances.map((i) => [i.id, value(i.id, keys.overflow) ?? 0]));
  const saturatedSet = new Set(input.saturated ?? []);
  const capacityIssues = instances
    .filter((i) => (overflowMap.get(i.id) ?? 0) > 0 || saturatedSet.has(i.id))
    .map((i) => {
      const of = overflowMap.get(i.id) ?? 0;
      return { id: i.id, note: of > 0 ? `overflow ${num(of)} req/s (rejected/dropped/throttled)` : 'saturated (ρ ≥ 1) — queue unbounded, real latency → ∞ (timeouts)' };
    });
  if (capacityIssues.length > 0) {
    h('**Saturation & overflow (a tier at/over capacity — the bottleneck to fix):**');
    h('');
    h('| Node | Condition |');
    h('|---|---|');
    for (const p of capacityIssues) h(`| ${display(p.id)} | ${p.note} |`);
    h('');
  } else {
    h('No tier is saturated: every tier carries its offered load with headroom (ρ < 1).');
    h('');
  }
  // ACTIVE flow transforms — where a port does NOT relay 1:1, the deliverable must say
  // so, or a reviewer reads the wrong downstream pressure (the very bug the feature fixes). We list every declared
  // per-instance transform, resolve the resulting rate from the ENGINE's served value via the ENGINE's own
  // applyTransform (never invented), and name it by wire direction: an OUT transform is an EMISSION ("gen emits ×100
  // of its traffic to logs"), an IN transform a CONSUMPTION ("agg intakes ÷100 of the traffic from client"). Only
  // shown when at least one transform is present — a plain 1:1 design adds no noise.
  const transformRows: string[] = [];
  for (const w of wires) {
    const [srcNode, srcPort] = w.from;
    const [dstNode, dstPort] = w.to;
    const src = instances.find((i) => i.id === srcNode);
    const dst = instances.find((i) => i.id === dstNode);
    const fOut = src?.transforms?.[srcPort];
    const fIn = dst?.transforms?.[dstPort];
    if (fOut !== undefined) {
      const served = value(srcNode, keys.throughput);
      const rate = served === undefined ? undefined : applyTransform(fOut, served);
      transformRows.push(`| ${display(srcNode)} → ${display(dstNode)} | emits ${transformVerb(fOut)} of its traffic | ${rate === undefined ? '—' : `${num(rate)} req/s`} |`);
    }
    if (fIn !== undefined) {
      const served = value(srcNode, keys.throughput);
      const afterOut = served === undefined ? undefined : applyTransform(fOut, served);
      const rate = afterOut === undefined ? undefined : applyTransform(fIn, afterOut);
      transformRows.push(`| ${display(srcNode)} → ${display(dstNode)} | ${display(dstNode)} intakes ${transformVerb(fIn)} of the arriving traffic | ${rate === undefined ? '—' : `${num(rate)} req/s`} |`);
    }
  }
  if (transformRows.length > 0) {
    h('**Flow transforms (a port that does not relay 1:1 — the real downstream pressure):**');
    h('');
    h('| Wire | Transform | Resulting rate |');
    h('|---|---|---|');
    for (const r of transformRows) h(r);
    h('');
  }

  // The ANALYTIC "Response latency per tier" table is intentionally NOT rendered (owner ruling: single-truth
  // measured-or-nothing). `responseLatency` is still computed — it just appears as a shown value on no surface; the
  // measured per-node percentiles table below is the only response-time readout the deliverable prints.

  // Per-node SIMULATED response PERCENTILES — the DES tail (p50/p95/p99) a caller of
  // each REQUIREMENT-BEARING node (a latency/tailLatency SLO) actually feels: the distribution the mean above cannot
  // show. Present ONLY when a sim ran (no-filler); a node with no recorded response reads "no data" (never a fake).
  const respPct = input.responsePercentilesByNode;
  const respPctRows = respPct
    ? instances.filter((i) => respPct[i.id] !== undefined && (i.bands ?? []).some((b) => String(b.key) === String(keys.latency) || String(b.key) === String(keys.tailLatency)))
    : [];
  if (respPctRows.length > 0) {
    h('**Response-time percentiles per promise-bearing node (simulated — the tail a mean cannot show):**');
    h('');
    h('| Node | Mean | p50 | p95 | p99 | Samples |');
    h('|---|---|---|---|---|---|');
    const cell = (v: number): string => (Number.isFinite(v) ? formatMs(v) : 'no data');
    for (const i of respPctRows) {
      const r = respPct![i.id] as NodeResponsePercentiles;
      h(`| ${display(i.id)} | ${cell(r.mean)} | ${cell(r.p50)} | ${cell(r.p95)} | ${cell(r.p99)} | ${num(r.samples)} |`);
    }
    h('');
  }

  // §5 High-level architecture — a C4 container view as Mermaid (renders in Markdown; pure text).
  h('## 5. High-level architecture (C4 container view)');
  h('');
  h('```mermaid');
  h(...c4Container(instances, wires, groups, labels));
  h('```');
  h('');

  // §6 Cost analysis — the bill DEPTH: compute + the most-missed egress line, the grand total, the per-node
  // own cost (sum of locals, fan-in safe), and what committed pricing would save on the eligible spend.
  h('## 6. Cost analysis');
  h('');
  const cb = sys.cost;
  h('| Line | Monthly |');
  h('|---|---|');
  h(`| Compute / storage / managed | ${money(cb.computeUsdMonth)} |`);
  h(`| Data transfer (egress) | ${money(cb.egressUsdMonth)} |`);
  h(`| **Total (on-demand)** | **${money(cb.totalUsdMonth)}** |`);
  h(`| With 1-yr commitment | ${money(cb.committed1yrUsdMonth)} _(−${money(cb.totalUsdMonth - cb.committed1yrUsdMonth)})_ |`);
  h(`| With 3-yr commitment | ${money(cb.committed3yrUsdMonth)} _(−${money(cb.totalUsdMonth - cb.committed3yrUsdMonth)})_ |`);
  h('');
  const ownCost = localContribution(value, instances, wires, keys.cost);
  const costRows = Object.entries(ownCost)
    .filter(([, c]) => c !== 0)
    .sort((a, b) => b[1] - a[1]);
  if (costRows.length > 0) {
    h('Per-component (compute/storage):');
    h('');
    h('| Node | Monthly cost | Share |');
    h('|---|---|---|');
    for (const [id, c] of costRows) {
      const share = cb.computeUsdMonth > 0 ? `${((c / cb.computeUsdMonth) * 100).toFixed(0)}%` : '—';
      h(`| ${display(id)} | ${money(c)}/mo | ${share} |`);
    }
    h('');
  }
  h(`_Egress @ ~$0.09/GB internet data-transfer (set each tier's payload). Committed pricing (AWS Compute Savings Plans / RIs) applies to the eligible compute/db spend (${money(cb.committableUsdMonth)}/mo) — illustrative 40% (1-yr) / 60% (3-yr)._`);
  h('');

  // §7 Reliability — the computed availability mapped to the AWS nines tier, with the sourced remedy.
  h('## 7. Reliability');
  h('');
  for (const f of requestFlows(instances, wires, value)) {
    const avail = value(f.terminal, keys.availability);
    if (avail === undefined) continue;
    const tier = availabilityTier(avail);
    const target = slos.find((s) => s.node === f.terminal && String(s.band.key) === keys.availability && s.band.band.shape === 'minTargetMax');
    const tgt = target && target.band.band.shape === 'minTargetMax' ? target.band.band.min ?? target.band.band.target : undefined;
    const weakest = weakestDependency(input, f);
    const advice = reliabilityAdvice(avail, tgt, weakest);
    h(`**${display(f.source)} → ${display(f.terminal)}: ${pct(avail)}** — ${tier ? `meets the ${pct(tier.availability)} tier (max ${tier.maxDowntimePerYear}/yr; ${tier.applicationCategories})` : 'below the 99% tier'}.`);
    if (advice.remedy) {
      h('');
      h(`> ${advice.remedy}`);
    }
    h('');
  }
  h(`_Source: AWS Well-Architected Reliability Pillar — Availability (${RELIABILITY_SOURCES.availability})._`);
  h('');

  // §8 Scalability & bottleneck analysis — every non-ok verdict, its cause chain and top remediation.
  h('## 8. Scalability & bottleneck analysis');
  h('');
  const problems = verdicts.filter((v) => v.status === 'warning' || v.status === 'violation');
  if (problems.length === 0) {
    h('The design meets every declared band: no bottleneck or SLO breach detected.');
  } else {
    // Group by the actionable fix so one root cause (e.g. an overflow that propagates downstream) is named
    // ONCE, listing every metric/node it affects — not repeated as near-identical bullets.
    const byFix = new Map<string, Verdict[]>();
    for (const v of problems) {
      const fix = v.remediations[0]?.action ?? `${keyLabel(String(v.key))} at ${display(String(v.scope))}`;
      const g = byFix.get(fix);
      if (g) g.push(v);
      else byFix.set(fix, [v]);
    }
    for (const [fix, vs] of byFix) {
      const worst = vs.some((v) => v.status === 'violation') ? 'violation' : 'warning';
      const affected = vs.map((v) => `${keyLabel(String(v.key))} at ${display(String(v.scope))} (${showValue(String(v.key), v.computed.value, v.computed.unit)})`).join(', ');
      h(`- **${STATUS_ICON[worst]}: ${affected}.**`);
      const head = vs[0] as Verdict;
      // The ORIGIN link (last in the chain) is where the binding actually arises — it matches the fix's node,
      // unlike a middle "further up" hop. Fall back to the first link for a single-node cause.
      const cause = head.cause[head.cause.length - 1] ?? head.cause[0];
      if (cause) h(`  - Cause: ${cause.note} (at ${display(String(cause.scope))}).`);
      if (head.remediations[0]) h(`  - Fix: ${fix}.`);
    }
  }
  h('');

  // §9–12 the hallmark sections the tool does not model — flagged, never silently absent.
  for (const [title, note] of AUTHOR_SECTIONS) {
    h(`## ${title}`);
    h('');
    h(`_${note}_`);
    h('');
  }

  // Completeness checklist — the gating function made explicit.
  h('## Completeness');
  h('');
  h('| Section | Source |');
  h('|---|---|');
  h('| Promises / SLOs | ✓ generated from the model |');
  h('| Capacity & estimation | ✓ generated from the model |');
  h('| Architecture (C4) | ✓ generated from the model |');
  h('| Cost analysis | ✓ generated from the model |');
  h('| Reliability | ✓ generated from the model (sourced) |');
  h('| Bottleneck analysis | ✓ generated from the model |');
  h('| Failure modes & resilience | ⚠ author required |');
  h('| Security & privacy | ⚠ author required |');
  h('| Alternatives & trade-offs | ⚠ author required (use compare_options) |');
  h('| Rollout / migration | ⚠ author required |');
  h('');

  // ── DocModel v2 sections. APPENDED after the legacy body so every pre-existing
  //    section stays byte-for-byte identical (the golden pins that). These render the NEW parts of the DocModel —
  //    the assumptions register (§3, the heart) and risks & open questions (§10) — as Markdown tables. Emitted
  //    ONLY when the caller passes `catalog` (provenance needs it); a legacy call omits `catalog` and gets the
  //    unchanged pre-v2 document. The DocModel itself NEVER carries an out-of-domain section (owner ruling §6). ──
  if (input.catalog !== undefined) {
    const model = buildDocModel(toDocModelInput(input, input.catalog));
    if (model.guarantees !== undefined) renderGuaranteesMd(model.guarantees, h);
    renderAssumptionsRegisterMd(model.assumptions, h);
    // The scenario-comparison table (assumption-model doc §8) — beside the register (it extends it with a per-world
    // value column). Present only when the design declares a named world (the model carries the section then).
    if (model.scenarios !== undefined) renderScenariosMd(model.scenarios, h);
    renderRisksMd(model.risks.items, h);
  }

  return out.join('\n');
}

/**
 * Render the design document as the self-contained HTML DELIVERABLE — the human-facing
 * report (C4 SVG, charts, the assumptions register). The SIBLING of `generateDesignDoc`: same `DesignDocInput`, so
 * every surface builds ONE input and picks the format, and the two outputs can never drift from each other. Pure and
 * deterministic (the timestamp is `input.generatedAt`, an input — no clock here). REQUIRES `catalog` (the HTML report
 * carries the assumptions register, whose provenance is derived against the catalog); a caller with no catalog gets
 * an honest error rather than a register-less report, since the register is the point of the HTML deliverable.
 */
export function renderDesignDocHtml(input: DesignDocInput): string {
  if (input.catalog === undefined) {
    // The register (§3, the heart of the HTML report) needs the catalog for provenance. Refusing here is honest —
    // a silent register-less HTML would be a lesser document masquerading as the deliverable. Callers always have it
    // (studio.mergedCatalog()), so this only fires on a programming error, and says exactly what to pass.
    throw new Error('renderDesignDocHtml requires `catalog` (the assumptions register derives provenance against it)');
  }
  return renderHtml(buildDocModel(toDocModelInput(input, input.catalog)));
}

/** Adapt the (superset) DesignDocInput to the DocModel input — the catalog is required there, supplied here. */
function toDocModelInput(input: DesignDocInput, catalog: Readonly<Record<string, Manifest>>): DocModelInput {
  return {
    name: input.name,
    instances: input.instances,
    wires: input.wires,
    catalog,
    verdicts: input.verdicts,
    value: input.value,
    ...(input.groups ? { groups: input.groups } : {}),
    ...(input.labels ? { labels: input.labels } : {}),
    ...(input.descriptions ? { descriptions: input.descriptions } : {}),
    ...(input.layout ? { layout: input.layout } : {}),
    ...(input.realLatencyByNode ? { realLatencyByNode: input.realLatencyByNode } : {}),
    ...(input.responseLatencyByNode ? { responseLatencyByNode: input.responseLatencyByNode } : {}),
    ...(input.saturated ? { saturated: input.saturated } : {}),
    ...(input.tail ? { tail: input.tail } : {}),
    ...(input.retry ? { retry: input.retry } : {}),
    ...(input.sweep ? { sweep: input.sweep } : {}),
    ...(input.alternatives ? { alternatives: input.alternatives } : {}),
    ...(input.guaranteeVerdicts ? { guaranteeVerdicts: input.guaranteeVerdicts } : {}),
    ...(input.lagVerdicts ? { lagVerdicts: input.lagVerdicts } : {}),
    ...(input.responsePercentilesByNode ? { responsePercentilesByNode: input.responsePercentilesByNode } : {}),
    ...(input.worlds ? { worlds: input.worlds } : {}),
    ...(input.systemPromises ? { systemPromises: input.systemPromises } : {}),
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
  };
}

const PROV_LABEL: Record<Provenance, string> = { documented: 'documented', estimate: 'estimate', architect: 'architect', default: 'default' };

/** Render the §3 assumptions register as a Markdown table (one row per assumption, with its provenance badge and
 *  a linked source when documented). The register lists what IS — an empty register renders a plain note. */
function renderAssumptionsRegisterMd(rows: readonly AssumptionRow[], h: (...lines: string[]) => void): void {
  h('## Assumptions & parameters register');
  h('');
  if (rows.length === 0) {
    h('_No configured assumptions — the design rests on no non-default parameters._');
    h('');
    return;
  }
  h('| Assumption | Value | Provenance | Where |');
  h('|---|---|---|---|');
  for (const r of rows) {
    const level = r.transformLevel ? ` (${r.transformLevel}-level)` : '';
    const badge = r.provenance === 'documented' && r.source ? `[documented](${r.source})` : PROV_LABEL[r.provenance];
    // A CATEGORICAL assumption (a guarantee contribution — "ordering: per-key") carries its token VERBATIM in
    // `display`; a token is not a quantity, so it wins over `value + unit` (F10 — never render "0 consistency").
    const valueCell = r.display !== undefined ? r.display : `${docNum(r.value)} ${r.unit}`;
    h(`| ${r.label}${level} | ${valueCell} | ${badge} | ${r.where} |`);
  }
  h('');
}

/** The value of a world's override with its unit (Markdown): ratio→percentage, ms→whole ms, USD→money, else num+unit. */
function overrideValueMd(o: ScenarioOverrideCell): string {
  if (o.unit === 'ratio') return pct(o.value);
  if (o.unit === 'ms') return formatMs(o.value);
  if (o.unit === 'USD/month') return `${money(o.value)}/mo`;
  return o.unit && o.unit !== '1' ? `${num(o.value)} ${o.unit}` : num(o.value);
}

/** The provenance mix of a world's overrides (Markdown): "3 derived · 1 frozen", so a reader sees how many values
 *  still await a measurement. Base (no overrides) reads "—". */
function provenanceMixMd(w: ScenarioWorldRow): string {
  const parts: string[] = [];
  if (w.derivedCount > 0) parts.push(`${w.derivedCount} derived`);
  if (w.architectCount > 0) parts.push(`${w.architectCount} frozen`);
  const plain = w.overrides.length - w.derivedCount - w.architectCount;
  if (plain > 0) parts.push(`${plain} manual`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/** Render the scenario-comparison table (assumption-model doc §8) as Markdown: the base world + every named world,
 *  per-world cost / worst-tier ρ / verdict (incl. which SLO breaks) / the fact-assumption deltas + provenance mix.
 *  Emitted only when the design declares a named world (the caller guards on `model.scenarios`). */
function renderScenariosMd(s: ScenariosSection, h: (...lines: string[]) => void): void {
  h('## Scenarios — world comparison');
  h('');
  h(
    "_The same design under different fact-assumption beliefs (offered load, service times), evaluated side by side — " +
      "the budget-defence view. Values badged `derived` are placeholders sized from this design's own capacity envelope; " +
      'replace them with measurements as they arrive._',
  );
  h('');
  h('| World | Overrides (fact-assumptions) | Provenance | Cost | Peak ρ | Verdict |');
  h('|---|---|---|---|---|---|');
  for (const w of s.worlds) {
    const overrides =
      w.overrides.length > 0
        ? w.overrides.map((o) => `${o.node}.${o.key}=${overrideValueMd(o)}${o.provenance ? ` (${o.provenance === 'architect' ? 'frozen' : o.provenance})` : ''}`).join('; ')
        : w.isBase
          ? 'as authored'
          : '—';
    const stale = w.staleOverrides.length > 0 ? ` _[stale skipped: ${w.staleOverrides.join(', ')}]_` : '';
    const rho = w.peakRho !== undefined ? num(w.peakRho) : '—';
    const verdict = w.feasible
      ? '✓ ok'
      : `✗ ${w.violations} violation${w.violations === 1 ? '' : 's'}${w.brokenSlos.length > 0 ? ` (${w.brokenSlos.join(', ')})` : ''}`;
    h(`| ${w.name} | ${overrides}${stale} | ${w.isBase ? '—' : provenanceMixMd(w)} | ${money(w.costUsdMonth)}/mo | ${rho} | ${verdict} |`);
  }
  h('');
}

/** Render the §10 risks & open questions as a Markdown table: violations, warnings, and every `unknown` with
 *  WHAT would resolve it (honesty about ignorance). Empty ⇒ the honest "no open risks" note. */
function renderRisksMd(items: readonly RiskItem[], h: (...lines: string[]) => void): void {
  h('## Risks & open questions');
  h('');
  if (items.length === 0) {
    h('_No violations, warnings or unknowns — every checked property is within band and computed._');
    h('');
    return;
  }
  h('| Severity | Where | Issue | Resolution |');
  h('|---|---|---|---|');
  const icon: Record<RiskItem['severity'], string> = { violation: '✗ violation', warning: '⚠ warning', unknown: '? unknown' };
  for (const it of items) {
    const resolution = it.fix ?? it.resolvedBy ?? '—';
    h(`| ${icon[it.severity]} | ${it.node} · ${it.key} | ${it.note} | ${resolution} |`);
  }
  h('');
}

/** Render the §7b guarantees section as a Markdown table: per-flow requirement,
 *  computed token, verdict, the root-cause hop and the computed remediation (or the honest reason none exists).
 *  Emitted only when the design declares a guarantee requirement (the caller guards on `model.guarantees`). */
function renderGuaranteesMd(g: GuaranteesSection, h: (...lines: string[]) => void): void {
  h('## Guarantees (consistency · ordering · delivery)');
  h('');
  h('_Qualitative promises each request flow makes about its data, as computed verdicts. A guarantee only ever degrades along a path, so the first hop below the promise is the provable root cause._');
  h('');
  h('| Flow | Dimension | Required | Computed | Status | Root cause | Remediation |');
  h('|---|---|---|---|---|---|---|');
  const icon: Record<GuaranteeReqRow['status'], string> = { ok: '✓ met', warning: '⚠ warning', violation: '✗ violated', unknown: '? unknown', 'did-not-converge': '? unknown' };
  for (const r of g.rows) {
    const cause = r.rootCauseNode ?? '—';
    const fix = r.remediation ?? r.noRemediationReason ?? '—';
    h(`| ${r.source} → ${r.terminal} | ${r.dimension} | ≥ ${r.required} | ${r.computed} | ${icon[r.status]} | ${cause} | ${fix} |`);
  }
  h('');
}

/** A compact number for the v2 tables (integers bare, else ≤2 decimals, trailing zeros stripped). Mirrors the
 *  legacy `num` but does not need the ∞ handling (register/risk values are finite inputs). */
function docNum(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '−∞';
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/** The hallmark sections SDA does not model — emitted as flagged stubs so the gating hallmarks are visible. */
const AUTHOR_SECTIONS: readonly (readonly [string, string])[] = [
  ['9. Failure modes & resilience', 'Timeouts, retries + jitter, idempotency, circuit breakers, backpressure: author required. (SDA verifies series availability and overflow above; the resilience narrative is yours.)'],
  ['10. Security & privacy', 'IAM / least-privilege, encryption, trust boundaries, threat model: author required (not yet modelled by SDA).'],
  ['11. Alternatives considered & trade-offs', 'The staff-vs-junior hallmark. Run `compare_options` per node to source the cheaper/faster alternative, then record the trade-off here.'],
  ['12. Rollout / migration & open questions', 'Deploy / rollback plan, migration steps, open questions: author required.'],
];

/** The weakest hard (synchronous, availability-bearing) dependency on a flow — the series product's
 *  smallest factor — so the reliability remedy can name it. Reads the engine's own-availability inverse. */
function weakestDependency(input: DesignDocInput, flow: { ids: readonly string[]; terminal: string }): { node: string; availability: number } | undefined {
  const own = localOwnAvailability(input.value, input.instances, input.wires);
  let worst: { node: string; availability: number } | undefined;
  for (const id of flow.ids) {
    const a = own[id];
    if (a === undefined) continue;
    if (!worst || a < worst.availability) worst = { node: id, availability: a };
  }
  return worst;
}


// ── C4 container view (Mermaid) ──────────────────────────────────────────────────────────────────────

/** Render the design as a Mermaid `flowchart` — the C4 container level: each component a container, each
 *  wire a relationship (solid sync, dashed async), each group a boundary subgraph. Pure text, renders in
 *  Markdown. Node ids are sanitised to safe tokens; the real id/type goes in the label. */
function c4Container(instances: readonly Instance[], wires: readonly Wire[], groups: readonly DocGroup[], labels: Readonly<Record<string, string>>): string[] {
  const token = new Map<string, string>();
  instances.forEach((i, idx) => token.set(i.id, `n${idx}`));
  const esc = (s: string): string => s.replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
  const decl = (id: string, type: string): string => `  ${token.get(id)}["${esc(labels[id] || id)}<br/><i>${esc(type)}</i>"]`;

  const lines: string[] = ['flowchart LR'];
  const grouped = new Set<string>();
  for (const g of groups) {
    lines.push(`  subgraph ${g.id.replace(/[^A-Za-z0-9_]/g, '_')}["${esc(g.label)}"]`);
    for (const id of g.members) {
      const inst = instances.find((i) => i.id === id);
      if (inst && token.has(id)) { lines.push('  ' + decl(id, inst.type)); grouped.add(id); }
    }
    lines.push('  end');
  }
  for (const i of instances) if (!grouped.has(i.id)) lines.push(decl(i.id, i.type));
  for (const w of wires) {
    const a = token.get(w.from[0]);
    const b = token.get(w.to[0]);
    if (!a || !b) continue;
    lines.push(w.semantics === 'async' ? `  ${a} -. async .-> ${b}` : `  ${a} --> ${b}`);
  }
  return lines;
}
