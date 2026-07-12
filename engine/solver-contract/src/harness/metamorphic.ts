// @algorithm Metamorphic instance transforms (a-priori laws on the optimum)
// @problem A differential harness cannot see a bug BOTH solvers share — agreement with itself proves
//   nothing; the suite needs perturbations whose effect on the optimum is known a-priori, as a LAW.
// @approach Pure graph surgery with proven consequences: uniform rate scaling by k (the feasibility
//   polytope is positively homogeneous of degree 1, so the optimal objective scales by exactly k);
//   node/edge permutation via a seeded Fisher-Yates shuffle (optimum invariant); monotone band
//   tightening (optimum never improves); repair-coherence transforms — then the runner asserts each
//   law on the solver's answers.
// @complexity O(graph size) per transform; shuffle O(n).
// @citations Metamorphic testing (Chen, Cheung & Yiu 1998); Fisher-Yates shuffle (Knuth TAOCP v2);
//   degree-1 homogeneity argument stated inline.
// @invariants Transforms are solver-free algebra (imports only engine-core + the generator); seeds
//   are inputs — every divergence reproduces from its integer seed.
// @where-tested engine/solver-contract/src/harness/metamorphic.test.ts

// THE METAMORPHIC LAYER — the instance TRANSFORMS (deeper distillation). The differential harness (./harness) proves a candidate matches the incumbent ANSWER-for-answer.
// That cannot see a bug BOTH solvers share — a shared misreading of the cell network would agree with itself. The
// metamorphic layer closes that gap: it perturbs a generated instance in a way whose effect on the OPTIMUM is known
// a-priori (a LAW, not a second solver's opinion), then asserts the solver's answer obeys the law. A solver that
// violates a scale/permutation/monotonicity law is wrong even if a second solver is wrong the same way.
//
// This module is the pure ALGEBRA of those perturbations — it makes the transformed PROBLEMS; ./metamorphic.test.ts
// runs a solver over them and asserts the laws. Exactly like ./generator it imports ONLY @sda/engine-core (types)
// and the generator's own exports, so it stays engine-core-pure (dependency.test.ts (A)/(B)): a transform is graph
// surgery + arithmetic, never a solver call. SEEDS ARE INPUTS (owner hard rule): the one stochastic transform
// (permutation) derives its shuffle from an explicit integer seed via the generator's mulberry32, so a divergence
// reproduces from that seed — no Date.now / Math.random anywhere.

import type { Cell, Edge, EdgeId, Graph, Key, Node, NodeId, Port, PortId, Transform } from '@sda/engine-core';
import { rngOf, THROUGHPUT, type NumericInstance, type Rng } from './generator';

// ── Scale equivariance ──────────────────────────────────────────────────────────────────────────────────
// Multiply every RATE in the design by a positive factor k: the source demand and each tier's throughput
// capacity (the req/s inputs), the freed knobs' domains, the SLO throughput floor, and any rate-CEILING transform
// (`cap`/`window`). A dimensionless FACTOR transform (`ratio`/`prob`/`batch`) is invariant under a uniform rate
// scaling and is left untouched; the cost RELATION (`throughput · unitCost`) is left untouched too, so the unit
// cost is unscaled. Under this transform the whole feasibility polytope scales by k (min/sum/cap are all
// positively homogeneous of degree 1), so the optimal knob vector scales by k and — because at the optimum every
// served-flow value scales by k while unit cost holds — the OPTIMAL OBJECTIVE (a sum of served·unitCost terms)
// scales by EXACTLY k. Feasibility (solved vs infeasible) is preserved because the floor and the non-tunable cap
// scale together. That exact factor-k relation is the law ./metamorphic.test.ts asserts.

/** The predicted optimal-objective factor a {@link scaledInstance} multiplies the optimum by: exactly `k`, since
 *  the cost objective is degree-1 homogeneous in the rates (served flow scales by k, unit cost is unscaled). */
export const SCALE_OBJECTIVE_FACTOR = (k: number): number => k;

/** Scale a rate-CEILING transform's ceiling by k; leave a dimensionless factor transform unchanged. A `cap`
 *  ceiling (`min(x, value)`, req/s) scales linearly with the flow; a `window` ceiling is `1000/value`, so scaling
 *  the CEILING by k divides its parameter by k. `ratio`/`prob`/`batch` are pure factors — invariant under a
 *  uniform rate scaling. (The generator emits only `ratio` + `cap`; the other kinds are handled for completeness.) */
