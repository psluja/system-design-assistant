import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { LayoutDesign, LayoutGroup, LayoutNode, LayoutWire, Placement } from './layout-model';
import { DEFAULT_NODE_SIZE, ROW_PITCH, designHash, fnv1a, mulberry32, nodeGeoms, portsFromWires } from './layout-model';
import { boxViolations, hardViolations, layoutGeometry, scoreLayout, separationMetrics, straightWireCount } from './layout-objective';
import { type BatchScorer, detectPins, optimizeLayout, placementKeys } from './layout-optimize';
import { tidyLayout } from './layout';
import { routeDesignEdges } from './edge-routing';

interface Raw {
  instances: { id: string; type: string; config?: Record<string, number> }[];
  wires: { from: [string, string]; to: [string, string]; semantics?: 'sync' | 'async' }[];
  groups?: { id: string; members: string[] }[];
}
function load(file: string): LayoutDesign {
  const raw = JSON.parse(readFileSync(new URL(`../../../examples/${file}`, import.meta.url), 'utf8')) as Raw;
  const nodes: LayoutNode[] = raw.instances.map((i) => {
    const origin = i.config?.assumedRps;
    return origin !== undefined ? { id: i.id, type: i.type, originRate: origin } : { id: i.id, type: i.type };
  });
  const wires: LayoutWire[] = raw.wires.map((w) => (w.semantics !== undefined ? { from: w.from, to: w.to, semantics: w.semantics } : { from: w.from, to: w.to }));
  const groups: LayoutGroup[] = (raw.groups ?? []).map((g) => ({ id: g.id, members: g.members }));
  return { nodes, wires, groups };
}
const EXAMPLES = ['cqrs.sda.json', 'ecommerce-production.sda.json', 'cqrs-production-large.sda.json', 'oracle-to-aurora-migration-repeat.sda.json'];
const tidyOf = (d: LayoutDesign): Placement => {
  const groups = d.groups.map((g) => ({ id: g.id, label: '', rect: { x: 0, y: 0, w: 0, h: 0 }, members: g.members }));
  const sizes: Record<string, { w: number; h: number }> = {};
  for (const x of d.nodes) sizes[x.id] = DEFAULT_NODE_SIZE; // match the optimiser's own Tidy seed (so an unmoved node is not a pin)
  return tidyLayout(d.nodes.map((x) => ({ id: x.id })), d.wires.map((w) => ({ from: w.from, to: w.to })), groups, sizes).pos;
};

describe('optimizer — determinism (§5.2)', () => {
  it('is a pure function of (seed, design): same seed + iteration budget ⇒ byte-identical layout', () => {
    const d = load('cqrs.sda.json');
    const a = optimizeLayout(d, { seed: 7, iterations: 12, budgetMs: 100000 });
    const b = optimizeLayout(d, { seed: 7, iterations: 12, budgetMs: 100000 });
    expect(JSON.stringify(a.placement)).toEqual(JSON.stringify(b.placement));
    expect(a.score.quality).toBe(b.score.quality);
  });
  it('a different seed can explore a different optimum (still ≥ Tidy)', () => {
    const d = load('cqrs.sda.json');
    const s1 = optimizeLayout(d, { seed: 1, iterations: 20, budgetMs: 100000 });
    const s7 = optimizeLayout(d, { seed: 7, iterations: 20, budgetMs: 100000 });
    expect(s1.score.quality).toBeGreaterThanOrEqual(s1.tidy.score.quality - 1e-9);
    expect(s7.score.quality).toBeGreaterThanOrEqual(s7.tidy.score.quality - 1e-9);
  });
});

describe('optimizer — monotone improvement (the floor never underperforms Tidy)', () => {
  it('beats or ties Tidy on the aggregate for every committed example, and stays feasible', () => {
    for (const f of EXAMPLES) {
      const d = load(f);
      const r = optimizeLayout(d, { seed: 1, iterations: 30, budgetMs: 4000 });
      expect(r.score.feasible, `${f} feasible`).toBe(true);
      expect(r.score.quality, `${f} optimize ${r.score.quality} ≥ tidy ${r.tidy.score.quality}`).toBeGreaterThanOrEqual(r.tidy.score.quality - 1e-9);
    }
  });
});

describe('optimizer — router regression (0 crossings preserved, §2.1 H1)', () => {
  it('keeps CQRS at zero routed crossings', () => {
    const d = load('cqrs.sda.json');
    const r = optimizeLayout(d, { seed: 1, iterations: 30, budgetMs: 4000 });
    const s = scoreLayout(d, r.placement);
    expect(s.penalties.crossings).toBe(0);
    expect(s.feasible).toBe(true);
  });
});

