import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  buildGraph,
  categoricalOf,
  DimensionId,
  DimensionToken,
  EdgeId,
  NodeId,
  PortId,
  type Categorical,
  type Dimension,
  type Edge,
  type Graph,
  type Guarantees,
  type Node,
  type Port,
} from '@sda/engine-core';
import { contributionsAlong, judgeGuarantee, propagateDimension, propagateFlow, propagateFlowEdges, enumerateFlowPaths, type Contribution } from './propagate';
import { meetDatalog } from './datalog';

// Guarantee propagation. Neutral tokens only (t0 strongest … t2 weakest) —
// the engine is domain-agnostic; 'strong'/'eventual'/'none' are content. Two dimensions exercise the general
// case + a boolean flag; one carries a declared-unknown token to pin the honest-unknown path.

const D = DimensionId('d'); // three-token ordering-like dimension
const F = DimensionId('f'); // boolean-flag delivery-like dimension
const U = DimensionId('u'); // a dimension with an unknown token
const dims: Dimension[] = [
  { id: D, tokens: ['t0', 't1', 't2'].map(DimensionToken) },
  { id: F, tokens: ['clean', 'flagged'].map(DimensionToken) },
  { id: U, tokens: ['u0', 'u1', 'unk'].map(DimensionToken), unknown: DimensionToken('unk') },
];
const vocab = (): Categorical => {
  const c = categoricalOf(dims);
  if (!c.ok) throw new Error('vocab');
  return c.value;
};
const tok = DimensionToken;
const contrib = (scope: string, node: string, g: Guarantees): Contribution => ({ scope: PortId(scope) as PortId | EdgeId, node: NodeId(node), guarantees: g });

describe('propagateDimension — the meet fold + first-drop attribution', () => {
  const cat = vocab();
  const dLat = cat.get(D);
  if (dLat === undefined) throw new Error('d');

  it('no contributions ⇒ TOP, no root cause (a path preserves the strongest guarantee)', () => {
    const r = propagateDimension(dLat, []);
    expect(r.token).toBe(tok('t0'));
    expect(r.rootCause).toBeNull();
    expect(r.touchedUnknown).toBe(false);
  });

  it('meets to the weakest and blames the FIRST hop that dropped, not later ones', () => {
    const contributions = [
      contrib('p0', 'a', { [D]: tok('t0') }), // TOP re-stated: no drop
      contrib('p1', 'b', { [D]: tok('t1') }), // FIRST drop t0→t1 — the root cause
      contrib('p2', 'c', { [D]: tok('t2') }), // further drop t1→t2 — a consequence, not the cause
    ];
    const r = propagateDimension(dLat, contributions);
    expect(r.token).toBe(tok('t2'));
    expect(r.rootCause?.scope).toBe(PortId('p1'));
    expect(r.rootCause?.node).toBe(NodeId('b'));
    expect(r.rootCause?.from).toBe(tok('t0'));
    expect(r.rootCause?.to).toBe(tok('t1'));
  });

  it('a hop absent for this dimension is a no-op (does not weaken)', () => {
    const contributions = [contrib('p0', 'a', { [F]: tok('flagged') }), contrib('p1', 'b', { [D]: tok('t1') })];
    const r = propagateDimension(dLat, contributions);
    expect(r.token).toBe(tok('t1'));
    expect(r.rootCause?.scope).toBe(PortId('p1'));
  });

  it('flags touchedUnknown when a hop contributes the declared-unknown token', () => {
    const uLat = cat.get(U);
    if (uLat === undefined) throw new Error('u');
    const r = propagateDimension(uLat, [contrib('p0', 'a', { [U]: tok('u1') }), contrib('p1', 'b', { [U]: tok('unk') })]);
    expect(r.touchedUnknown).toBe(true);
  });
});

