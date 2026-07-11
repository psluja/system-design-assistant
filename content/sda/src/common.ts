import { keys as k } from './registry';
import type { Manifest, ManifestBand, ManifestConfig, ManifestRelation } from './manifest';
import { availabilityByDeployment, connectionPool, costPer, payloadLimit, payPerUseCost, provisionedCost, RETRY_POLICY_CONFIG, sizingRels, unitCostConfig, withDeploymentCost, withOrigin, withOverflow } from './behaviors';

// SQS DOCUMENTED message-size ceiling: 256 KB (262,144 bytes) max message (larger needs the Extended Client + S3):
// https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html
// Informational: fires only if the architect sets `payloadBytes` (the real message size); 0 by default.
const SQS_MESSAGE_LIMIT = payloadLimit(262_144, 'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html');
import { cacheOut, channelIn, clientOut, dbOut, triggerIn } from './port-roles';
import { cacheReadGuarantees, kafkaOut, natsOut, rabbitmqOut, replicaGuarantees, searchGuarantees, sqsFifoOut, sqsStandardOut, writerGuarantees } from './guarantees';

// SOURCED availability by deployment mode (default Multi-AZ; deploymentMode 0 = single-AZ, 2 = multi-Region):
//  - RDS (Postgres/MySQL): single-AZ 99.5%, Multi-AZ 99.95% (https://aws.amazon.com/rds/sla/)
//  - EC2 (a VM / Auto Scaling fleet): single instance 99.5%, ≥2-AZ 99.99% (https://aws.amazon.com/compute/sla/)
const RDS_SLA_SOURCE = 'https://aws.amazon.com/rds/sla/';
const EC2_SLA_SOURCE = 'https://aws.amazon.com/compute/sla/';
const RDS_AVAILABILITY = availabilityByDeployment(0.995, 0.9995, 0.9995, RDS_SLA_SOURCE);
const EC2_AVAILABILITY = availabilityByDeployment(0.995, 0.9999, 0.9999, EC2_SLA_SOURCE);

// ─── DES QUEUEING for the fixed-throughput datastores (calibration #1) ──────────────────────────────────────────
// A fixed-throughput store (Mongo / Redis / Memcached) has no `concurrency` knob, so the DES modelled it as
// PURE_DELAY (100,000 servers) — it never queued and its p99 was flat under load, blind to the very saturation the
// scalar overflow verdict flags. The fix is PURE CONFIG on the existing `poolStation` mechanism (sim.ts): give the
// store a `connectionPool` (c = its physical service parallelism) + `connectionHeldMs` (the per-op service time),
// and the DES forms a FINITE-server M/M/c that QUEUES as load approaches the ceiling. We add ONLY the two DES knobs
// (via `.config`), NOT the `poolOverflow` relation: capacity is a fixed `throughput` config here, so the universal
// `overflow` band already flags saturation at the SAME threshold — a poolOverflow would duplicate it and move the
// scalar pass off byte-identical. CONSISTENCY (capacity unchanged): c / (held/1000) == the store's existing
// `throughput` ceiling, so the scalar/analytic pass is byte-for-byte the same and ONLY the DES tail gains queueing.
// ONE form: `held` = the SERVER-OCCUPANCY time (how long one request holds its server), and c = throughput × held
// is the Little's-law in-flight concurrency — so the DES base per-hop latency stays FAITHFUL to the declared service.
//   • MongoDB — a CONNECTION is held for the whole query (5 ms, the node's `latency`), so c = 10,000 op/s × 5 ms =
//               50 in-flight (within the driver default maxPoolSize 100) ⇒ M/M/50; 50 / (5 ms/1000) = 10,000 op/s.
//   • Redis   — single-threaded command loop ⇒ M/M/1; a THREAD is held only for the ~0.01 ms per-command CPU, NOT
//               the 0.5 ms `latency` (that is client round-trip, thread-free): 1 / (0.01 ms/1000) = 100,000 op/s.
//   • Memcached — 4 worker threads by default (-t 4) ⇒ M/M/4; thread held ~0.02 ms per-op CPU: 4 / (0.02 ms/1000) = 200,000.
const MONGO_POOL_SOURCE = 'https://www.mongodb.com/docs/manual/reference/connection-string-options/'; // maxPoolSize default = 100 (the ceiling the c=50 in-flight sits within)
const REDIS_POOL_SOURCE = 'https://redis.io/docs/latest/develop/get-started/faq/'; // "Redis is, mostly, a single-threaded server"
const MEMCACHED_POOL_SOURCE = 'https://github.com/memcached/memcached/wiki/ConfiguringServer'; // -t (threads) default = 4

// "Act as queue" behaviour, as DATA any component can carry (the engine stays domain-agnostic). The
// limits (retention, max backlog, durability) are what distinguish SQS vs Redis vs SQL as a queue.
// backlog = queueMode · max(0, arrivalRate − drainRate): >0 means it grows without bound (unstable).
const queueCfg = (mode: number, retention: number, maxBacklog: number): ManifestConfig[] => [
  { key: k.queueMode, value: mode, unit: '1' },
  { key: k.drainRate, value: 1000, unit: 'msg/s' }, // consumer pull rate — the PRODUCER's write rate is read from the graph
  { key: k.retention, value: retention, unit: 's' },
  { key: k.maxBacklog, value: maxBacklog, unit: 'msg' },
];
// backlog = (what the producers write IN, read from the graph via inflow, capped by the queue's ingest
// ceiling) − (what the consumer drains). The drain is read from the WIRED consumer via outflow; with no
// consumer connected it falls back to the manual drainRate. >0 ⇒ messages pile up at this rate (msg/s).
const QUEUE_REL: ManifestRelation = {
  key: k.backlog,
  reads: [k.queueMode, k.throughput, k.drainRate],
  // ingest ceiling = the node's OWN throughput capacity via self() — NOT a plain `throughput` ref, which
  // resolves to the INCOMING value (+Infinity for a disconnected relation-throughput store ⇒ a 0·∞ = NaN).
  expr: 'queueMode * max(0, min(inflow(throughput), self(throughput)) - (outflow(throughput) + drainRate * (outflow(throughput) <= 0.0001)))',
};
const QUEUE_BAND: ManifestBand = { key: k.backlog, band: { shape: 'minTargetMax', max: 0 } }; // stable ⇒ backlog ≤ 0

