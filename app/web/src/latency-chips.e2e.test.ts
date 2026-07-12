import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { NodeId, type Key } from '@sda/engine-core';
import { registry, allManifests, keys, toQueueingNetwork, nodeQueues, realAwareVerdicts, requestFlows, localContribution, systemSummary } from '@sda/content';
import { simulate, type QueueingNetwork } from '@sda/engine-sim';
import { measuredResponseOf, latencyRangeBar, latencyTone, responseRows, simVerdicts, summarySections, type SimTail, type NodeResponseView } from '@sda/presenter';

const catalog = allManifests;

// THE RESPONSE LOOP: the architect sets a latency requirement on
// a service and must read its mean + p99 RESPONSE there, continuously, after a sim run. This exercises the EXACT
// pipeline the web shell runs — Studio → toQueueingNetwork → the discrete-event simulation → the shared SimTail → the
// presenter — and asserts the canvas latency BAR (measured p50→p99) and the System ROWS render with plausible numbers,
// INCLUDING the sink-gate fix (a NON-terminal node's tail now gets a real verdict, not `unknown`). No browser is
// needed: the web computes NOTHING beyond the presenter (web-is-a-dumb-renderer), so driving the presenter over a REAL
// DES run IS the web's render path — and it stays deterministic (seed 7) and fast.
describe('latency bar e2e — a node reads its measured p50→p99 range after a real sim run', () => {
  // client → gw → fn → db. The tail/mean SLOs sit on `fn`, a NON-terminal (mid-path) node — the case R2's sink gate
  // wrongly left `unknown`. Load kept comfortably below every tier's capacity so responses are finite (not ∞).
  function build(): Studio {
    const s = new Studio(registry, catalog);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.source' });
    s.dispatch({ kind: 'setConfig', node: 'client', key: 'throughput', value: 400 });
    s.dispatch({ kind: 'addComponent', id: 'gw', type: 'gateway.api' });
    s.dispatch({ kind: 'addComponent', id: 'fn', type: 'compute.faas' });
    // A generous tail SLO on the mid-path function + a mean-latency SLO — the requirement-bearing shape the display
    // commits full numbers on. Generous so an unsaturated design reads `ok`, not a violation (we assert the verdict is
    // real, i.e. not `unknown`, which is what the sink-gate fix delivers).
    s.dispatch({ kind: 'setSLO', node: 'fn', key: keys.tailLatency, band: { shape: 'percentiles', targets: new Map([['p99', 5000]]) } });
    s.dispatch({ kind: 'setSLO', node: 'fn', key: keys.latency, band: { shape: 'minTargetMax', max: 5000 } });
    s.dispatch({ kind: 'addComponent', id: 'db', type: 'db.sql' });
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['gw', 'in'] });
    s.dispatch({ kind: 'connect', from: ['gw', 'out'], to: ['fn', 'in'] });
    s.dispatch({ kind: 'connect', from: ['fn', 'out'], to: ['db', 'in'] });
    return s;
  }

  // Run the REAL DES exactly as the web sim-worker does (seed 7) and pack the result into the SHARED SimTail (ms) —
  // this is the plumbing the worker performs, verified end-to-end.
  function runSim(s: Studio): SimTail {
    const g = s.graph();
    if (!g.ok) throw new Error('graph build failed');
    const net: QueueingNetwork = toQueueingNetwork(g.value);
    const r = simulate(net, { seed: 7, warmupCompletions: 10000, measureCompletions: 50000 });
    const nodeResponse: NodeResponseView[] = r.nodeResponse.map((n) => ({ id: String(n.id), mean: n.mean * 1000, p50: n.p50 * 1000, p95: n.p95 * 1000, p99: n.p99 * 1000, samples: n.samples }));
    return { p50: r.sojournPercentile(0.5) * 1000, p95: r.sojournPercentile(0.95) * 1000, p99: r.sojournPercentile(0.99) * 1000, nodeResponse };
  }

  const s = build();
  const ev = s.evaluate();
  if (!ev.ok) throw new Error(`eval failed: ${ev.error.join('; ')}`);
  const g = s.graph();
  if (!g.ok) throw new Error('graph failed');
  const doc = s.project();
  const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
  const queues = nodeQueues(g.value, value);
  const verdsBase = realAwareVerdicts(ev.value.verdicts, g.value, value, queues);
  const sim = runSim(s);
  const verds = simVerdicts(verdsBase, g.value, registry, sim);
  const flows = requestFlows(doc.instances, doc.wires, value);
  const saturated = new Map<string, number>();
  for (const [id, q] of queues) if (q.rho >= 1) saturated.set(id, value(id, keys.overflow) ?? 0);
  const ownCost = localContribution(value, doc.instances, doc.wires, keys.cost);
  const totalCost = Object.values(ownCost).reduce((a, b) => a + (b > 0.005 ? b : 0), 0);
  const costBreak = systemSummary(doc.instances, doc.wires, value).cost;
  const labelOf = (id: string, type: string): string => doc.labels[id] ?? (type.split('.').pop() ?? type);
  const typeOf = (id: string): string => doc.instances.find((x) => x.id === id)?.type ?? '';

  it('the DES yields a finite per-node response for the requirement-bearing node (mean + a real tail)', () => {
    const fn = sim.nodeResponse!.find((n) => n.id === 'fn');
    expect(fn).toBeDefined();
    expect(Number.isFinite(fn!.mean)).toBe(true);
    expect(fn!.mean).toBeGreaterThan(0);
    expect(fn!.p99).toBeGreaterThanOrEqual(fn!.p50); // the tail is at least the median
    expect(fn!.samples).toBeGreaterThan(0);
  });

  it('the canvas latency BAR renders the MEASURED p50→p99 range (single truth, no analytic; no selection gate)', () => {
    const fnMeasured = measuredResponseOf(sim, 'fn');
    expect(fnMeasured).not.toBeNull();
    const bar = latencyRangeBar(fnMeasured!, latencyTone(verds, 'fn'));
    expect(bar.typical).toMatch(/^p50 [\d,]+ ms$/); // whole-ms named anchor
    expect(bar.tail).toMatch(/^p99 [\d,]+ ms$/);
    expect(bar.tone).toBe('ok'); // p99 well under the generous 5,000 ms tail SLO ⇒ verdict-toned ok
    // MEASURED-OR-NOTHING shows the bar wherever the DES measured — db is a station too (no requirement-bearing gate).
    expect(measuredResponseOf(sim, 'db')).not.toBeNull();
    // SINGLE-TRUTH LATENCY FOR ORIGINS: the client is now a measured station too, so it carries the SAME p50→p99 bar
    // (the entry node's response IS the end-to-end journey) — the owner's "query-clients shows no latency bar" fix.
    const clientMeasured = measuredResponseOf(sim, 'client');
    expect(clientMeasured).not.toBeNull();
    const clientBar = latencyRangeBar(clientMeasured!, latencyTone(verds, 'client'));
    expect(clientBar.typical).toMatch(/^p50 [\d,]+ ms$/);
    expect(clientBar.tail).toMatch(/^p99 [\d,]+ ms$/);
  });

  it('the sink-gate fix: the NON-terminal fn tail gets a REAL verdict from its OWN response tail (not `unknown`)', () => {
    const tail = verds.find((v) => String(v.scope) === 'fn' && String(v.key) === String(keys.tailLatency));
    expect(tail).toBeDefined();
    expect(tail!.status).not.toBe('unknown');
    expect(tail!.status).toBe('ok'); // p99 well under the generous 5,000 ms target
  });

  it('the System "Response time · per component" section carries the fn row (p50/p95/p99)', () => {
    const label = labelOf('fn', typeOf('fn'));
    const rows = responseRows(sim, doc.instances, verds, labelOf, typeOf);
    const row = rows.find((r) => r.label === label);
    expect(row).toBeDefined();
    expect(row!.value).toMatch(/p50 .*p95 .*p99/);
    const sections = summarySections({
      instances: doc.instances, wires: doc.wires, value, flows, queues, saturated, totalCost, costBreak,
      verdicts: verds, evalOk: ev.ok, evalErrorCount: 0, sim, labelOf, typeOf,
    });
    const respSection = sections.find((sec) => sec.title === 'Response time · per component');
    expect(respSection).toBeDefined();
    expect(respSection!.rows.some((r) => r.label === label)).toBe(true);
  });
});
