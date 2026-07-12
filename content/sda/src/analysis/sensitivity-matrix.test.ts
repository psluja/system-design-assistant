import { describe, expect, it } from 'vitest';
import { NodeId, type Key, type Transform } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { simulate, StationId } from '@sda/engine-sim';
import { instantiate, allManifests, registry, keys, toQueueingNetwork, type Instance, type ManifestBand, type Wire } from '../index';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// SENSITIVITY MATRIX (task-78) — every INPUT knob × every OUTPUT metric, each cell = the EXPECTED monotone
// direction, mechanically checked on synthetic engine-level designs.
//
// WHY this suite exists: the owner caught `deploymentMode` stepping availability UP while COST stayed flat
// (redundancy was free — task-77). That is a whole CLASS of bug: a knob the model reads for one metric but
// silently forgets for another. A hand-written "does X move Y?" test only catches the case someone thought
// to write. This suite instead declares the WHOLE grid as reviewable DATA (the `MATRIX` table below) and
// mechanically bumps each knob to assert the SIGN of every metric's response. A cell that says `+` (must move
// up) but MEASURES `0` (did not move) fails with a NAMED gap — which is exactly how deploymentMode→cost=0 is
// caught here (see the `deploymentMode` rows: cost is `+`, so pre-task-77 they go RED).
//
// HOW a cell is checked: build a canonical synthetic chain, read the metric at the OBSERVATION node, bump the
// knob by `delta`, re-read, and classify the change as +/−/0 (with a tolerance). Then compare to the declared
// direction. `n/a` cells are not observed (the metric is not defined for that knob's node). Scalar metrics go
// through `evaluate` (the numeric hot path); DES-only metrics (goodput/errorRate — a retry loop is a question
// about TIME) go through a seeded `simulate` with CI-tolerant thresholds.
//
// The matrix is deliberately synthetic + engine-level: the chains are the smallest designs that exercise each
// knob, so a RED cell points at the MECHANISM (a relation that forgot to read a knob), not at content nuance.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The monotone response of a metric to a knob bump: up / down / unchanged / not-applicable. */
type Dir = '+' | '-' | '0' | 'n/a';

/** The OUTPUT metrics observed. Scalar ones are read from `evaluate`; DES-only ones (goodput/errorRate) from a
 *  seeded `simulate`. Each column is one observable of a solved design; the matrix declares the expected sign of
 *  each against every knob. `costTotal` is the whole-design monthly cost (the sum the finale bill is built from —
 *  the metric the deploymentMode gap corrupts); the rest are read at a named observation node. */
type Metric =
  | 'costTotal' // Σ node cost, USD/month — the honest total bill
  | 'throughput' // served req/s at the observation node
  | 'latency' // cumulative mean latency, ms
  | 'availability' // compounded availability ratio
  | 'durability' // compounded durability ratio
  | 'overflow' // rejected/dropped/throttled excess, req/s
  | 'poolOverflow' // pooled-connection excess (proxy)
  | 'payloadOverflow' // over-size item/message excess, bytes (documented payload ceiling)
  | 'egressCost' // data-transfer (egress) monthly $ at the observation node
  | 'backlog' // queue net accumulation rate, msg/s (>0 ⇒ growing without bound)
  | 'concurrencyNeeded' // Little's-law concurrency the load implies (serverless)
  | 'downstreamThroughput' // served req/s at a NAMED downstream node (for transform/origin rows whose effect lands downstream)
  | 'downstreamCost' // whole-design costTotal, but the row's effect lands at a downstream pay-per-use tier (a distinct column so the intent reads clearly)
  | 'goodputRps' // DES: successful completions/s past retries
  | 'errorRate' // DES: failures/s (retries exhausted / drops)
  | 'amplification' // DES: total attempts ÷ original arrivals (≥ 1; retry-traffic multiplier)
  | 'dropped'; // DES: jobs LOST at the observation station (full-buffer loss OR a wait-deadline renege)

// costTotal and downstreamCost are BOTH the whole-design bill (downstreamCost is a semantic alias so a
// transform/origin row can name the column that reads at the downstream tier); downstreamThroughput reads
// `throughput` at a SECOND observation node. Both go through the scalar path with a special reader (below).
const SCALAR_METRICS: readonly Metric[] = [
  'costTotal', 'throughput', 'latency', 'availability', 'durability', 'overflow', 'poolOverflow', 'payloadOverflow', 'egressCost', 'backlog', 'concurrencyNeeded', 'downstreamThroughput', 'downstreamCost',
];
const DES_METRICS: readonly Metric[] = ['goodputRps', 'errorRate', 'amplification', 'dropped'];

// The registry key each per-node scalar metric reads (costTotal/downstreamCost are whole-design; downstream*
// use a second node — handled in the reader, not here). `dropped`/`amplification` are DES-only (no forward key).
const METRIC_KEY: Record<'throughput' | 'latency' | 'availability' | 'durability' | 'overflow' | 'poolOverflow' | 'payloadOverflow' | 'egressCost' | 'backlog' | 'concurrencyNeeded' | 'goodputRps' | 'errorRate', Key> = {
  throughput: keys.throughput,
  latency: keys.latency,
  availability: keys.availability,
  durability: keys.durability,
  overflow: keys.overflow,
  poolOverflow: keys.poolOverflow,
  payloadOverflow: keys.payloadOverflow,
  egressCost: keys.egressCost,
  backlog: keys.backlog,
  concurrencyNeeded: keys.concurrencyNeeded,
  goodputRps: keys.goodputRps,
  errorRate: keys.errorRate,
};

/** One matrix ROW: a knob on a node of a synthetic chain, and the expected direction of each metric when the knob
 *  is bumped UP by `delta`. `expect` lists ONLY the metrics that apply; any metric absent from `expect` is `n/a`
 *  for this row (not observed). `observe` names the node whose per-node metrics are read (default: the terminal). */
interface Row {
  /** A human label for the knob under test (the registry key it drives, plus the node it lives on). */
  readonly knob: string;
  /** The registry key of the config knob being bumped. */
  readonly key: Key;
  /** The node the knob lives on. */
  readonly node: string;
  /** Additive bump applied to the knob's current value (the direction of the row is "knob goes UP"). */
  readonly delta: number;
  /** The synthetic chain the row runs on. */
  readonly instances: Instance[];
  readonly wires: Wire[];
  /** The node whose per-node metrics are observed (costTotal is always whole-design). Default = last instance. */
  readonly observe?: string;
  /** A SECOND observation node whose `throughput` is read as `downstreamThroughput` (transform/origin rows whose
   *  effect lands one hop downstream — e.g. a port ratio on `gen.out` moves the SINK's served rate, not gen's). */
  readonly downstream?: string;
  /** The DES station whose `dropped` count is read as the `dropped` metric (a wait-deadline renege / buffer loss
   *  is attributed to a specific station). Default = the row's `observe`/terminal node. */
  readonly dropStation?: string;
  /** Which mechanism answers this row's metrics: the scalar hot path or the DES. Default 'scalar'. */
  readonly mechanism?: 'scalar' | 'des';
  // ── TRANSFORM rows: the thing that moves is a transform's `value`, not a config knob. When any `tf*` field is
  //    set the harness bumps the transform (by `tfDelta`) instead of a config cell (`key`/`node`/`delta` are then
  //    inert placeholders — kept so the row is still a well-formed `Row`). Exactly one of tfPort/tfWire is set. ──
  /** The node whose PORT transform is bumped (with `tfPort`). */
  readonly tfNode?: string;
  /** The port name whose transform value is bumped. */
  readonly tfPort?: string;
  /** The WIRE [fromNode, toNode] whose transform value is bumped. */
  readonly tfWire?: readonly [string, string];
  /** The additive bump to the transform's `value` (the row's direction is "value goes UP"). */
  readonly tfDelta?: number;
  /** The EXPECTED direction per metric. A metric omitted here is `n/a` (unobserved for this knob). */
  readonly expect: Partial<Record<Metric, Dir>>;
}

