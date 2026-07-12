import type { Key } from '@sda/engine-core';
import { keys as k } from '../vocabulary/registry';
import type { Manifest, ManifestBand, ManifestConfig, ManifestRelation } from '../vocabulary/manifest';

// Shared OVERLOAD behaviour, as reusable DATA (the engine stays domain-agnostic). `overflow` is the load
// offered to a component beyond what it can serve — req/s rejected / dropped / throttled.
//
// ONE definition for every component: the OFFERED demand is `inflow(throughput) + self(assumedRps)` (what arrives
// from upstream, carried across async edges, PLUS what this node ORIGINATES itself — a node can be a traffic
// source, not only a relay), and the capacity is `self(throughput)` — the node's OWN throughput (its config or
// relation), read via the engine's `self()` primitive. Because `self(throughput)` resolves to whatever a
// component declares as its throughput — a fixed config, a Little's-law relation, or a sized fleet's
// `maxUnits × per-unit` — this single relation subsumes the old FIXED / LITTLE / REPLICATED / sized variants. It
// is applied UNIFORMLY by `withOverflow` (below), so no component can silently forget it. `assumedRps` defaults to
// 0, so for every relay (and every existing design) the offered demand is exactly `inflow(throughput)` as before.

export const OVERFLOW_BAND: ManifestBand = { key: k.overflow, band: { shape: 'minTargetMax', max: 0 } };

// Target utilisation (capacity headroom) for BACKWARD sizing: keep each sizable tier at ρ ≤ this so the solved
// design has FINITE queueing latency, not the ρ=1 knife-edge that serves the load but with an unbounded queue
// (USE method's ~70-80% rule). The web/MCP pass {key: throughput, factor: TARGET_UTILIZATION} to optimize/repair;
// it is a SOLVER target only — it never changes the forward-pass verdicts.
export const TARGET_UTILIZATION = 0.8;

// DATA-TRANSFER (egress) cost — the most-missed line on a real bill. A node at the
// internet boundary sending `payloadBytes` per request out pays `egressUsdPerGb` per GB. egressCost (USD/month)
// = inflow(throughput) · payloadBytes · egressUsdPerGb · seconds/month / 1e9 — a SEPARATE line from compute/
// storage `cost`, summed across the design. AWS internet data-transfer-out ≈ $0.09/GB (first 10 TB/mo, sourced:
// https://aws.amazon.com/ec2/pricing/on-demand/ "Data Transfer"); CloudFront ≈ $0.085/GB. payloadBytes is an
// illustrative default per edge tier — the architect sets the real response/message size. Apply to the
// INTERNET-FACING tier only (in a path with several possible boundaries, zero the inner tiers' payload so
// the egress is not double-counted — only the outermost tier actually transfers to the internet).
const MONTH_SECONDS = 2_592_000; // a 30-day month
export const EGRESS: ManifestRelation = {
  key: k.egressCost,
  reads: [k.throughput, k.payloadBytes, k.egressUsdPerGb],
  expr: `inflow(throughput) * payloadBytes * egressUsdPerGb * ${MONTH_SECONDS} / 1000000000`,
};
/** AWS internet data-transfer-out price (first 10 TB/mo ≈ $0.09/GB) — a SOURCED default the register can badge. */
const EGRESS_PRICE_SOURCE = 'https://aws.amazon.com/ec2/pricing/on-demand/';
/** Give a component a data-transfer (egress) line: a default payload size (an est., architect-tunable per tier) +
 *  the SOURCED egress price + the relation. */
export function egress(payloadBytes: number, usdPerGb = 0.09): { readonly config: readonly ManifestConfig[]; readonly relation: ManifestRelation } {
  return {
    config: [
      { key: k.payloadBytes, value: payloadBytes, unit: 'byte', est: true }, // an illustrative per-tier payload; the architect sets the real size
      { key: k.egressUsdPerGb, value: usdPerGb, unit: 'USD/GB', source: EGRESS_PRICE_SOURCE },
    ],
    relation: EGRESS,
  };
}

/**
 * overflow = OFFERED − SERVED, for ANY component. The OFFERED load is what arrives from upstream PLUS what
 * this node ORIGINATES itself: `inflow(throughput) + self(assumedRps)` (a node can be a traffic source, not
 * just a relay — see `withOrigin`). The SERVED amount is the node's emitted `throughput`, which the universal
 * origin wrapper has already clamped to `min(capacity, offered)`. So overflow = offered − served =
 * max(0, offered − capacity) — the rejected/dropped/throttled excess — WITHOUT a separate capacity read
 * (self(throughput) IS the served value after wrapping, and offered − min(cap,offered) = max(0, offered−cap)).
 * Origin defaults to 0 ⇒ this is identical to the old `inflow − self(throughput)` for every existing design.
 */
