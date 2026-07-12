// @algorithm Analytic queueing twin (M/M/c per node, critical-path folds, Dijkstra lag bound)
// @problem The canvas must show what users actually FEEL — queueing-aware latency, saturation, lag —
//   live on every edit, where the forward pass's no-queue service sum stays finite even past
//   saturation and a full DES is too slow.
// @approach Model every node as the SAME M/M/c station the DES builds (c = concurrency servers,
//   mu = 1/service; Erlang-C sojourn via engine mmc), fold real end-to-end latency as a memoized
//   cycle-guarded critical-path MAX over predecessors, fold caller-facing response over the sync
//   subtree per latencyComposition, and lower-bound flow lag with Dijkstra over every edge (the
//   simple O(V^2) selection — graphs are small).
// @complexity O(V + E) memoized folds; Dijkstra O(V^2); mmc O(c) per node.
// @citations Erlang C / M/M/c (via engine/sim/src/analytic.ts); Little's law; Dijkstra 1959.
// @invariants Agrees with the DES within tolerance (differential-tested); rho >= 1 answers Infinity
//   honestly (unbounded queue), never a finite lie; the ideal (no-queue) figure is kept alongside,
//   demoted not deleted.
// @where-tested content/sda/src/queueing.e2e.test.ts (analytic vs DES),
//   content/sda/src/response-latency.e2e.test.ts, content/sda/src/origin-latency.e2e.test.ts,
//   content/sda/src/headroom.test.ts

import { applyTransform, type Graph, type Key, type Node, type Transform } from '@sda/engine-core';
import { mmc } from '@sda/engine-sim';
import { keys } from './registry';
import { PURE_DELAY, cfg, cpuStation, queueStation } from './graph-read';

// REAL (queueing-aware) latency — the analytic twin of the DES, cheap enough for the hot path so the canvas
// and footer can show what users actually feel, live on every edit. The forward pass gives the no-queue sum
// of service times (the IDEAL); under load a tier queues, and the real latency inflates non-linearly as its
// utilisation ρ→1 (and is UNBOUNDED at ρ≥1 — the queue grows without limit → timeouts). We model each node as
// the SAME M/M/c station the DES does (content/sim.ts: c = concurrency servers, μ = 1/service), so the two
// agree (differential-tested). This is content, not the engine: it knows SDA keys (throughput, concurrency,
// perRequestDuration) — the engine stays domain-agnostic.

/** A node's real per-hop latency: its own service time inflated by the wait its offered load induces. */
export interface NodeQueue {
  readonly rho: number; // utilisation λ/(cμ) = offered/capacity; ≥ 1 ⇒ saturated (unbounded wait)
  readonly serviceMs: number; // own service time, no queue — the "ideal" (a pooled store's is its connection hold time)
  readonly sojournMs: number; // REAL per-hop latency incl. queue wait; Infinity when ρ ≥ 1
  readonly servers: number; // c servers (pool slots for a pooled store; PURE_DELAY ⇒ a pure delay that never queues)
  readonly offered: number; // REAL load reaching this node = Σ upstream delivered throughput, rps
  readonly capacity: number; // this node's REAL capacity (c·μ for an M/M/c tier, else its throughput ceiling), rps
}

// ── shared helpers — one definition each, reused by the projectors below (the FOLDS stay separate: a forward
//    MAX-over-predecessors vs a backward compose-over-successors are different algebras and read clearer apart). ──
/** Index every node by its string id. */
const nodeIndex = (graph: Graph): Map<string, Node> => {
  const m = new Map<string, Node>();
  for (const node of graph.nodes.values()) m.set(String(node.id), node);
  return m;
};
/** Predecessor adjacency (downstream ← upstream) as node-id lists — one (possibly empty) entry per node. */
const predecessorsOf = (graph: Graph): Map<string, string[]> => {
  const preds = new Map<string, string[]>();
  for (const id of graph.nodes.keys()) preds.set(String(id), []);
  for (const e of graph.edges.values()) {
    const from = graph.ports.get(e.from)?.node;
    const to = graph.ports.get(e.to)?.node;
    if (from !== undefined && to !== undefined) preds.get(String(to))?.push(String(from));
  }
  return preds;
};
/**
 * The REAL offered load reaching each node, TRANSFORM-AWARE.
 * The raw predecessor throughput is NOT what a node sees when the edge carries a transform: a per-wire routing
 * split (70/30) or a per-port ratio(100) reshapes it. So we walk EDGES and apply the SAME OUT-side resolution the
 * engine seam uses — the WIRE's transform WINS over the source out-port's f_out — then the target IN-port's f_in on
 * that port's fan-in sum. Without this, ρ would read a gateway's FULL rate at every fan-out target and FALSELY
 * report an overload the split prevents (exactly the stress-campaign bug). Returns a per-node offered rps; a node
 * with no inbound edge is absent (a source offers load, it does not receive it). Mirrors engine/solve's `flowInflow`.
 */
