import { describe, expect, it } from 'vitest';
import { EdgeId, NodeId, PortId, type Graph } from '@sda/engine-core';
import { judgeGuarantee, propagateFlow } from '@sda/engine-solve';
import { commonManifests, instantiate, categorical, dims, consistency, ordering, delivery, asyncProjectionGuarantees, type Instance, type Wire } from './index';

// END-TO-END: the CQRS guarantee story on ONE real design compiled from content manifests (doc:
// guarantee-propagation §5 R1 gate). Proves all three lenses with EXACT root-cause attribution:
//   • write path        → consistency STRONG (terminates at the primary/writer)
//   • read-via-async-projection → consistency EVENTUAL, root-caused to the async projection hop
//   • ordering at a fan-out → NONE at SQS standard (root-caused to its out port) vs PER-KEY at SQS FIFO
// The engine did the lattice math on OPAQUE tokens; the meaning ('strong'/'eventual'/'none') is content here.

const build = (instances: Instance[], wires: Wire[]): Graph => {
  const g = instantiate(commonManifests, instances, wires);
  if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
  return g.value;
};
// Find the single dimension result for a flow's first path (these designs are linear per query path).
const dim = (graph: Graph, source: string, terminal: string, id: (typeof dims)[keyof typeof dims]) => {
  const flows = propagateFlow(graph, categorical, NodeId(source), NodeId(terminal));
  const first = flows[0];
  if (first === undefined) throw new Error(`no path ${source} → ${terminal}`);
  const d = first.dimensions.find((x) => x.dimension === id);
  if (d === undefined) throw new Error(`no dimension ${id}`);
  return d;
};

describe('guarantee propagation e2e — the CQRS story (write strong, async read eventual, order lost at fan-out)', () => {
  it('WRITE PATH: a request terminating at the primary is strongly consistent (no drop)', () => {
    // client → service → primary Postgres (the write). The writer IN port provides consistency:strong.
    const graph = build(
      [
        { id: 'client', type: 'client.web' },
        { id: 'svc', type: 'compute.service' },
        { id: 'pg', type: 'db.postgres' },
      ],
      [
        { from: ['client', 'out'], to: ['svc', 'in'] },
        { from: ['svc', 'db'], to: ['pg', 'in'] },
      ],
    );
    const c = dim(graph, 'client', 'pg', dims.consistency);
    expect(c.token).toBe(consistency.strong);
    expect(c.rootCause).toBeNull(); // nothing weakened it — the promise holds end to end
    // and a "Consistency = strong" requirement is satisfied
    const lat = categorical.get(dims.consistency);
    if (lat === undefined) throw new Error('lattice');
    expect(judgeGuarantee(lat, c, { dimension: dims.consistency, atLeast: consistency.strong })).toBe('ok');
  });

  it('READ VIA ASYNC PROJECTION: consistency degrades to eventual, root-caused to the async hop', () => {
    // client → service → read replica, but the replica is fed by an ASYNC projection wire (a materialised read
    // model updated asynchronously). The wire carries consistency:eventual, so the read is eventual and the
    // provable root cause is that exact hop — the invisible production bug (post, refresh, comment gone) made visible.
    const graph = build(
      [
        { id: 'client', type: 'client.web' },
        { id: 'svc', type: 'compute.service' },
        { id: 'replica', type: 'db.postgres.replica' },
      ],
      [
        { from: ['client', 'out'], to: ['svc', 'in'] },
        // the async projection hop: content decides an async materialised-view update means eventual reads
        { from: ['svc', 'db'], to: ['replica', 'in'], semantics: 'async', guarantees: asyncProjectionGuarantees },
      ],
    );
    const c = dim(graph, 'client', 'replica', dims.consistency);
    expect(c.token).toBe(consistency.eventual);
    // the root cause is the async projection EDGE, not the replica node's own eventual contribution — the earliest
    // drop wins (the edge sits before the replica's in-port in path order), attributing to the projection hop.
    expect(c.rootCause?.scope).toBe(EdgeId('e1')); // e1 = the second wire (svc.db → replica.in)
    const lat = categorical.get(dims.consistency);
    if (lat === undefined) throw new Error('lattice');
    // "Consistency = strong" is now VIOLATED, honestly, with the fix site named
    expect(judgeGuarantee(lat, c, { dimension: dims.consistency, atLeast: consistency.strong })).toBe('violation');
    // but "Consistency ≥ eventual" holds
    expect(judgeGuarantee(lat, c, { dimension: dims.consistency, atLeast: consistency.eventual })).toBe('ok');
  });

  it('ORDERING LOST AT A FAN-OUT: SQS standard → none (+ may-duplicate); SQS FIFO → per-key', () => {
    // producer → queue → worker, once through standard SQS and once through FIFO. The queue's OUT port carries the
    // ordering/delivery contribution, so the consumer path computes it. This is the fan-out ordering bug from the doc.
    const commonInstances = (queueType: string): Instance[] => [
      { id: 'producer', type: 'client.web' },
      { id: 'q', type: queueType },
      { id: 'worker', type: 'compute.serverless' }, // a queue-driven worker (its in-port accepts sqs triggers)
    ];
    const wires: Wire[] = [
      { from: ['producer', 'out'], to: ['q', 'in'] },
      { from: ['q', 'out'], to: ['worker', 'in'], semantics: 'async' },
    ];

    const std = build(commonInstances('queue.sqs'), wires);
    const ord = dim(std, 'producer', 'worker', dims.ordering);
    expect(ord.token).toBe(ordering.none);
    expect(ord.rootCause?.scope).toBe(PortId('q.out')); // blamed on the SQS standard out port (compiler ids it `q.out`)
    const del = dim(std, 'producer', 'worker', dims.delivery);
    expect(del.token).toBe(delivery.mayDuplicate); // at-least-once

    // A "Ordering ≥ per-key" requirement is VIOLATED on standard SQS…
    const ordLat = categorical.get(dims.ordering);
    if (ordLat === undefined) throw new Error('ordering lattice');
    expect(judgeGuarantee(ordLat, ord, { dimension: dims.ordering, atLeast: ordering.perKey })).toBe('violation');

    // …and SATISFIED once the queue is switched to FIFO (the doc's remediation).
    const fifo = build(commonInstances('queue.sqs.fifo'), wires);
    const ordFifo = dim(fifo, 'producer', 'worker', dims.ordering);
    expect(ordFifo.token).toBe(ordering.perKey);
    expect(judgeGuarantee(ordLat, ordFifo, { dimension: dims.ordering, atLeast: ordering.perKey })).toBe('ok');
  });
});
