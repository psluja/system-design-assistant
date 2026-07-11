import { describe, expect, it } from 'vitest';
import { buildGraph, Key, NodeId, PortId } from '@sda/engine-core';
import { generateNumeric, generatedRegistry, THROUGHPUT, COST } from '../harness/generator';
import { compileProgram } from './compile';

// GPU BACKEND — the compiler (TASK-81). These pin the DECLINE contract (honest structural refusals, never a
// guessed arithmetic) and the program shape the two executors (fp32 JS + WGSL) consume. The fp32 NUMERICS are
// proven against the fp64 reference in ./fp32.test.ts; here we prove the compile step itself.

describe('gpu compile — a real design compiles to a runnable program', () => {
  it('a generated chain compiles: cells, bytecode, ≥1 sweep, and override/output slot maps', () => {
    const inst = generateNumeric(1, 'optimize', 'chain', 'sat');
    const r = compileProgram(inst.graph, generatedRegistry);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.program;
    expect(p.nCells).toBeGreaterThan(0);
    expect(p.code.length).toBe(p.nInstr * 2);
    expect(p.nInstr).toBeGreaterThan(0);
    expect(p.sweeps).toBeGreaterThanOrEqual(1);
    expect(p.stackCap).toBeGreaterThanOrEqual(1);
    // Every tunable tier's THROUGHPUT capacity is an overridable config slot (a Monte-Carlo sample coordinate).
    for (const t of inst.tunables) expect(p.overrideSlotOf.has(`${String(t.node)}|${String(t.key)}`)).toBe(true);
    // The SLO tier's cost + throughput outputs are readable (value(node,key) reads these settled slots).
    expect(p.outIndexOf.has(`${String(inst.objective.node)}|${String(COST)}`)).toBe(true);
    expect(p.outIndexOf.has(`${String(inst.objective.node)}|${String(THROUGHPUT)}`)).toBe(true);
  });

  it('the compile is deterministic — the same graph yields byte-identical bytecode + constants', () => {
    const inst = generateNumeric(7, 'optimize', 'fan-in', 'sat');
    const a = compileProgram(inst.graph, generatedRegistry);
    const b = compileProgram(inst.graph, generatedRegistry);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect([...a.program.code]).toEqual([...b.program.code]);
    expect([...a.program.consts]).toEqual([...b.program.consts]);
    expect([...a.program.baseCells]).toEqual([...b.program.baseCells]);
  });
});

describe('gpu compile — honest STRUCTURAL declines (never a guessed answer; fall back to CPU)', () => {
  it('declines build-error when a relation reads an unregistered key (the network cannot be built)', () => {
    // A node with a derived cell whose relation references a key ABSENT from the registry (`ghost`, which is not in
    // generatedRegistry) ⇒ buildNetwork errors ⇒ the GPU backend declines honestly and the caller runs the CPU
    // reference (which reports the same build error).
    const n = NodeId('n');
    const p = PortId('n.in');
    const g = buildGraph({
      nodes: [{ id: n, ports: [p], cells: [{ kind: 'derived', key: THROUGHPUT, relation: { produces: THROUGHPUT, reads: [Key('ghost')], expr: 'ghost * 2' } }] }],
      ports: [{ id: p, node: n, dir: 'in' }],
      edges: [],
    });
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const r = compileProgram(g.value, generatedRegistry);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.decline.kind).toBe('build-error');
  });
});
