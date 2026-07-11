import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { NodeId, type Key } from '@sda/engine-core';
import {
  registry, allManifests, keys,
  nodeQueues, realCumulativeLatency, realAwareVerdicts,
  requestFlows, systemSummary, localContribution, hasTrafficOrigin, NO_ORIGIN_REASON,
  lagVerdicts, systemPromiseVerdicts,
  type NodeQueue,
} from '@sda/content';
import {
  problemRows, problemCount,
  statusLine,
  summarySections, systemVerdict, simVerdicts, PROMISES_TITLE,
  responseRows, formatResponseTail,
  measuredResponseOf, latencyTone, latencyRangeBar,
  nodeDetail,
  tidyLayout,
  buildCandidates, suggestFor, matchingPort,
  type SimTail, type NodeResponseView,
} from './index';

const catalog = allManifests;

// ── A REAL design, built exactly like the content e2e/design-doc tests: client → API gateway → an
// UNDER-provisioned serverless function → a SQL DB. The DB carries a throughput SLO (target 1000, met by 600 ⇒
// a soft-target WARNING) and an availability floor (≥ 99.99%, missed by the series product ⇒ a VIOLATION). This
// exercises the presenter's severity ordering, the flow roll-up, verdict rows and the load-per-tier section on
// one honest model — nothing is stubbed. ──────────────────────────────────────────────────────────────────────
function buildDesign(): Studio {
  const s = new Studio(registry, catalog);
  s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.source' });
  s.dispatch({ kind: 'addComponent', id: 'gw', type: 'gateway.api' });
  s.dispatch({ kind: 'setConfig', node: 'gw', key: 'availability', value: 0.9995 });
  s.dispatch({ kind: 'addComponent', id: 'compute', type: 'compute.faas' });
  s.dispatch({ kind: 'setConfig', node: 'compute', key: 'concurrency', value: 30 });
  s.dispatch({ kind: 'addComponent', id: 'db', type: 'db.sql' });
  s.dispatch({ kind: 'setSLO', node: 'db', key: keys.throughput, band: { shape: 'minTargetMax', target: 1000 } });
  s.dispatch({ kind: 'setSLO', node: 'db', key: keys.availability, band: { shape: 'minTargetMax', min: 0.9999 } });
  s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['gw', 'in'] });
  s.dispatch({ kind: 'connect', from: ['gw', 'out'], to: ['compute', 'in'] });
  s.dispatch({ kind: 'connect', from: ['compute', 'out'], to: ['db', 'in'] });
  return s;
}

// The shell wiring, reproduced once so every test reads the SAME real-aware truth the web/vscode shells read.
function evalState(s: Studio) {
  const ev = s.evaluate();
  if (!ev.ok) throw new Error(`build failed: ${ev.error.join('; ')}`);
  const gr = s.graph();
  if (!gr.ok) throw new Error('graph build failed');
  const doc = s.project();
  const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
  const queues = nodeQueues(gr.value, value);
  const verds = realAwareVerdicts(ev.value.verdicts, gr.value, value, queues);
  const flows = requestFlows(doc.instances, doc.wires, value);
  const realLatByNode = realCumulativeLatency(gr.value, value, queues);
  const saturated = new Map<string, number>();
  for (const [id, q] of queues) if (q.rho >= 1) saturated.set(id, value(id, keys.overflow) ?? 0);
  const ownCost = localContribution(value, doc.instances, doc.wires, keys.cost);
  const totalCost = Object.values(ownCost).reduce((a, b) => a + (b > 0.005 ? b : 0), 0);
  const costBreak = systemSummary(doc.instances, doc.wires, value).cost;
  const labelOf = (id: string, type: string): string => doc.labels[id] ?? (type.split('.').pop() ?? type);
  const typeOf = (id: string): string => doc.instances.find((x) => x.id === id)?.type ?? '';
  return { ev, graph: gr.value, doc, value, queues, verds, flows, realLatByNode, saturated, totalCost, costBreak, labelOf, typeOf };
}

describe('problemRows — the shared Error List projection', () => {
  const st = evalState(buildDesign());
  const rows = problemRows(st.verds, st.ev.ok, []);

  it('surfaces the DB availability violation and the throughput warning', () => {
    const av = rows.find((r) => r.node === 'db' && r.key === String(keys.availability));
    const tp = rows.find((r) => r.node === 'db' && r.key === String(keys.throughput));
    expect(av?.severity).toBe('violation');
    expect(tp?.severity).toBe('warning');
  });

  it('sorts violation → warning → unknown (severity is the primary key)', () => {
    const sev = { violation: 0, warning: 1, unknown: 2 } as const;
    for (let i = 1; i < rows.length; i++) {
      expect(sev[rows[i]!.severity]).toBeGreaterThanOrEqual(sev[rows[i - 1]!.severity]);
    }
    // the very first non-ok row must be a violation (there is at least one on this design)
    expect(rows[0]?.severity).toBe('violation');
  });

  it('carries the engine remediation as `fix` on a violation', () => {
    const av = rows.find((r) => r.node === 'db' && r.key === String(keys.availability));
    expect(typeof av?.fix).toBe('string');
    expect(av?.fix?.length ?? 0).toBeGreaterThan(0);
  });

  it('prepends a build-error row (node "", key "build", value NaN) when the graph does not compile', () => {
    const withErrors = problemRows(st.verds, false, ['relation loop at n1', 'unknown key foo']);
    expect(withErrors[0]).toMatchObject({ severity: 'violation', node: '', key: 'build' });
    expect(Number.isNaN(withErrors[0]!.value)).toBe(true);
    expect(withErrors[0]!.fix).toBe('relation loop at n1');
    // build rows come BEFORE the verdict rows
    expect(withErrors.filter((r) => r.key === 'build')).toHaveLength(2);
  });

  it('problemCount = violations + warnings, excluding unverified `unknown` rows', () => {
    const violationsAndWarnings = rows.filter((r) => r.severity !== 'unknown').length;
    expect(problemCount(rows)).toBe(violationsAndWarnings);
    expect(problemCount(rows)).toBeGreaterThan(0);
  });
});