/** A VERDICT-FLIP row: tightening an SLO band must flip a node's verdict status (ok → violation). This is a
 *  DIFFERENT observable from the monotone metric grid — it reads the STATUS of a band, not a value — so it
 *  rides its own tiny table + `it` block rather than being shoehorned into a `Dir`. The knob under test is the
 *  SLO band itself (a scenario input), not a config knob. */
interface FlipRow {
  /** A human label for the SLO tightening under test. */
  readonly label: string;
  /** The base design (already at rest, verdict ok on the observed key). */
  readonly instances: Instance[];
  readonly wires: Wire[];
  /** The node the band is attached to and whose verdict is read. */
  readonly node: string;
  /** The registry key the band governs (its verdict is observed). */
  readonly key: Key;
  /** The LOOSE band (verdict expected `ok`) and the TIGHT band (verdict expected `violation`). */
  readonly loose: ManifestBand['band'];
  readonly tight: ManifestBand['band'];
}

// ── canonical synthetic chains (the smallest designs that exercise each knob) ──────────────────────────────

/** client → gateway → serverless(compute.faas) → db(db.postgres). The workhorse: a source, a provisioned relay,
 *  a Little's-law serverless tier (concurrency / duration), and a Multi-AZ-capable database (deploymentMode). */
const chain = (over: Record<string, Record<string, number>> = {}): { instances: Instance[]; wires: Wire[] } => ({
  instances: [
    { id: 'client', type: 'client.source', config: { throughput: 800, ...over.client } },
    { id: 'gw', type: 'gateway.api', config: { ...over.gw } },
    { id: 'compute', type: 'compute.faas', config: { concurrency: 100, perRequestDuration: 50, ...over.compute } },
    { id: 'db', type: 'db.postgres', config: { ...over.db } },
  ],
  wires: [
    { from: ['client', 'out'], to: ['gw', 'in'] },
    { from: ['gw', 'out'], to: ['compute', 'in'] },
    { from: ['compute', 'out'], to: ['db', 'in'] },
  ],
});

/** A pooled proxy in front of the db: client → service → rds-proxy → aurora. Exercises the connection-pool knobs
 *  (connectionPool / connectionHeldMs) and their poolOverflow, plus aurora's deploymentMode. */
const pooledChain = (over: Record<string, Record<string, number>> = {}): { instances: Instance[]; wires: Wire[] } => ({
  instances: [
    // 5000 req/s so the proxy's 100-connection pool is UNDER pressure (poolNeeded = 5000 × 30 ms = 150 > 100) —
    // the pool knobs must be able to MOVE poolOverflow, which needs a non-zero baseline to shrink/grow from.
    { id: 'client', type: 'client.source', config: { throughput: 5000, ...over.client } },
    { id: 'svc', type: 'compute.service', config: { ...over.svc } },
    { id: 'proxy', type: 'proxy.rds', config: { ...over.proxy } },
    { id: 'aurora', type: 'db.aurora', config: { ...over.aurora } },
  ],
  wires: [
    { from: ['client', 'out'], to: ['svc', 'in'] },
    { from: ['svc', 'db'], to: ['proxy', 'in'] },
    { from: ['proxy', 'out'], to: ['aurora', 'in'] },
  ],
});

/** A retrying caller into a single-server bottleneck: client(retry) → gw → svc(cap=10) → db. The DES-only rows
 *  (timeoutMs/retryCount) ride here — a retry loop is non-monotone feedback answered only by the simulator. */
const retryChain = (over: Record<string, number> = {}): { instances: Instance[]; wires: Wire[] } => ({
  instances: [
    // retryCount 0 by default so the retryCount ROW starts from the no-retry world (errorRate small/zero) and the
    // bump makes the retry storm APPEAR — a large, unambiguous errorRate rise, not a marginal wiggle at deep overload.
    { id: 'client', type: 'client.source', config: { throughput: 15, timeoutMs: 250, retryCount: 0, retryBackoffMs: 20, ...over } },
    { id: 'gw', type: 'compute.service', config: { concurrency: 1000, perRequestDuration: 2, latency: 2 } },
    { id: 'svc', type: 'compute.service', config: { concurrency: 1, perRequestDuration: 100, latency: 100 } }, // cap = 10 req/s
    { id: 'db', type: 'compute.service', config: { concurrency: 1000, perRequestDuration: 2, latency: 2 } },
  ],
  wires: [
    { from: ['client', 'out'], to: ['gw', 'in'] },
    { from: ['gw', 'out'], to: ['svc', 'in'] },
    { from: ['svc', 'out'], to: ['db', 'in'] },
  ],
});

/** A TRANSFORM chain: client → gen (a fast relay whose OUT port carries a transform) → sink (an unbounded
 *  PAY-PER-USE tier, so its `cost = inflow × unitCost` reads the transformed load — the "downstream cost" column).
 *  The gen tier is effectively unbounded so what reaches the sink is exactly the transformed rate (no clipping),
 *  and the sink is huge so it SERVES all of it: `downstreamThroughput`/`downstreamCost` at the sink then read the
 *  pure transform effect. A `portTf` puts the transform on gen's OUT port; a `wireTf` puts it on the gen→sink wire
 *  (the two seams the flow model applies transforms at). The knob under test is the transform's `value`. */
const transformChain = (opts: { portTf?: Transform; wireTf?: Transform } = {}): { instances: Instance[]; wires: Wire[] } => ({
  instances: [
    { id: 'client', type: 'client.web', config: { throughput: 200 } },
    { id: 'gen', type: 'compute.service', config: { concurrency: 100000 }, ...(opts.portTf ? { transforms: { out: opts.portTf } } : {}) },
    // storage.object is PAY-PER-USE (cost = inflow × unitCost) and given a huge ceiling ⇒ serves any offered rate.
    { id: 'sink', type: 'storage.object', config: { throughput: 100000000 } },
  ],
  wires: [
    { from: ['client', 'out'], to: ['gen', 'in'] },
    { from: ['gen', 'out'], to: ['sink', 'in'], ...(opts.wireTf ? { transform: opts.wireTf } : {}) },
  ],
});

/** An EGRESS / PAYLOAD chain: client → gateway.api. The gateway carries BOTH a documented payload ceiling-free
 *  egress line (egressCost = inflow × payloadBytes × price) — so bumping `payloadBytes` raises egressCost — AND
 *  (on a queue variant below) a payload ceiling. This chain isolates the payload/egress knobs. */
const egressChain = (over: Record<string, number> = {}): { instances: Instance[]; wires: Wire[] } => ({
  instances: [
    { id: 'client', type: 'client.source', config: { throughput: 800 } },
    { id: 'gw', type: 'gateway.api', config: { ...over } },
  ],
  wires: [{ from: ['client', 'out'], to: ['gw', 'in'] }],
});

/** A PAYLOAD-CEILING chain: client → sqs. queue.sqs ships the documented 256 KB message ceiling (maxItemBytes),
 *  so setting `payloadBytes` above/below it moves `payloadOverflow = max(0, payloadBytes − maxItemBytes)`. Start
 *  the payload at 200 KB (inside the ceiling ⇒ overflow 0) so a bump ACROSS the ceiling makes the overflow appear. */
const payloadChain = (over: Record<string, number> = {}): { instances: Instance[]; wires: Wire[] } => ({
  instances: [
    { id: 'client', type: 'client.web', config: { throughput: 100 } },
    { id: 'q', type: 'queue.sqs', config: { payloadBytes: 200_000, ...over } },
  ],
  wires: [{ from: ['client', 'out'], to: ['q', 'in'] }],
});

/** A QUEUE chain: producer → sqs (queueMode on). The producer overwhelms the drain, so backlog > 0 and — with a
 *  bounded buffer under the DES — the station DROPS. Exercises drainRate/maxBacklog against backlog (scalar) and
 *  dropped (DES). Producer 5000 into SQS (ingest ~3000, drain 1000) ⇒ a standing backlog to shrink/grow from. */
