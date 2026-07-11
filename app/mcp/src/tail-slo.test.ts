import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, manifests, commonManifests } from '@sda/content';
import { buildTools, type AnyTool } from './tools';

// TASK-19 (honesty): a TAIL/percentile latency SLO must NOT be answered from the scalar mean. set_slo can now
// express a percentile band; the forward `evaluate` reports it as `unknown` (the tail needs the DES) rather than
// a false green off the mean. A scalar band still checks the mean — the two are kept distinct.
const catalog = { ...manifests, ...commonManifests };

describe('set_slo — percentile (tail) SLO is honest, not a scalar false green', () => {
  const setup = () => {
    const s = new Studio(registry, catalog);
    const tools = buildTools(s);
    const call = (name: string, a: Record<string, unknown> = {}) => (tools.find((t) => t.name === name) as AnyTool).run(a);
    call('apply_design', { instances: [{ id: 'client', type: 'client.web', config: { throughput: 100 } }, { id: 'fn', type: 'compute.faas' }], wires: [['client', 'fn']] });
    const statusOf = (key: string) => (JSON.parse((call('evaluate') as { text: string }).text) as { verdicts: Array<{ scope: string; key: string; status: string }> }).verdicts.find((v) => v.scope === 'fn' && v.key === key)?.status;
    return { call, statusOf };
  };

  it('a SCALAR latency band checks the mean (50 ms > 10 ⇒ violation)', () => {
    const { call, statusOf } = setup();
    call('set_slo', { node: 'fn', key: 'latency', max: 10 });
    expect(statusOf('latency')).toBe('violation'); // scalar mean is genuinely over the ceiling
  });

  it('a PERCENTILE (tail) SLO on tailLatency is `unknown` on the scalar pass — never a scalar pass/fail', () => {
    const { call, statusOf } = setup();
    call('set_slo', { node: 'fn', key: 'tailLatency', percentiles: { p99: 10 } });
    expect(statusOf('tailLatency')).toBe('unknown'); // the tail needs the DES; the forward pass refuses to guess
  });
});
