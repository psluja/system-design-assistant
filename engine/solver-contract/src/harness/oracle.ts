// @algorithm Oracle answer certification (fan-safe whole-graph total inversion)
// @problem The differential suite needs each generated instance's CERTIFIED answer, distilled to the
//   equivalence surface (honesty kind + objective value + SLO satisfaction) — including a whole-graph
//   objective total that no single cumulative out-cell accumulates on fan-out designs.
// @approach Run the answering adapter (the incumbent binds here) through the same contract call the
//   candidate uses; read the whole-graph total by INVERTING the cumulative out-cells —
//   sum over nodes of out(n) minus sum over edges of out(parent) — the exact inverse of the sum
//   aggregation, correct under fan-in/fan-out; re-evaluate the returned assignment to record
//   epsilon-tolerant SLO satisfaction facts.
// @complexity O(nodes + edges) for the inversion plus one adapter re-evaluation per instance.
// @citations None (algebraic inversion of the network's own cumulative-sum fold).
// @invariants Engine-core-pure (the adapter is a parameter — no WASM, no engine-solve import);
//   nothing cached to disk (answers certified in-run); the distilled surface is exactly the
//   contract's equivalence, no more.
// @where-tested engine/solver-contract/src/harness/oracle.test.ts

// THE ORACLE HARNESS — the ORACLE (docs/design/solver-contract.html §4). The incumbent adapter
// (native MiniZinc/COIN-BC + clingo — the forever referee) answers every generated instance, and its answer is
// taken as CERTIFIED: this is the reference a candidate solver is graded against. The oracle
// runs the SAME contract the candidate does — `makeIncumbentAdapter` behind the `SolverBindings` interface — so
// "the oracle answers instance I" and "the candidate answers instance I" are literally the same call shape, and
// the harness compares two `SearchResult`s by the CONTRACT's equivalence (objective value + SLO satisfaction).
//
// WHY the oracle IS the incumbent (not a hand-written expected table): the whole point of is to replace
// the generic solver at RUNTIME while keeping it as the TEST-TIME truth. So the reference must be the generic
// solver, not a fixture — a fixture would only re-encode a human's belief about the answer. The incumbent is
// exact (it is the MIP/ASP solver itself), so its answer, distilled to {kind, objective value, SLO satisfaction},
// is the certified oracle answer. Cache nothing to disk in v1 (owner ruling): answers are computed in-run, and
// the corpus is sized so the whole batch certifies inside a CI budget.
//
// This module is engine-core-PURE: it takes the answering adapter as a PARAMETER (the oracle binds the
// incumbent; the harness binds the candidate), so it imports NEITHER ../incumbent NOR @sda/engine-solve — only
// the contract's own types + engine-core. The heavy solver deps live in the incumbent adapter the caller
// constructs and passes in; this file pulls in no WASM and no native binary, so it stays portable to a second
// solver (dependency.test.ts). The oracle-vs-candidate distinction is just WHICH adapter a caller passes here.

import type { Key, NodeId } from '@sda/engine-core';
import { closeEnough, type SolverBindings } from '../bindings';
import type { Change, Objective, Selection, Shortfall, Tunable } from '../capability';
import type { OptimizeSolution } from '../capability/optimize';
import type { SearchResult } from '../honesty';
import type { EnumerateInstance, GeneratedInstance, NumericInstance } from './generator';

/**
 * A CERTIFIED oracle answer for a numeric instance, distilled to the CONTRACT's equivalence surface (docs §5,
 * owner ruling 2026-07-03: equivalence = objective value + SLO satisfaction, NOT the knob vector). Two solvers
 * that reach the same objective while satisfying the same SLOs are equivalent even with different assignments —
 * so the oracle records the OBSERVABLE facts a candidate must reproduce, not the incumbent's internal choices:
 *  - `kind`           — solved / infeasible / did-not-converge (the honesty triad; must match exactly);
 *  - `objectiveValue` — the optimum's objective value (float-tolerant compare); undefined unless `solved`;
 *  - `sloSatisfied`   — whether the returned assignment makes every declared band hold (the anti-lie fact).
 * For repair/explain the answer instead carries the certified change/shortfall SET (see the union below).
 */