describe('statusLine — the shared footer / status-bar figures', () => {
  const st = evalState(buildDesign());
  const sinkId = st.doc.instances.find((i) => (i.bands?.length ?? 0) > 0)?.id ?? st.doc.instances.at(-1)?.id;
  const throughput = sinkId ? st.value(sinkId, keys.throughput) : undefined;
  const realLatency = st.flows[0] ? st.realLatByNode.get(st.flows[0].terminal) : undefined;

  it('reports the served throughput at the SLO endpoint, the cost and the violation count', () => {
    const status = statusLine(throughput, realLatency, st.totalCost, st.verds, st.ev.ok, 0);
    expect(status.throughputRps).toBeGreaterThan(0);
    expect(status.costUsdMonth).toBeGreaterThan(0);
    expect(status.violations).toBeGreaterThan(0); // the DB availability violation
    // latency is EITHER a finite positive figure OR honestly omitted (when a tier saturates → ∞); never a fake.
    if ('latencyMs' in status) {
      expect(status.latencyMs).toBeGreaterThan(0);
      expect(Number.isFinite(status.latencyMs!)).toBe(true);
    }
  });

  it('passes through a finite real latency as latencyMs', () => {
    // A well-provisioned single hop (offered ≪ capacity) has a finite queueing latency the status bar shows.
    const status = statusLine(1000, 42.5, 500, [], true, 0);
    expect(status.latencyMs).toBe(42.5);
  });

  it('OMITS latency (never fakes a number) when the terminal latency is ∞ / undefined', () => {
    const infinite = statusLine(1000, Infinity, 500, [], true, 0);
    expect('latencyMs' in infinite).toBe(false);
    const missing = statusLine(1000, undefined, 500, [], true, 0);
    expect('latencyMs' in missing).toBe(false);
  });

  it('counts build errors as violations when the design does not compile', () => {
    const status = statusLine(undefined, undefined, 0, [], false, 3);
    expect(status.violations).toBe(3);
    expect('throughputRps' in status).toBe(false);
    expect('costUsdMonth' in status).toBe(false);
  });
});

describe('summarySections — the shared System roll-up', () => {
  const st = evalState(buildDesign());
  const sections = summarySections({
    instances: st.doc.instances,
    wires: st.doc.wires,
    value: st.value,
    flows: st.flows,
    queues: st.queues,
    saturated: st.saturated,
    totalCost: st.totalCost,
    costBreak: st.costBreak,
    verdicts: st.verds,
    evalOk: st.ev.ok,
    evalErrorCount: 0,
    sim: null,
    labelOf: st.labelOf,
    typeOf: st.typeOf,
  });

  it('opens with a Design section carrying the component / connection / flow counts', () => {
    const design = sections.find((x) => x.title === 'Design');
    expect(design).toBeDefined();
    expect(design!.rows.find((r) => r.label === 'Components')?.value).toBe('4');
    expect(design!.rows.find((r) => r.label === 'Connections')?.value).toBe('3');
    expect(design!.rows.find((r) => r.label === 'Independent flows')?.value).toBe('1');
  });

  it('marks the Violations row with a `bad` tone when a verdict fails', () => {
    const v = sections.find((x) => x.title === 'Design')!.rows.find((r) => r.label === 'Violations');
    expect(v?.tone).toBe('bad');
    expect(Number(v?.value)).toBeGreaterThan(0);
  });

  it('emits one flow section titled "System · <source> → <terminal>" with pre-formatted figures', () => {
    const flow = sections.find((x) => x.title.startsWith('System · '));
    expect(flow).toBeDefined();
    expect(flow!.title).toContain('→');
    // SINGLE-TRUTH LATENCY: with no sim yet there is NO latency row (measured-or-nothing — never the analytic scalar).
    expect(flow!.rows.map((r) => r.label)).toEqual(['Throughput', 'Availability', 'Cost']);
    expect(flow!.rows.some((r) => r.label.startsWith('Latency'))).toBe(false);
    // availability is a percentage string; cost carries the $…/mo unit — pre-formatted, not raw numbers.
    expect(flow!.rows.find((r) => r.label === 'Availability')?.value).toMatch(/%$/);
    expect(flow!.rows.find((r) => r.label === 'Cost')?.value).toMatch(/^\$.*\/mo$/);
  });

  it('shows the flow latency as the terminal MEASURED response (mean · p99) once a sim covers it', () => {
    const withSim = summarySections({
      instances: st.doc.instances, wires: st.doc.wires, value: st.value, flows: st.flows, queues: st.queues,
      saturated: st.saturated, totalCost: st.totalCost, costBreak: st.costBreak,
      verdicts: st.verds, evalOk: st.ev.ok, evalErrorCount: 0,
      sim: { p50: 40, p95: 120, p99: 250, nodeResponse: [{ id: 'db', mean: 90, p50: 80, p95: 210, p99: 240, samples: 4096 }] },
      labelOf: st.labelOf, typeOf: st.typeOf,
    });
    const flow = withSim.find((x) => x.title.startsWith('System · '))!;
    const lat = flow.rows.find((r) => r.label === 'Latency (measured)');
    expect(lat).toBeDefined();
    expect(lat!.value).toBe('90 ms · p99 240 ms'); // the DB terminal's measured mean + p99 — never an analytic figure
  });

  it('shows an honest pending row for the simulated tail when no sim has run', () => {
    const tail = sections.find((x) => x.title === 'Response time · end-to-end');
    expect(tail).toBeDefined();
    expect(tail!.rows).toEqual([{ label: 'status', value: 'set a client throughput to simulate the tail' }]);
  });

  it('reads the simulated tail (p50/p95/p99) when the sim is present', () => {
    const withSim = summarySections({
      instances: st.doc.instances, wires: st.doc.wires, value: st.value, flows: st.flows, queues: st.queues,
      saturated: st.saturated, totalCost: st.totalCost, costBreak: st.costBreak,
      verdicts: st.verds, evalOk: st.ev.ok, evalErrorCount: 0, sim: { p50: 40, p95: 120, p99: 250 },
      labelOf: st.labelOf, typeOf: st.typeOf,
    });
    const tail = withSim.find((x) => x.title === 'Response time · end-to-end')!;
    expect(tail.rows).toEqual([
      { label: 'p50', value: '40 ms' },
      { label: 'p95', value: '120 ms' },
      { label: 'p99 · tail', value: '250 ms' },
    ]);
  });

  it('emits a Load per component section with a % value for each queued node', () => {
    const load = sections.find((x) => x.title === 'Load per component');
    expect(load).toBeDefined();
    expect(load!.rows.length).toBeGreaterThan(0);
    for (const r of load!.rows) expect(r.value === 'saturated · drops 0/s' || /%$/.test(r.value) || /^saturated/.test(r.value)).toBe(true);
  });
});