describe('optimizer — pins are hard constraints (§5.3, H5)', () => {
  it('never moves a pinned (hand-placed) node off its anchor', () => {
    const d = load('cqrs.sda.json');
    // Simulate a hand placement: take Tidy, drag one node far away — it diverges from Tidy ⇒ inferred as a pin.
    const stored: Record<string, { x: number; y: number }> = { ...tidyOf(d) };
    const target = d.nodes[3]!.id;
    stored[target] = { x: stored[target]!.x + 900, y: stored[target]!.y + 600 };
    const pins = detectPins(d, stored);
    expect(pins.has(target)).toBe(true);
    const r = optimizeLayout(d, { seed: 3, iterations: 25, budgetMs: 4000, pins, anchors: stored });
    expect(r.placement[target]).toEqual(stored[target]);
  });

  it('detectPins ignores nodes still at their Tidy position', () => {
    const d = load('cqrs.sda.json');
    const pins = detectPins(d, tidyOf(d));
    expect(pins.size).toBe(0);
  });
});

// R5 — THE CASCADE (port-centric alignment): rows placed by PORT anchors must CASH as the router's straight-line
// fast path in the layout that ships, and the winner may never draw fewer straight wires than Tidy (the R5 floor,
// the same near-lexicographic pattern as the R4 overlap floor).

describe('optimizer — the R5 cascade: port alignment lands as straight wires', () => {
  it('the result carries the ROUTER-ACCEPTED port slide, deterministic with the winner', () => {
    // The multi-out shape (a declared manifest out side, one port wired): the slide is where the last px of the
    // jog closes, so the optimizer must ship it on the result — and byte-identically on a re-run (same seed).
    const d: LayoutDesign = {
      nodes: [
        { id: 'api', size: { w: 160, h: 120 }, ports: [{ name: 'in', dir: 'in' }, { name: 'db', dir: 'out' }, { name: 'out', dir: 'out' }, { name: 'cache', dir: 'out' }] },
        { id: 'pg', size: { w: 160, h: 140 }, ports: [{ name: 'in', dir: 'in' }] },
      ],
      wires: [{ from: ['api', 'db'], to: ['pg', 'in'] }],
      groups: [],
    };
    const sizes = { api: { w: 160, h: 120 }, pg: { w: 160, h: 140 } };
    const one = optimizeLayout(d, { seed: 1, iterations: 20, budgetMs: 100000, sizes });
    const two = optimizeLayout(d, { seed: 1, iterations: 20, budgetMs: 100000, sizes });
    expect(one.portOffsets).toEqual(two.portOffsets);
    // The slide puts pg.in exactly opposite api.db — the router ships ONE straight segment at the offsets.
    const routed = routeDesignEdges({ nodes: nodeGeoms(d, one.placement, undefined, one.portOffsets), wires: d.wires.map((w) => ({ from: w.from, to: w.to })) });
    const pts = routed.get(0)!.points;
    expect(pts.length).toBe(2);
    expect(pts[0]!.y).toBeCloseTo(pts[1]!.y, 6);
  });

  it('a 3-node chain of heights 80/140/100 yields ONE straight wire per hop after ideal layout', () => {
    const d: LayoutDesign = {
      nodes: [
        { id: 'a', size: { w: 160, h: 80 } },
        { id: 'b', size: { w: 160, h: 140 } },
        { id: 'c', size: { w: 160, h: 100 } },
      ],
      wires: [
        { from: ['a', 'out'], to: ['b', 'in'] },
        { from: ['b', 'out'], to: ['c', 'in'] },
      ],
      groups: [],
    };
    const sizes = { a: { w: 160, h: 80 }, b: { w: 160, h: 140 }, c: { w: 160, h: 100 } };
    const r = optimizeLayout(d, { seed: 1, iterations: 30, budgetMs: 100000, sizes });
    const routed = routeDesignEdges({ nodes: nodeGeoms(d, r.placement), wires: d.wires.map((w) => ({ from: w.from, to: w.to })) });
    d.wires.forEach((_, i) => {
      const pts = routed.get(i)!.points;
      expect(pts.length, `hop ${i} is ONE straight segment`).toBe(2);
      expect(pts[0]!.y, `hop ${i} rides one row`).toBeCloseTo(pts[1]!.y, 9);
    });
  });

  it('a TALL two-in-port hub: both feeders route straight onto its 1/3 and 2/3 port rows after ideal layout', () => {
    // The other shape the owner named — a tall multi-port node whose anchors sit at port FRACTIONS. Here straight
    // wires and beauty agree, so the QUALITY winner carries them (no floor needed): the port-centric seed puts
    // each feeder's out anchor exactly on its target port's row and the router draws two one-segment wires.
    const d: LayoutDesign = {
      nodes: [
        { id: 'f1', size: { w: 160, h: 80 } },
        { id: 'f2', size: { w: 160, h: 80 } },
        { id: 'hub', size: { w: 160, h: 600 } },
      ],
      wires: [
        { from: ['f1', 'out'], to: ['hub', 'p1'] },
        { from: ['f2', 'out'], to: ['hub', 'p2'] },
      ],
      groups: [],
    };
    const sizes = { f1: { w: 160, h: 80 }, f2: { w: 160, h: 80 }, hub: { w: 160, h: 600 } };
    const r = optimizeLayout(d, { seed: 1, iterations: 30, budgetMs: 100000, sizes });
    const routed = routeDesignEdges({ nodes: nodeGeoms(d, r.placement), wires: d.wires.map((w) => ({ from: w.from, to: w.to })) });
    d.wires.forEach((_, i) => {
      expect(routed.get(i)!.points.length, `feeder wire ${i} is ONE straight segment`).toBe(2);
    });
  });

  it('the straight-wire TIE-BREAK: equal-quality finalists resolve toward more straight wires, and the winner is deterministic', () => {
    // The tie-break lives in result(): among equal-score finalists the router-straighter one ships (then signature).
    // Its observable, budget-safe guarantee is determinism + the R4 overlap floor still holding on every example.
    for (const f of EXAMPLES) {
      const d = load(f);
      const a = optimizeLayout(d, { seed: 1, iterations: 12, budgetMs: 100000 });
      const b = optimizeLayout(d, { seed: 1, iterations: 12, budgetMs: 100000 });
      expect(JSON.stringify(a.placement), `${f}: tie-break keeps the winner a pure function of (seed, design)`).toEqual(JSON.stringify(b.placement));
      expect(straightWireCount(layoutGeometry(d, a.placement))).toBe(straightWireCount(layoutGeometry(d, b.placement)));
    }
  });
});

