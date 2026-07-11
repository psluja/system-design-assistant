import { describe, expect, it } from 'vitest';
import { evaluate } from '@sda/engine-solve';
import {
  allManifests,
  instantiate,
  LOAD_STAGES_PRESETS,
  registry,
  twoTierEvaluation,
  TRANSIENT_BASIS,
  type EvaluateGraph,
  type Instance,
  type Wire,
} from './index';

// THE TWO-TIER EVALUATION e2e (doc: load-stages §10) — the ambient answer on REAL content: a diurnal generator
// feeding a capacity-limited tier is evaluated over its auto-derived season in two labelled tiers. Tier 1 (the
// analytic sweep) proposes the worst window (the diurnal peak); Tier 2 (the targeted DES) proves the true backlog
// and drain there. These pin: the composition shape ({tier1, tier2}); Tier 2 measures at the worst window with the
// re-homed survival verdict + basis 'measured (transient)'; a design that overloads at its peak reads "does not
// recover" honestly while one with peak headroom survives; determinism; and the no-shaped-generator silence.

/** The injected forward evaluator — the sync Evaluate capability, exactly as the worlds loop is wired. */
const evalDI: EvaluateGraph = (graph) => {
  const r = evaluate(graph, registry);
  return r.ok ? r.value : undefined;
};

/** A diurnal-shaped origin (peak ×1.8) feeding a bottleneck `svc` whose capacity `level·1.8` may or may not
 *  exceed. `svc` = concurrency `c` · 100 ms ⇒ capacity 10·c req/s. */
function diurnal(level: number, svcConcurrency: number): Instance[] {
  return [
    { id: 'src', type: 'compute.service', transforms: { out: { kind: 'generate', level, cycles: LOAD_STAGES_PRESETS.diurnal } }, config: { concurrency: 100000 } },
    { id: 'svc', type: 'compute.service', config: { concurrency: svcConcurrency, perRequestDuration: 100, latency: 100 } },
    { id: 'db', type: 'compute.service', config: { concurrency: 100000, perRequestDuration: 2, latency: 2 } },
  ];
}
const WIRES: Wire[] = [{ from: ['src', 'out'], to: ['svc', 'in'] }, { from: ['svc', 'out'], to: ['db', 'in'] }];

/** Keep the Tier-2 neighbourhood small so the DES runs fast in a unit test — it also SIZES the window. */
const TEST_EVENTS = 200_000;

function run(level: number, svcConcurrency: number) {
  const g = instantiate(allManifests, diurnal(level, svcConcurrency), WIRES);
  if (!g.ok) throw new Error(JSON.stringify(g.error));
  const r = twoTierEvaluation({ graph: g.value, evaluate: evalDI, maxEvents: TEST_EVENTS });
  if (r === undefined) throw new Error('expected a two-tier result for a shaped design');
  return r;
}

describe('twoTierEvaluation — Tier 1 proposes, Tier 2 proves, over a diurnal season', () => {
  it('composes {tier1, tier2}: the sweep spans two days, Tier 2 measures at the worst window, both bases labelled', () => {
    const r = run(400, 100); // peak 720 into 1000-cap svc ⇒ ρ 0.72, headroom
    expect(r.tier1.basis).toBe('analytic (quasi-static)');
    expect(r.tier1.spanS).toBe(86_400 * 2);
    expect(r.tier2).toBeDefined();
    if (r.tier2 === undefined) return;
    expect(r.tier2.verdict.basis).toBe(TRANSIENT_BASIS);
    // Tier 2 zoomed the window Tier 1 flagged: its worst instant is the sweep's worst window mid-instant.
    const worstWindow = r.tier1.windows[r.tier1.worstWindowIndex]!;
    expect(r.tier2.worst.atS).toBeCloseTo(worstWindow.tStartS + r.tier1.windowS / 2, 6);
    expect(r.tier2.worst.node).toBe('svc'); // the bottleneck is where ρ peaks
    // The full survival-verdict form is present and honest.
    expect(typeof r.tier2.verdict.survives).toBe('boolean');
    expect(r.tier2.verdict.note.length).toBeGreaterThan(0);
    expect(r.tier2.budget.estimatedEvents).toBeGreaterThan(0);
  });

  it('a design with PEAK HEADROOM survives the worst window (ρ<1 there, the queue stays bounded)', () => {
    const r = run(400, 100); // ρ_peak 0.72
    expect(r.tier2).toBeDefined();
    if (r.tier2 === undefined) return;
    expect(r.tier1.rhoEnvelope[r.tier1.worstWindowIndex]!).toBeLessThan(1);
    expect(r.tier2.verdict.survives).toBe(true);
    // A diurnal peak is a broad plateau: the cap-bounded neighbourhood sees constant sub-capacity load, so the
    // honest verdict is "bounded queue at the peak" (it may or may not clock a discrete recovery instant).
    expect(r.tier2.verdict.note).toMatch(/recovers within|holds through the busy period/);
  });

  it('a design that OVERLOADS at its peak reads "does not recover" honestly, backlog piled at the bottleneck', () => {
    const r = run(160, 10); // peak 288 into 100-cap svc ⇒ ρ 2.88, sustained overload across the plateau
    expect(r.tier1.rhoEnvelope[r.tier1.worstWindowIndex]!).toBeGreaterThan(1);
    expect(r.tier1.pctWindowsViolating).toBeGreaterThan(0);
    expect(r.tier2).toBeDefined();
    if (r.tier2 === undefined) return;
    expect(r.tier2.verdict.survives).toBe(false);
    expect(r.tier2.verdict.note).toContain('does not recover');
    expect(r.tier2.verdict.peakBacklog).not.toBeNull();
    expect((r.tier2.verdict.peakBacklog as { node: string }).node).toBe('svc');
  });

  it('is deterministic: the same design + seed reproduces the verdict', () => {
    const a = run(400, 100);
    const b = run(400, 100);
    expect(JSON.stringify(a.tier2?.verdict)).toBe(JSON.stringify(b.tier2?.verdict));
  });

  it('is SILENT (undefined) for a design with no shaped generator (the no-filler rule)', () => {
    const g = instantiate(allManifests, [
      { id: 'src', type: 'compute.service', transforms: { out: { kind: 'generate', level: 400 } }, config: { concurrency: 100000 } },
      { id: 'db', type: 'db.postgres' },
    ], [{ from: ['src', 'out'], to: ['db', 'in'] }]);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    expect(twoTierEvaluation({ graph: g.value, evaluate: evalDI, maxEvents: TEST_EVENTS })).toBeUndefined();
  });
});
