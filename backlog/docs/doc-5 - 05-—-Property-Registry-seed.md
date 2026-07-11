---
id: doc-5
title: 05 — Property Registry (seed)
type: specification
created_date: '2026-06-28 19:40'
tags:
  - research
  - content
---
# 05 — Property Registry (seed content)

> Status: draft, grounded in deep research (cited). This is the seed **content** (the keys) for the
> registry whose **shape** lives in `engine/core` (doc-2 §2, doc-4 §2). Keys are governed, versioned,
> and **date-stamped** (provider numbers drift). Feeds TASK-10.

Three classes. **Never present an SLO band (a target) as a derived metric (a fact)** — doc-4 §6.

## Input / config knobs (user-set, per component)

| key | unit | notes |
|---|---|---|
| `concurrency_limit` | count | e.g. Lambda default 1000/region |
| `max_connections` | count | e.g. Postgres default 100 |
| `partition_count` / `shard_count` | count | |
| `replication_factor` | count | |
| `timeout_ms` | ms | per remote call; choose from downstream p99.9 |
| `batch_size` | count | |
| `capacity_mode` | enum | provisioned \| on-demand |
| `consistency_mode` | enum | strong \| eventual \| causal \| read-your-writes |
| `eviction_policy` | enum | |
| `instance_size` | enum | |
| `retry_policy` | struct | exponential backoff + jitter + token-bucket cap |

## SLO bands (targets, not facts)

| key | unit |
|---|---|
| `availability_slo` | request-success % (NOT time-based uptime) |
| `latency_slo` | percentiles (p50/p99/p999), ms |
| `durability` | nines |
| `error_budget` | derived = 1 − SLO |

## Derived / computed metrics (simulator output) — with path-aggregation rule

| key | unit | aggregation along a request path |
|---|---|---|
| `latency` (p50/p99/p999) | ms | sync serial: means **SUM**; ⚠ **tails are super-additive across fan-out — use max/convolution, NEVER naive percentile-sum** |
| `throughput` | req/s | **MIN** (bottleneck stage) |
| `availability` | % | **PRODUCT** across series deps; **1 − ∏(1−aᵢ)** across redundant/parallel |
| `concurrency` | count | per node = rps × duration_s (Little's law) |
| `cost` | $/month | **SUM** across components |
| `utilization` | % | rps / capacity per node |

## Per-edge semantic properties

| key | enum |
|---|---|
| `delivery_semantics` | at-most-once \| at-least-once \| exactly-once |
| `ordering` | none \| per-partition \| total |

## Hard rules from the research

- **Availability is request-based** (Google SRE), not the "nines → annual-downtime" table — that
  claim was **refuted 0-3** in verification. Any downtime-minutes view is a derived, labelled approx.
- **Latency is a distribution**, never a single "avg" — p50/p99/p999 fields only.
- **Reliability is an error budget** (1 − SLO): a spendable input, not 100% uptime (cost ~100× per nine).

Sources: Google SRE Book (availability / SLO / error-budget / percentiles); AWS Builders' Library
(timeouts, retries, jitter, idempotency); AWS Lambda Developer Guide (concurrency = rps × duration);
Dean & Barroso, *The Tail at Scale* (tail super-additivity).
