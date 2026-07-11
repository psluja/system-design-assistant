import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, allManifests, quantizeKnob } from '@sda/content';
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
  ports: [{ name: 'in', dir: 'in', accepts: ['sns'] }, { name: 'out', dir: 'out', speaks: ['sns'] }],
  config: [{ key: 'throughput', value: 30000, unit: 'msg/s' }, { key: 'latency', value: 10, unit: 'ms' }, { key: 'availability', value: 0.9999, unit: 'ratio' }, { key: 'durability', value: 0.999999999, unit: 'ratio' }, { key: 'unitCost', value: 1.3, unit: 'USD/(msg/s)·month' }],
  relations: [{ key: 'cost', reads: ['throughput', 'unitCost'], expr: 'inflow(throughput) * self(unitCost)' }, { key: 'overflow', reads: ['throughput'], expr: 'max(0, inflow(throughput) - self(throughput))' }],
  bands: [{ key: 'overflow', band: { shape: 'minTargetMax', max: 0 } }],
};

describe('CQRS — interactive architect ⇄ tool session (timed)', () => {
  // SKIPPED — TASK-56: this scenario's premise ("optimize sizes the Lambda indexer's concurrency DOWN to save
  // cost") became domain-invalid when the cost model went accurate (functional-loop TASK-47). compute.faas is
  // pay-per-use, so RESERVED CONCURRENCY IS FREE (you pay per invocation, not per slot), and the projections
  // store (search.elasticsearch) now has a constant provisioned cost — so optimize(proj.cost, min) is a no-op
  // and never sizes the indexer, breaking the whole cascade (MOVE 2→3→4). Needs a redesign around a cost move
  // that IS meaningful under the current models. The optimize-sizes-a-tunable behaviour stays covered by
  // search.test.ts (repair, headroom-aware) and cqrs-cheap.e2e.
  it.skip('rough moves → optimal numbers, each verified in well under a second', async () => {
    const s = new Studio(registry, catalog);
    const tools = buildTools(s);
    const opt = buildSearchTools(s, bindSolvers(registry)).find((t) => t.name === 'optimize')!;
    const call = (set: AnyTool[] | AnyTool, name: string, a: Record<string, unknown> = {}) =>
      (Array.isArray(set) ? set.find((t) => t.name === name)! : set).run(a);

    let calls = 0;
    const log: string[] = [];
    const move = async (label: string, fn: () => Promise<void> | void): Promise<void> => {
      const c0 = calls;
      const t0 = performance.now();
      await fn();
      log.push(`  ${label}: ${Math.round(performance.now() - t0)} ms, ${calls - c0} tool call(s)`);
    };
    const verdicts = () => (JSON.parse((call(tools, 'evaluate') as { text: string }).text) as { verdicts: Array<{ scope: string; key: string; status: string }> }).verdicts;
    const applyOptimize = async (): Promise<boolean> => {
      const r = (await call([opt], 'optimize', { node: 'proj', key: 'cost', direction: 'min' })) as { ok: boolean; text: string };
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

    // MOVE 2 — "make it cost-minimal." The Lambda indexer defaults to concurrency 100 (20× what 100 rps needs);
    // optimize sizes it down. Fast now: the free knobs are pruned, so the MIP is tiny.
    await move('2 "make it minimal" → optimize + apply', async () => void (await applyOptimize()));
    const concAfterOpt = JSON.parse((call(tools, 'get_project') as { text: string }).text).instances.find((i: { id: string }) => i.id === 'indexer').config.concurrency as number;
    expect(concAfterOpt).toBe(5); // sized to serve exactly 100 rps (5 × 20)

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
    expect(firstBreak).toContain('indexer'); // the down-sized Lambda is the first to overflow at 5×

    // MOVE 4 — "fix it, cheapest." Re-optimize on the SCALED, QUEUED design. The backward search solves it
    // directly: minimizing cost drives the indexer Lambda back UP to exactly the concurrency that drains the
    // index queue at 500 rps — 25 (= 500 / 20-per-concurrency). One optimize call, no manual sizing.
    let violationsAfter = -1;
    await move('4 "fix it" → re-optimize + apply + evaluate', async () => {
      const solved = await applyOptimize();
      if (!solved) throw new Error('optimize failed to converge on the queued design — the engine should solve this');
      violationsAfter = verdicts().filter((v) => v.status === 'violation').length;
      calls += 1;
    });
    const concAt500 = JSON.parse((call(tools, 'get_project') as { text: string }).text).instances.find((i: { id: string }) => i.id === 'indexer').config.concurrency as number;

    /* eslint-disable no-console */
    console.log(`\nInteractive CQRS session — ${calls} tool calls, ${Math.round(performance.now() - wall0)} ms total:\n${log.join('\n')}`);
    console.log(`  → indexer Lambda: 100 → 5 (minimal @100 rps); at 500 rps it overflowed (engine named: ${firstBreak}); re-optimized → ${concAt500}. Now ${violationsAfter} violations.\n`);
    /* eslint-enable no-console */

    expect(violationsAfter).toBe(0); // verified again after the fix
    expect(concAt500).toBe(25); // optimize sized it to serve exactly 500 rps
  }, 20_000);
});