// WORST-CASE Load per component (owner ruling: a peak is just traffic in a given environment). Each row reads the
// WORST load the declared environment produces — the worst-window ρ when a generator is shaped, else the steady ρ —
// as a SINGLE number, red when it saturates, with NO 'peak' vocabulary, no '@HH:MM' and no dual reading. A node that
// breaks ONLY at its declared peak reads red here; a node fine at both stays green. Byte-identical with no shape.
describe('summarySections — WORST-CASE Load per component', () => {
  const st = evalState(buildDesign());
  const [pid, pq] = [...st.queues.entries()][0]!; // any metered tier
  const base = {
    instances: st.doc.instances, wires: st.doc.wires, value: st.value, flows: st.flows, queues: st.queues,
    saturated: st.saturated, totalCost: st.totalCost, costBreak: st.costBreak, verdicts: st.verds,
    evalOk: st.ev.ok, evalErrorCount: 0, sim: null, labelOf: st.labelOf, typeOf: st.typeOf,
  } as const;
  const loadOf = (peakByNode?: Map<string, { rho: number; atS: number }>) =>
    summarySections({ ...base, ...(peakByNode ? { peakByNode } : {}) }).find((x) => x.title === 'Load per component')!;

  it('reads the worst-window ρ (not the steady mean) as a single number, red when it saturates, no peak/@ framing', () => {
    const worst = pq.rho + 1; // clearly saturating at the worst window
    const load = loadOf(new Map([[pid, { rho: worst, atS: 61_200 }]]));
    const row = load.rows.find((r) => r.label === st.labelOf(pid, st.typeOf(pid)))!;
    expect(row.value).toBe(`${(worst * 100).toFixed(0)}%`);
    expect(row.value).not.toContain('peak');
    expect(row.value).not.toContain('@');
    expect(row.tone).toBe('bad');
  });

  it('SACRED PIN: with no peakByNode the section is byte-identical to today (steady ρ, no peak/@ text)', () => {
    const load = loadOf();
    for (const r of load.rows) { expect(r.value).not.toContain('peak'); expect(r.value).not.toContain('@'); }
    expect(load).toEqual(summarySections({ ...base }).find((x) => x.title === 'Load per component'));
  });
});

// RETRY OUTCOME rows (doc: retry-feedback §3). Past saturation retries LOWER goodput; the summary must
// show that honestly WHEN there is a retry story — and show NOTHING when there is none (ui-no-absent-feature-filler).
describe('summarySections — retry outcome rows', () => {
  const st = evalState(buildDesign());
  const tailOf = (sim: import('./summary').SimTail | null) =>
    summarySections({
      instances: st.doc.instances, wires: st.doc.wires, value: st.value, flows: st.flows, queues: st.queues,
      saturated: st.saturated, totalCost: st.totalCost, costBreak: st.costBreak,
      verdicts: st.verds, evalOk: st.ev.ok, evalErrorCount: 0, sim, labelOf: st.labelOf, typeOf: st.typeOf,
    }).find((x) => x.title === 'Response time · end-to-end')!;

  it('ADDS Goodput / Failed / Amplification rows when the sim carries a retry story (measured retry traffic)', () => {
    // A saturated retry storm: 8 succeed, 4 fail after retries, attempts ×1.6 the arrivals.
    const tail = tailOf({ p50: 40, p95: 120, p99: 250, goodputRps: 8, errorRate: 4, amplification: 1.6, retryPolicy: true });
    const labels = tail.rows.map((r) => r.label);
    expect(labels).toEqual(['p50', 'p95', 'p99 · tail', 'Goodput (succeeded)', 'Failed after retries', 'Retry amplification']);
    expect(tail.rows.find((r) => r.label === 'Goodput (succeeded)')?.value).toBe('8 req/s');
    // Failures > 0 read as a VIOLATION (bad tone); heavy amplification (>1.2) reads as a WARNING.
    const failed = tail.rows.find((r) => r.label === 'Failed after retries')!;
    expect(failed.value).toBe('4 req/s');
    expect(failed.tone).toBe('bad');
    const amp = tail.rows.find((r) => r.label === 'Retry amplification')!;
    expect(amp.value).toBe('×1.6');
    expect(amp.tone).toBe('warn');
  });

  it('shows the rows for a DECLARED policy even at ×1 amplification (a policy that has not fired yet)', () => {
    // A retry policy is set but the system is below saturation: goodput = offered, nothing failed, ×1.0. Still
    // reported (the architect declared retries), with NO alarming tones (nothing is wrong).
    const tail = tailOf({ p50: 40, p95: 120, p99: 250, goodputRps: 600, errorRate: 0, amplification: 1, retryPolicy: true });
    const failed = tail.rows.find((r) => r.label === 'Failed after retries')!;
    expect(failed.value).toBe('0 req/s');
    expect(failed.tone).toBeUndefined(); // 0 failures ⇒ no bad tone
    const amp = tail.rows.find((r) => r.label === 'Retry amplification')!;
    expect(amp.value).toBe('×1');
    expect(amp.tone).toBeUndefined(); // ×1 ⇒ no warning
  });

  it('ADDS NO retry rows when there is no story (no policy, ×1, 0 failures) — never advertise an absent feature', () => {
    const tail = tailOf({ p50: 40, p95: 120, p99: 250, goodputRps: 600, errorRate: 0, amplification: 1, retryPolicy: false });
    expect(tail.rows.map((r) => r.label)).toEqual(['p50', 'p95', 'p99 · tail']);
  });

  it('ADDS the rows when retry traffic is measured even if the policy flag is absent (amplification alone is a story)', () => {
    const tail = tailOf({ p50: 40, p95: 120, p99: 250, goodputRps: 500, errorRate: 2, amplification: 1.4 });
    expect(tail.rows.map((r) => r.label)).toContain('Goodput (succeeded)');
  });

  it('ADDS NO rows when the sim is a bare tail (no retry fields at all)', () => {
    const tail = tailOf({ p50: 40, p95: 120, p99: 250 });
    expect(tail.rows.map((r) => r.label)).toEqual(['p50', 'p95', 'p99 · tail']);
  });
});

