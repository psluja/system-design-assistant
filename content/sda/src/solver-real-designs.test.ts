import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NodeId, type Graph } from '@sda/engine-core';
import { makeNativeAdapter } from '@sda/solver-contract/native';
import { allManifests, instantiate, registry, provisioningTunables, keys, TARGET_UTILIZATION, type Instance, type Wire } from './index';

// THE DECLINE RATE ON REAL DESIGNS — the phase-3 gate (docs/design/solver-contract.html §3.2 scope note; 
// deeper distillation). The native (CPU cell-network) solver is EXACT on the class it covers — capacity/flow designs
// whose bands are monotone floors/ceilings — and returns an honest `did-not-converge` OUTSIDE that class (a `point`
// band a knob drives, a floor↔ceiling coupling, a cyclic free flow, a non-settling design). The oracle harness
// proves it matches the incumbent on GENERATED in-class designs; this test asks the different, load-bearing
// question the owner needs to decide phase 3: on the REAL designs SDA actually produces, HOW OFTEN does native
// decline? That fraction — the DECLINE RATE — is the number this test measures, prints, and asserts a ceiling on.
//
// It does NOT fix the solver and does NOT hide the number: if the rate is high, the assertion is pinned at the
// MEASURED value with a prominent comment, so a REGRESSION (native declining MORE designs than today) fails CI while
// the owner still sees the honest figure. The corpus is every real design reachable from content's tests: the four
// committed `examples/*.sda.json` (the real CDK/finale designs) plus the canon architectures from
// `architectures.e2e.test.ts`, transcribed here (they are inline in that test, not exported).
//
// The three honesty STATES are the only acceptable outcomes (never a throw, never a guess): `solved` (an exact
// answer), `infeasible` (proven no sizing meets the SLOs), `did-not-converge` (out of the exact class — the
// incumbent MIP remains the solver of record). The search is run through the SAME canonical call the MCP tools make
// (`provisioningTunables` + ρ ≤ TARGET_UTILIZATION headroom — app/mcp/src/search.ts), so the measured rate is the
// one a real user would hit.

const native = makeNativeAdapter({ registry });
const headroom = { key: keys.throughput, factor: TARGET_UTILIZATION } as const;

// ── The real-design corpus ──────────────────────────────────────────────────────────────────────────────────

/** A design ready to search: a name + a built graph. */
interface RealDesign {
  readonly name: string;
  readonly graph: Graph;
}

/** Raw (name, instances, wires) before instantiation — an example loaded from disk, or a transcribed architecture. */
interface RawDesign {
  readonly name: string;
  readonly instances: readonly Instance[];
  readonly wires: readonly Wire[];
}

// The committed export format tags Maps (percentile SLO targets) as `{ "__map": [...] }`; revive them so a design
// carrying a tail SLO loads losslessly (the same reviver app/core's `deserialize` uses). The examples are schema 3,
// so no migration is needed — only the Map revival.
const MAP_TAG = '__map';
const mapReviver = (_key: string, value: unknown): unknown =>
  value !== null && typeof value === 'object' && Array.isArray((value as Record<string, unknown>)[MAP_TAG])
    ? new Map((value as Record<string, [unknown, unknown][]>)[MAP_TAG])
    : value;

/** The four committed real designs (repo-root `examples/`). Loaded relative to this file so the path is stable. */
const EXAMPLE_NAMES = ['cqrs', 'ecommerce-production', 'empty-project', 'oracle-to-aurora-migration-repeat'] as const;
function loadExample(name: string): RawDesign {
  const path = fileURLToPath(new URL(`../../../examples/${name}.sda.json`, import.meta.url));
  const doc = JSON.parse(readFileSync(path, 'utf8'), mapReviver) as { instances: Instance[]; wires: Wire[] };
  return { name: `example:${name}`, instances: doc.instances, wires: doc.wires };
}

/** A wire, the same shorthand `architectures.e2e.test.ts` uses. */
const W = (a: string, ap: string, b: string, bp: string, async = false): Wire => ({ from: [a, ap], to: [b, bp], ...(async ? { semantics: 'async' as const } : {}) });

