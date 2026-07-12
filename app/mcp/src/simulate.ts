import { NodeId, type Key, type Registry } from '@sda/engine-core';
import type { Studio } from '@sda/core';
import {
  toQueueingNetwork,
  keys,
  checkGoodputBands,
  lagVerdicts,
  twoTierEvaluation,
  TAIL_SIM_OPTIONS,
  type EvaluateGraph,
  type LagProvider,
} from '@sda/content';
import { simulate, StationId } from '@sda/engine-sim';
import { checkTailBands, evaluate, type TailProvider } from '@sda/engine-solve';
import type { ToolDef } from './tools';
import { fail, json, obj, READS, round, roundMs } from './tool-kit';

// The TIME engine as an MCP tool. The scalar forward pass cannot judge a tail, so a percentile
// (p99) SLO is `unknown` there; this runs the discrete-event simulation and turns that `unknown` into a real
// ok/violation. LATENCY SEMANTICS v2 (doc §4): one DES run yields EVERY node's RESPONSE tail (a node's view is a
// suffix of the same journeys), so a percentile SLO is honest on ANY node — its OWN synchronous-subtree response
// tail — not only a terminal. A node with no recorded response (never reached, or dropped) reads `unknown`, never
// a guess. Sync (the DES is deterministic for a fixed seed); needs no external solver.