// FLOW-SCOPED LAG rows (doc: latency-semantics-v2 §3): the presenter renders a "Propagation lag" section from the
// SCALAR lag verdicts the shell computes — a section that appears ONLY when a lag SLO is declared (no-filler), and
// reads the honest scalar verdict (a provable violation, or `unknown` pointing at the sim).
describe('summarySections — flow-scoped lag rows', () => {
  // A CDC pipeline: capture (originates) →ASYNC→ q (queue-mode buffer) →SYNC→ loader. lag(capture → loader) crosses
  // the async queue, so the queue wait is invisible to the scalar ⇒ an honest `unknown` live.
  function lagStudio(): Studio {
    const s = new Studio(registry, catalog);
    s.dispatch({ kind: 'addComponent', id: 'capture', type: 'compute.service' });
    s.dispatch({ kind: 'setConfig', node: 'capture', key: 'assumedRps', value: 100 });
    s.dispatch({ kind: 'setConfig', node: 'capture', key: 'latency', value: 20 });
    s.dispatch({ kind: 'addComponent', id: 'q', type: 'queue.sqs' });
    s.dispatch({ kind: 'setConfig', node: 'q', key: 'queueMode', value: 1 });
    s.dispatch({ kind: 'setConfig', node: 'q', key: 'drainRate', value: 120 });
    s.dispatch({ kind: 'addComponent', id: 'loader', type: 'compute.faas' });
    s.dispatch({ kind: 'connect', from: ['capture', 'out'], to: ['q', 'in'], semantics: 'async' });
    s.dispatch({ kind: 'connect', from: ['q', 'out'], to: ['loader', 'in'] });
    return s;
  }
  const base = (lag: ReturnType<typeof lagVerdicts>) => {
    const st = evalState(lagStudio());
    return summarySections({
      instances: st.doc.instances, wires: st.doc.wires, value: st.value, flows: st.flows, queues: st.queues,
      saturated: st.saturated, totalCost: st.totalCost, costBreak: st.costBreak,
      verdicts: st.verds, evalOk: st.ev.ok, evalErrorCount: 0, sim: null, lag, labelOf: st.labelOf, typeOf: st.typeOf,
    });
  };

  it('adds a "Propagation lag" section with the honest scalar verdict when a lag SLO is declared', () => {
    const st = evalState(lagStudio());
    const verdicts = lagVerdicts(st.graph, st.value, [{ source: 'capture', terminal: 'loader', maxMs: 2000 }], st.queues);
    const sections = base(verdicts);
    const lagSection = sections.find((x) => x.title === 'Propagation lag · flow-scoped');
    expect(lagSection).toBeDefined();
    expect(lagSection?.rows).toHaveLength(1);
    const row = lagSection!.rows[0]!;
    expect(row.label).toContain('→'); // a flow label (source → terminal), using the shell's labelOf
    expect(row.value).toContain('2,000 ms'); // the declared deadline (fmt adds the thousands separator)
    expect(row.value).toContain('simulation'); // scalar cannot see the queue wait ⇒ points at the sim
    expect(row.tone).toBeUndefined(); // `unknown` is informational, not a failure
  });

  it('shows NO lag section when none is declared (the no-filler rule)', () => {
    expect(base([]).some((x) => x.title === 'Propagation lag · flow-scoped')).toBe(false);
  });
});

describe('summarySections — whole-system promise rows (owner ruling: cost is for THE WHOLE SYSTEM)', () => {
  // A tiny priced design; the SYSTEM cost promise is judged by content's shared judge and rendered here as ONE
  // SYSTEM row with NO flow context — the identical composition both shells (web drawer / VS Code tree) render.
  function costStudio(): Studio {
    const s = new Studio(registry, catalog);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
    s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.service' });
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['svc', 'in'] });
    return s;
  }
  const withPromise = (maxUsd: number) => {
    const studio = costStudio();
    studio.dispatch({ kind: 'setSystemPromise', promise: { key: 'cost', band: { shape: 'minTargetMax', max: maxUsd } } });
    const st = evalState(studio);
    const verdicts = systemPromiseVerdicts(st.doc.instances, st.doc.wires, st.value, studio.project().systemPromises);
    const sections = summarySections({
      instances: st.doc.instances, wires: st.doc.wires, value: st.value, flows: st.flows, queues: st.queues,
      saturated: st.saturated, totalCost: st.totalCost, costBreak: st.costBreak,
      verdicts: st.verds, evalOk: st.ev.ok, evalErrorCount: 0, sim: null, systemPromises: verdicts, labelOf: st.labelOf, typeOf: st.typeOf,
    });
    return { sections, verdicts };
  };

  it('renders the whole-system row in the shared "Promises" section: scope stated INLINE per-row, the shared comparator grammar, the honest read-back, the verdict tone', () => {
    const ok = withPromise(1_000_000);
    const section = ok.sections.find((x) => x.title === PROMISES_TITLE); // ONE 'Promises' form (owner ruling) — scope is per-row, never in the header
    expect(section).toBeDefined();
    expect(section?.rows).toHaveLength(1);
    const row = section!.rows[0]!;
    expect(row.label).toContain('cost ≤'); // the shared bandComparator grammar — 'cost' (not branch cost) at system scope
    expect(row.label).toContain('whole system'); // the scope, stated INLINE on the row — never in the section header
    expect(row.value).toMatch(/^now \$/); // the judged whole-graph total
    expect(row.value).toContain('✓');
    expect(row.tone).toBe('ok');

    const bad = withPromise(0.01);
    const badRow = bad.sections.find((x) => x.title === PROMISES_TITLE)!.rows[0]!;
    expect(badRow.value).toContain('✗');
    expect(badRow.tone).toBe('bad');
    // The Design roll-up counts the global promise and its breach exactly like a node band's.
    const design = bad.sections.find((x) => x.title === 'Design')!;
    expect(design.rows.find((r) => r.label === 'Promises (SLO)')?.value).toBe('1');
    expect(design.rows.find((r) => r.label === 'Violations')?.tone).toBe('bad');
  });

  it('ALWAYS emits the shared Promises section (even with NONE declared) so "Add promise…" always has a home — with no fake rows', () => {
    // ONE FORM (owner ruling): the whole-system Promises section mirrors the node Inspector's Promises group, which
    // is the deliberate exception to no-filler — it is ALWAYS shown so the "+ Add promise…" affordance the shell
    // hangs on it is always discoverable. So the section is PRESENT even with no declared promise, but carries ZERO
    // rows (the no-filler discipline still holds for the ROWS — never a fabricated line).
    const studio = costStudio();
    const st = evalState(studio);
    const sections = summarySections({
      instances: st.doc.instances, wires: st.doc.wires, value: st.value, flows: st.flows, queues: st.queues,
      saturated: st.saturated, totalCost: st.totalCost, costBreak: st.costBreak,
      verdicts: st.verds, evalOk: st.ev.ok, evalErrorCount: 0, sim: null, labelOf: st.labelOf, typeOf: st.typeOf,
    });
    const promises = sections.find((x) => x.title === PROMISES_TITLE);
    expect(promises).toBeDefined();          // present even with no declared system promise
    expect(promises!.title).toBe(PROMISES_TITLE); // the SHARED constant the node Inspector's Promises group uses
    expect(promises!.rows).toEqual([]);      // …but NO rows — the empty home for "Add promise…", never a fake line
  });
});

