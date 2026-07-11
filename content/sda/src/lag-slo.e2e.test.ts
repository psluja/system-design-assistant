import { describe, expect, it } from 'vitest';
import { NodeId, type Key } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { simulate, StationId } from '@sda/engine-sim';
import {
  allManifests,
  instantiate,
  lagLowerBoundMs,
  lagVerdicts,
  nodeQueues,
  registry,
  toQueueingNetwork,
  type Instance,
  type LagProvider,
  type LagSlo,
  type Wire,
} from './index';

// THE CDC / REPLICATION LAG CASE (doc: latency-semantics-v2 §3) — the owner's motivating example, end-to-end. A
// change captured from a source database must reach the destination within X ms, and the path crosses an ASYNC
// queue, so the queue's backlog WAIT must count. This is precisely the quantity a node/response SLO CANNOT express
// (it cuts at the async boundary — what a caller waits for), and precisely what a lag SLO does.
//
// The pipeline (built inline — the committed owner file examples/oracle-to-aurora-migration-repeat.sda.json is left
// UNTOUCHED): capture(originates the change stream, reading the source DB's redo log) →ASYNC→ q(the buffer, a
// queue-mode node whose backlog wait is a TIME-DOMAIN quantity invisible to the scalar) →SYNC→ loader(applies the
// change) →SYNC→ dest(the destination store). The whole assertion is the honesty split: the SCALAR sees only the
// queue-free lower bound (it cannot prove `ok`), and the DES resolves the true async-inclusive lag — both
// directions (a generous deadline ⇒ ok, a tight one ⇒ violation).

const build = (ins: Instance[], wrs: Wire[]) => {
  const g = instantiate(allManifests, ins, wrs);
  if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
  return g.value;
};
const solve = (graph: ReturnType<typeof build>): ((id: string, k: Key) => number | undefined) => {
  const ev = evaluate(graph, registry);
  if (!ev.ok) throw new Error(`evaluate failed: ${ev.error.join('; ')}`);
  return (id, k) => ev.value.value(NodeId(id), k);
};

// capture ORIGINATES 100 change-events/s (it is a station: it serves + forwards). q drains at 120/s (ρ ≈ 0.83 —
// stable, so a real standing backlog with a finite wait, no drops). loader/dest are amply provisioned so their own
// terms are their service times. The ASYNC hop capture→q is the whole point — its backlog wait belongs to the lag.
const instances: Instance[] = [
  { id: 'capture', type: 'compute.service', config: { assumedRps: 100, latency: 20, concurrency: 100000 } },
  { id: 'q', type: 'queue.sqs', config: { queueMode: 1, drainRate: 120, maxBacklog: 1000000 } },
  { id: 'loader', type: 'compute.service', config: { perRequestDuration: 30, concurrency: 100000 } },
  { id: 'dest', type: 'db.postgres', config: { concurrency: 100000, perRequestDuration: 5 } },
];
const wires: Wire[] = [
  { from: ['capture', 'out'], to: ['q', 'in'], semantics: 'async' },
  { from: ['q', 'out'], to: ['loader', 'in'], semantics: 'sync' },
  { from: ['loader', 'out'], to: ['dest', 'in'], semantics: 'sync' },
];

