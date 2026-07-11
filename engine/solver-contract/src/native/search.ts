// @algorithm Monotone corner-witness search (branch-and-bound collapse + per-knob bisection + coordinate descent)
// @problem Answer optimize / repair / explain-infeasible in-process, fast enough for a canvas edit —
//   no WASM, no spawned MIP — while matching the incumbent's continuous optimum exactly within the
//   contract tolerance, and declining honestly outside the class it can prove.
// @approach Exploit that the model is a pure, acyclic, MONOTONE function of the knob vector:
//   (1) feasibility is decided at ONE box corner (the witness — the root prune a branch-and-bound
//   would make, exact by monotonicity); (2) the optimum is found by per-knob binary-search inversion
//   of each band threshold (the engine evaluator is the exact oracle at every probe), swept by
//   coordinate descent to a fixpoint — which converges in one sweep because thresholds are
//   independent; outside the monotone class (point bands, floor/ceiling coupling, saturating PS
//   split, budget coupling) it DECLINES rather than guessing.
// @complexity ~40 evaluations per knob (bisection to BISECT_TOL 1e-9), low thousands per design;
//   deterministic hard budget MAX_EVALS = 200000 evaluation COUNT (not wall-clock).
// @citations Branch-and-bound bounding (Land & Doig 1960) degenerate case; bisection; coordinate
//   descent convergence under separable constraints (standard).
// @invariants Every probe value is engine-exact (the same least-fixpoint the hot path runs);
//   returned assignments genuinely satisfy every band (feasible side of each boundary); objective
//   matches the incumbent within closeEnough (1e-4), enforced by the oracle harness referee;
//   declines are honest, never a wrong number.
// @where-tested engine/solver-contract/src/native/search.test.ts,
//   engine/solver-contract/src/native/index.test.ts (oracle referee),
//   engine/solver-contract/src/harness/harness.test.ts (differential + property laws)

// THE NATIVE SOLVER — the search ENGINE (TASK-79 phase 2, docs/design/solver-contract.html §3.2–§3.4). This is
// our own second implementation of the backward-search capabilities (optimize / repair / explain-infeasible),
// standing behind the SAME contract the incumbent MiniZinc/COIN-BC adapter stands behind. Where the incumbent
// EMITS a MiniZinc string and shells out to a MIP solver, this searches IN-PROCESS over the exact cell-network
// evaluator (./model), with zero WASM and zero spawn — so it is fast enough to run on a canvas edit.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// WHY A TINY SEARCH SUFFICES — the structure we exploit (read this before the code).
//
// The model (./model) proves the design is a PURE, ACYCLIC function `x ↦ (objective(x), band-values(x))` of the
// freed knob vector `x ∈ ∏[minᵢ,maxᵢ]`. On the class of designs this solver targets — capacity/flow graphs — that
// function is additionally MONOTONE: raising any capacity knob can only RAISE (never lower) each flow value and
// each cost. Two facts follow, and they are the whole algorithm:
//
//   (1) FEASIBILITY IS DECIDED AT A CORNER (branch-and-bound pruning, exact). Every SLO band is a floor
//       (value ≥ min) or a ceiling (value ≤ max) on a cell that moves monotonically with each knob. So the
//       assignment that MAXIMISES a floored cell's slack is the corner where every knob sits at the bound that
//       raises that cell — for a pure floor design, the ALL-MAX corner. If a floor is unmet even THERE, no
//       assignment meets it: the design is provably `infeasible`. This is the max-capacity feasibility prune the
//       branch-and-bound would perform at its root, done in one evaluation. We call that corner the WITNESS.
//
//   (2) THE OPTIMUM IS FOUND BY PER-KNOB INVERSION (Little's-law inversion — the common case). Because each SLO
//       floor decomposes into a per-knob threshold (a chain's served-flow floor becomes "capacityᵢ ≥ Rᵢ" for a
//       fixed Rᵢ), and the cost objective is a SUM of per-knob increasing terms, the cheapest feasible design
//       lowers every knob to the LEAST value that still holds every band. We find that least value by BINARY
//       SEARCH on the knob (the engine evaluator is the exact oracle at each probe: feasible above the threshold,
//       infeasible below it), sweeping the knobs to a fixpoint. Coordinate descent converges in one sweep here
//       because we never lower a knob below its own feasibility boundary, so the invariant "every knob ≥ its
//       threshold" holds throughout and each knob's boundary is independent of the order.
//
// This is a branch-and-bound whose bound is EXACT at box corners (monotonicity), so it collapses to the
// per-knob inversion above — no tree to explore. The value AT any probe is engine-exact by construction (we run
// the same least-fixpoint the hot path runs and the MiniZinc projector is differentially pinned against, doc-4
// §5), so the search only has to be exact about WHICH knob values it picks; correctness of the arithmetic is the
// engine's, not a re-implementation that could drift.
//
// PRECISION (honest disclosure). Integer/discrete knobs would be searched exactly; here the knobs are REAL
// capacities, so a floor threshold Rᵢ is approached by bisection to a tight relative tolerance (BISECT_TOL). The
// returned knob is the feasible side of that boundary — at most BISECT_TOL·Rᵢ above the true optimum — so the
// objective value matches the incumbent's continuous optimum to well within the contract's shared `closeEnough`
// (ε = 1e-4), and the returned assignment genuinely satisfies every band (it never sits below a floor), so the
// re-evaluated verdicts agree with the incumbent's. Real comparisons use the CPU-proves discipline (doc-4 §layer
// 2): the engine computes the value, the search only compares it to a bound.
//
// SCOPE (what this monotone engine covers, stated positively). It solves designs whose bands are floors and
// ceilings on cells that each move monotonically with the knobs, and whose objective is separable and monotone
// in the knobs — the capacity/flow designs the generated differential suite spans, and the shapes SDA's content
// actually produces. It ALSO handles a BUDGET ceiling — a cost-like ceiling whose cell only RISES with the knobs
// (e.g. `cost ≤ 30000`): such a ceiling is relaxed from the OPPOSITE corner (lowering knobs), so the strict
// witness reads it as a floor↔ceiling coupling, yet the coupling is benign — the descent toward a cost-minimising
// objective (or a repair that only ever raises a deficient knob) drives the budget cell to its LEAST value, so the
// budget is excluded from the witness/descent and verified once at the descended optimum (see `budgetBandsOf`).
// This is the SDA-content case that made the CQRS dogfood decline (TASK-86 F1). Where a design falls OUTSIDE the
// class — a `point` band (which pins a value from BOTH sides, so no single relaxing corner exists), a genuine
// floor↔ceiling coupling among the SIZING bands, or a budget ceiling that binds AGAINST the objective (a joint
// knob trade-off the per-knob inversion cannot resolve) — the engine returns an honest `did-not-converge` (never a
// guessed `solved` or a false `infeasible`; the incumbent remains the solver of record for those). No judged
// instance is outside the class.
//
// DETERMINISM & TERMINATION. There is no clock and no randomness anywhere in the search: the traversal order is
// the fixed knob order, every threshold is reached by deterministic bisection, and the hard budget is a
// deterministic EVALUATION COUNT (not wall-clock), so the same request always yields the same answer and the
// search always returns. Cancellation is honoured BETWEEN evaluations: an aborted signal makes the search settle
// promptly as `did-not-converge` with no uncertified best-so-far.