const queueChain = (over: Record<string, number> = {}): { instances: Instance[]; wires: Wire[] } => ({
  instances: [
    { id: 'producer', type: 'client.web', config: { throughput: 5000 } },
    { id: 'q', type: 'queue.sqs', config: { queueMode: 1, drainRate: 1000, maxBacklog: 100, ...over } },
  ],
  wires: [{ from: ['producer', 'out'], to: ['q', 'in'] }],
});

/** An ORIGIN chain: a source SERVICE that ORIGINATES traffic (no client) → sink (pay-per-use). Raising `assumedRps`
 *  raises the load the source emits ⇒ the sink's served throughput and its pay-per-use cost both rise. The gen
 *  service is unbounded so its emission = assumedRps exactly (no capacity clip masking the effect). */
const originChain = (over: Record<string, number> = {}): { instances: Instance[]; wires: Wire[] } => ({
  instances: [
    { id: 'gen', type: 'compute.service', config: { assumedRps: 500, concurrency: 100000, ...over } },
    { id: 'sink', type: 'storage.object', config: { throughput: 100000000 } },
  ],
  wires: [{ from: ['gen', 'out'], to: ['sink', 'in'] }],
});

/** A DES POOL chain (borrow-timeout reneging): client → app → rds-proxy(small pool, short borrow timeout) → pg.
 *  A saturated pool's borrow queue exceeds `maxQueueWaitMs` and requests renege AT THE PROXY (its `dropped` +
 *  system `errorRate`). Mirrors rds-proxy.e2e's poolChain. Pool 10 / held 30 ms ⇒ ~333 rps capacity; offer 3000
 *  ⇒ deep pressure. The borrow timeout is short (300 ms) purely to keep the run fast (the sourced default is 120 s). */
const poolDesChain = (over: Record<string, number> = {}): { instances: Instance[]; wires: Wire[] } => ({
  instances: [
    { id: 'client', type: 'client.web', config: { throughput: 3000 } },
    { id: 'app', type: 'compute.service', config: { concurrency: 100000, perRequestDuration: 1, latency: 1 } },
    { id: 'proxy', type: 'proxy.rds', config: { connectionPool: 10, connectionHeldMs: 30, maxQueueWaitMs: 300, ...over } },
    { id: 'pg', type: 'db.postgres', config: { concurrency: 100000, perRequestDuration: 1 } },
  ],
  wires: [
    { from: ['client', 'out'], to: ['app', 'in'] },
    { from: ['app', 'db'], to: ['proxy', 'in'] },
    { from: ['proxy', 'out'], to: ['pg', 'in'] },
  ],
});

/** A DES RETRY chain at MILD overload with retries ON — the operating point where the retry knobs move all three
 *  outcome metrics CLEANLY: 12 req/s into a 10 req/s tier, retryCount 3. At this point retries RECOVER false
 *  timeouts (goodput ↑, errorRate ↓) while adding attempts (amplification ↑) — a robust, above-noise response.
 *  (Deep overload — retryChain's 30 req/s — pins goodput/errorRate at the capacity ceiling so only amplification
 *  moves; mild overload is where the retryCount→goodput/errorRate law is legible. See the DES rows' comments.) */
const retryMild = (over: Record<string, number> = {}): { instances: Instance[]; wires: Wire[] } => retryChain({ throughput: 12, retryCount: 3, timeoutMs: 250, retryBackoffMs: 20, ...over });

// ── THE MATRIX — reviewable DATA. Rows = knobs; the `expect` map = the expected direction per output metric. ──
// A blank cell (metric absent from `expect`) is `n/a`: that knob's node does not define / does not move it.
// The load-carrying rows for task-77 are the two `deploymentMode` rows: cost is `+`. Pre-77 those cost cells
// MEASURE `0` (redundancy is free) ⇒ the matrix goes RED with a named gap; task-77 turns them GREEN.

