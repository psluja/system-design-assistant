import { categoricalOf, DimensionId, DimensionToken, type Categorical, type Dimension, type Guarantees } from '@sda/engine-core';

// @feature Delivery guarantees (consistency / ordering / delivery propagation)
// @story Catch the invisible production bugs — stale reads, lost order, duplicates: declare a
//   per-flow guarantee and see the computed end-to-end token, the provable root-cause hop, the
//   cheapest same-family fix, and a colored strip on every wire.
// @surfaces mcp (set_guarantee_slo / clear_guarantee_slo, verdicts on evaluate —
//   app/mcp/src/tools.ts), web + vscode (wire strips + flow lines via
//   app/presenter/src/guarantee-view.ts; sda.setGuaranteeSlo / clearGuaranteeSlo)
// @algorithms engine/solve/src/guarantee/propagate.ts, engine/solve/src/guarantee/datalog.ts,
//   engine/core/src/lattice.ts
// @docs none
// @e2e content/sda/src/vocabulary/guarantees.e2e.test.ts, content/sda/src/analysis/guarantee-slo.e2e.test.ts
// @status shipped

// The seed CATEGORICAL vocabulary — the three qualitative-guarantee dimensions
// a credible design tool reasons about, as CONTENT. The engine knows only that dimensions are ordered token
// lattices with a meet; the token STRINGS ('strong', 'eventual', 'none'…) and what they mean live here, exactly
// like the numeric registry keys. A grep of the engine for any of these words stays zero.
//
// R2 scope (this file): declare the dimensions AND label the WHOLE catalog per-port with SOURCED provenance
// (§5 R2). Every declared contribution is either `documented` (a primary-source URL, carried as DATA like every
// catalog number) or `est` (honestly estimable but not a published number). NOTHING is declared where it would be
// a guess — an undeclared port contributes nothing (the dimension TOP, a neutral pass-through), never an invented
// label (the owner's certain/declared/refused contract, §3). Plain sync HTTP hops (gateways, proxies, LBs, sync
// compute, managed AI) declare NOTHING: they add no guarantee, they only pass one through.

/** The dimension ids, named once so manifests and the propagator reference them by the same string. */
export const dims = {
  /** Read freshness: strong (linearizable / read-your-writes off the writer) → eventual (a lagging replica). */
  consistency: DimensionId('consistency'),
  /** Message/record ordering: total → per-key (per partition/group) → none (a fan-out keeps no order). */
  ordering: DimensionId('ordering'),
  /** Delivery duplication as a monotone flag: clean (no duplicates) → may-duplicate (at-least-once). Modelled as
   *  the degenerate two-token lattice so the meet IS the monotone OR — once a hop can duplicate, the path can. */
  delivery: DimensionId('delivery'),
} as const;

/** The consistency tokens (strongest → weakest), including the declared-unknown value used when a hop's
 *  freshness genuinely depends on app code the model cannot see (custom cache invalidation) — §3 "refused". */
export const consistency = { strong: DimensionToken('strong'), eventual: DimensionToken('eventual'), unknown: DimensionToken('consistency-unknown') } as const;
/** The ordering tokens (strongest → weakest). */
export const ordering = { total: DimensionToken('total'), perKey: DimensionToken('per-key'), none: DimensionToken('none') } as const;
/** The delivery flag tokens (clean = strongest, may-duplicate = weakest). */
export const delivery = { clean: DimensionToken('clean'), mayDuplicate: DimensionToken('may-duplicate') } as const;

/** The dimension DECLARATIONS handed to the engine's `categoricalOf`. Ordered strongest → weakest; consistency
 *  carries a declared-unknown token at the weak end (a real hop can never be masked by it). */
export const guaranteeDimensions: readonly Dimension[] = [
  { id: dims.consistency, tokens: [consistency.strong, consistency.eventual, consistency.unknown], unknown: consistency.unknown },
  { id: dims.ordering, tokens: [ordering.total, ordering.perKey, ordering.none] },
  { id: dims.delivery, tokens: [delivery.clean, delivery.mayDuplicate] },
];

/** The compiled categorical vocabulary the content pack ships — the analogue of `registry` for the numeric keys.
 *  Passed to `instantiate`/`buildGraph` so a mislabelled guarantee is caught at build, and to the propagator so
 *  it can meet tokens. Built once at module load; a malformed seed declaration is a programmer error (throws). */
export const categorical: Categorical = (() => {
  const c = categoricalOf(guaranteeDimensions);
  if (!c.ok) throw new Error(`seed categorical vocabulary is malformed: ${JSON.stringify(c.error)}`);
  return c.value;
})();

