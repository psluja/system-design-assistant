import { exceedsCeiling, type Graph, type Key, type Status } from '@sda/engine-core';
import { lagLowerBoundMs, type NodeQueue } from './queueing';

// @feature Lag SLOs (flow-scoped propagation deadlines)
// @story Require that a change captured at the source reaches the destination within X ms — the
//   CDC/replication deadline that INCLUDES async queue waits — and read an honest ok / violation /
//   unknown back on every surface.
// @surfaces mcp (set_lag_slo / clear_lag_slo, verdicts on evaluate + simulate — app/mcp/src/tools.ts),
//   vscode (SLO/requirements hosts, app/vscode/src/slo-requirements.ts), presenter (lag rows in
//   app/presenter/src/summary.ts)
// @algorithms content/sda/src/queueing.ts (the Dijkstra scalar lower bound),
//   engine/sim/src/des.ts (measured async-inclusive lag)
// @docs none
// @e2e content/sda/src/lag-slo.e2e.test.ts
// @status shipped

// FLOW-SCOPED LAG SLOs + VERDICTS. The NUMERIC twin of the categorical
// guarantee SLO: an architect declares a per-FLOW propagation deadline — "a change captured at the source database
// reaches the destination within X ms" — and every surface reads back a computed ok / violation / unknown. Unlike a
// node latency SLO (which is judged against RESPONSE latency and CUTS at async boundaries — what a caller waits
// for), a lag SLO deliberately INCLUDES the async queue waits along the path, because the whole point of a CDC /
// replication deadline is the time a change spends queued (retention, drain).
//
// WHY a per-flow key (not a per-node band): lag is a property of a PATH (source→terminal), exactly like the
// guarantee SLO — so it is keyed by the flow's (source, terminal) node ids and serialises as plain data (two ids +
// a number). It is NOT a node `Band` (numeric, node-keyed) and NOT a categorical guarantee (a token, not a number),
// so it is its own additive container on the project doc — the third member of the SLO family.
//
// VERDICT SEMANTICS — the honest two-pass split (the tailLatency pattern). The scalar pass computes a LOWER BOUND
// on the mean lag (Σ stage response latencies on the cheapest path; the async queue's backlog wait is invisible to
// the scalar). If even that optimistic bound exceeds the ceiling ⇒ a PROVABLE violation. Otherwise the scalar
// cannot prove `ok` (it cannot see the queue wait), so it reads `unknown` and points at the sim. The DES then
// measures the true async-inclusive mean and resolves the verdict to a real ok / violation. Uncertainty is a value,
// never a guess — the same discipline as `checkTailBands`.

/** A per-FLOW propagation-lag requirement: the journey from `source` to `terminal`
 *  — INCLUDING async queue waits — must complete within `maxMs` (v1 = the MEAN lag; a percentile target is a named
 *  future extension). Plain data (two ids + a number), so it round-trips in the project doc with no Map handling. */
export interface LagSlo {
  readonly source: string;
  readonly terminal: string;
  readonly maxMs: number;
}

/** How a lag verdict was reached — so a surface never implies more certainty than it has:
 *  - `measured`: the DES measured the true async-inclusive mean lag (a real ok/violation);
 *  - `lower-bound`: the scalar lower bound alone proves a violation (even the optimistic estimate breaches);
 *  - `unknown`: the scalar cannot decide (the queue wait is invisible) — run the sim, or wire/rename the flow. */
export type LagBasis = 'measured' | 'lower-bound' | 'unknown';

/** A computed lag VERDICT for one declared requirement — the numeric, flow-keyed counterpart of the tail/guarantee
 *  verdicts. It carries BOTH the scalar lower bound (always available, on every edit) and the DES-measured mean
 *  (when a sim has run), plus the honest ok/violation/unknown and how it was reached. */
export interface LagVerdict {
  readonly source: string;
  readonly terminal: string;
  readonly maxMs: number;
  /** The scalar LOWER BOUND on the mean lag in ms (Σ stage response latencies on the cheapest path; async queue
   *  waits excluded). `Infinity` when the only path saturates; `NaN` when there is no path. */
  readonly lowerBoundMs: number;
  /** The DES-measured MEAN lag in ms (async-inclusive), when a sim ran and the pair was reached; else undefined. */
  readonly measuredMeanMs?: number;
  readonly status: Status;
  readonly basis: LagBasis;
  /** A one-line, computed explanation of the verdict / of what would resolve an `unknown` (honest, never a guess). */
  readonly note: string;
}

/** Supplies the DES-measured MEAN lag (ms) for a declared (source, terminal) pair, or undefined when no sim has run
 *  or the terminal was never reached from the source. The seam to the time engine — the caller builds one from a
 *  DES run's `pairLag`, keeping the verdict layer decoupled from the simulator (mirrors `TailProvider`). */
export type LagProvider = (source: string, terminal: string) => number | undefined;

const round = (n: number): number => (Number.isFinite(n) ? Math.round(n * 100) / 100 : n);

/** Does a design declare ANY lag requirement? (The no-filler gate — with none, the whole feature stays silent.) */
export function hasLagSlos(slos: readonly LagSlo[] | undefined): boolean {
  return slos !== undefined && slos.length > 0;
}

