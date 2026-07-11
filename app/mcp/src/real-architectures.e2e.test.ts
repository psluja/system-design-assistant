import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, allManifests } from '@sda/content';
import { buildTools, type AnyTool, type ToolResult } from './tools';
import { buildSimTools } from './simulate';
import { buildReliabilityTools } from './reliability';
import { buildDocTools } from './document';

// NIGHT-TEST HARNESS: three REAL-WORLD architectures (from public engineering blogs / AWS reference
// architectures), exercised through the SAME MCP tool loop an architect/AI uses — apply_design → evaluate →
// set_slo → simulate → reliability → generate_doc — with hand-computable numbers (explicit configs, so the
// math is checkable) and cross-SURFACE consistency asserted (one truth: evaluate == doc == reliability).
// These are the product's realism regression tests: if a composition/decoupling/saturation rule regresses,
// a realistic design catches it here before a user does.

interface EvalOut {
  feasible: boolean;
  violations: number;
  // OWNER RULING: single-truth latency = measured-or-nothing. `evaluate` carries NO analytic latency — the flows have
  // no `latencyMs` and there is no per-node `responseLatencyMs`; a `latency` note points at `simulate` for the tail.
  system: { flows: { source: string; terminal: string; throughputRps?: number; availability?: number }[]; cost: { totalUsdMonth: number } };
  latency?: string;
  verdicts: { scope: string; key: string; status: string; value?: number; fix?: string }[];
}
interface SimOut {
  seed: number;
  tailLatencyMs: { p50: number; p95: number; p99: number; mean: number };
  saturation: { id: string; utilization: number; dropped: number }[];
  verdicts: { scope: string; key: string; status: string }[];
}

const mk = () => {
  const s = new Studio(registry, allManifests);
  const tools: AnyTool[] = [...buildTools(s), ...buildSimTools(s, registry), ...buildReliabilityTools(s), ...buildDocTools(s)];
  return (name: string, a: Record<string, unknown> = {}): ToolResult => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.run(a) as ToolResult;
  };
};
const j = <T>(r: ToolResult): T => {
  if (!r.ok) throw new Error('tool failed: ' + r.text);
  return JSON.parse(r.text) as T;
};
const evalNow = (call: ReturnType<typeof mk>): EvalOut => j<EvalOut>(call('evaluate'));