describe('optimizer — budget is honoured (§3.6)', () => {
  it('a tiny wall-clock budget stops promptly and still returns a layout ≥ Tidy', () => {
    const d = load('cqrs-production-large.sda.json');
    const t0 = Date.now();
    const r = optimizeLayout(d, { seed: 1, budgetMs: 1, iterations: 100000 });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1500); // never runs the full schedule when the budget is spent
    expect(r.score.quality).toBeGreaterThanOrEqual(r.tidy.score.quality - 1e-9);
    expect(r.score.feasible).toBe(true);
  });
});

// ── R4d — THE CACHED PIPELINE: same layout, less compute (layout-optimize header, the polish speed round) ────────

describe('optimizer — R4d cached pipeline is byte-identical to the reference pipeline', () => {
  // THE PIPELINE DIFFERENTIAL (the R4d hard constraint): `caching: false` runs the PRE-R4d reference pipeline —
  // every candidate routed through the batch scorer, no memo, no box-reject — and the default runs the cached one.
  // Same seed ⇒ the two must agree on EVERY reported field — placement (byte-for-byte), score, provenance, compute
  // accounting — on every committed example, over the FULL deterministic schedule (a generous budget so the
  // wall-clock safety cap never truncates either side).
  it('cached vs reference: byte-identical winner + score + provenance on every committed example (seed 1, full schedule)', () => {
    for (const f of EXAMPLES) {
      const d = load(f);
      const cached = optimizeLayout(d, { seed: 1, budgetMs: 600000 });
      const reference = optimizeLayout(d, { seed: 1, budgetMs: 600000, caching: false });
      expect(JSON.stringify(cached.placement), `${f}: winner placement`).toEqual(JSON.stringify(reference.placement));
      expect(cached.score, `${f}: winner score`).toEqual(reference.score);
      expect(cached.source, `${f}: provenance`).toBe(reference.source);
      expect(cached.iterations, `${f}: schedule`).toBe(reference.iterations);
      expect(cached.evaluated, `${f}: compute accounting`).toBe(reference.evaluated);
    }
  }, 120000);

  it('holds across seeds too — the memo is trajectory-neutral, not seed-1 luck', () => {
    const d = load('cqrs.sda.json');
    for (const seed of [3, 7]) {
      const cached = optimizeLayout(d, { seed, budgetMs: 600000 });
      const reference = optimizeLayout(d, { seed, budgetMs: 600000, caching: false });
      expect(JSON.stringify(cached.placement), `seed ${seed}`).toEqual(JSON.stringify(reference.placement));
      expect(cached.score, `seed ${seed}`).toEqual(reference.score);
    }
  }, 60000);

  // THE PRE-CHANGE GOLDEN: the winners the pipeline produced at HEAD ee412a1 (BEFORE the R4d levers landed), seed 1,
  // full schedule — the cached pipeline must reproduce them bit-for-bit. Guarded by the design's STRUCTURE hash so a
  // legitimate future edit to an example file retires its pin (a changed design owes a different winner) instead of
  // failing spuriously; while the structure stands, the winner may not move.
  //
  // R5 RE-PIN (ecommerce + large): the separation pass changed DELIBERATELY — a bundle member that ships STRAIGHT
  // no longer consumes a stagger slot (edge-routing `reshapeBundle`), so jogging members split closer to the
  // shared port and the routed scores shifted; the beam therefore crowns different winners on the two fan-out-
  // heavy designs (ecommerce: 4 straight wires vs 2, line-on-line overlap 66px vs 78px; large: every standing
  // gate re-proven — quality ≥ Tidy, overlap ≤ Tidy, zero needless bends). cqrs and oracle reproduced bit-for-bit
  // across the change. The pin keeps its full power — same seed ⇒ same winner, byte-exact — at the re-proven truth.
  const R4D_GOLDENS: Readonly<Record<string, { readonly design: string; readonly winner: string }>> = {
    'cqrs.sda.json': { design: 'b0b105f7', winner: '40f9dff2' },
    'ecommerce-production.sda.json': { design: '9564925e', winner: '49116e11' },
    // large RE-PINNED after the identity rework of the example (anonymous compute.service → compute.fargate /
    // compute.lambda, search.elasticsearch → search.opensearch): the retype changed the structure hash, so the
    // old pin (design 5f8e8918 / winner 2a380bcc) retired by the guard below; this is the re-proven winner.
    'cqrs-production-large.sda.json': { design: '4d6482ea', winner: 'f74a3dc5' },
    'oracle-to-aurora-migration-repeat.sda.json': { design: 'd78e2055', winner: 'bf2e2c69' },
  };
  it('reproduces the pre-R4d winners bit-for-bit on every committed example (structure-guarded golden)', () => {
    for (const f of EXAMPLES) {
      const d = load(f);
      const golden = R4D_GOLDENS[f]!;
      if (designHash(d).toString(16) !== golden.design) continue; // structure changed — the pin retires with it
      const r = optimizeLayout(d, { seed: 1, budgetMs: 600000 });
      expect(fnv1a(placementKeys(r.placement).key).toString(16), `${f}: the R4d golden winner`).toBe(golden.winner);
    }
  }, 120000);
});

