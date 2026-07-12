import { DimensionId, DimensionToken, NodeId, type Graph, type Guarantees, type Lattice, type Status } from '@sda/engine-core';
import { judgeGuarantee, portsConnect, propagateFlow, type DimensionResult, type FlowGuarantees, type GuaranteeRequirement } from '@sda/engine-solve';
import { keys } from '../vocabulary/registry';
import { categorical, dims } from '../vocabulary/guarantees';
import { protocolCompat } from '../vocabulary/protocols';
import { familyOf } from './synth-spec';
import type { ValueFn } from './system';
import type { Manifest } from '../vocabulary/manifest';

// GUARANTEE REQUIREMENTS + VERDICTS + REMEDIATIONS. This is the categorical
// twin of the numeric SLO layer: an architect declares a per-FLOW requirement ("Ordering ≥ per-key from
// producer→worker"), and every surface reads back a computed verdict (ok / violation / unknown) with the provable
// root-cause hop AND a COMPUTED remediation — the cheapest same-family component swap whose DECLARED labels satisfy
// the requirement (e.g. sqs → fifo, with its documented 300 msg/s ceiling + the cost delta). When no swap exists it
// says so honestly. Nothing is advised from air; the swap, its ceiling and its cost delta are all read off the model.
//
// WHY a per-flow requirement (not a per-node band): a guarantee is a property of a PATH (source→terminal), not of a
// node — `propagateFlow` already takes (source, terminal), a terminal node can be shared by several flows (fan-in),
// and the token vocabulary is deliberately SEPARATE from the numeric registry keys (a `Band` is numeric-only and
// cannot carry a categorical `atLeast` token). So the requirement is keyed by the flow's (source, terminal) node
// ids — the SAME key `flowGuarantees`/`requestFlows` already use — and judged with the engine's `judgeGuarantee`.

/** A per-FLOW guarantee requirement: the flow from `source` to `terminal` must
 *  keep `dimension` AT LEAST AS STRONG as `atLeast`. All three are opaque strings the engine treats categorically;
 *  the phrasing ("Ordering ≥ per-key") is content. Serializable (plain strings) — it round-trips in the project doc. */
export interface GuaranteeSlo {
  readonly source: string;
  readonly terminal: string;
  readonly dimension: string;
  readonly atLeast: string;
}

/** A COMPUTED remediation for a violated guarantee requirement: swap the root-cause node to a same-family component
 *  whose declared labels satisfy the requirement. Every field is read off the model — the swap type, its documented
 *  capacity ceiling (with source), whether the flow's served load fits under it, and the monthly cost delta. */
export interface GuaranteeRemediation {
  /** The root-cause node to change, and the component type to change it to. */
  readonly node: string;
  readonly fromType: string;
  readonly toType: string;
  /** The swap's documented capacity ceiling in its own unit (e.g. SQS FIFO's 300 msg/s), when it has one. */
  readonly ceiling?: { readonly value: number; readonly unit: string; readonly source?: string };
  /** The flow's served load at the root-cause node — compared against `ceiling` for the "fits?" annotation. */
  readonly servedRps?: number;
  /** True iff `servedRps` is within the swap's `ceiling` (so the swap is actually viable at this load). */
  readonly fitsCeiling?: boolean;
  /** The monthly cost delta of the swap (toType − fromType) at the flow's served load, USD/month (may be negative). */
  readonly costDeltaUsdMonth?: number;
  /** A one-line, computed action string for the standard remediation surface (MCP `fix`, design-doc §8). */
  readonly action: string;
}

/** A computed guarantee VERDICT for one declared requirement — the categorical counterpart of the numeric
 *  {@link Verdict}. It is NOT the engine's numeric `Verdict` (whose `computed` is a `Quantity`): a guarantee is a
 *  TOKEN, not a number, and forcing it into a numeric quantity would lie about the type. It carries the same
 *  ok/violation/unknown honesty, the flow as the scope, the dimension as the key, the computed token, the
 *  root-cause hop and the computed remediation — everything a surface renders in its guarantee section. */