export function buildSimTools(studio: Studio, registry: Registry): ToolDef[] {
  return [
    {
      name: 'simulate',
      description:
        'Run the discrete-event simulation — the TRUE tail the scalar `evaluate` cannot see. Returns end-to-end p50/p95/p99 latency, per-tier saturation (utilization + drops), goodput/error-rate/amplification, and a VERDICT for every percentile (p99) SLO, turning a tail SLO from `unknown` into a real ok/violation. A tier\'s p99 comes from its M/M/c queueing station — `concurrency`×fleet servers for a store/service, or a `connectionPool` for a pooling proxy (past which the borrow timeout reneges as drops + errorRate); raise the right knob (see CAPABILITIES in the instructions) to lower the tail. Set the tail SLO first with set_slo {node, key:"tailLatency", percentiles:{"p99":300}} on the TERMINAL node of the request path — it is INDEPENDENT of a mean-latency SLO (key:"latency"), so you can set both. FLOW-SCOPED LAG: any deadline set with set_lag_slo (a CDC/replication "reaches the destination within X ms") is RESOLVED here — the run measures the true async-inclusive mean lag and returns a real ok/violation in `lagVerdicts` (the scalar `evaluate` could only prove a violation, never `ok`, since the queue wait is invisible to it). RETRY POLICIES: set timeoutMs/retryCount(/retryBackoffMs) on the CALLER node; simulate then shows goodputRps (successful work), errorRate and amplification (attempts ÷ arrivals) — and PAST SATURATION retries LOWER goodput (congestion collapse), never raise it. LOAD STAGES: when a generator declares periodic `cycles` (set_transform {kind:"generate", level, cycles}), the SAME read also returns `loadStages` — the two-tier transient over the auto-derived season: the ρ-envelope over time, the WORST window, the honest mean bill and %-of-span over capacity (Tier-1 analytic), plus the survival verdict PROVEN at that worst window (Tier-2 measured). Absent for a flat design. e.g. {}',
      inputSchema: obj({}),
      annotations: READS,
      run: () => {
        // MULTI-CLASS DES — the honest decline. The simulator routes over the class-BLIND
        // edge graph; under declared classes that graph can be CYCLIC (the each-to-each mesh) and, even when acyclic,
        // a single-river run ignores the per-class origins/routes — a wrong tail, not the per-class truth. Per-class
        // routing + (node,class) reservoirs are a later slice; until then `simulate` declines rather than mislead.
        // The forward `evaluate` (per class) stays available for the scalar per-class picture.
        if (studio.project().requestClasses.length > 0)
          return fail(
            'per-class simulation is not yet available — request classes need per-class routing and (node,class) response reservoirs in the DES. Use evaluate for the per-class scalar picture, or remove the request classes to simulate the single-river design.',
          );
        const g = studio.graph();
        if (!g.ok) return fail('design has build errors — resolve those first');

        // FLOW-SCOPED LAG: declare the pairs to measure so the ONE run also samples
        // each declared source→terminal journey (async queue waits INCLUDED). Bounded to declared pairs; an
        // undeclared design passes none and the run is bit-for-bit the pre-lag simulation.
        const proj = studio.project();
        const lagPairs = proj.lagSlos.map((s) => ({ source: StationId(s.source), terminal: StationId(s.terminal) }));
        // The DES run config is the SHARED `TAIL_SIM_OPTIONS` (content/doc-sim) — the SAME seed/warm-up/window the
        // design-doc's embedded tail uses, so this tool and the deliverable can never report a different p99 for the
        // same design (single-truth). The seed is surfaced in the result (below) so the measured latency reads as
        // "measured with seed N"; the run is deterministic for a fixed seed.
        const { seed } = TAIL_SIM_OPTIONS;
        const sim = simulate(toQueueingNetwork(g.value), { ...TAIL_SIM_OPTIONS, ...(lagPairs.length > 0 ? { lagPairs } : {}) });
        const ms = (q: number): number => sim.sojournPercentile(q) * 1000; // s → ms
        // v2 (doc §4): a p99 (tail) SLO on keys.tailLatency is judged against the node's OWN response tail, from
        // the SAME run — `responsePercentile(node,q)` is the DES twin of the scalar `responseLatency`. The DES
        // clock is in seconds, so scale to ms; NaN (no recorded response) ⇒ undefined ⇒ honest `unknown`. tailLatency
        // is a SEPARATE key from the mean `latency`, so a design can carry both at once.
        const tail: TailProvider = (node, key, q) => {
          if (String(key) !== String(keys.tailLatency)) return undefined;
          const p = sim.responsePercentile(StationId(String(node)), q);
          return Number.isNaN(p) ? undefined : p * 1000; // s → ms
        };

        // Tail (percentile) SLOs AND retry-feedback outcome SLOs (goodputRps / errorRate) are both DES-fed: merge
        // the two verdict lists. Off the scalar pass these keys read `unknown`; here the run answers them.
        const verdicts = [...checkTailBands(g.value, registry, tail), ...checkGoodputBands(g.value, sim)].map((v) => ({
          scope: v.scope,
          key: v.key,
          status: v.status,
          value: round(v.computed.value),
          unit: v.computed.unit,
          fix: v.remediations[0]?.action,
        }));

        // Per-flow LAG verdicts, now RESOLVED by the run: the DES measured the true
        // async-inclusive mean lag for every declared pair, turning the scalar `unknown` into a real ok/violation —
        // the SAME shared `lagVerdicts` computation the `evaluate` path uses, here fed the measured means. Uses the
        // solved value for the scalar lower bound the row also reports (and for the queue model); omitted when none.
        const ev = studio.evaluate();
        const value = (id: string, k: Key): number | undefined => (ev.ok ? ev.value.value(NodeId(id), k) : undefined);
        const lag: LagProvider = (s, t) => {
          const p = sim.pairLag.find((x) => String(x.source) === s && String(x.terminal) === t);
          return p && Number.isFinite(p.mean) ? p.mean * 1000 : undefined; // s → ms
        };
        const lagRows = proj.lagSlos.length > 0
          ? lagVerdicts(g.value, value, proj.lagSlos, undefined, lag).map((v) => ({
              scope: `${v.source} → ${v.terminal}`,
              maxMs: v.maxMs,
              status: v.status,
              basis: v.basis,
              ...(v.measuredMeanMs !== undefined ? { measuredMeanMs: roundMs(v.measuredMeanMs) } : {}),
              ...(Number.isFinite(v.lowerBoundMs) ? { lowerBoundMs: roundMs(v.lowerBoundMs) } : {}),
              note: v.note,
            }))
          : undefined;

        // LOAD STAGES — the ambient two-tier transient: when a generator declares periodic
        // cycles, the SAME `simulate` read also returns the ρ-envelope over the auto-derived season, the worst
        // window, the honest mean bill and %-in-violation (Tier-1 analytic), plus — proven at the worst window — the
        // survival verdict (Tier-2 measured). Silent for a flat design (no cycles ⇒ no section — the no-filler rule).
        // The forward evaluator is the sync scalar `evaluate` (no external solver), DI'd exactly as the worlds loop.
        const evalDI: EvaluateGraph = (gr) => { const r = evaluate(gr, registry); return r.ok ? r.value : undefined; };
        const twoTier = twoTierEvaluation({ graph: g.value, evaluate: evalDI });
        const loadStages = twoTier === undefined ? undefined : loadStagesReadout(twoTier);

        return json(
            {
              // The seed the tail was measured with — deterministic, so a re-run reproduces these percentiles exactly.
              seed,
              tailLatencyMs: { p50: roundMs(ms(0.5)), p95: roundMs(ms(0.95)), p99: roundMs(ms(0.99)), mean: roundMs(sim.meanSojourn * 1000) },
              saturation: sim.stations.map((s) => ({ id: s.id, utilization: round(s.utilization), dropped: s.dropped })),
              // Retry-feedback outcome accounting. Without a retry policy these degenerate to
              // the pre-retry world: goodputRps === completion rate, errorRate 0, amplification 1.
              goodputRps: round(sim.goodputRps),
              errorRate: round(sim.errorRate),
              amplification: round(sim.amplification),
              verdicts,
              // The async-inclusive lag each declared replication/CDC deadline (set_lag_slo) achieves — MEASURED here.
              ...(lagRows !== undefined ? { lagVerdicts: lagRows } : {}),
              // The two-tier transient over the design's declared cycles (absent for a flat design).
              ...(loadStages !== undefined ? { loadStages } : {}),
            },
        );
      },
    },
  ];
}

