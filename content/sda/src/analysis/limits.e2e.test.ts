import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { evaluate, type Evaluation } from '@sda/engine-solve';
import { instantiate, allManifests, registry, keys, type Instance, type Wire } from '../index';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// DOCUMENTED REAL-WORLD LIMITS (task-72). "Honesty depth": the outage-causing account/service ceilings that a
// diagram tool never sees, modelled as manifest DATA (config + bands + relations) with the OFFICIAL AWS docs
// URL cited at each manifest. This suite PINS that the limits actually FIRE as honest verdicts on designs that
// breach them, and stay silent on designs within quota — the difference between "I drew it" and "I verified it".
//
//   • Lambda ACCOUNT concurrency — default 1,000 concurrent executions per Region (soft):
//       https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
//     concurrencyNeeded = offered load × service-time (Little's law); throttled past the account quota.
//   • API Gateway ACCOUNT throttle — default 10,000 rps steady-state (429 Too Many Requests past it):
//       https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html
//   • DynamoDB item size 400 KB · SQS message size 256 KB — documented payload ceilings (informational until
//     the architect sets the real item/message size).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

const catalog = allManifests;
const W = (a: string, ap: string, b: string, bp: string, async = false): Wire => ({ from: [a, ap], to: [b, bp], ...(async ? { semantics: 'async' as const } : {}) });

function build(insts: Instance[], wires: Wire[]): Evaluation {
  const g = instantiate(catalog, insts, wires);
  if (!g.ok) throw new Error(`build error: ${JSON.stringify(g.error)}`);
  const r = evaluate(g.value, registry);
  if (!r.ok) throw new Error(`eval error: ${r.error.join('; ')}`);
  return r.value;
}
const at = (e: Evaluation, id: string, k: typeof keys.throughput): number | undefined => e.value(NodeId(id), k);
const verdictFor = (e: Evaluation, id: string, k: typeof keys.throughput) =>
  e.verdicts.find((v) => String(v.scope) === id && String(v.key) === String(k));

// ── LAMBDA ACCOUNT CONCURRENCY: a fleet pushed past the 1,000 default yields the new violation ──────────
describe('Lambda account concurrency (default 1,000/Region)', () => {
  // A function with a HUGE per-function capacity (concurrency 100k / 100 ms ⇒ 1,000,000 rps ceiling), so the
  // per-function throughput `overflow` does NOT bind — ISOLATING the ACCOUNT-concurrency limit. Offered 30,000
  // rps ⇒ concurrencyNeeded = 30,000 × 0.1 s = 3,000 simultaneous executions ⇒ 2,000 past the 1,000 quota.
  const e = build(
    [
      { id: 'src', type: 'client.source', config: { throughput: 30000 } },
      { id: 'fn', type: 'compute.faas', config: { concurrency: 100000, perRequestDuration: 100 } },
    ],
    [W('src', 'out', 'fn', 'in')],
  );

  it('offered load implies concurrency by Little\'s law (arrivalRate × service-time)', () => {
    expect(at(e, 'fn', keys.concurrencyNeeded)).toBe(3000); // 30,000 rps × 0.1 s
  });
  it('the account-concurrency ceiling binds even though the per-function throughput has headroom', () => {
    expect(at(e, 'fn', keys.overflow)).toBe(0); // 30,000 ≤ the 1,000,000 per-function ceiling — NOT a throughput drop
    expect(at(e, 'fn', keys.accountConcurrency)).toBe(1000); // the sourced default quota
    expect(at(e, 'fn', keys.concurrencyOverflow)).toBe(2000); // 3,000 needed − 1,000 quota = 2,000 throttled
  });
  it('yields a concurrencyOverflow VIOLATION with an honest remediation (raise the quota / reserve concurrency)', () => {
    const v = verdictFor(e, 'fn', keys.concurrencyOverflow);
    expect(v?.status).toBe('violation');
    // the engine attributes the breach to the origin (the fn's own concurrencyOverflow) and ranks a remediation;
    // the honest fix for a 429-throttled Lambda is a quota increase or reserved/provisioned concurrency.
    expect((v?.remediations.length ?? 0)).toBeGreaterThan(0);
    expect(String(v?.remediations[0]?.action ?? '')).toContain('fn');
  });
  it('stays SILENT within quota: the same fleet at 5,000 rps needs 500 executions ⇒ no throttle', () => {
    const ok = build(
      [
        { id: 'src', type: 'client.source', config: { throughput: 5000 } },
        { id: 'fn', type: 'compute.faas', config: { concurrency: 100000, perRequestDuration: 100 } },
      ],
      [W('src', 'out', 'fn', 'in')],
    );
    expect(at(ok, 'fn', keys.concurrencyNeeded)).toBe(500); // 5,000 × 0.1 s
    expect(at(ok, 'fn', keys.concurrencyOverflow)).toBe(0); // 500 ≤ 1,000 quota
    expect(verdictFor(ok, 'fn', keys.concurrencyOverflow)?.status).toBe('ok');
  });
});