describe('optimizer — R4d cache correctness (a stale entry would be a lying canvas)', () => {
  it('the memo key is EXACT geometry: sub-rounding coordinate changes never alias (only the beam sig rounds)', () => {
    const p1: Placement = { a: { x: 100, y: 50.02 }, b: { x: 440, y: 50 } };
    const p2: Placement = { a: { x: 100, y: 50.04 }, b: { x: 440, y: 50 } }; // 0.02px apart — one rounded signature
    const k1 = placementKeys(p1);
    const k2 = placementKeys(p2);
    expect(k1.sig, 'the 0.1px beam signature cannot tell them apart').toBe(k2.sig);
    expect(k1.key, 'the cache key MUST tell them apart').not.toBe(k2.key);
    expect(placementKeys({ b: { x: 440, y: 50 }, a: { x: 100, y: 50.02 } }).key, 'insertion order is irrelevant').toBe(k1.key);
    // the sig stays byte-identical to the legacy signature format the beam tie-breaks on
    expect(k1.sig).toBe('a:100,50|b:440,50');
  });

  it('box-reject agrees with the full hard check on beam-like nudges of every committed example', () => {
    // The cheap gate must be EXACTLY the H2/H4 subset of hardViolations on the placements the beam actually
    // produces — a candidate discarded by the gate is a candidate the exact scorer would have discarded, always.
    for (const f of EXAMPLES) {
      const d = load(f);
      const rng = mulberry32(0x24d);
      let p: Record<string, { x: number; y: number }> = { ...tidyOf(d) };
      for (let k = 0; k < 25; k++) {
        const ids = Object.keys(p);
        const id = ids[Math.floor(rng() * ids.length) % ids.length]!;
        p = { ...p, [id]: { x: p[id]!.x, y: p[id]!.y + (rng() < 0.5 ? -ROW_PITCH : ROW_PITCH) } };
        const geo = layoutGeometry(d, p);
        expect(boxViolations(geo.nodes, geo.groups), `${f} nudge ${k}`).toEqual(hardViolations(geo).filter((h) => h.constraint !== 'H1'));
      }
    }
  }, 60000);

  it('winner honesty: the reported score equals a FRESH re-score of the applied placement', () => {
    // If a stale or aliased cache entry ever leaked into the applied layout, the reported score would disagree
    // with an independent re-route + re-score of the shipped placement. It never may.
    for (const f of EXAMPLES) {
      const d = load(f);
      const r = optimizeLayout(d, { seed: 1, iterations: 20, budgetMs: 100000 });
      expect(r.score, f).toEqual(scoreLayout(d, r.placement));
    }
  }, 60000);
});