/**
 * Shape the two-tier transient into the guided JSON `simulate` returns under `loadStages`.
 * Tier 1 (analytic): a compact ρ-film across the season (≤24 points), the peak ρ, the WORST window (its instant, ρ
 * and the node that peaked), the honest mean bill and the fraction of the span over capacity. Tier 2 (measured,
 * present once the DES has run): the survival verdict at that worst window + budget honesty. Both bases labelled —
 * whole-ms tails, whole-second phase times — so the AI and the human read one honest answer, never a blur.
 */
function loadStagesReadout(twoTier: NonNullable<ReturnType<typeof twoTierEvaluation>>): Record<string, unknown> {
  const t1 = twoTier.tier1;
  const worst = t1.windows[t1.worstWindowIndex];
  const worstNode = worst ? Object.entries(worst.rhoByNode).reduce((mx, [id, r]) => (r > mx.r ? { id, r } : mx), { id: '', r: -1 }).id : '';
  const peakRho = t1.rhoEnvelope.length > 0 ? Math.max(...t1.rhoEnvelope) : 0;
  const step = Math.max(1, Math.ceil(t1.rhoEnvelope.length / 24)); // a compact ρ film (≤24 points across the span)
  const t2 = twoTier.tier2;
  return {
    basis: { tier1: t1.basis, ...(t2 !== undefined ? { tier2: t2.verdict.basis } : {}) },
    spanS: round(t1.spanS),
    windowS: round(t1.windowS),
    rhoEnvelope: t1.rhoEnvelope.filter((_, i) => i % step === 0).map((r) => round(r)),
    peakRho: round(peakRho),
    worstWindow: { atS: worst ? round(worst.tStartS + t1.windowS / 2) : 0, rho: round(peakRho), node: worstNode },
    costMeanUsdMonth: round(t1.costIntegral),
    pctWindowsViolating: round(t1.pctWindowsViolating),
    ...(t2 !== undefined
      ? {
          transient: {
            verdict: {
              survives: t2.verdict.survives,
              recoversInS: t2.verdict.recoversInS !== null ? round(t2.verdict.recoversInS) : null,
              peakBacklog: t2.verdict.peakBacklog !== null ? { ...t2.verdict.peakBacklog, atS: round(t2.verdict.peakBacklog.atS) } : null,
              p99DuringMs: roundMs(t2.verdict.p99DuringMs),
              p99AfterMs: roundMs(t2.verdict.p99AfterMs),
              lostRequests: t2.verdict.lostRequests,
              amplificationPeak: round(t2.verdict.amplificationPeak),
              note: t2.verdict.note,
              basis: t2.verdict.basis,
            },
            budget: t2.budget,
          },
        }
      : {}),
  };
}