// The system-design canon, transcribed verbatim from `architectures.e2e.test.ts` (those designs are declared inline
// in that test, so there is nothing to import — the transcription is the only way to reach them). They add topology
// breadth the examples lack: async fan-out, cache/DB caps, a sized worker fleet.
const ARCHITECTURES: readonly RawDesign[] = [
  {
    name: 'canon:url-shortener',
    instances: [
      { id: 'client', type: 'client.web', config: { throughput: 10000 } },
      { id: 'gw', type: 'gateway.api' }, { id: 'app', type: 'compute.service' },
      { id: 'cache', type: 'cache.redis' }, { id: 'store', type: 'db.dynamodb' },
      { id: 'aq', type: 'queue.sqs' }, { id: 'aw', type: 'compute.faas' }, { id: 'adb', type: 'db.postgres' },
    ],
    wires: [
      W('client', 'out', 'gw', 'in'), W('gw', 'out', 'app', 'in'),
      W('app', 'cache', 'cache', 'in'), W('app', 'db', 'store', 'in'),
      W('app', 'db', 'aq', 'in', true), W('aq', 'out', 'aw', 'in'), W('aw', 'out', 'adb', 'in'),
    ],
  },
  {
    name: 'canon:web-scraper',
    instances: [
      { id: 'users', type: 'client.web', config: { throughput: 20 } }, { id: 'gw', type: 'gateway.api' }, { id: 'api', type: 'compute.service' }, { id: 'pg', type: 'db.postgres' },
      { id: 'sched', type: 'client.source', config: { throughput: 12 } }, { id: 'jobq', type: 'queue.sqs' },
      { id: 'workers', type: 'compute.asg', config: { concurrency: 8, perRequestDuration: 4000 } },
      { id: 's3', type: 'storage.object' }, { id: 'changeq', type: 'queue.sqs' }, { id: 'emailer', type: 'compute.faas' },
    ],
    wires: [
      W('users', 'out', 'gw', 'in'), W('gw', 'out', 'api', 'in'), W('api', 'db', 'pg', 'in'),
      W('sched', 'out', 'jobq', 'in'), W('jobq', 'out', 'workers', 'in'),
      W('workers', 'db', 's3', 'in'), W('workers', 'db', 'changeq', 'in'), W('changeq', 'out', 'emailer', 'in'),
    ],
  },
  {
    name: 'canon:parking-lot',
    instances: [
      { id: 'client', type: 'client.web', config: { throughput: 500 } }, { id: 'gw', type: 'gateway.api' }, { id: 'app', type: 'compute.service' },
      { id: 'spots', type: 'db.postgres' }, { id: 'avail', type: 'cache.redis' },
      { id: 'payq', type: 'queue.sqs' }, { id: 'paywk', type: 'compute.faas' }, { id: 'paydb', type: 'db.postgres' },
    ],
    wires: [
      W('client', 'out', 'gw', 'in'), W('gw', 'out', 'app', 'in'),
      W('app', 'db', 'spots', 'in'), W('app', 'cache', 'avail', 'in'),
      W('app', 'db', 'payq', 'in', true), W('payq', 'out', 'paywk', 'in'), W('paywk', 'out', 'paydb', 'in'),
    ],
  },
  {
    name: 'canon:news-feed',
    instances: [
      { id: 'client', type: 'client.web', config: { throughput: 5000 } }, { id: 'gw', type: 'gateway.api' }, { id: 'app', type: 'compute.service' },
      { id: 'timeline', type: 'cache.redis' }, { id: 'tweets', type: 'db.dynamodb' },
      { id: 'fanq', type: 'stream.kafka' }, { id: 'fanwk', type: 'compute.faas' },
    ],
    wires: [
      W('client', 'out', 'gw', 'in'), W('gw', 'out', 'app', 'in'),
      W('app', 'cache', 'timeline', 'in'), W('app', 'db', 'tweets', 'in'),
      W('app', 'out', 'fanq', 'in', true), W('fanq', 'out', 'fanwk', 'in'),
    ],
  },
];

