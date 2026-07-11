// @algorithm System roll-up (union-find flow decomposition + cumulative-fold inversion)
// @problem The end-to-end picture — per-flow throughput, latency, availability, cost — must be
//   recovered from a solved graph whose cells carry CUMULATIVE values, and each node's OWN
//   contribution is not stored anywhere.
// @approach Decompose into request flows by union-find with path compression over wires plus
//   directed BFS reachability per origin; recover own contributions by inverting the network's
//   folds — own(n) = value(n) - sum of predecessors' values for sums, the quotient for the
//   availability product; diagnose cyclic flows honestly instead of mis-summing them.
// @complexity Union-find near-linear (path compression); reachability O(V + E) per origin;
//   contribution inversion O(V + E).
// @citations Union-find (Tarjan 1975); the inversions are exact algebraic inverses of the cell
//   network's sum/product aggregations.
// @invariants Inversion round-trips the engine's folds exactly (anchored by the sensitivity-matrix
//   test); one shared computation for every surface — the human and the AI read the same numbers.
// @where-tested content/sda/src/system.e2e.test.ts, content/sda/src/sensitivity-matrix.test.ts

// @feature System evaluation & roll-up
// @story Every edit yields the verified end-to-end picture — per-flow throughput, latency,
//   availability, cost and honest verdicts — identical on the canvas, in the doc and over MCP.
// @surfaces mcp (evaluate / apply_design, app/mcp/src/tools.ts), web (canvas + System panel),
//   vscode (System tree, diagnostics, status bar), presenter (summary/status/problems)
// @algorithms content/sda/src/system.ts, engine/solve/src/fixpoint/solve.ts,
//   engine/solve/src/network/build.ts, content/sda/src/queueing.ts
// @docs none (the engine calculus and coverage map live in the Backlog docs doc-4 / doc-8)
// @e2e content/sda/src/architectures.e2e.test.ts, content/sda/src/system.e2e.test.ts,
//   app/web/src/value-loop.e2e.test.ts
// @status shipped

import type { Key } from '@sda/engine-core';
import { keys } from './registry';

// SYSTEM-LEVEL roll-up — the end-to-end picture an architect reads off a solved design, computed ONCE and
// shared by every surface (the web System panel AND the MCP `evaluate`), so the human and the AI see the same
// numbers. It is domain-aware (it knows latency sums, availability multiplies, cost sums), which is why it
// lives in content, not the domain-agnostic engine.

/** Read a solved key value for a node id (the engine's `Evaluation.value`, adapted to string ids). */
export type ValueFn = (id: string, key: Key) => number | undefined;
type Inst = { readonly id: string; readonly type?: string };

/** Does a node DECLARE traffic it originates (assumedRps > 0)? A universal traffic source need not be a `client.*`:
 *  a migration service, a connected emitter or any node can originate. Preferred as a flow's `source` over the
 *  topological (no-in-wire) rule, so a client-less design (DB-to-DB migration) still names its true origin. */
const originatesTraffic = (id: string, value: ValueFn): boolean => (value(id, keys.assumedRps) ?? 0) > 0;

/** The exact wording every surface uses when a design has NO traffic origin — so the human and the AI read the
 *  same honest reason (a design with no source produces no flow, status or tail; the tool must not fake one). */
export const NO_ORIGIN_REASON = "No traffic origin — add a generator on a node's output port (or add a client) to see flows, status and tail latency";

/**
 * Does the design have ANY INTENTIONAL traffic origin? True when SOME node either (a) declares assumedRps > 0
 * (the universal source — a migration service, a cron, any emitter), or (b) is a `client.*` node (whose whole
 * job is to originate; its throughput config is the workload). False ⇒ nothing intentionally drives the design,
 * so throughput/tail/verdicts are vacuous and the shells must SAY WHY (NO_ORIGIN_REASON) instead of a silent
 * blank. We deliberately do NOT treat a bare capacity source (e.g. a wired-out DB with no assumedRps) as an
 * origin: a database does not spontaneously emit its ceiling as traffic — the fix is to add a generator on it.
 */
export function hasTrafficOrigin(instances: readonly Inst[], _wires: readonly Wire[], value: ValueFn): boolean {
  for (const inst of instances) {
    if (originatesTraffic(inst.id, value)) return true; // a declared universal origin (assumedRps > 0)
    if ((inst.type ?? '').startsWith('client')) return true; // a client node: dedicated traffic source
  }
  return false;
}

/** Component types eligible for committed pricing (AWS Compute Savings Plans cover compute; RIs cover RDS). */
const isCommittable = (type: string | undefined): boolean => type !== undefined && (type.startsWith('compute.') || type.startsWith('db.'));
// Typical effective discount on the committable (compute/db) spend, no-upfront (sourced: AWS Compute Savings
// Plans, https://aws.amazon.com/savingsplans/compute-pricing/). 1-yr ≈ 40%, 3-yr ≈ 60% — illustrative midpoints.
const COMMIT_SAVING = { oneYear: 0.4, threeYear: 0.6 } as const;
type Wire = { readonly from: readonly [string, string]; readonly to: readonly [string, string] };

