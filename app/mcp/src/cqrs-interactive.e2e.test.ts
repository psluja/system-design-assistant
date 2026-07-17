import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, allManifests, quantizeKnob, TARGET_UTILIZATION } from '@sda/content';
import { buildTools, type AnyTool } from './tools';
import { buildSearchTools } from './search';
import { bindSolvers } from './composition';

// An INTERACTIVE architect ⇄ tool session on the CQRS: the architect makes ROUGH moves ("design this",
// "make it minimal", "scale to 500", "fix it"); the tool adds the OPTIMAL, concrete numbers. We time every
// move. The point: each move is one or two tool calls and returns a VERIFIED result in well under a second —
// the engine does the optimisation, the AI never sits and "thinks" between moves. (This only became viable
// once optimize was made fast on these graphs.)
const catalog = allManifests;

const SNS = {
  type: 'topic.sns',
  // accepts 'https'/'http' too (PUBLISH_SOURCES, port-roles.ts) — cmd's generic 'out' port reaches SNS over
  // those, same accepts list the never-skipped cqrs.e2e.test.ts / cqrs-cheap.e2e.test.ts already use.
  ports: [{ name: 'in', dir: 'in', accepts: ['sns', 'https', 'http'] }, { name: 'out', dir: 'out', speaks: ['sns'] }],
  config: [{ key: 'throughput', value: 30000, unit: 'msg/s' }, { key: 'latency', value: 10, unit: 'ms' }, { key: 'availability', value: 0.9999, unit: 'ratio' }, { key: 'durability', value: 0.999999999, unit: 'ratio' }, { key: 'unitCost', value: 1.3, unit: 'USD/(msg/s)·month' }],
  relations: [{ key: 'cost', reads: ['throughput', 'unitCost'], expr: 'inflow(throughput) * self(unitCost)' }, { key: 'overflow', reads: ['throughput'], expr: 'max(0, inflow(throughput) - self(throughput))' }],
  bands: [{ key: 'overflow', band: { shape: 'minTargetMax', max: 0 } }],
};