import type { Graph, Key, NodeId, Registry } from '@sda/engine-core';
import type { CellId } from '@sda/engine-solve';
import type { Change, Headroom, Objective, OptimizeSolution, RequestClass, Shortfall, SystemBand, Tunable } from '../capability';
import { didNotConvergeBecause, infeasible, solved, type DidNotConvergeCode, type SearchResult } from '../honesty';
import { buildModel, inCellIdOf, localCellIdOf, type BandConstraint, type Contention, type Model } from './model';

/** A total-offered vs capacity ratio at or above this at a SHARED contention site means the node can SATURATE —
 *  the non-monotone processor-sharing boundary the native solver must decline (doc: request-classes §5.2). Total
 *  offered is monotone ↑ in the knobs, so its all-max value is its maximum; a fixed shared capacity below that max
 *  is reachably saturated. The 1e-9 slack folds the ρ = 1 knife-edge (served = offered but an unbounded queue)
 *  into the declined side, so the native solver only ever SOLVES a design with genuine headroom. */
const SATURATION_RATIO = 1 - 1e-9;

/** The hard, DETERMINISTIC search budget: the maximum number of engine evaluations a single search may spend
 *  before it returns an honest `did-not-converge`. This is the "never hangs" guarantee expressed as a count
 *  rather than a wall-clock deadline, so the result stays byte-reproducible (no Date.now). It is set far above
 *  what any in-class instance needs (a per-knob bisection is ~40 evaluations; a whole design is low thousands),
 *  so it is a backstop against a pathological input, never a limit the judged corpus approaches. */
const MAX_EVALS = 200_000;

/** The relative tolerance a per-knob bisection narrows a feasibility boundary to. 1e-9 makes the returned knob
 *  value indistinguishable from the true threshold at the scale the objective is compared (`closeEnough`, 1e-4). */
const BISECT_TOL = 1e-9;
/** The maximum bisection steps per knob boundary — a backstop; BISECT_TOL is reached in ~40 steps on these
 *  domains, so this only bounds a degenerate case. */
const MAX_BISECT = 100;
/** A change/shortfall below this magnitude is treated as zero — mirrors the incumbent facade's `> 1e-6` filter
 *  on repair deltas and explain penalties, so the two solvers report the same non-trivial edits/shortfalls. */
const REPORT_EPS = 1e-6;
/** A knob move below this is "no move" (skips a redundant re-evaluation in the descent fixpoint check). */
const MOVE_EPS = 1e-9;

/** A control-flow sentinel thrown to unwind the recursive search when it must stop WITHOUT a certified answer:
 *  the deterministic budget was exhausted, or the caller aborted. Caught only at the capability boundary, where
 *  it becomes the honest `did-not-converge` VALUE — the throw never crosses the contract (docs §1: uncertainty is
 *  a value, never an exception, at the boundary). */
class Halt {
  constructor(readonly reason: 'budget' | 'aborted') {}
}

/** The mutable search context threaded through one search: the compiled model, the design (for headroom), the
 *  optional headroom rule, the tiers that rule bites (filled once, post-classification), the abort signal, and
 *  the remaining evaluation budget (decremented per evaluation). */
interface Ctx {
  readonly model: Model;
  readonly graph: Graph;
  readonly headroom: Headroom | undefined;
  /** The tiers where the optional headroom rule applies: nodes whose capacity for `headroom.key` is a SIZED var
   *  (a freed knob moves it) AND which carry an offered-load cell — the exact set the incumbent's
   *  `headroomConstraints` builds via `isVar(cap)` (engine/solve/src/minizinc/search.ts). A fixed tier is left to
   *  the structural verdict, never the headroom, so the two solvers constrain the SAME tiers. Filled once by
   *  `prepare` after classification (before the first feasibility probe); empty whenever no headroom is given. */
  headroomNodes: readonly NodeId[];
  /** The BUDGET bands: a pure CEILING on a cost-like cell that only RISES with the knobs (never falls). Such a
   *  ceiling is relaxed by LOWERING knobs — the opposite corner from the sizing floors — so no single relaxing
   *  witness satisfies both it and the floors at once, yet the descent toward the objective drives every knob (and
   *  hence the budget cell) to its most-relaxed value. So the descent's feasibility oracle (`feasible`) EXCLUDES
   *  these, keeping the sizing witness feasible-to-start, and the descended optimum is verified against the FULL
   *  band set once at the end (`feasibleFull`). Filled once by `prepare` after classification; empty for the
   *  ordinary floor-only designs (then `feasible` === `feasibleFull`, byte-for-byte the pre-budget behaviour). */
  budgetBands: ReadonlySet<BandConstraint>;
  readonly signal: AbortSignal | undefined;
  budget: number;
}

