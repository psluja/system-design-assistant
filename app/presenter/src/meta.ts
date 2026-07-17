// Human-facing DESCRIPTIONS + LABELS for every metric, knob and component family — the copy that makes the tool
// legible. Lives in the presenter (not one shell) so EVERY surface labels a key the SAME way: the web Inspector,
// the VS Code native Inspector tree and the Problems panel all read "Throughput", "Latency (real)", … from ONE
// table — a label can never drift between shells. Presentation only; the engine/registry stay domain-agnostic.
// Moved verbatim from app/web/src/meta.ts (which is now a re-export stub).

export interface KeyInfo {
  readonly label: string;
  readonly unit: string; // shown inline; '' = dimensionless
  readonly desc: string; // the COMPUTED metric / SLO meaning (cumulative along the path) — for Verdict & SLO
  readonly cfg?: string; // the local INPUT meaning (this component's own value) — for Configuration; falls back to desc
}

export const KEY_INFO: Record<string, KeyInfo> = {
  throughput: { label: 'Throughput', unit: 'req/s', desc: 'Throughput reaching this node — the BOTTLENECK: the minimum capacity of any hop on the path up to here.', cfg: 'This component’s OWN capacity — the max requests/second it can serve before it overflows.' },
  latency: { label: 'Latency', unit: 'ms', desc: 'END-TO-END latency UP TO this node: every hop’s delay SUMS along the synchronous path (an async hop doesn’t add to the caller’s wait). To bound the whole chain, set this SLO on the LAST node. Mean, not tail — run Simulate for p99.', cfg: 'The delay THIS component alone adds to a request (its own service hop). The path total is the sum of these along the chain.' },
  tailLatency: { label: 'Tail latency (p99)', unit: 'ms', desc: 'The p99 (tail) of end-to-end latency — what the unluckiest 1% of requests feel, verified against the SIMULATED tail (not the mean). An INDEPENDENT SLO from the mean latency: set both at once.' },
  cost: { label: 'Cost', unit: '$/mo', desc: 'Total monthly cost UP TO this node — it SUMS this node plus everything upstream. The figure at the last node is the system total.', cfg: 'This component’s OWN monthly cost.' },
  availability: { label: 'Availability', unit: 'ratio', desc: 'Availability of the whole path UP TO this node (0–1, e.g. 0.999 = “three nines”): it MULTIPLIES across every dependency in series, so it only drops as you add hops. To bound the chain, set this SLO on the terminal node.', cfg: 'This component’s OWN uptime (0–1). The path availability is the product of these.' },
  durability: { label: 'Durability', unit: 'ratio', desc: 'Durability across every store on the path up to here (0–1, e.g. 0.99999999999 = “eleven nines”): it MULTIPLIES, so data is only as safe as the weakest store it must survive.', cfg: 'This store’s OWN durability (0–1).' },
  overflow: { label: 'Overflow', unit: 'req/s', desc: 'Offered load BEYOND capacity — requests rejected, dropped or throttled. > 0 means this node is overloaded: size it up, cache in front of it, or shed load.' },
  concurrency: { label: 'Concurrency', unit: '', desc: 'How many requests the component handles AT ONCE (worker / thread / connection pool). Capacity follows Little’s law: concurrency ÷ per-request time.' },
  perRequestDuration: { label: 'Per-request time', unit: 'ms', desc: 'Service time to handle ONE request. With concurrency it sets capacity: capacity = concurrency ÷ (time ÷ 1000).' },
  cpuCores: { label: 'CPU cores', unit: '', desc: 'CPU width a CPU-bound tier can burn AT ONCE (hardware threads / vCPUs). With CPU time per request it forms a CPU queueing station: capacity = cores ÷ (CPU time ÷ 1000). Set both to model a framework/proxy that saturates on CPU before its DB.', cfg: 'How many CPU cores/threads this node executes in parallel. Combined with the CPU time per request it caps throughput at cores ÷ (CPU time ÷ 1000) — the node’s ceiling is whichever resource (CPU, concurrency, pool, throughput) binds first.' },
  cpuTimePerRequestMs: { label: 'CPU time / request', unit: 'ms', desc: 'CPU time ONE request costs on this node. With CPU cores it sets the CPU ceiling: capacity = cores ÷ (time ÷ 1000). A CPU-bound front-end (web framework, nginx/Thrift) saturates on CPU at low load, before any database.', cfg: 'The CPU milliseconds one request burns here. Paired with CPU cores it makes this an M/M/cores CPU station; its p99 rises with load and raising cores (or lowering this) lowers the ceiling pressure.' },
  replicas: { label: 'Replicas', unit: '', desc: 'Horizontal copies of the component. Capacity scales linearly with the number of replicas.' },
  deploymentMode: { label: 'Deployment mode', unit: '', desc: 'Redundancy tier — Single-AZ, Multi-AZ or Multi-Region. Selects the PUBLISHED AWS SLA for this component (Multi-AZ/Region raise availability) and roughly doubles the bill for the billed standby/replica.' },
  maxUnits: { label: 'Max units', unit: '', desc: 'Ceiling on auto-scaling units/tasks (a service or account quota). The fleet cannot scale past this — exceed it and you overflow.' },
  requiredUnits: { label: 'Required units', unit: '', desc: 'How many units/tasks the offered load actually needs (demand-driven sizing). If this is above Max units, requests are dropped.' },
  unitCost: { label: 'Base cost', unit: '$/unit·mo', desc: 'The BASE price rate this component’s cost is built from. Its monthly cost = this base × the driver it scales with (units, replicas, throughput or concurrency). Edit it to model a different price tier or region.', cfg: 'The base price rate (per unit / replica / req·s / concurrency·month). The component’s monthly cost multiplies this by what it scales with.' },
  backlog: { label: 'Backlog growth', unit: 'msg/s', desc: 'Net rate the queue grows. > 0 means messages pile up without bound — the consumer cannot keep up (unstable). Keep it ≤ 0.' },
  queueMode: { label: 'Act as queue', unit: '', desc: 'Treat this component as a queue/buffer (SQS, a Redis list, SELECT … FOR UPDATE SKIP LOCKED). Turns on the backlog stability check.' },
  drainRate: { label: 'Drain rate', unit: 'msg/s', desc: 'Fallback consumer pull rate, used only when no consumer is wired downstream in the graph.' },
  retention: { label: 'Retention', unit: 's', desc: 'How long an unconsumed message survives before it is dropped.' },
  maxBacklog: { label: 'Max backlog', unit: 'msg', desc: 'How many queued messages the component can hold before it errors / drops.' },
  arrivalRate: { label: 'Arrival rate', unit: 'msg/s', desc: 'Offered ingress rate from the producers.' },
  // UNIVERSAL ASSUMED TRAFFIC (registry `assumedRps`) — the traffic a node ORIGINATES itself (any node can be a
  // traffic source, not only a client.*). A fact-assumption input (it lives in the Inspector's "Assumptions (facts
  // about your world)" section); folded into the node's emitted throughput at a source, so downstream sees it as
  // ordinary inflow.
  assumedRps: { label: 'Assumed traffic', unit: 'req/s', desc: 'How much traffic we ASSUME enters here. A fact-assumption about your world, not a goal — the engine computes whether the system sustains it.' },
  // RETRY POLICY — caller-side knobs on the CALLING node. Default 0 ⇒ no retries (today's
  // behaviour, bit-for-bit). They shape only the simulation; the goodput/error outcome below is what they produce.
  timeoutMs: { label: 'Timeout', unit: 'ms', desc: 'Per-attempt deadline: the caller gives up on an attempt that takes longer than this (queue wait + service). 0 = no timeout. Only affects the simulation.', cfg: 'How long this caller waits for one attempt before it times out and (if retries remain) tries again. 0 = wait forever (no retries).' },
  retryCount: { label: 'Retry attempts', unit: '', desc: 'Extra attempts after the first when an attempt times out. 0 = fail immediately on the first timeout.', cfg: 'How many times this caller retries a request after the first attempt times out. 0 = no retries.' },
  retryBackoffMs: { label: 'Retry backoff', unit: 'ms', desc: 'Fixed delay before a timed-out attempt is retried.', cfg: 'The wait this caller inserts before retrying a timed-out attempt.' },
  // DES-FED OUTCOME SLOs — answered only by the simulation (like the p99 tail).
  goodputRps: { label: 'Goodput', unit: 'req/s', desc: 'Requests that actually SUCCEED per second (retries and failures excluded) — the useful work the design delivers. Past saturation, retries LOWER it. Verified against the simulation, not the scalar pass.' },
  errorRate: { label: 'Failed requests', unit: 'req/s', desc: 'Requests that FAIL per second after every retry is exhausted — the honest error rate under load. Verified against the simulation, not the scalar pass.' },
};

