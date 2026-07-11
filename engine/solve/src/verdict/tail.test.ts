import { describe, expect, it } from 'vitest';
import { buildGraph, registryOf, Key, NodeId, Unit, type Node, type Verdict } from '@sda/engine-core';
import { checkTailBands, type TailProvider } from './tail';

const latency = Key('latency');

const registry = registryOf([
  { key: latency, unit: Unit('ms'), band: 'percentiles', aggregate: { series: 'max', onAsyncEdge: 'carry' }, kind: 'input' },
]);

const svc = NodeId('svc');

/** Build a one-node graph carrying a single percentiles band and run checkTailBands against it. */
function tailVerdict(targets: readonly (readonly [string, number])[], tail: TailProvider): Verdict {
  const nodes: Node[] = [
    {
      id: svc,
      ports: [],
      cells: [{ kind: 'input', key: latency, value: { kind: 'band', band: { shape: 'percentiles', targets: new Map(targets) } } }],
    },
  ];
  const g = buildGraph({ nodes, ports: [], edges: [] });
  if (!g.ok) throw new Error('invalid graph');
  const v = checkTailBands(g.value, registry, tail).find((x) => x.key === latency && x.scope === svc);
  if (v === undefined) throw new Error('no tail verdict for latency');
  return v;
}

/** A STUB TailProvider: answers only the quantiles in `answers`, and records every quantile it is asked. */
function stubTail(answers: ReadonlyMap<number, number>): { provider: TailProvider; asked: number[] } {
  const asked: number[] = [];
  return {
    provider: (_node, _key, q) => {
      asked.push(q);
      return answers.get(q);
    },
    asked,
  };
}

/** A STUB TailProvider that would answer ANY quantile with `value` — proves malformed labels never reach it. */
function alwaysTail(value: number): { provider: TailProvider; asked: number[] } {
  const asked: number[] = [];
  return {
    provider: (_node, _key, q) => {
      asked.push(q);
      return value;
    },
    asked,
  };
}

describe('checkTailBands', () => {
  it('reports the value of the HIGHEST answered quantile when all targets are answered', () => {
    // p50/p99/p999 all under target → ok; reported value must be the p999 (0.999) tail, not p50/p99.
    const { provider } = stubTail(new Map([[0.5, 100], [0.99, 200], [0.999, 300]]));
    const v = tailVerdict([['p50', 1000], ['p99', 1000], ['p999', 1000]], provider);
    expect(v.status).toBe('ok');
    expect(v.computed.value).toBe(300);
    expect(v.computed.unit).toBe(Unit('ms'));
  });

  it('reports the highest ANSWERED quantile when the topmost target has no tail', () => {
    // provider cannot answer p999 (0.999); reported must fall back to p99 (0.99), the highest answered.
    const { provider } = stubTail(new Map([[0.5, 100], [0.99, 200]]));
    const v = tailVerdict([['p50', 1000], ['p99', 1000], ['p999', 1000]], provider);
    expect(v.status).toBe('ok');
    expect(v.computed.value).toBe(200);
  });

  it('flags a violation when an answered quantile exceeds its target and still reports the top tail', () => {
    const { provider } = stubTail(new Map([[0.5, 100], [0.99, 200], [0.999, 300]]));
    const v = tailVerdict([['p50', 1000], ['p99', 1000], ['p999', 250]], provider);
    expect(v.status).toBe('violation');
    expect(v.computed.value).toBe(300); // highest answered quantile
    expect(v.remediations.length).toBeGreaterThan(0);
  });

  it("stays 'unknown' (never a fabricated number) when the provider cannot answer any quantile", () => {
    const { provider } = stubTail(new Map()); // answers nothing
    const v = tailVerdict([['p50', 1000], ['p99', 1000]], provider);
    expect(v.status).toBe('unknown');
    expect(Number.isNaN(v.computed.value)).toBe(true);
    expect(v.remediations).toEqual([]);
  });

  it("parses 'p999' to the 0.999 quantile", () => {
    const { provider, asked } = stubTail(new Map([[0.999, 42]]));
    const v = tailVerdict([['p999', 1000]], provider);
    expect(asked).toContain(0.999);
    expect(v.status).toBe('ok');
    expect(v.computed.value).toBe(42);
  });

  it("rejects malformed labels ('p', 'px', 'p0') — they never reach the provider and leave the band 'unknown'", () => {
    // A provider that WOULD answer anything; if any label parsed it would be consulted and flip status.
    const { provider, asked } = alwaysTail(999);
    const v = tailVerdict([['p', 1], ['px', 1], ['p0', 1]], provider);
    expect(v.status).toBe('unknown'); // all labels rejected by quantileOf before the provider
    expect(asked).toEqual([]); // provider never consulted for a malformed label
    expect(Number.isNaN(v.computed.value)).toBe(true);
  });

  it('skips malformed labels but still answers the one valid label in a mixed band', () => {
    // 'p0' → 0 is out of the open (0,1) range and rejected; only 'p99' (0.99) is a legal quantile.
    const { provider, asked } = stubTail(new Map([[0.99, 77]]));
    const v = tailVerdict([['p', 1], ['px', 1], ['p0', 1], ['p99', 1000]], provider);
    expect(asked).toEqual([0.99]); // only the legal label reached the provider
    expect(v.status).toBe('ok');
    expect(v.computed.value).toBe(77);
  });
});