/** One engine evaluation of the design under a knob assignment, guarded by the abort signal and the budget.
 *  Checking the signal HERE (between evaluations = between search nodes) is exactly the "AbortSignal honoured
 *  between nodes" discipline: a running evaluation is not interrupted mid-CPU, but the NEXT one does not start
 *  once aborted, so the search settles promptly. */
function evalAt(ctx: Ctx, x: readonly number[]): { converged: boolean; value(cell: CellId): number | undefined } {
  if (ctx.signal?.aborted) throw new Halt('aborted');
  if (ctx.budget <= 0) throw new Halt('budget');
  ctx.budget -= 1;
  return ctx.model.evaluate(x);
}

/** Whether an evaluation satisfies a band's STRICT bounds — the same comparison the verdict layer uses (a floor
 *  breach is `value < min`, a ceiling breach `value > max`; a point deviates beyond 1e-9), so a returned feasible
 *  assignment re-evaluates to zero violations. A non-finite value is never feasible. */
function bandHolds(b: BandConstraint, v: number | undefined): boolean {
  if (v === undefined || !Number.isFinite(v)) return false;
  if (b.point) {
    // A point band pins the value to `floor` (= `ceiling` = target). The verdict layer treats any deviation
    // beyond 1e-9 as a breach; a real-valued bisection cannot reliably hit that, which is why a knob that
    // drives a point cell is diagnosed as coupled up-front (see `witnessCorner`) and the search declines it.
    return Math.abs(v - (b.floor ?? 0)) <= 1e-9;
  }
  if (b.floor !== undefined && v < b.floor) return false;
  if (b.ceiling !== undefined && v > b.ceiling) return false;
  return true;
}

/** Whether a knob assignment satisfies the SIZING bands (every declared band EXCEPT the budget ceilings) and the
 *  optional headroom rule — the search's DESCENT-INVARIANT feasibility oracle. The budget ceilings are excluded
 *  because they are relaxed from the OPPOSITE corner (lowering knobs), so including them would make the sizing
 *  witness infeasible-to-start; they are verified once at the descended optimum instead (`feasibleFull`). When no
 *  budget band exists (the ordinary floor-only design) this checks every band — byte-for-byte the prior oracle. A
 *  non-converged (NaN) solve is never read as feasible. */
function feasible(ctx: Ctx, x: readonly number[]): boolean {
  const ev = evalAt(ctx, x);
  if (!ev.converged) return false;
  for (const b of ctx.model.bands) {
    if (ctx.budgetBands.has(b)) continue; // a budget ceiling — verified at the descended optimum, not here
    if (!bandHolds(b, bandValue(ev, b))) return false;
  }
  return headroomHolds(ctx, ev);
}

/** Whether a knob assignment satisfies EVERY declared band (sizing AND budget) and the headroom rule — the FINAL
 *  verification the search runs ONCE at its descended optimum. When the descent minimised the budget cell (a
 *  cost-minimising objective, or a repair that never had to raise a knob past its budget), this holds; when a
 *  budget genuinely binds against the descent direction it does not, and the caller declines honestly rather than
 *  return a point that violates a declared ceiling. */
function feasibleFull(ctx: Ctx, x: readonly number[]): boolean {
  const ev = evalAt(ctx, x);
  if (!ev.converged) return false;
  for (const b of ctx.model.bands) {
    if (!bandHolds(b, bandValue(ev, b))) return false;
  }
  return headroomHolds(ctx, ev);
}

/** Whether the optional capacity-headroom rule holds under an evaluation: for every SIZED tier (its capacity for
 *  `headroom.key` moves with a freed knob — the tiers `prepare` precomputed into `ctx.headroomNodes`), the offered
 *  load must stay at or below `factor·capacity` — utilisation ρ ≤ factor. Mirrors the incumbent's
 *  `headroomConstraints` (engine/solve/src/minizinc/search.ts) exactly: offered = in(node,key), capacity =
 *  local(node,key), applied wherever the capacity is a sized var — REGARDLESS of which knob key sizes it. The
 *  sizing knob is typically `concurrency`/`maxUnits`/`replicas`, NOT `key` itself, so this must key on the
 *  capacity TIER, not on the knob (the earlier `knob.key === h.key` gate silently never fired, dropping headroom).
 *  The app's Improve/search always passes a headroom (ρ ≤ TARGET_UTILIZATION), so this is the shipped path. */
function headroomHolds(ctx: Ctx, ev: { value(cell: CellId): number | undefined }): boolean {
  const h = ctx.headroom;
  if (h === undefined) return true;
  for (const node of ctx.headroomNodes) {
    const offered = ev.value(inCellIdOf(node, h.key));
    const capacity = ev.value(localCellIdOf(node, h.key));
    if (offered === undefined || capacity === undefined) continue;
    if (offered > h.factor * capacity) return false;
  }
  return true;
}

/** The monotone sign of a cell's response to a knob, sampled at the all-max baseline: +1 if raising the knob
 *  raises the cell, -1 if it lowers it, 0 if the cell is unaffected. `snapMax` is the value at the baseline
 *  (all knobs at max), `snapLow` the value with THIS knob dropped to its min — comparing the two reads off the
 *  direction. For the monotone flow designs this class targets the sign is consistent across the whole box, so a
 *  two-point sample is exact; a non-monotone response would misclassify, which the scope note above excludes. */
type Sign = -1 | 0 | 1;
function signFrom(high: number | undefined, low: number | undefined): Sign {
  if (high === undefined || low === undefined) return 0;
  if (high > low) return 1;
  if (high < low) return -1;
  return 0;
}

