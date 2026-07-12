// @algorithm Callable knob-vector evaluator over the cell network (the native search model)
// @problem The native search needs the design as an exactly-evaluable pure function
//   x -> (objective(x), band-values(x)) — computed by the SAME arithmetic the oracle certifies, so
//   the search can be exact about WHICH x it picks without re-implementing any math.
// @approach Constant-fold everything independent of the tunables, verify the derived residue is
//   acyclic (iterative-DFS cycle test — cyclic free flow is declined honestly), then evaluate by
//   overlaying x onto the tunable config cells and running the engine's own least-fixpoint solve();
//   bands lift to floor/ceiling constraints and processor-sharing contention sites are extracted so
//   the search can detect the saturation decline class.
// @complexity One engine solve per probe (O(sweeps * cells * expr)); cycle test and site extraction
//   linear in cells + refs; unbounded knob domains boxed to BOUND = 1e9 exactly like the incumbent.
// @citations None (structural reduction; the exactness argument rides the engine's fixpoint and the
// JS<->MiniZinc differential).
// @invariants Evaluation is engine-exact by construction (no drift possible); acyclicity is checked,
//   never assumed; knob boxing mirrors the incumbent so both solvers search the same space.
// @where-tested engine/solver-contract/src/native/model.test.ts

// THE NATIVE SOLVER — the search MODEL. The shared
// front-end every native search capability builds on: it turns a (graph, registry, tunables) triple into a small,
// exactly-evaluable model over the SAME cell network the JS hot path solves. This is our solver's answer to the
// incumbent's `compile()` (engine/solve/src/minizinc/search.ts) — but where that EMITS a MiniZinc string for an
// out-of-domain MIP, this exposes a CALLABLE evaluator, so we search in-process with zero WASM and zero spawn.
//
// WHY this is exact (the 100% rule). The incumbent's own `compile()` proves a structural fact we exploit: after
// freeing the tunables and constant-folding everything independent of them, EVERY other cell is a deterministic,
// acyclic function of the tunable vector (it rejects a cyclic free flow honestly — search.ts hasCycle). So the
// whole design is a pure function `x ↦ (objective(x), band-values(x))` of the freed knobs `x ∈ ∏[minᵢ,maxᵢ]`.
// We compute that function by OVERLAYING `x` onto the graph's tunable config cells and running the engine's own
// least-fixpoint `solve()` — the identical evaluator the hot path uses and the MiniZinc projector is differentially
// pinned against. The optimum is therefore read through the SAME arithmetic the oracle certifies, not a
// re-implementation that could drift. The search over `x` (native/search.ts) then only has to be exact about WHICH
// `x` it picks — the value AT an `x` is engine-exact by construction.
//
// This module is reached only from the ./native entry (like ./incumbent), so it may import @sda/engine-solve — the
// dependency lint scopes @sda/engine-solve to incumbent/ AND native/ (both are dynamically-imported adapter entries
// outside the runtime-shipped core). It pulls in NO WASM: buildNetwork/solve are pure TS (the numeric core), so the
// native adapter stays free of the 17.8 MB MiniZinc bundle — that is the whole point of.

import type { ClassId, Graph, Key, NodeId, Registry, Result } from '@sda/engine-core';
import { buildNetwork, solve, type Cell, type CellId, type Expr } from '@sda/engine-solve';
import type { RequestClass, SystemBand, Tunable } from '../capability';

/** A finite bound for a knob whose Tunable domain is not itself finite — mirrors the incumbent's `BOUND`
 *  (search.ts) so an unbounded `[0, Infinity]` domain is boxed identically to the MIP the oracle certifies. */
const BOUND = 1e9;
const finite = (x: number, fallback: number): number => (Number.isFinite(x) ? x : fallback);

/** One freed knob, resolved to the concrete config cell it drives, with its (finite) numeric domain and the
 *  value it holds in the un-searched graph (`current` — the L1-repair anchor, matching search.ts's `current`). */
export interface Knob {
  readonly node: NodeId;
  readonly key: Key;
  /** The `cfg:node:key` cell whose value this knob sets. */
  readonly cell: CellId;
  readonly min: number;
  readonly max: number;
  /** The knob's value in the original graph (before any search) — repair minimises Σ|new − current|. */
  readonly current: number;
}