describe('flow-scoped lag SLO — the CDC case end-to-end (doc: latency-semantics-v2 §3)', () => {
  it('the scalar lower bound omits the async queue wait; the DES measures the true async-inclusive lag', () => {
    const graph = build(instances, wires);
    const value = solve(graph);
    const queues = nodeQueues(graph, value);

    // 1) THE SCALAR LOWER BOUND — Σ stage own latencies (capture 20 + loader 30, dest excluded; q ≈ 0 because a
    //    queue-mode node's backlog wait is invisible to the scalar). Finite and small: the scalar cannot see the
    //    queue's wait, so it can never prove this lag `ok`.
    const lb = lagLowerBoundMs(graph, value, 'capture', 'dest', queues);
    expect(Number.isFinite(lb)).toBe(true);
    expect(lb).toBeGreaterThan(0);
    expect(lb).toBeLessThan(120); // ≈ 50 ms (capture 20 + loader 30); crucially NOT the true, queue-laden lag

    // 2) THE DES — the true async-inclusive lag from the SAME run (capture sojourn + q backlog wait + loader sojourn).
    const sim = simulate(toQueueingNetwork(graph), {
      seed: 20260703,
      warmupCompletions: 8000,
      measureCompletions: 40000,
      lagPairs: [{ source: StationId('capture'), terminal: StationId('dest') }],
    });
    const pair = sim.pairLag.find((p) => String(p.source) === 'capture' && String(p.terminal) === 'dest');
    if (pair === undefined) throw new Error('no pair lag measured');
    const lagMs = pair.mean * 1000; // s → ms
    expect(pair.samples).toBeGreaterThan(0); // the destination WAS reached — a real measurement, not `unknown`
    // The DES lag INCLUDES the async queue wait, so it is meaningfully ABOVE the queue-free scalar lower bound.
    expect(lagMs).toBeGreaterThan(lb * 1.2);

    // A provider adapting the DES pairLag to the shared lag-verdict computation (the same shape MCP `simulate` builds).
    const lag: LagProvider = (s, t) => {
      const found = sim.pairLag.find((p) => String(p.source) === s && String(p.terminal) === t);
      return found && Number.isFinite(found.mean) ? found.mean * 1000 : undefined;
    };

    // 3) BOTH DIRECTIONS, resolved by the DES.
    // (a) GENEROUS deadline — comfortably above the measured lag ⇒ ok, from the MEASURED basis.
    const generous: LagSlo[] = [{ source: 'capture', terminal: 'dest', maxMs: Math.ceil(lagMs * 3) }];
    const okV = lagVerdicts(graph, value, generous, queues, lag)[0];
    expect(okV?.status).toBe('ok');
    expect(okV?.basis).toBe('measured');

    // (b) A deadline the SCALAR cannot decide but the DES resolves to a violation — a maxMs BETWEEN the queue-free
    //     lower bound and the true lag. Without the sim the verdict is honest `unknown`; with it, a real violation.
    const tightMs = Math.round((lb + lagMs) / 2);
    expect(tightMs).toBeGreaterThan(lb);
    expect(tightMs).toBeLessThan(lagMs);
    const tight: LagSlo[] = [{ source: 'capture', terminal: 'dest', maxMs: tightMs }];

    const scalarOnly = lagVerdicts(graph, value, tight, queues)[0]; // no lag provider ⇒ the scalar pass alone
    expect(scalarOnly?.status).toBe('unknown'); // the scalar cannot prove ok — the queue wait is invisible to it
    expect(scalarOnly?.basis).toBe('unknown');
    expect(scalarOnly?.note).toContain('simulate'); // it points at the resolution

    const resolved = lagVerdicts(graph, value, tight, queues, lag)[0]; // the DES resolves it
    expect(resolved?.status).toBe('violation');
    expect(resolved?.basis).toBe('measured');
  });

  it('a lower bound already over the deadline is a PROVABLE violation with no sim (basis: lower-bound)', () => {
    const graph = build(instances, wires);
    const value = solve(graph);
    const lb = lagLowerBoundMs(graph, value, 'capture', 'dest');
    // A deadline BELOW even the queue-free lower bound: the scalar alone proves the breach (the true lag is ≥ lb).
    const tooTight: LagSlo[] = [{ source: 'capture', terminal: 'dest', maxMs: Math.max(1, Math.floor(lb / 2)) }];
    const v = lagVerdicts(graph, value, tooTight)[0];
    expect(v?.status).toBe('violation');
    expect(v?.basis).toBe('lower-bound');
  });

  it('a lag SLO whose flow is not connected is honestly UNKNOWN (never a silent drop)', () => {
    const graph = build(instances, wires);
    const value = solve(graph);
    // dest → capture is the WRONG direction (routing only flows capture→…→dest), so there is no path.
    const backwards: LagSlo[] = [{ source: 'dest', terminal: 'capture', maxMs: 1000 }];
    const v = lagVerdicts(graph, value, backwards)[0];
    expect(v?.status).toBe('unknown');
    expect(v?.note).toContain('no path');
  });
});