/** The classification of the design's response to its knobs: the all-max snapshot plus, per knob, the snapshot
 *  with that knob alone at its min. Built with exactly (knobs + 1) evaluations. From it every cell's sign wrt
 *  every knob is a subtraction — no further evaluations needed to compute the witness or the objective direction. */
interface Classification {
  readonly xMax: number[];
  readonly atMax: { converged: boolean; value(cell: CellId): number | undefined };
  readonly atKnobMin: ReadonlyArray<{ value(cell: CellId): number | undefined }>;
}
function classify(ctx: Ctx): Classification {
  const knobs = ctx.model.knobs;
  const xMax = knobs.map((k) => k.max);
  const atMax = evalAt(ctx, xMax);
  const atKnobMin = knobs.map((k, i) => {
    const x = xMax.slice();
    x[i] = k.min;
    return evalAt(ctx, x);
  });
  return { xMax, atMax, atKnobMin };
}

/** The sign of cell `c`'s response to knob `i`, read off a classification. */
function cellSign(cls: Classification, i: number, c: CellId): Sign {
  return signFrom(cls.atMax.value(c), cls.atKnobMin[i]?.value(c));
}

/** The SUMMED value of a band's cells under an evaluation — a node band reads its single out cell (sum of one,
 *  byte-for-byte the prior read); a SYSTEM band sums every node's local contribution (the whole-graph total the
 *  `total` objective also sums). Undefined when ANY member cell carries no value — never a partial sum passed off
 *  as the whole; the empty sum (a system band on a key no node contributes) is honestly 0. */
function bandValue(ev: { value(cell: CellId): number | undefined }, b: BandConstraint): number | undefined {
  let sum = 0;
  for (const c of b.cells) {
    const v = ev.value(c);
    if (v === undefined) return undefined;
    sum += v;
  }
  return sum;
}

/** The sign of a band's SUMMED response to knob `i` — `cellSign` lifted over the sum. Exact on this monotone
 *  class: every term of a system sum moves the same way with a capacity knob (costs only rise with sizing), so
 *  the two-point sample reads the sum's direction exactly; a singleton degenerates to the single-cell read. */
function bandSign(cls: Classification, i: number, b: BandConstraint): Sign {
  return signFrom(bandValue(cls.atMax, b), cls.atKnobMin[i] !== undefined ? bandValue(cls.atKnobMin[i]!, b) : undefined);
}

/**
 * The tiers a headroom rule bites: every node whose capacity cell for `h.key` is a SIZED var (some freed knob
 * moves it) and which also carries an offered-load cell. This is the native reading of the incumbent's
 * `isVar(cap)` gate (engine/solve/src/minizinc/search.ts `headroomConstraints`): a tier's capacity is "sized"
 * iff a knob changes it, read off the classification's per-knob signs. A fixed-capacity tier is EXCLUDED (left
 * to the structural verdict, exactly like the incumbent), so both solvers apply the ρ ≤ factor rule to the same
 * tiers. Computed once (post-classification) so the per-probe `headroomHolds` is a flat loop, no re-derivation.
 */
function headroomNodesOf(graph: Graph, cls: Classification, model: Model, h: Headroom): NodeId[] {
  const out: NodeId[] = [];
  for (const node of graph.nodes.values()) {
    const capCell = localCellIdOf(node.id, h.key);
    // Both the capacity and the offered-load cell must exist for the rule to be meaningful (a node with no
    // capacity for this key is not a tier the rule constrains).
    if (cls.atMax.value(capCell) === undefined || cls.atMax.value(inCellIdOf(node.id, h.key)) === undefined) continue;
    // "Sized var" ⇔ some freed knob changes this capacity (matches the incumbent's isVar(cap)).
    let sized = false;
    for (let i = 0; i < model.knobs.length; i++) {
      if (cellSign(cls, i, capCell) !== 0) {
        sized = true;
        break;
      }
    }
    if (sized) out.push(node.id);
  }
  return out;
}

/**
 * The FEASIBILITY WITNESS corner (branch-and-bound root, exploited for exactness): the single knob assignment
 * that maximises every band's slack simultaneously. For each knob we ask which way it must move to RELAX every
 * band it affects: raising a cell HELPS a floor but HURTS a ceiling, so a knob that raises a floored cell wants
 * to be at its max, a knob that raises a ceilinged cell at its min. If a knob would have to move BOTH ways — it
 * relaxes one band by tightening another (a floor↔ceiling coupling, or a `point` band which is both at once) —
 * there is no universal relaxing corner and we return `null`, so the search declines honestly rather than
 * guessing. For the floor-only designs the suite spans this is always the all-max corner.
 */
function witnessCorner(cls: Classification, model: Model, sizingBands: readonly BandConstraint[]): number[] | null {
  const knobs = model.knobs;
  const x: number[] = [];
  for (let i = 0; i < knobs.length; i++) {
    let wantUp = false;
    let wantDown = false;
    for (const b of sizingBands) {
      const s = bandSign(cls, i, b);
      if (s === 0) continue;
      if (b.point) return null; // a point cell driven by this knob: no relaxing corner exists
      if (b.floor !== undefined) (s > 0 ? (wantUp = true) : (wantDown = true)); // raising the cell relaxes the floor
      if (b.ceiling !== undefined) (s > 0 ? (wantDown = true) : (wantUp = true)); // raising the cell tightens the ceiling
      if (wantUp && wantDown) return null; // this knob relaxes one band by tightening another — coupled
    }
    const knob = knobs[i]!;
    x.push(wantDown ? knob.min : knob.max); // wantUp or unaffected → max; wantDown → min
  }
  return x;
}