export interface GuaranteeVerdict {
  /** The flow the requirement is on (the verdict's SCOPE). */
  readonly source: string;
  readonly terminal: string;
  /** The dimension the requirement is on (the verdict's KEY). */
  readonly dimension: string;
  /** The token the flow requires (at least). */
  readonly required: string;
  /** The token the flow actually computes end-to-end (the meet of every hop). */
  readonly computed: string;
  readonly status: Status;
  /** The provable root-cause hop where the guarantee first dropped below the requirement (or null if it holds). */
  readonly rootCauseNode: string | null;
  readonly rootCauseScope: string | null;
  /** The computed remediation, when the requirement is violated AND a satisfying same-family swap exists. Absent
   *  when the verdict is ok/unknown, or when NO swap can restore the guarantee (said honestly in `noRemediationReason`). */
  readonly remediation?: GuaranteeRemediation;
  /** When violated but no swap exists: the honest reason (so a surface never implies a fix it cannot compute). */
  readonly noRemediationReason?: string;
}

/** The token a manifest declares for `dimension` on ANY of its ports (the strongest it can offer). Used to test
 *  whether a swap candidate could satisfy a requirement — we take the best claim it makes on the dimension. */
function bestTokenFor(lattice: Lattice, manifest: Manifest, dimension: DimensionId): DimensionToken | undefined {
  let best: DimensionToken | undefined;
  for (const p of manifest.ports) {
    const g: Guarantees | undefined = p.guarantees;
    const t = g?.[dimension];
    if (t === undefined) continue;
    if (best === undefined || (lattice.rank(t) ?? Infinity) < (lattice.rank(best) ?? Infinity)) best = t;
  }
  return best;
}

const isIn = (d: string): boolean => d === 'in' || d === 'bi';
const isOut = (d: string): boolean => d === 'out' || d === 'bi';
/** A neighbour port's protocol SET on the wired side — the producer's `speaks` (it emits into our in port) or the
 *  consumer's `accepts` (it receives from our out port). We keep the whole set (not just the natural first) so the
 *  fit test uses the SAME emit∩accept legality the canvas enforces (a queue's out speaks `sqs`; a worker's `in`
 *  ACCEPTS `sqs` even though its natural protocol is `http`), never a false refusal on the natural-only protocol. */
function neighbourProtocols(catalog: Readonly<Record<string, Manifest>>, type: string | undefined, port: string, side: 'speaks' | 'accepts'): readonly string[] {
  const p = type === undefined ? undefined : catalog[type]?.ports.find((x) => x.name === port);
  return (side === 'speaks' ? p?.speaks : p?.accepts) ?? [];
}

/** Does `candidate` DROP INTO the root-cause node's exact wiring? — the same port NAMES the node's wires use, each
 *  carrying a protocol set COMPATIBLE with the neighbour on the far end. The categorical remediation must also be a
 *  legal wiring swap (a queue.nats with an `nats`-only in port cannot replace an `sqs`-fed queue), so a proposed
 *  swap is a REAL drop-in — the same emit∩accept legality the canvas/`specForNode` use, restricted to this node's
 *  edges. Uses the neighbour's full protocol SET (not just its natural protocol) so it never falsely refuses a swap. */
function fitsWiring(
  catalog: Readonly<Record<string, Manifest>>,
  candidate: Manifest,
  node: string,
  instances: readonly { readonly id: string; readonly type?: string }[],
  wires: readonly { readonly from: readonly [string, string]; readonly to: readonly [string, string] }[],
): boolean {
  const typeOf = (id: string): string | undefined => instances.find((i) => i.id === id)?.type;
  // node in-port NAME → the producer's speak set it must accept; node out-port NAME → the consumer's accept set it must emit to
  const needIn = new Map<string, readonly string[]>();
  const needOut = new Map<string, readonly string[]>();
  for (const w of wires) {
    if (w.to[0] === node) needIn.set(w.to[1], neighbourProtocols(catalog, typeOf(w.from[0]), w.from[1], 'speaks'));
    if (w.from[0] === node) needOut.set(w.from[1], neighbourProtocols(catalog, typeOf(w.to[0]), w.to[1], 'accepts'));
  }
  const has = (name: string, neighbour: readonly string[], dir: 'in' | 'out'): boolean =>
    candidate.ports.some((p) => {
      if (p.name !== name || (dir === 'in' ? !isIn(p.dir) : !isOut(p.dir))) return false;
      // in: the producer emits `neighbour`, our in must accept one of them; out: our out speaks, the consumer accepts `neighbour`.
      return dir === 'in' ? portsConnect(neighbour, p.accepts ?? [], protocolCompat) : portsConnect(p.speaks ?? [], neighbour, protocolCompat);
    });
  for (const [name, protos] of needIn) if (!has(name, protos, 'in')) return false;
  for (const [name, protos] of needOut) if (!has(name, protos, 'out')) return false;
  return true;
}