describe('optimizer — early termination (stallIterations, an opt-in lever — R4d)', () => {
  // MEASURED VERDICT (R4d): improvements land LATE in the schedule (last gains at beam iteration 41/44 on cqrs,
  // 71/92 on cqrs-production-large, 118/120 on a synthetic 40-node design), so any stall window small enough to
  // save time changes the trajectory — at every measured N ≤ 24 the cqrs winner differs from the full run's.
  // Byte-identity therefore does NOT hold ⇒ the lever ships DEFAULT-OFF (the R4d rule: default-on only if it
  // does). What the lever guarantees regardless of where it stops are the structural floors below.
  it('the floors hold under any stall window on every committed example: feasible, ≥ Tidy quality, ≤ Tidy overlap', () => {
    for (const f of EXAMPLES) {
      const d = load(f);
      for (const N of [4, 12]) {
        const r = optimizeLayout(d, { seed: 1, budgetMs: 100000, stallIterations: N });
        expect(r.score.feasible, `${f} N=${N}`).toBe(true);
        expect(r.score.quality, `${f} N=${N}: quality floor`).toBeGreaterThanOrEqual(r.tidy.score.quality - 1e-9);
        const overlap = separationMetrics(layoutGeometry(d, r.placement)).overlapLen;
        const tidyOverlap = separationMetrics(layoutGeometry(d, r.tidy.placement)).overlapLen;
        expect(overlap, `${f} N=${N}: traceability floor`).toBeLessThanOrEqual(tidyOverlap + 1e-6);
      }
    }
  }, 60000);

  it('a window the schedule cannot stall past never fires — byte-identical to the full run', () => {
    const d = load('cqrs.sda.json');
    const full = optimizeLayout(d, { seed: 1, budgetMs: 600000 });
    const idle = optimizeLayout(d, { seed: 1, budgetMs: 600000, stallIterations: full.iterations + 1 });
    expect(JSON.stringify(idle.placement)).toEqual(JSON.stringify(full.placement));
    expect(idle.score).toEqual(full.score);
  });
});

describe('optimizer — R4d perf smoke (the polish never pays for the same geometry twice)', () => {
  // MACHINE-INDEPENDENT regression gate: the trajectory is deterministic, so the number of candidates that reach
  // the batch scorer (= placements actually routed during the search) is a fixed function of (seed, design). R4d
  // measured 20–33% of proposals on the committed examples — the rest were memo hits (duplicate geometries) or
  // box-rejects (H2/H4, no routing needed); 40% is the ceiling with honest margin. If the cache is ever weakened
  // this trips regardless of how fast the machine is.
  it('≤ 40% of proposed candidates reach the batch scorer on every committed example', () => {
    for (const f of EXAMPLES) {
      const d = load(f);
      const ports = portsFromWires(d);
      let routed = 0;
      const counting: BatchScorer = (cands) => {
        routed += cands.length;
        return cands.map((p) => scoreLayout(d, p, ports));
      };
      const r = optimizeLayout(d, { seed: 1, budgetMs: 600000, batchScore: counting });
      const proposed = r.iterations * 6 * 6; // default beamWidth × movesPerCandidate; the beam stays full on the examples
      expect(routed, `${f}: ${routed}/${proposed} candidates routed`).toBeLessThanOrEqual(0.4 * proposed);
    }
  }, 60000);

  // Wall-clock smoke with honest margin: the FULL deterministic schedule of all four examples summed to ~0.8s after
  // R4d (vs ~3.5s before) on the profiling machine; 6s catches a pathological blow-up without flaking on a slow CI
  // runner. The deterministic routed-fraction gate above is the precise cache-regression detector.
  it('the full deterministic polish of all four committed examples completes inside 6s total', () => {
    const t0 = performance.now();
    for (const f of EXAMPLES) optimizeLayout(load(f), { seed: 1, budgetMs: 600000 });
    expect(performance.now() - t0).toBeLessThan(6000);
  }, 30000);
});