/**
 * The BUDGET bands (a cost-ceiling generalisation of the monotone class): a pure CEILING whose cell only RISES
 * with the freed knobs (a non-negative sign on EVERY knob, and a positive one on at least one) — a cost/resource
 * budget. Such a ceiling is relaxed by LOWERING knobs, the OPPOSITE corner from the sizing floors, so the strict
 * `witnessCorner` reads it as a floor↔ceiling coupling and DECLINES. But the coupling is benign: the descent
 * toward a cost-minimising objective (or a repair that only ever raises a deficient knob) drives every knob — and
 * therefore the budget cell — to its LEAST value, i.e. exactly where the budget is most relaxed. So the search
 * EXCLUDES these from the witness/descent oracle and verifies the FULL band set (including them) once at the
 * descended optimum. A ceiling on a cell that also FALLS with some knob is genuinely non-monotone against the
 * ceiling and is NOT a budget (it stays in the sizing set, where the strict witness still declines the coupling).
 */
function budgetBandsOf(cls: Classification, model: Model): Set<BandConstraint> {
  const out = new Set<BandConstraint>();
  for (const b of model.bands) {
    if (b.point) continue; // a point pins from both sides — never a one-sided budget
    if (b.ceiling === undefined || b.floor !== undefined) continue; // must be a PURE ceiling
    let anyUp = false;
    let anyDown = false;
    for (let i = 0; i < model.knobs.length; i++) {
      const s = bandSign(cls, i, b);
      if (s > 0) anyUp = true;
      else if (s < 0) anyDown = true;
    }
    if (anyUp && !anyDown) out.add(b); // rises with the knobs, never falls ⇒ a budget relaxed by lowering them
  }
  return out;
}

/**
 * The feasible knob value CLOSEST to `target` along coordinate `i`, holding the other knobs fixed at `x` (which
 * is feasible). This is the exact per-knob inversion: if the whole way to `target` is feasible we take it;
 * otherwise the feasibility boundary lies between `target` (infeasible) and the current value (feasible), and we
 * bisect to it — the engine evaluator deciding each probe. Returned is always the FEASIBLE side of the boundary,
 * so the assignment never crosses a band.
 */
function boundaryToward(ctx: Ctx, x: readonly number[], i: number, target: number): number {
  const here = x[i]!;
  if (target === here) return here;
  const probe = (v: number): boolean => {
    const y = x.slice();
    y[i] = v;
    return feasible(ctx, y);
  };
  if (probe(target)) return target; // the objective-improving extreme is itself feasible — go all the way
  // Bisect the boundary: `feas` stays feasible, `inf` stays infeasible, converging to the exact threshold.
  let feas = here;
  let inf = target;
  for (let step = 0; step < MAX_BISECT; step++) {
    const mid = (feas + inf) / 2;
    if (probe(mid)) feas = mid;
    else inf = mid;
    if (Math.abs(feas - inf) <= BISECT_TOL * Math.max(1, Math.abs(feas))) break;
  }
  return feas;
}

/**
 * Move every knob toward its per-knob `target` as far as feasibility allows, sweeping to a fixpoint. `target(i)`
 * is the value coordinate `i` WANTS: for optimize it is the objective-improving extreme (lower a cost-raising
 * knob), for repair it is the knob's current value (stay closest to the original design). Starting from the
 * feasible witness and only ever moving a knob to its feasibility boundary keeps the assignment feasible at every
 * step, so on the box-decomposable designs this class targets one sweep reaches the optimum; extra sweeps are a
 * cheap safety net that stop as soon as nothing moves.
 */
function descend(ctx: Ctx, start: readonly number[], target: (i: number) => number): number[] {
  const x = start.slice();
  const maxSweeps = Math.max(1, x.length) + 1;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let moved = false;
    for (let i = 0; i < x.length; i++) {
      const next = boundaryToward(ctx, x, i, target(i));
      if (Math.abs(next - x[i]!) > MOVE_EPS) moved = true;
      x[i] = next;
    }
    if (!moved) break;
  }
  return x;
}

/**
 * Whether any SHARED contention site can SATURATE across the knob box — the non-monotone processor-sharing boundary
 * (doc: request-classes §5.2) the native solver must DECLINE rather than guess. CONSERVATIVE by design: over-
 * declining is acceptable (the incumbent still solves those), a wrong `solved`/`infeasible` is not. A site declines
 * when BOTH:
 *   (1) TWO OR MORE classes actually contend at it (a single-class split is `min(cap, offered)` — monotone, so the
 *       native solver handles it exactly as the single river and there is nothing to decline); AND
 *   (2) EITHER its capacity is itself SIZED by a freed knob (the split couples capacity ↔ per-class flow, which the
 *       two-point corner classification cannot certify), OR its total offered at the all-max corner reaches its
 *       capacity there — total offered is monotone ↑ in the knobs, so all-max is its MAXIMUM, and a fixed capacity
 *       at or below that max is reachably saturated (ρ ≥ 1 for some assignment).
 * In the headroom regime — a shared node provably unsaturated at every reachable assignment (fixed capacity strictly
 * above the max total offered) — neither clause fires, so the native solver SOLVES and the differential stays green.
 */
function saturationDeclines(cls: Classification, model: Model): boolean {
  return model.contentions.some((s) => contentionSaturates(cls, model, s));
}

function contentionSaturates(cls: Classification, model: Model, s: Contention): boolean {
  const contenders = s.offeredCells.filter((c) => (cls.atMax.value(c) ?? 0) > REPORT_EPS).length;
  if (contenders < 2) return false; // single-class site: split reduces to min(cap, offered) — monotone, not declined
  const capSized = model.knobs.some((_, i) => cellSign(cls, i, s.capCell) !== 0);
  if (capSized) return true; // a sized shared capacity couples cap ↔ flow — not corner-certifiable, decline honestly
  const cap = cls.atMax.value(s.capCell);
  const tot = cls.atMax.value(s.totCell);
  if (cap === undefined || tot === undefined || !Number.isFinite(cap) || !Number.isFinite(tot)) return true; // cannot verify ⇒ decline
  return tot >= cap * SATURATION_RATIO; // max total offered reaches capacity ⇒ reachably saturated ⇒ decline
}

