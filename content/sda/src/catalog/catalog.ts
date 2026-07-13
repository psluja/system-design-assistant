import { keys as k } from '../vocabulary/registry';
import type { Manifest } from '../vocabulary/manifest';
import { availabilityByDeployment, connectionPool, costPer, egress, lambdaAccountConcurrency, provisionedCost, RETRY_POLICY_CONFIG, unitCostConfig, withOrigin, withOverflow } from './behaviors';

// DES QUEUEING for the fixed-throughput relational archetypes (calibration #1 — see common.ts for the full
// rationale). A relational DB is connection-bound: give it the same M/M/c DES form as the concrete stores so its
// p99 rises with load instead of a flat pure delay. `held` = the query time it holds a connection (the node's
// `latency`); c = throughput × held is the Little's-law in-flight concurrency, within a typical RDBMS
// max_connections (~100). Config-only (no poolOverflow relation — the universal `overflow` band already flags
// saturation at the same threshold); c / (held/1000) == the existing `throughput` ceiling, so capacity is unchanged.
const SQL_POOL_SOURCE = 'https://www.postgresql.org/docs/current/runtime-config-connection.html'; // max_connections default = 100 (the ceiling the in-flight count sits within)

// AWS Lambda ACCOUNT concurrency (default 1,000 concurrent executions per Region, soft):
// https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
const FAAS_ACCOUNT_CONCURRENCY = lambdaAccountConcurrency();

// A typical API response payload — illustrative; the architect sets the real size. Internet egress @ $0.09/GB.
const GW_EGRESS = egress(20_000);
import { clientOut, triggerIn } from '../vocabulary/port-roles';
import { writerGuarantees } from '../vocabulary/guarantees';

// EC2 SLA: single instance 99.5%, ≥2-AZ deployment 99.99% (https://aws.amazon.com/compute/sla/).
const EC2_SLA_SOURCE = 'https://aws.amazon.com/compute/sla/';
const VM_AVAILABILITY = availabilityByDeployment(0.995, 0.9999, 0.9999, EC2_SLA_SOURCE);

// A SEED CATALOG of archetype-first manifests. Numbers are illustrative starting points, not
// claims of truth — real, sourced limits per concrete service come later. Each is pure data.