/**
 * Recover each node's OWN contribution to a SUM-aggregated property from the engine's CUMULATIVE value:
 * own(n) = value(n) − Σ_{p→n} value(p). The exact inverse of the cell network's `out = local + Σin`, so it is
 * correct ONLY for keys whose `series` aggregate is 'sum' (cost, latency). Fan-in/out safe (a shared
 * predecessor is subtracted once per edge, never double-counted).
 */
export function localContribution(value: ValueFn, instances: readonly Inst[], wires: readonly Wire[], key: Key): Record<string, number> {
  const out = (id: string): number => value(id, key) ?? 0;
  const m: Record<string, number> = {};
  for (const inst of instances) {
    const preds = wires.filter((w) => w.to[0] === inst.id);
    m[inst.id] = out(inst.id) - preds.reduce((s, w) => s + out(w.from[0]), 0);
  }
  return m;
}

/**
 * Recover each node's OWN availability from the engine's CUMULATIVE value, inverting the availability aggregation
 * (a series PRODUCT): own(n) = value(n) / Π_{p→n} value(p). The multiplicative counterpart of localContribution
 * (which inverts SUM keys — cost, latency). Content owns this domain math so the web design-doc AND the MCP
 * reliability advisor read ONE decomposition instead of each re-deriving the inverse and risking drift.
 */
export function localOwnAvailability(value: ValueFn, instances: readonly Inst[], wires: readonly Wire[]): Record<string, number> {
  const cum = (id: string): number | undefined => value(id, keys.availability);
  const m: Record<string, number> = {};
  for (const inst of instances) {
    const here = cum(inst.id);
    if (here === undefined) continue;
    const denom = wires.filter((w) => w.to[0] === inst.id).reduce((p, w) => p * (cum(w.from[0]) ?? 1), 1);
    m[inst.id] = denom > 0 ? here / denom : here;
  }
  return m;
}

/** One independent request flow: a traffic ORIGIN, the set of nodes reachable FROM it (forward, along wire
 *  direction), and its TERMINAL (the deepest reachable sink by cumulative latency) — the node whose computed
 *  values ARE the flow's end-to-end metrics. MULTI-ORIGIN is the norm (universal origins, doc: universal traffic
 *  origin): one connected component can carry SEVERAL independent flows — a CQRS write client AND a 20× read
 *  client, a full-load AND a CDC migration stream — so each origin is its OWN row, never collapsed into one. */
export interface RequestFlow {
  readonly ids: readonly string[];
  readonly source: string;
  readonly terminal: string;
}

/**
 * Partition a design into independent request flows — ONE per traffic ORIGIN, ordered by served throughput
 * (busiest first). An origin is a node that INTRODUCES traffic: a topological source (no inbound wire) OR a
 * universal origin (`assumedRps > 0` — a migration service, a connected emitter). Each origin's flow is everything
 * reachable FROM it along wire direction; its terminal is the deepest reachable sink by cumulative latency.
 *
 * This REPLACES the old one-flow-per-connected-component collapse, which hid every origin but the first — on a
 * CQRS design the entire read path (20× the write traffic, the whole point of CQRS) was absent from the roll-up
 * and the deliverable. A SINGLE-origin design is unchanged: one origin that reaches its whole component yields the
 * identical single flow (same source, terminal and member set). Shared by the web System panel and the MCP
 * roll-up, so the human and the AI read the SAME flows.
 *
 * COVERAGE: every node is carried by at least one flow. A component with no topological source and no declared
 * origin (a pure cycle) falls back to seeding a flow at its first unreached node, so nothing is silently dropped.
 */
