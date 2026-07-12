// @algorithm Tier-1 analytic time-sweep (quasi-static M/M/c response + per-node peak over the auto-derived span)
// @problem A multi-cycle span is far too long to simulate arrival-by-arrival (a 90-day quarter at ~1000 rps is
//   ~1500× the 5M-event DES cap — doc: load-stages §10.1), so the ambient transient answer needs a CHEAP core.
// @approach Partition the auto-derived observation span (slowest period × spanRepeats) into windows sized to
//   resolve the fastest cycle; at each window's instantaneous rate λ(t) = Σ_origins level·Π cycles(t), override
//   each origin's reconciled assumedRps to that scalar and evaluate the STEADY-STATE response with the existing
//   analytic M/M/c twin (queueing.ts nodeQueues) — one evaluation per window (the EvaluateBatch seam is declared
//   but not yet activated, so this is the documented sequential loop; GPU batching is a later optimization). Each
//   window also folds a SELF-ORIGIN ρ (an isolated generator serving its own λ(t)); peakLoadByNode then projects
//   each node's worst window, so the per-node surfaces judge the declared PEAK, not just the steady baseline (R4).
// @complexity O(windows × evaluate) — a diurnal design at 96 pts/day over 2 days is ~192 windows, sub-second.
// @citations Quasi-static (adiabatic) approximation — a slowly-varying arrival rate ⇒ the instantaneous steady
//   state; Erlang-C / M/M/c (via queueing.ts); Datadog rollup windowing (≤~300 intervals, load-stages §16.3 A).
// @invariants Basis is 'analytic (quasi-static)' — the STEADY response per window, honest that it does NOT chain
//   backlog window-to-window (that is Tier-2's measured transient, R2). Silent (undefined) for a design with no
//   shaped generator (the no-filler rule). Deterministic.
// @where-tested content/sda/src/time-sweep.test.ts

import type { Cycle, Graph, Key, Node, NodeId } from '@sda/engine-core';
import { keys } from './registry';
import { nodeCapacityRps, nodeQueues } from './queueing';
import { applyScenarioToGraph, type EvaluateGraph, type ScenarioOverride } from './scenario';
import { generatorRate, observationSpanS, fastestPeriodS, shortestFeatureStageS, LOAD_STAGES_DEFAULTS } from './load-stages';

// THE TIER-1 SWEEP — "the sweep proposes, the DES proves", applied to time. This is the
// cheap quasi-static core: it sweeps the analytic M/M/c response across the whole observation span to find WHERE
// and HOW BADLY the design strains (the ρ envelope, the worst window, the cost integral, the %-in-violation). The
// worst window it returns is the one a targeted DES (Tier-2, R2) then zooms — the seam is `worstWindowIndex`.

/** One resolved shaped origin: the node it sits on and its generators' baseline levels + cycles. */
export interface ShapedOrigin {
  readonly nodeId: string;
  readonly gens: readonly { readonly level: number; readonly cycles: readonly Cycle[] }[];
}

/** One window of the sweep: the steady response at the instant `tStartS`, per node ρ and the whole-design cost. */
export interface TimeSweepWindow {
  /** The window's start time (seconds into the span). */
  readonly tStartS: number;
  /** ρ = offered/capacity for each station node at this window's instantaneous rate (keyed by node id). */
  readonly rhoByNode: Readonly<Record<string, number>>;
  /** requiredUnits (node-local sizing: units/tasks needed to serve this window's load) for each node that declares
   *  it, at this window's instantaneous rate. Carried ALONGSIDE `rhoByNode` (the same per-window evaluation) so the
   *  per-node peak reads a task count coherent with the peak ρ — one projection, both consumed together (R4). */
  readonly requiredUnitsByNode: Readonly<Record<string, number>>;
  /** The worst ρ anywhere in the design at this window (the envelope point). */
  readonly rhoMax: number;
  /** The whole-design cost (Σ node cost) at this window's instantaneous rate — the honest per-window bill. */
  readonly cost: number;
  /** How many nodes are saturated (ρ ≥ 1) at this window — a capacity band exceeded. */
  readonly violations: number;
}

