import {
  buildGraph,
  registryOf,
  EdgeId,
  Key,
  NodeId,
  PortId,
  Unit,
  type Edge,
  type Graph,
  type KeyDef,
  type Node,
  type Port,
  type Registry,
  type Transform,
} from '@sda/engine-core';

// @algorithm Seeded LCG corpus generation (class-free golden population)
// @problem The request-classes equivalence gate needs a stable, varied population of class-free
//   graphs whose golden cell values survive machines and runs byte-for-byte — fast-check's own
//   generators do not promise cross-version stability.
// @approach A plain linear congruential generator (Numerical Recipes constants 1664525 /
//   1013904223, 32-bit wrap) drives deterministic construction of chains, fan-in/fan-out,
//   per-wire/per-port transforms, async cut/carry and cyclic meshes — the seams the class branch
//   could disturb. (This is the repo's third PRNG home, distinct from mulberry32 in engine/sim/rng
//   and harness/generator: an LCG, chosen for fixture simplicity.)
// @complexity O(1) per draw; corpus construction linear in nodes + edges.
// @citations Press et al., "Numerical Recipes" (the LCG constants); Knuth TAOCP v2 (LCG theory).
// @invariants Same seed => same corpus => same golden, across machines; no class declarations
//   anywhere (the single-implicit-river world the class dimension must leave byte-identical).
// @where-tested engine/solve/src/network/build.class.test.ts (equivalence vs captured golden)

// A DETERMINISTIC corpus of class-free graphs — the reference population for the request-classes EQUIVALENCE
// property. Its golden values are captured from the PRE-CHANGE `buildNetwork`
// (see `capture-no-class-golden` scratchpad script) and the equivalence test asserts the class-aware builder,
// given NO class declarations, reproduces every cell value bit-for-bit. Nothing here declares a class — this is
// the whole "single implicit river" world the class dimension must leave byte-identical.
//
// The generator is a plain seeded LCG (no fast-check), so the corpus — and therefore the golden — is stable
// across runs and machines. Variety spans the seams the class branch could disturb: chains, fan-in, fan-out,
// per-wire + per-port transforms, async cut/carry, and CYCLIC topologies (a mesh is class-free-legal too, it
// just reads as one river).

const tput = Key('throughput'); // the flow key — the one the class dimension indexes
const lat = Key('latency'); // sum down a path, cut at async — the forward-cumulative fold §4.2 generalises
const avail = Key('availability'); // product — the multiplicative fold
const cost = Key('cost'); // sum, carried across async

/** The corpus registry: one flow key plus the three roll-up folds (sum / product), so the equivalence covers
 *  the flow cells AND the non-flow folds the class branch also touches. */
export const corpusRegistry: Registry = registryOf([
  { key: tput, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'min', fanIn: 'sum', onAsyncEdge: 'carry', flow: true }, kind: 'derived' },
  { key: lat, unit: Unit('ms'), band: 'percentiles', aggregate: { series: 'sum', onAsyncEdge: 'cut' }, kind: 'derived' },
  { key: avail, unit: Unit('1'), band: 'point', aggregate: { series: 'product', onAsyncEdge: 'carry' }, kind: 'derived' },
  { key: cost, unit: Unit('USD/mo'), band: 'point', aggregate: { series: 'sum', onAsyncEdge: 'carry' }, kind: 'derived' },
] satisfies KeyDef[]);

export const corpusKeys: readonly Key[] = [tput, lat, avail, cost];

/** A tiny deterministic PRNG (LCG, Numerical Recipes constants) — same seed ⇒ same corpus ⇒ same golden. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const fixed = (key: Key, value: number, unit: string) => ({ kind: 'input', key, value: { kind: 'fixed', quantity: { value, unit: Unit(unit) } } }) as const;

/** A source node: emits `rps`, its own latency/availability/cost. No input port. */
function sourceNode(id: string, rps: number, latMs: number, av: number, cst: number): Node {
  return {
    id: NodeId(id),
    ports: [PortId(`${id}.out`)],
    cells: [fixed(tput, rps, 'req/s'), fixed(lat, latMs, 'ms'), fixed(avail, av, '1'), fixed(cost, cst, 'USD/mo')],
  };
}