/** Build the context + classify + compute the witness — the shared front matter of all three searches. Returns
 *  a discriminated result so callers branch on: a build/monotonicity failure (→ did-not-converge), or a posed
 *  problem carrying the (ctx, classification, witness) and whether the witness is feasible. Optimize/repair read
 *  `witnessFeasible` as the exact feasibility verdict (infeasible ⇒ no assignment satisfies the bands); explain
 *  reads the witness values whether or not it is feasible — an infeasible witness is precisely the shortfall it
 *  reports. */
/** Honest true-cause reasons a monotone search returns with a `did-not-converge` (TASK-86 F1): the search NAMES
 *  why it stepped back, so the surface layer never dresses a structural decline as a "time limit". Each entry
 *  carries BOTH the human `text` (shown verbatim) AND the machine `code` (its {@link DidNotConvergeCode} class) so
 *  a consumer can gate on the class — e.g. escalate exactly `budget-coupling` to the reference MIP — without
 *  string-matching the prose. Domain-neutral solver vocabulary (the contract core greps clean of domain strings). */
const REASON = {
  notSteady: { code: 'not-steady', text: 'the design did not settle to a steady state (a feedback loop with no fixpoint)' },
  saturation: { code: 'saturation', text: 'a shared node can saturate under the declared request classes — processor-sharing is non-monotone there, so the in-process search cannot prove the optimum' },
  coupled: { code: 'coupled', text: 'an SLO lies outside the in-process solver’s monotone class (a point-target SLO, or a knob that relaxes one SLO while tightening another)' },
  budgetBinds: { code: 'budget-coupling', text: 'a budget-style ceiling (e.g. a total-cost limit) binds against the objective — resolving it needs a joint trade-off across knobs the in-process search cannot make' },
  budgetExplain: { code: 'budget-explain', text: 'this design carries a budget-style ceiling whose exact shortfall the single-corner explainer cannot measure' },
  evalBudget: { code: 'eval-budget', text: 'the search reached its evaluation budget without converging' },
  aborted: { code: 'aborted', text: 'the search was cancelled' },
} as const satisfies Record<string, { readonly code: DidNotConvergeCode; readonly text: string }>;

/** A `did-not-converge` from one of the named REASON entries — carrying its human text AND its machine code so the
 *  surface layer can gate on the class (see {@link DidNotConvergeCode}). The ONE place a native decline is minted. */
const decline = (r: { readonly code: DidNotConvergeCode; readonly text: string }): SearchResult<never> => didNotConvergeBecause(r.text, r.code);

type Prepared =
  | { readonly kind: 'declined'; readonly reason: string; readonly code: DidNotConvergeCode } // cannot pose or prove within the monotone class → did-not-converge (true cause + its class)
  | {
      readonly kind: 'posed';
      readonly ctx: Ctx;
      readonly cls: Classification;
      readonly witness: number[];
      /** Feasible on the SIZING bands at the witness — the exact feasibility verdict for the floors (an infeasible
       *  witness means no assignment meets the sizing floors, so the design is provably infeasible). Budget ceilings
       *  are verified separately at the descended optimum. */
      readonly witnessFeasible: boolean;
      /** Whether the design carries a BUDGET ceiling (a cost-like ceiling relaxed by lowering knobs). When true the
       *  witness/descent oracle excluded it and the caller must verify the full band set at the descended optimum;
       *  ExplainInfeasible declines such designs (its single-corner shortfall model cannot place a budget ceiling). */
      readonly hasBudget: boolean;
    };
function prepare(registry: Registry, graph: Graph, tunables: readonly Tunable[], headroom: Headroom | undefined, signal: AbortSignal | undefined, classes: readonly RequestClass[] | undefined, systemBands?: readonly SystemBand[]): Prepared {
  const declined = (r: { readonly code: DidNotConvergeCode; readonly text: string }): Prepared => ({ kind: 'declined', reason: r.text, code: r.code });
  const m = buildModel(graph, registry, tunables, classes, systemBands);
  if (!m.ok) return { kind: 'declined', reason: m.error.join('; '), code: 'model-error' }; // a malformed tunable / cyclic flow — the model names it
  const ctx: Ctx = { model: m.value, graph, headroom, headroomNodes: [], budgetBands: new Set(), signal, budget: MAX_EVALS };
  const cls = classify(ctx);
  if (!cls.atMax.converged) return declined(REASON.notSteady); // did not settle — honest ignorance, not infeasible
  // OUT OF THE MONOTONE CLASS when a shared node can SATURATE (doc: request-classes §5.2): the processor-sharing
  // split is non-monotone across classes there, so the corner classification cannot certify the optimum. Decline
  // honestly (the incumbent remains the solver of record for these — §5.3). In the headroom regime this never
  // fires, so multi-class designs whose shared nodes stay unsaturated still SOLVE.
  if (saturationDeclines(cls, m.value)) return declined(REASON.saturation);
  // The STRICT witness FIRST (every band in the corner) — byte-for-byte the pre-budget solver. It succeeds whenever
  // the bands do not couple a knob, and then a cost-like ceiling present on a knob at its min is already satisfied at
  // the witness and respected by the (all-band) descent oracle — so a design like the envelope's max-demand, whose
  // OVERFLOW ceiling rises with the demand knob, stays exactly as before (that ceiling is a genuine sizing bound, not
  // a budget). ONLY when the strict corner DECLINES (a knob pulled up by a floor and down by a cost ceiling — the
  // CQRS F1 coupling) do we relax: pull the BUDGET ceilings (pure ceilings that only RISE with the knobs, e.g. a
  // total-cost limit) OUT of the corner and the descent oracle, and re-verify them once at the descended optimum.
  let witness = witnessCorner(cls, m.value, m.value.bands);
  let budgetBands: ReadonlySet<BandConstraint> = new Set();
  if (witness === null) {
    const budgets = budgetBandsOf(cls, m.value);
    if (budgets.size > 0) {
      budgetBands = budgets;
      witness = witnessCorner(cls, m.value, m.value.bands.filter((b) => !budgets.has(b)));
    }
  }
  ctx.budgetBands = budgetBands;
  if (witness === null) return declined(REASON.coupled); // outside the monotone class (a point band / a genuine sizing coupling)
  // Precompute the headroom tiers ONCE, now that the classification exists (classify samples corners only — it
  // never calls feasible/headroomHolds — so filling this before the first feasibility probe below is safe).
  if (headroom !== undefined) ctx.headroomNodes = headroomNodesOf(graph, cls, m.value, headroom);
  return { kind: 'posed', ctx, cls, witness, witnessFeasible: feasible(ctx, witness), hasBudget: budgetBands.size > 0 };
}

