import { describe, expect, it } from 'vitest';
import { Key, NodeId } from '@sda/engine-core';
import { buildModel, inCellIdOf, localCellIdOf } from './model';
import { corpusRegistry, corpusTunable, feasibleDesign, COST, SVC, THROUGHPUT } from '../conformance/corpus';

// THE NATIVE SEARCH MODEL's own tests — PURE. They pin the compiled model that every native
// search builds on: the knobs resolve to the right config cells with the right current/domain, the scalar bands
// lift to their out-cells, the evaluator overlays a knob assignment and returns engine-exact values, and a
// malformed tunable is rejected exactly as the incumbent's `compile` rejects it (the differential precondition).

describe('native model — buildModel over the hand-checked corpus', () => {
  it('resolves each tunable to its config cell with the right domain and current value', () => {
    const m = buildModel(feasibleDesign(), corpusRegistry, [corpusTunable]);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.value.knobs).toHaveLength(1);
    const knob = m.value.knobs[0]!;
    expect(knob.node).toBe(SVC);
    expect(knob.key).toBe(THROUGHPUT);
    expect(knob.cell).toBe(`cfg:${SVC}:${THROUGHPUT}`);
    expect(knob.min).toBe(0);
    expect(knob.max).toBe(1000);
    expect(knob.current).toBe(500); // the service's fixed capacity in the un-searched graph
  });

  it('lifts the scalar floor band to its out-cell', () => {
    const m = buildModel(feasibleDesign(), corpusRegistry, [corpusTunable]);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.value.bands).toHaveLength(1);
    const band = m.value.bands[0]!;
    expect(band.floor).toBe(300);
    expect(band.ceiling).toBeUndefined();
    expect(band.point).toBe(false);
    // A node band is the SINGLETON sum — its one cell is the node's out-cell (a system band would sum local cells).
    expect(band.cells).toEqual([`out:${SVC}:${THROUGHPUT}`]);
    expect(band.cells).toEqual([m.value.outCell(SVC, THROUGHPUT)]);
  });

  it('the evaluator overlays a knob assignment and reads engine-exact cell values', () => {
    const m = buildModel(feasibleDesign(), corpusRegistry, [corpusTunable]);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const ev = m.value.evaluate([300]);
    expect(ev.converged).toBe(true);
    expect(ev.value(m.value.outCell(SVC, THROUGHPUT))).toBe(300); // served = min(capacity 300, demand 1000)
    expect(ev.value(m.value.outCell(SVC, COST))).toBeCloseTo(30, 9); // cost = 300 · 0.1
    // A different assignment yields a different value — the evaluator is a pure function of the assignment.
    expect(m.value.evaluate([700]).value(m.value.outCell(SVC, THROUGHPUT))).toBe(700);
  });

  it('rejects a tunable that is not a fixed config input (differential with the incumbent compile)', () => {
    const m = buildModel(feasibleDesign(), corpusRegistry, [{ node: SVC, key: COST, min: 0, max: 100 }]);
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.error.join(' ')).toContain('must be a fixed config input');
  });

  it('the cell-id helpers name the in/local cells the headroom rule reads', () => {
    expect(inCellIdOf(NodeId('n'), Key('k'))).toBe('in:n:k');
    expect(localCellIdOf(NodeId('n'), Key('k'))).toBe('local:n:k');
  });
});