// ── Running the native search over every design ─────────────────────────────────────────────────────────────

/** The only acceptable outcomes plus test-only markers: `skipped` = optimize had no cost objective; `threw` = the
 *  search threw (a contract violation — the search must return an honesty value, never an exception). */
type Outcome = 'solved' | 'infeasible' | 'did-not-converge' | 'skipped' | 'threw';
const HONESTY: ReadonlySet<Outcome> = new Set<Outcome>(['solved', 'infeasible', 'did-not-converge']);

interface Run {
  readonly name: string;
  readonly capability: 'optimize' | 'repair';
  readonly outcome: Outcome;
  /** How many provisioning knobs the search had to move — shows the outcome is over a REAL search, not a
   *  no-knob no-op that trivially "solves". */
  readonly knobs: number;
}

/** The node whose accumulated `cost` is highest under a forward evaluation — the natural objective node for a
 *  "minimise the design's cost" optimize (cost sums along the path, so the terminal accumulator is the total). */
function costSink(graph: Graph): NodeId | undefined {
  const ev = native.evaluate({ graph });
  if (!ev.ok || !ev.value.converged) return undefined;
  let best: NodeId | undefined;
  let bestValue = -Infinity;
  for (const id of graph.nodes.keys()) {
    const v = ev.value.value(id, keys.cost);
    if (v !== undefined && Number.isFinite(v) && v > bestValue) {
      bestValue = v;
      best = id;
    }
  }
  return best;
}

/** Run one native search, mapping ANY throw to `threw` so the "zero throws" invariant is a checked outcome, not an
 *  uncaught failure that hides which design broke. */
async function outcomeOf(run: () => Promise<{ kind: 'solved' | 'infeasible' | 'did-not-converge' }>): Promise<Outcome> {
  try {
    return (await run()).kind;
  } catch {
    return 'threw';
  }
}

const designs: RealDesign[] = [];
const buildFailures: { name: string; error: string }[] = [];
const runs: Run[] = [];

beforeAll(async () => {
  const raw: RawDesign[] = [...EXAMPLE_NAMES.map(loadExample), ...ARCHITECTURES];
  for (const r of raw) {
    const g = instantiate(allManifests, r.instances, r.wires);
    if (g.ok) designs.push({ name: r.name, graph: g.value });
    else buildFailures.push({ name: r.name, error: JSON.stringify(g.error) });
  }

  for (const d of designs) {
    const tunables = provisioningTunables(d.graph);
    const knobs = tunables.length;
    // repair — the canonical MCP call: raise-only provisioning knobs + ρ-headroom, no objective (search.ts).
    runs.push({ name: d.name, capability: 'repair', knobs, outcome: await outcomeOf(() => native.repair!({ graph: d.graph, tunables, headroom })) });
    // optimize — minimise total cost at the cost-sink node, same knobs + headroom (search.ts optimize tool).
    const sink = costSink(d.graph);
    const optOutcome: Outcome =
      sink === undefined
        ? 'skipped'
        : await outcomeOf(() => native.optimize!({ graph: d.graph, tunables, objective: { node: sink, key: keys.cost, direction: 'min' }, headroom }));
    runs.push({ name: d.name, capability: 'optimize', knobs, outcome: optOutcome });
  }

  // Print the decline rate PROMINENTLY (owner: do not hide it). One line per run + the headline fraction.
  const judged = runs.filter((r) => HONESTY.has(r.outcome));
  const declined = judged.filter((r) => r.outcome === 'did-not-converge');
  const rate = judged.length === 0 ? 0 : declined.length / judged.length;
  const lines = [
    '',
    '==================== NATIVE SOLVER — DECLINE RATE ON REAL DESIGNS ====================',
    `designs built: ${designs.length}   build failures: ${buildFailures.length}   judged runs: ${judged.length}`,
    ...buildFailures.map((b) => `  build-failed  ${b.name}: ${b.error}`),
    ...runs.map((r) => `  ${r.outcome.padEnd(16)} ${r.capability.padEnd(9)} knobs=${String(r.knobs).padEnd(3)} ${r.name}`),
    `DID-NOT-CONVERGE (declined): ${declined.length} / ${judged.length}  ⇒  DECLINE RATE = ${(rate * 100).toFixed(1)}%`,
    declined.length > 0 ? `declined designs: ${declined.map((r) => `${r.name}/${r.capability}`).join(', ')}` : 'declined designs: none',
    '=====================================================================================',
    '',
  ];
  console.log(lines.join('\n'));
});