/**
 * The cells whose SUM is the optimize objective: the single cumulative out-cell (the default), or — for a
 * `total` objective — every node's LOCAL contribution cell for the key that carries a value in the model. A sum
 * of monotone terms is monotone (each term only ever moves the same way with a knob on this class), so the
 * per-knob classification of the SUMMED response is exact on the same class the single-cell objective covers —
 * and for one cell the summed read degenerates to the single-cell read, byte-for-byte the prior behaviour.
 */
function objectiveCellsOf(objective: Objective, model: Model, graph: Graph, cls: Classification): CellId[] {
  if (objective.total !== true) return [model.outCell(objective.node, objective.key, objective.class)];
  const out: CellId[] = [];
  for (const node of graph.nodes.values()) {
    const cell = localCellIdOf(node.id, objective.key);
    if (cls.atMax.value(cell) !== undefined) out.push(cell); // only nodes with an own contribution for the key
  }
  return out;
}

/**
 * OPTIMIZE — the cheapest (or richest) feasible design (docs §3.2). Prove feasibility at the witness corner
 * (`infeasible` if it fails), then lower/raise each knob to the objective-improving feasibility boundary. The
 * returned solution reads any key's value back through the SAME evaluator, so the reported optimum is the
 * engine's own number.
 */
export function runOptimize(
  registry: Registry,
  req: { graph: Graph; tunables: readonly Tunable[]; objective: Objective; headroom?: Headroom; signal?: AbortSignal; classes?: readonly RequestClass[]; systemBands?: readonly SystemBand[] },
): SearchResult<OptimizeSolution> {
  try {
    // A TOTAL objective sums per-node LOCAL cells, which the per-class network splits per class — the class-blind
    // sum would silently ignore the declared classes, so the combination is declined honestly (mirrors the
    // incumbent's `optimizeModel` rejection of the same pairing).
    if (req.objective.total === true && req.classes !== undefined && req.classes.length > 0) {
      return didNotConvergeBecause('a total objective is not supported together with request classes', 'model-error');
    }
    const p = prepare(registry, req.graph, req.tunables, req.headroom, req.signal, req.classes, req.systemBands);
    if (p.kind === 'declined') return didNotConvergeBecause(p.reason, p.code);
    if (!p.witnessFeasible) return infeasible; // the max-slack corner misses a band ⇒ provably infeasible
    const { ctx, cls, witness } = p;
    const model = ctx.model;

    // The objective-improving direction per knob: to MINIMISE a key that rises with a knob, lower the knob; to
    // MAXIMISE it, raise it (and the mirror for a key that falls with the knob). A knob the objective does not
    // depend on is left at the witness — moving it cannot improve the objective and might only cost evaluations.
    // Under classes the objective may name a class (a non-flow key's per-class value); `outCell` reads that cell.
    // A TOTAL objective reads the SUM of the local cells instead — the per-knob sign of the summed response —
    // so a knob that prices an OFF-PATH branch (invisible to any single out-cell) still descends.
    const objCells = objectiveCellsOf(req.objective, model, req.graph, cls);
    const sumAt = (snap: { value(cell: CellId): number | undefined } | undefined): number | undefined => {
      if (snap === undefined) return undefined;
      let sum = 0;
      let any = false;
      for (const cell of objCells) {
        const v = snap.value(cell);
        if (v === undefined) continue;
        any = true;
        sum += v;
      }
      return any ? sum : undefined;
    };
    const wantLower = req.objective.direction === 'min';
    const target = (i: number): number => {
      const s = signFrom(sumAt(cls.atMax), sumAt(cls.atKnobMin[i]));
      if (s === 0) return witness[i]!; // objective independent of this knob → do not move it
      const lower = wantLower ? s > 0 : s < 0; // improving move is "lower this knob"?
      const knob = model.knobs[i]!;
      return lower ? knob.min : knob.max;
    };

    const x = descend(ctx, witness, target);
    const finalEv = evalAt(ctx, x);
    if (!finalEv.converged) return decline(REASON.notSteady);
    // VERIFY the FULL band set (including any budget ceiling) at the descended optimum. When it holds, the point
    // genuinely satisfies every declared band AND is optimal (the descent minimised the objective subject to the
    // sizing floors, and a slack budget did not restrict that optimum). When a budget ceiling FAILS here the
    // descended point breaches a declared ceiling — the budget genuinely binds against this objective, a joint
    // trade-off the per-knob inversion cannot resolve — so the search DECLINES honestly (never returns a point
    // that violates a ceiling, and never a guessed `infeasible` that a knob trade-off might disprove).
    if (p.hasBudget && !feasibleFull(ctx, x)) return decline(REASON.budgetBinds);
    const assignments = model.knobs.map((k, i) => ({ node: k.node, key: k.key, value: x[i]! }));
    const solution: OptimizeSolution = {
      assignments,
      value: (node: NodeId, key: Key, cls?) => finalEv.value(model.outCell(node, key, cls)),
    };
    return solved(solution);
  } catch (e) {
    if (e instanceof Halt) return decline(haltReason(e)); // budget exhausted or aborted — honest, named
    throw e; // a genuine programmer error is not swallowed
  }
}