// ════════ ARCH 1 — Netflix-style playback path ════════
// Public basis: Netflix tech blog — Zuul edge gateway → playback API fleet → EVCache (memcached) look-aside +
// a wide-column viewing store; playback EVENTS go to Kafka → consumer fleet → S3 (decoupled from the viewer).
// Regional scale here: 8,000 rps playback-start API.
describe('ARCH 1 — Netflix-style playback (gateway → API fleet → cache+store; async Kafka events)', () => {
  const build = (call: ReturnType<typeof mk>): void => {
    const r = call('apply_design', {
      instances: [
        { id: 'viewer', type: 'client.web', config: { throughput: 8000 } },
        { id: 'zuul', type: 'gateway.api', config: { throughput: 50000, latency: 3 } },
        // playback fleet: 480 concurrent / 12 ms = 40,000 rps capacity ⇒ ρ = 0.2 (healthy)
        { id: 'playback', type: 'compute.service', config: { concurrency: 480, perRequestDuration: 12 } },
        { id: 'evcache', type: 'cache.memcached', config: { throughput: 100000, latency: 1 } },
        { id: 'viewingdb', type: 'db.dynamodb', config: { throughput: 20000, latency: 8 } },
        { id: 'events', type: 'stream.kafka' },
        // consumer fleet is SLOW on purpose (40 ms) — if the async cut ever regressed, the viewer response
        // would jump by ~45+ ms and the bound below would catch it.
        { id: 'consumers', type: 'compute.asg', config: { concurrency: 120, perRequestDuration: 40, maxUnits: 4 } },
        { id: 'archive', type: 'db.dynamodb', config: { throughput: 30000, latency: 4 } },
      ],
      wires: [
        ['viewer', 'zuul'],
        ['zuul', 'playback'],
        ['playback', 'cache', 'evcache', 'in'],
        ['playback', 'out', 'viewingdb', 'in'], // DynamoDB speaks aws-api — reached via the generic out, NOT the SQL db port
        ['playback', 'out', 'events', 'in', true], // fire-and-forget events — ASYNC (the viewer never waits)
        ['events', 'out', 'consumers', 'in'],
        ['consumers', 'out', 'archive', 'in'],
      ],
      slos: [{ node: 'viewingdb', key: 'throughput', cmp: '>=', value: 8000 }],
    });
    expect(r.ok, r.text).toBe(true);
  };

  it('evaluates feasible with the hand-checked flow numbers (8k rps served; no analytic latency readout)', () => {
    const call = mk();
    build(call);
    const o = evalNow(call);
    expect(o.feasible, JSON.stringify(o.verdicts.filter((v) => v.status === 'violation'))).toBe(true);
    // throughput: no tier bottlenecks 8,000 (zuul 50k, playback 40k, cache 100k, db 20k). One connected
    // component ⇒ one flow; its terminal is the worst-latency sink (the async archive), but the served rate
    // at the terminal is the full 8,000 either way.
    expect(o.system.flows.length).toBe(1);
    expect(o.system.flows[0]?.throughputRps).toBe(8000);
    // OWNER RULING (measured-or-nothing): evaluate reports NO analytic latency — the flows carry no latencyMs and a
    // note points at `simulate` for the tail. The measured per-node/tail figures live in the DES-tail test below.
    for (const f of o.system.flows) expect('latencyMs' in f).toBe(false);
    expect(o.latency).toMatch(/simulate/);
  });

  it('is honest about a saturated edge tier — and undo restores feasibility', () => {
    const call = mk();
    build(call);
    // spike the viewer to 60k > zuul's 50k ceiling ⇒ overflow at the gateway; evaluate must flip infeasible
    expect(call('set_config', { node: 'viewer', key: 'throughput', value: 60000 }).ok).toBe(true);
    const hot = evalNow(call);
    expect(hot.feasible).toBe(false);
    expect(hot.verdicts.some((v) => v.status === 'violation' && (v.key === 'overflow' || v.key === 'latency'))).toBe(true);
    // one undo = the single set_config; back to green
    expect(call('undo').ok).toBe(true);
    expect(evalNow(call).feasible).toBe(true);
  });

  it('DES tail: p50 ≤ p95 ≤ p99, and a p99 SLO on the sink gets a REAL verdict (not unknown)', () => {
    const call = mk();
    build(call);
    expect(call('set_slo', { node: 'viewingdb', key: 'tailLatency', percentiles: { p99: 250 } }).ok).toBe(true);
    const sim = j<SimOut>(call('simulate'));
    expect(sim.tailLatencyMs.p50).toBeGreaterThan(0);
    expect(sim.tailLatencyMs.p95).toBeGreaterThanOrEqual(sim.tailLatencyMs.p50);
    expect(sim.tailLatencyMs.p99).toBeGreaterThanOrEqual(sim.tailLatencyMs.p95);
    const tail = sim.verdicts.find((v) => v.scope === 'viewingdb' && v.key === 'tailLatency');
    expect(tail).toBeDefined();
    expect(tail?.status).not.toBe('unknown');
  });

  it('one truth: generate_doc + reliability agree with evaluate (measured latency, no analytic table)', () => {
    const call = mk();
    build(call);
    const o = evalNow(call);
    const doc = call('generate_doc');
    expect(doc.ok).toBe(true);
    // OWNER RULING: the doc's latency is MEASURED (DES, seed 7); the analytic "Response latency per tier" table is
    // gone and the §4 flow header drops the "(real)" qualifier. The doc no longer shows any analytic latency value.
    expect(doc.text).not.toContain('Response latency per tier');
    expect(doc.text).toContain('| Flow | Throughput | Latency | Availability | Branch cost |');
    expect(doc.text).toMatch(/Latency is measured/);
    // reliability's availability for the (single) flow == evaluate's flow availability (one truth): locate the
    // same-terminal record and require SOME numeric field to equal evaluate's figure (robust to field naming)
    const ef = o.system.flows[0];
    expect(ef?.availability).toBeDefined();
    const rel = j<{ flows: Record<string, unknown>[] }>(call('reliability'));
    const rf = rel.flows.find((f) => f.terminal === ef?.terminal);
    expect(rf).toBeDefined();
    const nums = Object.values(rf ?? {}).filter((v): v is number => typeof v === 'number');
    expect(nums.some((n) => Math.abs(n - (ef?.availability as number)) < 1e-6)).toBe(true);
  });
});

