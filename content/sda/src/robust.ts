// @algorithm Robust sizing by per-world solve + knob-wise max
// @problem A design sized against ONE point of the assumption space is fragile; the search must find
//   the cheapest configuration that holds every SLO across ALL selected worlds — with no new solver.
// @approach Run the same injected repair/optimize once per world (base world always included), then
//   combine by taking each provisioning knob's MAXIMUM across the per-world solutions — sound
//   because every provisioning knob is monotone capacity-increasing, so max(worlds) satisfies each
//   world at once; the world supplying a knob's max is derived as its binding constraint; the
//   combined graph is re-verified in every world and any residual violation DECLINES honestly.
// @complexity O(|worlds| + 1) injected solves + O(knobs * worlds) max reduction + O(|worlds|)
//   verification evaluations.
// @citations Robust optimization framing (Ben-Tal & Nemirovski, scenario-based reduction); the
//   monotone knob-wise-max argument is stated inline.
// @invariants Binding worlds are derived from actual per-world solves, never assumed; verification
//   is mandatory — a combination that fails any world returns did-not-converge, not a guess;
//   deterministic given the injected solver.
// @where-tested content/sda/src/robust.test.ts, content/sda/src/robustness.property.test.ts

// @feature Robust improve (across worlds)
// @story Size the design to the cheapest configuration that holds every SLO in ALL selected worlds,
//   not just the "real" one.
// @surfaces mcp (optimize/repair with worlds, app/mcp/src/search.ts), vscode (Improve,
//   app/vscode/src/solver-host.ts)
// @algorithms content/sda/src/robust.ts, engine/solver-contract/src/native/search.ts
// @docs none
// @e2e none (property + unit: content/sda/src/robustness.property.test.ts)
// @status shipped (surfaced through the search tools, no standalone tool name)

import type { Graph } from '@sda/engine-core';
import type { EvaluateBatch, Headroom, Objective, Optimize, Repair } from '@sda/solver-contract';
import { keys } from './registry';
import { provisioningTunables, quantizeKnob } from './provision';
import { TARGET_UTILIZATION } from './behaviors';
import { applyScenarioToGraph, evaluateWorlds, type AssumptionScenario } from './scenario';
import type { Instance, Wire } from './manifest';

// ROBUST IMPROVE ACROSS WORLDS (assumption-model doc §8, "Improve → a robust objective becomes expressible"). The
// existing backward search sizes a design against ONE point in the assumption space; a design proven only against
// "real" is a fragile design. Robust improve sizes it to hold every SLO in ALL selected worlds — "the cheapest
// configuration that holds all SLOs across the selected worlds" (doc §8) — with NO new solver: the same native
// binding, run once per world (each world = the same design with different fact-assumption INPUT values, overlaid via
// the ~1 ms native path), then the knob values COMBINED.
//
// THE MECHANISM — per-world solve + knob-wise max (the honest reduction of "N constraint sets on the same knobs"):
//   1. For every selected world (+ the base world, always), overlay its fact-assumption overrides onto the graph and
//      run the SAME repair/optimize the single-world search runs — giving the knob values THAT world needs.
//   2. The robust sizing is the knob-wise MAXIMUM across the per-world solutions: each provisioning knob raised to the
//      largest value any world required. Because every provisioning knob is capacity-increasing (concurrency /
//      replicas / throughput / maxUnits — more is monotonically better for every SLO), a knob at max(worlds) satisfies
//      each world at once — so the combined sizing holds ALL worlds. The world that supplied a knob's max is the
//      constraint that BINDS it (doc §8: "the binding constraint per band is the world that stresses it most" — for
//      the trio's monotone demand that is the max-demand/pessimistic world, but it is DERIVED per knob from the actual
//      per-world solve, never assumed).
//   3. VERIFY: the combined graph is re-evaluated in every world (`evaluateWorlds`). If a world still violates — the
//      max-combine left the monotone class — we DECLINE honestly (`did-not-converge`) naming that world, never a
//      silent lie. If a world's own solve is infeasible / non-convergent, we surface that naming the world.
//
// PURE aside from the injected solver capabilities (repair/optimize/evaluateBatch) — the same DI'd contract every
// other search rides. Default-off at the tool layer: with no selected world the base search path is untouched.

/** The ρ ≤ TARGET_UTILIZATION headroom every tier is sized to (matching the single-world search) — finite queueing
 *  latency, not the ρ = 1 knife-edge. One behaviour for the base search and the robust one. */
const HEADROOM: Headroom = { key: keys.throughput, factor: TARGET_UTILIZATION };

/** Everything a robust search reads: the base graph + design structure (for the roll-up / verification) and the
 *  SELECTED named worlds. The base world (the design as authored) is ALWAYS included implicitly — a robust design
 *  must hold as authored too — so an empty `worlds` degenerates to a plain single-graph search over the base world. */
export interface RobustInput {
  readonly graph: Graph;
  readonly instances: readonly Instance[];
  readonly wires: readonly Wire[];
  readonly worlds: readonly AssumptionScenario[];
  readonly signal?: AbortSignal;
}

/** One robust knob change: the coordinate, the robust target (the knob-wise max across worlds, quantized as
 *  `set_config` would apply it), and which world required that value — the constraint that BINDS the knob (doc §8). */
export interface RobustChange {
  readonly node: string;
  readonly key: string;
  readonly value: number;
  /** `'base'` or a scenario id — the world whose independent solve required this (the binding constraint). */
  readonly bindingWorld: string;
}