const MATRIX: readonly Row[] = [
  // ── the WORKLOAD & capacity knobs ───────────────────────────────────────────────────────────────────────
  {
    knob: 'client.throughput (offered workload)',
    key: keys.throughput,
    node: 'client',
    delta: 400, // 800 → 1200, still under every tier's ceiling
    ...chain(),
    observe: 'compute', // the serverless tier carries served throughput AND concurrencyNeeded (Little's law)
    // more offered load ⇒ more served throughput; the serverless tier needs more concurrency (Little's law); the
    // mean per-hop latency and the tier's own availability do not move on the scalar pass.
    expect: { throughput: '+', concurrencyNeeded: '+', latency: '0', availability: '0' },
  },
  {
    knob: 'compute.concurrency (serverless capacity dial)',
    key: keys.concurrency,
    node: 'compute',
    delta: 100, // 100 → 200 : capacity = concurrency / duration, and cost = concurrency × base
    ...chain(),
    observe: 'db',
    // raising the capacity dial costs money (the cardinal rule: no free capacity) and lifts served throughput iff
    // the tier was the bottleneck. Here compute cap = 100/0.05 = 2000 ≥ 800 offered, so throughput is already
    // unbottlenecked ⇒ served throughput does NOT rise; only cost does.
    expect: { costTotal: '+', throughput: '0' },
  },
  {
    knob: 'compute.perRequestDuration (service time)',
    key: keys.perRequestDuration,
    node: 'compute',
    delta: 100, // 50 → 150 ms : capacity = concurrency / duration FALLS, concurrencyNeeded RISES
    ...chain(),
    observe: 'compute',
    // a slower handler shrinks Little's-law capacity (concurrency / duration) and raises the concurrency the load
    // needs. At 150 ms the tier capacity is 100/0.15 ≈ 667 < 800 offered ⇒ served throughput DROPS (a new bottleneck).
    expect: { throughput: '-', concurrencyNeeded: '+' },
  },
  {
    knob: 'db.perRequestDuration (query time → capacity)',
    key: keys.perRequestDuration,
    node: 'db',
    delta: 200, // 50 → 250 ms query time : db capacity = 100 conn / 0.25 s = 400 < 800 offered ⇒ db bottlenecks
    ...chain(),
    observe: 'db',
    // db.postgres capacity = connections / query-time. A much slower query drops capacity below the 800 offered,
    // so the db becomes the bottleneck and served throughput DROPS. (The db's `latency` is a separate config knob,
    // not perRequestDuration, so the latency key is unmoved — this row isolates the CAPACITY effect.)
    expect: { throughput: '-', latency: '0' },
  },
  {
    knob: 'db.latency (per-hop latency)',
    key: keys.latency,
    node: 'db',
    delta: 50, // 50 → 100 ms
    ...chain(),
    observe: 'db',
    // the db's own latency adds directly to the cumulative sync-path latency; nothing else moves.
    expect: { latency: '+', throughput: '0', availability: '0' },
  },
  {
    knob: 'db.concurrency (connection-bound capacity + cost driver)',
    key: keys.concurrency,
    node: 'db',
    delta: 100, // 100 → 200 connections : capacity = conn / query-time, cost = conn × base
    ...chain(),
    observe: 'db',
    // more connections = a bigger instance = more cost (costPer(concurrency)); capacity rises but the db is not the
    // bottleneck here (100 conn / 0.05 s = 2000 ≥ 800), so served throughput is unmoved.
    expect: { costTotal: '+', throughput: '0' },
  },

  // ── the AVAILABILITY / DEPLOYMENT knobs (task-77 load-bearing) ────────────────────────────────────────────
  {
    knob: 'db.postgres deploymentMode (single-AZ → Multi-AZ)',
    key: keys.deploymentMode,
    node: 'db',
    delta: -1, // start Multi-AZ (default 1) then step DOWN to single-AZ 0 — availability DROPS, cost DROPS
    ...chain({ db: { deploymentMode: 1 } }),
    observe: 'db',
    // Stepping DOWN from Multi-AZ to single-AZ: the published SLA availability DROPS (0.9995 → 0.995) AND — the
    // task-77 fix — the billed standby goes away, so COST DROPS. Pre-77 the cost cell MEASURES 0 (redundancy was
    // free) ⇒ this is the RED gap the matrix catches. Direction here is for the knob going UP (delta<0 flips it):
    // as deploymentMode RISES, availability RISES and cost RISES.
    expect: { availability: '+', costTotal: '+' },
  },
  {
    knob: 'db.aurora deploymentMode (single-AZ → Multi-AZ, replicas billed)',
    key: keys.deploymentMode,
    node: 'aurora',
    delta: -1, // Multi-AZ (1) → single (0): availability + billed replica both drop
    ...pooledChain({ aurora: { deploymentMode: 1 } }),
    observe: 'aurora',
    // Aurora Multi-AZ = writer + reader instances, each billed. Same law as RDS: availability UP with mode, and cost
    // UP with mode (the reader is not free). Pre-77: cost cell measures 0 ⇒ RED.
    expect: { availability: '+', costTotal: '+' },
  },

  // ── the POOL knobs (proxy) ───────────────────────────────────────────────────────────────────────────────
  {
    knob: 'proxy.connectionPool (pooled-connection budget)',
    key: keys.connectionPool,
    node: 'proxy',
    delta: 100, // 100 → 200 pooled connections : capacity = pool / heldMs, poolOverflow FALLS
    ...pooledChain(),
    observe: 'proxy',
    // a bigger pool raises the proxy's Little's-law capacity (pool / heldMs) and shrinks the pooled-connection
    // overflow. cost is per target vCPU (not the pool), so cost does NOT move with the pool size.
    expect: { poolOverflow: '-', costTotal: '0' },
  },
  {
    knob: 'proxy.connectionHeldMs (per-request hold time)',
    key: keys.connectionHeldMs,
    node: 'proxy',
    delta: 30, // 30 → 60 ms held : capacity = pool / held FALLS, poolOverflow RISES
    ...pooledChain(),
    observe: 'proxy',
    // holding each pooled connection longer shrinks capacity (pool / heldMs) and grows the pool overflow.
    expect: { poolOverflow: '+' },
  },
  {
    knob: 'proxy.vcpus (per-vCPU billing driver)',
    key: keys.vcpus,
    node: 'proxy',
    delta: 2, // 2 → 4 vCPU : cost = vcpus × $10.95/mo
    ...pooledChain(),
    observe: 'proxy',
    // the proxy bills per target vCPU (costPer(vcpus)); more vCPU ⇒ more cost, nothing else.
    expect: { costTotal: '+', poolOverflow: '0' },
  },

  // ── unit cost & durability ───────────────────────────────────────────────────────────────────────────────
  {
    knob: 'db.unitCost (base $ rate)',
    key: keys.unitCost,
    node: 'db',
    delta: 1, // 1.4 → 2.4 USD/conn·month
    ...chain(),
    observe: 'db',
    // the visible base rate multiplies the cost driver: raising it raises cost, moves nothing else.
    expect: { costTotal: '+', throughput: '0', availability: '0' },
  },
  {
    knob: 'db.durability (data-safety ratio)',
    key: keys.durability,
    node: 'db',
    delta: -0.0009, // 0.99999 → 0.99909 : the compounded durability drops
    ...chain(),
    observe: 'db',
    // durability compounds multiplicatively down the path; lowering the db's own durability lowers the roll-up.
    // (delta<0 flips the row: as the knob RISES, durability RISES.)
    expect: { durability: '+' },
  },

  // ── DES-only knobs (a retry loop is non-monotone feedback — a question about TIME; answered ONLY by
  //     the simulator, so these rows use the DES mechanism + CI-tolerant thresholds) ─────────────────────────
  {
    knob: 'svc.concurrency (bottleneck capacity, via the DES)',
    key: keys.concurrency,
    node: 'svc',
    delta: 2, // 1 → 3 servers : bottleneck capacity 10 → 30 req/s, absorbing the 30 req/s offered load
    ...retryChain({ throughput: 30, retryCount: 2 }), // 30 req/s into a 1-server (10 req/s) tier ⇒ deep overload
    mechanism: 'des',
    // Raising the BOTTLENECK's capacity through the simulator: goodput climbs (more requests actually complete) and
    // real FAILURES fall (fewer drops/timeouts) — the honest, monotone capacity→goodput law the DES must show.
    expect: { goodputRps: '+', errorRate: '-' },
  },
  {
    knob: 'client.throughput (offered load deeper into overload, via the DES)',
    key: keys.throughput,
    node: 'client',
    delta: 20, // 15 → 35 req/s into the 10 req/s bottleneck : deeper overload with the retry policy on
    ...retryChain({ retryCount: 2 }), // retries ON; deeper overload ⇒ more excess that cannot be served ⇒ more failures
    mechanism: 'des',
    // Pushing more load past a fixed bottleneck: real FAILURES rise (the excess over the ~10 req/s capacity cannot be
    // served, no matter the retries), while goodput stays pinned at that capacity ceiling (it cannot rise).
    expect: { errorRate: '+', goodputRps: '0' },
  },

  // ── FLOW TRANSFORMS — every kind × BOTH seams (PORT and WIRE) → the downstream served rate + the downstream
  // PAY-PER-USE cost. The transform reshapes the load that reaches the sink, so we
  //    observe the SINK (`downstream`): its served throughput = the transformed rate, its cost = inflow × unitCost.
  //    The knob bumped is the transform's `value` (via the row's `key`/`node` machinery: see the transform-row
  //    handling in the harness — these rows carry NO config knob, the transform value is the thing that moves). ──

  // ratio(value) = value·x. value 1→2 on gen's OUT port ⇒ the sink sees 2× ⇒ served UP, pay-per-use cost UP.
  {
    knob: 'PORT ratio.value (gen.out amplification factor)',
    key: keys.throughput, node: 'gen', delta: 0, // transform rows drive the transform, not a config knob (delta unused)
    ...transformChain({ portTf: { kind: 'ratio', value: 1 } }),
    tfNode: 'gen', tfPort: 'out', tfDelta: 1, // ratio 1 → 2
    observe: 'sink', downstream: 'sink',
    expect: { downstreamThroughput: '+', downstreamCost: '+' },
  },
  {
    knob: 'WIRE ratio.value (gen→sink amplification factor)',
    key: keys.throughput, node: 'gen', delta: 0,
    ...transformChain({ wireTf: { kind: 'ratio', value: 1 } }),
    tfWire: ['gen', 'sink'], tfDelta: 1, // ratio 1 → 2
    observe: 'sink', downstream: 'sink',
    expect: { downstreamThroughput: '+', downstreamCost: '+' },
  },
  // batch(value) = x/value. value 2→3 ⇒ FEWER downstream ⇒ served DOWN, cost DOWN.
  {
    knob: 'PORT batch.value (gen.out n:1 aggregation)',
    key: keys.throughput, node: 'gen', delta: 0,
    ...transformChain({ portTf: { kind: 'batch', value: 2 } }),
    tfNode: 'gen', tfPort: 'out', tfDelta: 1, // batch 2 → 3 (a BIGGER divisor ⇒ less downstream)
    observe: 'sink', downstream: 'sink',
    expect: { downstreamThroughput: '-', downstreamCost: '-' },
  },
  {
    knob: 'WIRE batch.value (gen→sink n:1 aggregation)',
    key: keys.throughput, node: 'gen', delta: 0,
    ...transformChain({ wireTf: { kind: 'batch', value: 2 } }),
    tfWire: ['gen', 'sink'], tfDelta: 1, // batch 2 → 3
    observe: 'sink', downstream: 'sink',
    expect: { downstreamThroughput: '-', downstreamCost: '-' },
  },
  // cap(value) = min(x, value). The gen relay emits 200 rps; cap starts BELOW that (150) so it BINDS, then a bump
  // raises the ceiling ⇒ MORE passes ⇒ served UP, cost UP. (Cap only moves the flow while it is the binding ceiling.)
  {
    knob: 'PORT cap.value (gen.out rate ceiling)',
    key: keys.throughput, node: 'gen', delta: 0,
    ...transformChain({ portTf: { kind: 'cap', value: 150 } }),
    tfNode: 'gen', tfPort: 'out', tfDelta: 30, // cap 150 → 180 (still ≤ 200 offered ⇒ still binds, lets more through)
    observe: 'sink', downstream: 'sink',
    expect: { downstreamThroughput: '+', downstreamCost: '+' },
  },
  {
    knob: 'WIRE cap.value (gen→sink rate ceiling)',
    key: keys.throughput, node: 'gen', delta: 0,
    ...transformChain({ wireTf: { kind: 'cap', value: 150 } }),
    tfWire: ['gen', 'sink'], tfDelta: 30, // cap 150 → 180
    observe: 'sink', downstream: 'sink',
    expect: { downstreamThroughput: '+', downstreamCost: '+' },
  },
  // window(value) = min(x, 1000/value): a BIGGER window ms ⇒ a LOWER flush ceiling ⇒ LESS downstream. Start at a
  // window that binds (window 4 ⇒ ceiling 250 < 200? no — pick window 2 ⇒ 500, still > 200; must bind: window 10 ⇒
  // 100 < 200 binds) then bump UP ⇒ ceiling falls further ⇒ served DOWN, cost DOWN.
  {
    knob: 'PORT window.value (gen.out flush-window ms)',
    key: keys.throughput, node: 'gen', delta: 0,
    ...transformChain({ portTf: { kind: 'window', value: 10 } }), // ceiling 1000/10 = 100 < 200 ⇒ binds
    tfNode: 'gen', tfPort: 'out', tfDelta: 10, // window 10 → 20 ⇒ ceiling 100 → 50 (falls) ⇒ less downstream
    observe: 'sink', downstream: 'sink',
    expect: { downstreamThroughput: '-', downstreamCost: '-' },
  },
  {
    knob: 'WIRE window.value (gen→sink flush-window ms)',
    key: keys.throughput, node: 'gen', delta: 0,
    ...transformChain({ wireTf: { kind: 'window', value: 10 } }),
    tfWire: ['gen', 'sink'], tfDelta: 10, // window 10 → 20
    observe: 'sink', downstream: 'sink',
    expect: { downstreamThroughput: '-', downstreamCost: '-' },
  },
  // prob(value) = value·x (scalar mean). value 0.3→0.5 ⇒ MORE passes ⇒ served UP, cost UP.
  {
    knob: 'PORT prob.value (gen.out keep-probability)',
    key: keys.throughput, node: 'gen', delta: 0,
    ...transformChain({ portTf: { kind: 'prob', value: 0.3 } }),
    tfNode: 'gen', tfPort: 'out', tfDelta: 0.2, // prob 0.3 → 0.5
    observe: 'sink', downstream: 'sink',
    expect: { downstreamThroughput: '+', downstreamCost: '+' },
  },
  {
    knob: 'WIRE prob.value (gen→sink keep-probability / routing split)',
    key: keys.throughput, node: 'gen', delta: 0,
    ...transformChain({ wireTf: { kind: 'prob', value: 0.3 } }),
    tfWire: ['gen', 'sink'], tfDelta: 0.2, // prob 0.3 → 0.5
    observe: 'sink', downstream: 'sink',
    expect: { downstreamThroughput: '+', downstreamCost: '+' },
  },

  // ── PAYLOAD / EGRESS knobs ───────────────────────────────────────────────────────────────────────────────
  {
    knob: 'q.payloadBytes (item/message size → documented ceiling)',
    key: keys.payloadBytes, node: 'q',
    delta: 100_000, // 200 KB → 300 KB : crosses the 256 KB SQS ceiling ⇒ payloadOverflow appears (0 → 44 KB)
    ...payloadChain(),
    observe: 'q',
    // payloadOverflow = max(0, payloadBytes − maxItemBytes); at 200 KB it is 0, at 300 KB it is 300k−256k > 0 ⇒ UP.
    expect: { payloadOverflow: '+' },
  },
  {
    knob: 'gw.payloadBytes (response size → egress cost)',
    key: keys.payloadBytes, node: 'gw',
    delta: 20_000, // 20 KB → 40 KB : egressCost = inflow × payloadBytes × price ⇒ doubles
    ...egressChain(),
    observe: 'gw',
    // egressCost scales linearly with the payload sent per request; a bigger response ⇒ a bigger data-transfer bill.
    expect: { egressCost: '+', throughput: '0' },
  },
  {
    knob: 'gw.egressUsdPerGb (data-transfer price)',
    key: keys.egressUsdPerGb, node: 'gw',
    delta: 0.05, // $0.09 → $0.14 /GB : egressCost scales linearly with the price
    ...egressChain(),
    observe: 'gw',
    expect: { egressCost: '+' },
  },

  // ── UNIVERSAL TRAFFIC ORIGIN ─────────────────────────────────────────────────────────────────────────────
  {
    knob: 'gen.assumedRps (workload a node originates → downstream load + cost)',
    key: keys.assumedRps, node: 'gen',
    delta: 500, // 500 → 1000 rps originated : the sink sees more load ⇒ served UP, pay-per-use cost UP
    ...originChain(),
    observe: 'sink', downstream: 'sink',
    // assumedRps folds into the source's emitted throughput, which flows downstream as ordinary inflow: the sink's
    // served rate rises and its pay-per-use cost (inflow × unitCost) rises with it.
    expect: { downstreamThroughput: '+', downstreamCost: '+' },
  },

  // ── POOL knobs → THROUGHPUT (the connection pool IS the proxy's capacity) ─────────────────────────────────
  {
    knob: 'proxy.connectionPool (pool budget → proxy capacity)',
    key: keys.connectionPool, node: 'proxy',
    delta: 100, // 100 → 200 : capacity = pool / heldMs RISES, so the saturating 5000 rps is served more
    ...pooledChain(),
    observe: 'proxy',
    // proxy capacity = pool/held; at 5000 rps offered the proxy is the bottleneck, so a bigger pool serves MORE
    // (served throughput UP) AND shrinks the pooled-connection overflow.
    expect: { throughput: '+', poolOverflow: '-' },
  },
  {
    knob: 'proxy.connectionHeldMs (per-request hold → proxy capacity)',
    key: keys.connectionHeldMs, node: 'proxy',
    delta: 30, // 30 → 60 ms held : capacity = pool / held FALLS ⇒ served throughput DROPS, poolOverflow RISES
    ...pooledChain(),
    observe: 'proxy',
    expect: { throughput: '-', poolOverflow: '+' },
  },

  // ── QUEUE knobs (scalar backlog) ─────────────────────────────────────────────────────────────────────────
  {
    knob: 'q.drainRate (consumer pull rate → backlog)',
    key: keys.drainRate, node: 'q',
    delta: 1000, // 1000 → 2000 msg/s drained : backlog = inflow − drain FALLS
    ...queueChain(),
    observe: 'q',
    // backlog = queueMode · max(0, min(inflow, ingestCap) − drain). Faster drain ⇒ less accumulation ⇒ backlog DOWN.
    expect: { backlog: '-' },
  },
  {
    knob: 'q.maxBacklog (buffer bound → backlog rate)',
    key: keys.maxBacklog, node: 'q',
    delta: 100, // 100 → 200 msg buffer : the scalar backlog is a RATE (msg/s), not a level — it does NOT read maxBacklog
    ...queueChain(),
    observe: 'q',
    // HONEST 0: the scalar `backlog` is the net ACCUMULATION RATE (inflow − drain), independent of the buffer BOUND.
    // A bigger buffer holds more before erroring but does not change how fast the queue grows — so backlog is `0`
    // here BY DESIGN (the level/rate distinction, not a missing wiring). The buffer bound's effect is a DES question
    // (drops over time), covered by the DES `maxBacklog` row below.
    expect: { backlog: '0' },
  },

  // ── DES: the RETRY-POLICY knobs → goodput / errorRate / amplification, at the MILD-overload operating point
  //    where all three move CLEANLY (retries recover false timeouts: goodput ↑, errorRate ↓, amplification ↑). ──
  {
    knob: 'client.retryCount (extra attempts → the retry storm, via the DES)',
    key: keys.retryCount, node: 'client',
    delta: 3, // 0 → 3 retries at 12 req/s into a 10 req/s tier : retries recover false timeouts AND add attempts
    ...retryMild({ retryCount: 0 }),
    mechanism: 'des',
    // At MILD overload with a per-attempt deadline, retries recover requests that falsely timed out (goodput UP,
    // errorRate DOWN) at the cost of extra attempts (amplification UP) — the honest three-way retry law.
    expect: { goodputRps: '+', errorRate: '-', amplification: '+' },
  },
  {
    knob: 'client.timeoutMs (per-attempt deadline → false-timeout recovery, via the DES)',
    key: keys.timeoutMs, node: 'client',
    // 120 → 700 ms : from a SHORT deadline (the ~100 ms service + queue routinely blows it ⇒ a false-timeout storm)
    // to a generous one. Measured Δ goodput ≈ +0.83, Δ errorRate ≈ −0.73 (both well above the 0.5 DES eps). Starting
    // at 250 (the earlier draft) was too close to the service time to move goodput above the noise floor — 120 is
    // squarely in the false-timeout regime, where a longer deadline demonstrably recovers work.
    delta: 580,
    ...retryMild({ retryCount: 3, timeoutMs: 120 }),
    mechanism: 'des',
    // A longer per-attempt deadline lets slow-but-succeeding requests finish instead of being abandoned: goodput
    // rises and real failures fall. (amplification is NOT declared here — a longer timeout means fewer retry ROUNDS
    // but each waits longer, so the net attempt count barely moves; that cell is RED-documented in the todo block.)
    expect: { goodputRps: '+', errorRate: '-' },
  },

  // ── DES: STATION WAIT DEADLINE + QUEUE DRAIN → dropped / errorRate ────────────────────────────────────────
  {
    knob: 'proxy.maxQueueWaitMs (connection-borrow deadline → reneging drops)',
    key: keys.maxQueueWaitMs, node: 'proxy',
    delta: 300, // 0 (no deadline) → 300 ms : ARM the borrow timeout on a saturated pool ⇒ reneging drops APPEAR
    ...poolDesChain({ maxQueueWaitMs: 0 }), // start UNARMED (pure-delay proxy, no reneging) so the bump turns it ON
    mechanism: 'des',
    dropStation: 'proxy',
    // Arming the borrow deadline on a saturated pool (offered ≫ pool/held) makes requests renege AT the proxy: the
    // proxy's `dropped` and the system `errorRate` both jump from 0. The unarmed pool queues unboundedly (no drops);
    // the deadline reveals the honest capacity ceiling by shedding the excess as timeouts.
    expect: { dropped: '+', errorRate: '+' },
  },
  {
    knob: 'q.drainRate (consumer pull rate → buffer drops, via the DES)',
    key: keys.drainRate, node: 'q',
    delta: 3000, // 1000 → 4000 msg/s drained : a faster consumer sheds LESS at the bounded buffer ⇒ fewer drops
    ...queueChain(),
    mechanism: 'des',
    dropStation: 'q',
    // The queue's bounded buffer DROPS what the consumer cannot keep up with. A faster drain empties it more, so
    // fewer arrivals hit a full buffer ⇒ `dropped` falls (and the system `errorRate`, its per-second twin, with it).
    expect: { dropped: '-', errorRate: '-' },
  },
];