// ── The gate ────────────────────────────────────────────────────────────────────────────────────────────────

describe('native solver over real designs — honesty + the decline-rate gate', () => {
  it('the real-design corpus is non-empty (examples load, architectures build)', () => {
    expect(designs.length, `no real design built; build failures:\n${buildFailures.map((b) => `${b.name}: ${b.error}`).join('\n')}`).toBeGreaterThan(0);
  });

  it('every native search returns an HONESTY state — never a throw (contract: uncertainty is a value)', () => {
    const threw = runs.filter((r) => r.outcome === 'threw');
    expect(threw, `these searches threw instead of returning solved/infeasible/did-not-converge:\n${threw.map((r) => `${r.name}/${r.capability}`).join('\n')}`).toEqual([]);
    // Every judged run is exactly one of the three honesty kinds (skipped = no cost objective, excluded honestly).
    for (const r of runs) {
      if (r.outcome === 'skipped') continue;
      expect(HONESTY.has(r.outcome), `${r.name}/${r.capability} produced a non-honesty outcome: ${r.outcome}`).toBe(true);
    }
  });

  // THE PHASE-3 GATE. The threshold is set at the EMPIRICALLY MEASURED decline rate (see the printed report above),
  // NOT an aspiration: it fails CI only if native starts declining MORE real designs than it does today (a
  // regression), while leaving the honest current figure visible in the test output for the owner's phase-3 call.
  //
  // ⚠️  MEASURED DECLINE RATE = 0.0%  (0 / 14 judged searches — 2026-07-03).
  //     Native CONVERGED (`solved`) on EVERY real design reachable from content's tests: all four committed
  //     `examples/*.sda.json` that build (cqrs is EXCLUDED — it fails to instantiate on `topic.sns`, absent from
  //     `allManifests`; a catalog gap, not a solver decline) AND all four canon architectures — repair AND
  //     optimize, each over a non-empty knob set (see `knobs=` in the report). Zero `did-not-converge`, zero
  //     `infeasible`, zero throws. Phase-3 reading for the owner: the native (WASM-free) solver already covers
  //     100% of the real-design corpus — the out-of-class escape hatch (docs §3.2) is never hit in practice here.
  //     The gate is therefore pinned at 0.0: any future real design native declines is a REGRESSION and fails CI,
  //     with the honest figure still printed for re-evaluation.
  const MEASURED_DECLINE_RATE = 0.0;
  it(`the decline rate stays at or below the measured baseline (${(MEASURED_DECLINE_RATE * 100).toFixed(1)}%)`, () => {
    const judged = runs.filter((r) => HONESTY.has(r.outcome));
    const declined = judged.filter((r) => r.outcome === 'did-not-converge');
    const rate = judged.length === 0 ? 0 : declined.length / judged.length;
    expect(judged.length, 'there must be at least one judged search').toBeGreaterThan(0);
    expect(
      rate,
      `DECLINE RATE ${(rate * 100).toFixed(1)}% exceeds the measured baseline ${(MEASURED_DECLINE_RATE * 100).toFixed(1)}% — native now declines MORE real designs than before (a regression). Declined: ${declined
        .map((r) => `${r.name}/${r.capability}`)
        .join(', ')}`,
    ).toBeLessThanOrEqual(MEASURED_DECLINE_RATE + 1e-9);
  });
});