/**
 * A catalog of WELL-KNOWN, cloud-agnostic components (the OSS staples). These make richer, more
 * recognizable designs than the AWS-only archetypes.
 *
 * SOURCING (the tool must not lie): the numbers are TYPICAL single-node figures and DOCUMENTED
 * defaults, not universal truths — real throughput/latency are hardware- and workload-dependent, so
 * treat them as editable starting points. The high-confidence parts are the documented LIMITS that
 * cause real outages and are the whole point of modelling these by name:
 *  - PostgreSQL `max_connections` default = 100; MySQL default = 151 (connection-pool exhaustion).
 *  - Redis is single-threaded → one core caps ops/s; Kafka ordering/throughput is per-partition.
 * Capacity for the connection-bound stores is Little's law: connections / query-time.
 */
export const commonManifests: Readonly<Record<string, Manifest>> = withOverflow(withOrigin({
  // ---- load source ----
  // `client.web`'s throughput-as-workload is a CONVENIENCE PRESET over the universal origin mechanism: a client
  // is just a node dedicated to originating traffic — any node can now originate too by declaring `assumedRps`.
  'client.web': {
    type: 'client.web',
    ports: [{ name: 'out', dir: 'out', speaks: ['https', 'http'] }],
    config: [
      { key: k.throughput, value: 5000, unit: 'req/s' },
      { key: k.latency, value: 0, unit: 'ms' },
      { key: k.availability, value: 1, unit: 'ratio' },
      ...RETRY_POLICY_CONFIG, // a browser/client is a caller: timeout + retries (default 0 = off)
    ],
  },

  // ---- reverse proxies / load balancers ----
  'proxy.nginx': {
    type: 'proxy.nginx',
    ports: [
      { name: 'in', dir: 'in', accepts: ['http'] },
      { name: 'out', dir: 'out', speaks: ['http'] },
    ],
    config: [
      { key: k.throughput, value: 50000, unit: 'req/s' }, // tens of thousands of rps on a single node (typical)
      { key: k.latency, value: 1, unit: 'ms' }, // proxy overhead (typical)
      { key: k.availability, value: 0.999, unit: 'ratio' },
      unitCostConfig(0.0005, 'USD/(req/s)·month'), // self-managed nginx on a VM (est., list): $25/mo at the default 50k rps ceiling
    ],
    relations: [provisionedCost],
  },
  // AWS RDS Proxy — a MANAGED connection-pooling proxy in front of RDS/Aurora (PostgreSQL, MySQL/MariaDB,
  // SQL Server). What it really buys: thousands of client connections (Lambda storms) multiplexed onto a
  // bounded backend pool, plus faster failover recovery. SOURCED:
  //  - latency overhead ~1–3 ms per query (https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html;
  //    can grow when session state PINS a connection — pinning is workload-dependent and NOT modelled, see doc-8).
  //  - pool = MaxConnectionsPercent × the TARGET's max_connections (default 100%); default here 100 matches a
  //    stock PostgreSQL max_connections. connectionHeldMs ≈ your backend's per-query time (tune to workload).
  //  - price $0.015 per TARGET vCPU-hour, billed for ≥ 2 vCPU (https://aws.amazon.com/rds/proxy/pricing/):
  //    0.015 × 730 h ≈ $10.95/vCPU·month → the `vcpus` knob (default the 2-vCPU minimum).
  //  - availability: managed, Multi-AZ by design; no separately published SLA → the RDS Multi-AZ SLA figure
  //    (99.95%, https://aws.amazon.com/rds/sla/). Failover-recovery acceleration (up to 79% faster client
  //    recovery on Aurora MySQL) is a QUALITATIVE benefit — folding it into the availability ratio would be
  //    an invented number, so it stays out of the math (doc-8).
  'proxy.rds': {
    type: 'proxy.rds',
    ports: [
      { name: 'in', dir: 'in', accepts: ['postgresql', 'mysql', 'tds'] },
      { name: 'out', dir: 'out', speaks: ['postgresql', 'mysql', 'tds'] },
    ],
    config: [
      { key: k.latency, value: 2, unit: 'ms' }, // sourced 1–3 ms proxy overhead
      { key: k.availability, value: 0.9995, unit: 'ratio' },
      { key: k.vcpus, value: 2, unit: '1' }, // target-instance vCPUs (billing driver; 2 = the billed minimum)
      unitCostConfig(10.95, 'USD/vcpu·month'), // managed AWS RDS Proxy, sourced: $0.015/vCPU·h × 730 h (https://aws.amazon.com/rds/proxy/pricing/)
      ...connectionPool(100, 30, 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html').config, // pool ≈ MaxConnectionsPercent × target max_connections; held ≈ query ms
      // CONNECTION BORROW TIMEOUT: a client asking the proxy for a pooled connection waits AT MOST this long for
      // one to free; past it the proxy returns an ERROR. Default ConnectionBorrowTimeout = 120 s (120,000 ms):
      // https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-connections.html (and the CreateDBProxy
      // API reference). Modelled as the GENERIC station wait deadline: under pool pressure (offered × heldMs >>
      // pool) the borrow queue's wait exceeds 120 s in the DES and requests renege — the timeout wave the scalar
      // `poolOverflow` violation predicts, now visible over time. DES-only (a wait deadline is a question about
      // time); the scalar pass ignores it. Distinct from a CALLER's per-attempt `timeoutMs` (this proxy has none).
      { key: k.maxQueueWaitMs, value: 120000, unit: 'ms', source: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-connections.html' },
    ],
    relations: [
      // capacity EMERGES from the pool: with every pooled connection held for connectionHeldMs, the proxy can
      // pass at most pool/held req/s — the same Little's-law algebra the overflow band checks.
      { key: k.throughput, reads: [k.connectionPool, k.connectionHeldMs], expr: 'self(connectionPool) / (self(connectionHeldMs) / 1000)' },
      costPer(k.vcpus),
      ...connectionPool(100, 30).relations,
    ],
    bands: [...connectionPool(100, 30).bands],
  },

  'proxy.haproxy': {
    type: 'proxy.haproxy',
    ports: [
      { name: 'in', dir: 'in', accepts: ['http'] },
      { name: 'out', dir: 'out', speaks: ['http'] },
    ],
    config: [
      { key: k.throughput, value: 40000, unit: 'req/s' },
      { key: k.latency, value: 1, unit: 'ms' },
      { key: k.availability, value: 0.999, unit: 'ratio' },
      unitCostConfig(0.000625, 'USD/(req/s)·month'), // self-managed HAProxy on a VM (est., list): $25/mo at the default 40k rps ceiling
    ],
    relations: [provisionedCost],
  },

  // ---- protocol entrypoints (gRPC / WebSocket / GraphQL) ----
  'gateway.grpc': {
    type: 'gateway.grpc',
    ports: [
      { name: 'in', dir: 'in', accepts: ['grpc'] },
      { name: 'out', dir: 'out', speaks: ['grpc'] },
    ],
    config: [
      { key: k.throughput, value: 20000, unit: 'req/s' }, // HTTP/2 multiplexing → high throughput (typical)
      { key: k.latency, value: 3, unit: 'ms' },
      { key: k.availability, value: 0.999, unit: 'ratio' },
      unitCostConfig(0.0015, 'USD/(req/s)·month'), // self-managed gRPC gateway on a VM (est., list): $30/mo at the default 20k rps ceiling
    ],
    relations: [provisionedCost],
  },
  'gateway.websocket': {
    type: 'gateway.websocket',
    ports: [{ name: 'in', dir: 'in', accepts: ['websocket'] }],
    config: [
      { key: k.throughput, value: 50000, unit: 'msg/s' }, // capacity is really concurrent connections (typical)
      { key: k.latency, value: 1, unit: 'ms' },
      { key: k.availability, value: 0.999, unit: 'ratio' },
      unitCostConfig(0.0006, 'USD/(msg/s)·month'), // self-managed WebSocket gateway on a VM (est., list): $30/mo at the default 50k msg/s ceiling
    ],
    relations: [provisionedCost],
  },
  'gateway.graphql': {
    type: 'gateway.graphql',
    ports: [
      { name: 'in', dir: 'in', accepts: ['graphql'] },
      { name: 'db', dir: 'out', speaks: ['postgresql'] },
    ],
    config: [
      { key: k.throughput, value: 8000, unit: 'query/s' }, // resolver-bound; workload-dependent (typical)
      { key: k.latency, value: 15, unit: 'ms' },
      { key: k.availability, value: 0.999, unit: 'ratio' },
      unitCostConfig(0.005, 'USD/(query/s)·month'), // self-managed GraphQL gateway on a VM (est., list): $40/mo at the default 8k query/s ceiling
    ],
    relations: [provisionedCost],
  },

  // ---- horizontally-scaled app: capacity = per-replica capacity × replica count; cost scales too ----
  'compute.replicated': {
    type: 'compute.replicated',
    ports: [
      triggerIn(), // a service/worker: invoked over HTTP, OR driven by a queue/stream/event source
      dbOut('db', 'postgresql'), // the database dependency — reaches SQL databases, not gateways/queues
      clientOut('out', 'https'), // a service runs general code — it calls other services, queues/streams, AWS APIs…
    ],
    config: [
      { key: k.concurrency, value: 50, unit: '1' }, // per replica
      { key: k.perRequestDuration, value: 25, unit: 'ms' },
      { key: k.replicas, value: 2, unit: '1' }, // the scale-out knob
      { key: k.latency, value: 25, unit: 'ms' },
      { key: k.availability, value: 0.9995, unit: 'ratio' },
      unitCostConfig(30, 'USD/replica·month'), // self-managed replica (est., list): ~$30/replica·month
    ],
    relations: [
      { key: k.throughput, reads: [k.concurrency, k.perRequestDuration, k.replicas], expr: 'concurrency / (perRequestDuration / 1000) * replicas' },
      costPer(k.replicas),
    ],
  },

  // ---- DEMAND-DRIVEN SIZING fleets: how many units the offered load needs (+ cost). "Sizing" is a
  //      reusable role across many auto-scalers — only the per-unit capacity, ceiling and $/unit differ. ----
  'compute.fargate': {
    type: 'compute.fargate',
    ports: [
      triggerIn(), // a service/worker: invoked over HTTP, OR driven by a queue/stream/event source
      dbOut('db', 'postgresql'), // the database dependency — reaches SQL databases, not gateways/queues
      clientOut('out', 'https'), // a service runs general code — it calls other services, queues/streams, AWS APIs…
    ],
    config: [
      { key: k.concurrency, value: 40, unit: '1' }, // requests one task serves concurrently
      { key: k.perRequestDuration, value: 25, unit: 'ms' },
      { key: k.maxUnits, value: 100, unit: '1' }, // service/account task ceiling
      { key: k.latency, value: 25, unit: 'ms' },
      { key: k.availability, value: 0.9995, unit: 'ratio' }, // illustrative — ECS/Fargate has NO published AWS SLA (don't seed a sourced number)
      unitCostConfig(30, 'USD/task·month'), // managed AWS Fargate (est./illustrative): ~$30/task·month
    ],
    relations: sizingRels(),
  },
  'compute.cloudrun': {
    type: 'compute.cloudrun',
    ports: [
      triggerIn(), // a service/worker: invoked over HTTP, OR driven by a queue/stream/event source
      dbOut('db', 'postgresql'), // the database dependency — reaches SQL databases, not gateways/queues
      clientOut('out', 'https'), // a service runs general code — it calls other services, queues/streams, AWS APIs…
    ],
    config: [
      { key: k.concurrency, value: 80, unit: '1' }, // Cloud Run: up to 80 concurrent requests / instance (default)
      { key: k.perRequestDuration, value: 25, unit: 'ms' },
      { key: k.maxUnits, value: 1000, unit: '1' }, // scales wide; pay-per-use, scales to zero
      { key: k.latency, value: 25, unit: 'ms' },
      { key: k.availability, value: 0.9995, unit: 'ratio' },
      unitCostConfig(12, 'USD/unit·month'), // managed Cloud Run (est., pay-per-use): ~$12/unit·month, cheaper per unit
    ],
    relations: sizingRels(),
  },
  'compute.k8s': {
    type: 'compute.k8s',
    ports: [
      triggerIn(), // a service/worker: invoked over HTTP, OR driven by a queue/stream/event source
      dbOut('db', 'postgresql'), // the database dependency — reaches SQL databases, not gateways/queues
      clientOut('out', 'https'), // a service runs general code — it calls other services, queues/streams, AWS APIs…
    ],
    config: [
      { key: k.concurrency, value: 50, unit: '1' }, // per pod (HPA scales pod count)
      { key: k.perRequestDuration, value: 25, unit: 'ms' },
      { key: k.maxUnits, value: 200, unit: '1' }, // HPA maxReplicas
      { key: k.latency, value: 25, unit: 'ms' },
      { key: k.availability, value: 0.999, unit: 'ratio' },
      unitCostConfig(25, 'USD/pod·month'), // self-managed Kubernetes (est., list): ~node share per pod·month
    ],
    relations: sizingRels(),
  },
  'compute.asg': {
    type: 'compute.asg',
    ports: [
      triggerIn(), // a service/worker: invoked over HTTP, OR driven by a queue/stream/event source
      dbOut('db', 'postgresql'), // the database dependency — reaches SQL databases, not gateways/queues
      clientOut('out', 'https'), // a service runs general code — it calls other services, queues/streams, AWS APIs…
    ],
    config: [
      { key: k.concurrency, value: 200, unit: '1' }, // a whole VM serves more, but is a coarser, pricier unit
      { key: k.perRequestDuration, value: 25, unit: 'ms' },
      { key: k.maxUnits, value: 50, unit: '1' }, // ASG max size
      { key: k.latency, value: 25, unit: 'ms' },
      EC2_AVAILABILITY.config, // deploymentMode (default ≥2-AZ); availability = sourced EC2 SLA per mode
      unitCostConfig(70, 'USD/instance·month'), // self-managed EC2 ASG (est., list): ~$70/instance·month (a full VM)
    ],
    relations: [...sizingRels(), EC2_AVAILABILITY.relation],
  },

  // ---- serverless: PAY-PER-USE — cost scales with actual throughput, not provisioned size ----
  'compute.serverless': {
    type: 'compute.serverless',
    ports: [
      triggerIn(), // a service/worker: invoked over HTTP, OR driven by a queue/stream/event source
      dbOut('db', 'postgresql'), // the database dependency — reaches SQL databases, not gateways/queues
      clientOut('out', 'https'), // a service runs general code — it calls other services, queues/streams, AWS APIs…
    ],
    config: [
      { key: k.concurrency, value: 100, unit: '1' },
      { key: k.perRequestDuration, value: 40, unit: 'ms' },
      { key: k.latency, value: 40, unit: 'ms' },
      { key: k.availability, value: 0.9995, unit: 'ratio' },
      unitCostConfig(0.5, 'USD/(req/s)·month'), // managed serverless (est., pay-per-use): ~$0.5/mo per sustained req/s
    ],
    relations: [
      { key: k.throughput, reads: [k.concurrency, k.perRequestDuration], expr: 'concurrency / (perRequestDuration / 1000)' },
      payPerUseCost,
    ],
  },

  // ---- object store: the durability champion (≈ 11 nines) ----
  'storage.object': {
    type: 'storage.object',
    ports: [{ name: 'in', dir: 'in', accepts: ['http'] }],
    config: [
      { key: k.throughput, value: 5500, unit: 'req/s' }, // per-prefix typical
      { key: k.latency, value: 20, unit: 'ms' },
      { key: k.availability, value: 0.999, unit: 'ratio', source: 'https://aws.amazon.com/s3/sla/' }, // S3 availability SLA 99.9%
      { key: k.durability, value: 0.99999999999, unit: 'ratio', source: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/DataDurability.html' }, // S3 11 nines durability
      unitCostConfig(1, 'USD/(req/s)·month'), // managed object store / S3-class (est., pay-per-use): per sustained req/s
    ],
    relations: [payPerUseCost],
  },

  // ---- generic stateless app server (talks to a db and a cache) ----
  'compute.service': {
    type: 'compute.service',
    ports: [
      triggerIn(), // a service/worker: invoked over HTTP, OR driven by a queue/stream/event source
      dbOut('db', 'postgresql'), // the database dependency — reaches SQL databases, not gateways/queues
      clientOut('out', 'https'), // a service runs general code — it calls other services, queues/streams, AWS APIs…
      cacheOut('cache'),
    ],
    config: [
      { key: k.concurrency, value: 500, unit: '1' }, // worker/thread pool (typical)
      { key: k.perRequestDuration, value: 20, unit: 'ms' }, // app handler time (typical)
      { key: k.latency, value: 20, unit: 'ms' },
      { key: k.availability, value: 0.999, unit: 'ratio' },
      unitCostConfig(0.24, 'USD/conc·month'), // self-managed app server on a VM (est., list): $120/mo at the default 500-worker pool; more workers (capacity) cost more
      ...RETRY_POLICY_CONFIG, // a service is a caller of its downstreams: it can declare a timeout + retries (default 0 = off)
    ],
    relations: [
      { key: k.throughput, reads: [k.concurrency, k.perRequestDuration], expr: 'concurrency / (perRequestDuration / 1000)' },
      costPer(k.concurrency),
    ],
  },

  // ---- caches (in-memory) ----
  // CACHE-ASIDE MISS RATIO — the honest place for it is the SERVICE's db WIRE, not this component. A cache-aside
  // service reads the cache first and, on a MISS (probability 1−h), falls through to the DB, so only the miss
  // fraction of the service's read traffic reaches the database. In this catalog a service has SEPARATE `cache`
  // and `db` out ports (see compute.service): the cache does NOT sit between the service and the DB, so a
  // transform on redis's own port CANNOT express cache-aside — it would be faking a fact that lives elsewhere.
  // The RECOMMENDED PATTERN (expressible today via per-wire transforms): put `ratio(est. miss)` on the
  // SERVICE→DB wire — e.g. ratio(0.2) for an 80%-hit cache — so the DB tier is sized for the real miss load. The
  // miss ratio is a per-DESIGN choice (workload + cache size), not a component fact of Redis, so no default here.
  'cache.redis': {
    type: 'cache.redis',
    ports: [
      // A cache read with no declared invalidation is EVENTUAL (doc: guarantee-propagation §2) — sourced behaviour
      // carried as data. The architect can override it (declares "invalidates on write") in R3.
      { name: 'in', dir: 'in', accepts: ['resp'], guarantees: cacheReadGuarantees },
      { name: 'out', dir: 'out', speaks: ['resp'] }, // a consumer pulls when used as a queue (act as queue)
    ],
    config: [
      { key: k.throughput, value: 100000, unit: 'op/s' }, // single-threaded ~100k+ ops/s on one core (documented)
      { key: k.latency, value: 0.5, unit: 'ms' }, // sub-millisecond (typical)
      { key: k.availability, value: 0.999, unit: 'ratio' },
      { key: k.durability, value: 0.99, unit: 'ratio' }, // in-memory: volatile unless AOF/RDB — the risk as a queue
      unitCostConfig(0.0009, 'USD/(op/s)·month'), // self-managed Redis on a VM (est., list): $90/mo at the default 100k op/s ceiling (a bigger node = more ops/s)
      ...queueCfg(0, 1_000_000_000, 1_000_000), // as a list queue: held until consumed, but RAM-bound & volatile
      ...connectionPool(1, 0.01, REDIS_POOL_SOURCE).config, // DES M/M/1 (single-threaded); 1 / (0.01 ms) = 100,000 op/s == throughput
    ],
    relations: [QUEUE_REL, provisionedCost],
    bands: [QUEUE_BAND],
  },
  'cache.memcached': {
    type: 'cache.memcached',
    // A cache read with no declared invalidation is EVENTUAL — same sourced behaviour as redis (doc §2).
    ports: [{ name: 'in', dir: 'in', accepts: ['memcached'], guarantees: cacheReadGuarantees }], // the Memcached protocol — NOT RESP-compatible (the cache port speaks both)
    config: [
      { key: k.throughput, value: 200000, unit: 'op/s' }, // multi-threaded (typical)
      { key: k.latency, value: 0.5, unit: 'ms' },
      { key: k.availability, value: 0.999, unit: 'ratio' },
      unitCostConfig(0.00035, 'USD/(op/s)·month'), // self-managed Memcached on a VM (est., list): $70/mo at the default 200k op/s ceiling
      ...connectionPool(4, 0.02, MEMCACHED_POOL_SOURCE).config, // DES M/M/4 (4 worker threads); 4 / (0.02 ms) = 200,000 op/s == throughput
    ],
    relations: [provisionedCost],
  },

  // ---- relational databases (connection-bound capacity) ----
  'db.postgres': {
    type: 'db.postgres',
    ports: [
      // The PRIMARY/writer: reads off it are strongly consistent (read-your-writes). The guarantee is sourced
      // behaviour carried as data (doc: guarantee-propagation §2) — a request path terminating here provides `strong`.
      { name: 'in', dir: 'in', accepts: ['postgresql'], guarantees: writerGuarantees },
      { name: 'out', dir: 'out', speaks: ['postgresql'] }, // a worker pulls when used as a queue (SELECT … FOR UPDATE SKIP LOCKED)
    ],
    config: [
      { key: k.concurrency, value: 100, unit: '1', source: 'https://www.postgresql.org/docs/current/runtime-config-connection.html' }, // max_connections default = 100
      { key: k.perRequestDuration, value: 50, unit: 'ms', est: true }, // query time (workload-dependent; typical mixed)
      { key: k.latency, value: 50, unit: 'ms' },
      RDS_AVAILABILITY.config, // deploymentMode (default Multi-AZ); availability is the sourced RDS SLA per mode
      { key: k.durability, value: 0.99999, unit: 'ratio' }, // ~5 nines with backups/PITR (typical)
      unitCostConfig(1.4, 'USD/conn·month'), // managed relational DB, RDS-class (est.): $140/mo at the default 100 connections; capacity = connections, so it is priced
      ...queueCfg(0, 1_000_000_000, 1_000_000_000), // as a queue (SELECT … FOR UPDATE SKIP LOCKED): durable, ~unbounded retention, but drain is connection-bound
    ],
    relations: [
      { key: k.throughput, reads: [k.concurrency, k.perRequestDuration], expr: 'concurrency / (perRequestDuration / 1000)' },
      RDS_AVAILABILITY.relation, // availability = sourced RDS SLA selected by deploymentMode
      QUEUE_REL,
      // cost = connections × base (more connections = a bigger instance = no free capacity), THEN the deployment
      // surcharge: RDS Multi-AZ bills the standby ≈ 2× (task-77, sourced) — redundancy is not free.
      withDeploymentCost(costPer(k.concurrency)),
    ],
    bands: [QUEUE_BAND],
  },
  // A READ REPLICA of a relational primary — the exemplar of an EVENTUAL read (doc: guarantee-propagation §2).
  // Replication lag is documented behaviour, so a read served here is `eventual`: a request path terminating at
  // the replica computes consistency = eventual, root-caused to the replica. Same capacity/cost shape as the
  // primary (a replica is a full copy); its distinguishing fact is the weaker consistency contribution.
  'db.postgres.replica': {
    type: 'db.postgres.replica',
    ports: [{ name: 'in', dir: 'in', accepts: ['postgresql'], guarantees: replicaGuarantees }],
    config: [
      { key: k.concurrency, value: 100, unit: '1', source: 'https://www.postgresql.org/docs/current/runtime-config-connection.html' },
      { key: k.perRequestDuration, value: 50, unit: 'ms', est: true },
      { key: k.latency, value: 50, unit: 'ms' },
      RDS_AVAILABILITY.config,
      { key: k.durability, value: 0.99999, unit: 'ratio' },
      unitCostConfig(1.4, 'USD/conn·month'), // managed relational read replica, RDS-class (est.): matches the primary per-connection price
    ],
    relations: [
      { key: k.throughput, reads: [k.concurrency, k.perRequestDuration], expr: 'concurrency / (perRequestDuration / 1000)' },
      RDS_AVAILABILITY.relation,
      withDeploymentCost(costPer(k.concurrency)),
    ],
  },
  'db.mysql': {
    type: 'db.mysql',
    // The PRIMARY/writer: reads off it are strongly consistent (read-your-writes off a single primary), like postgres.
    ports: [{ name: 'in', dir: 'in', accepts: ['mysql'], guarantees: writerGuarantees }],
    config: [
      { key: k.concurrency, value: 151, unit: '1', source: 'https://dev.mysql.com/doc/refman/8.0/en/server-system-variables.html#sysvar_max_connections' }, // max_connections default = 151
      { key: k.perRequestDuration, value: 30, unit: 'ms' },
      { key: k.latency, value: 30, unit: 'ms' },
      RDS_AVAILABILITY.config, // deploymentMode (default Multi-AZ); availability = sourced RDS SLA per mode
      unitCostConfig(130 / 151, 'USD/conn·month'), // managed relational DB, RDS-class (est.): $130/mo at the default 151 connections (max_connections)
    ],
    relations: [
      { key: k.throughput, reads: [k.concurrency, k.perRequestDuration], expr: 'concurrency / (perRequestDuration / 1000)' },
      RDS_AVAILABILITY.relation,
      withDeploymentCost(costPer(k.concurrency)), // RDS Multi-AZ standby billed ≈ 2× (task-77) — redundancy is not free
    ],
  },

  // ---- document / search ----
  'db.mongodb': {
    type: 'db.mongodb',
    ports: [{ name: 'in', dir: 'in', accepts: ['mongodb'] }],
    config: [
      { key: k.throughput, value: 10000, unit: 'op/s' },
      { key: k.latency, value: 5, unit: 'ms' },
      { key: k.availability, value: 0.999, unit: 'ratio' },
      unitCostConfig(0.016, 'USD/(op/s)·month'), // self-managed MongoDB on a VM (est., list): $160/mo at the default 10k op/s ceiling
      ...connectionPool(50, 5, MONGO_POOL_SOURCE).config, // DES M/M/50 (in-flight = 10,000 op/s × 5 ms query, within maxPoolSize 100); 50 / (5 ms) = 10,000 op/s == throughput
    ],
    relations: [provisionedCost],
  },
  // SELF-MANAGED Elasticsearch on your OWN EC2 fleet — NOT the AWS OpenSearch managed service (that is the separate
  // `search.opensearch` block below; the owner must be able to tell the two apart from the cost alone). PRICING
  // IDENTITY: self-managed, so the modelled cost is the raw EC2 COMPUTE bill you run the cluster on, at LIST/on-demand
  // rates — an `est.`, never a published all-in number. BASIS for the 0.036 USD/(query/s)·mo default: a minimal
  // 3-node cluster (one node per AZ for quorum) of small 2 vCPU / 8 GiB general-purpose nodes ≈ 3× t3.large @
  // $0.0832/h × 730 h ≈ $182/mo of compute, serving ~5,000 SIMPLE queries/s (query cost is workload-dependent —
  // complex aggregations serve far fewer). 182 / 5000 ≈ 0.036. EBS data volumes, cross-AZ transfer and the operational
  // effort of running it are EXTRA and DELIBERATELY EXCLUDED — a self-managed cluster's real TCO is higher than this
  // compute line, stated so the figure is not misread as all-in. EC2 on-demand list prices (us-east-1, 2026):
  // https://aws.amazon.com/ec2/pricing/on-demand/
  'search.elasticsearch': {
    type: 'search.elasticsearch',
    // NEAR-REAL-TIME: an indexed document is searchable only after the next refresh, so a read is EVENTUAL (sourced).
    ports: [{ name: 'in', dir: 'in', accepts: ['http'], guarantees: searchGuarantees }],
    config: [
      { key: k.throughput, value: 5000, unit: 'query/s' }, // query-heavy; shard/replica-dependent (est. simple-query ceiling)
      { key: k.latency, value: 50, unit: 'ms' }, // search latency higher than a KV get
      { key: k.availability, value: 0.99, unit: 'ratio' }, // small self-run cluster (illustrative — not a managed SLA)
      unitCostConfig(0.036, 'USD/(query/s)·month'), // self-managed Elasticsearch on EC2 (est., list): 3× t3.large ≈ $182/mo compute at ~5k simple q/s; EBS/storage extra
    ],
    relations: [provisionedCost],
  },

  // AWS OpenSearch Service — the MANAGED counterpart to the self-managed `search.elasticsearch` above (the owner
  // asked that a search cost state WHICH of the two it is). PRICING IDENTITY: managed, SOURCED from the published AWS
  // OpenSearch Service on-demand instance-hour + EBS list prices (us-east-1, 2026), NOT reverse-engineered from a round
  // monthly figure. A realistic 3-AZ PRODUCTION domain:
  //   • 3× r6g.large.search data nodes (2 vCPU / 16 GiB) @ $0.167/h × 730 h            = $365.73/mo
  //   • 3× c6g.large.search dedicated cluster-manager (master) nodes @ $0.113/h × 730 h = $247.47/mo
  //   • gp3 EBS: 3 × 100 GiB @ $0.122/GiB·mo                                            =  $36.60/mo
  //   → ≈ $649.80/mo ≈ $650/mo. At the est. ~5,000 query/s ceiling (the same workload-dependent basis as the ES block,
  //     so the managed PREMIUM shows up in COST, not capacity): 650 / 5000 ≈ 0.13 USD/(query/s)·mo — ~3.6× the
  //     self-managed compute line. Dedicated masters + EBS + managed operation are what the premium buys. Reserved-
  //     Instance / volume discounts (≈ 30-40% off at 1-yr RI) apply at scale — this default is the ON-DEMAND LIST rate.
  // Sources (us-east-1, 2026): instance-hours https://aws.amazon.com/opensearch-service/pricing/ · r6g.large.search
  //   $0.167/h https://instances.vantage.sh/aws/opensearch/r6g.large.search · gp3 EBS $0.122/GiB·mo
  //   https://aws.amazon.com/blogs/big-data/lower-your-amazon-opensearch-service-storage-cost-with-gp3-amazon-ebs-volumes/
  // Availability: the AWS OpenSearch Service SLA is 99.9% for a Multi-AZ (2+ AZ) domain without standby, 99.99% with
  //   standby (3 AZ) — we take the conservative 99.9% (https://aws.amazon.com/opensearch-service/sla/). Reads are
  //   NEAR-REAL-TIME eventual, exactly like Elasticsearch (same engine) — so it reuses `searchGuarantees` (sourced).
  'search.opensearch': {
    type: 'search.opensearch',
    ports: [{ name: 'in', dir: 'in', accepts: ['http'], guarantees: searchGuarantees }],
    config: [
      { key: k.throughput, value: 5000, unit: 'query/s', est: true }, // est. simple-query ceiling for a 3× r6g.large data-node domain (workload-dependent)
      { key: k.latency, value: 50, unit: 'ms', est: true }, // est. search latency (same engine class as self-managed ES)
      { key: k.availability, value: 0.999, unit: 'ratio', source: 'https://aws.amazon.com/opensearch-service/sla/' }, // Multi-AZ OpenSearch SLA 99.9%
      unitCostConfig(0.13, 'USD/(query/s)·month'), // managed AWS OpenSearch, sourced (see the note above): 3-AZ domain ≈ $650/mo at ~5k query/s
    ],
    relations: [provisionedCost],
  },

  // ---- messaging / streaming (all carry queue behaviour; the limits differ → they're comparable) ----
  'queue.sqs': {
    type: 'queue.sqs',
    ports: [
      channelIn('sqs'), // enqueue via SendMessage (aws-api), an HTTP request, or an SNS subscription
      // consumers poll the queue. HINT (doc: flow-transformations-r2 §5): ReceiveMessage returns AT MOST 10 messages
      // per call (AWS docs), so a batching consumer collapses up to 10:1 — model it with a per-instance batch(≤10)
      // transform on THIS port. We do NOT preset one: the REAL batch size is the app's choice, and inventing a
      // default would lie about a rate the architect never declared. Default stays identity (1:1). See
      // https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html
      // SQS STANDARD keeps NO order and is at-least-once (may-duplicate) — sourced behaviour on the delivering
      // (out) port, so a consumer path through it computes ordering:none + delivery:may-duplicate.
      { name: 'out', dir: 'out', speaks: ['sqs'], guarantees: sqsStandardOut },
    ],
    config: [
      { key: k.throughput, value: 3000, unit: 'msg/s' }, // per API action without batching (typical; higher batched)
      { key: k.latency, value: 10, unit: 'ms' },
      { key: k.availability, value: 0.9999, unit: 'ratio' },
      { key: k.durability, value: 0.999999999, unit: 'ratio' }, // stored redundantly across AZs (managed, durable)
      unitCostConfig(1, 'USD/(msg/s)·month'), // managed AWS SQS (est., pay-per-use): per sustained msg/s
      ...queueCfg(1, 345600, 120000), // 4-day default retention (max 14d); ~120k in-flight (standard queue)
      ...SQS_MESSAGE_LIMIT.config, // 256 KB documented max message size (informational unless payloadBytes is set)
    ],
    relations: [QUEUE_REL, payPerUseCost, SQS_MESSAGE_LIMIT.relation],
    bands: [QUEUE_BAND, SQS_MESSAGE_LIMIT.band],
  },
  'queue.sqs.fifo': {
    type: 'queue.sqs.fifo',
    ports: [
      channelIn('sqs'),
      // FIFO preserves order per message-group (per-key) and is effective exactly-once — a real step above
      // standard SQS on the ordering lattice, the trade for its 300 msg/s ceiling (already modelled in config).
      { name: 'out', dir: 'out', speaks: ['sqs'], guarantees: sqsFifoOut },
    ],
    config: [
      // FIFO default: 300 msg/s per API action (3,000 with batching), ordered + exactly-once:
      // https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-fifo.html
      { key: k.throughput, value: 300, unit: 'msg/s' },
      { key: k.latency, value: 10, unit: 'ms' },
      { key: k.availability, value: 0.9999, unit: 'ratio' },
      { key: k.durability, value: 0.999999999, unit: 'ratio' },
      unitCostConfig(1.5, 'USD/(msg/s)·month'), // managed AWS SQS FIFO (est., pay-per-use): per sustained msg/s (dearer than standard)
      ...queueCfg(1, 345600, 20000), // 4-day default retention; ~20k in-flight (FIFO is lower than standard)
      ...SQS_MESSAGE_LIMIT.config, // 256 KB documented max message size (same as standard; informational unless payloadBytes is set)
    ],
    relations: [QUEUE_REL, payPerUseCost, SQS_MESSAGE_LIMIT.relation],
    bands: [QUEUE_BAND, SQS_MESSAGE_LIMIT.band],
  },
  'queue.rabbitmq': {
    type: 'queue.rabbitmq',
    ports: [
      { name: 'in', dir: 'in', accepts: ['amqp'] },
      // Per-queue FIFO ordering for initial deliveries (per-key) + at-least-once with acks/redelivery (sourced).
      { name: 'out', dir: 'out', speaks: ['amqp'], guarantees: rabbitmqOut },
    ],
    config: [
      { key: k.throughput, value: 20000, unit: 'msg/s' },
      { key: k.latency, value: 2, unit: 'ms' },
      { key: k.availability, value: 0.999, unit: 'ratio' },
      { key: k.durability, value: 0.9999, unit: 'ratio' }, // durable + mirrored/quorum queues (typical)
      unitCostConfig(0.006, 'USD/(msg/s)·month'), // self-managed RabbitMQ on a VM (est., list): $120/mo at the default 20k msg/s ceiling
      ...queueCfg(1, 1_000_000_000, 1_000_000), // no default TTL (≈ held until consumed); memory/disk-bound depth
    ],
    relations: [QUEUE_REL, provisionedCost],
    bands: [QUEUE_BAND],
  },
  'queue.nats': {
    type: 'queue.nats',
    ports: [
      { name: 'in', dir: 'in', accepts: ['nats'] },
      // Core NATS delivers in order from a single publisher (per-key), sourced. It is fire-and-forget/at-most-once,
      // but the v1 delivery lattice models only DUPLICATION (may-duplicate); core NATS does not duplicate, so it
      // makes no delivery claim = TOP (the honest neutral — not a fabricated may-lose the lattice cannot represent).
      { name: 'out', dir: 'out', speaks: ['nats'], guarantees: natsOut },
    ],
    config: [
      { key: k.throughput, value: 1000000, unit: 'msg/s' }, // core NATS is very high throughput
      { key: k.latency, value: 0.5, unit: 'ms' },
      { key: k.availability, value: 0.999, unit: 'ratio' },
      { key: k.durability, value: 0.99, unit: 'ratio' }, // core NATS is fire-and-forget (JetStream adds durability)
      unitCostConfig(0.00004, 'USD/(msg/s)·month'), // self-managed NATS on a VM (est., list): $40/mo at the default 1M msg/s ceiling
      ...queueCfg(1, 0, 65536), // core NATS: NO retention — a slow/absent consumer drops messages
    ],
    relations: [QUEUE_REL, provisionedCost],
    bands: [QUEUE_BAND],
  },
  'stream.kafka': {
    type: 'stream.kafka',
    ports: [
      { name: 'in', dir: 'in', accepts: ['kafka'] },
      // consumers poll in BATCHES. HINT (same style as SQS): the Kafka consumer default `max.poll.records` = 500,
      // so a batching consumer can collapse up to 500:1 — model it with a per-instance batch(≤500) transform on THIS
      // port. We do NOT preset one: `max.poll.records` is a TUNABLE client config, so the real batch size is the
      // app's choice; inventing a default would lie about a rate the architect never declared. Default stays identity.
      // https://kafka.apache.org/documentation/#consumerconfigs_max.poll.records
      // Ordering is TOTAL within a partition (= per-key) and delivery is at-least-once by default (may-duplicate) —
      // both sourced from the Kafka design docs; a consumer path through the log computes ordering:per-key + may-duplicate.
      { name: 'out', dir: 'out', speaks: ['kafka'], guarantees: kafkaOut },
    ],
    config: [
      { key: k.throughput, value: 100000, unit: 'msg/s' }, // aggregate; ordering & throughput are PER-PARTITION
      { key: k.latency, value: 5, unit: 'ms' },
      { key: k.availability, value: 0.999, unit: 'ratio' },
      { key: k.durability, value: 0.99999, unit: 'ratio' }, // replicated, append-only log
      unitCostConfig(0.0025, 'USD/(msg/s)·month'), // self-managed Kafka on a VM cluster (est., list): $250/mo at the default 100k msg/s ceiling
      ...queueCfg(1, 604800, 1_000_000_000), // 7-day default retention; disk-bound depth (effectively huge)
    ],
    relations: [QUEUE_REL, provisionedCost],
    bands: [QUEUE_BAND],
  },
}));
