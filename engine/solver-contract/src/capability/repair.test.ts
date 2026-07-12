import { describe, expect, it } from 'vitest';
import { Key, NodeId } from '@sda/engine-core';
import type { Change, Repair, RepairRequest } from './repair';
import type { Tunable } from './optimize';
import { solved } from '../honesty';
import { violatedDesign } from '../conformance/corpus';

describe('Repair capability (the minimal edit)', () => {
  const tunable: Tunable = { node: NodeId('svc'), key: Key('throughput'), min: 0, max: 1000 };
  const req: RepairRequest = { graph: violatedDesign(), tunables: [tunable] };

  it('a solved implementation returns the changes that fix the design', async () => {
    const change: Change = { node: NodeId('svc'), key: Key('throughput'), from: 500, to: 800, delta: 300 };
    const stub: Repair = async () => solved([change]);
    const r = await stub(req);
    expect(r.kind).toBe('solved');
    if (r.kind !== 'solved') return;
    expect(r.value[0]?.delta).toBe(300);
  });

  it('a solved with an EMPTY change list means the design already holds', async () => {
    const stub: Repair = async () => solved([]);
    const r = await stub(req);
    expect(r.kind).toBe('solved');
    if (r.kind !== 'solved') return;
    expect(r.value).toEqual([]);
  });
});