const offeredLoadOf = (graph: Graph, value: (id: string, key: Key) => number | undefined): Map<string, number> => {
  // Group each target node's inbound edges by its IN-port, so f_in applies to the whole port fan-in (as the engine does).
  const byNodePort = new Map<string, Map<string, { fOut: Transform | undefined; up: string }[]>>();
  const fInOf = new Map<string, Transform | undefined>(); // `${node}\x00${port}` → the in-port's transform
  for (const e of graph.edges.values()) {
    const from = graph.ports.get(e.from);
    const to = graph.ports.get(e.to);
    if (from === undefined || to === undefined) continue;
    const node = String(to.node);
    const port = String(e.to);
    fInOf.set(`${node}\x00${port}`, to.transform);
    const ports = byNodePort.get(node) ?? new Map();
    const list = ports.get(port) ?? [];
    list.push({ fOut: e.transform ?? from.transform, up: String(from.node) }); // wire override > source port f_out
    ports.set(port, list);
    byNodePort.set(node, ports);
  }
  const out = new Map<string, number>();
  for (const [node, ports] of byNodePort) {
    let offered = 0;
    for (const [port, edges] of ports) {
      // this in-port's fan-in = SUM of each edge's f_out(served_up); then f_in on the port's whole intake
      const portSum = edges.reduce((s, ed) => s + applyTransform(ed.fOut, value(ed.up, keys.throughput) ?? 0), 0);
      offered += applyTransform(fInOf.get(`${node}\x00${port}`), portSum);
    }
    out.set(node, offered);
  }
  return out;
};

/** Successor adjacency (upstream → downstream) with each edge's async flag — one entry per node. */
const successorsOf = (graph: Graph): Map<string, { to: string; async: boolean }[]> => {
  const succ = new Map<string, { to: string; async: boolean }[]>();
  for (const id of graph.nodes.keys()) succ.set(String(id), []);
  for (const e of graph.edges.values()) {
    const from = graph.ports.get(e.from)?.node;
    const to = graph.ports.get(e.to)?.node;
    if (from !== undefined && to !== undefined) succ.get(String(from))?.push({ to: String(to), async: e.semantics === 'async' });
  }
  return succ;
};
/** A node's OWN real latency: its queue-inflated sojourn if it queues, else its static latency config (a source
 *  ⇒ its own latency, usually 0) — the single definition of the "own term" every latency projector shares. */
const ownLatency = (node: Node | undefined, q: NodeQueue | undefined): number => q?.sojournMs ?? (node ? cfg(node, keys.latency) ?? 0 : 0);

/**
 * A node's REAL capacity ceiling (rps) — the ONE definition of "how much can this tier serve": an M/M/c tier (it
 * carries a `concurrency` knob) serves c·μ (servers × per-server completions/s); a POOLED store/proxy (a
 * `connectionPool` + `connectionHeldMs`, no concurrency) likewise serves c·μ = pool/held via its {@link queueStation}
 * (which EQUALS its declared throughput ceiling by construction); a plain fixed-throughput component (cache,
 * gateway…) serves its declared `throughput` ceiling. Reading c·μ for that last case would put c at PURE_DELAY ⇒
 * astronomical capacity ⇒ ρ≈0 even AT the ceiling — a lie the tool must not tell. Shared by {@link nodeQueues}
 * (below) AND the Tier-1 time-sweep's self-origin ρ (time-sweep.ts), so the analytic capacity reads identically
 * wherever it is needed and can never drift into two formulas.
 */