function scaleTransform(t: Transform, k: number): Transform {
  if (t.kind === 'cap') return { kind: 'cap', value: t.value * k };
  if (t.kind === 'window') return { kind: 'window', value: t.value / k };
  return t; // ratio / prob / batch: a dimensionless factor, invariant under uniform rate scaling
}

/** Scale one cell: a fixed THROUGHPUT input (a rate) and a THROUGHPUT `minTargetMax` band (the SLO) scale by k;
 *  every other cell — the derived cost relation included — is unchanged, so unit cost stays fixed and the
 *  objective's scale factor is a clean k. */
function scaleCell(c: Cell, k: number): Cell {
  if (c.kind !== 'input') return c; // a derived relation (cost = throughput · unitCost) is left as-is
  if (c.value.kind === 'fixed') {
    if (c.key !== THROUGHPUT) return c; // only the req/s rates scale; a non-rate input would not
    return { kind: 'input', key: c.key, value: { kind: 'fixed', quantity: { ...c.value.quantity, value: c.value.quantity.value * k } } };
  }
  const band = c.value.band;
  if (c.key !== THROUGHPUT || band.shape !== 'minTargetMax') return c; // percentile/point bands never appear on a generated design
  const scaled = {
    shape: 'minTargetMax' as const,
    ...(band.min !== undefined ? { min: band.min * k } : {}),
    ...(band.target !== undefined ? { target: band.target * k } : {}),
    ...(band.max !== undefined ? { max: band.max * k } : {}),
  };
  return { kind: 'input', key: c.key, value: { kind: 'band', band: scaled } };
}

/** The scaled twin of a numeric instance (see the section header). `k` must be > 0. The graph, the knob domains
 *  and the descriptive `demand`/`ceiling` labels all scale; the objective (which key, which node, which
 *  direction) and the capability/topology/regime are unchanged. */
export function scaledInstance(inst: NumericInstance, k: number): NumericInstance {
  const nodes = new Map<NodeId, Node>();
  for (const [id, node] of inst.graph.nodes) nodes.set(id, { id: node.id, ports: node.ports, cells: node.cells.map((c) => scaleCell(c, k)) });
  const ports = new Map<PortId, Port>();
  for (const [id, p] of inst.graph.ports) ports.set(id, p.transform !== undefined ? { ...p, transform: scaleTransform(p.transform, k) } : p);
  const edges = new Map<EdgeId, Edge>();
  for (const [id, e] of inst.graph.edges) edges.set(id, e.transform !== undefined ? { ...e, transform: scaleTransform(e.transform, k) } : e);
  const graph: Graph = { nodes, ports, edges };
  const tunables = inst.tunables.map((t) => ({ node: t.node, key: t.key, min: t.min * k, max: t.max * k }));
  return { ...inst, graph, tunables, demand: inst.demand * k, ceiling: inst.ceiling * k };
}

// ── Permutation invariance ──────────────────────────────────────────────────────────────────────────────
// Reorder the graph's node/port/edge maps and the tunable list. The aggregation algebra (min for flow, sum for
// cost) is commutative, so the solved values are identical regardless of iteration order — the OBJECTIVE and the
// honesty KIND must not move. This is determinism BEYOND the seed: two representations of the SAME design must
// give the same answer, catching any order-dependence the seeded differential (which fixes one order) cannot.

/** A Fisher–Yates shuffle of a map's entries into a NEW map, driven by the seeded RNG (deterministic). Rebuilding
 *  the map changes only iteration order — the entries are identical — so the design is semantically unchanged. */
function shuffledMap<K, V>(m: ReadonlyMap<K, V>, rng: Rng): Map<K, V> {
  const entries = [...m.entries()];
  for (let i = entries.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [entries[i], entries[j]] = [entries[j]!, entries[i]!];
  }
  return new Map(entries);
}

/** A Fisher–Yates shuffle of an array into a NEW array, driven by the seeded RNG. */
function shuffledArray<T>(xs: readonly T[], rng: Rng): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A permuted twin: the same design with its node/port/edge maps and its tunable list reordered by `seed`. The
 *  optimum + honesty kind must be identical to the original (the permutation-invariance law). */
