import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMznCliOutput, type MznSolver } from '@sda/engine-solve';
import { makeNativeAdapter } from '../native';
import { makeIncumbentAdapter } from '../incumbent';
import { closeEnough, type SolverBindings } from '../bindings';
import type { Change } from '../capability';
import type { SearchResult } from '../honesty';
import { generateNumeric, generatedRegistry, type NumericInstance, type Regime, type Topology } from './generator';
import { SCALE_OBJECTIVE_FACTOR, currentValue, floorOf, maxCornerInstance, permutedInstance, scaledInstance, withFloor } from './metamorphic';

// THE METAMORPHIC LAYER — the RUNNER (docs/design/solver-contract.html §4, §7; deeper distillation). The
// differential harness (./harness) can only catch a candidate that disagrees with the incumbent; a bug BOTH solvers
// share is invisible to it (agreement with a shared wrong reading is still agreement). This layer asserts LAWS that
// hold for the TRUE optimum regardless of any solver: scale equivariance, permutation invariance, monotone
// tightening, and repair↔optimize coherence (./metamorphic.ts makes the transformed problems; here we run a solver
// and assert its answers obey the laws). The primary subject is the NATIVE adapter — in-process, ~1 ms/instance, so
// hundreds of runs are cheap. A handful of the laws are then re-checked against the INCUMBENT (the real MIP, slow):
// if the incumbent obeys the SAME law, the law is a genuine property of the optimum, not an accident of native's
// search — so a native pass is meaningful and a native failure is a real bug (not a mis-stated property).
//
// Everything is seeded (owner hard rule): every instance is `generateNumeric(seed, …)` and every permutation carries
// its own integer seed, so a failure names the seed that reproduces it. No product vocabulary appears here — the
// generated designs are opaque typed-property graphs (dependency.test.ts (C)).

const native = makeNativeAdapter({ registry: generatedRegistry });

const TOPOLOGIES: readonly Topology[] = ['chain', 'fan-out', 'fan-in'];
const REGIMES: readonly Regime[] = ['sat', 'unsat'];
/** Per-cell seeds. Small integers offset far from the harness's own seeds (baseSeed 0x5da79, 20k/70k ranges) so the
 *  metamorphic corpus never coincides with an existing instance. */
const SEEDS = [1, 2, 3, 4, 5] as const;
const NATIVE_BASE = 900_000;
/** Positive scale factors (both > 1 and < 1) — a rate scaling is valid for any k > 0; the optimum scales by k. */
const SCALE_KS = [0.5, 2, 5, 10] as const;

/** An adapter's optimize answer distilled to (kind, objective value) — the metamorphic surface (the knob vector is
 *  irrelevant, exactly as the differential harness compares only the observable optimum). */
async function optimize(adapter: SolverBindings, inst: NumericInstance): Promise<{ readonly kind: SearchResult<unknown>['kind']; readonly obj: number | undefined }> {
  const r = await adapter.optimize!({ graph: inst.graph, tunables: inst.tunables, objective: inst.objective });
  return r.kind === 'solved' ? { kind: 'solved', obj: r.value.value(inst.objective.node, inst.objective.key) } : { kind: r.kind, obj: undefined };
}

/** The total L1 edit distance of a change set — the measure repair minimises. */
const totalL1 = (cs: readonly Change[]): number => cs.reduce((s, c) => s + Math.abs(c.delta), 0);