export function requestFlows(instances: readonly Inst[], wires: readonly Wire[], value: ValueFn): RequestFlow[] {
  const parent: Record<string, string> = {};
  const find = (x: string): string => {
    while (parent[x] !== undefined && parent[x] !== x) { parent[x] = parent[parent[x] as string] as string; x = parent[x] as string; }
    return x;
  };
  for (const i of instances) parent[i.id] = i.id;
  for (const w of wires) { const a = find(w.from[0]); const b = find(w.to[0]); if (parent[a] !== undefined && parent[b] !== undefined && a !== b) parent[a] = b; }
  const hasOut = new Set(wires.map((w) => w.from[0]));
  const hasIn = new Set(wires.map((w) => w.to[0]));
  const groups = new Map<string, string[]>();
  for (const i of instances) { const r = find(i.id); const g = groups.get(r); if (g) g.push(i.id); else groups.set(r, [i.id]); }
  const lat = (id: string): number => value(id, keys.latency) ?? -1;

  // Directed adjacency for forward reachability from an origin (the flow's member set is what its traffic can reach).
  const adj = new Map<string, string[]>();
  for (const w of wires) { const a = adj.get(w.from[0]); if (a) a.push(w.to[0]); else adj.set(w.from[0], [w.to[0]]); }
  const reachFrom = (o: string): Set<string> => {
    const seen = new Set<string>([o]);
    const stack = [o];
    while (stack.length > 0) { const n = stack.pop() as string; for (const m of adj.get(n) ?? []) if (!seen.has(m)) { seen.add(m); stack.push(m); } }
    return seen;
  };
  const order = new Map(instances.map((i, idx) => [i.id, idx]));
  const byOrder = (a: string, b: string): number => (order.get(a) ?? 0) - (order.get(b) ?? 0);

  const flows: RequestFlow[] = [];
  for (const members of groups.values()) {
    const candidates = [...members].sort(byOrder); // stable: origins + member lists follow the instances order
    // ORIGINS of this component: every node that INTRODUCES traffic — a topological source, or a declared universal
    // origin (a mid-graph emitter). COVERAGE second pass: any node reachable from none of them (a pure cycle with no
    // external source) seeds its own flow, so every node stays in some flow (as the component collapse guaranteed).
    const covered = new Set<string>();
    const origins: string[] = [];
    const seed = (id: string): void => { origins.push(id); for (const r of reachFrom(id)) covered.add(r); };
    for (const id of candidates) if (!hasIn.has(id) || originatesTraffic(id, value)) seed(id);
    for (const id of candidates) if (!covered.has(id)) seed(id);
    if (origins.length === 0) seed(candidates[0] as string); // unreachable (a component is never empty) — belt-and-braces

    for (const source of origins) {
      const reach = reachFrom(source);
      const reachable = candidates.filter((id) => reach.has(id)); // instances-order member list (stable for the waterfall)
      const sinks = reachable.filter((id) => !hasOut.has(id));
      const terminal = (sinks.length > 0 ? sinks : reachable).reduce((best, id) => (lat(id) > lat(best) ? id : best));
      flows.push({ ids: reachable, source, terminal });
    }
  }
  return flows.sort((a, b) => (value(b.terminal, keys.throughput) ?? 0) - (value(a.terminal, keys.throughput) ?? 0));
}

/** End-to-end metrics of one flow, read at its terminal (the aggregation algebra already rolled them up). */
export interface FlowMetrics {
  readonly source: string;
  readonly terminal: string;
  // undefined when the metric isn't computed for this design (JSON.stringify omits it); never a guess.
  readonly throughputRps: number | undefined;
  readonly latencyMs: number | undefined;
  readonly availability: number | undefined;
  readonly costUsdMonth: number | undefined; // this flow's accumulated branch cost
}

/** The cost DEPTH a real bill has (doc-10): compute/storage + the most-missed data-transfer line, the grand
 *  total, and what a committed-pricing commitment would cost on the eligible spend. Every figure is summed
 *  from per-node OWN values (fan-in/out never double-counted). */
export interface CostBreakdown {
  readonly computeUsdMonth: number; // sum of node own `cost` (compute / storage / managed services)
  readonly egressUsdMonth: number; // sum of node own `egressCost` (internet data transfer)
  readonly totalUsdMonth: number; // compute + egress — the grand total
  readonly committableUsdMonth: number; // the part eligible for committed pricing (compute + db)
  readonly committed1yrUsdMonth: number; // grand total with a 1-yr commitment on the committable part
  readonly committed3yrUsdMonth: number; // grand total with a 3-yr commitment
}

/** The whole-design summary: each flow's end-to-end metrics, the TRUE total monthly cost (compute), and the
 *  full cost breakdown (compute + egress + committed-pricing scenarios). */
export interface SystemSummary {
  readonly flows: readonly FlowMetrics[];
  readonly totalCostUsdMonth: number; // = cost.computeUsdMonth (kept for back-compat); see `cost` for the depth
  readonly cost: CostBreakdown;
}

/** The whole-design roll-up an architect reads off a solved model: the independent request flows, the true total
 *  monthly cost and its per-component breakdown. Computed once and shared by the web System panel and MCP evaluate. */
export function systemSummary(instances: readonly Inst[], wires: readonly Wire[], value: ValueFn): SystemSummary {
  const flows = requestFlows(instances, wires, value).map((f) => ({
    source: f.source,
    terminal: f.terminal,
    throughputRps: value(f.terminal, keys.throughput),
    latencyMs: value(f.terminal, keys.latency),
    availability: value(f.terminal, keys.availability),
    costUsdMonth: value(f.terminal, keys.cost),
  }));
  const ownCost = localContribution(value, instances, wires, keys.cost);
  const ownEgress = localContribution(value, instances, wires, keys.egressCost);
  const computeUsdMonth = Object.values(ownCost).reduce((s, c) => s + c, 0);
  const egressUsdMonth = Object.values(ownEgress).reduce((s, c) => s + c, 0);
  const totalUsdMonth = computeUsdMonth + egressUsdMonth;
  const committableUsdMonth = instances.filter((i) => isCommittable(i.type)).reduce((s, i) => s + (ownCost[i.id] ?? 0), 0);
  const cost: CostBreakdown = {
    computeUsdMonth,
    egressUsdMonth,
    totalUsdMonth,
    committableUsdMonth,
    committed1yrUsdMonth: totalUsdMonth - committableUsdMonth * COMMIT_SAVING.oneYear,
    committed3yrUsdMonth: totalUsdMonth - committableUsdMonth * COMMIT_SAVING.threeYear,
  };
  return { flows, totalCostUsdMonth: computeUsdMonth, cost };
}