export function nodeCapacityRps(node: Node): number {
  const st = queueStation(node); // the BINDING station (concurrency / pool / CPU) — c servers + per-server service ms
  const concurrency = cfg(node, keys.concurrency); // undefined ⇒ a fixed-throughput / pooled component (no M/M/c knob)
  const mu = st.serviceMs > 0 ? 1000 / st.serviceMs : Infinity; // per-server completions/s
  if (concurrency !== undefined) return st.servers * mu; // an M/M/c tier serves c·μ of its binding station (a CPU ceiling binds here too)
  const throughput = cfg(node, keys.throughput); // a declared fixed ceiling (cache/gateway/proxy), else a relation (undefined)
  if (throughput === undefined) return st.servers * mu; // pooled proxy: c·μ = pool/held (throughput is a relation, invisible to cfg)
  // A fixed-throughput component serves its declared ceiling — UNLESS it ALSO declares a CPU resource that binds
  // LOWER (cores/cpuTime); then the CPU is the real bottleneck (min of the two ceilings). No CPU config ⇒ Math.min
  // with Infinity returns `throughput` unchanged — BYTE-IDENTICAL to before (the sacred pin).
  const cpu = cpuStation(node);
  return cpu === undefined ? throughput : Math.min(throughput, stationCapacityRps(cpu)); // rps
}

/** The rps ceiling c·μ of a CPU (or any) station — cores × completions/s. Local mirror of graph-read's private
 *  `stationCapacity`, used ONLY to cap a fixed-throughput node by its CPU when both are declared. */
const stationCapacityRps = (st: { readonly servers: number; readonly serviceMs: number }): number =>
  st.servers * (st.serviceMs > 0 ? 1000 / st.serviceMs : Infinity);

/**
 * Per-node real latency, computed instantly from the forward-pass throughput (no simulation). A node's
 * OFFERED load is the throughput its predecessors actually deliver (`value(pred, throughput)`); its capacity
 * is c·μ. Sources (no predecessor) are skipped — they offer load, not receive it. Keyed by node id string.
 */
export function nodeQueues(graph: Graph, value: (id: string, key: Key) => number | undefined): Map<string, NodeQueue> {
  const preds = predecessorsOf(graph);
  const offeredLoad = offeredLoadOf(graph, value); // TRANSFORM-AWARE offered load (per-wire splits + port transforms)

  const out = new Map<string, NodeQueue>();
  for (const node of graph.nodes.values()) {
    const id = String(node.id);
    const ps = preds.get(id) ?? [];
    if (ps.length === 0) continue; // a load source

    // The M/M/c station this node forms (graph-read `queueStation`, shared with the DES `poolStation` so the two
    // engines cannot drift): a concurrency tier ⇒ c = concurrency × fleet, service = perRequestDuration/latency; a
    // pooled datastore/proxy (no `concurrency` but a `connectionPool` + `connectionHeldMs`) ⇒ c = the pool slots,
    // service = the connection hold time h — so it QUEUES BY PHYSICS (calibration #3), c·μ = pool/held = its
    // throughput ceiling; a CPU-bound tier (`cpuCores` + `cpuTimePerRequestMs`) ⇒ c = cores, service = the CPU time,
    // and when several resources are declared the BINDING (lowest-capacity) one owns the queue. A node with none
    // stays PURE_DELAY (never queues). No branch on component TYPE.
    const st = queueStation(node);
    const serviceMs = st.serviceMs; // per-server service (the pool's hold time for a pooled store, the CPU time for a CPU tier)
    const servers = st.servers; // pool slots for a pooled store, else concurrency × fleet; PURE_DELAY when unbounded
    // The REAL load reaching this node — its inbound edges' transformed contributions, NOT the raw predecessor
    // throughput (a 70/30 split or a ratio(100) reshapes it; ignoring that FALSELY overloads a fan-out target).
    const offered = offeredLoad.get(id) ?? 0; // rps
    const mu = serviceMs > 0 ? 1000 / serviceMs : Infinity; // per-server completions/s
    // A node's REAL capacity — the ONE definition in `nodeCapacityRps` (shared with the time-sweep): an M/M/c tier
    // (concurrency knob) serves c·μ of its BINDING station (a CPU ceiling binds here too); a fixed-throughput
    // component (cache, gateway, db.sql…) serves its declared ceiling — which for a POOLED store EQUALS c·μ =
    // pool/held by construction (byte-identical, only the tail is new), UNLESS it declares a CPU resource that binds
    // lower (min of the two). Reading c·μ for a non-pooled fixed-throughput tier would put c at PURE_DELAY ⇒
    // astronomical capacity ⇒ ρ≈0 even AT the ceiling — a lie the tool must not tell; `nodeCapacityRps` reads the
    // declared throughput instead. Using the shared fn keeps ρ and the CPU-min consistent with the canvas capacity.
    const capacity = nodeCapacityRps(node); // rps (mu below still drives the sojourn's mmc)
    const rho = capacity > 0 && Number.isFinite(capacity) ? offered / capacity : 0;

    let sojournMs: number;
    if (serviceMs <= 0 || offered <= 0 || servers >= PURE_DELAY) {
      sojournMs = serviceMs; // pure delay / idle / no service time ⇒ no queue
    } else {
      const m = mmc(offered, mu, servers);
      sojournMs = m.W === Infinity ? Infinity : m.W * 1000; // s → ms
    }
    out.set(id, { rho, serviceMs, sojournMs, servers, offered, capacity });
  }
  return out;
}