// ── Scale equivariance ──────────────────────────────────────────────────────────────────────────────────────
// Multiply every rate/floor by k: the optimum scales by EXACTLY k and the solved/infeasible kind is preserved.
describe('metamorphic — scale equivariance (native): optimum scales by k, kind preserved', () => {
  for (const topology of TOPOLOGIES) {
    for (const regime of REGIMES) {
      it(`${topology} · ${regime}`, async () => {
        for (const seed of SEEDS) {
          const inst = generateNumeric(NATIVE_BASE + seed, 'optimize', topology, regime);
          const base = await optimize(native, inst);
          for (const k of SCALE_KS) {
            const scaled = await optimize(native, scaledInstance(inst, k));
            expect(scaled.kind, `seed=${seed} k=${k}: kind must be preserved (base=${base.kind})`).toBe(base.kind);
            if (base.kind === 'solved' && base.obj !== undefined && scaled.obj !== undefined) {
              const predicted = SCALE_OBJECTIVE_FACTOR(k) * base.obj;
              expect(closeEnough(scaled.obj, predicted), `seed=${seed} k=${k}: scaled optimum ${scaled.obj} must equal k·base ${predicted}`).toBe(true);
            }
          }
        }
      });
    }
  }
});

// ── Permutation invariance ──────────────────────────────────────────────────────────────────────────────────
// Reorder the node/port/edge maps and the tunable list: the optimum and the honesty kind are unchanged (min/sum
// aggregation is commutative). This is determinism BEYOND the seed — the same design in a different representation.
describe('metamorphic — permutation invariance (native): reordering never moves the optimum', () => {
  const PERM_SEEDS = [7, 13, 29] as const;
  for (const topology of TOPOLOGIES) {
    for (const regime of REGIMES) {
      it(`${topology} · ${regime}`, async () => {
        for (const seed of SEEDS) {
          const inst = generateNumeric(NATIVE_BASE + 100 + seed, 'optimize', topology, regime);
          const base = await optimize(native, inst);
          // Repair is order-sensitive in a different way (it sums per-knob edits); pin its measure too.
          const baseRepair = await native.repair!({ graph: inst.graph, tunables: inst.tunables });
          for (const p of PERM_SEEDS) {
            const perm = permutedInstance(inst, p);
            const permOpt = await optimize(native, perm);
            expect(permOpt.kind, `seed=${seed} perm=${p}: kind must be invariant`).toBe(base.kind);
            if (base.kind === 'solved' && base.obj !== undefined && permOpt.obj !== undefined) {
              expect(closeEnough(permOpt.obj, base.obj), `seed=${seed} perm=${p}: optimum ${permOpt.obj} must equal ${base.obj}`).toBe(true);
            }
            const permRepair = await native.repair!({ graph: perm.graph, tunables: perm.tunables });
            expect(permRepair.kind, `seed=${seed} perm=${p}: repair kind must be invariant`).toBe(baseRepair.kind);
            if (baseRepair.kind === 'solved' && permRepair.kind === 'solved') {
              expect(closeEnough(totalL1(permRepair.value), totalL1(baseRepair.value)), `seed=${seed} perm=${p}: repair L1 must be invariant`).toBe(true);
            }
          }
        }
      });
    }
  }
});

// ── Monotone tightening (swept) ─────────────────────────────────────────────────────────────────────────────
// Sweep the SLO floor upward: the optimum cost never DROPS as the floor rises (a stricter SLO is at least as
// expensive), and feasibility is downward-closed (once a floor is too high to meet, no higher floor is feasible).
// The equivalent "loosening never raises the cost" is the same statement read in reverse along the sweep.
describe('metamorphic — monotone tightening (native), swept over the SLO floor', () => {
  // Ascending multiples of the design's own SAT floor (which sits at ≤ 0.8·hardCap), spanning from comfortably
  // feasible up past the reachable ceiling into provably infeasible — so the sweep exercises BOTH the monotone-cost
  // law over the feasible prefix and the downward-closed-feasibility law at the crossover.
  const MULTIPLES = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 8] as const;
  for (const topology of TOPOLOGIES) {
    it(`${topology}: cost non-decreasing in the floor; feasibility downward-closed`, async () => {
      for (const seed of SEEDS) {
        const inst = generateNumeric(NATIVE_BASE + 200 + seed, 'optimize', topology, 'sat');
        const f0 = floorOf(inst) ?? 0;
        expect(f0, `seed=${seed}: a SAT instance must carry a floor`).toBeGreaterThan(0);
        let lastCost = -Infinity;
        let sawInfeasible = false;
        for (const m of MULTIPLES) {
          const floor = Math.max(1, Math.round(f0 * m));
          const r = await optimize(native, withFloor(inst, floor));
          if (sawInfeasible) {
            // Once a floor is infeasible, every HIGHER floor must remain infeasible — never solved again.
            expect(r.kind, `seed=${seed} floor=${floor}: feasibility must be downward-closed (already saw infeasible)`).not.toBe('solved');
          }
          if (r.kind === 'solved' && r.obj !== undefined) {
            expect(r.obj, `seed=${seed} floor=${floor}: cost ${r.obj} must not fall below the looser floor's ${lastCost}`).toBeGreaterThanOrEqual(lastCost - 1e-3);
            lastCost = r.obj;
          } else if (r.kind === 'infeasible') {
            sawInfeasible = true;
          }
        }
        // Teeth: the sweep must actually reach the infeasible regime (else the downward-closed law is untested).
        expect(sawInfeasible, `seed=${seed}: the floor sweep must cross into provably infeasible`).toBe(true);
      }
    });
  }
});

