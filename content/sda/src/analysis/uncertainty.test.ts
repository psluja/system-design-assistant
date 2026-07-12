import { describe, expect, it } from 'vitest';
import { NodeId, type Key } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { makeNativeAdapter } from '@sda/solver-contract/native';
import type { EvaluateBatch } from '@sda/solver-contract';
import { instantiate, allManifests, registry, keys, type AssumptionScenario, type Instance, type Wire } from '../index';
import { systemSummary } from './system';
import { runUncertainty, hasRanges, rangedInputsOf, type UncertaintyResult } from './uncertainty';

// ASSUMPTION UNCERTAINTY R1 — the seam + the math. Each test carries its ANALYTIC
// ANCHOR: a closed-form the seeded Monte-Carlo output must match, so a green is a proof, not a vibe. The evaluator
// is the CONTRACT's native EvaluateBatch (the same one the app binds), so these tests exercise the real seam.

// The bound batch evaluator — the native in-process adapter over the JS forward pass (no WASM, no process spawn).
const native = makeNativeAdapter({ registry });
const evaluateBatch: EvaluateBatch = native.evaluateBatch!;

// ── canonical toy designs (the smallest that exercise the math) ─────────────────────────────────────────────

/** A LINEAR-COST toy: gen ORIGINATES `assumedRps` (unbounded, so it emits exactly that) → a pay-per-use sink whose
 *  cost = inflow × unitCost. So the whole-design cost is AFFINE in assumedRps — the closed form the percentile and
 *  tornado tests anchor against. `ranges` declares the uncertainty; `config` holds the point value the base uses. */
const linearCost = (ranges: Instance['ranges'], genConfig: Record<string, number> = {}): { instances: Instance[]; wires: Wire[] } => ({
  instances: [
    { id: 'gen', type: 'compute.service', config: { assumedRps: 500, concurrency: 100000, ...genConfig }, ...(ranges ? { ranges } : {}) },
    { id: 'sink', type: 'storage.object', config: { throughput: 100000000, unitCost: 0.1 } },
  ],
  wires: [{ from: ['gen', 'out'], to: ['sink', 'in'] }],
});

/** A latency-SLO chain: client → svc (fixed latency, no queueing) → db. The SLO rides on svc; ranging an unrelated
 *  input keeps the latency fixed across scenarios, so the SLO holds (or breaks) in EVERY world — the coherence anchor. */
const sloChain = (svcLatencyMax: number, ranges: Instance['ranges']): { instances: Instance[]; wires: Wire[] } => ({
  instances: [
    { id: 'client', type: 'client.web', config: { throughput: 100 } },
    { id: 'svc', type: 'compute.service', config: { concurrency: 100000, perRequestDuration: 5, latency: 50 }, bands: [{ key: keys.latency, band: { shape: 'minTargetMax', max: svcLatencyMax } }] },
    { id: 'db', type: 'db.postgres', config: { unitCost: 0.2 }, ...(ranges ? { ranges } : {}) },
  ],
  wires: [
    { from: ['client', 'out'], to: ['svc', 'in'] },
    { from: ['svc', 'out'], to: ['db', 'in'] },
  ],
});

/** Compile + forward-evaluate a design and read its whole-design cost total — the SAME `systemSummary` metric
 *  runUncertainty distributes, so the closed-form endpoints and the empirical percentiles come from one function. */
function costOf(instances: Instance[], wires: Wire[]): number {
  const g = instantiate(allManifests, instances, wires);
  if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
  const ev = evaluate(g.value, registry);
  if (!ev.ok) throw new Error(`evaluate failed: ${ev.error.join('; ')}`);
  const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
  return systemSummary(instances, wires, value).cost.totalUsdMonth;
}

/** Cost of a design with one config knob pinned to `value` (the point evaluation at a range endpoint / mode). */
function costAt(instances: Instance[], wires: Wire[], node: string, key: string, value: number): number {
  const pinned = instances.map((i) => (i.id === node ? { ...i, config: { ...(i.config ?? {}), [key]: value } } : i));
  return costOf(pinned, wires);
}

const run = (instances: Instance[], wires: Wire[], n: number, seed: number): Promise<UncertaintyResult> => {
  const g = instantiate(allManifests, instances, wires);
  if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
  return runUncertainty({ graph: g.value, instances, wires, n, seed }, evaluateBatch);
};