describe('CQRS — interactive architect ⇄ tool session (timed)', () => {
  // — the re-baseline.
  // The file was skipped on the premise "Lambda is pay-per-use, so optimize-for-cost can't
  // (and shouldn't) size its concurrency down" — that does NOT hold against the live catalog: compute.faas prices
  // reserved concurrency via costPer(concurrency) (catalog.ts: "cost scales with provisioned concurrency — so
  // 'run backwards' has a real trade-off to optimize"), the same capacity-must-cost-money rule every priced
  // component obeys (behaviors.ts: "a free capacity dial would let the backward-solver 'meet the SLO' for $0 and
  // make every cost figure a fiction"). So sizing the Lambda down for cost IS domain-true today, confirmed below
  // against the native solver. The ACTUAL bug that broke this file was unrelated to costing: the test's own inline
  // SNS component's `in` port accepted only `['sns']`, one short of the `sns`/`https`/`http` PUBLISH_SOURCES set
  // (port-roles.ts) that `cmd`'s generic `out` port speaks — an illegal wire, so `apply_design` applied NOTHING
  // (atomic) and every later move read an empty design. Fixed to the same accepts list the sibling, never-skipped
  // cqrs.e2e.test.ts / cqrs-cheap.e2e.test.ts already carry. MOVE 2/4 now optimize scope:"system" (the F8
  // whole-design total, search.test.ts) instead of one node's cumulative path, so every cost-bearing tier (the
  // app pool, Postgres, the Lambda) right-sizes together rather than only whichever tier sits upstream of one
  // chosen node — and search.elasticsearch's floor (part of the ORIGINAL diagnosis that WAS correct) is asserted
  // explicitly below: its provisioned cost never has anywhere to shrink to.
  it('rough moves → optimal numbers, each verified in well under a second', async () => {
    const s = new Studio(registry, catalog);
    const tools = buildTools(s);
    const opt = buildSearchTools(s, bindSolvers(registry)).find((t) => t.name === 'optimize')!;
    const call = (set: AnyTool[] | AnyTool, name: string, a: Record<string, unknown> = {}) =>
      (Array.isArray(set) ? set.find((t) => t.name === name)! : set).run(a);
    const configOf = (id: string): Record<string, number> =>
      (JSON.parse((call(tools, 'get_project') as { text: string }).text).instances.find((i: { id: string }) => i.id === id) as { config: Record<string, number> }).config;

    let calls = 0;
    const log: string[] = [];
    const move = async (label: string, fn: () => Promise<void> | void): Promise<void> => {
      const c0 = calls;
      const t0 = performance.now();
      await fn();
      log.push(`  ${label}: ${Math.round(performance.now() - t0)} ms, ${calls - c0} tool call(s)`);
    };
    const verdicts = () => (JSON.parse((call(tools, 'evaluate') as { text: string }).text) as { verdicts: Array<{ scope: string; key: string; status: string }> }).verdicts;
    // scope:"system" (the F8 whole-design total, search.test.ts) — the objective sums EVERY node's own cost
    // contribution, so cmd/pg/indexer (each priced by their own costPer(concurrency)) right-size TOGETHER; a
    // single node's cumulative path would leave whichever of them sits off that path untouched (or worse, free
    // to drift, since a knob the objective never reads is left at an arbitrary witness value).
    const applyOptimize = async (): Promise<boolean> => {
      const r = (await call([opt], 'optimize', { key: 'cost', direction: 'min', scope: 'system' })) as { ok: boolean; text: string };
      calls += 1;
      if (!r.ok) return false;
      for (const a of JSON.parse(r.text) as Array<{ node: string; key: string; value: number }>) {
        call(tools, 'set_config', { node: a.node, key: a.key, value: quantizeKnob(a.key, a.value) });
        calls += 1;
      }
      return true;
    };

    const wall0 = performance.now();

    // MOVE 1 — "design a CQRS: Postgres source of truth, projections, HTTP-POST commands, SNS+SQS events,
    // API gateway, a Fargate cluster on its own SQS doing reports to S3, indexing on another SQS on Lambda.
    // ~100 command rps." → the tool builds it concretely in ONE call.
    await move('1 describe → build (1 call)', () => {
      call(tools, 'define_component', { json: JSON.stringify(SNS) });
      calls += 1;
      call(tools, 'apply_design', {
        instances: [
          { id: 'client', type: 'client.web', config: { throughput: 100 }, label: 'Clients' },
          { id: 'gw', type: 'apigw.rest', label: 'API Gateway' },
          { id: 'cmd', type: 'compute.service', label: 'Command handler' },
          { id: 'pg', type: 'db.postgres', label: 'Source of truth' },
          { id: 'sns', type: 'topic.sns', label: 'Event topic' },
          { id: 'indexq', type: 'queue.sqs', label: 'Index queue' },
          { id: 'indexer', type: 'compute.faas', label: 'Indexer (Lambda)' },
          { id: 'proj', type: 'search.elasticsearch', label: 'Projections' },
          { id: 'reportq', type: 'queue.sqs', label: 'Report queue' },
          { id: 'reporter', type: 'compute.fargate', label: 'Report cluster (Fargate)' },
          { id: 's3', type: 'storage.object', label: 'Reports (S3)' },
        ],
        wires: [['client', 'out', 'gw', 'in'], ['gw', 'out', 'cmd', 'in'], ['cmd', 'db', 'pg', 'in'], ['cmd', 'out', 'sns', 'in'], ['sns', 'out', 'indexq', 'in'], ['sns', 'out', 'reportq', 'in'], ['indexq', 'out', 'indexer', 'in'], ['indexer', 'out', 'proj', 'in'], ['reportq', 'out', 'reporter', 'in'], ['reporter', 'out', 's3', 'in']],
      });
      calls += 1;
    });
    const idxCap0 = Number(JSON.parse((call(tools, 'get_project') as { text: string }).text).instances.length); // touch state
    expect(idxCap0).toBe(11);

    // MOVE 2 — "make it cost-minimal." Three tiers on the request path each price their OWN capacity dial via
    // costPer(concurrency): cmd (compute.service), pg (db.postgres — the same connection-bound shape as
    // search.test.ts's `repair` case), and indexer (compute.faas — Lambda's RESERVED concurrency IS priced here,
    // not pay-per-use; see the describe-block note). Each defaults 7-100× oversized for 100 rps; one optimize
    // call sizes every one of them down to the ρ ≤ 80% headroom floor (search.test.ts's TARGET_UTILIZATION).
    await move('2 "make it minimal" → optimize + apply', async () => void (await applyOptimize()));
    // cmd (compute.service): capacity = concurrency × (1000 / perRequestDuration) = concurrency × (1000/20ms) =
    // concurrency × 50 req/s. pg (db.postgres) AND indexer (compute.faas) both default perRequestDuration = 50ms
    // here = concurrency × 20 req/s. Headroom: offered ≤ TARGET_UTILIZATION × capacity ⇒ concurrency ≥
    // offered / TARGET_UTILIZATION / rate, whole-unit knob ⇒ ceil (quantizeKnob's own rounding rule).
    const CMD_RATE = 1000 / 20; // req/s per compute.service worker
    const CONN_RATE = 1000 / 50; // req/s per db.postgres connection == per compute.faas concurrency unit (same 50 ms here)
    const cmdConcurrencyAt = (rps: number): number => Math.ceil(rps / TARGET_UTILIZATION / CMD_RATE);
    const connConcurrencyAt = (rps: number): number => Math.ceil(rps / TARGET_UTILIZATION / CONN_RATE);
    expect(configOf('cmd').concurrency).toBe(cmdConcurrencyAt(100)); // = ceil(100/0.8/50) = 3
    expect(configOf('pg').concurrency).toBe(connConcurrencyAt(100)); // = ceil(100/0.8/20) = 7
    expect(configOf('indexer').concurrency).toBe(connConcurrencyAt(100)); // = ceil(100/0.8/20) = 7 — the Lambda sizes down too: its cost is genuinely priced (costPer), so this is domain-true, not the old free-knob premise
    // search.elasticsearch: provisionedCost = self(throughput) × unitCost — a genuine floor at its declared 5,000
    // query/s ceiling (raise-only; cost-minimizing never wants to raise it). NEVER moves — the one part of the
    // original skip-note diagnosis that was actually correct.
    expect(configOf('proj').throughput).toBe(5000);

    // MOVE 3 — "scale commands to 500 rps — where does it break first?" One config change; the engine pinpoints
    // the new bottleneck instantly.
    let firstBreak = '';
    await move('3 "scale to 500 rps" → set_config + evaluate', () => {
      call(tools, 'set_config', { node: 'client', key: 'throughput', value: 500 });
      calls += 1;
      const vs = verdicts();
      calls += 1;
      firstBreak = vs.filter((v) => v.status === 'violation').map((v) => `${v.scope}.${v.key}`).join(', ');
    });
    expect(firstBreak).toContain('cmd.overflow'); // cmd's rightsized pool caps at 3×50 = 150 rps ≪ 500 rps offered — the root cause every downstream verdict cites

    // MOVE 4 — "fix it, cheapest." Re-optimize on the SCALED design: the SAME system-scope objective drives every
    // downsized tier back UP to exactly the concurrency the new 500 rps needs. One optimize call, no manual sizing.
    let violationsAfter = -1;
    await move('4 "fix it" → re-optimize + apply + evaluate', async () => {
      const solved = await applyOptimize();
      if (!solved) throw new Error('optimize failed to converge on the queued design — the engine should solve this');
      violationsAfter = verdicts().filter((v) => v.status === 'violation').length;
      calls += 1;
    });
    const concAt500 = { cmd: configOf('cmd').concurrency, pg: configOf('pg').concurrency, indexer: configOf('indexer').concurrency };

    /* eslint-disable no-console */
    console.log(`\nInteractive CQRS session — ${calls} tool calls, ${Math.round(performance.now() - wall0)} ms total:\n${log.join('\n')}`);
    console.log(`  → cmd/pg/indexer rightsized 500/100/100 → 3/7/7 @100 rps; at 500 rps ${firstBreak.split(', ')[0]} overflowed; re-optimized → ${concAt500.cmd}/${concAt500.pg}/${concAt500.indexer}. Now ${violationsAfter} violations.\n`);
    /* eslint-enable no-console */

    expect(violationsAfter).toBe(0); // verified again after the fix
    expect(concAt500.cmd).toBe(cmdConcurrencyAt(500)); // = ceil(500/0.8/50) = 13
    expect(concAt500.pg).toBe(connConcurrencyAt(500)); // = ceil(500/0.8/20) = 32
    expect(concAt500.indexer).toBe(connConcurrencyAt(500)); // = ceil(500/0.8/20) = 32
  }, 20_000);
});