// ---- PROVENANCE-CARRYING contributions (R2) ------------------------------------------------------------------
// A guarantee contribution is a claim about real infrastructure behaviour; like every catalog number it must be
// SOURCED or honestly marked an estimate — never invented (the tool must not lie). The engine-facing `Guarantees`
// value the manifests attach is intentionally PURE TOKENS (the engine only meets them; it must stay
// domain-agnostic and provenance-blind). So provenance travels ALONGSIDE the tokens as content data: each
// contribution helper is built from a list of `{ dimension, token, source?, est? }` claims, from which we derive
// BOTH the pure `Guarantees` record (for the port) AND the register rows the design doc needs (with the badge).

/** One dimension's sourced claim for a port/edge. A `documented`
 *  claim carries the primary-source `source` URL; an `est` claim is credible-but-not-published (badged estimate);
 *  a claim that is neither is a plain declared default. Exactly the `ManifestConfig.source`/`est` discipline, for
 *  categorical tokens. */
export interface GuaranteeClaim {
  readonly dimension: DimensionId;
  readonly token: DimensionToken;
  /** The primary-doc URL a `documented` contribution is sourced from (an AWS quota page, the Kafka docs). */
  readonly source?: string;
  /** Marks the contribution an ESTIMATE — credible AWS-typical/behaviour but not a published number. */
  readonly est?: true;
}

/** A named guarantee contribution: the pure `Guarantees` the engine meets, PLUS its per-dimension provenance so a
 *  register/inspector can badge each token. `where` names the human component+port ("SQS standard · out port")
 *  for the register's "Where" column. Built once via {@link contribution} so the token map and the provenance can
 *  never drift apart. */
export interface GuaranteeContribution {
  /** Human name of the component + port this contribution sits on (the register/inspector "Where" column). */
  readonly where: string;
  /** The engine-facing token map attached to the manifest port/edge (provenance-free — the engine only meets it). */
  readonly guarantees: Guarantees;
  /** The per-dimension sourced claims behind those tokens (the register/inspector provenance). */
  readonly claims: readonly GuaranteeClaim[];
}

/** Build a {@link GuaranteeContribution} from its sourced claims: the pure token map is derived from the claims,
 *  so a manifest port attaches `x.guarantees` and the register reads `x.claims` — one source of truth, no drift. */
function contribution(where: string, claims: readonly GuaranteeClaim[]): GuaranteeContribution {
  const guarantees: Record<string, DimensionToken> = {};
  for (const c of claims) guarantees[String(c.dimension)] = c.token;
  return { where, guarantees, claims };
}

// Primary-source URLs (carried as DATA, like every catalog number's `source`). Reused across contributions.
const SRC = {
  // AWS SQS standard vs FIFO delivery + ordering:
  sqsStandard: 'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues.html',
  sqsFifo: 'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues.html',
  // PostgreSQL/RDS read-replica lag (documented behaviour of an async physical/logical replica):
  rdsReplica: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html',
  // Apache Kafka: per-partition (per-key) ordering + at-least-once delivery (design/semantics):
  kafka: 'https://kafka.apache.org/documentation/#semantics',
  // RabbitMQ: per-queue FIFO ordering for initial deliveries + at-least-once with acknowledgements:
  rabbitmqOrder: 'https://www.rabbitmq.com/docs/queues',
  rabbitmqReliability: 'https://www.rabbitmq.com/docs/reliability',
  // Core NATS: fire-and-forget, at-most-once, in-order from a single publisher (no persistence):
  natsCore: 'https://docs.nats.io/nats-concepts/core-nats',
  // Amazon DynamoDB: eventually-consistent reads by default (strong is an opt-in per-request parameter):
  dynamodb: 'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html',
  // Apache Cassandra: per-query TUNABLE consistency, but the reference cqlsh client documents its OWN default as
  // CL ONE for both reads and writes ("The default CQL shell level is ONE"):
  cassandra: 'https://docs.datastax.com/en/cql-oss/3.3/cql/cql_reference/cqlshConsistency.html',
  // Amazon OpenSearch/Elasticsearch: near-real-time — a document is searchable only after the next refresh:
  elasticsearch: 'https://www.elastic.co/guide/en/elasticsearch/reference/current/near-real-time.html',
  // Amazon S3: strong read-after-write for new objects (documented since Dec 2020):
  s3: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel',
} as const;

// ---- WRITERS / PRIMARIES: strong reads (read-your-writes off a single primary) ----
/** A relational PRIMARY/writer IN port: reads off it are strongly consistent (documented single-primary
 *  read-your-writes). Consistency only — a primary does not by itself constrain ordering/delivery of a request. */