/** A component's documented capacity ceiling = its `throughput` config value + unit + source, if it declares one. */
function ceilingOf(manifest: Manifest): { value: number; unit: string; source?: string } | undefined {
  const c = manifest.config?.find((x) => String(x.key) === String(keys.throughput));
  if (c === undefined) return undefined;
  return { value: c.value, unit: c.unit, ...(c.source !== undefined ? { source: c.source } : {}) };
}

/** The base `unitCost` a manifest declares (the visible cost rate every cost relation multiplies by its driver). */
function unitCostOf(manifest: Manifest): number | undefined {
  return manifest.config?.find((x) => String(x.key) === String(keys.unitCost))?.value;
}

/**
 * Compute the monthly cost DELTA of swapping `fromType → toType` at a node serving `servedRps`. Honest and coarse:
 * for the swaps R2 actually proposes (same-family messaging/store components), cost is a linear function of the
 * base `unitCost` at the served load (pay-per-use = inflow × unitCost; provisioned = throughput × unitCost), so at
 * the SAME served load the delta is `servedRps × (unitCost(to) − unitCost(from))`. Returns undefined when either
 * side declares no `unitCost` (we do not invent a delta we cannot source from the manifests). This is the same
 * per-node own-cost basis `compare_options` reads — computed off the model, never advised from air.
 */
function costDelta(from: Manifest, to: Manifest, servedRps: number | undefined): number | undefined {
  const uFrom = unitCostOf(from);
  const uTo = unitCostOf(to);
  if (uFrom === undefined || uTo === undefined || servedRps === undefined) return undefined;
  return servedRps * (uTo - uFrom);
}

/**
 * Find the cheapest same-family swap for `node` (type `fromType`) whose DECLARED label on `dimension` satisfies the
 * requirement `atLeast`, and package it as a {@link GuaranteeRemediation}. This reuses the compare_options selection
 * discipline — same family (`familyOf`), a like-for-like drop-in — but restricted to the CATEGORICAL check the swap
 * is about: does the candidate's declared token meet the floor? Among the satisfying candidates it picks the lowest
 * `unitCost` (the cheapest restore), then reads its documented ceiling and the cost delta at the flow's served load.
 * Returns null (with no swap) when the family has no candidate that can restore the guarantee — said honestly upstream.
 */
