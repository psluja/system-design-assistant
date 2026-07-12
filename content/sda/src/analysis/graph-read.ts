import type { Edge, Key, Node, Port, Transform } from '@sda/engine-core';
import { keys } from '../vocabulary/registry';

// Shared design-time reads for the queueing projectors. The analytic model (queueing.ts → nodeQueues) and the DES
// projector (sim.ts → toQueueingNetwork) are differential-tested against each other, so they MUST read a node's
// capacity identically — these are the single definitions both import, rather than two copies that can drift.

/** "No concurrency cap" ⇒ this many servers — effectively a pure delay that never queues. */
export const PURE_DELAY = 100_000;

/** A node's fixed config value for a key (its design-time assumption), or undefined if it declares none. */
export function cfg(node: Node, key: Key): number | undefined {
  for (const c of node.cells) {
    if (c.kind === 'input' && c.key === key && c.value.kind === 'fixed') return c.value.quantity.value;
  }
  return undefined;
}

/** A replicated / demand-sized fleet's unit count: `replicas` or `maxUnits`, else a single unit. */
export const fleetOf = (node: Node): number => cfg(node, keys.replicas) ?? cfg(node, keys.maxUnits) ?? 1;

/** The M/M/c server count: `concurrency` slots PER unit × the fleet size (a 2-task fleet has twice the servers). A
 *  component with no concurrency knob is modelled as a PURE DELAY (never queues). This is THE definition both the
 *  analytic and the DES projector use, so the analytic ⇄ DES differential guarantee cannot silently break. */
export const serverCount = (node: Node): number => {
  const concurrency = cfg(node, keys.concurrency);
  return concurrency !== undefined ? concurrency * fleetOf(node) : PURE_DELAY;
};

/** The M/M/c queue STATION a node forms — its server count `c` and per-server mean service time (ms). */
export interface QueueStation {
  readonly servers: number; // c — finite ⇒ the tier queues; PURE_DELAY ⇒ a pure delay that never queues
  readonly serviceMs: number; // per-server mean service time; μ = 1000/serviceMs per second (c·μ = the capacity)
}

/** The per-second capacity c·μ a station serves — servers × completions/s (Infinity for a zero-service pure delay).
 *  Used ONLY to pick the binding station when a node declares several resources; never widens/narrows a station. */
const stationCapacity = (st: QueueStation): number => st.servers * (st.serviceMs > 0 ? 1000 / st.serviceMs : Infinity);

/**
 * The CPU-core M/M/c station a node forms when it declares BOTH `cpuCores` (parallel-execution width — hardware
 * threads / vCPUs it can burn at once) and `cpuTimePerRequestMs` (the CPU time ONE request costs): c = cpuCores,
 * per-server service = the CPU time, so c·μ = cpuCores / cpuTime is the CPU throughput ceiling. Absent EITHER ⇒
 * undefined (no CPU ceiling; the node is byte-identical to before — the SACRED PIN). This is the THIRD resource a
 * node can be bound by (alongside its own concurrency and a connection pool); {@link queueStation} picks the BINDING
 * one. Pure config read, NO branch on component TYPE — a node gains a CPU ceiling ONLY by config (closed framework).
 */
export function cpuStation(node: Node): QueueStation | undefined {
  const cores = cfg(node, keys.cpuCores);
  const cpuMs = cfg(node, keys.cpuTimePerRequestMs);
  if (cores === undefined || !(cores > 0) || cpuMs === undefined || !(cpuMs > 0)) return undefined;
  return { servers: Math.max(1, Math.round(cores)), serviceMs: cpuMs }; // integer c (Erlang-C); μ = 1/cpuTime ⇒ c·μ = cores/cpuTime
}

/**
 * The concurrency / connection-pool station a node forms — the ORIGINAL station logic, unchanged. Split out so
 * {@link queueStation} can weigh a CPU station ALONGSIDE it without disturbing this path: a node with no CPU config
 * gets EXACTLY this, byte-for-byte (the sacred pin). Pure config read, NO branch on component TYPE:
 *   • a node with a `concurrency` knob is already a finite-server station (c = concurrency × fleet, service = its
 *     `perRequestDuration`, else its `latency`): its own M/M/c owns the queue;
 *   • a fixed-throughput node (no `concurrency` ⇒ PURE_DELAY servers) that declares a `connectionPool` +
 *     `connectionHeldMs` is a FINITE connection POOL that QUEUES BY PHYSICS — c = the pool slots, service = the
 *     hold time h, so c·μ = pool/held EXACTLY equals its declared `throughput` ceiling (capacity is unmoved; only
 *     the queueing TAIL is new). This is the datastore / RDS-Proxy case (calibration #1 for the DES, #3 for the
 *     analytic twin);
 *   • any other node stays a PURE DELAY (unbounded servers) that never queues.
 * A node that already has a real (concurrency-bound) station keeps it — the pass-through pool budget never
 * overrides its own service parallelism (the first clause wins). We read the pool primitives DIRECTLY (they are
 * fixed configs; `throughput` may be a relation, invisible to `cfg`).
 */
