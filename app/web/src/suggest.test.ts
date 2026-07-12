import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, allManifests } from '@sda/content';
import { buildCandidates, suggestFor, matchingPort } from './suggest';

const catalog = allManifests;

// matchingPort is the AUTO-WIRE port picker: given an open port of the selected node (as the same
// Suggestion object suggestFor produces) and a component `type` to attach, it names the port on that
// component the wire should land on — using the ONE portsConnect legality rule the suggester uses, so
// the picked port is always one that actually fits. Every `from` here is a REAL suggestion off a real
// graph (built exactly as value-loop.e2e.test.ts builds it), not a hand-crafted stub.
describe('matchingPort — the auto-wire port picker', () => {
  it('from an OUT open port it resolves the correct IN target port on the new component', () => {
    const s = new Studio(registry, catalog);
    const candidates = buildCandidates(catalog);
    s.dispatch({ kind: 'addComponent', id: 'gw', type: 'gateway.api' });

    // The gateway's open OUT port (http producer). It is a downstream feed → the picker must land on the
    // consumer's IN port (compute.faas has both an `in` trigger and an `out` client port).
    const out = suggestFor(s, catalog, candidates, 'gw').find((x) => x.port === 'out');
    expect(out).toBeDefined();
    expect(out!.dir).toBe('out');
    expect(matchingPort(catalog, 'compute.faas', out!)).toBe('in');
  });

  it('back-wire fallback: from an IN open port it resolves the correct OUT port on the feeding component', () => {
    const s = new Studio(registry, catalog);
    const candidates = buildCandidates(catalog);
    s.dispatch({ kind: 'addComponent', id: 'fn', type: 'compute.faas' });

    // The function's open IN port (a consumer). An IN port is FED by an OUT — the picker skips the
    // forward branch and back-wires to the gateway's OUT port (gateway.api has both an `in` and an `out`).
    const inn = suggestFor(s, catalog, candidates, 'fn').find((x) => x.port === 'in');
    expect(inn).toBeDefined();
    expect(inn!.dir).toBe('in');
    expect(matchingPort(catalog, 'gateway.api', inn!)).toBe('out');
  });

  it('a protocol-incompatible pairing yields undefined (no port fits in either direction)', () => {
    const s = new Studio(registry, catalog);
    const candidates = buildCandidates(catalog);
    s.dispatch({ kind: 'addComponent', id: 'db', type: 'db.postgres' });

    // A Postgres OUT port speaks `postgresql`; RabbitMQ's ports accept/speak `amqp`. Neither the forward
    // (postgresql → amqp in) nor the back-wire (amqp out → postgresql) connects, so there is NO matching port.
    const out = suggestFor(s, catalog, candidates, 'db').find((x) => x.port === 'out');
    expect(out).toBeDefined();
    expect(out!.protocol).toBe('postgresql');
    expect(matchingPort(catalog, 'queue.rabbitmq', out!)).toBeUndefined();
  });
});