export const OVERFLOW: ManifestRelation = { key: k.overflow, reads: [k.throughput, k.assumedRps], expr: 'max(0, (inflow(throughput) + self(assumedRps)) - self(throughput))' };

// ─── DOCUMENTED-LIMITS behaviors (task-72), each a sourced, outage-causing ceiling as reusable DATA ───

/**
 * LAMBDA ACCOUNT CONCURRENCY (default 1,000 concurrent executions per Region, SOFT — quota-increasable):
 * https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
 * https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html
 * A serverless fleet is throttled not only by its own per-function `concurrency` knob but by the Region-wide
 * account quota. The concurrency the OFFERED load implies is Little's law (arrivalRate × service-time):
 *   concurrencyNeeded = inflow(throughput) × perRequestDuration / 1000   (req/s × s = simultaneous executions)
 * and the throttled excess is concurrencyOverflow = max(0, needed − accountConcurrency), banded ≤ 0. When it
 * is > 0 Lambda throttles (429 / TooManyRequestsException); the remedy is a quota increase or reserved/
 * provisioned concurrency. BURST behaviour (a +500-per-10s / +5,000-rps-per-10s scale-up ramp) is a
 * TRANSIENT, not a steady-state ceiling, so it is NOT modelled here — recorded as honestly uncovered
 * (the numeric hot path is steady-state; a ramp is a DES/time question).
 */
export const LAMBDA_ACCOUNT_CONCURRENCY_DEFAULT = 1000;
/** The primary AWS doc for the account concurrency quota — sourced, so the register links the ceiling. */
const LAMBDA_CONCURRENCY_SOURCE = 'https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html';
export const CONCURRENCY_NEEDED: ManifestRelation = {
  key: k.concurrencyNeeded,
  reads: [k.throughput, k.perRequestDuration],
  expr: 'inflow(throughput) * (perRequestDuration / 1000)',
};
export const CONCURRENCY_OVERFLOW: ManifestRelation = {
  key: k.concurrencyOverflow,
  reads: [k.concurrencyNeeded, k.accountConcurrency],
  expr: 'max(0, self(concurrencyNeeded) - self(accountConcurrency))',
};
export const CONCURRENCY_OVERFLOW_BAND: ManifestBand = { key: k.concurrencyOverflow, band: { shape: 'minTargetMax', max: 0 } };
/** Give a Lambda archetype the documented account-concurrency ceiling + the two derived keys + the band.
 *  Default ceiling = the sourced 1,000; pass a smaller number for an account with a reserved/lowered quota. */
export function lambdaAccountConcurrency(accountConcurrency = LAMBDA_ACCOUNT_CONCURRENCY_DEFAULT): {
  readonly config: readonly ManifestConfig[];
  readonly relations: readonly ManifestRelation[];
  readonly bands: readonly ManifestBand[];
} {
  return {
    config: [{ key: k.accountConcurrency, value: accountConcurrency, unit: '1', source: LAMBDA_CONCURRENCY_SOURCE }],
    relations: [CONCURRENCY_NEEDED, CONCURRENCY_OVERFLOW],
    bands: [CONCURRENCY_OVERFLOW_BAND],
  };
}

/**
 * CONNECTION-POOL budget (RDS Proxy, pgbouncer): the proxy multiplexes any number of CLIENT connections onto
 * a fixed pool of BACKEND connections; one request holds a pooled connection for ~the backend's per-query
 * time. Little's law on the pool: poolConnectionsNeeded = inflow(throughput) × connectionHeldMs/1000;
 * poolOverflow = max(0, needed − connectionPool), banded ≤ 0 (excess demand waits — the borrow queue — or
 * times out). Deliberately NOT the `concurrency` key, so the DES keeps the proxy as a thin fixed-latency
 * pass-through station instead of double-counting the backend's service time.
 */