describe('summarySections — end-to-end availability is a NODE band on the terminal (flowPromises consolidated away)', () => {
  // The consolidation: an end-to-end availability promise IS an `availability` band on the flow's TERMINAL node
  // (`pg`), judged against value(pg, availability) — the serial product over the whole path. It counts in the
  // Design roll-up like any node band, and a breach surfaces as a NODE verdict violation (via the shared
  // realAwareVerdicts). No separate path container / Promises section (which is now system-scoped only).
  function terminalBandStudio(min: number): Studio {
    const s = new Studio(registry, catalog);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
    s.dispatch({ kind: 'addComponent', id: 'pg', type: 'db.postgres' });
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['pg', 'in'] });
    s.dispatch({ kind: 'setSLO', node: 'pg', key: keys.availability, band: { shape: 'minTargetMax', min } });
    return s;
  }

  it('counts a terminal availability band in the Design roll-up; a breach reads a NODE violation', () => {
    const studio = terminalBandStudio(0.9999999); // above any serial cumulative with a real DB on the path ⇒ violation
    const st = evalState(studio);
    const sections = summarySections({
      instances: st.doc.instances, wires: st.doc.wires, value: st.value, flows: st.flows, queues: st.queues,
      saturated: st.saturated, totalCost: st.totalCost, costBreak: st.costBreak,
      verdicts: st.verds, evalOk: st.ev.ok, evalErrorCount: 0, sim: null, labelOf: st.labelOf, typeOf: st.typeOf,
    });
    const design = sections.find((x) => x.title === 'Design')!;
    expect(design.rows.find((r) => r.label === 'Promises (SLO)')?.value).toBe('1');
    expect(design.rows.find((r) => r.label === 'Violations')?.tone).toBe('bad');
    // The Promises section is SYSTEM-scoped: a node availability band produces NO whole-system promise ROW. The
    // section itself is ALWAYS present (the always-on "Add promise…" home), but stays EMPTY here — no fake row.
    const promises = sections.find((x) => x.title === PROMISES_TITLE);
    expect(promises).toBeDefined();
    expect(promises!.rows).toEqual([]);
  });
});

describe('nodeDetail — the shared Inspector model', () => {
  const st = evalState(buildDesign());
  const inst = st.doc.instances.find((i) => i.id === 'compute')!;
  const man = catalog[inst.type];
  const candidates = buildCandidates(catalog);
  const s = buildDesign(); // a fresh studio for suggestFor (same design)
  const suggestions = suggestFor(s, catalog, candidates, 'compute');
  const detail = nodeDetail({ sel: 'compute', instance: inst, manifest: man, verdicts: st.verds, suggestions, labelOf: st.labelOf });

  it('lists the manifest config knobs with keyInfo labels + units and the instance override value', () => {
    const conc = detail.knobs.find((k) => k.key === 'concurrency');
    expect(conc).toBeDefined();
    expect(conc!.label).toBe('Concurrency'); // the shared keyInfo label
    expect(conc!.value).toBe(30); // the instance override, not the manifest default
    const perReq = detail.knobs.find((k) => k.key === 'perRequestDuration');
    expect(perReq?.unit).toBe('ms');
  });

  it('reports the selected node id, friendly label and type', () => {
    expect(detail.node).toBe('compute');
    expect(detail.typeId).toBe('compute.faas');
    expect(detail.label.length).toBeGreaterThan(0);
  });

  it('HIDES the assumedRps knob (owner: hidden from every human-facing surface) — the manifest carries it (withOrigin), the model drops it', () => {
    // `allManifests` folds a universal `assumedRps` config onto every manifest, so the raw manifest DOES declare it…
    expect((man!.config ?? []).some((c) => String(c.key) === String(keys.assumedRps))).toBe(true);
    // …yet the shared Inspector model renders no such knob (both shells read this list), while ordinary knobs remain.
    expect(detail.knobs.some((k) => k.key === String(keys.assumedRps))).toBe(false);
    expect(detail.knobs.some((k) => k.key === 'concurrency')).toBe(true);
  });

  it('returns the empty model (node "") when nothing is selected', () => {
    const empty = nodeDetail({ sel: null, instance: undefined, manifest: undefined, verdicts: st.verds, suggestions: [], labelOf: st.labelOf });
    expect(empty).toEqual({ node: '', label: '', typeId: '', knobs: [], verdicts: [], suggestions: [] });
  });

  it('formats a node verdict row as "<value> <unit> · <status>" with a tone', () => {
    const dbInst = st.doc.instances.find((i) => i.id === 'db')!;
    const dbDetail = nodeDetail({ sel: 'db', instance: dbInst, manifest: catalog[dbInst.type], verdicts: st.verds, suggestions: [], labelOf: st.labelOf });
    const avRow = dbDetail.verdicts.find((r) => r.value.includes('violation'));
    expect(avRow).toBeDefined();
    expect(avRow!.tone).toBe('bad');
    expect(avRow!.value).toMatch(/·\s(ok|warning|violation|unknown)$/);
  });

  // WORST-CASE LOAD (owner ruling: a peak is just traffic in a given environment). nodeDetail no longer adds a
  // separate peak "Load" row: a node saturated at its declared peak carries an ORDINARY saturation violation in the
  // shared verdict list (realAwareVerdicts, fed the sweep's per-node peak), rendered as a verdict row like any other.
  it('never adds a separate peak "Load" row — the worst-case saturation rides the shared verdict list, no peak/@ text', () => {
    const d = nodeDetail({ sel: 'compute', instance: inst, manifest: man, verdicts: st.verds, suggestions, labelOf: st.labelOf });
    expect(d.verdicts.some((r) => r.label === 'Load')).toBe(false);
    for (const r of d.verdicts) { expect(r.value).not.toContain('peak'); expect(r.value).not.toContain('at peak'); expect(r.value).not.toContain('@'); }
    expect(d.verdicts).toEqual(detail.verdicts); // byte-identical to the baseline (no peak input exists any more)
  });
});

describe('tidyLayout — the shared auto-layout geometry', () => {
  const instances = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const wires = [
    { from: ['a', 'out'] as [string, string], to: ['b', 'in'] as [string, string] },
    { from: ['b', 'out'] as [string, string], to: ['c', 'in'] as [string, string] },
    { from: ['c', 'out'] as [string, string], to: ['d', 'in'] as [string, string] },
  ];

  it('aligns nodes into columns by longest-path depth (a constant x pitch between tiers)', () => {
    const { pos } = tidyLayout(instances, wires, []);
    const xs = [pos['a']!.x, pos['b']!.x, pos['c']!.x, pos['d']!.x];
    const pitch = xs[1]! - xs[0]!;
    expect(pitch).toBeGreaterThan(0);
    expect(xs[2]! - xs[1]!).toBe(pitch); // every column is an equal step apart
    expect(xs[3]! - xs[2]!).toBe(pitch);
  });

  it('never overlaps two nodes stacked in the SAME column, given their measured sizes', () => {
    // b and c are both fed only by their predecessor and feed one successor → put them in one column via a fork.
    const forky = [{ id: 'src' }, { id: 'x' }, { id: 'y' }];
    const forkWires = [
      { from: ['src', 'out'] as [string, string], to: ['x', 'in'] as [string, string] },
      { from: ['src', 'out'] as [string, string], to: ['y', 'in'] as [string, string] },
    ];
    const sizes = { src: { w: 160, h: 200 }, x: { w: 160, h: 200 }, y: { w: 160, h: 200 } };
    const { pos } = tidyLayout(forky, forkWires, [], sizes);
    // x and y share a column (same x); their vertical spans must not overlap.
    expect(pos['x']!.x).toBe(pos['y']!.x);
    const [top, bot] = pos['x']!.y <= pos['y']!.y ? [pos['x']!, pos['y']!] : [pos['y']!, pos['x']!];
    expect(bot.y).toBeGreaterThanOrEqual(top.y + 200); // no vertical overlap (height 200)
  });
});