// ── API GATEWAY 429: past the 10,000-rps default account throttle ───────────────────────────────────────
describe('API Gateway account throttle (default 10,000 rps → 429)', () => {
  // 25,000 rps offered to a gateway whose documented account throttle is 10,000 rps ⇒ 15,000 rps rejected
  // (429 Too Many Requests). This is the UNIVERSAL overflow relation reading the gateway's own 10k ceiling.
  const e = build(
    [
      { id: 'src', type: 'client.source', config: { throughput: 25000 } },
      { id: 'gw', type: 'gateway.api' },
    ],
    [W('src', 'out', 'gw', 'in')],
  );

  it('caps served flow at the documented 10,000 rps and flags the 15,000 rps rejected as 429s', () => {
    expect(at(e, 'gw', keys.throughput)).toBe(10000); // the account throttle ceiling
    expect(at(e, 'gw', keys.overflow)).toBe(15000); // max(0, 25,000 − 10,000) — the 429-throttled excess
  });
  it('yields an overflow VIOLATION (the 429 verdict) with a ranked remediation aimed at the gateway', () => {
    const v = verdictFor(e, 'gw', keys.overflow);
    expect(v?.status).toBe('violation');
    // honest 429 remedy: request a throttle-quota increase or shed/cache load before the gateway.
    expect((v?.remediations.length ?? 0)).toBeGreaterThan(0);
    expect(String(v?.remediations[0]?.action ?? '')).toContain('gw');
  });
  it('stays SILENT within the 10k ceiling', () => {
    const ok = build(
      [
        { id: 'src', type: 'client.source', config: { throughput: 8000 } },
        { id: 'gw', type: 'gateway.api' },
      ],
      [W('src', 'out', 'gw', 'in')],
    );
    expect(at(ok, 'gw', keys.overflow)).toBe(0);
    expect(verdictFor(ok, 'gw', keys.overflow)?.status).toBe('ok');
  });
});

// ── DOCUMENTED PAYLOAD CEILINGS: DynamoDB 400 KB item, SQS 256 KB message ────────────────────────────────
describe('documented payload-size ceilings (DynamoDB 400 KB · SQS 256 KB)', () => {
  it('DynamoDB flags an over-400 KB item and stays silent at/under the limit', () => {
    const over = build([{ id: 'ddb', type: 'db.dynamodb', config: { payloadBytes: 500000 } }], []);
    expect(at(over, 'ddb', keys.maxItemBytes)).toBe(409600); // documented 400 KB
    expect(at(over, 'ddb', keys.payloadOverflow)).toBe(500000 - 409600); // 90,400 bytes over the ceiling
    expect(verdictFor(over, 'ddb', keys.payloadOverflow)?.status).toBe('violation');

    const ok = build([{ id: 'ddb', type: 'db.dynamodb', config: { payloadBytes: 300000 } }], []);
    expect(at(ok, 'ddb', keys.payloadOverflow)).toBe(0);
    expect(verdictFor(ok, 'ddb', keys.payloadOverflow)?.status).toBe('ok');
  });
  it('is INFORMATIONAL by default: an unset payload (0) never falsely breaches the limit', () => {
    const e = build([{ id: 'ddb', type: 'db.dynamodb' }], []);
    expect(at(e, 'ddb', keys.payloadOverflow)).toBe(0); // payloadBytes defaults to 0 (unset)
    expect(verdictFor(e, 'ddb', keys.payloadOverflow)?.status).toBe('ok');
  });
  it('SQS flags an over-256 KB message', () => {
    const over = build([{ id: 'q', type: 'queue.sqs', config: { payloadBytes: 300000 } }], []);
    expect(at(over, 'q', keys.maxItemBytes)).toBe(262144); // documented 256 KB
    expect(at(over, 'q', keys.payloadOverflow)).toBe(300000 - 262144); // 37,856 bytes over the ceiling
    expect(verdictFor(over, 'q', keys.payloadOverflow)?.status).toBe('violation');
  });
});
