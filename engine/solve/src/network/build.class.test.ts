import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildGraph,
  registryOf,
  ClassId,
  EdgeId,
  Key,
  NodeId,
  PortId,
  Unit,
  type Edge,
  type KeyDef,
  type Node,
  type Port,
  type Registry,
} from '@sda/engine-core';
import { buildNetwork, type RequestClass } from './build';
import { solve } from '../fixpoint';
import { noClassCorpus, corpusBuildRegistry, corpusKeys } from './__fixtures__/no-class-corpus';

// REQUEST CLASSES — R1 engine algebra (doc: request-classes §4.1, §4.2, §9). A CLASS is a named flow (a
// commodity): its own acyclic wire membership over a shared, possibly cyclic, topology, and its own origins.
// The default — NO classes — is the single implicit river, and the whole point of R1 is that it changes nothing.
// These tests pin, at the cell level: (a) that equivalence, (b) the mesh a single river would refuse, (c) the
// relocated cycle guard, (d) the processor-sharing split's analytic anchors, (e) per-class monotonicity and its
// honest saturated boundary, (f) per-class cumulative latency (the fold following the class path).

const tput = Key('throughput'); // the flow key the class dimension indexes
const lat = Key('latency'); // a non-flow SUM fold — cumulative latency down the class's path

const classReg: Registry = registryOf([
  { key: tput, unit: Unit('req/s'), band: 'minTargetMax', aggregate: { series: 'min', fanIn: 'sum', onAsyncEdge: 'carry', flow: true }, kind: 'derived' },
  { key: lat, unit: Unit('ms'), band: 'percentiles', aggregate: { series: 'sum', onAsyncEdge: 'cut' }, kind: 'derived' },
] satisfies KeyDef[]);

const cfgTput = (value: number) => ({ kind: 'input', key: tput, value: { kind: 'fixed', quantity: { value, unit: Unit('req/s') } } }) as const;
const cfgLat = (value: number) => ({ kind: 'input', key: lat, value: { kind: 'fixed', quantity: { value, unit: Unit('ms') } } }) as const;

const outP = (id: string): PortId => PortId(`${id}.out`);
const inP = (id: string): PortId => PortId(`${id}.in`);

/** A pure ORIGIN source: an out port only, no capacity (its emission is the class origin). Optional own latency. */
function source(id: string, latMs?: number): Node {
  return { id: NodeId(id), ports: [outP(id)], cells: latMs === undefined ? [] : [cfgLat(latMs)] };
}
/** A capacitated node: `cap` is its PURE throughput capacity (a config), plus its own latency. `hasOut` if it forwards. */
function capNode(id: string, cap: number, latMs: number, hasOut: boolean): Node {
  return { id: NodeId(id), ports: hasOut ? [inP(id), outP(id)] : [inP(id)], cells: [cfgTput(cap), cfgLat(latMs)] };
}
function edge(id: string, from: string, to: string, semantics: 'sync' | 'async' = 'sync'): Edge {
  return { id: EdgeId(id), from: outP(from), to: inP(to), semantics };
}
function portsOf(sources: readonly string[], caps: readonly [string, boolean][]): Port[] {
  const ps: Port[] = [];
  for (const s of sources) ps.push({ id: outP(s), node: NodeId(s), dir: 'out' });
  for (const [c, hasOut] of caps) {
    ps.push({ id: inP(c), node: NodeId(c), dir: 'in' });
    if (hasOut) ps.push({ id: outP(c), node: NodeId(c), dir: 'out' });
  }
  return ps;
}

/** Build + solve with classes; returns a per-(node,key,class) value reader. Throws on build error / non-convergence. */
function evalClasses(nodes: Node[], ports: Port[], edges: Edge[], registry: Registry, classes: readonly RequestClass[]) {
  const g = buildGraph({ nodes, ports, edges });
  if (!g.ok) throw new Error(`graph: ${JSON.stringify(g.error)}`);
  const net = buildNetwork(g.value, registry, classes);
  if (!net.ok) throw new Error(`network: ${net.error.join('; ')}`);
  const r = solve(net.value.system);
  expect(r.converged).toBe(true);
  return {
    net: net.value,
    value: (id: string, key: Key, cls?: string): number | undefined => r.values.get(net.value.out(NodeId(id), key, cls === undefined ? undefined : ClassId(cls))),
    system: net.value.system,
  };
}