export interface NumericOracleAnswer {
  readonly kind: SearchResult<unknown>['kind'];
  /** The certified optimum objective value (optimize only; undefined for a non-`solved` result). */
  readonly objectiveValue?: number;
  /** Whether the incumbent's returned assignment satisfies every SLO (optimize/repair `solved` results). */
  readonly sloSatisfied?: boolean;
  /** The certified minimal-change set (repair only): sorted by (node,key) for a stable compare. */
  readonly changes?: readonly Change[];
  /** The certified shortfall set (explainInfeasible only): sorted by (node,key,bound) for a stable compare. */
  readonly shortfalls?: readonly Shortfall[];
}

/** A CERTIFIED oracle answer for an enumerate instance: the honesty kind and — when enumerated — the EXACT
 *  canonical selection set (docs §5: exact for Enumerate). Empty selections is a valid `enumerated` (UNSAT). */
export interface EnumerateOracleAnswer {
  readonly kind: 'enumerated' | 'did-not-converge';
  readonly selections?: readonly Selection[];
}

/** The oracle's answer for any instance, tagged to match the instance's kind. */
export type OracleAnswer =
  | { readonly kind: 'numeric'; readonly answer: NumericOracleAnswer }
  | { readonly kind: 'enumerate'; readonly answer: EnumerateOracleAnswer };

/** A stable key for a (node,key) pair so change/shortfall sets compare independent of solver ordering. */
const nk = (x: { readonly node: string; readonly key: string }): string => `${x.node}|${x.key}`;
const sortChanges = (cs: readonly Change[]): readonly Change[] => [...cs].sort((a, b) => nk(a).localeCompare(nk(b)));
const sortShortfalls = (ss: readonly Shortfall[]): readonly Shortfall[] =>
  [...ss].sort((a, b) => `${nk(a)}|${a.bound}`.localeCompare(`${nk(b)}|${b.bound}`));

/**
 * Ask an adapter a numeric instance's question and distil the answer to the certified equivalence surface. Used
 * for BOTH the oracle (bound to the incumbent) and — inside the harness — the candidate (bound to the solver
 * under test), so the two are compared apples-to-apples. `sloSatisfied` is computed by re-running the adapter's
 * OWN evaluate on the returned assignment: it re-reads the design under the solved knob values and checks no
 * band is violated — the honest "does this answer actually hold" the contract cares about.
 */
export async function answerNumeric(adapter: SolverBindings, instance: NumericInstance): Promise<NumericOracleAnswer> {
  // Thread the declared request classes (doc: request-classes §3) AND the system bands (the whole-graph sum
  // constraints) so BOTH the oracle and the candidate answer the identical question; absent ⇒ an existing
  // instance's request is unchanged.
  const req = {
    graph: instance.graph,
    tunables: instance.tunables,
    ...(instance.classes !== undefined ? { classes: instance.classes } : {}),
    ...(instance.systemBands !== undefined ? { systemBands: instance.systemBands } : {}),
  };
  switch (instance.capability) {
    case 'optimize': {
      if (adapter.optimize === undefined) return { kind: 'did-not-converge' };
      const r = await adapter.optimize({ ...req, objective: instance.objective });
      if (r.kind !== 'solved') return { kind: r.kind };
      const objectiveValue = readObjective(r.value, instance.objective, instance.graph);
      // Spread `objectiveValue` only when defined — exactOptionalPropertyTypes forbids an explicit `undefined`
      // on an optional field, and "absent" is the honest reading when the objective key has no value.
      return {
        kind: 'solved',
        ...(objectiveValue !== undefined ? { objectiveValue } : {}),
        sloSatisfied: assignmentSatisfiesSlos(adapter, instance, r.value),
      };
    }
    case 'repair': {
      if (adapter.repair === undefined) return { kind: 'did-not-converge' };
      const r = await adapter.repair(req);
      if (r.kind !== 'solved') return { kind: r.kind };
      return { kind: 'solved', changes: sortChanges(r.value) };
    }
    case 'explainInfeasible': {
      if (adapter.explainInfeasible === undefined) return { kind: 'did-not-converge' };
      const r = await adapter.explainInfeasible(req);
      if (r.kind !== 'solved') return { kind: r.kind };
      return { kind: 'solved', shortfalls: sortShortfalls(r.value) };
    }
  }
}