// ── RED-DOCUMENTED DES rows (task-78) — knobs whose declared metric MEASURES 0 (or is non-monotone) in this
//    harness. Left as `it.todo` with the gap NAMED rather than faked green or deleted: the matrix must stay honest.
//    Each todo is a real, understood finding (see the report), not an oversight. ─────────────────────────────────
const RED_DES_ROWS: readonly string[] = [
  // retryBackoffMs only SPACES OUT re-injection in time; at steady state it barely moves goodput/errorRate/
  // amplification (measured Δ ≈ 0.2 req/s at mild overload, 0.03 on amplification — all under the 0.5 DES eps).
  // A backoff's real job is to prevent a synchronized thundering herd (a TRANSIENT), which a steady-state mean
  // cannot show. So retryBackoffMs → {goodputRps, errorRate, amplification} is RED here — an honest limitation of
  // the steady-state metric, not a broken relation. (Would need a burst/transient probe, out of this grid's scope.)
  'client.retryBackoffMs → goodputRps/errorRate/amplification (steady-state mean is flat; backoff shapes TRANSIENTS)',
  // timeoutMs → amplification: a longer deadline cuts retry ROUNDS but lengthens each attempt's wait; the net
  // attempt count is near-flat (measured Δ ≈ 0.25 on amplification, under the 0.5 eps). goodput/errorRate DO move
  // (asserted in the green row above); amplification alone is the ambiguous cell.
  'client.timeoutMs → amplification (fewer rounds but longer waits ⇒ net attempts near-flat)',
  // maxBacklog → dropped (DES): at a steady 5:1 overload the drop RATE is arrival − drain regardless of buffer
  // SIZE (a bigger buffer delays the first drop but not the steady drop rate) — measured Δ ≈ 6 drops out of ~16k,
  // i.e. 0. A buffer bound absorbs BURSTS (a transient), which the steady-state window cannot show. Honest 0.
  'q.maxBacklog → dropped (steady-state drop rate is arrival−drain, independent of buffer SIZE; buffer absorbs BURSTS)',
];