/** Build with classes and RETURN the errors (the honest, guided refusal). Throws if the build unexpectedly succeeds. */
function classBuildErrors(nodes: Node[], ports: Port[], edges: Edge[], classes: readonly RequestClass[]): readonly string[] {
  const g = buildGraph({ nodes, ports, edges });
  if (!g.ok) throw new Error(`graph: ${JSON.stringify(g.error)}`);
  const net = buildNetwork(g.value, classReg, classes);
  if (net.ok) throw new Error('expected the build to refuse this class configuration');
  return net.error;
}

const rc = (id: string, edges: string[], origins: [string, number][]): RequestClass => ({
  id: ClassId(id),
  edges: edges.map((e) => EdgeId(e)),
  origins: origins.map(([node, rps]) => ({ node: NodeId(node), rps })),
});

// ── (a) THE EQUIVALENCE PROPERTY — no class declarations ⇒ every cell value bit-identical to the pre-change
//    builder. Differentialled against a GOLDEN captured from the pre-change `buildNetwork` over a deterministic
//    corpus (chains, fan-in/out, transforms, async, and a class-free mesh). This is the additive default's proof.
describe('request classes — (a) equivalence: absent classes is byte-for-byte today', () => {
  const golden = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'no-class-golden.json'), 'utf8')) as Record<string, Record<string, number | null>>;

  it('reproduces the pre-change golden for every corpus graph, with NO class-only cells', () => {
    for (const { name, graph } of noClassCorpus()) {
      const net = buildNetwork(graph, corpusBuildRegistry); // no classes ⇒ the single implicit river
      expect(net.ok, `${name} builds`).toBe(true);
      if (!net.ok) continue;
      // The class machinery must be fully INERT: not one class-only cell exists when no class is declared.
      for (const cellId of net.value.system.keys()) {
        expect(cellId.startsWith('off:') || cellId.startsWith('tot:') || cellId.startsWith('tin:') || cellId.startsWith('org:'), `${name}: ${cellId} is class-only`).toBe(false);
      }
      const r = solve(net.value.system);
      const g = golden[name] as Record<string, number | null>;
      expect(r.converged ? 1 : 0, `${name} converged`).toBe(g.__converged);
      for (const nodeId of graph.nodes.keys()) {
        for (const key of corpusKeys) {
          const v = r.values.get(net.value.out(nodeId, key));
          const expected = g[`${String(nodeId)}|${String(key)}`];
          expect(v === undefined ? null : v, `${name}: ${String(nodeId)}|${String(key)}`).toBe(expected);
        }
      }
    }
  });

  it('one explicit class over the whole wire reduces to the single river (PS split → min(cap, offered))', () => {
    // client → relay(cap). No-class: out(relay) = min(cap, rps). One class over the edge, origin = the client's rate.
    const nodes = [source('client'), capNode('relay', 120, 4, false)];
    const ports = portsOf(['client'], [['relay', false]]);
    const edges = [edge('e', 'client', 'relay')];
    for (const rps of [80, 200]) {
      const one = evalClasses(nodes, ports, edges, classReg, [rc('all', ['e'], [['client', rps]])]);
      expect(one.value('relay', tput, 'all')).toBe(Math.min(120, rps)); // 80 (headroom) / 120 (saturated) — exactly min
      expect(one.value('client', tput, 'all')).toBe(rps); // the origin passes through the capacity-less source
    }
  });
});

// ── (b) THE MESH — two acyclic commodities over the SAME two nodes (A↔B). One river reads this as a cycle and
//    refuses/degenerates; classes compute each one honestly. Values checked by hand.
describe('request classes — (b) the each-to-each mesh evaluates per class', () => {
  const A = 'A';
  const B = 'B';
  const nodes = [capNode(A, 5000, 3, true), capNode(B, 5000, 4, true)];
  const ports = portsOf([], [[A, true], [B, true]]);
  const edges = [edge('e1', A, B), edge('e2', B, A)]; // A→B and B→A — a cyclic drawing
  const order = rc('order', ['e1'], [[A, 800]]); // order: A originates, flows A→B
  const report = rc('report', ['e2'], [[B, 500]]); // report: B originates, flows B→A

  it('both classes flow along their own acyclic wires over the cyclic topology', () => {
    const s = evalClasses(nodes, ports, edges, classReg, [order, report]);
    // order: A emits 800 → B serves 800 (headroom). report: B emits 500 → A serves 500. Each acyclic.
    expect(s.value(A, tput, 'order')).toBe(800);
    expect(s.value(B, tput, 'order')).toBe(800);
    expect(s.value(B, tput, 'report')).toBe(500);
    expect(s.value(A, tput, 'report')).toBe(500);
    expect(s.net.classes.map(String)).toEqual(['order', 'report']);
  });

  it('total overflow equals the single river’s (both zero under headroom)', () => {
    const s = evalClasses(nodes, ports, edges, classReg, [order, report]);
    let totalOverflow = 0;
    for (const node of [A, B]) for (const [c, rps] of [['order', 800], ['report', 500]] as const) {
      const served = s.value(node, tput, c) ?? 0;
      const origin = node === (c === 'order' ? A : B) ? rps : 0; // this class originates only at its origin node
      const inflow = node === (c === 'order' ? B : A) ? origin : 0; // and lands at the far node
      const offered = origin + inflow;
      totalOverflow += Math.max(0, offered - served);
    }
    expect(totalOverflow).toBe(0); // the single implicit river of the same drawing carries no traffic either
  });
});