/** The Tier-1 sweep result. Basis is `analytic (quasi-static)` — never measured dynamics. */
export interface TimeSweep {
  readonly windows: readonly TimeSweepWindow[];
  /** argmax ρ over the span — the window where cycles superimpose worst; the seam Tier-2 (R2) zooms. */
  readonly worstWindowIndex: number;
  /** The ρ envelope over time (rhoMax per window) — the utilisation film across the season. */
  readonly rhoEnvelope: readonly number[];
  /** The honest bill: the MEAN whole-design cost over the span (§7 — the mean bills, a spike barely moves it). */
  readonly costIntegral: number;
  /** The fraction of windows where a capacity band is exceeded (∈ [0, 1]). */
  readonly pctWindowsViolating: number;
  /** The auto-derived observation span (seconds) — slowest period × spanRepeats (§10.4). */
  readonly spanS: number;
  /** The window width (seconds) — sized to resolve the fastest cycle (§16.3 A). */
  readonly windowS: number;
  readonly basis: 'analytic (quasi-static)';
}

export interface TimeSweepInput {
  readonly graph: Graph;
  /** The injected forward evaluator (the sync `Evaluate` capability — DI'd exactly like the worlds loop), so
   *  content stays free of @sda/engine-solve. Applied to each window's overridden graph. */
  readonly evaluate: EvaluateGraph;
  /** Sweep resolution in points per (fastest) cycle — the LIVE ambient pass passes
   *  {@link LOAD_STAGES_DEFAULTS.livePointsPerCycle} (coarse, sub-frame); omitted ⇒ the fine at-rest
   *  {@link LOAD_STAGES_DEFAULTS.restPointsPerCycle} (§16.3 A/C, the live-vs-rest split). */
  readonly pointsPerCycle?: number;
  /** Hard cap on the window count — the LIVE pass passes {@link LOAD_STAGES_DEFAULTS.liveWindowTarget}
   *  (Datadog's ≤~300-interval budget); omitted ⇒ the fine-sweep safety cap {@link MAX_WINDOWS}. */
  readonly maxWindows?: number;
}

/** A hard safety cap on the window count so a pathological span never spins the sweep (the honest live budget is
 *  §16.3 C; the fine at-rest sweep is bounded here). Well above a diurnal×quarterly design's ~8.6k windows. */
const MAX_WINDOWS = 10_000;

/** Collect the SHAPED origins of a graph — nodes carrying a `generate` transform whose cycles are non-empty. A
 *  graph with none has no time-varying demand, so the sweep is silent (undefined) — the no-filler rule. */
export function shapedOriginsOf(graph: Graph): ShapedOrigin[] {
  const byNode = new Map<string, ShapedOrigin['gens'][number][]>();
  for (const port of graph.ports.values()) {
    const t = port.transform;
    // A `disable`d generator falls back to FLAT (its cycles are kept but ignored — doc: load-stages §7): it is not a
    // shaped origin, so an all-disabled design sweeps as silent, exactly as the DES lowering treats it (sim.ts).
    if (t?.kind !== 'generate' || t.disable === true || t.level <= 0 || t.cycles === undefined || t.cycles.length === 0) continue;
    const node = String(port.node);
    const list = byNode.get(node) ?? [];
    list.push({ level: t.level, cycles: t.cycles });
    byNode.set(node, list);
  }
  return [...byNode.entries()].map(([nodeId, gens]) => ({ nodeId, gens }));
}

/**
 * Run the Tier-1 analytic time-sweep on a design. Returns `undefined` when the design
 * declares no shaped generator (nothing varies over time — silent by design). Otherwise it auto-derives the
 * observation span and window resolution (§10.4, §16.3), and at each window overrides every shaped origin's
 * reconciled `assumedRps` to its instantaneous rate λ(t) = Σ level·Π cycles(t), evaluates the steady M/M/c
 * response, and records the ρ envelope, the worst window, the cost integral (the mean bill), and the fraction of
 * windows in violation. The basis is `analytic (quasi-static)` — honest that it reads the STEADY response per
 * window and does NOT chain a multi-hour backlog build-up (that is Tier-2's measured transient, R2).
 */
