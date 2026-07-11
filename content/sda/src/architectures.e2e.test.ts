import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { evaluate, type Evaluation } from '@sda/engine-solve';
import { instantiate, allManifests, registry, keys, type Instance, type Wire } from './index';

// End-to-end on REAL, multi-path architectures from the system-design canon (URL shortener, web scraper,
// parking lot, news feed). Each exercises the three cross-cutting dimensions — LATENCY (sums on a sync
// path), THROUGHPUT (the min/bottleneck), COST (sums) — over three distinct flows (a read path, a write
// path, an async path). Built from the seed catalog only. These designs drove two ROOT fixes (now asserted
// as correct behaviour, not phantoms): throughput now CARRIES across async edges (the message rate flows to
// queue consumers), and overflow is a single UNIVERSAL relation auto-applied to every receiver (so capacity
// drops are flagged everywhere — DynamoDB included — never silently). See `code-quality` memory trail.
const catalog = allManifests;
const W = (a: string, ap: string, b: string, bp: string, async = false): Wire => ({ from: [a, ap], to: [b, bp], ...(async ? { semantics: 'async' as const } : {}) });

function build(insts: Instance[], wires: Wire[]): Evaluation {
  const g = instantiate(catalog, insts, wires);
  if (!g.ok) throw new Error(`build error: ${JSON.stringify(g.error)}`);
  const r = evaluate(g.value, registry);
  if (!r.ok) throw new Error(`eval error: ${r.error.join('; ')}`);
  return r.value;
}
const at = (e: Evaluation, id: string, k: typeof keys.throughput) => e.value(NodeId(id), k);

// ── URL SHORTENER (read-heavy, 10k rps) — resolve(cache) · store(db) · analytics(async) ───────────────
describe('URL shortener @ 10k rps', () => {
  const e = build(
    [
      { id: 'client', type: 'client.web', config: { throughput: 10000 } },
      { id: 'gw', type: 'gateway.api' }, { id: 'app', type: 'compute.service' },
      { id: 'cache', type: 'cache.redis' }, { id: 'store', type: 'db.dynamodb' },
      { id: 'aq', type: 'queue.sqs' }, { id: 'aw', type: 'compute.faas' }, { id: 'adb', type: 'db.postgres' },
    ],
    [
      W('client', 'out', 'gw', 'in'), W('gw', 'out', 'app', 'in'),
      W('app', 'cache', 'cache', 'in'), W('app', 'db', 'store', 'in'),
      W('app', 'db', 'aq', 'in', true), W('aq', 'out', 'aw', 'in'), W('aw', 'out', 'adb', 'in'),
    ],
  );

  it('LATENCY: the redirect read path is sub-30ms', () => {
    expect(at(e, 'cache', keys.latency)).toBe(25.5); // client 0 + gw 5 + app 20 + redis 0.5
  });
  it('THROUGHPUT: cache serves all 10k; DynamoDB caps writes at 1k AND flags the 9k it drops', () => {
    expect(at(e, 'cache', keys.throughput)).toBe(10000);
    expect(at(e, 'store', keys.throughput)).toBe(1000); // DynamoDB on-demand baseline caps the served flow
    // Overflow is now UNIVERSAL (every receiver gets `max(0, inflow(throughput) − self(throughput))` via
    // withOverflow), so DynamoDB flags the 9,000 rps it must reject — no silent drop. A read-heavy shortener
    // is forced to lean on the cache (most reads) or raise provisioned capacity; the tool says so loudly.
    expect(at(e, 'store', keys.overflow)).toBe(9000);
  });
  it('COST: the analytics path is dominated by the pay-per-use SQS queue at 10k rps (~$10.3k/mo)', () => {
    // gw $50 + app $120 + the async analytics SQS carrying the FULL 10k rps (pay-per-use: 10,000 × $1)
    // $10,000 + faas (concurrency 100 × $1.5) $150 = $10,320. FINDING: mirroring every read into an
    // unsampled pay-per-use queue is the real cost driver here — not the Lambda. Exactly the kind of thing
    // the tool surfaces once cost is modelled honestly (SQS at sustained 10k msg/s really is ~$10k/mo).
    expect(at(e, 'aw', keys.cost)).toBe(10320);
  });
});