function computeRemediation(
  catalog: Readonly<Record<string, Manifest>>,
  lattice: Lattice,
  dimension: DimensionId,
  node: string,
  fromType: string,
  atLeast: DimensionToken,
  servedRps: number | undefined,
  instances: readonly { readonly id: string; readonly type?: string }[],
  wires: readonly { readonly from: readonly [string, string]; readonly to: readonly [string, string] }[],
): GuaranteeRemediation | null {
  const from = catalog[fromType];
  if (from === undefined) return null;
  const need = lattice.rank(atLeast);
  if (need === undefined) return null;
  const family = familyOf(fromType);

  // Candidate = a DIFFERENT type in the same family that (a) DROPS INTO the node's exact wiring (a real swap, not
  // just a name match) AND (b) declares a token on `dimension` at least as strong as required. (We compare the
  // candidate's BEST claim on the dimension; a queue.sqs.fifo's out-port ordering=per-key satisfies per-key, while
  // queue.sqs's ordering=none does not.) The wiring fit is what keeps the swap HONEST — a queue.nats (nats-only in
  // port) is not a legal replacement for an sqs-fed queue, however cheap it is or however strong its ordering.
  const candidates = Object.keys(catalog)
    .filter((t) => t !== fromType && familyOf(t) === family)
    .map((t) => ({ type: t, manifest: catalog[t] as Manifest }))
    .filter(({ manifest }) => fitsWiring(catalog, manifest, node, instances, wires))
    .filter(({ manifest }) => {
      const tok = bestTokenFor(lattice, manifest, dimension);
      return tok !== undefined && (lattice.rank(tok) ?? Infinity) <= need;
    })
    // cheapest restore first (a swap is a trade-off; the least-cost satisfying option is offered)
    .sort((a, b) => (unitCostOf(a.manifest) ?? Infinity) - (unitCostOf(b.manifest) ?? Infinity));

  const winner = candidates[0];
  if (winner === undefined) return null;

  const ceiling = ceilingOf(winner.manifest);
  const delta = costDelta(from, winner.manifest, servedRps);
  const fits = ceiling !== undefined && servedRps !== undefined ? servedRps <= ceiling.value : undefined;

  // Build the one-line action — every clause is computed (the ceiling, the fit, the delta), never invented.
  const parts: string[] = [`switch ${node} to ${winner.type} — restores ${String(dimension)} ≥ ${String(atLeast)}`];
  if (ceiling !== undefined) {
    const fitMark = fits === undefined ? '' : fits ? ' ✓' : ' ✗ (over ceiling — size up or shard)';
    const load = servedRps !== undefined ? `; your flow ${round(servedRps)} ${ceiling.unit}${fitMark}` : '';
    parts.push(`documented ceiling ${round(ceiling.value)} ${ceiling.unit}${load}`);
  }
  if (delta !== undefined) parts.push(`${delta >= 0 ? '+' : ''}$${round(delta)}/mo`);

  return {
    node,
    fromType,
    toType: winner.type,
    ...(ceiling !== undefined ? { ceiling } : {}),
    ...(servedRps !== undefined ? { servedRps } : {}),
    ...(fits !== undefined ? { fitsCeiling: fits } : {}),
    ...(delta !== undefined ? { costDeltaUsdMonth: delta } : {}),
    action: parts.join(' · '),
  };
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** Merge a fan-out flow's several source→terminal paths into ONE worst-case result per dimension (the honest floor
 *  a consumer could observe). Deterministic — paths already come in a stable order. Mirrors `guarantee-flows`. */
function mergeWorst(paths: readonly FlowGuarantees[]): FlowGuarantees | undefined {
  const first = paths[0];
  if (first === undefined) return undefined;
  if (paths.length === 1) return first;
  const byDim = new Map<string, DimensionResult>();
  for (const p of paths) {
    for (const d of p.dimensions) {
      const key = String(d.dimension);
      const prev = byDim.get(key);
      if (prev === undefined) { byDim.set(key, d); continue; }
      const l = categorical.get(DimensionId(key));
      if (l === undefined) continue;
      const prevRank = l.rank(prev.token) ?? 0;
      const curRank = l.rank(d.token) ?? 0;
      if (curRank > prevRank || (curRank === prevRank && prev.rootCause === null && d.rootCause !== null)) byDim.set(key, d);
    }
  }
  return { source: first.source, terminal: first.terminal, dimensions: [...byDim.values()] };
}

/** Does a design declare ANY guarantee requirement? (The no-filler gate — with none, the whole feature stays silent.) */
export function hasGuaranteeSlos(slos: readonly GuaranteeSlo[] | undefined): boolean {
  return slos !== undefined && slos.length > 0;
}

/**
 * Judge every declared guarantee requirement against the solved design and produce a {@link GuaranteeVerdict} each —
 * with the computed token, the provable root-cause hop, and (on a violation) a computed same-family swap remediation.
 * Pure: it re-propagates each flow over the graph and reads served load + costs off `value`. A requirement whose
 * (source, terminal) no longer names a real flow is reported honestly as `unknown` (a dangling requirement, e.g. a
 * renamed node) rather than dropped — the tool must not silently swallow a declared intent.
 */