export const POOL_NEEDED: ManifestRelation = {
  key: k.poolConnectionsNeeded,
  reads: [k.throughput, k.connectionHeldMs],
  expr: 'inflow(throughput) * (self(connectionHeldMs) / 1000)',
};
export const POOL_OVERFLOW: ManifestRelation = {
  key: k.poolOverflow,
  reads: [k.poolConnectionsNeeded, k.connectionPool],
  expr: 'max(0, self(poolConnectionsNeeded) - self(connectionPool))',
};
export const POOL_OVERFLOW_BAND: ManifestBand = { key: k.poolOverflow, band: { shape: 'minTargetMax', max: 0 } };
/** Give a pooling proxy its connection budget: pool size + held-time (≈ the backend's per-query ms — the
 *  architect tunes it to their workload, so an `est.`) + the Little's-law demand/overflow pair + the band. Pass
 *  `poolSource` (the RDS Proxy doc) so the register badges the documented pool = MaxConnectionsPercent × target
 *  max_connections. */
export function connectionPool(pool: number, heldMs: number, poolSource?: string): {
  readonly config: readonly ManifestConfig[];
  readonly relations: readonly ManifestRelation[];
  readonly bands: readonly ManifestBand[];
} {
  return {
    config: [
      { key: k.connectionPool, value: pool, unit: '1', ...(poolSource !== undefined ? { source: poolSource } : {}) },
      { key: k.connectionHeldMs, value: heldMs, unit: 'ms', est: true }, // ≈ the backend's per-query time — a workload-dependent estimate
    ],
    relations: [POOL_NEEDED, POOL_OVERFLOW],
    bands: [POOL_OVERFLOW_BAND],
  };
}

/**
 * PAYLOAD-SIZE CEILING (documented item/message max size), as reusable DATA. Informational: it only ever
 * fires when the architect sets the node's `payloadBytes` (the real item/message size) — 0 by default, so
 * the limit is never falsely breached. payloadOverflow = max(0, payloadBytes − maxItemBytes), banded ≤ 0.
 * Sourced per component (DynamoDB 400 KB item, SQS 256 KB message) at the call site.
 */
export const PAYLOAD_OVERFLOW: ManifestRelation = {
  key: k.payloadOverflow,
  reads: [k.payloadBytes, k.maxItemBytes],
  expr: 'max(0, self(payloadBytes) - self(maxItemBytes))',
};
export const PAYLOAD_OVERFLOW_BAND: ManifestBand = { key: k.payloadOverflow, band: { shape: 'minTargetMax', max: 0 } };
/** Give a component a documented payload-size ceiling: the max bytes + a default (0 = unset) payloadBytes +
 *  the overflow relation + its band. `maxBytes` is the sourced limit (DynamoDB 400 KB, SQS 256 KB); pass its
 *  primary-doc URL as `source` so the assumptions register badges the ceiling `documented` and links it. */
export function payloadLimit(maxBytes: number, source?: string): {
  readonly config: readonly ManifestConfig[];
  readonly relation: ManifestRelation;
  readonly band: ManifestBand;
} {
  return {
    config: [
      { key: k.maxItemBytes, value: maxBytes, unit: 'byte', ...(source !== undefined ? { source } : {}) },
      { key: k.payloadBytes, value: 0, unit: 'byte' }, // unset by default — the architect enters the real item/message size
    ],
    relation: PAYLOAD_OVERFLOW,
    band: PAYLOAD_OVERFLOW_BAND,
  };
}

/**
 * Availability by AWS DEPLOYMENT MODE — a node-local `deploymentMode` knob (0 = single-AZ, 1 = Multi-AZ,
 * 2 = multi-Region) selecting the PUBLISHED AWS SLA for that mode. Sourced, not derived: AWS publishes the
 * Multi-AZ / multi-Region SLA directly (e.g. RDS single-AZ 99.5% vs Multi-AZ 99.95%, https://aws.amazon.com/rds/sla/),
 * so we pick the committed number per mode rather than the parallel formula `1−(1−a)^n` (which the relation
 * language has no exponent for, and whose variable exponent is hostile to the MIP solver). Default = Multi-AZ.
 * Pass the single / multiAz / (optional) multiRegion availabilities, each the published SLA. Returns the
 * `deploymentMode` config + the piecewise `availability` relation (a step function in the integer mode).
 */
