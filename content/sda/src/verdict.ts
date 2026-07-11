import { NodeId, Unit, exceedsCeiling, belowFloor, type Band, type CauseLink, type Graph, type Key, type Remediation, type Status, type Verdict } from '@sda/engine-core';
import { keys } from './registry';
import { nodeQueues, responseLatency, type NodeQueue } from './queueing';
import type { NodePeak } from './time-sweep';

// @feature Response percentiles & real-aware verdicts
// @story Set a mean or p99 latency SLO: the scalar pass judges against REAL (queueing-aware)
//   response latency with explicit saturation violations, honestly answers `unknown` for tails, and
//   the DES then measures every node's percentiles and turns them into real verdicts.
// @surfaces mcp (simulate, app/mcp/src/simulate.ts), web (latency chips + sim worker,
//   app/web/src/sim-worker.ts), vscode (Test-Explorer SLO verdicts, app/vscode/src/slo-tests.ts),
//   presenter (app/presenter/src/latency.ts, app/presenter/src/sim-verdicts.ts)
// @algorithms content/sda/src/queueing.ts, engine/sim/src/des.ts, engine/sim/src/stats.ts
// @docs docs/design/latency-semantics-v2.html
// @e2e content/sda/src/tail.e2e.test.ts, content/sda/src/response-latency.e2e.test.ts,
//   app/web/src/latency-chips.e2e.test.ts
// @status shipped

// REAL-AWARE VERDICTS — the queueing-aware correction the engine cannot make on its own. The engine
// (domain-agnostic) verdicts a latency SLO against the IDEAL cumulative latency (Σ service times), which stays
// finite even when a tier is saturated; and it only flags a drop via the overflow band (offered − capacity),
// which is exactly 0 at the ρ=1 knife-edge while the real wait is already unbounded. So the same design can read
// "Latency 71 ms · ok" on one surface and "∞ · ✗" on another. This module recomputes the latency verdict against
// the REAL (M/M/c) latency and raises an explicit saturation violation for every ρ≥1 tier — the ONE verdict list
// every surface (Inspector, header badge, System panel, design doc, MCP) consumes, so they can never disagree.
//
// LATENCY SEMANTICS v2 (doc: latency-semantics-v2 §3, §7 R2). A node's latency SLO is judged against its RESPONSE
// latency — its own queued sojourn PLUS the responses of everything it SYNCHRONOUSLY calls (an async hop cuts the
// wait) — the exact number the node card shows (`responseLatency`, doc-15). It is NO LONGER the source→node
// accumulation (`realCumulativeLatency`), which anchored the SLO to a quantity the requirement never named
// (accumulated from WHICH origin, under universal fan-in?) and disagreed with the card. This re-read is usually
// MORE generous — response (own + downstream) is typically smaller than accumulation-from-origin, which dragged in
// every upstream hop — so it can flip a red mid-path node green; that is a correctness fix, stated plainly.
// End-to-end is unchanged: the response latency of an entry node IS the whole synchronous journey.

const MS = Unit('ms');

const isLatency = (k: Key): boolean => String(k) === String(keys.latency);
const isScalarLatencyBand = (b: Band): boolean => b.shape === 'minTargetMax';

/** Like the engine's statusForBand, but a non-finite (saturated, ρ≥1) latency is a hard VIOLATION — an
 *  unbounded queue is the worst breach, never 'unknown'. With no band, a finite real latency is ok. Every bound
 *  comparison is ε-tolerant (the shared `closeEnough`, doc: latency-semantics-v2 §5): a response latency within
 *  float noise of the bound is AT it (the owner's live 200.00000001 vs 200 reads ok), while a real miss beyond ε
 *  still fails honestly — a boundary tolerance, never a slack budget. */
function latencyStatus(v: number, band: Band | undefined): Status {
  if (!Number.isFinite(v)) return 'violation';
  if (band !== undefined && band.shape === 'minTargetMax') {
    if (band.max !== undefined && exceedsCeiling(v, band.max)) return 'violation';
    if (band.min !== undefined && belowFloor(v, band.min)) return 'violation';
    if (band.target !== undefined && belowFloor(v, band.target)) return 'warning';
  }
  return 'ok';
}

/** The scopes of every node carrying a SCALAR (mean) latency SLO — the verdicts the engine produced against the
 *  ideal value, which we replace with real ones. Percentile (tail) latency bands are left to the DES path. */
function scalarLatencyBandScopes(graph: Graph): Map<string, Band> {
  const out = new Map<string, Band>();
  for (const node of graph.nodes.values()) {
    for (const cell of node.cells) {
      if (cell.kind !== 'input' || cell.value.kind !== 'band') continue;
      if (isLatency(cell.key) && isScalarLatencyBand(cell.value.band)) out.set(String(node.id), cell.value.band);
    }
  }
  return out;
}