const metric = (res: UncertaintyResult, name: string) => res.metrics.find((m) => m.name === name)!;

describe('uncertainty — no ranges is SILENT and BIT-IDENTICAL to today (the no-filler contract)', () => {
  it('a design with no ranges draws no scenarios and reports nothing', async () => {
    const { instances, wires } = linearCost(undefined); // no ranges anywhere
    expect(hasRanges(instances)).toBe(false);
    expect(rangedInputsOf(instances)).toEqual([]);
    const res = await run(instances, wires, 1000, 1);
    expect(res.scenarios).toBe(0);
    expect(res.metrics).toEqual([]);
    expect(res.tornado).toEqual([]);
    expect(res.sloConfidence).toEqual([]);
    expect(res.rangedInputs).toEqual([]);
  });

  it('declaring a range does NOT change the base forward evaluation (the point value is still used)', () => {
    const withRange = linearCost({ assumedRps: { lo: 200, hi: 800 } });
    const without = linearCost(undefined);
    // The base graph must be bit-identical: a range is register metadata, not a value — it never touches the forward
    // pass until sampled. Same cost, same every solved value.
    expect(costOf(withRange.instances, withRange.wires)).toBe(costOf(without.instances, without.wires));
  });
});

describe('uncertainty — seeded determinism (byte-reproducible; the seed is an input)', () => {
  it('same (design, n, seed) ⇒ identical result; a different seed ⇒ a different sample', async () => {
    const { instances, wires } = linearCost({ assumedRps: { lo: 200, hi: 800 } });
    const a = await run(instances, wires, 2000, 12345);
    const b = await run(instances, wires, 2000, 12345);
    const c = await run(instances, wires, 2000, 67890);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // byte-reproducible
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c)); // a real re-draw, not a fixed answer
    expect(a.seed).toBe(12345);
    expect(a.scenarios).toBe(2000);
  });
});

describe('uncertainty — percentiles vs the closed form (cost linear in a UNIFORM input)', () => {
  it('empirical p5/p50/p95 of cost match the analytic quantiles of the affine map', async () => {
    const lo = 200;
    const hi = 800;
    const { instances, wires } = linearCost({ assumedRps: { lo, hi } });
    // Cost is AFFINE increasing in assumedRps, so quantile(cost) = cost(lo) + q·(cost(hi) − cost(lo)) — the two
    // endpoints pin the whole line (no need to know the slope). assumedRps ~ Uniform ⇒ q is the plain quantile.
    const costLo = costAt(instances, wires, 'gen', 'assumedRps', lo);
    const costHi = costAt(instances, wires, 'gen', 'assumedRps', hi);
    const span = costHi - costLo;
    expect(span).toBeGreaterThan(0); // the toy actually responds (a dead metric would make the test vacuous)

    const res = await run(instances, wires, 5000, 4242);
    const cost = metric(res, 'cost');
    const tol = 0.03 * span; // 3% of the spread — order-statistic noise at N=5000 is well under 1% (seeded ⇒ stable)
    expect(Math.abs(cost.p5 - (costLo + 0.05 * span))).toBeLessThan(tol);
    expect(Math.abs(cost.median - (costLo + 0.5 * span))).toBeLessThan(tol);
    expect(Math.abs(cost.p95 - (costLo + 0.95 * span))).toBeLessThan(tol);
    expect(Math.abs(cost.mean - (costLo + 0.5 * span))).toBeLessThan(tol);
    expect(cost.min).toBeGreaterThanOrEqual(costLo - 1e-6);
    expect(cost.max).toBeLessThanOrEqual(costHi + 1e-6);
  });

  it('the histogram is a partition: bins are contiguous, on a nice-step grid, and counts sum to N', async () => {
    const { instances, wires } = linearCost({ assumedRps: { lo: 200, hi: 800 } });
    const res = await run(instances, wires, 3000, 7);
    const h = metric(res, 'cost').histogram;
    expect(h.reduce((s, b) => s + b.count, 0)).toBe(3000); // every scenario lands in exactly one bin
    const width = h[0]!.hi - h[0]!.lo;
    for (let i = 1; i < h.length; i++) {
      expect(h[i]!.lo).toBeCloseTo(h[i - 1]!.hi, 6); // contiguous, no gaps/overlaps
      expect(h[i]!.hi - h[i]!.lo).toBeCloseTo(width, 6); // equal-width bins on the nice grid
    }
  });
});