/** A relay/sink: capacity-clamped throughput (min(cap, inflow)), additive latency/cost, multiplicative availability. */
function relayNode(id: string, capValue: number, latMs: number, av: number, cst: number, hasOut: boolean): Node {
  const ports = hasOut ? [PortId(`${id}.in`), PortId(`${id}.out`)] : [PortId(`${id}.in`)];
  return {
    id: NodeId(id),
    ports,
    cells: [
      fixed(Key('cap'), capValue, 'req/s'),
      { kind: 'derived', key: tput, relation: { produces: tput, reads: [Key('cap')], expr: 'min(cap, inflow(throughput))' } },
      fixed(lat, latMs, 'ms'),
      fixed(avail, av, '1'),
      fixed(cost, cst, 'USD/mo'),
    ],
  };
}

const capKey: KeyDef = { key: Key('cap'), unit: Unit('req/s'), band: 'point', aggregate: { series: 'min', onAsyncEdge: 'carry' }, kind: 'input' };
/** The registry actually used to BUILD (adds the relay's `cap` input key). Equivalence reads out cells for `corpusKeys`. */
export const corpusBuildRegistry: Registry = registryOf([...(corpusRegistry.keys.map((k) => corpusRegistry.get(k)!)), capKey]);

interface Shape {
  readonly name: string;
  readonly graph: Graph;
}

function build(name: string, nodes: Node[], ports: Port[], edges: Edge[]): Shape {
  const g = buildGraph({ nodes, ports, edges });
  if (!g.ok) throw new Error(`corpus ${name}: ${JSON.stringify(g.error)}`);
  return { name, graph: g.value };
}

const outP = (id: string): PortId => PortId(`${id}.out`);
const inP = (id: string): PortId => PortId(`${id}.in`);

function edge(id: string, from: string, to: string, semantics: 'sync' | 'async', transform?: Transform): Edge {
  return { id: EdgeId(id), from: outP(from), to: inP(to), semantics, ...(transform !== undefined ? { transform } : {}) };
}

/** Ports for a linear list of node ids where `srcs` are pure sources (out only) and the rest are relays. */
function portsFor(srcIds: readonly string[], relayIds: readonly string[], relayHasOut: (id: string) => boolean): Port[] {
  const ps: Port[] = [];
  for (const s of srcIds) ps.push({ id: outP(s), node: NodeId(s), dir: 'out' });
  for (const r of relayIds) {
    ps.push({ id: inP(r), node: NodeId(r), dir: 'in' });
    if (relayHasOut(r)) ps.push({ id: outP(r), node: NodeId(r), dir: 'out' });
  }
  return ps;
}