/** A declared SLO band lifted to the cell(s) whose solved SUM it constrains, with the linear bounds a
 *  `minTargetMax`/`point` band imposes. A NODE band constrains the singleton [out(node,key)] (the value at that
 *  node — sum of one); a SYSTEM band (a whole-graph promise, e.g. a total-cost ceiling) constrains Σ over every
 *  node's `local(node,key)` cell — the exact cells a `total` objective sums, so the constraint, the objective and
 *  the verdict layer's whole-design total read ONE truth. A sum of same-signed monotone terms stays monotone, so
 *  the per-knob corner classification is exact on the summed response too. Percentile bands are EXCLUDED — a tail
 *  is not a value the forward model produces, exactly as the incumbent's `bandsOf` skips them (search.ts). */
export interface BandConstraint {
  readonly node: NodeId;
  readonly key: Key;
  /** The solved cells whose SUM must satisfy the band (a node band is the singleton [out(node,key)]). */
  readonly cells: readonly CellId[];
  /** A hard floor (band `min` / `point` lower side): the summed value must be ≥ this. */
  readonly floor?: number;
  /** A hard ceiling (band `max` / `point` upper side): the summed value must be ≤ this. */
  readonly ceiling?: number;
  /** True when this constraint came from a `point` band (both floor and ceiling equal `target`) — carried so
   *  ExplainInfeasible can report the `point` bound rather than a floor/ceiling (docs §3.4 Shortfall.bound). */
  readonly point: boolean;
}

/**
 * The compiled search model: the cell network, the freed knobs, the band constraints, and an EVALUATOR that reads
 * any cell's value under a knob assignment. The evaluator is the exact oracle every native search calls per node of
 * its search tree — it overlays `x` onto the tunable config cells and runs the engine's least fixpoint.
 */
/**
 * A shared-capacity CONTENTION site under request classes: a node whose flow key
 * `key` splits its finite capacity across the classes that contend at it (the processor-sharing split). The native
 * solver's branch-and-bound relies on per-class monotonicity, which HOLDS in the unsaturated region but BREAKS at a
 * shared SATURATED node (raising one class's load lowers a sibling's served rate — §5.2). So `search.ts` reads these
 * off the classification and DECLINES honestly whenever total offered can cross capacity here (the non-monotone
 * boundary), instead of guessing. `capCell`/`totCell` are the node's capacity and total-offered cells; `offeredCells`
 * are the per-class offered cells (used to count how many classes actually contend — a single-class site's split is
 * `min(cap, offered)`, monotone, and needs no decline).
 */
export interface Contention {
  readonly node: NodeId;
  readonly key: Key;
  /** `local:node:key` — the node's own capacity for the flow key. */
  readonly capCell: CellId;
  /** `tot:node:key` — Σ over classes of offered load (the processor-sharing denominator). */
  readonly totCell: CellId;
  /** `off:node:key:class` per declared class — the class's offered load (0 ⇒ the class does not reach this node). */
  readonly offeredCells: readonly CellId[];
}

export interface Model {
  readonly knobs: readonly Knob[];
  readonly bands: readonly BandConstraint[];
  /** Evaluate the whole design under a knob assignment (indexed like `knobs`); read any cell's solved value.
   *  `converged` is the hot path's honesty state — a non-converged/NaN solve is never read as a real number. */
  evaluate(assignment: readonly number[]): { converged: boolean; value(cell: CellId): number | undefined };
  /** The cell holding `out(node,key)` — used to read the objective and to map a band back to its solved value. With
   *  request classes, `cls` reads that class's own served/derived value `out(node,key,class)` (a non-flow key has no
   *  class-blind value under classes); absent ⇒ the class-blind cell (a flow total, or the single implicit river). */
  outCell(node: NodeId, key: Key, cls?: ClassId): CellId;
  /** The declared request-class ids (empty ⇒ the single implicit river). */
  readonly classes: readonly ClassId[];
  /** The shared-capacity contention sites (empty when no classes are declared) — the seam `search.ts` inspects to
   *  DECLINE a design whose shared node can saturate (the non-monotone boundary, doc: request-classes §5.2). */
  readonly contentions: readonly Contention[];
}