// ── (c) THE CYCLE GUARD RELOCATES — a cyclic COMMODITY is refused (naming the class + its cycle); a cyclic
//    TOPOLOGY whose per-class subsets are each acyclic builds fine.
describe('request classes — (c) the cycle guard is per class, not per drawing', () => {
  const A = 'A';
  const B = 'B';
  const nodes = [capNode(A, 5000, 3, true), capNode(B, 5000, 4, true)];
  const ports = portsOf([], [[A, true], [B, true]]);
  const edges = [edge('e1', A, B), edge('e2', B, A)];

  it('refuses a class whose OWN path cycles, naming the class and the cycle', () => {
    const errs = classBuildErrors(nodes, ports, edges, [rc('loop', ['e1', 'e2'], [[A, 100]])]);
    expect(errs.some((e) => e.includes('class "loop"') && e.includes('cyclic') && e.includes('A → B → A'))).toBe(true);
  });

  it('accepts a cyclic topology whose classes each carve an acyclic slice', () => {
    const s = evalClasses(nodes, ports, edges, classReg, [rc('order', ['e1'], [[A, 100]]), rc('report', ['e2'], [[B, 100]])]);
    expect(s.value(B, tput, 'order')).toBe(100);
    expect(s.value(A, tput, 'report')).toBe(100);
  });

  it('refuses honestly when a class names an unknown edge or origin node', () => {
    expect(classBuildErrors(nodes, ports, edges, [rc('x', ['nope'], [])]).some((e) => e.includes('unknown edge "nope"'))).toBe(true);
    expect(classBuildErrors(nodes, ports, edges, [rc('x', ['e1'], [['ghost', 1]])]).some((e) => e.includes('unknown origin node "ghost"'))).toBe(true);
  });
});

// ── (d) THE PS-SPLIT ANALYTIC ANCHORS — two classes sharing one node N. S1 feeds N on class order, S2 on report.
//    Acyclic cells (pure sources), so the split is directly hand-computable.
describe('request classes — (d) processor-sharing split anchors', () => {
  const S1 = 'S1';
  const S2 = 'S2';
  const N = 'N';
  const ports = portsOf([S1, S2], [[N, false]]);
  const edges = [edge('e1', S1, N), edge('e2', S2, N)];
  const build = (capN: number, o1 = 100, o2 = 100) => {
    const nodes = [source(S1), source(S2), capNode(N, capN, 5, false)];
    return evalClasses(nodes, ports, edges, classReg, [rc('order', ['e1'], [[S1, o1]]), rc('report', ['e2'], [[S2, o2]])]);
  };

  it('UNSATURATED (total ≤ cap): served == offered per class — exact and separable', () => {
    const s = build(250); // 100 + 100 = 200 ≤ 250
    expect(s.value(N, tput, 'order')).toBe(100);
    expect(s.value(N, tput, 'report')).toBe(100);
  });

  it('SATURATED (total > cap): proportional split, Σ served = capacity, Σ overflow = excess', () => {
    const capN = 150; // 200 offered vs 150 capacity
    const s = build(capN);
    const order = s.value(N, tput, 'order') as number;
    const report = s.value(N, tput, 'report') as number;
    expect(order).toBeCloseTo(75, 9); // 100 · 150/200
    expect(report).toBeCloseTo(75, 9);
    expect(order + report).toBeCloseTo(capN, 9); // Σ served = capacity exactly
    const overflow = 100 - order + (100 - report);
    expect(overflow).toBeCloseTo(200 - capN, 9); // Σ overflow = total offered − capacity
  });

  it('SATURATED with unequal offered loads splits in proportion', () => {
    const s = build(150, 300, 100); // offered 300 / 100, total 400, cap 150 ⇒ factor 150/400
    expect(s.value(N, tput, 'order')).toBeCloseTo(300 * (150 / 400), 9); // 112.5
    expect(s.value(N, tput, 'report')).toBeCloseTo(100 * (150 / 400), 9); // 37.5
    expect((s.value(N, tput, 'order') as number) + (s.value(N, tput, 'report') as number)).toBeCloseTo(150, 9);
  });
});

