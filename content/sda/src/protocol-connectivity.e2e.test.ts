import { describe, expect, it } from 'vitest';
import { illegalEdges } from '@sda/engine-solve';
import { protocolCompat } from './protocols';
import { instantiate, type Instance, type Manifest, type Wire } from './manifest';
import { manifests } from './catalog';
import { commonManifests } from './common';

// The real point of the protocol layer: components connect the way they do in reality. A queue/topic/stream
// drives an event-driven compute (Lambda / worker), an SNS topic fans out to SQS and Lambda, an HTTP gateway
// invokes a function — but a queue does NOT drive a datastore. This is what the `aws` catch-all could never
// express; the named protocols + the consumer accept-set do.
const SNS: Manifest = {
  type: 'topic.sns',
  ports: [
    { name: 'in', dir: 'in', accepts: ['sns', 'https', 'http'] },
    { name: 'out', dir: 'out', speaks: ['sns'] },
  ],
};
const catalog = { ...manifests, ...commonManifests, 'topic.sns': SNS };
const W = (from: string, fp: string, to: string, tp: string): Wire => ({ from: [from, fp], to: [to, tp] });
const illegalCount = (instances: Instance[], wires: Wire[]): number => {
  const g = instantiate(catalog, instances, wires);
  if (!g.ok) throw new Error('build failed: ' + JSON.stringify(g.error));
  return illegalEdges(g.value, protocolCompat).length;
};

describe('protocol connectivity — components connect like reality', () => {
  it('SQS → Lambda is LEGAL (the case that used to be impossible)', () => {
    expect(illegalCount([{ id: 'q', type: 'queue.sqs' }, { id: 'fn', type: 'compute.faas' }], [W('q', 'out', 'fn', 'in')])).toBe(0);
  });

  it('SNS fans out to BOTH SQS and Lambda — LEGAL', () => {
    expect(
      illegalCount(
        [{ id: 't', type: 'topic.sns' }, { id: 'q', type: 'queue.sqs' }, { id: 'fn', type: 'compute.faas' }],
        [W('t', 'out', 'q', 'in'), W('t', 'out', 'fn', 'in')],
      ),
    ).toBe(0);
  });

  it('Kafka → worker and HTTP gateway → Lambda are LEGAL', () => {
    expect(illegalCount([{ id: 'k', type: 'stream.kafka' }, { id: 'w', type: 'compute.fargate' }], [W('k', 'out', 'w', 'in')])).toBe(0);
    expect(illegalCount([{ id: 'gw', type: 'gateway.api' }, { id: 'fn', type: 'compute.faas' }], [W('gw', 'out', 'fn', 'in')])).toBe(0);
  });

  it('a compute calls any backend — Lambda → Postgres and Lambda → Elasticsearch are LEGAL', () => {
    expect(illegalCount([{ id: 'fn', type: 'compute.faas' }, { id: 'db', type: 'db.postgres' }], [W('fn', 'out', 'db', 'in')])).toBe(0);
    expect(illegalCount([{ id: 'fn', type: 'compute.faas' }, { id: 'es', type: 'search.elasticsearch' }], [W('fn', 'out', 'es', 'in')])).toBe(0);
  });

  it('a queue does NOT drive a datastore — SQS → Postgres is ILLEGAL', () => {
    expect(illegalCount([{ id: 'q', type: 'queue.sqs' }, { id: 'db', type: 'db.postgres' }], [W('q', 'out', 'db', 'in')])).toBe(1);
  });

  it('a browser does NOT speak a DB wire protocol — client → Postgres is ILLEGAL', () => {
    expect(illegalCount([{ id: 'c', type: 'client.web' }, { id: 'db', type: 'db.postgres' }], [W('c', 'out', 'db', 'in')])).toBe(1);
  });
});