/**
 * Build the search model, or fail honestly. Mirrors the incumbent `compile()` preconditions EXACTLY so the two
 * solvers accept and reject the same inputs (the differential contract):
 *  - each tunable must be a fixed config input (else `tunable … must be a fixed config input`);
 * - a cyclic dependency among the freed cells is rejected (search over a cyclic flow is unsupported).
 * On success the returned `evaluate` is a pure function of the assignment — no hidden state, so the same assignment
 * always yields the same values (determinism under seed, a conformance clause).
 */
export function buildModel(graph: Graph, registry: Registry, tunablesIn: readonly Tunable[], classes?: readonly RequestClass[], systemBands?: readonly SystemBand[]): Result<Model, readonly string[]> {
  // A SYSTEM band sums per-node LOCAL cells, which the per-class network splits per class — the class-blind sum
  // would silently ignore the declared classes, so the combination is declined honestly (mirrors the incumbent's
  // `optimizeModel`/`repairModel` rejection and the `total`-objective rule).
  if (systemBands !== undefined && systemBands.length > 0 && classes !== undefined && classes.length > 0) {
    return { ok: false, error: ['a system band is not supported together with request classes'] };
  }
  const netR = buildNetwork(graph, registry, classes);
  if (!netR.ok) return netR;
  const net = netR.value;
  const system = net.system;

  // Resolve each tunable to its config cell — the SAME check the incumbent makes (a tunable must be a node's fixed
  // config input, reached through its `local` ref; anything else is not a knob we can set).
  const knobs: Knob[] = [];
  const knobCells = new Set<CellId>();
  for (const t of tunablesIn) {
    const meta = net.metaOf(t.node, t.key);
    if (meta === undefined || meta.localKind !== 'config' || meta.local === null || meta.local.kind !== 'ref') {
      return { ok: false, error: [`tunable ${t.node}.${t.key} must be a fixed config input`] };
    }
    const cell = meta.local.key;
    const current = configValue(system, cell);
    knobs.push({ node: t.node, key: t.key, cell, min: finite(t.min, -BOUND), max: finite(t.max, BOUND), current });
    knobCells.add(cell);
  }

  // Acyclic-only, exactly as the incumbent: a cyclic free flow needs the post-fixpoint+minimise encoding that
  // conflicts with an objective (search.ts). We reject it here so the two solvers agree on the honest "unsupported".
  if (hasCycleAmongDerived(system)) {
    return { ok: false, error: ['search over a cyclic flow is not supported in this slice'] };
  }

  // Extract the SCALAR bands (minTargetMax/point) as linear floor/ceiling constraints on their out cell, PLUS the
  // declared SYSTEM bands as sum constraints over the local cells. This is the same set the incumbent
  // hard-constrains (`bandsOf` + `systemBandConstraints`) — so a feasible point here is feasible there and vice versa.
  const bands = [...scalarBands(graph, net.out), ...systemBandConstraints(graph, system, systemBands ?? [])];

  // The evaluator: clone the cell system, overwrite the knob config cells with the assignment, run the least
  // fixpoint. `solve()` is the engine's own iterator (the hot path), so the value at any `x` is engine-exact.
  const baseCells = [...system.entries()];
  const evaluate = (assignment: readonly number[]): { converged: boolean; value(cell: CellId): number | undefined } => {
    const overlaid = new Map<CellId, Cell>(baseCells);
    knobs.forEach((k, i) => overlaid.set(k.cell, { kind: 'input', value: assignment[i] ?? k.current }));
    const solved = solve(overlaid);
    return { converged: solved.converged, value: (cell) => solved.values.get(cell) };
  };

  // The shared-capacity CONTENTION sites. Only present under declared classes:
  // for every flow key and node whose per-class served cells contend for one finite capacity (`local:node:key`
  // exists AND the processor-sharing denominator `tot:node:key` exists), record the capacity, total-offered and
  // per-class offered cells. `search.ts` reads these off the classification to DECLINE a design whose shared node
  // can saturate (where per-class monotonicity fails). Empty when no classes are declared, so the single river is
  // exactly as before.
  const contentions = classes !== undefined && classes.length > 0 ? contentionSites(graph, registry, net.classes, system) : [];

  return { ok: true, value: { knobs, bands, evaluate, outCell: net.out, classes: net.classes, contentions } };
}