/**
 * Each node's REAL end-to-end latency: the queue-inflated sojourn accumulated along its CRITICAL (slowest)
 * incoming path — the queueing-aware twin of the engine's ideal cumulative `latency` (which only sums service
 * times). `Infinity` once any tier on the path saturates (ρ≥1). This is the ONE end-to-end latency every
 * surface should verdict against (canvas, System panel, Inspector verdict, design doc) so they never disagree
 * — the engine can't compute it (it's domain-agnostic; the queue model is content). Fan-in safe: a node takes
 * the MAX over its predecessors (the tail is set by the slowest branch), so it is never double-counted.
 */
export function realCumulativeLatency(
  graph: Graph,
  value: (id: string, key: Key) => number | undefined,
  queues?: Map<string, NodeQueue>,
): Map<string, number> {
  const q = queues ?? nodeQueues(graph, value);
  const preds = predecessorsOf(graph);
  const nodeById = nodeIndex(graph);
  const own = (id: string): number => ownLatency(nodeById.get(id), q.get(id));
  const memo = new Map<string, number>();
  const onPath = new Set<string>();
  const cum = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (onPath.has(id)) return own(id); // cycle guard: don't recurse through a loop
    onPath.add(id);
    const ps = preds.get(id) ?? [];
    const upstream = ps.length === 0 ? 0 : Math.max(...ps.map(cum));
    onPath.delete(id);
    const r = upstream + own(id);
    memo.set(id, r);
    return r;
  };
  const out = new Map<string, number>();
  for (const id of preds.keys()) out.set(id, cum(id));
  return out;
}

/**
 * Each node's REAL request→response latency: its own queueing sojourn PLUS the responses of what it
 * SYNCHRONOUSLY calls, combined by the node's `latencyComposition` knob — 0 sequential (sum), 1 parallel /
 * scatter-gather (max, the critical path), 2 fastest / hedged (min); default 0, the conservative bound. This
 * accumulates from the LEAVES UP (a caller waits for what it calls) — the mirror of realCumulativeLatency's
 * source→node fold. Async downstream is decoupled and EXCLUDED; a saturated (∞) synchronous dependency
 * propagates ∞ up every caller. It is the caller-facing latency the canvas / MCP / design-doc display; the
 * engine can't compute it (M/M/c is content). Fan-out safe (each subtree once) and cycle-guarded.
 */
export function responseLatency(graph: Graph, value: (id: string, key: Key) => number | undefined, queues?: Map<string, NodeQueue>): Map<string, number> {
  const q = queues ?? nodeQueues(graph, value);
  const succ = successorsOf(graph);
  const nodeById = nodeIndex(graph);
  const own = (id: string): number => ownLatency(nodeById.get(id), q.get(id));
  // Combine the SYNC children's responses per this node's composition (default sequential = sum).
  const combine = (id: string, kids: readonly number[]): number => {
    if (kids.length === 0) return 0;
    const node = nodeById.get(id);
    const mode = Math.round((node ? cfg(node, keys.latencyComposition) : undefined) ?? 0);
    return mode === 1 ? Math.max(...kids) : mode === 2 ? Math.min(...kids) : kids.reduce((a, b) => a + b, 0);
  };
  const memo = new Map<string, number>();
  const onPath = new Set<string>();
  const resp = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (onPath.has(id)) return own(id); // cycle guard: don't recurse through a loop
    onPath.add(id);
    const kids = (succ.get(id) ?? []).filter((e) => !e.async).map((e) => resp(e.to));
    onPath.delete(id);
    const r = own(id) + combine(id, kids);
    memo.set(id, r);
    return r;
  };
  const out = new Map<string, number>();
  for (const id of succ.keys()) out.set(id, resp(id));
  return out;
}