describe('matchingPort — the shared auto-wire port picker', () => {
  it('resolves the correct IN target port for a downstream (OUT) suggestion', () => {
    const s = new Studio(registry, catalog);
    const candidates = buildCandidates(catalog);
    s.dispatch({ kind: 'addComponent', id: 'gw', type: 'gateway.api' });
    const out = suggestFor(s, catalog, candidates, 'gw').find((x) => x.port === 'out');
    expect(out).toBeDefined();
    expect(matchingPort(catalog, 'compute.faas', out!)).toBe('in');
  });

  it('yields undefined when no port fits in either direction (protocol-incompatible)', () => {
    const s = new Studio(registry, catalog);
    const candidates = buildCandidates(catalog);
    s.dispatch({ kind: 'addComponent', id: 'db', type: 'db.postgres' });
    const out = suggestFor(s, catalog, candidates, 'db').find((x) => x.port === 'out');
    expect(out).toBeDefined();
    expect(matchingPort(catalog, 'queue.rabbitmq', out!)).toBeUndefined();
  });
});

describe('summarySections — a saturated design surfaces the saturation via ρ (never a faked latency)', () => {
  it('shows NO flow latency row (measured-or-nothing) but a saturated ρ row with a bad tone', () => {
    const s = new Studio(registry, catalog);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.source' });
    s.dispatch({ kind: 'setConfig', node: 'client', key: 'throughput', value: 5000 });
    s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.faas' });
    s.dispatch({ kind: 'setConfig', node: 'svc', key: 'concurrency', value: 50 }); // cap 1000 rps ≪ 5000 offered ⇒ ρ=5
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['svc', 'in'] });
    const st = evalState(s);
    const q: NodeQueue | undefined = st.queues.get('svc');
    expect(q?.rho).toBeGreaterThanOrEqual(1); // genuinely saturated
    const sections = summarySections({
      instances: st.doc.instances, wires: st.doc.wires, value: st.value, flows: st.flows, queues: st.queues,
      saturated: st.saturated, totalCost: st.totalCost, costBreak: st.costBreak,
      verdicts: st.verds, evalOk: st.ev.ok, evalErrorCount: 0, sim: null, labelOf: st.labelOf, typeOf: st.typeOf,
    });
    const flow = sections.find((x) => x.title.startsWith('System · '))!;
    // SINGLE-TRUTH LATENCY: with no measurement the flow shows no latency at all — the saturation is loud in the ρ
    // section instead (the analytic ∞ is never rendered as a latency value).
    expect(flow.rows.some((r) => r.label.startsWith('Latency'))).toBe(false);
    const load = sections.find((x) => x.title === 'Load per component')!;
    const svcRow = load.rows.find((r) => r.label === st.labelOf('svc', st.typeOf('svc')))!;
    expect(svcRow.value).toContain('saturated');
    expect(svcRow.tone).toBe('bad');
  });
});

// EMPTY STATE — the design has no traffic origin at all (the universal-origin design correction): neither a client
// NOR a node with assumedRps > 0. The status line and the tail section must SAY WHY, not sit silently blank; and
// once ANY node originates (a client OR assumedRps on a mid-chain node), the reason must disappear.
describe('empty state — no traffic origin says why', () => {
  // Two databases wired but nothing driving them (no client, no assumedRps): a valid but un-driven design.
  function buildNoOrigin(): Studio {
    const s = new Studio(registry, catalog);
    s.dispatch({ kind: 'addComponent', id: 'src', type: 'db.postgres' });
    s.dispatch({ kind: 'addComponent', id: 'dst', type: 'db.postgres' });
    s.dispatch({ kind: 'connect', from: ['src', 'out'], to: ['dst', 'in'] });
    return s;
  }

  it('hasTrafficOrigin is false with no client and no assumedRps', () => {
    const st = evalState(buildNoOrigin());
    expect(hasTrafficOrigin(st.doc.instances, st.doc.wires, st.value)).toBe(false);
  });

  it('the status line carries the honest NO_ORIGIN_REASON', () => {
    const st = evalState(buildNoOrigin());
    const hasOrigin = hasTrafficOrigin(st.doc.instances, st.doc.wires, st.value);
    const status = statusLine(undefined, undefined, st.totalCost, st.verds, st.ev.ok, 0, hasOrigin);
    expect(status.reason).toBe(NO_ORIGIN_REASON);
  });

  it('the tail section states the reason instead of the client-only hint', () => {
    const st = evalState(buildNoOrigin());
    const sections = summarySections({
      instances: st.doc.instances, wires: st.doc.wires, value: st.value, flows: st.flows, queues: st.queues,
      saturated: st.saturated, totalCost: st.totalCost, costBreak: st.costBreak,
      verdicts: st.verds, evalOk: st.ev.ok, evalErrorCount: 0, sim: null, labelOf: st.labelOf, typeOf: st.typeOf,
    });
    const tail = sections.find((x) => x.title === 'Response time · end-to-end')!;
    expect(tail.rows).toEqual([{ label: 'status', value: NO_ORIGIN_REASON }]);
  });

  it('once a node ORIGINATES traffic (assumedRps > 0), the reason is gone', () => {
    const s = buildNoOrigin();
    s.dispatch({ kind: 'setConfig', node: 'src', key: 'assumedRps', value: 300 }); // src now originates the migration
    const st = evalState(s);
    const hasOrigin = hasTrafficOrigin(st.doc.instances, st.doc.wires, st.value);
    expect(hasOrigin).toBe(true);
    const status = statusLine(st.value('dst', keys.throughput), undefined, st.totalCost, st.verds, st.ev.ok, 0, hasOrigin);
    expect('reason' in status).toBe(false);
    const sections = summarySections({
      instances: st.doc.instances, wires: st.doc.wires, value: st.value, flows: st.flows, queues: st.queues,
      saturated: st.saturated, totalCost: st.totalCost, costBreak: st.costBreak,
      verdicts: st.verds, evalOk: st.ev.ok, evalErrorCount: 0, sim: null, labelOf: st.labelOf, typeOf: st.typeOf,
    });
    const tail = sections.find((x) => x.title === 'Response time · end-to-end')!;
    expect(tail.rows).toEqual([{ label: 'status', value: 'set a client throughput to simulate the tail' }]);
  });
});