/** The `tot:node:key` cell — Σ over classes of offered load, the processor-sharing denominator (build.ts). */
const totCellIdOf = (node: NodeId, key: Key): CellId => `tot:${node}:${key}`;
/** The `off:node:key:class` cell — one class's offered load at a node (build.ts). */
const offeredCellIdOf = (node: NodeId, key: Key, cls: ClassId): CellId => `off:${node}:${key}:${cls}`;

/** The flow keys (aggregate.flow) in play in the graph — the ones whose cells are split per class under classes. */
function flowKeysOf(graph: Graph, registry: Registry): Key[] {
  const keys = new Set<Key>();
  for (const node of graph.nodes.values()) for (const cell of node.cells) keys.add(cell.key);
  return [...keys].filter((k) => registry.get(k)?.aggregate.flow === true);
}

/** Collect every shared-capacity contention site: a (node, flow key) whose capacity and total-offered cells both
 *  materialised (build.ts only emits `tot:node:key` under classes and `local:node:key` when the node has an own
 *  capacity). The per-class offered cells present in the system are recorded so `search.ts` can count how many
 *  classes actually contend at atMax (a single-class site is monotone `min(cap, offered)` and is not declined). */
function contentionSites(graph: Graph, registry: Registry, classes: readonly ClassId[], system: ReadonlyMap<CellId, Cell>): Contention[] {
  const out: Contention[] = [];
  for (const key of flowKeysOf(graph, registry)) {
    for (const node of graph.nodes.values()) {
      const capCell = localCellIdOf(node.id, key);
      const totCell = totCellIdOf(node.id, key);
      if (!system.has(capCell) || !system.has(totCell)) continue; // no own capacity, or not class-split ⇒ no split
      const offeredCells = classes.map((c) => offeredCellIdOf(node.id, key, c)).filter((c) => system.has(c));
      out.push({ node: node.id, key, capCell, totCell, offeredCells });
    }
  }
  return out;
}

/** The identifier of the `in(node,key)` cell — the offered load arriving at a node for a key. Used by the
 *  headroom constraint (offered ≤ factor·capacity), mirroring the incumbent's `inCellId` (search.ts). */
export const inCellIdOf = (node: NodeId, key: Key): CellId => `in:${node}:${key}`;
/** The identifier of the `local(node,key)` cell — the node's OWN value for a key (its capacity), independent of
 *  incoming flow. Used by the headroom constraint (offered ≤ factor·capacity), mirroring the incumbent's
 *  `localCellId` (search.ts). */
export const localCellIdOf = (node: NodeId, key: Key): CellId => `local:${node}:${key}`;

/** Read a config cell's fixed value from the system, or NaN if it is not a materialised input (matches the
 *  incumbent's `current = … : NaN` fallback in search.ts). */
function configValue(system: ReadonlyMap<CellId, Cell>, cell: CellId): number {
  const c = system.get(cell);
  return c !== undefined && c.kind === 'input' ? c.value : NaN;
}

/** Lift every declared SYSTEM band to a SUM constraint over the local contribution cells that materialised — the
 *  exact cells a `total` objective sums (and the incumbent's `systemBandConstraints` bounds), so both solvers hold
 *  the identical whole-graph constraint. No local cell for the key ⇒ the empty sum 0, honestly constrained. The
 *  anchor `node` is the first graph node (a Shortfall read-back coordinate; a system band belongs to no node). */
function systemBandConstraints(graph: Graph, system: ReadonlyMap<CellId, Cell>, bands: readonly SystemBand[]): BandConstraint[] {
  const out: BandConstraint[] = [];
  const anchor = [...graph.nodes.keys()][0];
  if (anchor === undefined) return out; // an empty graph has nothing to constrain (and nothing to search)
  for (const b of bands) {
    const cells = [...graph.nodes.keys()].map((id) => localCellIdOf(id, b.key)).filter((c) => system.has(c));
    out.push({
      node: anchor,
      key: b.key,
      cells,
      point: false,
      ...(b.floor !== undefined ? { floor: b.floor } : {}),
      ...(b.ceiling !== undefined ? { ceiling: b.ceiling } : {}),
    });
  }
  return out;
}