// ── Repair coherence ────────────────────────────────────────────────────────────────────────────────────────
// (1) Repair from an already-feasible point is a zero-distance edit. (2) Repair's minimal L1 never exceeds the L1
// distance to the optimize-from-scratch optimum (that optimum is one feasible point; repair is the min over all).
describe('metamorphic — repair coherence (native)', () => {
  it('repair from the (feasible) all-max corner returns a zero-distance edit', async () => {
    for (const topology of TOPOLOGIES) {
      for (const seed of SEEDS) {
        const inst = generateNumeric(NATIVE_BASE + 300 + seed, 'optimize', topology, 'sat');
        // Pin every knob to its max — a strictly feasible corner for a SAT design — then repair: nothing to fix.
        const feasible = maxCornerInstance(inst);
        const r = await native.repair!({ graph: feasible.graph, tunables: inst.tunables });
        expect(r.kind, `${topology} seed=${seed}: a feasible design is repairable`).toBe('solved');
        if (r.kind === 'solved') {
          expect(totalL1(r.value), `${topology} seed=${seed}: an already-feasible design needs no edit`).toBeLessThanOrEqual(1e-6);
        }
      }
    }
  });

  it("repair's minimal L1 never exceeds the distance to the optimize-from-scratch optimum", async () => {
    for (const topology of TOPOLOGIES) {
      for (const seed of SEEDS) {
        const inst = generateNumeric(NATIVE_BASE + 400 + seed, 'optimize', topology, 'sat');
        const rep = await native.repair!({ graph: inst.graph, tunables: inst.tunables });
        const opt = await native.optimize!({ graph: inst.graph, tunables: inst.tunables, objective: inst.objective });
        expect(rep.kind, `${topology} seed=${seed}: repair`).toBe('solved');
        expect(opt.kind, `${topology} seed=${seed}: optimize`).toBe('solved');
        if (rep.kind === 'solved' && opt.kind === 'solved') {
          const repL1 = totalL1(rep.value);
          // The L1 distance from the original design to the optimize solution — one feasible edit repair could pick.
          const optL1 = inst.tunables.reduce((s, t) => {
            const cur = currentValue(inst.graph, t.node, t.key) ?? 0;
            const to = opt.value.value(t.node, t.key) ?? cur;
            return s + Math.abs(to - cur);
          }, 0);
          expect(repL1, `${topology} seed=${seed}: repair L1 ${repL1} must be ≤ optimize distance ${optL1}`).toBeLessThanOrEqual(optL1 + 1e-6);
        }
      }
    }
  });
});