// simVerdicts — the SHARED DES-fed verdict composer both shells use. It merges the tail (p99) and
// retry-goodput verdicts the scalar pass cannot see. Here we prove the goodput floor flow: `unknown` with no sim,
// a real verdict once the sim outcome lands (and that it REPLACES the stale `unknown`, not doubles it).
describe('simVerdicts — composes the DES-fed (tail + goodput) verdicts into the base list', () => {
  // A client with a retry policy → an under-provisioned service carrying a goodput FLOOR SLO of 500 req/s (the svc
  // is the terminal — goodput is a whole-system outcome, so the band sits on any node; svc keeps ports simple).
  function buildRetryDesign(): Studio {
    const s = new Studio(registry, allManifests);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.source' });
    s.dispatch({ kind: 'setConfig', node: 'client', key: 'throughput', value: 2000 });
    s.dispatch({ kind: 'setConfig', node: 'client', key: 'timeoutMs', value: 200 });
    s.dispatch({ kind: 'setConfig', node: 'client', key: 'retryCount', value: 2 });
    s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.service' });
    s.dispatch({ kind: 'setConfig', node: 'svc', key: 'concurrency', value: 20 }); // under-provisioned ⇒ saturates
    s.dispatch({ kind: 'setSLO', node: 'svc', key: keys.goodputRps, band: { shape: 'minTargetMax', min: 500 } });
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['svc', 'in'] });
    return s;
  }

  const st = evalState(buildRetryDesign());
  const base = st.verds;
  const goodputOf = (verds: readonly import('@sda/engine-core').Verdict[]) =>
    verds.find((v) => String(v.scope) === 'svc' && String(v.key) === String(keys.goodputRps));

  it('leaves the goodput SLO `unknown` when no sim has run (never a guess before the DES answers)', () => {
    const out = simVerdicts(base, st.graph, registry, null);
    expect(goodputOf(out)?.status).toBe('unknown');
  });

  it('turns the goodput SLO into a real VIOLATION from a sim outcome below the floor, replacing the `unknown`', () => {
    // The measured goodput (120 req/s) is far under the 500 floor ⇒ a violation with the retry-aware remediation.
    const out = simVerdicts(base, st.graph, registry, { p50: 40, p95: 120, p99: 250, goodputRps: 120, errorRate: 30, amplification: 1.8, retryPolicy: true });
    const gp = goodputOf(out);
    expect(gp?.status).toBe('violation');
    expect(gp?.computed.value).toBe(120);
    // Exactly ONE goodput verdict for svc — the DES-fed one REPLACED the scalar `unknown` (no stale duplicate).
    expect(out.filter((v) => String(v.scope) === 'svc' && String(v.key) === String(keys.goodputRps))).toHaveLength(1);
  });

  it('flows the goodput violation into problemRows (both shells pick it up automatically)', () => {
    const out = simVerdicts(base, st.graph, registry, { p50: 40, p95: 120, p99: 250, goodputRps: 120, errorRate: 30, amplification: 1.8, retryPolicy: true });
    const rows = problemRows(out, st.ev.ok, []);
    const gp = rows.find((r) => r.node === 'svc' && r.key === String(keys.goodputRps));
    expect(gp?.severity).toBe('violation');
    expect(gp?.fix?.length ?? 0).toBeGreaterThan(0); // the retry-aware remediation text
  });
});