export const writerContribution = contribution('relational primary · in port', [
  { dimension: dims.consistency, token: consistency.strong, est: true }, // single-primary read-your-writes (behaviour, not a published SLA)
]);
/** The pure token map for a writer IN port (the manifest attaches this; the register reads `writerContribution`). */
export const writerGuarantees: Guarantees = writerContribution.guarantees;

// ---- READ REPLICAS / async projections: eventual reads ----
/** A read-replica IN port: replication lag ⇒ eventual reads (documented RDS behaviour). Ordering unclaimed. */
export const replicaContribution = contribution('read replica · in port', [
  { dimension: dims.consistency, token: consistency.eventual, source: SRC.rdsReplica },
]);
export const replicaGuarantees: Guarantees = replicaContribution.guarantees;
/** An ASYNC PROJECTION edge (write → materialised read model updated asynchronously): the read is eventual by
 *  construction. Attached to the edge, so the root cause of a CQRS read's eventual freshness is that exact hop. */
export const asyncProjectionContribution = contribution('async materialised-view projection · edge', [
  { dimension: dims.consistency, token: consistency.eventual, est: true }, // an async projection is eventual by construction
]);
export const asyncProjectionGuarantees: Guarantees = asyncProjectionContribution.guarantees;

// ---- MESSAGING / STREAMING: ordering + delivery on the delivering (out) port ----
/** SQS STANDARD out port: best-effort ordering (none) and at-least-once delivery (may-duplicate) — sourced. */
export const sqsStandardContribution = contribution('SQS standard · out port', [
  { dimension: dims.ordering, token: ordering.none, source: SRC.sqsStandard },
  { dimension: dims.delivery, token: delivery.mayDuplicate, source: SRC.sqsStandard },
]);
export const sqsStandardOut: Guarantees = sqsStandardContribution.guarantees;
/** SQS FIFO out port: ordering preserved per message-group (per-key); effective exactly-once (clean) — sourced. */
export const sqsFifoContribution = contribution('SQS FIFO · out port', [
  { dimension: dims.ordering, token: ordering.perKey, source: SRC.sqsFifo },
  { dimension: dims.delivery, token: delivery.clean, source: SRC.sqsFifo }, // effective exactly-once (dedup within the 5-min window)
]);
export const sqsFifoOut: Guarantees = sqsFifoContribution.guarantees;
/** A generic FAN-OUT topic out port: delivery to multiple consumers keeps no order (ordering → none). */
export const fanoutContribution = contribution('fan-out topic · out port', [
  { dimension: dims.ordering, token: ordering.none, est: true }, // a broadcast fan-out preserves no cross-consumer order
]);
export const fanoutOut: Guarantees = fanoutContribution.guarantees;
/** RabbitMQ out port: per-queue FIFO ordering for initial deliveries (per-key) + at-least-once (may-duplicate)
 *  once acknowledgements/redelivery are used — both sourced from the RabbitMQ docs. */
export const rabbitmqContribution = contribution('RabbitMQ · out port', [
  { dimension: dims.ordering, token: ordering.perKey, source: SRC.rabbitmqOrder }, // FIFO per queue for initial deliveries
  { dimension: dims.delivery, token: delivery.mayDuplicate, source: SRC.rabbitmqReliability }, // ack/redelivery ⇒ at-least-once
]);
export const rabbitmqOut: Guarantees = rabbitmqContribution.guarantees;
/** Core NATS out port: in-order from a single publisher (per-key) but fire-and-forget, at-most-once — a slow or
 *  absent consumer DROPS messages. We declare only what the lattice can model today: ordering per-key (sourced).
 *  (`may-lose` / at-most-once is honestly NOT in the v1 delivery lattice — the delivery dimension models only
 *  duplication; NATS core does not duplicate, so it makes no delivery claim = TOP, the honest neutral.) */
export const natsContribution = contribution('core NATS · out port', [
  { dimension: dims.ordering, token: ordering.perKey, source: SRC.natsCore }, // in order from a given publisher
]);
export const natsOut: Guarantees = natsContribution.guarantees;
/** Kafka out port: per-partition (per-key) ordering + at-least-once delivery by default (may-duplicate) — the
 *  canonical log's guarantees, sourced from the Kafka design docs. */
export const kafkaContribution = contribution('Kafka · out port', [
  { dimension: dims.ordering, token: ordering.perKey, source: SRC.kafka }, // total order within a partition = per-key
  { dimension: dims.delivery, token: delivery.mayDuplicate, source: SRC.kafka }, // at-least-once (unless idempotent producer)
]);
export const kafkaOut: Guarantees = kafkaContribution.guarantees;

// ---- KEY-VALUE / DOCUMENT / SEARCH stores whose DEFAULT read is eventual ----
/** DynamoDB IN port: reads are eventually consistent BY DEFAULT (strong is an opt-in per-request parameter), so a
 *  request path terminating here computes consistency:eventual unless the design declares strong reads — sourced. */