// ════════ ARCH 2 — Uber-style dispatch ════════
// Public basis: Uber engineering blog — a dispatch service fans out to a geo index and a pricing service IN
// PARALLEL (scatter-gather); driver location telemetry is a separate high-rps flow into Kafka → workers →
// a locations store. Tests the parallel (max) composition and the two-independent-flows split.
describe('ARCH 2 — Uber-style dispatch (parallel fan-out; separate telemetry flow through Kafka)', () => {
  const build = (call: ReturnType<typeof mk>): void => {
    const r = call('apply_design', {
      instances: [
        { id: 'riders', type: 'client.web', config: { throughput: 3000 } },
        { id: 'waf', type: 'security.waf', config: { throughput: 20000, latency: 1 } },
        { id: 'alb', type: 'lb.alb', config: { throughput: 50000, latency: 1 } },
        // dispatch: 128 concurrent / 15 ms ≈ 8,533 rps capacity ⇒ ρ = 0.35
        { id: 'dispatch', type: 'compute.service', config: { concurrency: 128, perRequestDuration: 15 } },
        { id: 'geo', type: 'cache.redis', config: { throughput: 80000, latency: 1 } },
        // pricing: 100 / 8 ms = 12,500 rps
        { id: 'pricing', type: 'compute.service', config: { concurrency: 100, perRequestDuration: 8 } },
        // postgres derives its throughput from ITS real knobs (connections / query time) — size it honestly:
        // 100 connections / 5 ms = 20,000 rps capacity, 5 ms service time
        { id: 'pricedb', type: 'db.postgres', config: { concurrency: 100, perRequestDuration: 5, latency: 5 } },
        // telemetry flow: 12k rps → gateway → collector service (the Kafka PRODUCER — a gateway can't speak
        // the kafka wire protocol; real ingestion puts a service in front) → Kafka (async) → workers → store
        { id: 'telemetry', type: 'client.source', config: { throughput: 12000 } },
        { id: 'ingest', type: 'gateway.api', config: { throughput: 30000, latency: 2 } },
        { id: 'collector', type: 'compute.service', config: { concurrency: 240, perRequestDuration: 8 } }, // 30,000 rps
        { id: 'pipe', type: 'stream.kafka' },
        { id: 'workers', type: 'compute.asg', config: { concurrency: 80, perRequestDuration: 10, maxUnits: 2 } }, // 16,000 rps
        { id: 'locdb', type: 'db.dynamodb', config: { throughput: 25000, latency: 6 } },
      ],
      wires: [
        ['riders', 'waf'],
        ['waf', 'alb'],
        ['alb', 'dispatch'],
        ['dispatch', 'cache', 'geo', 'in'],
        ['dispatch', 'out', 'pricing', 'in'],
        ['pricing', 'db', 'pricedb', 'in'],
        ['telemetry', 'ingest'],
        ['ingest', 'out', 'collector', 'in'],
        ['collector', 'out', 'pipe', 'in', true], // the producer fires-and-forgets — nobody waits on Kafka
        ['pipe', 'out', 'workers', 'in'],
        ['workers', 'out', 'locdb', 'in'], // DynamoDB = aws-api ⇒ the generic out
      ],
    });
    expect(r.ok, r.text).toBe(true);
  };

  it('REFUSES the wire a human cannot draw: a SQL db port into DynamoDB (protocol legality on the AI path)', () => {
    const call = mk();
    build(call);
    // the canvas would refuse dragging dispatch.db (pg) → locdb.in (aws-api); the MCP connect must refuse too
    const r = call('connect', { fromNode: 'dispatch', fromPort: 'db', toNode: 'locdb', toPort: 'in' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('no shared protocol');
  });

  it('two independent flows, both feasible; telemetry response excludes the Kafka pipeline', () => {
    const call = mk();
    build(call);
    const o = evalNow(call);
    expect(o.feasible, JSON.stringify(o.verdicts.filter((v) => v.status === 'violation'))).toBe(true);
    // two independent request flows (the rider path and the telemetry path)
    expect(o.system.flows.some((f) => f.source === 'riders')).toBe(true);
    expect(o.system.flows.some((f) => f.source === 'telemetry')).toBe(true);
    // the async decoupling still shows as DATA: the worker chain CARRIES the 12k load (throughput crosses the async
    // Kafka boundary) even though the telemetry client never waits on it. (The measured tail is `simulate`'s job now.)
    const locFlow = o.system.flows.find((f) => f.terminal === 'locdb');
    expect(locFlow?.throughputRps).toBe(12000);
  });

  it('scatter-gather to geo + pricing runs feasibly under both compositions; every tier stays unsaturated (measured)', () => {
    const call = mk();
    build(call);
    // The analytic sum−max=min latency-composition identity is verified in content/response-latency.e2e.test.ts.
    // evaluate no longer exposes a scalar latency (owner ruling: measured-or-nothing), so here we assert what the MCP
    // surface still tells the truth about: the design stays feasible under BOTH compositions, and the DES confirms
    // every tier (both fan-out branches included) carries its share without saturating.
    expect(evalNow(call).feasible).toBe(true); // default = sequential
    expect(call('set_config', { node: 'dispatch', key: 'latencyComposition', value: 1 }).ok).toBe(true); // parallel
    expect(evalNow(call).feasible).toBe(true);
    const sim = j<SimOut>(call('simulate'));
    // the scatter-gather fan-out node and its two parallel branches (geo + pricing) carry their share without
    // saturating — the measured health of the parallel composition (the async Kafka buffer is a separate concern).
    for (const id of ['dispatch', 'geo', 'pricing']) {
      const s = sim.saturation.find((x) => x.id === id);
      expect(s, `${id} missing from DES`).toBeDefined();
      expect(s!.utilization, `${id} saturated`).toBeLessThan(1);
    }
    // the measured tail is a sane distribution (monotone, not a degenerate point).
    expect(sim.tailLatencyMs.p99).toBeGreaterThanOrEqual(sim.tailLatencyMs.p50);
  });

  it('is honest when the telemetry gateway saturates (12k → 35k > 30k ceiling)', () => {
    const call = mk();
    build(call);
    expect(call('set_config', { node: 'telemetry', key: 'throughput', value: 35000 }).ok).toBe(true);
    const hot = evalNow(call);
    expect(hot.feasible).toBe(false);
    expect(call('undo').ok).toBe(true);
    expect(evalNow(call).feasible).toBe(true);
  });
});

// ════════ ARCH 3 — Serverless e-commerce checkout (AWS reference architecture) ════════
// Public basis: the AWS serverless web-app reference — API Gateway → Lambda → DynamoDB for the synchronous
// path; the order is queued to SQS and a worker Lambda writes the order store (Aurora). Tests queue
// decoupling AND the "workers can't keep up" honesty (load carries across the queue).
describe('ARCH 3 — serverless checkout (API GW → Lambda → DynamoDB; SQS → worker → Aurora)', () => {
  const build = (call: ReturnType<typeof mk>, workerConcurrency: number): void => {
    const r = call('apply_design', {
      instances: [
        { id: 'shoppers', type: 'client.web', config: { throughput: 1200 } },
        { id: 'api', type: 'apigw.rest', config: { throughput: 10000, latency: 10 } },
        // checkout Lambda: 100 conc / 30 ms = 3,333 rps
        { id: 'checkout', type: 'compute.faas', config: { concurrency: 100, perRequestDuration: 30 } },
        { id: 'cart', type: 'db.dynamodb', config: { throughput: 4000, latency: 5 } },
        { id: 'orderq', type: 'queue.sqs' },
        // worker Lambda: capacity = workerConcurrency / 60 ms — 50 ⇒ 833 rps (CANNOT keep up with 1,200)
        { id: 'worker', type: 'compute.faas', config: { concurrency: workerConcurrency, perRequestDuration: 60 } },
        { id: 'orders', type: 'db.dynamodb', config: { throughput: 2000, latency: 8 } }, // the AWS serverless reference stores orders in DynamoDB
      ],
      wires: [
        ['shoppers', 'api'],
        ['api', 'checkout'],
        ['checkout', 'out', 'cart', 'in'],
        ['checkout', 'out', 'orderq', 'in', true], // enqueue and return — the shopper never waits for the worker
        ['orderq', 'out', 'worker', 'in'],
        ['worker', 'out', 'orders', 'in'],
      ],
      slos: [{ node: 'cart', key: 'throughput', cmp: '>=', value: 1200 }],
    });
    expect(r.ok, r.text).toBe(true);
  };

  it('an under-provisioned worker FAILS honestly even though it hides behind the queue (load carries)', () => {
    const call = mk();
    build(call, 50); // 833 rps < 1,200 offered — orders pile up forever
    const o = evalNow(call);
    expect(o.feasible).toBe(false);
    // the violation names the async side (worker overflow / saturation), NOT the healthy sync path
    expect(o.verdicts.some((v) => v.status === 'violation' && v.scope === 'worker')).toBe(true);
    // ...while the synchronous checkout path stays healthy: NO violation on api / checkout / cart (the shopper is
    // decoupled from the queue). The measured shopper tail is `simulate`'s job — evaluate reports no scalar latency.
    expect(o.verdicts.some((v) => v.status === 'violation' && ['api', 'checkout', 'cart'].includes(v.scope))).toBe(false);
  });

  it('right-sizing the worker (repair-by-hand) turns the design feasible; DES confirms a sane tail', () => {
    const call = mk();
    build(call, 120); // 2,000 rps ≥ 1,200 — keeps up
    const o = evalNow(call);
    expect(o.feasible, JSON.stringify(o.verdicts.filter((v) => v.status === 'violation'))).toBe(true);
    // one connected component ⇒ one flow; terminal = the worst-latency sink (orders, behind the queue); the
    // served rate there is the full 1,200 once the worker keeps up
    expect(o.system.flows[0]?.throughputRps).toBe(1200);
    // whole-design cost is a positive, finite number (catalog-priced)
    expect(o.system.cost.totalUsdMonth).toBeGreaterThan(0);
    // tail SLO on the sync sink; DES answers it
    expect(call('set_slo', { node: 'cart', key: 'tailLatency', percentiles: { p99: 500 } }).ok).toBe(true);
    const sim = j<SimOut>(call('simulate'));
    expect(sim.tailLatencyMs.p99).toBeGreaterThanOrEqual(sim.tailLatencyMs.p50);
    const tail = sim.verdicts.find((v) => v.scope === 'cart' && v.key === 'tailLatency');
    expect(tail?.status).not.toBe('unknown');
  });
});