/** The honest outcome of a robust search (mirroring the single-world `SearchResult` triad, plus WHICH world drove a
 *  non-solved answer). `solved` carries the combined changes + the ids of every world it holds in. */
export type RobustOutcome =
  | { readonly kind: 'solved'; readonly changes: readonly RobustChange[]; readonly worlds: readonly string[] }
  | { readonly kind: 'infeasible'; readonly world: string }
  | { readonly kind: 'did-not-converge'; readonly world: string; readonly reason?: string };

/** The full world set a robust search covers: the base world (the design as authored) FIRST, then each selected named
 *  world. Base is `{ overrides: [] }`, so `applyScenarioToGraph` leaves the graph unchanged for it. */
function worldSet(worlds: readonly AssumptionScenario[]): AssumptionScenario[] {
  return [{ id: 'base', overrides: [] }, ...worlds];
}

/** Overlay the robust knob values onto the base graph — the SAME fixed-input-cell surgery the world overlay uses (a
 *  provisioning knob is itself a fixed input cell). The result is the design at its robust sizing, for verification
 *  and for the caller to enact. */
function applyKnobs(graph: Graph, changes: readonly RobustChange[]): Graph {
  return applyScenarioToGraph(graph, { id: '__robust__', overrides: changes.map((c) => ({ node: c.node, key: c.key, value: c.value })) });
}

/** Fold one per-world solution's `(node, key) → target` into the knob-wise-max accumulator, remembering which world
 *  supplied each knob's largest value (the binding world). */
function accumulate(perKnob: Map<string, RobustChange>, node: string, key: string, target: number, world: string): void {
  const coord = `${node}|${key}`;
  const prev = perKnob.get(coord);
  if (prev === undefined || target > prev.value) perKnob.set(coord, { node, key, value: target, bindingWorld: world });
}

/** Combine the per-world knob requirements into the robust sizing, then VERIFY it holds in every world — declining
 *  honestly (naming the world) if the max-combine left the monotone class. Shared by robust repair + optimize. */
async function finalize(input: RobustInput, worlds: readonly AssumptionScenario[], perKnob: Map<string, RobustChange>, evaluateBatch: EvaluateBatch): Promise<RobustOutcome> {
  const worldIds = worlds.map((w) => w.id);
  const changes = [...perKnob.values()];
  if (changes.length === 0) return { kind: 'solved', changes: [], worlds: worldIds };
  const solved = applyKnobs(input.graph, changes);
  const ver = await evaluateWorlds(
    { graph: solved, instances: input.instances, wires: input.wires, scenarios: input.worlds, ...(input.signal ? { signal: input.signal } : {}) },
    evaluateBatch,
  );
  const stillBad = ver.worlds.find((w) => !w.feasible);
  if (stillBad !== undefined) {
    return { kind: 'did-not-converge', world: stillBad.id, reason: 'the robust sizing (worst value per knob across worlds) did not hold this world — a non-monotone response; size the knobs manually' };
  }
  return { kind: 'solved', changes, worlds: worldIds };
}

/**
 * Robust REPAIR: the minimal knob change that makes every SLO hold in ALL selected worlds (+ base). Runs the injected
 * `repair` once per world and takes the knob-wise max of the proposed changes, then verifies. See the module header.
 */
export async function robustRepair(input: RobustInput, repair: Repair, evaluateBatch: EvaluateBatch): Promise<RobustOutcome> {
  const worlds = worldSet(input.worlds);
  const perKnob = new Map<string, RobustChange>();
  for (const w of worlds) {
    const wg = applyScenarioToGraph(input.graph, w);
    const r = await repair({ graph: wg, tunables: provisioningTunables(wg), headroom: HEADROOM, ...(input.signal ? { signal: input.signal } : {}) });
    if (r.kind === 'infeasible') return { kind: 'infeasible', world: w.id };
    if (r.kind === 'did-not-converge') return { kind: 'did-not-converge', world: w.id, ...(r.reason ? { reason: r.reason } : {}) };
    for (const c of r.value) accumulate(perKnob, String(c.node), String(c.key), quantizeKnob(String(c.key), c.to), w.id);
  }
  return finalize(input, worlds, perKnob, evaluateBatch);
}

/**
 * Robust OPTIMIZE: the objective (e.g. minimize cost) subject to every SLO holding in ALL selected worlds (+ base).
 * Runs the injected `optimize` once per world and takes the knob-wise max of the per-world optima, then verifies. For
 * a minimize-cost objective this is the robust minimum (each knob at its worst-world floor); the verification guards
 * the monotone assumption. See the module header.
 */
export async function robustOptimize(input: RobustInput, objective: Objective, optimize: Optimize, evaluateBatch: EvaluateBatch): Promise<RobustOutcome> {
  const worlds = worldSet(input.worlds);
  const perKnob = new Map<string, RobustChange>();
  for (const w of worlds) {
    const wg = applyScenarioToGraph(input.graph, w);
    const r = await optimize({ graph: wg, tunables: provisioningTunables(wg), objective, headroom: HEADROOM, ...(input.signal ? { signal: input.signal } : {}) });
    if (r.kind === 'infeasible') return { kind: 'infeasible', world: w.id };
    if (r.kind === 'did-not-converge') return { kind: 'did-not-converge', world: w.id, ...(r.reason ? { reason: r.reason } : {}) };
    for (const x of r.value.assignments) accumulate(perKnob, String(x.node), String(x.key), quantizeKnob(String(x.key), x.value), w.id);
  }
  return finalize(input, worlds, perKnob, evaluateBatch);
}