/** Lift every SCALAR band (minTargetMax with a floor/ceiling, or a point) to a linear constraint on its out cell.
 *  Percentile bands are skipped (the incumbent skips them too — a tail is a DES value, not a forward one). */
function scalarBands(graph: Graph, outCell: (n: NodeId, k: Key) => CellId): BandConstraint[] {
  const out: BandConstraint[] = [];
  for (const node of graph.nodes.values()) {
    for (const cell of node.cells) {
      if (cell.kind !== 'input' || cell.value.kind !== 'band') continue;
      const band = cell.value.band;
      const c = outCell(node.id, cell.key);
      if (band.shape === 'minTargetMax') {
        // A minTargetMax band's HARD bounds are its min (floor) and max (ceiling) — the same two the incumbent
        // emits as `>=`/`<=` constraints (search.ts hardBand). `target` is a soft WARNING line the verdict layer
        // reads, NOT a hard constraint, so the search ignores it (and so does the MIP) — feasibility is min/max only.
        const bc: BandConstraint = {
          node: node.id,
          key: cell.key,
          cells: [c],
          point: false,
          ...(band.min !== undefined ? { floor: band.min } : {}),
          ...(band.max !== undefined ? { ceiling: band.max } : {}),
        };
        if (bc.floor !== undefined || bc.ceiling !== undefined) out.push(bc);
      } else if (band.shape === 'point') {
        // A point band pins the value to `target` from both sides — floor = ceiling = target (search.ts emits `=`).
        out.push({ node: node.id, key: cell.key, cells: [c], floor: band.target, ceiling: band.target, point: true });
      }
      // percentiles: skipped (a tail SLO is verified by the DES, not this forward model).
    }
  }
  return out;
}

/** Whether the derived cells form a dependency cycle — the same acyclic-only guard the incumbent applies (an
 *  iterative-DFS back-edge test over the cell → referenced-cell graph). Input cells are leaves. */
function hasCycleAmongDerived(system: ReadonlyMap<CellId, Cell>): boolean {
  const deps = new Map<CellId, CellId[]>();
  for (const [id, cell] of system) {
    if (cell.kind !== 'derived') {
      deps.set(id, []);
      continue;
    }
    const refs = new Set<CellId>();
    collectRefs(cell.expr, refs);
    deps.set(id, [...refs].filter((r) => system.has(r)));
  }
  const state = new Map<CellId, 1 | 2>(); // 1 = on the current DFS stack, 2 = fully explored
  const onStack = new Set<CellId>();
  for (const root of deps.keys()) {
    if (state.has(root)) continue;
    const stack: { id: CellId; i: number }[] = [{ id: root, i: 0 }];
    onStack.add(root);
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { id: CellId; i: number };
      const d = deps.get(top.id) ?? [];
      if (top.i < d.length) {
        const next = d[top.i] as CellId;
        top.i += 1;
        if (onStack.has(next)) return true;
        if (!state.has(next)) {
          state.set(next, 1);
          stack.push({ id: next, i: 0 });
          onStack.add(next);
        }
      } else {
        state.set(top.id, 2);
        onStack.delete(top.id);
        stack.pop();
      }
    }
  }
  return false;
}

/** Collect the cell-ids an expression references (for the cycle test). */
function collectRefs(e: Expr<CellId>, out: Set<CellId>): void {
  switch (e.kind) {
    case 'num':
      return;
    case 'ref':
      out.add(e.key);
      return;
    case 'neg':
      collectRefs(e.arg, out);
      return;
    case 'binary':
      collectRefs(e.left, out);
      collectRefs(e.right, out);
      return;
    case 'call':
      for (const a of e.args) collectRefs(a, out);
      return;
    case 'compare':
      collectRefs(e.left, out);
      collectRefs(e.right, out);
      return;
  }
}