// ── LATENCY SEMANTICS v2 · R3 surfaces (doc: latency-semantics-v2 §1, §4) ────────────────────────────────────────
// The shared per-node RESPONSE surfaces both shells render: the canvas chip, the System rows, the Inspector row, and
// the sink-gate fix (a NON-terminal node's tailLatency judged against its OWN response tail, matching MCP). Synthetic
// SimTails (hand-crafted nodeResponse) keep these pure + deterministic; the REAL DES pipeline end-to-end is proven in
// app/web's latency-chips e2e.
describe('R3 surfaces — per-node response chip / rows / sink-gate fix', () => {
  // client → gw → compute → db. `compute` is NON-terminal (it feeds db), so a tailLatency band on it is exactly the
  // case R2's sink gate wrongly left `unknown` — v2 judges it against compute's OWN response tail.
  function buildTailDesign(): Studio {
    const s = new Studio(registry, catalog);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.source' });
    s.dispatch({ kind: 'setConfig', node: 'client', key: 'throughput', value: 1000 });
    s.dispatch({ kind: 'addComponent', id: 'gw', type: 'gateway.api' });
    s.dispatch({ kind: 'addComponent', id: 'compute', type: 'compute.faas' });
    s.dispatch({ kind: 'setSLO', node: 'compute', key: keys.tailLatency, band: { shape: 'percentiles', targets: new Map([['p99', 300]]) } });
    s.dispatch({ kind: 'setSLO', node: 'compute', key: keys.latency, band: { shape: 'minTargetMax', max: 250 } });
    s.dispatch({ kind: 'addComponent', id: 'db', type: 'db.sql' });
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['gw', 'in'] });
    s.dispatch({ kind: 'connect', from: ['gw', 'out'], to: ['compute', 'in'] });
    s.dispatch({ kind: 'connect', from: ['compute', 'out'], to: ['db', 'in'] });
    return s;
  }
  const st = evalState(buildTailDesign());
  const nr = (id: string, mean: number, p99: number): NodeResponseView => ({ id, mean, p50: mean, p95: p99, p99, samples: 4096 });
  const simWith = (nodeResponse: NodeResponseView[]): SimTail => ({ p50: 40, p95: 120, p99: 250, nodeResponse });
  const tailOf = (sim: SimTail) => simVerdicts(st.verds, st.graph, registry, sim).find((v) => String(v.scope) === 'compute' && String(v.key) === String(keys.tailLatency));

  it('simVerdicts judges a NON-TERMINAL node tailLatency against its OWN response tail (the sink-gate fix)', () => {
    const tail = tailOf(simWith([nr('compute', 220, 500)])); // compute's p99 500 ms > the 300 ms target
    expect(tail?.status).toBe('violation');
    expect(tail?.computed.value).toBe(500);
  });

  it('the same non-terminal tail reads OK when its own response tail is within the target', () => {
    expect(tailOf(simWith([nr('compute', 80, 120)]))?.status).toBe('ok'); // p99 120 ms < 300
  });

  it('a node with no per-node reservoir stays honest `unknown` (never a fabricated tail)', () => {
    expect(tailOf(simWith([]))?.status).toBe('unknown'); // compute not in the run
  });

  // SINGLE-TRUTH LATENCY (owner decree, measured-or-nothing). The canvas latency is a MEASURED p50→p99 range bar —
  // there is no selection-gated chip any more (killed entirely), so none of these resolve against a `selected` node.
  it('latencyRangeBar: the canvas latency BAR is the MEASURED p50→p99 range, verdict-toned (single truth, no analytic)', () => {
    const sim = simWith([nr('compute', 120, 310), nr('db', 20, 30)]);
    const verds = simVerdicts(st.verds, st.graph, registry, sim);
    const measured = measuredResponseOf(sim, 'compute');
    expect(measured).not.toBeNull();
    const bar = latencyRangeBar(measured!, latencyTone(verds, 'compute'));
    expect(bar.typical).toBe('p50 120 ms'); // nr() sets p50 = mean = 120
    expect(bar.tail).toBe('p99 310 ms');
    expect(bar.p50Digits).toBe('120');
    expect(bar.p99Digits).toBe('310');
    expect(bar.tone).toBe('bad'); // p99 310 > the 300 ms tail SLO ⇒ the bar reads red (what is judged = what is shown)
  });

  it('measuredResponseOf: MEASURED-OR-NOTHING — the response when finite, null before any run and for a NaN reservoir', () => {
    expect(measuredResponseOf(null, 'compute')).toBeNull(); // no run yet ⇒ nothing (never an analytic fallback)
    expect(measuredResponseOf(simWith([]), 'compute')).toBeNull(); // not a station in this run
    const naN = simWith([{ id: 'compute', mean: NaN, p50: NaN, p95: NaN, p99: NaN, samples: 0 }]);
    expect(measuredResponseOf(naN, 'compute')).toBeNull(); // never reached / all dropped ⇒ nothing
    expect(measuredResponseOf(simWith([nr('compute', 80, 120)]), 'compute')?.mean).toBe(80);
  });

  it('latencyTone: red exactly when the node\'s own latency/tailLatency SLO is violated, neutral without one', () => {
    const sim = simWith([nr('compute', 120, 310)]);
    const verds = simVerdicts(st.verds, st.graph, registry, sim);
    expect(latencyTone(verds, 'compute')).toBe('bad'); // p99 310 > 300
    expect(latencyTone(verds, 'db')).toBeUndefined(); // db bears no latency SLO ⇒ neutral (no tone)
  });

  it('responseRows + summarySections: a "Response time · per component" section for the requirement-bearing node', () => {
    const sim = simWith([nr('compute', 120, 310), nr('db', 20, 30)]);
    const rows = responseRows(sim, st.doc.instances, st.verds, st.labelOf, st.typeOf);
    const label = st.labelOf('compute', st.typeOf('compute'));
    expect(rows.map((r) => r.label)).toContain(label);
    expect(rows.find((r) => r.label === label)?.value).toContain('p99 310');
    const sections = summarySections({
      instances: st.doc.instances, wires: st.doc.wires, value: st.value, flows: st.flows, queues: st.queues,
      saturated: st.saturated, totalCost: st.totalCost, costBreak: st.costBreak,
      verdicts: st.verds, evalOk: st.ev.ok, evalErrorCount: 0, sim, labelOf: st.labelOf, typeOf: st.typeOf,
    });
    expect(sections.some((s) => s.title === 'Response time · per component')).toBe(true);
    // no-filler: with no sim the section is absent
    const noSim = summarySections({
      instances: st.doc.instances, wires: st.doc.wires, value: st.value, flows: st.flows, queues: st.queues,
      saturated: st.saturated, totalCost: st.totalCost, costBreak: st.costBreak,
      verdicts: st.verds, evalOk: st.ev.ok, evalErrorCount: 0, sim: null, labelOf: st.labelOf, typeOf: st.typeOf,
    });
    expect(noSim.some((s) => s.title === 'Response time · per component')).toBe(false);
  });

  it('formatResponseTail: the three percentiles a reviewer judges by (mean lives on the Latency row, samples are engine detail), honest no-data for an empty reservoir', () => {
    expect(formatResponseTail(nr('compute', 120, 310))).toBe('p50 120 ms · p95 310 ms · p99 310 ms');
    expect(formatResponseTail({ id: 'compute', mean: NaN, p50: NaN, p95: NaN, p99: NaN, samples: 0 })).toContain('no data');
  });

  it('nodeDetail: the selected node gets a full MEASURED Response tail row when a sim ran (absent otherwise)', () => {
    const inst = st.doc.instances.find((i) => i.id === 'compute')!;
    const detail = nodeDetail({ sel: 'compute', instance: inst, manifest: catalog[inst.type], verdicts: st.verds, suggestions: [], labelOf: st.labelOf, response: nr('compute', 120, 310) });
    expect(detail.response?.label).toBe('Response tail (simulated)');
    expect(detail.response?.value).toContain('p99 310');
    const noResp = nodeDetail({ sel: 'compute', instance: inst, manifest: catalog[inst.type], verdicts: st.verds, suggestions: [], labelOf: st.labelOf });
    expect(noResp.response).toBeUndefined();
  });
});

// THE ONE-LINE SYSTEM VERDICT (owner-approved story) — the ONE computation both shells render (web pill + VS Code
// System-tree top item), so the headline can never disagree between the two surfaces.
describe('systemVerdict — the shared one-line answer', () => {
  it('reads "Design holds" with the three headline numbers when nothing is violated or overloaded', () => {
    const v = systemVerdict({ violations: 0, saturated: 0, capacityRps: 6260, p99Ms: 257, costUsdMonth: 1021 });
    expect(v.status).toBe('ok');
    expect(v.headline).toBe('Design holds — every promise met, no tier overloaded');
    expect(v.numbers).toBe('handles up to 6,260 req/s · p99 257 ms · $1,021/mo');
  });

  it('names unmet promises first (singular/plural), pointing at Problems', () => {
    expect(systemVerdict({ violations: 1, saturated: 3 }).headline).toBe('1 promise not met — open Problems');
    expect(systemVerdict({ violations: 2, saturated: 0 }).headline).toBe('2 promises not met — open Problems');
    expect(systemVerdict({ violations: 2, saturated: 0 }).status).toBe('problem');
  });

  it('falls back to overloaded tiers when there is no SLO violation but a tier saturates', () => {
    expect(systemVerdict({ violations: 0, saturated: 1 }).headline).toBe('1 tier overloaded — open Problems');
    expect(systemVerdict({ violations: 0, saturated: 2 }).headline).toBe('2 tiers overloaded — open Problems');
  });

  it('omits each headline number that is absent (no envelope / no sim / no cost) and drops a zero cost', () => {
    expect(systemVerdict({ violations: 0, saturated: 0 }).numbers).toBe('');
    expect(systemVerdict({ violations: 0, saturated: 0, p99Ms: 40 }).numbers).toBe('p99 40 ms');
    expect(systemVerdict({ violations: 0, saturated: 0, costUsdMonth: 0 }).numbers).toBe('');
  });
});