describe('judgeGuarantee — ok / violation / unknown (no soft band)', () => {
  const cat = vocab();
  const dLat = cat.get(D);
  const uLat = cat.get(U);
  if (dLat === undefined || uLat === undefined) throw new Error('lattices');

  it('ok when the computed token is stronger-or-equal to the requirement', () => {
    const r = propagateDimension(dLat, [contrib('p', 'a', { [D]: tok('t0') })]);
    expect(judgeGuarantee(dLat, r, { dimension: D, atLeast: tok('t1') })).toBe('ok'); // t0 ≥ t1
    expect(judgeGuarantee(dLat, r, { dimension: D, atLeast: tok('t0') })).toBe('ok'); // equal
  });

  it('violation when the computed token is weaker than the requirement', () => {
    const r = propagateDimension(dLat, [contrib('p', 'a', { [D]: tok('t2') })]);
    expect(judgeGuarantee(dLat, r, { dimension: D, atLeast: tok('t1') })).toBe('violation');
  });

  it('unknown when the path touched the declared-unknown token — never a fake ok', () => {
    const r = propagateDimension(uLat, [contrib('p', 'a', { [U]: tok('unk') })]);
    // even though unk is the weakest and would "violate", the honest answer is unknown, not violation
    expect(judgeGuarantee(uLat, r, { dimension: U, atLeast: tok('u1') })).toBe('unknown');
  });

  it('unknown when the requirement names a token outside the lattice', () => {
    const r = propagateDimension(dLat, [contrib('p', 'a', { [D]: tok('t0') })]);
    expect(judgeGuarantee(dLat, r, { dimension: D, atLeast: tok('nonsense') })).toBe('unknown');
  });
});

// ---- graph-level propagation (path enumeration + contribution order) ------------------------------------

const node = (id: string, ports: string[]): Node => ({ id: NodeId(id), ports: ports.map(PortId), cells: [] });
const outPort = (id: string, n: string, g?: Guarantees): Port => ({ id: PortId(id), node: NodeId(n), dir: 'out', ...(g ? { guarantees: g } : {}) });
const inPort = (id: string, n: string, g?: Guarantees): Port => ({ id: PortId(id), node: NodeId(n), dir: 'in', ...(g ? { guarantees: g } : {}) });
const edge = (id: string, from: string, to: string, semantics: 'sync' | 'async' = 'sync', g?: Guarantees): Edge => ({
  id: EdgeId(id),
  from: PortId(from),
  to: PortId(to),
  semantics,
  ...(g ? { guarantees: g } : {}),
});
function build(nodes: Node[], ports: Port[], edges: Edge[], cat: Categorical): Graph {
  const g = buildGraph({ nodes, ports, edges }, cat);
  if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
  return g.value;
}

describe('propagateFlow — path walk over a real graph', () => {
  const cat = vocab();

  it('linear chain: source out-port sets the start, an async edge degrades, root cause = that edge', () => {
    // a --(async, D:t1)--> b : the source provides t0 (strong), the async projection hop degrades to t1
    const nodes = [node('a', ['a.out']), node('b', ['b.in'])];
    const ports = [outPort('a.out', 'a', { [D]: tok('t0') }), inPort('b.in', 'b')];
    const edges = [edge('e0', 'a.out', 'b.in', 'async', { [D]: tok('t1') })];
    const flows = propagateFlow(build(nodes, ports, edges, cat), cat, NodeId('a'), NodeId('b'));
    expect(flows).toHaveLength(1);
    const d = (flows[0] as (typeof flows)[number]).dimensions.find((x) => x.dimension === D);
    expect(d?.token).toBe(tok('t1'));
    expect(d?.rootCause?.scope).toBe(EdgeId('e0'));
    expect(d?.rootCause?.node).toBe(NodeId('b'));
  });

  it('fan-out: enumerates a path per consumer; a topic out-port that drops ordering hits BOTH', () => {
    // a -> topic, topic --(out drops D to t2)--> wA and --> wB
    const nodes = [node('a', ['a.out']), node('t', ['t.in', 't.out']), node('wa', ['wa.in']), node('wb', ['wb.in'])];
    const ports = [
      outPort('a.out', 'a', { [D]: tok('t0') }),
      inPort('t.in', 't'),
      outPort('t.out', 't', { [D]: tok('t2') }), // the fan-out topic keeps no order
      inPort('wa.in', 'wa'),
      inPort('wb.in', 'wb'),
    ];
    const edges = [edge('e0', 'a.out', 't.in'), edge('e1', 't.out', 'wa.in'), edge('e2', 't.out', 'wb.in')];
    const g = build(nodes, ports, edges, cat);
    const toA = propagateFlow(g, cat, NodeId('a'), NodeId('wa'));
    const toB = propagateFlow(g, cat, NodeId('a'), NodeId('wb'));
    expect(toA).toHaveLength(1);
    expect(toB).toHaveLength(1);
    for (const flows of [toA, toB]) {
      const d = (flows[0] as (typeof flows)[number]).dimensions.find((x) => x.dimension === D);
      expect(d?.token).toBe(tok('t2'));
      expect(d?.rootCause?.scope).toBe(PortId('t.out')); // blamed on the topic's out port
    }
  });

  it('contributionsAlong yields source-out, edge, target-in in that order', () => {
    const nodes = [node('a', ['a.out']), node('b', ['b.in'])];
    const ports = [outPort('a.out', 'a', { [D]: tok('t0') }), inPort('b.in', 'b', { [D]: tok('t1') })];
    const edges = [edge('e0', 'a.out', 'b.in', 'sync', { [F]: tok('flagged') })];
    const cs = contributionsAlong(build(nodes, ports, edges, cat), [EdgeId('e0')]);
    expect(cs.map((c) => c.scope)).toEqual([PortId('a.out'), EdgeId('e0'), PortId('b.in')]);
  });
});