describe('uncertainty — triangular sampling: the MODE is the density peak (statistical, seeded)', () => {
  it('the modal histogram bin sits at cost(mode), not at an edge', async () => {
    // lo > 0: at assumedRps 0 a source is no longer a DECLARED origin (it reverts to emitting its full capacity), so
    // the affine cost anchor only holds for a strictly-positive origin — keep the whole range above 0.
    const lo = 20;
    const mode = 50;
    const hi = 100;
    const { instances, wires } = linearCost({ assumedRps: { lo, mode, hi } });
    const costLo = costAt(instances, wires, 'gen', 'assumedRps', lo);
    const costHi = costAt(instances, wires, 'gen', 'assumedRps', hi);
    const costMode = costAt(instances, wires, 'gen', 'assumedRps', mode);

    const res = await run(instances, wires, 5000, 20260704);
    expect(res.rangedInputs[0]!.kind).toBe('triangular');
    const h = metric(res, 'cost').histogram;
    const modal = h.reduce((best, b) => (b.count > best.count ? b : best));
    const mid = (modal.lo + modal.hi) / 2;
    // The empirical peak must be near cost(mode) — closer to it than to EITHER endpoint (an interior peak, the
    // signature of a triangular density, not the flat plateau a uniform would give).
    expect(Math.abs(mid - costMode)).toBeLessThan(Math.abs(mid - costLo));
    expect(Math.abs(mid - costMode)).toBeLessThan(Math.abs(mid - costHi));
    expect(Math.abs(mid - costMode)).toBeLessThan(0.12 * (costHi - costLo));
  });
});

describe('uncertainty — SLO confidence is coherent (0% when it always breaks, 100% when it always holds)', () => {
  it('a loose ceiling holds in every world; a tight one breaks in every world', async () => {
    const ranges = { unitCost: { lo: 0.1, hi: 0.5 } }; // varies COST, never the latency the SLO judges
    const looseDesign = sloChain(100000, ranges);
    const tightDesign = sloChain(1, ranges);
    const loose = await run(looseDesign.instances, looseDesign.wires, 500, 11);
    const tight = await run(tightDesign.instances, tightDesign.wires, 500, 11);
    const conf = (r: UncertaintyResult) => r.sloConfidence.find((s) => s.scope === 'svc' && String(s.key) === String(keys.latency))!;
    expect(conf(loose).satisfiedFraction).toBe(1); // the ~50 ms response is always within 100 s
    expect(conf(tight).satisfiedFraction).toBe(0); // ~50 ms never fits a 1 ms ceiling — a violation in all 500 worlds
  });
});