export function timeSweep(input: TimeSweepInput): TimeSweep | undefined {
  const { graph, evaluate } = input;
  const origins = shapedOriginsOf(graph);
  if (origins.length === 0) return undefined;

  const allCycles = origins.flatMap((o) => o.gens.flatMap((g) => g.cycles));
  const fullSpanS = observationSpanS(allCycles); // slowest period × spanRepeats (§16.3 B)
  const fastest = fastestPeriodS(allCycles);
  const shortestStage = shortestFeatureStageS(allCycles);
  const pointsPerCycle = input.pointsPerCycle ?? LOAD_STAGES_DEFAULTS.restPointsPerCycle;
  // The window must resolve BOTH the fastest PERIOD and the shortest STAGE feature (§16.3 A): a short spike/burst
  // inside a long period would fall between two period-spaced samples and vanish, so we also bound the window to
  // shortestFeatureStage / stagePointsFactor (≥ that many samples across the shortest ramp/hold).
  const periodWindowS = fastest / pointsPerCycle;
  const stageWindowS = shortestStage > 0 ? shortestStage / LOAD_STAGES_DEFAULTS.stagePointsFactor : Infinity;
  const idealWindowS = Math.min(periodWindowS, stageWindowS);
  const windowCap = input.maxWindows ?? MAX_WINDOWS;
  // Cap honesty (§16.3 A): the resolution-vs-cap tradeoff must never SILENTLY hide a declared feature. If the ideal
  // (fine) window over the full span would exceed the window budget, prefer a SHORTER span — fewer periods at the
  // fine resolution — over coarsening the window past the feature. So windowS holds at the ideal; the span shrinks.
  const spanS = Math.min(fullSpanS, idealWindowS * windowCap);
  const windowCount = Math.min(windowCap, Math.max(2, Math.ceil(spanS / idealWindowS)));
  const windowS = spanS / windowCount; // tile the (possibly shortened) span exactly

  const nodeCost = (value: (id: string, key: Key) => number | undefined): number => {
    let sum = 0;
    for (const id of graph.nodes.keys()) {
      const c = value(String(id), keys.cost as Key);
      if (c !== undefined && Number.isFinite(c)) sum += c;
    }
    return sum;
  };

  // Index the base nodes by id once — the SELF-ORIGIN ρ fold below reads each shaped origin's own capacity, which
  // is CONFIG (invariant under the per-window assumedRps override), so the base graph's node is the honest source.
  const nodeById = new Map<string, Node>();
  for (const n of graph.nodes.values()) nodeById.set(String(n.id), n);

  const windows: TimeSweepWindow[] = [];
  for (let i = 0; i < windowCount; i++) {
    const tCenter = (i + 0.5) * windowS; // the window's mid-instant (§5 — the scalar product read there)
    // Each shaped origin's instantaneous rate λ(t) = Σ_gens level·Π cycles(t) at this instant — computed ONCE and
    // reused for BOTH the assumedRps override (below) and the self-origin ρ fold (further below), so the two can
    // never read a different rate.
    const originRates = origins.map((o) => ({ nodeId: o.nodeId, rate: o.gens.reduce((r, g) => r + generatorRate(g.level, g.cycles, tCenter), 0) }));
    // Override each shaped origin's reconciled level to its instantaneous rate (the scenario override addresses
    // node|assumedRps — the same reconciled cell worlds/MC use, so the forward pass scales).
    const overrides: ScenarioOverride[] = originRates.map((o) => ({ node: o.nodeId, key: String(keys.assumedRps), value: o.rate }));
    const og = applyScenarioToGraph(graph, { id: `sweep-w${i}`, overrides });
    const ev = evaluate(og);
    if (ev === undefined) continue; // a window whose overlaid graph fails to build is skipped honestly
    const value = (id: string, key: Key): number | undefined => ev.value(id as unknown as NodeId, key);
    const queues = nodeQueues(og, value);
    const rhoByNode: Record<string, number> = {};
    // requiredUnits (node-local sizing) at THIS window's load — captured from the same evaluation `rhoByNode` reads,
    // so the peak task count and the peak ρ describe the SAME worst window (R4). Absent for a node that declares no
    // sizing relation (a store, a pure-delay hop): `value(requiredUnits)` is undefined there, so it never enters.
    const requiredUnitsByNode: Record<string, number> = {};
    for (const id of graph.nodes.keys()) {
      const ru = value(String(id), keys.requiredUnits as Key);
      if (ru !== undefined && Number.isFinite(ru)) requiredUnitsByNode[String(id)] = ru;
    }
    let rhoMax = 0;
    let violations = 0;
    for (const [id, q] of queues) {
      rhoByNode[id] = q.rho;
      rhoMax = Math.max(rhoMax, q.rho);
      if (q.rho >= 1) violations += 1;
    }
    // SELF-ORIGIN ρ (R4 fix — the R3 flag): `nodeQueues` SKIPS a topological source (it receives no INBOUND load),
    // so an isolated saturating GENERATOR — a node that ORIGINATES its own λ(t) and serves it — read ρ≈0 in Tier 1
    // while the Tier-2 DES (which injects the origin's arrivals AT it — sim.ts) formed a real backlog. Fold each
    // shaped origin's OWN generated load at this instant against its own capacity, so an unconnected generator reads
    // honestly. Taken as a MAX with any inbound ρ (never an over-count): the flagged case is the pure isolated
    // origin, whose inbound is 0, so there the self term IS the whole truth.
    for (const { nodeId, rate } of originRates) {
      const node = nodeById.get(nodeId);
      if (node === undefined) continue;
      const cap = nodeCapacityRps(node);
      if (!(cap > 0 && Number.isFinite(cap))) continue; // a pure-delay / capacity-less origin never queues its own load
      const selfRho = rate / cap;
      const prev = rhoByNode[nodeId] ?? 0;
      if (selfRho > prev) {
        if (prev < 1 && selfRho >= 1) violations += 1; // newly saturated by its OWN generated load
        rhoByNode[nodeId] = selfRho;
        rhoMax = Math.max(rhoMax, selfRho);
      }
    }
    windows.push({ tStartS: i * windowS, rhoByNode, requiredUnitsByNode, rhoMax, cost: nodeCost(value), violations });
  }

  const rhoEnvelope = windows.map((w) => w.rhoMax);
  let worstWindowIndex = 0;
  for (let i = 1; i < windows.length; i++) if ((windows[i] as TimeSweepWindow).rhoMax > (windows[worstWindowIndex] as TimeSweepWindow).rhoMax) worstWindowIndex = i;
  const costIntegral = windows.length === 0 ? 0 : windows.reduce((s, w) => s + w.cost, 0) / windows.length; // the mean bill (§7)
  const pctWindowsViolating = windows.length === 0 ? 0 : windows.filter((w) => w.violations > 0).length / windows.length;

  return { windows, worstWindowIndex, rhoEnvelope, costIntegral, pctWindowsViolating, spanS, windowS, basis: 'analytic (quasi-static)' };
}