// ── (e) MONOTONICITY per class in the headroom regime, and the DOCUMENTED non-monotone shared-saturation boundary.
describe('request classes — (e) monotonicity and its honest boundary', () => {
  const S1 = 'S1';
  const S2 = 'S2';
  const N = 'N';
  const ports = portsOf([S1, S2], [[N, false]]);
  const edges = [edge('e1', S1, N), edge('e2', S2, N)];
  const served = (capN: number, o1: number, o2: number, cls: 'order' | 'report') => {
    const nodes = [source(S1), source(S2), capNode(N, capN, 5, false)];
    const s = evalClasses(nodes, ports, edges, classReg, [rc('order', ['e1'], [[S1, o1]]), rc('report', ['e2'], [[S2, o2]])]);
    return s.value(N, tput, cls) as number;
  };

  it('raising capacity never DECREASES any class’s served throughput', () => {
    // A saturated shared node; raise cap through and past saturation. Each class's served is non-decreasing.
    let prevOrder = -Infinity;
    let prevReport = -Infinity;
    for (const capN of [100, 150, 200, 260]) {
      const o = served(capN, 130, 90, 'order');
      const r = served(capN, 130, 90, 'report');
      expect(o).toBeGreaterThanOrEqual(prevOrder - 1e-9);
      expect(r).toBeGreaterThanOrEqual(prevReport - 1e-9);
      prevOrder = o;
      prevReport = r;
    }
  });

  it('DOCUMENTED non-monotone limit: at a SATURATED shared node, raising a sibling’s load lowers a class’s served', () => {
    // The one non-separable term (doc §4.1 Tension #1 / §5.2). Held at cap 150 (saturated), report's own offered
    // load fixed at 100; raising ORDER's offered load steals report's share. Asserted as the KNOWN boundary — the
    // scalar's proportional estimate; the DES measures the truth in R3. NOT hidden, NOT pretended monotone.
    const reportAtLowOrder = served(150, 100, 100, 'report'); // total 200 ⇒ report 100·150/200 = 75
    const reportAtHighOrder = served(150, 300, 100, 'report'); // total 400 ⇒ report 100·150/400 = 37.5
    expect(reportAtLowOrder).toBeCloseTo(75, 9);
    expect(reportAtHighOrder).toBeCloseTo(37.5, 9);
    expect(reportAtHighOrder).toBeLessThan(reportAtLowOrder); // a sibling's load lowered THIS class — the honest limit
  });
});

// ── (f) PER-CLASS DOWNSTREAM QUANTITIES (point 3 / §4.2) — cumulative latency folds along the CLASS's own path,
//    so a node crossed by two classes holds two latency perspectives.
describe('request classes — (f) latency folds follow the class path (two perspectives at a shared node)', () => {
  const A = 'A';
  const Bn = 'B';
  const N = 'N';
  const ports = portsOf([A, Bn], [[N, false]]);
  const edges = [edge('e1', A, N), edge('e2', Bn, N)];
  const nodes = [source(A, 5), source(Bn, 7), capNode(N, 5000, 10, false)];
  const classX = rc('x', ['e1'], [[A, 100]]); // A → N
  const classY = rc('y', ['e2'], [[Bn, 100]]); // B → N

  it('N has one cumulative latency per class, each summed over that class’s predecessors', () => {
    const s = evalClasses(nodes, ports, edges, classReg, [classX, classY]);
    // class x: 5 (A) + 10 (N) = 15;  class y: 7 (B) + 10 (N) = 17.  Two perspectives on the same physical node.
    expect(s.value(N, lat, 'x')).toBe(15);
    expect(s.value(N, lat, 'y')).toBe(17);
    expect(s.value(A, lat, 'x')).toBe(5);
    expect(s.value(Bn, lat, 'y')).toBe(7);
  });
});