export const manifests: Readonly<Record<string, Manifest>> = withOverflow(withOrigin({
  // A load source: offers demand, no added latency/cost, always up. Its demand rides the universal `assumedRps`
  // origin knob (: unified) — a client is just a node whose whole job is to originate; ANY node can
  // originate the same way (folded into its emitted throughput at a source; see manifest.ts `instantiate` and
  // behaviors.ts `withOrigin`), so a client-less design (DB-to-DB migration) works. Declaring the demand as
  // `assumedRps` (not `throughput`, the old convenience preset) means a scenario/named-world/derived-trio can
  // reach it directly — `assumedRps` is a fact-assumption; `throughput`'s GLOBAL role is `computed`, so it was
  // never truly scenario-overridable. A pre-unification `{ throughput: X }` override still loads (instantiate's
  // compatibility sugar + the app/core document migration).
  'client.source': {
    type: 'client.source',
    ports: [{ name: 'out', dir: 'out', speaks: ['https', 'http'] }],
    config: [
      { key: k.assumedRps, value: 1000, unit: 'req/s', est: true }, // the workload the architect is expected to declare/tune — a credible illustrative starting rate, not a vendor fact
      { key: k.latency, value: 0, unit: 'ms' }, // neutral: a client adds no hop latency of its own
      { key: k.availability, value: 1, unit: 'ratio' }, // neutral: an abstract client is always "up"
      ...RETRY_POLICY_CONFIG, // a client is a caller: it can declare a timeout + retries (default 0 = off)
    ],
  },

  // An API gateway. The default AWS account-level throttle is a DOCUMENTED, outage-causing ceiling: 10,000 req/s
  // steady-state per account per Region, with a 5,000-request burst bucket (token-bucket). Soft (quota-increasable
  // EXCEPT the burst, which the service team sets): https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html
  // Past 10k rps API Gateway returns 429 Too Many Requests. The universal `overflow` relation (via withOverflow)
  // flags the rejected excess = max(0, offered − 10,000); those rejects ARE the 429s.
  // The 5,000 burst is a token-bucket ALLOWANCE over the steady-state rate (a transient), not a steady ceiling, so
  // it is recorded as config (documented) but not a second forward band — the steady-state 429 breach is the honest,
  // load-independent verdict; burst absorption is a DES/time question.
  'gateway.api': {
    type: 'gateway.api',
    ports: [
      { name: 'in', dir: 'in', accepts: ['http'] },
      { name: 'out', dir: 'out', speaks: ['http'] },
    ],
    config: [
      // default account throttle: 10,000 rps steady-state (soft) — a DOCUMENTED, outage-causing ceiling
      { key: k.throughput, value: 10000, unit: 'req/s', source: 'https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html' },
      { key: k.latency, value: 5, unit: 'ms', est: true },
      { key: k.availability, value: 0.9995, unit: 'ratio', source: 'https://aws.amazon.com/api-gateway/sla/' },
      unitCostConfig(0.005, 'USD/(req/s)·month'), // managed API gateway (est., list): $50/mo at the default 10k rps ceiling; upsizing the ceiling costs more
      ...GW_EGRESS.config,
    ],
    relations: [provisionedCost, GW_EGRESS.relation],
  },

  // A serverless function: capacity is Little's law (concurrency / service-time).
  'compute.faas': {
    type: 'compute.faas',
    ports: [
      triggerIn(), // invoked over HTTP/HTTPS, OR triggered by a queue/stream/event source (SQS, SNS, Kafka…)
      clientOut('out', 'https'), // a function calls any backend — HTTP/gRPC service, SQL/NoSQL DB, cache, AWS API…

    ],
    config: [
      { key: k.concurrency, value: 100, unit: '1', est: true }, // per-function reserved concurrency (workload/config choice)
      { key: k.perRequestDuration, value: 50, unit: 'ms', est: true },
      { key: k.latency, value: 50, unit: 'ms', est: true },
      { key: k.availability, value: 0.9995, unit: 'ratio', source: 'https://aws.amazon.com/lambda/sla/' }, // AWS Lambda SLA 99.95%
      unitCostConfig(1.5, 'USD/conc·month'), // managed serverless / FaaS (est.): priced per reserved concurrency unit
      ...FAAS_ACCOUNT_CONCURRENCY.config, // account-level concurrency ceiling (default 1,000, soft)
    ],
    relations: [
      { key: k.throughput, reads: [k.concurrency, k.perRequestDuration], expr: 'concurrency / (perRequestDuration / 1000)' },
      // cost scales with provisioned concurrency — so "run backwards" has a real trade-off to optimize
      costPer(k.concurrency),
      // ACCOUNT-concurrency limit: offered load implies concurrency (Little's law); throttled past the quota.
      ...FAAS_ACCOUNT_CONCURRENCY.relations,
    ],
    bands: [...FAAS_ACCOUNT_CONCURRENCY.bands],
  },

  // A VM-based compute alternative: a fixed capacity ceiling and a flat price (no concurrency knob).
  'compute.vm': {
    type: 'compute.vm',
    ports: [
      triggerIn(),
      clientOut('out', 'https'), // a function calls any backend — HTTP/gRPC service, SQL/NoSQL DB, cache, AWS API…

    ],
    config: [
      { key: k.throughput, value: 800, unit: 'req/s', est: true },
      { key: k.latency, value: 40, unit: 'ms', est: true },
      VM_AVAILABILITY.config, // deploymentMode (default ≥2-AZ); availability = sourced EC2 SLA per mode
      unitCostConfig(0.15, 'USD/(req/s)·month'), // self-managed VM / EC2 (est., list): $120/mo at the default 800 rps ceiling
    ],
    relations: [provisionedCost, VM_AVAILABILITY.relation],
  },

  // A relational database: a sustained-qps ceiling, query latency, the priciest hop.
  'db.sql': {
    type: 'db.sql',
    // A relational PRIMARY/writer: reads off it are strongly consistent (read-your-writes off a single primary).
    ports: [{ name: 'in', dir: 'in', accepts: ['postgresql', 'mysql', 'tds', 'oracle-tns', 'odbc'], guarantees: writerGuarantees }],
    config: [
      { key: k.throughput, value: 2000, unit: 'req/s', est: true },
      { key: k.latency, value: 8, unit: 'ms', est: true },
      // this cited https://aws.amazon.com/rds/sla/ but carried 0.9999 — the SOURCED-BUT-WRONG case; the
      // page itself publishes Multi-AZ 99.95% (verified live 2026-07-12), matching db.postgres's Multi-AZ tier
      // (see RDS_AVAILABILITY in common.ts: availabilityByDeployment(0.995, 0.9995, 0.9995, ...)). Corrected to
      // agree with its own citation. (Tempting follow-up, OUT OF SCOPE here: mirror db.postgres's
      // availabilityByDeployment(single-AZ/Multi-AZ) pattern instead of one flat figure — a restructuring, not a
      // value fix.)
      { key: k.availability, value: 0.9995, unit: 'ratio', source: 'https://aws.amazon.com/rds/sla/' },
      unitCostConfig(0.1, 'USD/(req/s)·month'), // managed relational DB, RDS-class (est.): $200/mo at the default 2000 rps ceiling
      ...connectionPool(16, 8, SQL_POOL_SOURCE).config, // DES M/M/16 (in-flight = 2,000 req/s × 8 ms query); 16 / (8 ms) = 2,000 req/s == throughput
    ],
    relations: [provisionedCost],
  },

  // A cheaper datastore alternative — genuinely "cheaper but more LIMITED", never a free win: it
  // must NOT strictly dominate db.sql/db.postgres. It buys the lower price by being single-AZ — clearly lower
  // availability (0.99 vs db.sql's 0.9995) AND lower durability (0.999, no PITR/replica, vs db.postgres' ~5
  // nines) — and by a lower throughput ceiling (1000 vs db.sql's 2000). Faster latency alone is not a free
  // lunch: you trade resilience and headroom for cost. Availability/durability here are illustrative
  // single-AZ figures, not a sourced SLA.
  'db.cheap': {
    type: 'db.cheap',
    // A single-AZ relational writer: still a single primary, so reads off it are strongly consistent (the cheapness
    // is bought in availability/durability/throughput, NOT in consistency — see the config below).
    ports: [{ name: 'in', dir: 'in', accepts: ['postgresql', 'mysql', 'tds', 'oracle-tns', 'odbc'], guarantees: writerGuarantees }],
    config: [
      { key: k.throughput, value: 1000, unit: 'req/s', est: true },
      { key: k.latency, value: 12, unit: 'ms', est: true },
      { key: k.availability, value: 0.99, unit: 'ratio', est: true }, // single-AZ (illustrative) — a real step below db.sql's 0.9995
      { key: k.durability, value: 0.999, unit: 'ratio', est: true }, // no PITR/replica (illustrative) — below db.postgres' ~5 nines
      unitCostConfig(0.09, 'USD/(req/s)·month'), // managed single-AZ DB (est./illustrative): $90/mo at the default 1000 rps ceiling — cheaper per rps than db.sql ($0.10)
      ...connectionPool(12, 12, SQL_POOL_SOURCE).config, // DES M/M/12 (in-flight = 1,000 req/s × 12 ms query); 12 / (12 ms) = 1,000 req/s == throughput
    ],
    relations: [provisionedCost],
  },
}));