/** Ask an adapter an enumerate instance's question and distil to the certified selection set (or the honesty
 *  kind). Selections come back in the adapter's canonical order; the harness compares them as sets/ordered. */
export async function answerEnumerate(adapter: SolverBindings, instance: EnumerateInstance): Promise<EnumerateOracleAnswer> {
  if (adapter.enumerate === undefined) return { kind: 'did-not-converge' };
  const r = await adapter.enumerate({ problem: instance.problem });
  if (r.kind !== 'enumerated') return { kind: 'did-not-converge' };
  return { kind: 'enumerated', selections: r.selections };
}

/** The one dispatch a caller needs: answer ANY generated instance with the given adapter, tagged by kind. */
export async function answer(adapter: SolverBindings, instance: GeneratedInstance): Promise<OracleAnswer> {
  return instance.kind === 'numeric'
    ? { kind: 'numeric', answer: await answerNumeric(adapter, instance) }
    : { kind: 'enumerate', answer: await answerEnumerate(adapter, instance) };
}

/** Read the objective's value back through the solution's `value(node,key)` reader (the observable optimum). Under
 *  request classes the objective may name a class (a non-flow key's per-class value), so its class is passed. A
 *  TOTAL objective (`total: true` — the sum of every node's OWN contribution) is read by inverting the cumulative
 *  out-cells over the graph: Σ_n out(n) − Σ_{edges p→n} out(p) — the exact inverse of the sum-aggregation
 *  `out = local + Σ in`, so both adapters' solutions are read through ONE formula and compared apples-to-apples. */
function readObjective(sol: OptimizeSolution, objective: Objective, graph: NumericInstance['graph']): number | undefined {
  if (objective.total !== true) return sol.value(objective.node, objective.key, objective.class);
  return wholeGraphTotal((node, key) => sol.value(node, key), objective.key, graph);
}

/** The WHOLE-GRAPH total of a sum-aggregated key, read by inverting the cumulative out-cells: Σ_n out(n) −
 *  Σ_{edges p→n} out(p) — the exact inverse of the sum-aggregation `out = local + Σ in` (fan-safe: a shared
 *  predecessor is subtracted once per edge). ONE formula for the total objective's read-back AND the system-band
 *  satisfaction check, so both adapters' solutions are measured through the identical arithmetic. */
function wholeGraphTotal(
  read: (node: NodeId, key: Key) => number | undefined,
  key: Key,
  graph: NumericInstance['graph'],
): number | undefined {
  let sum = 0;
  let any = false;
  for (const node of graph.nodes.values()) {
    const v = read(node.id, key);
    if (v === undefined) continue;
    any = true;
    sum += v;
  }
  for (const edge of graph.edges.values()) {
    const from = graph.ports.get(edge.from)?.node;
    if (from === undefined) continue;
    sum -= read(from, key) ?? 0; // subtract the carried-in cumulative once per edge (fan-safe)
  }
  return any ? sum : undefined;
}

/**
 * Whether the solved assignment ACTUALLY satisfies every SLO — the anti-lie fact. We re-read the design under
 * the solver's chosen knob values with the adapter's OWN evaluate (the synchronous hot path both adapters share)
 * and check every declared scalar band against the computed value AT THE CONTRACT's shared tolerance
 * (`closeEnough`, ε = 1e-4), the SAME tolerance the objective value is compared at (docs §5).
 *
 * WHY the tolerance (and why the verdict layer's strict `<` is the wrong test HERE). At the optimum a floor SLO
 * is an ACTIVE constraint: the cheapest feasible design places the flow EXACTLY on the floor. Two exact solvers
 * then legitimately straddle that boundary by a few ULPs — a MIP's continuous optimum lands a hair BELOW (COIN-BC
 * feasibility tolerance), a bisection a hair ABOVE — so a strict `value < min` re-evaluation would read the MIP's
 * own optimum as a violation while reading the bisection's as satisfied, and reject a SECOND CORRECT solver for a
 * float artifact. Judging satisfaction within ε (as the objective already is) makes the anti-lie fact measure a
 * REAL miss, not the boundary noise: a genuinely violating assignment (short by more than ε) still reads false, so
 * a lying `solved` is still caught — the check's intent — while two ε-equivalent optima agree. (Percentile bands
 * are DES-verified, never a forward value, so they are skipped here exactly as the search models skip them.)
 */