export function permutedInstance(inst: NumericInstance, seed: number): NumericInstance {
  const rng = rngOf(seed);
  const graph: Graph = { nodes: shuffledMap(inst.graph.nodes, rng), ports: shuffledMap(inst.graph.ports, rng), edges: shuffledMap(inst.graph.edges, rng) };
  return { ...inst, graph, tunables: shuffledArray(inst.tunables, rng) };
}

// ── Monotone tightening ─────────────────────────────────────────────────────────────────────────────────
// The generator co-locates the SLO floor on the objective node. Setting that floor to a chosen value gives a
// controlled family of the SAME design at increasing tightness — the substrate for the swept monotonicity law
// (a tighter floor never lowers the optimal cost; a looser floor never raises it; and feasibility is downward-
// closed in the floor). Mirrors the private `tightenedTwin` in ./harness.ts, generalised to any floor value.

/** Read the SLO floor (`minTargetMax` band `min`) on the instance's objective node, or `undefined` if none. */
export function floorOf(inst: NumericInstance): number | undefined {
  const node = inst.graph.nodes.get(inst.objective.node);
  const cell = node?.cells.find((c) => c.kind === 'input' && c.value.kind === 'band' && c.value.band.shape === 'minTargetMax');
  return cell?.kind === 'input' && cell.value.kind === 'band' && cell.value.band.shape === 'minTargetMax' ? cell.value.band.min : undefined;
}

/** The same design with its SLO floor set to `floor` (the objective node's `minTargetMax` band `min`). Pure
 *  engine-core surgery — only the one band's `min` changes. */
export function withFloor(inst: NumericInstance, floor: number): NumericInstance {
  const sloId = inst.objective.node;
  const nodes = new Map(inst.graph.nodes);
  const node = nodes.get(sloId);
  if (node !== undefined) {
    const cells = node.cells.map((c): Cell =>
      c.kind === 'input' && c.value.kind === 'band' && c.value.band.shape === 'minTargetMax'
        ? { kind: 'input', key: c.key, value: { kind: 'band', band: { shape: 'minTargetMax', min: floor } } }
        : c,
    );
    nodes.set(sloId, { id: node.id, ports: node.ports, cells });
  }
  return { ...inst, graph: { nodes, ports: inst.graph.ports, edges: inst.graph.edges } };
}

// ── Repair coherence ────────────────────────────────────────────────────────────────────────────────────
// Two laws relate repair to optimize on the SAME design: (1) repairing from an already-FEASIBLE point is a
// zero-distance edit (nothing to fix); (2) repair's minimal L1 edit never exceeds the L1 distance to the
// optimize-from-scratch optimum, because that optimum is ONE feasible point and repair is the minimum over ALL of
// them. Both need to read a knob's current value and to pin knobs onto the graph — pure graph surgery below.

/** The current value of a freed knob: the fixed input the tunable names, or `undefined` if it is not a fixed
 *  input. Used to measure the L1 distance from the original design to an optimize solution. */
export function currentValue(graph: Graph, node: NodeId, key: Key): number | undefined {
  const cell = graph.nodes.get(node)?.cells.find((c) => c.kind === 'input' && c.value.kind === 'fixed' && c.key === key);
  return cell?.kind === 'input' && cell.value.kind === 'fixed' ? cell.value.quantity.value : undefined;
}

/** The instance with each freed knob PINNED to its domain maximum — the all-max corner. For a feasible (`sat`)
 *  design this corner is strictly feasible (its served flow is the design's ceiling, above the SLO floor), so
 *  repairing from it is the canonical "already feasible ⇒ zero edit" case. */
export function maxCornerInstance(inst: NumericInstance): NumericInstance {
  const byNodeKey = new Map<string, number>(inst.tunables.map((t) => [`${t.node}|${t.key}`, t.max]));
  const nodes = new Map<NodeId, Node>();
  for (const [id, node] of inst.graph.nodes) {
    const cells = node.cells.map((c): Cell => {
      if (c.kind !== 'input' || c.value.kind !== 'fixed') return c;
      const v = byNodeKey.get(`${id}|${c.key}`);
      return v === undefined ? c : { kind: 'input', key: c.key, value: { kind: 'fixed', quantity: { ...c.value.quantity, value: v } } };
    });
    nodes.set(id, { id: node.id, ports: node.ports, cells });
  }
  return { ...inst, graph: { nodes, ports: inst.graph.ports, edges: inst.graph.edges } };
}