// ── VERDICT-FLIP rows — tightening an SLO band must flip a node's verdict ok → violation. A separate observable
//    (a STATUS, not a value), so it rides its own table. The SLO is a scenario input, not a config knob. ────────
const FLIP_ROWS: readonly FlipRow[] = [
  {
    // A latency SLO: the chain's cumulative sync latency is ~105 ms (client 0 + gw 5 + compute 50 + db 50). A loose
    // 500 ms ceiling is ok; tightening it to 50 ms (below the real latency) flips the db verdict to a violation.
    label: 'latency ceiling 500 ms → 50 ms (below the real ~105 ms path)',
    ...chain(),
    node: 'db',
    key: keys.latency,
    loose: { shape: 'minTargetMax', max: 500 },
    tight: { shape: 'minTargetMax', max: 50 },
  },
  {
    // A cost SLO on the whole db node: its own cost is ~140/mo at the default 100 connections × Multi-AZ ×2 = 280.
    // A loose 10000 ceiling is ok; a 1 ceiling (below the real bill) flips it to a violation.
    label: 'cost ceiling 10000 → 1 (below the real db bill)',
    ...chain(),
    node: 'db',
    key: keys.cost,
    loose: { shape: 'minTargetMax', max: 10000 },
    tight: { shape: 'minTargetMax', max: 1 },
  },
  {
    // A throughput FLOOR SLO: the compute tier serves 800 rps. A loose floor of 100 is ok; a floor of 5000 (above the
    // served rate) flips it to a violation — the honest "you asked for more throughput than this design delivers".
    label: 'throughput floor 100 → 5000 (above the served 800 rps)',
    ...chain(),
    node: 'compute',
    key: keys.throughput,
    loose: { shape: 'minTargetMax', min: 100 },
    tight: { shape: 'minTargetMax', min: 5000 },
  },
];

// ── the harness ─────────────────────────────────────────────────────────────────────────────────────────────

/** Read every scalar metric of a design at the observation node (+ the whole-design cost total). Returns a map
 *  metric → value; a metric with no computed value reads NaN (so it classifies as `0`/unchanged, never a false +/−).
 *  `downstream` names a SECOND node whose `throughput` is read as `downstreamThroughput` (transform/origin rows
 *  whose effect lands one hop downstream — the transformed load reaches the SINK, not the transforming node). */