export function availabilityByDeployment(single: number, multiAz: number, multiRegion: number = multiAz, slaSource?: string): { config: ManifestConfig; relation: ManifestRelation } {
  return {
    // The deployment mode SELECTS a published SLA, so its `source` (when given) points at that SLA page — the
    // register then badges the deployment mode `documented` and links the SLA the availability derives from.
    config: { key: k.deploymentMode, value: 1, unit: '1', ...(slaSource !== undefined ? { source: slaSource } : {}) },
    relation: {
      key: k.availability,
      reads: [k.deploymentMode],
      // single-AZ baseline + the (sourced) uplift for Multi-AZ, + the further uplift for multi-Region.
      expr: `${single} + (${multiAz - single}) * (deploymentMode >= 1) + (${multiRegion - multiAz}) * (deploymentMode >= 2)`,
    },
  };
}

// COST by DEPLOYMENT MODE — the companion to availabilityByDeployment (task-77: "redundancy is not free"). The
// availability relation steps availability UP with deploymentMode; without this, cost stayed FLAT — Multi-AZ was
// free in the model, understating every redundant database's price and letting any optimizer (or human) pick
// redundancy without paying for it. REALITY (sourced): RDS Multi-AZ bills the STANDBY at ≈ the single-AZ instance
// price, i.e. the Multi-AZ instance rows are DOUBLE the single-AZ rows (https://aws.amazon.com/rds/pricing/);
// Aurora Multi-AZ = a writer PLUS a reader, each billed per instance. Multi-region adds a SECOND cluster + the
// cross-region replication data transfer — an ESTIMATE (exact figures are workload/region-dependent).
//
// So the cost gets a piecewise MULTIPLIER — the SAME step-function shape as the availability relation, in the same
// integer `deploymentMode`:  costFactor = 1 + STANDBY·(mode≥1) + REGION_EXTRA·(mode≥2). At the default Multi-AZ
// (mode 1) the factor is 2 (the sourced standby); at multi-region (mode 2) ≈ 2.2 (estimated). We fold it onto the
// node's EXISTING cost relation by wrapping its expr in `(base) * factor`, so the cost MODEL (what the base
// multiplies — connections / replicas / usage) is untouched; only the redundancy surcharge is layered on.
//
// AUDIT — apply ONLY where the mode step implies an EXTRA BILLED resource the base cost does NOT already count:
//   • RDS (db.postgres / db.mysql): Multi-AZ standby billed ≈ 2× — YES.        (costPer(concurrency) counts one instance)
//   • Aurora (db.aurora): Multi-AZ reader billed per instance — YES.           (costPer(concurrency) counts the writer only)
//   • DynamoDB (db.dynamodb): INHERENTLY multi-AZ; the published on-demand price ALREADY includes cross-AZ
//     replication — applying this would DOUBLE-CHARGE. NOT wrapped. (Its mode-2 global-tables surcharge is a
// separate, genuinely-extra region and is a documented follow-up, not this fold.)
//   • S3 (storage.object): no deploymentMode knob at all (flat availability); inherently replicated — out of scope.
//   • EC2 ASG (compute.asg): sized by a UNIT COUNT (costPer(requiredUnits)) that ALREADY prices every running
//     instance; AZ spread of the same count adds no billed instance — wrapping would double-charge. NOT wrapped.
// The multiplier is SOURCED (Multi-AZ ×2) / ESTIMATED (multi-region) as DATA via the flags below, so the design
// doc's assumptions register badges the surcharge automatically.

/** RDS Multi-AZ bills the standby at ≈ the primary's price — the Multi-AZ instance rows are DOUBLE the single-AZ
 *  rows (sourced). So the Multi-AZ (mode ≥ 1) cost multiplier ADDS 1.0× (a second billed instance) ⇒ factor 2×. */
export const MULTI_AZ_COST_STANDBY = 1.0;
/** Multi-region (mode ≥ 2) adds cross-region replication + a standby footprint in the second Region. An ESTIMATE
 * (exact spend is region/workload-dependent): a further +0.3× on top of the ×2 Multi-AZ ⇒ a TOTAL factor
 *  ≈ 2.3× (inside task-77's est. 2.2–2.5 band). Deliberately NOT a full second ×2: the primary Region's standby is
 *  already billed at mode 1, so mode 2 layers the replica/replication surcharge, not a whole duplicate cluster. */
export const MULTI_REGION_COST_EXTRA = 0.3;
/** The sourced RDS pricing page the Multi-AZ ≈ 2× standby figure comes from — badged `documented` on the surcharge. */
export const RDS_PRICING_SOURCE = 'https://aws.amazon.com/rds/pricing/';