/** Generate the deterministic corpus: assorted chains, fan-in, fan-out, transforms, async edges and one cycle. */
export function noClassCorpus(): readonly Shape[] {
  const rnd = lcg(0x5da51);
  const rInt = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const shapes: Shape[] = [];

  // 1. Random linear chains: source → relay → … → relay (length 2..6), varied capacities/latencies.
  for (let i = 0; i < 8; i++) {
    const len = rInt(2, 6);
    const ids = Array.from({ length: len }, (_, j) => `c${i}n${j}`);
    const srcId = ids[0]!;
    const relayIds = ids.slice(1);
    const nodes: Node[] = [sourceNode(srcId, rInt(50, 900), rInt(1, 20), 0.9 + rnd() * 0.099, rInt(1, 40))];
    relayIds.forEach((id, j) => nodes.push(relayNode(id, rInt(40, 600), rInt(1, 30), 0.9 + rnd() * 0.099, rInt(1, 60), j < relayIds.length - 1)));
    const ports = portsFor([srcId], relayIds, (id) => id !== relayIds[relayIds.length - 1]);
    const edges: Edge[] = [];
    for (let j = 0; j < ids.length - 1; j++) {
      const async = rnd() < 0.25;
      const tf: Transform | undefined = rnd() < 0.3 ? { kind: 'ratio', value: 0.5 + rnd() } : undefined;
      edges.push(edge(`c${i}e${j}`, ids[j]!, ids[j + 1]!, async ? 'async' : 'sync', tf));
    }
    shapes.push(build(`chain-${i}`, nodes, ports, edges));
  }

  // 2. Fan-in: two sources → one relay (offered loads SUM at the fan-in).
  for (let i = 0; i < 4; i++) {
    const s1 = `f${i}s1`;
    const s2 = `f${i}s2`;
    const r = `f${i}r`;
    const nodes = [sourceNode(s1, rInt(50, 400), rInt(1, 15), 0.95, rInt(1, 20)), sourceNode(s2, rInt(50, 400), rInt(1, 15), 0.95, rInt(1, 20)), relayNode(r, rInt(100, 900), rInt(1, 20), 0.99, rInt(1, 30), false)];
    const ports = portsFor([s1, s2], [r], () => false);
    const edges = [edge(`f${i}e1`, s1, r, 'sync'), edge(`f${i}e2`, s2, r, 'sync')];
    shapes.push(build(`fan-in-${i}`, nodes, ports, edges));
  }

  // 3. Fan-out: source → relay → {relayA, relayB}, with per-wire ratio splits.
  for (let i = 0; i < 4; i++) {
    const s = `o${i}s`;
    const hub = `o${i}h`;
    const a = `o${i}a`;
    const b = `o${i}b`;
    const nodes = [sourceNode(s, rInt(100, 800), rInt(1, 10), 0.98, rInt(1, 20)), relayNode(hub, rInt(200, 1000), rInt(1, 15), 0.99, rInt(1, 25), true), relayNode(a, rInt(50, 500), rInt(1, 20), 0.97, rInt(1, 30), false), relayNode(b, rInt(50, 500), rInt(1, 20), 0.97, rInt(1, 30), false)];
    const ports: Port[] = [
      { id: outP(s), node: NodeId(s), dir: 'out' },
      { id: inP(hub), node: NodeId(hub), dir: 'in' },
      { id: outP(hub), node: NodeId(hub), dir: 'out' },
      { id: inP(a), node: NodeId(a), dir: 'in' },
      { id: inP(b), node: NodeId(b), dir: 'in' },
    ];
    const edges = [edge(`o${i}e0`, s, hub, 'sync'), edge(`o${i}e1`, hub, a, 'sync', { kind: 'ratio', value: 0.7 }), edge(`o${i}e2`, hub, b, 'sync', { kind: 'ratio', value: 0.3 })];
    shapes.push(build(`fan-out-${i}`, nodes, ports, edges));
  }

  // 4. Cyclic topology (a class-free mesh): A → B → A. One river; the fixpoint settles it. The class dimension
  //    must leave this byte-identical (a cyclic drawing is legal without classes — it just reads as one commodity).
  for (let i = 0; i < 2; i++) {
    const a = `m${i}a`;
    const b = `m${i}b`;
    const nodes = [relayNode(a, rInt(200, 900), rInt(1, 12), 0.99, rInt(1, 20), true), relayNode(b, rInt(200, 900), rInt(1, 12), 0.99, rInt(1, 20), true)];
    const ports: Port[] = [
      { id: inP(a), node: NodeId(a), dir: 'in' },
      { id: outP(a), node: NodeId(a), dir: 'out' },
      { id: inP(b), node: NodeId(b), dir: 'in' },
      { id: outP(b), node: NodeId(b), dir: 'out' },
    ];
    const edges = [edge(`m${i}e1`, a, b, 'sync'), edge(`m${i}e2`, b, a, 'sync')];
    shapes.push(build(`mesh-${i}`, nodes, ports, edges));
  }

  return shapes;
}