function assignmentSatisfiesSlos(adapter: SolverBindings, instance: NumericInstance, sol: OptimizeSolution): boolean {
  // Overlay the solved knob values as fixed inputs on the graph, then evaluate. The overlay is a pure
  // engine-core transformation (rewrite the tunable cells' fixed quantities), so it stays domain-agnostic. Under
  // request classes the re-evaluation must fold per class too (else the mesh reads as a cycle) — the flow-total
  // band is then read class-blind off the unindexed cell, exactly the fact the solver constrained.
  const overlaid = overlayAssignment(instance, sol);
  const ev = adapter.evaluate({ graph: overlaid, ...(instance.classes !== undefined ? { classes: instance.classes } : {}) });
  if (!ev.ok || !ev.value.converged) return false;
  for (const node of instance.graph.nodes.values()) {
    for (const cell of node.cells) {
      if (cell.kind !== 'input' || cell.value.kind !== 'band') continue;
      const band = cell.value.band;
      if (band.shape === 'percentiles') continue; // a tail SLO is DES-verified, not a forward value
      const v = ev.value.value(node.id, cell.key);
      if (v === undefined || !Number.isFinite(v)) return false; // no computable value ⇒ cannot claim satisfied
      if (band.shape === 'minTargetMax') {
        if (band.min !== undefined && v < band.min && !closeEnough(v, band.min)) return false;
        if (band.max !== undefined && v > band.max && !closeEnough(v, band.max)) return false;
      } else if (Math.abs(v - band.target) > 1e-9 && !closeEnough(v, band.target)) {
        return false; // point band: must hit the target within ε
      }
    }
  }
  // The SYSTEM bands (whole-graph sum constraints) must hold at the returned assignment too — the same anti-lie
  // fact, measured through the SAME whole-graph inversion the total objective is read with (one formula, both
  // adapters), at the contract's shared ε (an active ceiling is a boundary two exact solvers legitimately
  // straddle). The inversion walks `instance.graph`'s SHAPE — the overlay rewrites cell values, never topology.
  for (const sb of instance.systemBands ?? []) {
    const total = wholeGraphTotal((node, key) => ev.value.value(node, key), sb.key, instance.graph);
    if (total === undefined || !Number.isFinite(total)) return false;
    if (sb.floor !== undefined && total < sb.floor && !closeEnough(total, sb.floor)) return false;
    if (sb.ceiling !== undefined && total > sb.ceiling && !closeEnough(total, sb.ceiling)) return false;
  }
  return true;
}

/** Rewrite the tunable cells' fixed throughput to the solved values, producing a graph with the knobs pinned.
 *  Pure engine-core surgery over the graph maps; no solver and no domain knowledge. */
function overlayAssignment(instance: NumericInstance, sol: OptimizeSolution): NumericInstance['graph'] {
  const byNode = new Map<string, number>();
  for (const t of instance.tunables) {
    const v = sol.value(t.node, t.key);
    if (v !== undefined) byNode.set(`${t.node}|${t.key}`, v);
  }
  const nodes = new Map(instance.graph.nodes);
  for (const [id, node] of nodes) {
    let changed = false;
    const cells = node.cells.map((c) => {
      if (c.kind !== 'input' || c.value.kind !== 'fixed') return c;
      const key = `${id}|${c.key}`;
      const v = byNode.get(key);
      if (v === undefined) return c;
      changed = true;
      return { ...c, value: { kind: 'fixed' as const, quantity: { ...c.value.quantity, value: v } } };
    });
    if (changed) nodes.set(id, { ...node, cells });
  }
  return { nodes, ports: instance.graph.ports, edges: instance.graph.edges };
}

/** Re-export the tunable/objective types callers thread through — a convenience so a harness file imports one
 *  module. (Types only; no runtime coupling.) */
export type { Tunable, Objective };
