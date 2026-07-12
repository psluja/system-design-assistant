import type { Graph, Registry, Verdict } from '@sda/engine-core';
import { checkTailBands, type TailProvider } from '@sda/engine-solve';
import { simulate, StationId } from '@sda/engine-sim';
import { toQueueingNetwork } from './sim';
import { checkGoodputBands } from './verdict';
import { keys } from './registry';
import type { LagProvider } from './lag-slo';
import type { NodeResponsePercentiles } from './doc-model';

// DES-FOR-THE-DOC — run the discrete-event simulation ONCE and shape its result into exactly the
// fields the design-doc input wants: the busiest-flow tail, every node's response percentiles, the retry outcome,
// and a measured lag provider. This is the SAME run the MCP `simulate` tool does (seed 7, warmup 10k, measure 50k)
// — so a doc's percentiles agree with what `simulate` reports — but packaged for the deliverable so `generate_doc`
// (MCP) and the VS Code host can EMBED measured tails/lag/goodput instead of leaving them at the honest but
// unhelpful "unknown / run the simulation". Shells with an AMBIENT sim (web, VS Code webview) already pass their
// worker's result directly and do not need this; the surfaces that had no sim result now get one cheaply.
//
// The DES clock is in SECONDS; every value here is scaled to ms so the doc renderers (which round to whole ms) read
// the same units as the scalar `responseLatency` twin. A node/pair with no recorded response reads `NaN` here and
// renders as "no data" (never a fabricated number) — the honesty the whole tool rests on.

/** The DES result reshaped for the design-doc input (all times in ms). Feed each field into `DesignDocInput`. */
export interface DocSimResult {
  /** The busiest-flow end-to-end tail (the same p50/p95/p99 the `simulate` tool returns as `tailLatencyMs`). */
  readonly tail: { readonly p50: number; readonly p95: number; readonly p99: number };
  /** Every node's OWN request→response distribution (ms), keyed by node id — the doc renderer picks the
   *  requirement-bearing ones (a latency/tailLatency band) and shows the rest to no one (no-filler). */
  readonly responsePercentilesByNode: Readonly<Record<string, NodeResponsePercentiles>>;
  /** The retry-feedback outcome from the same run (goodput/error/amplification) — the doc shows it ONLY when a
   *  retry policy is declared (buildSimulation gates on it), so a policy-free design carries a vacuous but unused row. */
  readonly retry: { readonly goodputRps: number; readonly errorRate: number; readonly amplification: number };
  /** A measured async-inclusive mean lag (ms) per declared (source, terminal) pair — resolves each lag SLO's honest
   *  scalar `unknown` into a real ok/violation (fed to `lagVerdicts` as its `LagProvider`). */
  readonly lag: LagProvider;
  /** The DES-FED verdicts (percentile/tail SLOs + retry-feedback goodput/error SLOs) the scalar pass could only read
   *  `unknown` — now measured into a real ok/violation. Merge these OVER the scalar verdicts (`mergeMeasuredVerdicts`)
   *  so the doc's Requirements table resolves a p99 SLO the sim proved, instead of leaving it "unknown" (F3). */
  readonly verdicts: readonly Verdict[];
}

/**
 * Run the DES on a solved graph and shape the result for the design-doc input. `lagPairs` are the declared lag
 * SLO endpoints to also sample (async queue waits included) — pass none for a design with no lag SLO and the run is
 * bit-for-bit the pre-lag simulation. Deterministic (fixed seed), synchronous, needs no external solver — safe to
 * call inside a synchronous doc-generation path (MCP `generate_doc`, the VS Code host command).
 */
export function simResultForDoc(graph: Graph, registry: Registry, lagPairs: readonly { readonly source: string; readonly terminal: string }[] = []): DocSimResult {
  const pairs = lagPairs.map((p) => ({ source: StationId(p.source), terminal: StationId(p.terminal) }));
  const sim = simulate(toQueueingNetwork(graph), { seed: 7, warmupCompletions: 10000, measureCompletions: 50000, ...(pairs.length > 0 ? { lagPairs: pairs } : {}) });
  const ms = (s: number): number => s * 1000; // DES clock is seconds → ms

  const responsePercentilesByNode: Record<string, NodeResponsePercentiles> = {};
  for (const n of sim.nodeResponse) {
    responsePercentilesByNode[String(n.id)] = { mean: ms(n.mean), p50: ms(n.p50), p95: ms(n.p95), p99: ms(n.p99), samples: n.samples };
  }

  const lag: LagProvider = (source, terminal) => {
    const p = sim.pairLag.find((x) => String(x.source) === source && String(x.terminal) === terminal);
    return p && Number.isFinite(p.mean) ? ms(p.mean) : undefined;
  };

  // A p99 (tail) SLO is judged against a node's OWN response tail (the DES twin of the scalar `responseLatency`),
  // from THIS run — the same seam the `simulate` tool uses. NaN (never reached) ⇒ undefined ⇒ honest `unknown`.
  const tail: TailProvider = (node, key, q) => {
    if (String(key) !== String(keys.tailLatency)) return undefined;
    const p = sim.responsePercentile(StationId(String(node)), q);
    return Number.isNaN(p) ? undefined : ms(p);
  };
  const verdicts = [...checkTailBands(graph, registry, tail), ...checkGoodputBands(graph, sim)];

  return {
    tail: { p50: ms(sim.sojournPercentile(0.5)), p95: ms(sim.sojournPercentile(0.95)), p99: ms(sim.sojournPercentile(0.99)) },
    responsePercentilesByNode,
    retry: { goodputRps: sim.goodputRps, errorRate: sim.errorRate, amplification: sim.amplification },
    lag,
    verdicts,
  };
}

/**
 * Merge DES-MEASURED verdicts OVER the scalar ones: a measured tail/goodput verdict REPLACES the scalar `unknown`
 * for the same (scope, key), so the doc's Requirements table shows the real ok/violation the sim proved — never the
 * stale "unknown / run the simulation" beside a p99 the tool already measured (F3). Any measured key not present in
 * the scalar set is appended. Order-stable for the scalar rows (the requirements table reads them in declared order).
 */
export function mergeMeasuredVerdicts(scalar: readonly Verdict[], measured: readonly Verdict[]): Verdict[] {
  if (measured.length === 0) return [...scalar];
  const keyOf = (v: Verdict): string => `${String(v.scope)}\x00${String(v.key)}`;
  const measuredByKey = new Map(measured.map((v) => [keyOf(v), v]));
  const seen = new Set<string>();
  const out: Verdict[] = scalar.map((v) => { const k = keyOf(v); seen.add(k); return measuredByKey.get(k) ?? v; });
  for (const v of measured) if (!seen.has(keyOf(v))) out.push(v);
  return out;
}