// propagateFlowEdges — the per-EDGE running meet the canvas STRIP paints. Pinned to the whole-path result
// (propagateFlow) so the strip a human sees can never disagree with the verdict a requirement is judged by (the
// anti-drift invariant the SURFACE round depends on).
describe('propagateFlowEdges — per-edge running meet, pinned to the whole-path result', () => {
  const cat = vocab();

  it('a linear chain: the LAST edge\'s running token equals propagateFlow\'s end-to-end token', () => {
    // a --(async, D:t1)--> b --> c : the async hop drops D to t1; the last edge's running meet must be t1 too.
    const nodes = [node('a', ['a.out']), node('b', ['b.in', 'b.out']), node('c', ['c.in'])];
    const ports = [outPort('a.out', 'a', { [D]: tok('t0') }), inPort('b.in', 'b'), outPort('b.out', 'b'), inPort('c.in', 'c')];
    const edges = [edge('e0', 'a.out', 'b.in', 'async', { [D]: tok('t1') }), edge('e1', 'b.out', 'c.in')];
    const g = build(nodes, ports, edges, cat);
    const whole = propagateFlow(g, cat, NodeId('a'), NodeId('c'))[0]!;
    const wholeD = whole.dimensions.find((x) => x.dimension === D)!;
    const perEdge = propagateFlowEdges(g, cat, D, NodeId('a'), NodeId('c'));
    expect(perEdge).toHaveLength(1);
    const edgesOfPath = perEdge[0]!.edges;
    // the running token AFTER the last edge equals the whole-path token (they are the same fold)
    expect(String(edgesOfPath[edgesOfPath.length - 1]!.to)).toBe(String(wholeD.token));
    // the FIRST edge is where it dropped from t0 → t1 (the async hop); the second re-states t1
    expect(String(edgesOfPath[0]!.from)).toBe('t0');
    expect(String(edgesOfPath[0]!.to)).toBe('t1');
    expect(String(edgesOfPath[1]!.to)).toBe('t1');
  });

  it('the strip is red FROM the degrading hop onward: every edge after the drop stays weakened', () => {
    // a --> b --(out drops D to t2 at b)--> c : the drop happens at b's out port (rides the b→c edge), so e0 holds
    // (t0) and e1 is weakened (t2). The strip logic (rank > need) reads exactly this per-edge `to`.
    const nodes = [node('a', ['a.out']), node('b', ['b.in', 'b.out']), node('c', ['c.in'])];
    const ports = [outPort('a.out', 'a', { [D]: tok('t0') }), inPort('b.in', 'b'), outPort('b.out', 'b', { [D]: tok('t2') }), inPort('c.in', 'c')];
    const edges = [edge('e0', 'a.out', 'b.in'), edge('e1', 'b.out', 'c.in')];
    const g = build(nodes, ports, edges, cat);
    const perEdge = propagateFlowEdges(g, cat, D, NodeId('a'), NodeId('c'))[0]!.edges;
    expect(String(perEdge[0]!.to)).toBe('t0'); // holds before the drop
    expect(String(perEdge[1]!.to)).toBe('t2'); // weakened from the b.out hop onward
  });

  it('propagates the touchedUnknown flag from the first unknown edge onward (gray strip)', () => {
    const nodes = [node('a', ['a.out']), node('b', ['b.in'])];
    const ports = [outPort('a.out', 'a', { [U]: tok('unk') }), inPort('b.in', 'b')];
    const edges = [edge('e0', 'a.out', 'b.in')];
    const g = build(nodes, ports, edges, cat);
    const perEdge = propagateFlowEdges(g, cat, U, NodeId('a'), NodeId('b'))[0]!.edges;
    expect(perEdge[0]!.touchedUnknown).toBe(true);
  });

  it('enumerateFlowPaths returns one path per fan-out consumer, in deterministic edge order', () => {
    const nodes = [node('a', ['a.out']), node('t', ['t.in', 't.out']), node('wa', ['wa.in']), node('wb', ['wb.in'])];
    const ports = [outPort('a.out', 'a'), inPort('t.in', 't'), outPort('t.out', 't'), inPort('wa.in', 'wa'), inPort('wb.in', 'wb')];
    const edges = [edge('e0', 'a.out', 't.in'), edge('e1', 't.out', 'wa.in'), edge('e2', 't.out', 'wb.in')];
    const g = build(nodes, ports, edges, cat);
    const toA = enumerateFlowPaths(g, NodeId('a'), NodeId('wa'));
    expect(toA).toHaveLength(1);
    expect(toA[0]!.map(String)).toEqual(['e0', 'e1']);
  });

  it('returns [] for an unknown dimension (nothing to paint)', () => {
    const nodes = [node('a', ['a.out']), node('b', ['b.in'])];
    const ports = [outPort('a.out', 'a', { [D]: tok('t0') }), inPort('b.in', 'b')];
    const edges = [edge('e0', 'a.out', 'b.in')];
    const g = build(nodes, ports, edges, cat);
    expect(propagateFlowEdges(g, cat, DimensionId('nonexistent'), NodeId('a'), NodeId('b'))).toEqual([]);
  });
});