export const keyInfo = (key: string): KeyInfo => KEY_INFO[key] ?? { label: key, unit: '', desc: '' };

// What each COMPONENT FAMILY is for (by kind) — the palette/node tooltip.
export const KIND_DESC: Record<string, string> = {
  client: 'A traffic SOURCE — a user, browser or caller that OFFERS load to the system. It adds no latency or cost of its own; set its throughput to the requests/second it generates.',
  compute: 'A stateless app server or function that handles requests. Capacity = concurrency ÷ service time (Little’s law); scale it with replicas or auto-scaling units.',
  db: 'A database / persistent store. Usually connection- or throughput-bound — and often the first bottleneck under read-heavy load.',
  cache: 'An in-memory cache. Very high throughput and sub-millisecond latency — put it in front of a slower store to absorb reads.',
  storage: 'Object / blob storage (S3-class). Very high durability (many nines) and high throughput; the place for large artifacts.',
  queue: 'A message queue. Decouples producers from consumers and absorbs bursts — watch its backlog so messages don’t pile up.',
  stream: 'A distributed log (Kafka-style): ordered, partitioned, high-throughput event streaming with replay.',
  proxy: 'A reverse proxy / load balancer. Spreads traffic across backends and terminates connections; adds one small hop of latency.',
  gateway: 'An API gateway at the edge — routing, throttling, auth and quotas at the front door.',
  lb: 'A load balancer (L4/L7) that distributes traffic across backend instances.',
  cdn: 'A content delivery network — caches content at the edge, close to users, to cut latency and origin load.',
  search: 'A search / index engine for full-text and analytical queries.',
  security: 'A security control (WAF / firewall) that inspects and filters traffic.',
  ai: 'A managed AI/ML service (LLM, speech-to-text, text-to-speech, …).',
  scheduler: 'A time trigger that fires work on a schedule (cron / EventBridge Scheduler).',
  email: 'A transactional email sender (e.g. Amazon SES).',
};
