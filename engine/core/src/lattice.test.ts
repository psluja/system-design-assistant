import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  categoricalOf,
  DimensionId,
  DimensionToken,
  EdgeId,
  NodeId,
  PortId,
  type Dimension,
  type Edge,
  type Node,
  type Port,
} from './index';

// The generic categorical-lattice primitive. The engine knows only the SHAPE —
// ordered opaque tokens + the meet — so these tests use neutral tokens (t0 strongest … t2 weakest) and a
// boolean-flag dimension, never a domain word. Domain meaning ('strong'/'eventual'/'none') is content's job.

const dim = (id: string, tokens: string[], unknown?: string): Dimension => ({
  id: DimensionId(id),
  tokens: tokens.map(DimensionToken),
  ...(unknown !== undefined ? { unknown: DimensionToken(unknown) } : {}),
});

describe('categorical lattice primitive', () => {
  it('compiles an ordered dimension: rank, meet (weaker wins), top (identity)', () => {
    const c = categoricalOf([dim('d', ['t0', 't1', 't2'])]);
    if (!c.ok) throw new Error('should compile');
    const lat = c.value.get(DimensionId('d'));
    if (lat === undefined) throw new Error('dimension present');
    const [t0, t1, t2] = ['t0', 't1', 't2'].map(DimensionToken) as [DimensionToken, DimensionToken, DimensionToken];

    expect(lat.rank(t0)).toBe(0); // index 0 = strongest
    expect(lat.rank(t2)).toBe(2);
    expect(lat.top()).toBe(t0);
    // meet = the WEAKER (larger-rank) token, in any argument order
    expect(lat.meet(t0, t1)).toBe(t1);
    expect(lat.meet(t1, t0)).toBe(t1);
    expect(lat.meet(t2, t1)).toBe(t2);
    // meeting with TOP is a no-op; meet is idempotent
    expect(lat.meet(t0, t2)).toBe(t2);
    expect(lat.meet(t1, t1)).toBe(t1);
  });

  it('models a boolean monotone flag as the degenerate two-token lattice (meet = the flagged token)', () => {
    // [clean, flagged]: 'flagged' is weaker, so once any hop declares it the meet stays flagged — the monotone OR
    // (delivery: may-duplicate). One mechanism, no separate boolean primitive.
    const c = categoricalOf([dim('flag', ['clean', 'flagged'])]);
    if (!c.ok) throw new Error('should compile');
    const lat = c.value.get(DimensionId('flag'));
    if (lat === undefined) throw new Error('present');
    const clean = DimensionToken('clean');
    const flagged = DimensionToken('flagged');
    expect(lat.meet(clean, flagged)).toBe(flagged);
    expect(lat.meet(clean, clean)).toBe(clean);
    expect(lat.meet(flagged, flagged)).toBe(flagged);
    expect(lat.top()).toBe(clean);
  });

  it('accepts a declared-unknown token that is one of the tokens', () => {
    const c = categoricalOf([dim('d', ['t0', 't1', 'unk'], 'unk')]);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.value.get(DimensionId('d'))?.unknown).toBe(DimensionToken('unk'));
  });

  it('collects every well-formedness error at once (empty, duplicate token, duplicate dimension, absent unknown)', () => {
    const c = categoricalOf([
      dim('empty', []),
      dim('dupTok', ['a', 'a']),
      dim('ok', ['x', 'y']),
      dim('ok', ['x', 'y']), // duplicate dimension id
      dim('badUnk', ['a', 'b'], 'c'), // unknown token not among tokens
    ]);
    expect(c.ok).toBe(false);
    if (c.ok) return;
    const kinds = c.error.map((e) => e.kind).sort();
    expect(kinds).toContain('empty-dimension');
    expect(kinds).toContain('duplicate-token');
    expect(kinds).toContain('duplicate-dimension');
    expect(kinds).toContain('unknown-token-absent');
  });

  it('an empty vocabulary is legal (a design that uses no categorical dimensions)', () => {
    const c = categoricalOf([]);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.value.dimensions).toEqual([]);
  });
});

// buildGraph validation: a mislabelled guarantee must be unrepresentable in a built graph (doc §3).
const node = (id: string, ports: string[]): Node => ({ id: NodeId(id), ports: ports.map(PortId), cells: [] });

describe('buildGraph guarantee validation', () => {
  const cat = categoricalOf([dim('d', ['t0', 't1'])]);
  if (!cat.ok) throw new Error('vocab');
  const categorical = cat.value;

  it('accepts a graph whose guarantees name known dimensions and tokens', () => {
    const ports: Port[] = [
      { id: PortId('a.out'), node: NodeId('a'), dir: 'out', guarantees: { [DimensionId('d')]: DimensionToken('t0') } },
      { id: PortId('b.in'), node: NodeId('b'), dir: 'in', guarantees: { [DimensionId('d')]: DimensionToken('t1') } },
    ];
    const edges: Edge[] = [{ id: EdgeId('e0'), from: PortId('a.out'), to: PortId('b.in'), semantics: 'sync' }];
    const g = buildGraph({ nodes: [node('a', ['a.out']), node('b', ['b.in'])], ports, edges }, categorical);
    expect(g.ok).toBe(true);
  });

  it('rejects an unknown DIMENSION and an unknown TOKEN, naming the offending scope', () => {
    const ports: Port[] = [
      { id: PortId('a.out'), node: NodeId('a'), dir: 'out', guarantees: { [DimensionId('nope')]: DimensionToken('t0') } },
      { id: PortId('b.in'), node: NodeId('b'), dir: 'in', guarantees: { [DimensionId('d')]: DimensionToken('typo') } },
    ];
    const edges: Edge[] = [
      { id: EdgeId('e0'), from: PortId('a.out'), to: PortId('b.in'), semantics: 'sync', guarantees: { [DimensionId('d')]: DimensionToken('t9') } },
    ];
    const g = buildGraph({ nodes: [node('a', ['a.out']), node('b', ['b.in'])], ports, edges }, categorical);
    expect(g.ok).toBe(false);
    if (g.ok) return;
    const dimErr = g.error.find((e) => e.kind === 'guarantee-unknown-dimension');
    const tokErrPort = g.error.find((e) => e.kind === 'guarantee-unknown-token' && e.scope === PortId('b.in'));
    const tokErrEdge = g.error.find((e) => e.kind === 'guarantee-unknown-token' && e.scope === EdgeId('e0'));
    expect(dimErr).toBeDefined();
    expect(tokErrPort).toBeDefined();
    expect(tokErrEdge).toBeDefined();
  });

  it('with NO categorical passed, guarantees are not validated (today-bit-for-bit for guarantee-free callers)', () => {
    // The numeric engine builds graphs without a categorical vocabulary; that path must be untouched.
    const ports: Port[] = [{ id: PortId('a.out'), node: NodeId('a'), dir: 'out', guarantees: { [DimensionId('whatever')]: DimensionToken('x') } }];
    const g = buildGraph({ nodes: [node('a', ['a.out'])], ports, edges: [] });
    expect(g.ok).toBe(true); // no categorical ⇒ the guarantee check is a no-op
  });
});