/**
 * A SCALAR LOWER BOUND on the mean flow-scoped LAG from `source` to `terminal`:
 * the sum of each stage's OWN response latency along the CHEAPEST (least-latency) path between them, EXCLUDING the
 * terminal's own term (the DES stamps lag at the terminal's ARRIVAL, before it serves — so its sojourn is not yet
 * incurred). It is a genuine LOWER bound because an async queue's real backlog wait is a TIME-DOMAIN quantity the
 * scalar cannot see (a queue-mode node carries ~0 own latency here — its waiting-line dynamics live only in the
 * DES), so the true lag is always ≥ this. Consequently the scalar can PROVE a violation (even the optimistic bound
 * exceeds the ceiling) but never prove `ok` — that needs the sim. `Infinity` when the only path crosses a saturated
 * (ρ≥1) tier (an unbounded lag — a provable breach); `NaN` when `source` cannot reach `terminal` at all.
 *
 * Dijkstra over the directed graph following EVERY edge (sync AND async — lag includes async hops, unlike the
 * response cut), node-weighted by `ownLatency`; graphs are small, so the simple O(V²) selection is ample.
 */
export function lagLowerBoundMs(
  graph: Graph,
  value: (id: string, key: Key) => number | undefined,
  source: string,
  terminal: string,
  queues?: Map<string, NodeQueue>,
): number {
  const q = queues ?? nodeQueues(graph, value);
  const succ = successorsOf(graph);
  const nodeById = nodeIndex(graph);
  if (!nodeById.has(source) || !nodeById.has(terminal)) return NaN; // an endpoint is not a node ⇒ no flow to bound
  if (source === terminal) return 0;
  const own = (id: string): number => ownLatency(nodeById.get(id), q.get(id));
  // dist[u] = the least Σ own(node) over nodes on a path from `source` UP TO (not including) u. Relaxing u → v adds
  // own(u), so the terminal's own term is never added — it is excluded exactly as the DES lag excludes it.
  const dist = new Map<string, number>([[source, 0]]);
  const visited = new Set<string>();
  for (;;) {
    // pick the unvisited reachable node of least distance (∞ allowed: a saturated-only path is a real ∞ lag, not
    // "unreachable" — which stays absent from `dist` and yields NaN below).
    let u: string | undefined;
    let best = Infinity;
    let found = false;
    for (const [id, d] of dist) {
      if (visited.has(id)) continue;
      if (!found || d < best) { best = d; u = id; found = true; }
    }
    if (!found || u === undefined) break; // every reachable node settled; terminal never reached ⇒ NaN
    if (u === terminal) return dist.get(terminal) as number;
    visited.add(u);
    const nd = (dist.get(u) as number) + own(u); // ∞ propagates through a saturated hop
    for (const e of succ.get(u) ?? []) {
      if (visited.has(e.to)) continue;
      const cur = dist.get(e.to);
      if (cur === undefined || nd < cur) dist.set(e.to, nd);
    }
  }
  return NaN; // no path source → terminal
}

/** The composition of a node's response latency for display: `base` = its constant declared service time;
 *  `queue` = the penalty it ADDS by not keeping up (real own − base — the cascade source that lengthens every
 *  synchronous caller's response); `downstream` = the latency it INHERITS from what it synchronously calls.
 *  base + queue + downstream = response. A saturated tier's queue is ∞; a node waiting on a saturated dependency
 *  has an ∞ downstream. Pure display decomposition of the already-solved queueing/response values. */
export interface LatencyParts {
  readonly base: number;
  readonly queue: number;
  readonly downstream: number;
  readonly response: number;
}
export function latencyBreakdown(graph: Graph, value: (id: string, key: Key) => number | undefined, queues?: Map<string, NodeQueue>): Map<string, LatencyParts> {
  const q = queues ?? nodeQueues(graph, value);
  const resp = responseLatency(graph, value, q);
  const nodeById = nodeIndex(graph);
  const out = new Map<string, LatencyParts>();
  for (const [id, node] of nodeById) {
    const nq = q.get(id);
    const base = nq?.serviceMs ?? (node ? cfg(node, keys.latency) ?? 0 : 0); // declared service (a source ⇒ its own latency, usually 0)
    const own = ownLatency(node, nq); // real own incl queue wait (= base for a source, which has no queue)
    const response = resp.get(id) ?? own;
    const queue = Number.isFinite(own) ? Math.max(0, own - base) : Infinity; // this tier's congestion (∞ when saturated)
    const downstream = !Number.isFinite(own) ? 0 : !Number.isFinite(response) ? Infinity : Math.max(0, response - own);
    out.set(id, { base, queue, downstream, response });
  }
  return out;
}
