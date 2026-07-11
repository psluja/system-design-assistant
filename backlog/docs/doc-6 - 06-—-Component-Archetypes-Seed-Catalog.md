---
id: doc-6
title: 06 — Component Archetypes & Seed Catalog
type: specification
created_date: '2026-06-28 19:40'
updated_date: '2026-06-28 19:54'
tags:
  - research
  - content
---
# 06 — Component Archetypes & Seed Catalog

> Status: **rev.2 — archetype-first (provider-neutral).** The unit is the **archetype** (a
> system-design primitive); specific provider services (AWS / GCP / Azure / on-prem / custom — open,
> infinite) are **instances** that share the archetype's property schema and only fill in
> values/quotas/cost. AWS was an illustration, never a boundary. Feeds TASK-10/11.

## The model: archetype → instances

- An **archetype** defines the property **shape**: which registry keys (doc-5) and which
  ports/protocols. Fully provider-neutral.
- A **provider instance** fills the **values** (sourced numbers, quotas, cost model). Same archetype
  ⇒ instances are comparable **by construction** — this answers the research's open question on
  representing the same logical service across providers.
- Provider/feature **variants** (queue standard vs FIFO; DB single vs replicated; provider A vs B) use
  the family/variant + conditional-declaration mechanism (doc-3 §3–4) + hierarchy/tags (TASK-17).
- Cloud-agnostic blocks (Redis, Postgres, Kafka, NATS) are just instances with no managed-provider
  wrapper — same schema, no special case.

## Archetype taxonomy (the universal units)

| Category | Archetypes | Example instances (provider-spanning) | Distinguishing keys |
|---|---|---|---|
| **Compute** | VM, Container/orchestration, **FaaS** | EC2 / GCE / Azure VM · ECS-Fargate / GKE / Cloud Run / Knative · Lambda / Cloud Functions / Azure Functions / Cloudflare Workers | vCPU, memory, concurrency, cold-start, duration |
| **Storage** | Object, Block, File | S3 / GCS / Azure Blob / MinIO · EBS · EFS | durability, consistency, throughput, cost/GB |
| **Database** | Relational, KV, Document, Wide-column, Graph, Time-series, Search | RDS-Postgres / Cloud SQL / self-hosted PG · DynamoDB / Bigtable / Cosmos · Mongo / Firestore · Cassandra / Scylla · Neptune / Neo4j · Timestream / Influx · OpenSearch / Elastic | consistency model, query model, partitioning, max_connections |
| **Cache** | In-memory, CDN | Redis / Memcached / ElastiCache / Memorystore · CloudFront / Cloud CDN / Fastly / Cloudflare | throughput, eviction, hit-ratio, TTL |
| **Messaging** | Work queue, Pub/sub, Distributed log/stream | SQS / Cloud Tasks / RabbitMQ · SNS / Pub-Sub / Service Bus / NATS · Kafka / Kinesis / Pulsar | delivery_semantics, ordering, per-partition throughput, max-msg-size |
| **Networking & edge** | L4 LB, L7 LB, API gateway, DNS, CDN, reverse proxy, service mesh | NLB/ALB / Cloud LB / Azure LB · API Gateway / Apigee / APIM / Kong · Route 53 / Cloud DNS · Envoy / Istio / Linkerd | throughput, latency add, routing model |
| **Coordination** | Config/discovery, locks, leader election | ZooKeeper / etcd / Consul | consistency, quorum |
| **Observability** | Metrics, traces, logs | CloudWatch / Cloud Monitoring / Prometheus-Grafana / OpenTelemetry / Datadog | ingestion rate, retention, cost |

## First-release seed (instances to ship first)

A few per archetype to prove breadth + the managed/agnostic mix: FaaS (Lambda), VM (EC2), container
(Fargate), object store (S3), relational (Postgres — RDS **and** self-hosted), KV (DynamoDB), cache
(Redis), queue (SQS), pub/sub (SNS, NATS), log (Kafka), L7 LB (ALB), API gateway, CDN (CloudFront),
DNS (Route 53). Cloud-agnostic proofs: **Redis, Postgres, Kafka, NATS**.

## Sourced numbers (instance values; the archetype owns the keys)

- **FaaS / Lambda instance:** 1000 concurrency/region; `concurrency = rps × duration`; rps ceiling =
  10× concurrency (10,000); scale 1000 envs / 10 s per function. *[AWS Lambda dg]*
- **Queue / SQS instance:** Standard at-least-once + best-effort order; FIFO exactly-once + ordered
  (per group, 5-min dedup); FIFO 300 / 3,000 (batch) / 70,000 (high-throughput) msg/s; max 1 MiB
  (raised from 256 KiB, Aug 2025). *[AWS SQS FAQ]*

## ⚠ Still need primary sourcing (per instance, date-stamped)

Postgres `max_connections` + pool exhaustion · DynamoDB partition limits + on-demand/provisioned ·
Redis throughput + eviction · S3 11-nines durability + strong read-after-write · API Gateway throttling ·
Kafka per-partition throughput + replication · CDN cache semantics. Source each before shipping its instance.
