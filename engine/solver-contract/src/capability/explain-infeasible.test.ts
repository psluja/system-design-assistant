import { describe, expect, it } from 'vitest';
import { Key, NodeId } from '@sda/engine-core';
import type { ExplainInfeasible, ExplainRequest, Shortfall } from './explain-infeasible';
import type { Tunable } from './optimize';
import { didNotConverge, solved } from '../honesty';
import { infeasibleDesign } from '../conformance/corpus';

describe('ExplainInfeasible capability (the exact shortfall)', () => {
  const tunable: Tunable = { node: NodeId('svc'), key: Key('throughput'), min: 0, max: 1000 };
  const req: ExplainRequest = { graph: infeasibleDesign(), tunables: [tunable] };

  it('a solved implementation names which SLO fails and by how much', async () => {
    const shortfall: Shortfall = { node: NodeId('svc'), key: Key('throughput'), bound: 'floor', amount: 200 };
    const stub: ExplainInfeasible = async () => solved([shortfall]);
    const r = await stub(req);
    expect(r.kind).toBe('solved');
    if (r.kind !== 'solved') return;
    expect(r.value[0]?.bound).toBe('floor');
    expect(r.value[0]?.amount).toBe(200);
  });

  it('an empty shortfall list means the design is feasible', async () => {
    const stub: ExplainInfeasible = async () => solved([]);
    const r = await stub(req);
    if (r.kind !== 'solved') return;
    expect(r.value).toEqual([]);
  });

  it('the only non-solved outcome is did-not-converge (the relaxed model is always satisfiable)', async () => {
    const stub: ExplainInfeasible = async () => didNotConverge;
    expect((await stub(req)).kind).toBe('did-not-converge');
  });
});