describe('uncertainty — tornado attributes the spread with the right SIGN and SHARE (the sensitivity row)', () => {
  it('a single ranged input owns ~100% of the outcome variance, with the correct sign', async () => {
    const { instances, wires } = linearCost({ assumedRps: { lo: 200, hi: 800 } });
    const res = await run(instances, wires, 3000, 99);
    const costRows = res.tornado.filter((t) => t.metric === 'cost');
    expect(costRows).toHaveLength(1);
    expect(costRows[0]!.node).toBe('gen');
    expect(costRows[0]!.key).toBe('assumedRps');
    expect(costRows[0]!.share).toBeGreaterThan(0.99); // the only ranged input drives the whole spread
    expect(costRows[0]!.correlation).toBeGreaterThan(0.99); // cost RISES with assumedRps (pay-per-use) — a positive sign
  });

  it('sensitivity matrix: the wide-range driver ranks first; every sign matches the monotone direction', async () => {
    // Two independent ranged inputs, both raising cost: a WIDE assumedRps (big variance) and a NARROWER sink.unitCost
    // (smaller, but GENUINE, variance — a real driver above the noise floor, not a zero-correlation artifact). The
    // tornado must rank assumedRps first (it drives most of the spread) and give BOTH a positive sign (cost rises with
    // each). This is the sensitivity-matrix row for ranges: correct direction + correct ranking.
    const design = {
      instances: [
        { id: 'gen', type: 'compute.service', config: { assumedRps: 500, concurrency: 100000 }, ranges: { assumedRps: { lo: 100, hi: 900 } } },
        { id: 'sink', type: 'storage.object', config: { throughput: 100000000, unitCost: 0.1 }, ranges: { unitCost: { lo: 0.05, hi: 0.15 } } },
      ] as Instance[],
      wires: [{ from: ['gen', 'out'], to: ['sink', 'in'] }] as Wire[],
    };
    const res = await run(design.instances, design.wires, 4000, 555);
    const costRows = res.tornado.filter((t) => t.metric === 'cost');
    expect(costRows).toHaveLength(2);
    expect(costRows[0]!.key).toBe('assumedRps'); // the wide-range driver ranks first
    expect(costRows[0]!.share).toBeGreaterThan(costRows[1]!.share);
    for (const row of costRows) expect(row.correlation).toBeGreaterThan(0); // both raise cost ⇒ positive sign
  });

  it('F5: a ZERO-correlation input (does not move the outcome) contributes NO tornado row — no false precision', async () => {
    // assumedRps drives cost; a SECOND ranged input on the sink's `timeoutMs` (a fact-assumption that does NOT enter
    // the cost math at all) has ~zero correlation with cost. The tornado must show ONLY assumedRps — the noise input
    // is filtered (below TORNADO_MIN_CORRELATION), never rendered as a meaningful share.
    const design = {
      instances: [
        { id: 'gen', type: 'compute.service', config: { assumedRps: 500, concurrency: 100000 }, ranges: { assumedRps: { lo: 100, hi: 900 } } },
        { id: 'sink', type: 'storage.object', config: { throughput: 100000000, unitCost: 0.1 }, ranges: { timeoutMs: { lo: 100, hi: 5000 } } },
      ] as Instance[],
      wires: [{ from: ['gen', 'out'], to: ['sink', 'in'] }] as Wire[],
    };
    const res = await run(design.instances, design.wires, 4000, 555);
    const costRows = res.tornado.filter((t) => t.metric === 'cost');
    expect(costRows).toHaveLength(1); // only the genuine driver
    expect(costRows[0]!.key).toBe('assumedRps');
    expect(costRows.some((r) => r.key === 'timeoutMs')).toBe(false); // the zero-correlation input is suppressed
  });
});

describe('uncertainty — the cloud CENTERS on the ACTIVE world (assumption-model doc §6)', () => {
  // A purely demand-driven pay-per-use design: a client (NO compute cost) offers `throughput` to a pay-per-use sink,
  // so whole-design cost = demand × unitCost. The demand is the source client's throughput a world overrides; the
  // sink's `unitCost` is ranged, so Monte Carlo has spread. Centering on a demand-raising world must shift the whole
  // cost cloud — "a range is a cloud AROUND A POINT", and the point is the active world.
  const design = (): { instances: Instance[]; wires: Wire[] } => ({
    instances: [
      { id: 'c', type: 'client.web', config: { throughput: 500 } },
      { id: 'sink', type: 'storage.object', config: { throughput: 100000000, unitCost: 0.1 }, ranges: { unitCost: { lo: 0.08, hi: 0.12 } } },
    ],
    wires: [{ from: ['c', 'out'], to: ['sink', 'in'] }],
  });
  const runWith = (scenario?: AssumptionScenario): Promise<UncertaintyResult> => {
    const d = design();
    const g = instantiate(allManifests, d.instances, d.wires);
    if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
    return runUncertainty({ graph: g.value, instances: d.instances, wires: d.wires, n: 3000, seed: 7, ...(scenario ? { scenario } : {}) }, evaluateBatch);
  };

  it('NO active world ⇒ bit-for-bit today (an empty-override world is an inert no-op overlay)', async () => {
    const base = await runWith();
    const emptyWorld = await runWith({ id: 'empty', overrides: [] });
    expect(emptyWorld).toEqual(base); // the overlay does nothing when the world diverges nowhere — today's result
  });

  it('a demand-raising world SHIFTS the distribution centers (mean cost tracks the world override)', async () => {
    const base = await runWith(); // the cloud centered at demand = 500
    const high = await runWith({ id: 'high', overrides: [{ node: 'c', key: 'throughput', value: 2000 }] }); // ×4 demand
    const baseCost = metric(base, 'cost');
    const highCost = metric(high, 'cost');
    // cost = demand × unitCost, so ×4 the demand ⇒ ~×4 the mean cost, and the whole cloud shifts up with it.
    expect(highCost.mean).toBeGreaterThan(baseCost.mean * 3.5);
    expect(highCost.mean).toBeLessThan(baseCost.mean * 4.5);
    expect(highCost.median).toBeGreaterThan(baseCost.median * 3.5);
  });
});