function baseStation(node: Node): QueueStation {
  const servers = serverCount(node);
  const serviceMs = cfg(node, keys.perRequestDuration) ?? cfg(node, keys.latency) ?? 0;
  if (servers < PURE_DELAY) return { servers, serviceMs }; // a concurrency-bound station already owns its queue
  const pool = cfg(node, keys.connectionPool); // c: the pooled-connection budget (a fixed config)
  const heldMs = cfg(node, keys.connectionHeldMs); // h: how long one request holds a pooled connection (ms)
  if (pool === undefined || !(pool > 0) || heldMs === undefined || !(heldMs > 0)) return { servers, serviceMs }; // no pool ⇒ pure delay
  return { servers: Math.max(1, Math.round(pool)), serviceMs: heldMs }; // finite pool: c = slots, μ = 1/held ⇒ c·μ = pool/held
}

/**
 * The M/M/c queue station a node forms — the ONE definition the analytic twin (queueing.ts `nodeQueues`) and the
 * DES projector (sim.ts `poolStation`) BOTH read, so the two engines can never drift on HOW a node queues. It is
 * the node's concurrency/pool station ({@link baseStation}) UNLESS the node also declares a CPU station
 * ({@link cpuStation}) that binds LOWER, in which case the CPU is the real bottleneck. Pure config read, NO branch
 * on component TYPE. A node with no CPU config gets EXACTLY {@link baseStation} — byte-for-byte the pre-CPU
 * behaviour (the sacred pin, property-tested). When both resources are declared, the two in-series resources are
 * modelled as the MIN (lowest capacity), NOT a tandem queueing network — the honest SIMPLE model; the DEEP
 * allocator/GC/contention economics is out of domain (flagged unmodeled).
 */
export function queueStation(node: Node): QueueStation {
  const base = baseStation(node);
  const cpu = cpuStation(node);
  if (cpu === undefined) return base; // no CPU ceiling ⇒ EXACTLY the original station (byte-identical — the sacred pin)
  return stationCapacity(cpu) < stationCapacity(base) ? cpu : base; // the BINDING resource (lower c·μ) owns the queue
}

/**
 * The MEAN per-completion multiplicity a flow transform induces on an edge.
 * ratio(k) and prob(p) map directly to a mean count (k, or a Bernoulli(p)); batch(n) thins 1/n. cap/window are rate
 * CEILINGS whose effect depends on the offered rate — a memoryless per-completion route cannot see that rate, so
 * they induce NO thinning here (their steady-state effect is the forward-pass throttle + overflow verdict). THE ONE
 * DEFINITION both the DES route-edge projector (sim.ts) and the analytic response-latency composition (queueing.ts)
 * read, so the two engines can never drift on what a transform means for a single completion. Moved here (from
 * sim.ts, byte-identical) so a SECOND consumer could not silently diverge.
 */
export function transformFactor(t: Transform | undefined): number {
  if (t === undefined) return 1;
  switch (t.kind) {
    case 'ratio':
    case 'prob':
      return t.value;
    case 'batch':
      return 1 / t.value;
    case 'cap':
    case 'window':
      return 1; // a ceiling, not a mean thinning — see the note above
    case 'generate':
      return 1; // a generator ORIGINATES at the node; the port's route edges relay the served flow untouched — identity
  }
}

/**
 * The MEAN per-completion multiplicity a single EDGE delivers, resolved the ONE way both engines read it (doc:
 * flow-transformations-r2 §5): the WIRE's transform WINS over the source out-port's default (a per-wire routing
 * split overrides broadcast fan-out), then the target IN-port's transform applies on top (its own consumption
 * shape) — the two seams compose by PRODUCT, never added. Absent everywhere ⇒ 1 (today's untransformed edge,
 * byte-identical). Shared by sim.ts's DES routing and queueing.ts's response-latency composition.
 */
export function edgeMultiplicity(edge: Edge, from: Port | undefined, to: Port | undefined): number {
  return transformFactor(edge.transform ?? from?.transform) * transformFactor(to?.transform);
}