/**
 * Wrap a base cost relation with the deployment-mode surcharge (task-77). The returned relation computes the SAME
 * base cost, then multiplies by the piecewise factor `1 + STANDBY·(mode≥1) + REGION_EXTRA·(mode≥2)` — so flipping a
 * node to Multi-AZ doubles its cost (the billed standby/replica) and multi-region ≈ 2.2×. `deploymentMode` is
 * added to the relation's reads (it is a node-local input the availability relation already declares). Apply ONLY
 * to manifests whose base cost does NOT already count the redundant instance (see the AUDIT above) — never to
 * inherently-replicated services (DynamoDB/S3) whose published price already includes replication.
 */
export function withDeploymentCost(base: ManifestRelation): ManifestRelation {
  return {
    key: base.key,
    reads: [...new Set([...base.reads, k.deploymentMode])],
    // (base cost) × the redundancy factor. Parenthesise the base so its own arithmetic binds before the multiply.
    expr: `(${base.expr}) * (1 + ${MULTI_AZ_COST_STANDBY} * (deploymentMode >= 1) + ${MULTI_REGION_COST_EXTRA} * (deploymentMode >= 2))`,
  };
}

const hasThroughput = (m: Manifest): boolean =>
  (m.config ?? []).some((c) => c.key === k.throughput) || (m.relations ?? []).some((r) => r.key === k.throughput);
const receivesWork = (m: Manifest): boolean => m.ports.some((p) => p.dir === 'in' || p.dir === 'bi');
const hasOverflow = (m: Manifest): boolean => (m.relations ?? []).some((r) => r.key === k.overflow);
const hasOrigin = (m: Manifest): boolean =>
  (m.config ?? []).some((c) => c.key === k.assumedRps) || (m.relations ?? []).some((r) => r.key === k.assumedRps);

// UNIVERSAL TRAFFIC ORIGIN (the design correction: every node can be a source, not only `client.*`).
//
// A node's emitted `throughput` conflates two roles the engine keeps in ONE key: a node's CAPACITY (read as
// `self(throughput)` by provisionedCost, the queue ingest ceiling and the SEARCH's ρ-headroom `inflow ≤
// factor·self(throughput)`) and the load it EMITS (`out = min(self(throughput), inflow)`). We must not disturb
// `self(throughput)` where it means capacity. Whether a node ORIGINATES vs RELAYS is a TOPOLOGY fact (a source
// has no inbound wire) — not knowable from a manifest — so the origin fold happens per-instance in `instantiate`
// (see `foldOriginAtSource`), NOT here. `withOrigin` only makes every node CAPABLE of originating: it adds the
// default `assumedRps = 0` knob. The default of 0 keeps every existing design byte-for-byte identical.
export function withOrigin(catalog: Readonly<Record<string, Manifest>>): Record<string, Manifest> {
  const out: Record<string, Manifest> = {};
  for (const [id, m] of Object.entries(catalog)) {
    out[id] = hasOrigin(m) ? m : { ...m, config: [...(m.config ?? []), { key: k.assumedRps, value: 0, unit: 'req/s' }] };
  }
  return out;
}

/** Give every component that RECEIVES work and declares a throughput (capacity) the universal overflow
 *  verdict — uniformly, never per-component, never forgotten. Pure SOURCES (no input port — clients/
 *  generators) are skipped: they OFFER load, they don't receive it (so `inflow` is undefined for them). */
export function withOverflow(catalog: Readonly<Record<string, Manifest>>): Record<string, Manifest> {
  const out: Record<string, Manifest> = {};
  for (const [id, m] of Object.entries(catalog)) {
    out[id] =
      receivesWork(m) && hasThroughput(m) && !hasOverflow(m)
        ? { ...m, relations: [...(m.relations ?? []), OVERFLOW], bands: [...(m.bands ?? []), OVERFLOW_BAND] }
        : m;
  }
  return out;
}

// DEMAND-DRIVEN SIZING, as reusable DATA — for any auto-scaling fleet (Fargate, Cloud Run, Kubernetes HPA,
// EC2 ASG, …). Given the offered load (via inflow) and per-unit capacity (Little's law), it derives how many
// units are needed and the cost. Overflow past the unit ceiling is the universal `OVERFLOW` (capacity =
// self(throughput) = maxUnits × per-unit), added by `withOverflow` — not redeclared here.
const PER_UNIT = 'concurrency / (perRequestDuration / 1000)';
export const sizingRels = (): ManifestRelation[] => [
  { key: k.throughput, reads: [k.maxUnits, k.concurrency, k.perRequestDuration], expr: `maxUnits * ${PER_UNIT}` },
  { key: k.requiredUnits, reads: [k.throughput, k.concurrency, k.perRequestDuration], expr: `inflow(throughput) / (${PER_UNIT})` },
  // cost = units the load needs × the BASE rate per unit — the same uniform `costPer` shape every fleet uses.
  costPer(k.requiredUnits),
];