// ── Incumbent spot-check: the laws are REAL (a shared property, not a native quirk) ───────────────────────────
// Re-run scale, permutation and monotone against the INCUMBENT (the real MIP) on a FEW instances. If the incumbent
// obeys the SAME law, the law is a genuine property of the optimum — so a native pass above is meaningful and a
// native failure would be a native bug, distinguishable from a mis-stated property. The incumbent needs the
// MiniZinc CLI, wired exactly as ../incumbent/index.test.ts + ./harness.test.ts do (CI installs it via $MINIZINC).
const MZN = process.env.MINIZINC ?? 'minizinc';
const solveMzn: MznSolver = async (model) => {
  const dir = mkdtempSync(join(tmpdir(), 'sda-metamorphic-'));
  try {
    const file = join(dir, 'm.mzn');
    writeFileSync(file, model);
    const out = execFileSync(MZN, ['--solver', 'cbc', '--time-limit', '10000', '--output-mode', 'json', file], { encoding: 'utf8', timeout: 12000 });
    return parseMznCliOutput(out);
  } catch (e) {
    const partial = (e as { stdout?: string }).stdout;
    return partial ? parseMznCliOutput(partial) : { kind: 'unknown' as const };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const incumbent = makeIncumbentAdapter({ registry: generatedRegistry, solveMzn });
const INCUMBENT_BASE = 950_000;
const SPOT_TIMEOUT_MS = 120_000; // several MiniZinc spawns per test — well above the CLI's own 10 s per solve

describe('metamorphic — incumbent spot-check (the laws hold for the real MIP too)', () => {
  const SPOT_CASES: ReadonlyArray<readonly [Topology, Regime]> = [
    ['chain', 'sat'],
    ['fan-in', 'sat'],
  ];

  it(
    'scale: the incumbent optimum also scales by k, kind preserved',
    async () => {
      let i = 0;
      for (const [topology, regime] of SPOT_CASES) {
        const inst = generateNumeric(INCUMBENT_BASE + i++, 'optimize', topology, regime);
        const base = await optimize(incumbent, inst);
        for (const k of [2, 3] as const) {
          const scaled = await optimize(incumbent, scaledInstance(inst, k));
          expect(scaled.kind, `${topology}/${regime} k=${k}: kind preserved`).toBe(base.kind);
          if (base.kind === 'solved' && base.obj !== undefined && scaled.obj !== undefined) {
            expect(closeEnough(scaled.obj, k * base.obj), `${topology}/${regime} k=${k}: ${scaled.obj} vs k·base ${k * base.obj}`).toBe(true);
          }
        }
      }
    },
    SPOT_TIMEOUT_MS,
  );

  it(
    'permutation: the incumbent optimum is invariant under reordering',
    async () => {
      const inst = generateNumeric(INCUMBENT_BASE + 50, 'optimize', 'chain', 'sat');
      const base = await optimize(incumbent, inst);
      for (const p of [7, 13] as const) {
        const perm = await optimize(incumbent, permutedInstance(inst, p));
        expect(perm.kind, `perm=${p}: kind invariant`).toBe(base.kind);
        if (base.kind === 'solved' && base.obj !== undefined && perm.obj !== undefined) {
          expect(closeEnough(perm.obj, base.obj), `perm=${p}: ${perm.obj} vs ${base.obj}`).toBe(true);
        }
      }
    },
    SPOT_TIMEOUT_MS,
  );

  it(
    'monotone: the incumbent optimum is non-decreasing as the floor rises',
    async () => {
      const inst = generateNumeric(INCUMBENT_BASE + 60, 'optimize', 'chain', 'sat');
      const f0 = floorOf(inst) ?? 0;
      let lastCost = -Infinity;
      for (const m of [0.5, 1, 1.5] as const) {
        const floor = Math.max(1, Math.round(f0 * m));
        const r = await optimize(incumbent, withFloor(inst, floor));
        if (r.kind === 'solved' && r.obj !== undefined) {
          expect(r.obj, `floor=${floor}: cost ${r.obj} must not drop below ${lastCost}`).toBeGreaterThanOrEqual(lastCost - 1e-3);
          lastCost = r.obj;
        }
      }
      expect(lastCost, 'the incumbent solved at least one floor in the feasible sweep').toBeGreaterThan(0);
    },
    SPOT_TIMEOUT_MS,
  );
});
