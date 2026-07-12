import { describe, expect, it } from 'vitest';
import { simulate } from './des';
import { StationId, type QueueingNetwork } from './network';

// Finite buffers: a bounded queue DROPS arrivals once full — the time-domain form of back-pressure /
// message loss (a queue accumulating then erroring). Unbounded stations never drop (only queue/latency).
describe('DES finite buffer (back-pressure / loss)', () => {
  it('drops jobs when arrivals outpace service and the buffer is full', () => {
    const q = StationId('q');
    const net: QueueingNetwork = {
      stations: [{ id: q, service: { kind: 'exponential', rate: 100 }, servers: 1, capacity: 10 }],
      arrivals: [{ at: q, interarrival: { kind: 'exponential', rate: 500 } }], // offered 5× the drain
      routing: new Map(),
    };
    const r = simulate(net, { seed: 3, warmupCompletions: 2000, measureCompletions: 20000 });
    expect(r.stations.find((s) => s.id === q)?.dropped).toBeGreaterThan(0);
  });

  it('never drops with an unbounded buffer (stable load)', () => {
    const q = StationId('q');
    const net: QueueingNetwork = {
      stations: [{ id: q, service: { kind: 'exponential', rate: 100 }, servers: 1 }], // no capacity ⇒ ∞
      arrivals: [{ at: q, interarrival: { kind: 'exponential', rate: 50 } }],
      routing: new Map(),
    };
    const r = simulate(net, { seed: 3, warmupCompletions: 1000, measureCompletions: 5000 });
    expect(r.stations.find((s) => s.id === q)?.dropped).toBe(0);
  });
});