function readScalar(instances: Instance[], wires: Wire[], observe: string, downstream?: string): Record<Metric, number> {
  const g = instantiate(allManifests, instances, wires);
  if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
  const ev = evaluate(g.value, registry);
  if (!ev.ok) throw new Error(`evaluate failed: ${ev.error.join('; ')}`);
  const at = (id: string, k: Key): number => ev.value.value(NodeId(id), k) ?? NaN;
  // costTotal = Σ each node's OWN cost (invert the cumulative sum: own(n) = cum(n) − Σ preds). This is exactly the
  // whole-design bill the finale total is built from — the metric the deploymentMode gap corrupts.
  let costTotal = 0;
  for (const inst of instances) {
    const preds = wires.filter((w) => w.to[0] === inst.id);
    const own = (at(inst.id, keys.cost) || 0) - preds.reduce((s, w) => s + (at(w.from[0], keys.cost) || 0), 0);
    costTotal += own;
  }
  const out = { costTotal } as Record<Metric, number>;
  // per-node scalar metrics that map to a registry key, read at the observation node.
  for (const m of SCALAR_METRICS) {
    if (m === 'costTotal' || m === 'downstreamThroughput' || m === 'downstreamCost') continue;
    out[m] = at(observe, METRIC_KEY[m as keyof typeof METRIC_KEY]);
  }
  // downstreamThroughput = served rate at a NAMED downstream node; downstreamCost aliases the whole-design bill
  // (the row's effect lands at a downstream pay-per-use tier — the column just names WHERE the cost change reads).
  out.downstreamThroughput = downstream !== undefined ? at(downstream, keys.throughput) : NaN;
  out.downstreamCost = costTotal;
  return out;
}

/** Read the DES metrics of a design with a seeded, deterministic simulation. goodput/errorRate/amplification are
 *  whole-network; `dropped` is a per-STATION count read at `dropStation` (a wait-deadline renege / buffer loss).
 *  Same seed + window as retry-feedback.e2e, so the numbers are the pinned, reproducible ones. */
function readDes(instances: Instance[], wires: Wire[], dropStation?: string): Record<'goodputRps' | 'errorRate' | 'amplification' | 'dropped', number> {
  const g = instantiate(allManifests, instances, wires);
  if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
  const sim = simulate(toQueueingNetwork(g.value), { seed: 76076, warmupCompletions: 8000, measureCompletions: 40000 });
  const dropped = dropStation !== undefined ? sim.stations.find((s) => String(s.id) === dropStation)?.dropped ?? NaN : NaN;
  return { goodputRps: sim.goodputRps, errorRate: sim.errorRate, amplification: sim.amplification, dropped };
}

/** Evaluate a design with one SLO `band` attached to `node`/`key`, and return that key's verdict STATUS at the
 *  node (ok / warning / violation / unknown). The band rides as an instance `bands` entry — exactly how the
 *  Inspector's set_slo attaches one — so a tightening test observes the real verdict path, not a re-implementation. */
function verdictStatusOf(instances: Instance[], wires: Wire[], node: string, key: Key, band: ManifestBand['band']): string {
  const withBand = instances.map((i) => (i.id === node ? { ...i, bands: [...(i.bands ?? []), { key, band }] } : i));
  const g = instantiate(allManifests, withBand, wires);
  if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
  const ev = evaluate(g.value, registry);
  if (!ev.ok) throw new Error(`evaluate failed: ${ev.error.join('; ')}`);
  const v = ev.value.verdicts.find((x) => String(x.scope) === node && String(x.key) === String(key));
  return v?.status ?? 'unknown';
}

/** The current value of a knob on an instance: the instance override if present, else the manifest DEFAULT (a
 *  knob left at its default is not in `i.config`, so we must fall back to the manifest — bumping from 0 would
 *  silently RESET the knob instead of nudging it, hiding a real response). Throws if the knob exists nowhere. */
function knobValue(inst: Instance, key: Key): number {
  const override = inst.config?.[String(key)];
  if (override !== undefined) return override;
  const dflt = (allManifests[inst.type]?.config ?? []).find((c) => String(c.key) === String(key))?.value;
  if (dflt === undefined) throw new Error(`knob "${String(key)}" is not a config of "${inst.type}" (add it to the manifest or the instance)`);
  return dflt;
}

/** Apply a config bump to one node of a design (returns a fresh copy — never mutates the base). The bump is
 *  relative to the knob's CURRENT value (instance override or manifest default), never from 0. */
function withBump(instances: Instance[], node: string, key: Key, delta: number): Instance[] {
  return instances.map((i) =>
    i.id === node ? { ...i, config: { ...i.config, [String(key)]: knobValue(i, key) + delta } } : i,
  );
}

/** Bump a PORT transform's `value` on one instance (a fresh copy). The transform KIND is preserved; only its
 *  numeric parameter moves — the row's direction is "the transform's value goes UP". Throws if the port carries no
 *  transform (a row must bump a transform that exists, never conjure one — the same honesty as `knobValue`). */
function withPortTransformBump(instances: Instance[], node: string, port: string, delta: number): Instance[] {
  return instances.map((i) => {
    if (i.id !== node) return i;
    const t = i.transforms?.[port];
    if (t === undefined) throw new Error(`no transform on port "${port}" of "${node}" to bump`);
    if (t.kind === 'generate') throw new Error(`port "${port}" of "${node}" carries a generator, not a reshaping transform — bump its level via assumedRps instead`);
    return { ...i, transforms: { ...i.transforms, [port]: { ...t, value: t.value + delta } } };
  });
}

/** Bump a WIRE transform's `value` on the edge `[from, to]` (a fresh copy). Mirror of the port bump for the
 *  per-wire seam (a routing split); the kind is preserved, only the value moves. */
function withWireTransformBump(wires: Wire[], from: string, to: string, delta: number): Wire[] {
  return wires.map((w) => {
    if (!(w.from[0] === from && w.to[0] === to)) return w;
    if (w.transform === undefined) throw new Error(`no transform on wire ${from}→${to} to bump`);
    if (w.transform.kind === 'generate') throw new Error(`wire ${from}→${to} carries a generator, which is not a wire-level function — nothing to bump`);
    return { ...w, transform: { ...w.transform, value: w.transform.value + delta } };
  });
}

/** Classify a measured change as a direction. The `eps` is the SMALLEST change treated as real; below it the
 *  metric is `0` (unchanged). The scalar engine is DETERMINISTIC, so an untouched metric changes by EXACTLY 0
 *  (a tiny absolute eps swallows only float noise) while a real response — a doubled cost, a dropped nine
 *  (Δavailability ≈ 4e-4, absolute but tiny in RELATIVE terms) — is caught. DES rows pass a LARGER eps to absorb
 *  Monte-Carlo sampling jitter. The knob-up convention: if the row bumps the knob DOWN (delta<0) we FLIP the
 *  observed sign, so every declared direction reads "as the knob RISES". A metric undefined on BOTH sides
 *  (NaN — not defined for that node) is genuinely unmoved (`0`); an appear/disappear (NaN on one side) is a change. */
function classify(before: number, after: number, flip: boolean, eps: number): Dir {
  if (Number.isNaN(before) && Number.isNaN(after)) return '0';
  const b = Number.isNaN(before) ? 0 : before;
  const a = Number.isNaN(after) ? 0 : after;
  let d = a - b;
  if (flip) d = -d;
  if (Math.abs(d) <= eps) return '0';
  return d > 0 ? '+' : '-';
}