// ── WEB SCRAPER PLATFORM (1M pages/day ≈ 12 rps) — control(api→pg) · scrape(q→fleet→s3) · notify(q→email)
describe('Web scraper platform @ 12 rps', () => {
  const e = build(
    [
      { id: 'users', type: 'client.web', config: { throughput: 20 } }, { id: 'gw', type: 'gateway.api' }, { id: 'api', type: 'compute.service' }, { id: 'pg', type: 'db.postgres' },
      { id: 'sched', type: 'client.source', config: { throughput: 12 } }, { id: 'jobq', type: 'queue.sqs' },
      { id: 'workers', type: 'compute.asg', config: { concurrency: 8, perRequestDuration: 4000 } },
      { id: 's3', type: 'storage.object' }, { id: 'changeq', type: 'queue.sqs' }, { id: 'emailer', type: 'compute.faas' },
    ],
    [
      W('users', 'out', 'gw', 'in'), W('gw', 'out', 'api', 'in'), W('api', 'db', 'pg', 'in'),
      W('sched', 'out', 'jobq', 'in'), W('jobq', 'out', 'workers', 'in'),
      W('workers', 'db', 's3', 'in'), W('workers', 'db', 'changeq', 'in'), W('changeq', 'out', 'emailer', 'in'),
    ],
  );

  it('THROUGHPUT + sizing: the fleet needs 6 worker units for the offered load', () => {
    expect(at(e, 'workers', keys.throughput)).toBe(12);
    expect(at(e, 'workers', keys.requiredUnits)).toBe(6); // 12 rps ÷ (8 conc / 4 s) = 6 units
    expect(at(e, 'workers', keys.overflow)).toBe(0); // within the 50-unit ASG ceiling
  });
  it('requiredUnits is NODE-LOCAL: the store/queue downstream of the fleet have no "tasks" of their own', () => {
    // The fleet sizes ITSELF; a node-local property must not flow downstream. Before this was modelled as a
    // node-local key, S3 and the queue inherited the fleet's 6 via the `max` aggregation — a phantom figure.
    expect(at(e, 'workers', keys.requiredUnits)).toBe(6);
    expect(at(e, 's3', keys.requiredUnits)).toBeUndefined(); // an object store has no units to inherit
    expect(at(e, 'changeq', keys.requiredUnits)).toBeUndefined(); // nor does the change queue
  });
  it('COST: ~$594/mo (6 ASG workers @ $70 + two low-rate SQS hops + the notifier Lambda)', () => {
    expect(at(e, 'workers', keys.cost)).toBe(432); // 6 × $70 fleet + jobq SQS ingest (12 rps pay-per-use ≈ $12)
    expect(at(e, 'emailer', keys.cost)).toBe(594); // + changeq SQS (12 rps ≈ $12) + notifier Lambda $150
  });
  it('LATENCY: the modelled scrape path is 55ms — and that is a TRAP', () => {
    expect(at(e, 's3', keys.latency)).toBe(55); // sched 0 + sqs 10 + asg 25 + s3 20
    // FINDING #5 (modelling nuance): `latency` (25ms on the ASG) is INDEPENDENT of `perRequestDuration`
    // (4,000ms — the real scrape time used for sizing). So the latency path reads 55ms while a scrape
    // actually takes ~4s. Capacity/cost are right; the latency dimension understates slow work unless you
    // set `latency` to match the service time. Two different questions, two different knobs.
  });
});