export const dynamodbContribution = contribution('DynamoDB · in port', [
  { dimension: dims.consistency, token: consistency.eventual, source: SRC.dynamodb },
]);
export const dynamodbGuarantees: Guarantees = dynamodbContribution.guarantees;
/** Cassandra IN port: consistency is a per-query TUNABLE (ONE/QUORUM/ALL/LOCAL_QUORUM/…), but the reference CQL
 *  shell (cqlsh) documents its OWN default as CL ONE for both reads and writes. At CL ONE, R + W ≤ RF (no
 *  guaranteed replica overlap), so the DEFAULT behaviour is an eventual read — strong is an opt-in per-query CL,
 *  the same shape as DynamoDB's opt-in strong read (dynamodbContribution above), NOT a single-primary writer.
 *  Sourced to cqlsh's OWN documented default — never borrows DynamoDB's citation for a different vendor's fact. */
export const cassandraContribution = contribution('Cassandra · in port', [
  { dimension: dims.consistency, token: consistency.eventual, source: SRC.cassandra },
]);
export const cassandraReadGuarantees: Guarantees = cassandraContribution.guarantees;
/** Elasticsearch/OpenSearch IN port: NEAR-REAL-TIME — an indexed document is searchable only after the next
 *  refresh (default 1 s), so a read is eventual by design — sourced. */
export const searchContribution = contribution('search index · in port', [
  { dimension: dims.consistency, token: consistency.eventual, source: SRC.elasticsearch },
]);
export const searchGuarantees: Guarantees = searchContribution.guarantees;

// ---- CACHES: a read is eventual UNLESS the app invalidates on write (which the model cannot see) ----
/** A cache read IN port: with NO declared invalidation, a cache serves whatever it last stored — stale after an
 * upstream write, so the read is EVENTUAL. Marked `est` — this is the honest default behaviour of an un-invalidated
 *  cache, not a published SLA; the architect can override it (declared "invalidates on write" ⇒ strong-on-hit) in
 *  R3. NOT `unknown`: an un-invalidated cache is definitely-eventual, not indeterminate. */
export const cacheReadContribution = contribution('cache · read (in) port', [
  { dimension: dims.consistency, token: consistency.eventual, est: true },
]);
export const cacheReadGuarantees: Guarantees = cacheReadContribution.guarantees;

// NOTE — deliberately NOT labelled (would be a guess, §3 "refused"):
//   • db.mongodb — read consistency is per-read-preference config (primary = strong, secondary = eventual); the
//     component fact is genuinely ambiguous, so no default token (refused, per the certain/declared/refused rule).
//   • storage.object (S3) — strong read-after-write for NEW objects but eventual for overwrites/lists; the
//     component-level token is ambiguous, so no default (refused). The sourced fact lives in SRC.s3 for R3 if the
//     design ever declares which access pattern it uses.

/** EVERY contribution the catalog attaches — one place to enumerate them for the labeling-integrity test (each
 *  declared token is a valid lattice token; each `documented` claim carries a source) and for the register lookup.
 *  A contribution's `guarantees` object is attached BY REFERENCE onto a manifest port, so {@link claimsFor} can map
 *  a port's token map back to its provenance without re-deriving it. */
export const catalogGuaranteeContributions: readonly GuaranteeContribution[] = [
  writerContribution,
  replicaContribution,
  asyncProjectionContribution,
  cacheReadContribution,
  searchContribution,
  dynamodbContribution,
  cassandraContribution,
  sqsStandardContribution,
  sqsFifoContribution,
  fanoutContribution,
  rabbitmqContribution,
  natsContribution,
  kafkaContribution,
];

// Reference index: the exact `Guarantees` object a port carries → its contribution. The manifests attach
// `contribution.guarantees` (the same object), so a design-doc register or an inspector can recover the sourced
// claims from a port's token map by identity — no fragile token-string matching, no provenance re-derivation.
const byGuaranteesRef = new WeakMap<Guarantees, GuaranteeContribution>();
for (const c of catalogGuaranteeContributions) byGuaranteesRef.set(c.guarantees, c);

/** The sourced claims behind a port/edge's token map, or undefined if the map is not a catalog contribution (e.g.
 *  a hand-authored guarantee on a custom component). Used by the design-doc register + the inspector to badge each
 *  declared token with its provenance. Matches by object identity — the manifest attaches the very object. */
export function claimsFor(guarantees: Guarantees | undefined): readonly GuaranteeClaim[] | undefined {
  return guarantees === undefined ? undefined : byGuaranteesRef.get(guarantees)?.claims;
}