/** The BASE cost-rate knob, as DATA: every priced component declares its base as a visible, editable config
 *  (read by the component's cost relation via `self(unitCost)`), so the price is never a magic literal buried
 *  in a relation string. The cost MODEL — what the base multiplies (units / replicas / throughput /
 *  concurrency) — differs per component; the base does not. `unit` documents the rate (e.g. USD/task·month). */
export const unitCostConfig = (value: number, unit: string): ManifestConfig => ({ key: k.unitCost, value, unit });

/** The CALLER-SIDE RETRY POLICY knobs, as editable config DATA. A retry policy is a
 *  fact of the CALLER's code, so it rides on a node that ORIGINATES requests (a client or a calling service) —
 *  never on a database/queue, which does not retry its own callers. All default 0, which is the pre-retry world
 *  bit-for-bit (no deadline ⇒ no reneging, no retries); an architect turns it on per node in the Inspector. The
 *  three knobs shape ONLY the simulation (the scalar pass never reads them — a retry loop is a question about
 * time). Applied explicitly to the caller manifests rather than every node, so the vocabulary stays
 *  honest (a store shows no retry knobs it would never use). */
export const RETRY_POLICY_CONFIG: readonly ManifestConfig[] = [
  { key: k.timeoutMs, value: 0, unit: 'ms' }, // per-attempt deadline; 0 = none (today's behaviour)
  { key: k.retryCount, value: 0, unit: '1' }, // extra attempts after the first; 0 = no retries
  { key: k.retryBackoffMs, value: 0, unit: 'ms' }, // fixed delay before re-injecting a timed-out attempt
];

// THE COST MODEL — ONE mechanism: a visible base × the driver that GROWS the capacity. The cardinal rule
// (the tool must not lie): whatever knob a node scales its capacity by — provisioned `throughput`, M/M/c
// `concurrency`, a `replicas`/unit COUNT, or actual usage — its `cost` MUST read that same knob, so adding
// capacity always costs money. A free capacity dial would let the backward-solver "meet the SLO" for $0 and
// make every cost figure a fiction. Every priced component carries a `unitCost` config (the base) PLUS exactly
// one `cost` relation below; the shape reflects how the real service bills; never a literal buried in a string.

/** TRULY FIXED: a flat monthly price for a component with NO sizable capacity knob (you scale it by SWAPPING
 *  to a bigger type, not by turning a dial). Do NOT use this on a node whose `throughput`/`concurrency` is a
 *  tunable — that makes capacity free; use `provisionedCost` or `costPer` instead. */
export const flatCost: ManifestRelation = { key: k.cost, reads: [k.unitCost], expr: 'self(unitCost)' };

/** PROVISIONED CAPACITY: cost = the node's OWN throughput CEILING (`self(throughput)`, the capacity you reserve
 *  — NOT the incoming load) × base. The honest model for a sized box/cluster (proxy, gateway, self-managed
 *  store/stream): upsizing the ceiling to meet an SLO costs money. `unit` is then USD per provisioned req·s
 *  (or msg·s) per month. */
export const provisionedCost: ManifestRelation = { key: k.cost, reads: [k.throughput, k.unitCost], expr: 'self(throughput) * self(unitCost)' };

/** SCALES WITH A LOCAL KNOB: cost = (this node's own `driver` — replicas / required units / concurrency) ×
 *  base. For demand-sized fleets `driver` is `requiredUnits`; for replicated apps `replicas`; for connection-
 *  bound M/M/c stores `concurrency` (more connections = a bigger instance). */
export const costPer = (driver: Key): ManifestRelation => ({ key: k.cost, reads: [driver, k.unitCost], expr: `${String(driver)} * self(unitCost)` });

/** PAY-PER-USE: cost = OFFERED load (inflow throughput) × base — so it is ~0 at rest and rises with traffic
 *  (Lambda, the AI services, DynamoDB on-demand, S3, CloudFront, SQS). `unit` is then USD per sustained
 *  req·s (or msg·s) per month. */
export const payPerUseCost: ManifestRelation = { key: k.cost, reads: [k.throughput, k.unitCost], expr: 'inflow(throughput) * self(unitCost)' };