describe('SENSITIVITY MATRIX — every knob × every metric, expected monotone direction', () => {
  // One `it` per matrix ROW keeps the failure message pinned to the exact knob+metric that regressed (a named
  // gap), instead of a single opaque assertion. The row's `expect` map is the reviewable contract.
  for (const row of MATRIX) {
    const mechanism = row.mechanism ?? 'scalar';
    const observe = row.observe ?? (row.instances.at(-1)?.id ?? '');
    // A TRANSFORM row moves a transform's `value` by `tfDelta`; a plain row moves a config knob by `delta`. The
    // knob-up convention flips the observed sign when the bump is negative, so every declared direction reads "up".
    const isTf = row.tfDelta !== undefined;
    const bumpDelta = isTf ? (row.tfDelta ?? 0) : row.delta;
    const flip = bumpDelta < 0;

    // Build the bumped (instances, wires) pair — a config bump, a port-transform bump, or a wire-transform bump.
    const bump = (): { instances: Instance[]; wires: Wire[] } => {
      if (isTf && row.tfWire !== undefined) return { instances: row.instances, wires: withWireTransformBump(row.wires, row.tfWire[0], row.tfWire[1], row.tfDelta ?? 0) };
      if (isTf && row.tfNode !== undefined && row.tfPort !== undefined) return { instances: withPortTransformBump(row.instances, row.tfNode, row.tfPort, row.tfDelta ?? 0), wires: row.wires };
      return { instances: withBump(row.instances, row.node, row.key, row.delta), wires: row.wires };
    };

    it(`${row.knob} — ${Object.entries(row.expect).map(([m, d]) => `${m}:${d}`).join(' ')}`, () => {
      const metrics = mechanism === 'des' ? DES_METRICS : SCALAR_METRICS;
      const read = (ins: Instance[], wrs: Wire[]): Record<Metric, number> =>
        mechanism === 'des'
          ? (readDes(ins, wrs, row.dropStation ?? observe) as unknown as Record<Metric, number>)
          : readScalar(ins, wrs, observe, row.downstream);
      const before = read(row.instances, row.wires);
      const bumped = bump();
      const after = read(bumped.instances, bumped.wires);

      // For every metric this row declares, the MEASURED direction must equal the EXPECTED one. A declared `+`
      // that measures `0` is the class of bug this suite exists to catch (deploymentMode→cost) — reported by key.
      // The scalar engine is deterministic ⇒ a tiny absolute eps (only float noise is `0`); the DES has sampling
      // jitter ⇒ a larger eps (≈ 0.5 req/s) so a stochastic wiggle is not misread as a real +/− response.
      const eps = mechanism === 'des' ? 0.5 : 1e-9;
      const bumpDesc = isTf ? `transform value +${row.tfDelta} on ${row.tfWire ? `wire ${row.tfWire[0]}→${row.tfWire[1]}` : `${row.tfNode}.${row.tfPort}`}` : `${String(row.key)} +${row.delta} on ${row.node}`;
      for (const m of metrics) {
        const want = row.expect[m];
        if (want === undefined) continue; // unobserved (n/a) for this knob
        const got = classify(before[m], after[m], flip, eps);
        expect(
          got,
          `knob "${row.knob}" (${bumpDesc}) → metric "${m}": expected ${want}, measured ${got} ` +
            `(before=${before[m]}, after=${after[m]})`,
        ).toBe(want);
      }
    });
  }

  // ── SLO band TIGHTENING → verdict FLIP (ok → violation). The observable is a verdict STATUS, not a metric value:
  //    the same design reads `ok` under a loose band and `violation` under a tight one. This proves the SLO surface
  //    is honest — a tightened target the design cannot meet MUST fire, never silently pass. ─────────────────────
  for (const flip of FLIP_ROWS) {
    it(`SLO flip: ${flip.label} — ${flip.node}.${String(flip.key)} ok → violation`, () => {
      const loose = verdictStatusOf(flip.instances, flip.wires, flip.node, flip.key, flip.loose);
      const tight = verdictStatusOf(flip.instances, flip.wires, flip.node, flip.key, flip.tight);
      expect(loose, `loose band should pass on ${flip.node}.${String(flip.key)}`).toBe('ok');
      expect(tight, `tightened band should FLIP to violation on ${flip.node}.${String(flip.key)}`).toBe('violation');
    });
  }

  // ── RED-DOCUMENTED gaps (task-78) — knobs whose declared metric MEASURES 0 / is non-monotone in this STEADY-STATE
  //    harness. Kept as `it.todo` with the gap NAMED, never faked green or deleted: the matrix stays honest. Each is
  //    a real, understood physics limitation (a transient a steady-state mean cannot show), not a broken relation. ──
  for (const gap of RED_DES_ROWS) it.todo(`RED (steady-state harness limitation): ${gap}`);

  it('the matrix is well-formed data (every declared direction is one of +/-/0, every knob is a real registry key)', () => {
    const known = new Set(Object.values(keys).map(String));
    for (const row of MATRIX) {
      expect(known.has(String(row.key)), `unknown registry key on row "${row.knob}"`).toBe(true);
      for (const [m, d] of Object.entries(row.expect)) {
        expect(['+', '-', '0', 'n/a'], `row "${row.knob}" metric ${m}`).toContain(d);
      }
      // A transform row must carry a coherent tf* spec (exactly one seam), and it declares only downstream metrics.
      if (row.tfDelta !== undefined) {
        const seams = [row.tfPort !== undefined && row.tfNode !== undefined, row.tfWire !== undefined].filter(Boolean).length;
        expect(seams, `transform row "${row.knob}" must name exactly one seam (port OR wire)`).toBe(1);
      }
    }
    // Every FLIP row's key must be a real registry key too.
    for (const flip of FLIP_ROWS) expect(known.has(String(flip.key)), `unknown registry key on flip "${flip.label}"`).toBe(true);
  });
});

// ── FLOW-SCOPED LAG — a DES-ONLY, PAIR-scoped observable the per-node metric grid
//    above cannot express (lag is a property of a source→terminal PATH, and its async queue wait is a time-domain
//    quantity the scalar never sees). Its own directional row: raising the async queue's SERVICE RATE (drainRate)
//    empties the backlog faster, so a change spends less time queued ⇒ the measured lag FALLS. ──────────────────────
describe('SENSITIVITY — flow-scoped lag vs the async queue service rate', () => {
  // A CDC pipeline: capture (originates 100/s) →ASYNC→ q (queue-mode buffer) →SYNC→ dest. lag(capture → dest)
  // crosses the async queue, so its backlog wait belongs to the lag — and only the DES can measure it.
  const pipeline = (drainRate: number): { instances: Instance[]; wires: Wire[] } => ({
    instances: [
      { id: 'capture', type: 'compute.service', config: { assumedRps: 100, latency: 20, concurrency: 100000 } },
      { id: 'q', type: 'queue.sqs', config: { queueMode: 1, drainRate, maxBacklog: 1000000 } },
      { id: 'dest', type: 'compute.service', config: { perRequestDuration: 5, concurrency: 100000 } },
    ],
    wires: [
      { from: ['capture', 'out'], to: ['q', 'in'], semantics: 'async' },
      { from: ['q', 'out'], to: ['dest', 'in'] },
    ],
  });
  const lagMeanMs = (drainRate: number): number => {
    const design = pipeline(drainRate);
    const g = instantiate(allManifests, design.instances, design.wires);
    if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
    // Same seed + window as the retry-feedback/matrix DES rows, so the numbers are pinned and reproducible.
    const sim = simulate(toQueueingNetwork(g.value), {
      seed: 76076, warmupCompletions: 8000, measureCompletions: 40000,
      lagPairs: [{ source: StationId('capture'), terminal: StationId('dest') }],
    });
    const p = sim.pairLag.find((x) => String(x.source) === 'capture' && String(x.terminal) === 'dest');
    if (p === undefined) throw new Error('no lag measured');
    return p.mean * 1000; // s → ms
  };

  it('q.drainRate ↑ ⇒ lag ↓ (a faster consumer empties the backlog, so the change waits less)', () => {
    const slow = lagMeanMs(115); // ρ_q ≈ 0.87 — a standing backlog, so a long queue wait
    const fast = lagMeanMs(300); // ρ_q ≈ 0.33 — the backlog barely forms
    expect(fast, `lag at drain 300 (${fast} ms) should be below lag at drain 115 (${slow} ms)`).toBeLessThan(slow);
  });
});
