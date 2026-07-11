import { describe, expect, it } from 'vitest';
import { Key, NodeId } from '@sda/engine-core';
import type { Objective, Optimize, OptimizeRequest, Tunable } from './optimize';
import { didNotConverge, infeasible, solved } from '../honesty';
import { feasibleDesign } from '../conformance/corpus';

describe('Optimize capability (search a knob against SLOs)', () => {
  const tunable: Tunable = { node: NodeId('svc'), key: Key('throughput'), min: 0, max: 1000 };
  const objective: Objective = { node: NodeId('svc'), key: Key('cost'), direction: 'min' };
  const req: OptimizeRequest = { graph: feasibleDesign(), tunables: [tunable], objective };

  it('a solved implementation returns assignments + a value reader', async () => {
    const stub: Optimize = async () =>
      solved({ assignments: [{ node: NodeId('svc'), key: Key('throughput'), value: 300 }], value: () => 30 });
    const r = await stub(req);
    expect(r.kind).toBe('solved');
    if (r.kind !== 'solved') return;
    expect(r.value.assignments[0]?.value).toBe(300);
    expect(r.value.value(NodeId('svc'), Key('cost'))).toBe(30);
  });

  it('the honesty triad is returnable and distinct', async () => {
    const asInfeasible: Optimize = async () => infeasible;
    const asTimeout: Optimize = async () => didNotConverge;
    expect((await asInfeasible(req)).kind).toBe('infeasible');
    expect((await asTimeout(req)).kind).toBe('did-not-converge');
  });

  it('the request carries an optional headroom and an optional abort signal', () => {
    const c = new AbortController();
    const withExtras: OptimizeRequest = { ...req, headroom: { key: Key('throughput'), factor: 0.8 }, signal: c.signal };
    expect(withExtras.headroom?.factor).toBe(0.8);
    expect(withExtras.signal?.aborted).toBe(false);
  });
});