/**
 * Judge every declared lag requirement against the solved design (+ an optional DES lag provider) and produce a
 * {@link LagVerdict} each. Pure: derives the scalar lower bound from the graph + solved values, and reads the
 * measured mean from `lag` when supplied. THE SINGLE SHARED COMPUTATION — MCP `evaluate` (no sim ⇒ `lag` omitted ⇒
 * scalar-only), MCP `simulate` (sim ran ⇒ measured), and the presenter view-model all call THIS, so the human and
 * the AI can never read different lag verdicts (web-is-a-dumb-renderer).
 *
 * @param graph   the compiled engine graph.
 * @param value   the engine's solved value lookup `(id, key) => value`.
 * @param slos    the declared lag requirements.
 * @param queues  optional precomputed node queues (shared with the caller's other queueing reads — avoids recompute).
 * @param lag     optional DES lag provider; absent ⇒ the scalar pass alone (provable violation or honest unknown).
 */
export function lagVerdicts(
  graph: Graph,
  value: (id: string, key: Key) => number | undefined,
  slos: readonly LagSlo[],
  queues?: Map<string, NodeQueue>,
  lag?: LagProvider,
): LagVerdict[] {
  const nodeIds = new Set([...graph.nodes.keys()].map(String));
  const out: LagVerdict[] = [];

  for (const slo of slos) {
    const base = { source: slo.source, terminal: slo.terminal, maxMs: slo.maxMs };

    // A requirement whose endpoint is not a node in the design (a renamed/removed node) — honest unknown, never a
    // silent drop; the tool must not swallow a declared intent.
    if (!nodeIds.has(slo.source) || !nodeIds.has(slo.terminal)) {
      out.push({ ...base, lowerBoundMs: NaN, status: 'unknown', basis: 'unknown', note: `no flow ${slo.source} → ${slo.terminal} in this design (was a node renamed or removed?)` });
      continue;
    }

    const lowerBoundMs = lagLowerBoundMs(graph, value, slo.source, slo.terminal, queues);
    // No path ⇒ the two are not connected in this direction: honest unknown, with what would resolve it.
    if (Number.isNaN(lowerBoundMs)) {
      out.push({ ...base, lowerBoundMs: NaN, status: 'unknown', basis: 'unknown', note: `no path ${slo.source} → ${slo.terminal} — wire them so the lag can be computed` });
      continue;
    }

    const measured = lag?.(slo.source, slo.terminal);
    if (measured !== undefined && Number.isFinite(measured)) {
      // The DES measured the true async-inclusive mean — a real ok/violation (ε-tolerant on the ceiling, the shared
      // `closeEnough`: float noise at the bound is AT it, a real miss beyond ε still fails).
      const status: Status = exceedsCeiling(measured, slo.maxMs) ? 'violation' : 'ok';
      out.push({
        ...base,
        lowerBoundMs,
        measuredMeanMs: measured,
        status,
        basis: 'measured',
        note: status === 'violation'
          ? `measured mean lag ${round(measured)} ms exceeds the ${slo.maxMs} ms deadline (incl. async queue waits)`
          : `measured mean lag ${round(measured)} ms within the ${slo.maxMs} ms deadline`,
      });
      continue;
    }

    // No sim measurement. The scalar lower bound can only PROVE a violation (even the optimistic bound breaches);
    // it can never prove `ok`, because the async queue wait it omits could push the true lag over the ceiling.
    if (!Number.isFinite(lowerBoundMs) || exceedsCeiling(lowerBoundMs, slo.maxMs)) {
      out.push({
        ...base,
        lowerBoundMs,
        status: 'violation',
        basis: 'lower-bound',
        note: !Number.isFinite(lowerBoundMs)
          ? `the path ${slo.source} → ${slo.terminal} crosses a saturated tier — lag is unbounded (> ${slo.maxMs} ms)`
          : `even the queue-free lower bound ${round(lowerBoundMs)} ms exceeds the ${slo.maxMs} ms deadline`,
      });
      continue;
    }
    out.push({
      ...base,
      lowerBoundMs,
      status: 'unknown',
      basis: 'unknown',
      note: `scalar lower bound ${round(lowerBoundMs)} ms is within ${slo.maxMs} ms, but the async queue wait is invisible to the scalar — run simulate for the true lag`,
    });
  }

  return out;
}

/** Flatten a {@link LagVerdict} to the design-doc's per-flow row shape — the ONE mapping every surface uses to feed
 *  the generated document (mirrors `guaranteeVerdictRow`), so the doc and the MCP/web read one computation. */
export function lagVerdictRow(v: LagVerdict): {
  readonly source: string;
  readonly terminal: string;
  readonly maxMs: number;
  readonly lowerBoundMs: number;
  readonly measuredMeanMs?: number;
  readonly status: Status;
  readonly basis: LagBasis;
  readonly note: string;
} {
  return {
    source: v.source,
    terminal: v.terminal,
    maxMs: v.maxMs,
    lowerBoundMs: v.lowerBoundMs,
    ...(v.measuredMeanMs !== undefined ? { measuredMeanMs: v.measuredMeanMs } : {}),
    status: v.status,
    basis: v.basis,
    note: v.note,
  };
}
