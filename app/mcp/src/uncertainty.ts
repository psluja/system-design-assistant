import type { SolverBindings } from '@sda/solver-contract';
import type { Studio } from '@sda/core';
import { runUncertainty, hasRanges, MAX_SCENARIOS, DEFAULT_SCENARIOS, type UncertaintyResult } from '@sda/content';
import type { AsyncToolDef, ToolResult } from './tools';
import { fail, json, obj, READS, round, roundMs } from './tool-kit';

// ASSUMPTION UNCERTAINTY over MCP (doc: uncertainty-monte-carlo §4) — the minimal surface so the owner can TRY
// Monte Carlo before the Inspector/System UI (R3): declare ranges with set_range/clear_range (the synchronous
// command tools in tools.ts), then `uncertainty` draws N scenarios, evaluates each through the CONTRACT's
// EvaluateBatch capability (bound at the composition root — native in-process by default), and returns the §3
// shapes (per-metric percentiles + histogram, per-SLO confidence, tornado) as JSON, carrying the seed + N so any
// reader reproduces the run. Async — it awaits the batch evaluator — so it lives with the other solver-bound tools.

/** How many bins of a histogram to surface as a compact text spark-count (the full series rides in `histogram`). */
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/** Shape a Monte-Carlo result into the JSON rows the agent reads (doc §3). Numbers rounded for a human/agent; the
 *  raw distribution (percentiles, histogram) rides along so a caller can render the chart later. */
function uncertaintyView(res: UncertaintyResult): Record<string, unknown> {
  return {
      seed: res.seed,
      scenarios: res.scenarios,
      rangedInputs: res.rangedInputs.map((r) => `${r.node}.${r.key} (${r.kind})`),
      // Per metric: the board-room "median (p5–p95)" plus the spread and the histogram series (bin lo/hi + count).
      // A TIME metric (unit ms) is rendered in WHOLE ms (owner rule: no sub-ms noise in agent-facing text); cost /
      // availability keep 2-dp precision. One rounding fn chosen per metric by its unit. ZERO-VARIANCE metrics (no
      // ranged input moves them) are SUPPRESSED to `constantMetrics` — a flat histogram is not a distribution (F5).
      metrics: res.metrics
        .filter((m) => m.constant !== true)
        .map((m) => {
          const r = m.unit === 'ms' ? roundMs : round;
          return {
            metric: m.name,
            unit: m.unit,
            median: r(m.median),
            p5: r(m.p5),
            p95: r(m.p95),
            mean: r(m.mean),
            min: r(m.min),
            max: r(m.max),
            histogram: m.histogram.map((b) => ({ lo: r(b.lo), hi: r(b.hi), count: b.count })),
          };
        }),
      // Zero-variance metrics rendered HONESTLY: the single constant value + why there is no distribution (no-filler,
      // never a fake spread). Omitted entirely when every metric varies.
      constantMetrics: res.metrics
        .filter((m) => m.constant === true)
        .map((m) => ({ metric: m.name, unit: m.unit, value: (m.unit === 'ms' ? roundMs : round)(m.median), note: 'no ranged input moves this metric' })),
      // Per SLO: "% of scenarios satisfied" (the queueing-aware v2 verdict, the same one evaluate reads).
      sloConfidence: res.sloConfidence.map((s) => ({ scope: s.scope, key: s.key, satisfiedPct: round(s.satisfiedFraction * 100) })),
      // Tornado: which ranged input drives each outcome's spread (share of variance) + the sign of its influence.
      tornado: res.tornado.map((t) => ({ metric: t.metric, input: `${t.node}.${t.key}`, sharePct: round(t.share * 100), correlation: round4(t.correlation) })),
  };
}

export function buildUncertaintyTools(studio: Studio, solvers: SolverBindings): AsyncToolDef[] {
  return [
    {
      name: 'uncertainty',
      description:
        'Run MONTE CARLO over the assumptions register (doc: uncertainty-monte-carlo): draw N scenarios from the ranges declared with set_range, evaluate each, and return every conclusion as a DISTRIBUTION instead of a false-precision point. Returns per metric (cost, per-flow latency, availability) the median + p5/p95 + a histogram; per SLO the % of scenarios it holds in; and a TORNADO ranking which ranged input drives each outcome\'s spread (what to measure first). Seeded → byte-reproducible; the seed + N ride on the result. What the human sees: after you save_design a ranged design, the canvas System panel shows the Uncertainty · Monte Carlo block (median + p5–p95) live. Optional {n} (default 1000, max 10000) and {seed}. Optional {scenario}: center the cloud on a named world (assumption-model §6 — "a range is a cloud around a point"). Declare at least one range first (set_range) — with none this reports nothing to run. e.g. {n:1000, seed:7}',
      inputSchema: obj({ n: { type: 'number' }, seed: { type: 'number' }, scenario: { type: 'string', description: 'A declared named world (list_scenarios) to center the sample on; omit for the base design.' } }),
      annotations: READS,
      run: async (a): Promise<ToolResult> => {
        const proj = studio.project();
        if (!hasRanges(proj.instances)) {
          return fail('no uncertainty ranges declared — set one with set_range {node, key, lo, hi[, mode]} on a soft input (a cache-hit ratio, a service time, a traffic figure) before running Monte Carlo');
        }
        const g = studio.graph();
        if (!g.ok) return fail('design has build errors — resolve those first (evaluate to see them)');
        const evaluateBatch = solvers.evaluateBatch;
        if (evaluateBatch === undefined) return fail('this server has no batch-evaluation backend bound — uncertainty is unavailable');
        // Optional ACTIVE-WORLD center (doc §6): resolve the named world and blur the ranges around ITS point. An
        // unknown scenario is refused (naming the fix), never silently ignored — the tool must not lie about which
        // world it sampled.
        const scenarioId = a.scenario !== undefined && a.scenario !== null && String(a.scenario) !== '' ? String(a.scenario) : undefined;
        const scenario = scenarioId !== undefined ? proj.scenarios.find((s) => s.id === scenarioId) : undefined;
        if (scenarioId !== undefined && scenario === undefined) {
          return fail(`no named world "${scenarioId}" — declared worlds are [${proj.scenarios.map((s) => s.id).join(', ') || 'none'}]; declare one with declare_scenario (or derive_scenarios), or omit {scenario} to sample the base design`);
        }
        // Honest bounds on the run knobs (the same clamp runUncertainty applies, surfaced so the agent sees what it got).
        const n = a.n !== undefined && Number.isFinite(Number(a.n)) ? Math.max(1, Math.min(MAX_SCENARIOS, Math.floor(Number(a.n)))) : DEFAULT_SCENARIOS;
        const seed = a.seed !== undefined && Number.isFinite(Number(a.seed)) ? Math.floor(Number(a.seed)) : undefined;
        const res = await runUncertainty({ graph: g.value, instances: proj.instances, wires: proj.wires, n, ...(seed !== undefined ? { seed } : {}), ...(scenario !== undefined ? { scenario } : {}) }, evaluateBatch);
        return json(uncertaintyView(res));
      },
    },
  ];
}