// ---- DIFFERENTIAL + PROPERTY (the credibility net) ------------------------------------------------------

const T = ['t0', 't1', 't2'].map(tok);

describe('guarantee differential (forward fold vs DataScript) + monotonicity', () => {
  const cat = vocab();
  const dLat = cat.get(D);
  if (dLat === undefined) throw new Error('d');

  // A random contribution list for dimension D: each hop optionally names a token.
  const contribArb = fc.array(
    fc.record({
      scope: fc.constantFrom('p0', 'p1', 'p2', 'p3', 'p4', 'e0', 'e1'),
      hasToken: fc.boolean(),
      token: fc.constantFrom(...T),
    }),
    { maxLength: 8 },
  );

  it('forward fold and DataScript agree on the end-to-end token (order-free meet)', () => {
    fc.assert(
      fc.property(contribArb, (raw) => {
        const contributions: Contribution[] = raw.map((r, i) => contrib(r.scope, `n${i}`, r.hasToken ? { [D]: r.token } : {}));
        const forward = propagateDimension(dLat, contributions);
        const relational = meetDatalog(dLat, contributions);
        return forward.token === relational.token && forward.touchedUnknown === relational.touchedUnknown;
      }),
      { numRuns: 300 },
    );
  });

  it('MONOTONICITY: appending ANY hop never strengthens the result (a hop can only weaken)', () => {
    fc.assert(
      fc.property(contribArb, fc.record({ hasToken: fc.boolean(), token: fc.constantFrom(...T) }), (raw, extra) => {
        const base: Contribution[] = raw.map((r, i) => contrib(r.scope, `n${i}`, r.hasToken ? { [D]: r.token } : {}));
        const withHop = [...base, contrib('pX', 'nX', extra.hasToken ? { [D]: extra.token } : {})];
        const before = dLat.rank(propagateDimension(dLat, base).token);
        const after = dLat.rank(propagateDimension(dLat, withHop).token);
        if (before === undefined || after === undefined) return false;
        return after >= before; // rank can only grow (weaker) or stay — never shrink (stronger)
      }),
      { numRuns: 300 },
    );
  });

  it('the meet is order-INDEPENDENT for the final token (commutative monoid)', () => {
    fc.assert(
      fc.property(contribArb, fc.array(fc.nat(), { maxLength: 8 }), (raw, perm) => {
        const base: Contribution[] = raw.map((r, i) => contrib(r.scope, `n${i}`, r.hasToken ? { [D]: r.token } : {}));
        // a deterministic shuffle driven by the random nat array
        const shuffled = [...base];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = (perm[i % perm.length] ?? 0) % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j] as Contribution, shuffled[i] as Contribution];
        }
        return propagateDimension(dLat, base).token === propagateDimension(dLat, shuffled).token;
      }),
      { numRuns: 200 },
    );
  });
});