/** One node's WORST-WINDOW load across a sweep: its highest ρ over the whole season, and WHEN it peaks (seconds
 *  into the span — the window's mid-instant). The per-node read the surfaces judge so the canvas answers the PEAK,
 * not only the steady baseline. */
export interface NodePeak {
  /** The node's worst ρ across every window (its own envelope point — the peak the design must survive). */
  readonly rho: number;
  /** The absolute instant (seconds into the auto-derived span) at which that worst ρ occurs. */
  readonly atS: number;
  /** The node's requiredUnits AT that worst window (the units/tasks its generation scaled to at the highest point).
   *  Undefined for a node that declares no sizing relation. The '⊞ tasks' chip reads this so it reports the PEAK
   *  task count — coherent with the peak ρ, since both come from the same worst window (ρ = requiredUnits/maxUnits). */
  readonly requiredUnits?: number;
}

/**
 * The per-node PEAK load across a Tier-1 {@link TimeSweep} — for every station node, the window where its ρ is
 * worst and the instant it happens. This is what makes the per-node surfaces (the canvas ρ chip, the Inspector
 * verdict, the System ρ rows) PEAK-AWARE: a node whose steady baseline is comfortable but whose declared peak
 * saturates it reads its worst-window ρ, not the mean. A node whose ρ never varies simply
 * peaks at its steady value — the presenter then shows no separate peak (the no-filler rule lives there, not here).
 * Pure projection of the sweep's per-window `rhoByNode`; deterministic.
 */
export function peakLoadByNode(sweep: TimeSweep): Map<string, NodePeak> {
  const out = new Map<string, NodePeak>();
  for (const w of sweep.windows) {
    const atS = w.tStartS + sweep.windowS / 2; // the window's mid-instant — the same read Tier 2 zooms
    for (const id of Object.keys(w.rhoByNode)) {
      const rho = w.rhoByNode[id] as number;
      const cur = out.get(id);
      // The requiredUnits recorded is the one from THIS worst-ρ window (both monotone in the window's load, so the
      // worst-ρ window is also the max-requiredUnits window) — one projection, ρ and task count from one instant.
      if (cur === undefined || rho > cur.rho) {
        const requiredUnits = w.requiredUnitsByNode[id];
        out.set(id, { rho, atS, ...(requiredUnits !== undefined ? { requiredUnits } : {}) });
      }
    }
  }
  return out;
}