export function guaranteeVerdicts(
  graph: Graph,
  catalog: Readonly<Record<string, Manifest>>,
  instances: readonly { readonly id: string; readonly type?: string }[],
  wires: readonly { readonly from: readonly [string, string]; readonly to: readonly [string, string] }[],
  value: ValueFn,
  slos: readonly GuaranteeSlo[],
): GuaranteeVerdict[] {
  const typeOf = new Map(instances.map((i) => [i.id, i.type]));
  const nodeIds = new Set(instances.map((i) => i.id));
  const out: GuaranteeVerdict[] = [];

  for (const slo of slos) {
    const dimId = DimensionId(slo.dimension);
    const lattice = categorical.get(dimId);
    const base: Omit<GuaranteeVerdict, 'status'> = {
      source: slo.source,
      terminal: slo.terminal,
      dimension: slo.dimension,
      required: slo.atLeast,
      computed: slo.atLeast,
      rootCauseNode: null,
      rootCauseScope: null,
    };
    // A requirement naming a dimension the vocabulary does not declare cannot be judged — honest unknown.
    if (lattice === undefined) { out.push({ ...base, status: 'unknown', noRemediationReason: `unknown dimension "${slo.dimension}"` }); continue; }
    // A requirement whose endpoint is not a node in the design (a renamed/removed node) — honest unknown, never a
    // silent drop; the tool must not swallow a declared intent (§3 "unknown naming what would resolve it").
    if (!nodeIds.has(slo.source) || !nodeIds.has(slo.terminal)) {
      out.push({ ...base, status: 'unknown', noRemediationReason: `no flow ${slo.source} → ${slo.terminal} in this design (was a node renamed or removed?)` });
      continue;
    }

    // Enumerate the source → terminal PATHS (any real path the requirement is about — not only the flow's canonical
    // terminal). No path ⇒ the two are not connected in this direction: honest unknown, with what would resolve it.
    const paths = propagateFlow(graph, categorical, NodeId(slo.source), NodeId(slo.terminal));
    if (paths.length === 0) {
      out.push({ ...base, status: 'unknown', noRemediationReason: `no path ${slo.source} → ${slo.terminal} — wire them so the flow's guarantee can be computed` });
      continue;
    }
    const worst = mergeWorst(paths);
    const dimResult = worst?.dimensions.find((d) => String(d.dimension) === slo.dimension);
    if (dimResult === undefined) {
      // No hop touched this dimension ⇒ the path preserves TOP ⇒ it satisfies any requirement (ok).
      out.push({ ...base, computed: String(lattice.top()), status: 'ok' });
      continue;
    }

    const requirement: GuaranteeRequirement = { dimension: dimId, atLeast: DimensionToken(slo.atLeast) };
    const status = judgeGuarantee(lattice, dimResult, requirement);
    const rootCauseNode = dimResult.rootCause ? String(dimResult.rootCause.node) : null;
    const rootCauseScope = dimResult.rootCause ? String(dimResult.rootCause.scope) : null;
    const computed = String(dimResult.token);

    if (status !== 'violation' || rootCauseNode === null) {
      out.push({ ...base, computed, status, rootCauseNode, rootCauseScope });
      continue;
    }

    // A violation with a named root cause ⇒ compute the cheapest same-family swap that restores the guarantee.
    const fromType = typeOf.get(rootCauseNode);
    const servedRps = value(rootCauseNode, keys.throughput);
    const remediation = fromType !== undefined
      ? computeRemediation(catalog, lattice, dimId, rootCauseNode, fromType, DimensionToken(slo.atLeast), servedRps, instances, wires)
      : null;
    out.push({
      ...base,
      computed,
      status,
      rootCauseNode,
      rootCauseScope,
      ...(remediation !== null
        ? { remediation }
        : { noRemediationReason: `no same-family component can restore ${slo.dimension} ≥ ${slo.atLeast} at ${rootCauseNode}` }),
    });
  }

  return out;
}

/** Flatten a {@link GuaranteeVerdict} to the design-doc's per-flow row shape (doc-model `GuaranteeReqRow`) — the
 *  ONE mapping every surface uses to feed the generated document, so the doc and the MCP/web read one computation.
 *  Kept here (not in doc-model) so the categorical logic stays in one module; the returned shape is structural. */
export function guaranteeVerdictRow(v: GuaranteeVerdict): {
  readonly source: string;
  readonly terminal: string;
  readonly dimension: string;
  readonly required: string;
  readonly computed: string;
  readonly status: Status;
  readonly rootCauseNode: string | null;
  readonly remediation?: string;
  readonly noRemediationReason?: string;
} {
  return {
    source: v.source,
    terminal: v.terminal,
    dimension: v.dimension,
    required: v.required,
    computed: v.computed,
    status: v.status,
    rootCauseNode: v.rootCauseNode,
    ...(v.remediation !== undefined ? { remediation: v.remediation.action } : {}),
    ...(v.noRemediationReason !== undefined ? { noRemediationReason: v.noRemediationReason } : {}),
  };
}

/** The dimension ids re-exported for the requirement builders (so a surface names them by the same string). */
export { dims };