/**
 * Correct an engine verdict list to be queueing-aware, judged against the WORST load the declared environment
 * produces. Returns a NEW list where:
 *  1. every SCALAR latency verdict is recomputed against the node's REAL RESPONSE latency (own queued sojourn +
 *     synchronous downstream subtree; async cut; ∞ at saturation) — the number the node card shows (v2 §3);
 *  2. each saturated tier that the overflow band did not already flag gets an explicit latency violation (the ρ=1
 *     knife-edge: overflow=0 but the wait is unbounded);
 *  3. all other verdicts (throughput, availability, cost, overflow, tail percentiles) pass through unchanged.
 *
 * WORST-CASE LOAD (owner ruling: a peak is just traffic in a given environment). When a shaped generator
 * (load-stages) makes a node's worst window heavier than its steady baseline, `peak` carries the sweep's per-node
 * worst-window ρ (`peakLoadByNode`), and a node is judged saturated if its steady ρ≥1 OR its worst-window ρ≥1. A
 * worst-window saturation is the SAME saturation violation as a steady one — there is NO separate 'peak' basis, no
 * clock instant, no dual 'steady vs peak' verdict. The node is simply judged against its worst load, so a node calm
 * at the mean but saturated at its declared peak fails here — the ONE verdict list MCP, the design doc, the worlds
 * matrix and the canvas all read, so none can report steady-green while the canvas shows the tier red.
 *
 * SACRED PIN: with no shaped generator (`peak` undefined / no worst-window ρ≥1 beyond the steady set) the result is
 * BYTE-IDENTICAL to the steady list — property-pinned at this layer. Pure: derives everything from the graph +
 * solved values + the sweep's per-node peak, no clock/randomness.
 */
export function realAwareVerdicts(
  base: readonly Verdict[],
  graph: Graph,
  value: (id: string, key: Key) => number | undefined,
  queues?: Map<string, NodeQueue>,
  peak?: ReadonlyMap<string, NodePeak>,
): Verdict[] {
  const q = queues ?? nodeQueues(graph, value);
  // v2: judge each node's SLO against its RESPONSE latency (own + sync downstream), NOT the source→node
  // accumulation. `responseLatency` is the exact quantity the card renders (doc-15), so what is judged equals
  // what is shown. `realCumulativeLatency` is retained (queueing.ts) for the end-to-end cumulative displays that
  // still want it (the design doc's realLatencyByNode row, the load sweep) — it simply no longer JUDGES a node.
  const responses = responseLatency(graph, value, q);
  const bandScopes = scalarLatencyBandScopes(graph);

  // Keep every engine verdict EXCEPT the ideal scalar-latency ones we are about to replace.
  const kept = base.filter((v) => !(isLatency(v.key) && bandScopes.has(String(v.scope))));

  // The tiers saturated at the WORST load the environment produces: a node whose STEADY ρ≥1, plus — when a shaped
  // generator makes a window heavier than the steady baseline — a node whose WORST-WINDOW ρ≥1 (the sweep's
  // `peakLoadByNode`, folded in as an equal saturation, no 'peak' distinction). With no shape (`peak` undefined)
  // this is EXACTLY the steady set, in the steady order, so every verdict below is byte-identical (the sacred pin).
  // An isolated saturating origin — absent from `q` (a source receives no inbound load) but caught by the sweep's
  // self-origin ρ — enters here through `peak`, so it too reads red (never a node that vanishes from the truth).
  const steadySaturated = [...q.entries()].filter(([, nq]) => nq.rho >= 1).map(([id]) => id);
  const saturatedSet = new Set(steadySaturated);
  if (peak !== undefined) for (const [id, p] of peak) if (p.rho >= 1) saturatedSet.add(id);
  const saturated = [...saturatedSet];
  const saturationCause = (scopeId: string): { cause: CauseLink[]; remediations: Remediation[] } => {
    const culprits = saturated.length > 0 ? saturated : [scopeId];
    const cause: CauseLink[] = culprits.map((id) => ({
      scope: nodeIdOf(graph, id),
      key: keys.latency,
      note: `ρ ≥ 1 at ${id}: the queue grows without bound — real latency is unbounded (timeouts)`,
    }));
    return {
      cause,
      remediations: [{ action: `Add capacity at ${culprits[0]} (raise concurrency / throughput, or scale out) to bring ρ below 1`, rank: 1 }],
    };
  };

  const out: Verdict[] = [...kept];

  // 1 + 2: a response-latency verdict per declared scalar-latency SLO (v2 §3 — the number on the card). A node
  // saturated at its worst load (steady OR worst-window) has an unbounded response THERE, so it is judged ∞ — a
  // node green at the mean but saturated at its declared peak fails, never a false green. For a steady-saturated
  // node `responses.get` is already ∞, so forcing ∞ leaves the no-shape case byte-identical.
  for (const [scope, band] of bandScopes) {
    const real = saturatedSet.has(scope) ? Number.POSITIVE_INFINITY : (responses.get(scope) ?? Number.NaN);
    const status = latencyStatus(real, band);
    const enrich = status === 'violation' || status === 'warning' ? saturationCause(scope) : { cause: [], remediations: [] };
    out.push({ key: keys.latency, scope: nodeIdOf(graph, scope), computed: { value: real, unit: MS }, status, ...enrich });
  }

  // 3: saturation violations for ρ≥1 tiers WITHOUT a latency SLO already covering them (so the header badge,
  // the doc bottleneck section and the node verdict all see the knife-edge, even with no SLO set).
  const overflowViolation = new Set(
    base.filter((v) => String(v.key) === String(keys.overflow) && (v.status === 'violation' || v.status === 'warning')).map((v) => String(v.scope)),
  );
  for (const id of saturated) {
    if (bandScopes.has(id) || overflowViolation.has(id)) continue; // already surfaced as a latency or overflow breach
    const enrich = saturationCause(id);
    out.push({ key: keys.latency, scope: nodeIdOf(graph, id), computed: { value: Number.POSITIVE_INFINITY, unit: MS }, status: 'violation', ...enrich });
  }

  return out;
}