/** The honest reason a Halt unwind carries — an evaluation-budget backstop or a caller cancellation. */
const haltReason = (h: Halt): { readonly code: DidNotConvergeCode; readonly text: string } => (h.reason === 'aborted' ? REASON.aborted : REASON.evalBudget);

/**
 * REPAIR — the smallest edit that makes every band hold (docs §3.3). Same feasibility front matter as optimize
 * (`infeasible` if even the witness fails), but each knob is drawn toward its CURRENT value: a knob already
 * compatible with feasibility snaps back to its current (zero edit), a deficient knob stops at its feasibility
 * boundary (the minimal raise). Minimising each knob's move independently minimises the total L1 edit distance
 * on these box-decomposable designs — the incumbent's L1-MIP objective — so the oracle certifies the same
 * minimal measure.
 */
export function runRepair(
  registry: Registry,
  req: { graph: Graph; tunables: readonly Tunable[]; headroom?: Headroom; signal?: AbortSignal; classes?: readonly RequestClass[]; systemBands?: readonly SystemBand[] },
): SearchResult<readonly Change[]> {
  try {
    const p = prepare(registry, req.graph, req.tunables, req.headroom, req.signal, req.classes, req.systemBands);
    if (p.kind === 'declined') return didNotConvergeBecause(p.reason, p.code);
    if (!p.witnessFeasible) return infeasible; // no assignment satisfies the bands ⇒ nothing to repair to
    const { ctx, witness } = p;
    const knobs = ctx.model.knobs;

    const x = descend(ctx, witness, (i) => knobs[i]!.current); // draw each knob back toward the original design
    // VERIFY the FULL band set (including any budget ceiling) at the repaired point. The sizing descent produced
    // the minimal L1 edit that meets the floors; if the budget also holds there it is the minimal repair (any
    // feasible repair must meet the floors, and this is the least-edit floor-feasible point). If a budget ceiling
    // fails, a feasible repair might still exist by TRADING knobs on the shared budget — which the per-knob
    // inversion cannot find — so the search declines honestly rather than claim infeasible or emit a breaching edit.
    if (p.hasBudget && !feasibleFull(ctx, x)) return decline(REASON.budgetBinds);
    const changes: Change[] = knobs
      .map((k, i) => ({ node: k.node, key: k.key, from: k.current, to: x[i]!, delta: Math.abs(x[i]! - k.current) }))
      .filter((c) => c.delta > REPORT_EPS); // report only the knobs that actually had to move (facade parity)
    return solved(changes);
  } catch (e) {
    if (e instanceof Halt) return decline(haltReason(e));
    throw e;
  }
}

/**
 * EXPLAIN-INFEASIBLE — the exact shortfall of each SLO (docs §3.4). Evaluate the design at the witness corner —
 * the assignment that maximises every band's slack, i.e. the penalty-minimising point the incumbent's relaxed
 * MIP also lands on — and read off, per band, HOW FAR the best-achievable value still misses: `floor − value`
 * for a floor, `value − ceiling` for a ceiling. A design with no shortfall (every band reachable) returns an
 * empty set; the relaxed problem is always answerable, so the only non-`solved` outcome is honest
 * non-convergence (aborted / budget / outside the monotone class). Never `infeasible` — a shortfall is the
 * ANSWER, not a failure.
 */
export function runExplain(
  registry: Registry,
  req: { graph: Graph; tunables: readonly Tunable[]; signal?: AbortSignal; classes?: readonly RequestClass[] },
): SearchResult<readonly Shortfall[]> {
  try {
    const p = prepare(registry, req.graph, req.tunables, undefined, req.signal, req.classes);
    if (p.kind === 'declined') return didNotConvergeBecause(p.reason, p.code);
    // A BUDGET ceiling has its LEAST shortfall at the OPPOSITE corner from the sizing floors, so no single witness
    // measures both a floor's and a budget's shortfall. ExplainInfeasible's one-corner model cannot place it, so a
    // design carrying a budget ceiling is declined honestly (the incumbent remains the explainer of record there).
    if (p.hasBudget) return decline(REASON.budgetExplain);
    // The witness values are read whether or not the witness is FEASIBLE: an infeasible witness is exactly the
    // case with a floor missed — the shortfall this capability measures. (The witness maximises every band's
    // slack, so `floor − value(witness)` is the SMALLEST unavoidable miss, matching the incumbent's relaxed MIP.)
    const { ctx, witness } = p;
    const ev = evalAt(ctx, witness);
    if (!ev.converged) return decline(REASON.notSteady);
    const shortfalls: Shortfall[] = [];
    for (const b of ctx.model.bands) {
      const v = bandValue(ev, b);
      if (v === undefined || !Number.isFinite(v)) continue; // a keyless band cannot have a measured shortfall
      collectShortfall(b, v, shortfalls);
    }
    return solved(shortfalls);
  } catch (e) {
    if (e instanceof Halt) return decline(haltReason(e));
    throw e;
  }
}

/** Append the shortfall a band shows at value `v` (0 ⇒ satisfied, so nothing is appended). A floor short reports
 *  `floor − v`; a ceiling over reports `v − ceiling`; a point reports the missed side. Only shortfalls above the
 *  report epsilon are emitted, matching the incumbent facade's penalty filter. */
function collectShortfall(b: BandConstraint, v: number, out: Shortfall[]): void {
  if (b.point) {
    const target = b.floor ?? b.ceiling ?? 0;
    const lack = target - v;
    if (lack > REPORT_EPS) out.push({ node: b.node, key: b.key, bound: 'point', amount: lack });
    else if (v - target > REPORT_EPS) out.push({ node: b.node, key: b.key, bound: 'point', amount: v - target });
    return;
  }
  if (b.floor !== undefined && b.floor - v > REPORT_EPS) out.push({ node: b.node, key: b.key, bound: 'floor', amount: b.floor - v });
  if (b.ceiling !== undefined && v - b.ceiling > REPORT_EPS) out.push({ node: b.node, key: b.key, bound: 'ceiling', amount: v - b.ceiling });
}
