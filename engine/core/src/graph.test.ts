import { describe, expect, it } from 'vitest';
import { applyTransform, buildGraph, cyclesProblem, type Cycle } from './graph';
import { EdgeId, NodeId, PortId } from './ids';

describe('buildGraph', () => {
  const n = NodeId('n1');
  const pOut = PortId('p-out');
  const pIn = PortId('p-in');

  it('builds a valid out→in graph', () => {
    const r = buildGraph({
      nodes: [{ id: n, ports: [pOut, pIn], cells: [] }],
      ports: [
        { id: pOut, node: n, dir: 'out' },
        { id: pIn, node: n, dir: 'in' },
      ],
      edges: [{ id: EdgeId('e1'), from: pOut, to: pIn, semantics: 'sync' }],
    });
    expect(r.ok).toBe(true);
  });

  it('collects all structural errors at once (missing port + bad direction)', () => {
    const r = buildGraph({
      nodes: [{ id: n, ports: [pOut], cells: [] }],
      ports: [{ id: pOut, node: n, dir: 'out' }],
      edges: [
        { id: EdgeId('e1'), from: pOut, to: PortId('ghost'), semantics: 'sync' }, // missing target port
        { id: EdgeId('e2'), from: pOut, to: pOut, semantics: 'sync' }, // out→out is illegal
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.some((e) => e.kind === 'edge-unknown-port')).toBe(true);
      expect(r.error.some((e) => e.kind === 'edge-direction')).toBe(true);
    }
  });

  // Port transforms are pure MATH data validated at build time — a malformed one is unrepresentable in a
  // built graph (doc: flow-transformations §6 honesty; the tool must not carry a nonsensical transfer).
  it('accepts a well-formed transform on a port (identity ratio(1) and a 100:1 batch)', () => {
    const r = buildGraph({
      nodes: [{ id: n, ports: [pOut, pIn], cells: [] }],
      ports: [
        { id: pOut, node: n, dir: 'out', transform: { kind: 'ratio', value: 100 } },
        { id: pIn, node: n, dir: 'in', transform: { kind: 'batch', value: 100 } },
      ],
      edges: [{ id: EdgeId('e1'), from: pOut, to: pIn, semantics: 'sync' }],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a transform with a non-positive parameter (ratio 0, batch −1, cap 0)', () => {
    for (const bad of [
      { kind: 'ratio', value: 0 } as const,
      { kind: 'batch', value: -1 } as const,
      { kind: 'cap', value: 0 } as const,
      { kind: 'window', value: 0 } as const,
    ]) {
      const r = buildGraph({
        nodes: [{ id: n, ports: [pOut], cells: [] }],
        ports: [{ id: pOut, node: n, dir: 'out', transform: bad }],
        edges: [],
      });
      expect(r.ok, `${bad.kind}(${bad.value}) must be rejected`).toBe(false);
      if (!r.ok) expect(r.error.some((e) => e.kind === 'transform-value')).toBe(true);
    }
  });

  it('rejects a prob transform outside (0, 1] but accepts p ≤ 1', () => {
    const over = buildGraph({
      nodes: [{ id: n, ports: [pOut], cells: [] }],
      ports: [{ id: pOut, node: n, dir: 'out', transform: { kind: 'prob', value: 1.5 } }],
      edges: [],
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.some((e) => e.kind === 'transform-value')).toBe(true);

    const ok = buildGraph({
      nodes: [{ id: n, ports: [pOut], cells: [] }],
      ports: [{ id: pOut, node: n, dir: 'out', transform: { kind: 'prob', value: 0.01 } }],
      edges: [],
    });
    expect(ok.ok).toBe(true);
  });

  it('accepts a well-formed per-WIRE transform on an edge (a routing split prob(0.7))', () => {
    const r = buildGraph({
      nodes: [{ id: n, ports: [pOut, pIn], cells: [] }],
      ports: [
        { id: pOut, node: n, dir: 'out' },
        { id: pIn, node: n, dir: 'in' },
      ],
      edges: [{ id: EdgeId('e1'), from: pOut, to: pIn, semantics: 'sync', transform: { kind: 'prob', value: 0.7 } }],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a malformed per-WIRE transform on an edge (edge-transform-value, same rule as a port)', () => {
    for (const bad of [{ kind: 'ratio', value: 0 } as const, { kind: 'prob', value: 1.5 } as const, { kind: 'batch', value: -2 } as const]) {
      const r = buildGraph({
        nodes: [{ id: n, ports: [pOut, pIn], cells: [] }],
        ports: [
          { id: pOut, node: n, dir: 'out' },
          { id: pIn, node: n, dir: 'in' },
        ],
        edges: [{ id: EdgeId('e1'), from: pOut, to: pIn, semantics: 'sync', transform: bad }],
      });
      expect(r.ok, `wire ${bad.kind}(${bad.value}) must be rejected`).toBe(false);
      if (!r.ok) expect(r.error.some((e) => e.kind === 'edge-transform-value')).toBe(true);
    }
  });

  // GENERATE — the sixth port function (doc: load-stages §4): a generator ORIGINATES flow. Validation pins the
  // doc's rules: out/bi ports only; level finite ≥ 0; the cycles well-formed (periodS > 0, non-empty stages,
  // durationS > 0, multiplier ≥ 0 with some > 0, Σ durationS ≤ periodS); no per-WIRE generators in R1. The
  // edge-seam arithmetic is the identity (the level folds at the NODE).
  describe('generate — the generator port function', () => {
    const cycles: Cycle[] = [{ periodS: 86_400, stages: [{ durationS: 43_200, multiplier: 1.5 }, { durationS: 43_200, multiplier: 0.5 }] }];

    it('accepts a generator on an out port (with and without cycles, with disable), and on a bi port', () => {
      for (const dir of ['out', 'bi'] as const) {
        const r = buildGraph({
          nodes: [{ id: n, ports: [pOut], cells: [] }],
          ports: [{ id: pOut, node: n, dir, transform: { kind: 'generate', level: 200, cycles } }],
          edges: [],
        });
        expect(r.ok, `generate on a ${dir} port`).toBe(true);
      }
      const disabled = buildGraph({
        nodes: [{ id: n, ports: [pOut], cells: [] }],
        ports: [{ id: pOut, node: n, dir: 'out', transform: { kind: 'generate', level: 200, cycles, disable: true } }],
        edges: [],
      });
      expect(disabled.ok).toBe(true);
      const bare = buildGraph({
        nodes: [{ id: n, ports: [pOut], cells: [] }],
        ports: [{ id: pOut, node: n, dir: 'out', transform: { kind: 'generate', level: 0 } }], // level 0 = declared-but-silent, legal
        edges: [],
      });
      expect(bare.ok).toBe(true);
    });

    it('refuses a generator on an IN port, naming the port (generate-on-in-port)', () => {
      const r = buildGraph({
        nodes: [{ id: n, ports: [pIn], cells: [] }],
        ports: [{ id: pIn, node: n, dir: 'in', transform: { kind: 'generate', level: 200 } }],
        edges: [],
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.some((e) => e.kind === 'generate-on-in-port' && e.port === pIn)).toBe(true);
    });

    it('refuses a per-WIRE generator (generate-on-edge — a port function in R1)', () => {
      const r = buildGraph({
        nodes: [{ id: n, ports: [pOut, pIn], cells: [] }],
        ports: [
          { id: pOut, node: n, dir: 'out' },
          { id: pIn, node: n, dir: 'in' },
        ],
        edges: [{ id: EdgeId('e1'), from: pOut, to: pIn, semantics: 'sync', transform: { kind: 'generate', level: 100 } }],
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.some((e) => e.kind === 'generate-on-edge')).toBe(true);
    });

    it('rejects a malformed level (negative, NaN, Infinity) as transform-value', () => {
      for (const level of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const r = buildGraph({
          nodes: [{ id: n, ports: [pOut], cells: [] }],
          ports: [{ id: pOut, node: n, dir: 'out', transform: { kind: 'generate', level } }],
          edges: [],
        });
        expect(r.ok, `level ${level} must be rejected`).toBe(false);
        if (!r.ok) expect(r.error.some((e) => e.kind === 'transform-value')).toBe(true);
      }
    });

    it('rejects malformed cycles through the same transform-value gate, with a guided cyclesProblem', () => {
      const bads: readonly Cycle[][] = [
        [{ periodS: 86_400, stages: [] }], // empty stages
        [{ periodS: 0, stages: [{ durationS: 10, multiplier: 1 }] }], // degenerate period
        [{ periodS: 86_400, stages: [{ durationS: 0, multiplier: 1 }] }], // zero-duration stage
        [{ periodS: 86_400, stages: [{ durationS: 10, multiplier: -0.5 }] }], // negative multiplier
        [{ periodS: 86_400, stages: [{ durationS: 10, multiplier: 0 }] }], // all-zero (no traffic)
        [{ periodS: 100, stages: [{ durationS: 60, multiplier: 1 }, { durationS: 60, multiplier: 2 }] }], // Σ durationS > periodS
      ];
      for (const bad of bads) {
        expect(cyclesProblem(bad), JSON.stringify(bad)).not.toBeNull();
        const r = buildGraph({
          nodes: [{ id: n, ports: [pOut], cells: [] }],
          ports: [{ id: pOut, node: n, dir: 'out', transform: { kind: 'generate', level: 100, cycles: bad } }],
          edges: [],
        });
        expect(r.ok, JSON.stringify(bad)).toBe(false);
        if (!r.ok) expect(r.error.some((e) => e.kind === 'transform-value')).toBe(true);
      }
      expect(cyclesProblem(cycles)).toBeNull();
      expect(cyclesProblem([])).toBeNull(); // no cycles = a flat generator, legal and silent
    });

    it('applyTransform(generate) is the identity at the edge seam (the level folds at the node)', () => {
      expect(applyTransform({ kind: 'generate', level: 500 }, 123)).toBe(123);
      expect(applyTransform({ kind: 'generate', level: 500, cycles }, 0)).toBe(0);
    });
  });
});