/** Recover the branded NodeId for a string id from the graph (verdict scopes are NodeId, not bare strings). */
function nodeIdOf(graph: Graph, id: string): Verdict['scope'] {
  for (const nid of graph.nodes.keys()) if (String(nid) === id) return nid;
  return NodeId(id); // not in the graph (a defensive fallback): recover it as a node-scoped id via the smart constructor
}

// -------------------- DES-FED OUTCOME verdicts (goodput / error rate) — the retry-feedback path --------------------

const RPS = Unit('req/s');

/** The whole-system outcome the DES measured (doc: retry-feedback §3). These are SYSTEM metrics — the useful work
 *  the design delivers and the failures it sheds — so a `goodputRps` / `errorRate` SLO on any node is judged
 *  against them. Undefined ⇒ no simulation has run yet, so the bands stay `unknown` (pointing at simulate). */
export interface SimOutcome {
  readonly goodputRps: number;
  readonly errorRate: number;
}

/**
 * Turn `goodputRps` / `errorRate` SLO bands into honest verdicts from a DES run — the retry-feedback twin of
 * {@link checkTailBands}. A throughput floor on a RETRYING path belongs on `goodputRps` (successful work), not
 * raw completions, and an `errorRate` ceiling caps the failures a retry storm produces. Both are `minTargetMax`:
 * goodput a FLOOR (min/target — below it is a breach), errorRate a CEILING (max — above it is a breach). Off the
 * scalar pass these keys carry no value and read `unknown`; here the sim answers them. `sim === undefined`
 * (no run yet) ⇒ every such band stays `unknown`, never a guess. Pure: derives only from the graph + the run.
 */
export function checkGoodputBands(graph: Graph, sim: SimOutcome | undefined): Verdict[] {
  const isGoodput = (k: Key): boolean => String(k) === String(keys.goodputRps);
  const isErrorRate = (k: Key): boolean => String(k) === String(keys.errorRate);
  const out: Verdict[] = [];
  for (const node of graph.nodes.values()) {
    for (const cell of node.cells) {
      if (cell.kind !== 'input' || cell.value.kind !== 'band' || cell.value.band.shape !== 'minTargetMax') continue;
      const goodput = isGoodput(cell.key);
      if (!goodput && !isErrorRate(cell.key)) continue;
      const band = cell.value.band;
      if (sim === undefined) {
        // No simulation has run: the outcome is genuinely unknown — surface the SLO, point at the sim.
        out.push({ key: cell.key, scope: node.id, computed: { value: NaN, unit: RPS }, status: 'unknown', cause: [], remediations: [] });
        continue;
      }
      const value = goodput ? sim.goodputRps : sim.errorRate;
      const status = statusForRate(value, band);
      const remediations: Remediation[] =
        status === 'violation' || status === 'warning'
          ? [
              {
                action: goodput
                  ? `Goodput ${value.toFixed(1)} req/s is below the SLO at ${node.id}: past saturation retries LOWER goodput — add capacity at the bottleneck or shed load`
                  : `Error rate ${value.toFixed(1)} req/s exceeds the SLO at ${node.id}: the retry storm is failing requests — add capacity or relax the retry policy`,
                rank: 1,
              },
            ]
          : [];
      out.push({ key: cell.key, scope: node.id, computed: { value, unit: RPS }, status, cause: [], remediations });
    }
  }
  return out;
}

/** minTargetMax status for a rate: above `max` or below `min` is a violation; below `target` a warning; else ok.
 *  ε-tolerant on every bound (shared `closeEnough`, doc: latency-semantics-v2 §5) so summed-rate float noise never
 *  flips a verdict, while a real breach beyond ε still fails. */
function statusForRate(v: number, band: Band): Status {
  if (band.shape !== 'minTargetMax') return 'ok';
  if (band.max !== undefined && exceedsCeiling(v, band.max)) return 'violation';
  if (band.min !== undefined && belowFloor(v, band.min)) return 'violation';
  if (band.target !== undefined && belowFloor(v, band.target)) return 'warning';
  return 'ok';
}