// ── PARKING LOT backend (500 rps) — inventory(db) · availability(cache) · payment(async q→worker→db) ───
describe('Parking lot backend @ 500 rps', () => {
  const e = build(
    [
      { id: 'client', type: 'client.web', config: { throughput: 500 } }, { id: 'gw', type: 'gateway.api' }, { id: 'app', type: 'compute.service' },
      { id: 'spots', type: 'db.postgres' }, { id: 'avail', type: 'cache.redis' },
      { id: 'payq', type: 'queue.sqs' }, { id: 'paywk', type: 'compute.faas' }, { id: 'paydb', type: 'db.postgres' },
    ],
    [
      W('client', 'out', 'gw', 'in'), W('gw', 'out', 'app', 'in'),
      W('app', 'db', 'spots', 'in'), W('app', 'cache', 'avail', 'in'),
      W('app', 'db', 'payq', 'in', true), W('payq', 'out', 'paywk', 'in'), W('paywk', 'out', 'paydb', 'in'),
    ],
  );

  it('LATENCY + THROUGHPUT: inventory path is 75ms and well within Postgres headroom', () => {
    expect(at(e, 'spots', keys.latency)).toBe(75); // 0 + 5 + 20 + 50
    expect(at(e, 'spots', keys.throughput)).toBe(500); // Postgres caps at 2,000 ⇒ comfortable at 500
    expect(at(e, 'spots', keys.overflow)).toBe(0);
  });
  it('COST: payment path ~$1,100/mo — the pay-per-use SQS at 500 rps is ~half; Multi-AZ Postgres bills its standby', () => {
    // gw $50 + app $120 + payment SQS at 500 rps (pay-per-use: 500 × $1) $500 + Lambda $150 + Postgres $280.
    // The Postgres tier is the DEFAULT Multi-AZ (deploymentMode 1), so its cost is the single-AZ $140 × 2 — the
    // billed standby (task-77: redundancy is not free). A single-AZ (deploymentMode 0) paydb would be $140 ⇒ $960.
    expect(at(e, 'paydb', keys.cost)).toBe(1100);
  });
  it('the async payment worker correctly serves the real load — overflow 0 (no phantom)', () => {
    // `throughput.onAsyncEdge` is now CARRY: across the async edge app→payq the real 500 rps flows through,
    // so the SQS node carries 500 (not its 3,000 capacity) and the Lambda sees 500 ≤ its 2,000 capacity ⇒
    // overflow 0. The old phantom 1,000 (from async 'cut' resetting to capacity) is gone. Async decouples
    // the caller's WAIT (latency), not the message RATE.
    expect(at(e, 'paywk', keys.overflow)).toBe(0);
  });
});

// ── NEWS FEED / Twitter timeline (5k rps) — timeline-read(cache) · tweet-write(db) · fanout(async stream)
describe('News feed @ 5k rps', () => {
  const e = build(
    [
      { id: 'client', type: 'client.web', config: { throughput: 5000 } }, { id: 'gw', type: 'gateway.api' }, { id: 'app', type: 'compute.service' },
      { id: 'timeline', type: 'cache.redis' }, { id: 'tweets', type: 'db.dynamodb' },
      { id: 'fanq', type: 'stream.kafka' }, { id: 'fanwk', type: 'compute.faas' },
    ],
    [
      W('client', 'out', 'gw', 'in'), W('gw', 'out', 'app', 'in'),
      W('app', 'cache', 'timeline', 'in'), W('app', 'db', 'tweets', 'in'),
      W('app', 'out', 'fanq', 'in', true), W('fanq', 'out', 'fanwk', 'in'), // publish to Kafka over the service's GENERIC out (https) — the db port is a SQL connection

    ],
  );

  it('LATENCY: timeline read is sub-30ms from cache', () => {
    expect(at(e, 'timeline', keys.latency)).toBe(25.5);
  });
  it('THROUGHPUT: timeline serves 5k; DynamoDB caps tweet writes at 1k and flags the 4k dropped', () => {
    expect(at(e, 'timeline', keys.throughput)).toBe(5000);
    expect(at(e, 'tweets', keys.throughput)).toBe(1000);
    expect(at(e, 'tweets', keys.overflow)).toBe(4000); // now flagged (universal overflow): write fan-in needs sharding
  });
  it('the single fan-out worker is the REAL bottleneck: it drops 3k of the 5k fanout', () => {
    // With throughput carrying across async, the fan-out Lambda sees the real 5,000 rps and (at its 2,000
    // capacity) genuinely drops 3,000 — a true, actionable finding (shard the fanout / raise worker
    // capacity), where before the async 'cut' produced a meaningless phantom 98,000.
    expect(at(e, 'fanwk', keys.overflow)).toBe(3000);
  });
});
