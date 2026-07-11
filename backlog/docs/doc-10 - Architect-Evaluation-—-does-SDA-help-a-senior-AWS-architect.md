---
id: doc-10
title: Architect Evaluation — does SDA help a senior AWS architect?
type: specification
created_date: '2026-06-30 12:48'
tags:
  - evaluation
  - product
  - gaps
---
# Architect Evaluation — does SDA help a senior AWS architect?

> A deliberately critical, evidence-based evaluation. I role-played a senior/staff AWS solutions architect,
> grounded the bar in a researched rubric of what such an architect actually delivers (Well-Architected 6
> pillars, design-doc/RFC, ADR, C4, STRIDE, capacity & cost models, DR/RTO-RPO — sources in the research
> note), and drove the REAL tools (the same MCP surface an AI architect uses over the bridge: apply_design /
> evaluate / set_slo / optimize / compare_options) across three demanding scenarios. Findings are cited with
> the numbers the tool produced. This document is the basis for the next backlog tasks.

## Method

Three scenarios, each built and exercised through the tool:
1. **Event-driven e-commerce checkout** — Black Friday peak 2,000 orders/s; 13-node async topology (API GW →
   command → Postgres; SNS fan-out → 3× SQS → Lambda/Fargate workers → read model / S3).
2. **Real-time ingestion / streaming** — 50,000 events/s; gateway → ingest → Kafka → stream processor →
   DynamoDB + S3.
3. **Multi-tenant SaaS API** — 8,000 req/s; API GW → service → Redis + Aurora.

## Verdict (up front, honest)

SDA is a **strong, fast, honest CAPACITY & FLOW verifier** — and genuinely useful for one slice of the job:
sizing a *known topology* under load and finding where it overflows. But measured against what a senior AWS
architect must actually **deliver and review**, it today covers roughly **1.5 of the 6 Well-Architected
pillars** (Performance Efficiency partially; Cost partially) and **produces none of the narrative
deliverables**. It is a verified-calculator for throughput/availability/cost-per-node, not yet an architect's
design tool. For the two domain scenarios it was weakest exactly where each domain is hardest (streaming
semantics; multi-tenancy). **It helps a capacity-focused engineer; it does not yet serve a staff architect
writing a Well-Architected design doc.**

## What it does WELL (with evidence)

- **Flow / overflow / backlog across complex async topologies, instant and correct.** The 13-node e-commerce
  design built in ONE `apply_design` call (default-port wiring) and evaluated in ms; the 50k/s stream
  correctly flagged `gw.overflow = 40,000 req/s · violation` and named it "the dominant maximum". This is the
  real, differentiated value: a *verified* "does it carry the load, and where does it break".
- **End-to-end availability as a series product, with a cause.** Setting an availability SLO produced
  `orders.availability = 0.998 · violation` with the remediation "Increase availability at orders (0.999) —
  the weakest factor". That is exactly the series-multiplication math the rubric demands, with the weakest
  link identified.
- **Backward sizing that is honest.** `optimize` sized the e-commerce design to meet SLOs; when a target was
  unreachable by the knobs it returned **"proven infeasible — use explainInfeasible"** rather than a wrong
  green. Honesty-as-a-value is real here.
- **Protocol-correct, role-aware suggester** and fast coarse build (default ports) — low friction to lay out
  a design.

## Where it FAILS — gaps mapped to the rubric (with evidence)

**Performance Efficiency (partial)**
- **No tail latency on the architect's path.** The DES (p50/p95/p99) is web-only — `@sda/engine-sim` is not
  even a dependency of the MCP toolset. Worse, a `latency` SLO is silently checked against the **scalar mean**
  (`checkout.latency = 50 ms · ok`), so a "p99 ≤ 300 ms" requirement gets a green that does **not** verify the
  tail. A percentile SLO that can't see percentiles is a correctness trap.
- **No capacity-estimation layer.** No peak factor, **no headroom/utilization** (a node at 100% utilization
  shows `overflow 0 · ok` — green with zero headroom), no bandwidth (QPS×payload), no storage-over-retention,
  no derived node count. The architect's back-of-the-envelope table (the rubric's §2.3) is unsupported.

**Cost Optimization (partial)**
- **No end-to-end cost total** on the AI path (per-node only: `checkout.cost = 430`), **no data-transfer /
  egress model** (the rubric flags egress as 20–40% of real spend — the most-missed line), no on-demand vs
  Savings-Plan/RI comparison. The dominant real cost drivers are unmodelled.

**Reliability (essentially absent)**
- No multi-AZ / multi-region, no **redundancy / parallel-availability** math, no RTO/RPO, no DR tiers, no
  blast-radius. On the SaaS design `optimize` returned **"infeasible"** for an availability SLO with **no
  actionable path** — the real fix (multi-AZ Aurora) is outside the model, so the tool can prove you fail but
  not how to pass.

**Security (absent)** — no IAM/least-privilege, encryption, WAF, trust boundaries, or STRIDE threat model.
**Operational Excellence (absent)** — no runbooks, observability, deploy/rollback, or ORR.
**Sustainability (absent).**

**Domain-specific failures**
- **Streaming has no semantics.** Kafka exposes **no ordering / partitioning / delivery-semantics** config and
  there is **no ordering / exactly-once / consumer-lag SLO** anywhere (42 component types, none expose it). The
  things that *define* a streaming design are invisible to the tool.
- **SaaS has no multi-tenancy.** No tenant multiplier, no per-tenant cost, no isolation/blast-radius. Throughput
  is a single offered load; cost is per-component, never per-tenant.

**Tool defects found while driving it**
- **`compare_options` is effectively non-functional for the core question.** In 3/3 attempts it returned "no
  alternative component type fits" — even for a plain worker where Fargate vs Lambda vs ECS/ASG obviously
  compete. The "is X cheaper than Y here?" question — a staple of the Cost & Performance pillars — fails.
- **`apply_design` swallows build errors.** A wire to a non-existent port (`proc.db` on a function that has no
  `db` port) was accepted without validation and `apply_design` returned `ok:true` with an **empty** verdict
  list instead of surfacing the structural error. Silent failure, false green.
- **NFR metrics are hidden by default.** `evaluate` returns only overflow/backlog/throughput; latency,
  availability and cost appear **only after** you `set_slo` on each. The architect doesn't see the NFR picture
  unless they already know to ask for it.

**No deliverables at all**
- The tool produces **no** design doc, ADR, C4 diagram, STRIDE table, Well-Architected (HRI) output, capacity
  table, cost table, or rollout/runbook. The architect's actual *output* — the reviewed document — is 100%
  manual. The web "DESIGN SPECIFICATION (LIVE)" (C4-container count, NFR list, risk count) is a seed of this,
  not a deliverable.

## Honest read per persona

- **Capacity / performance engineer, known topology:** genuinely helpful today — fast, verified load/overflow
  and least-cost sizing with honest infeasibility.
- **Staff architect producing a Well-Architected design:** not yet. The tool verifies a narrow quantitative
  slice and authors none of the required artifacts; reliability, security, operability, cost-depth, and the
  document itself are missing.

## Proposed next tasks (prioritized — to turn into backlog items)

**P0 — make the verified slice trustworthy and complete**
1. Expose tail latency (DES p50/p95/p99) on the engine/MCP path, and make a `latency`/percentile SLO use the
   tail — never silently fall back to the scalar mean.
2. Surface latency/availability/cost (and an end-to-end **system roll-up**: total cost, path latency, path
   availability) in `evaluate` by default — not only after an SLO is set.
3. Fix `apply_design` to validate ports and surface build errors instead of returning ok + empty.
4. Fix `compare_options` so it actually offers same-family alternatives (Fargate/Lambda/ECS/ASG) for a node.

**P1 — close the missing pillars (the meta-model evolves, per the charter)**
5. Reliability: redundancy / parallel-availability math, multi-AZ/region, RTO/RPO, DR tiers, blast-radius;
   and let `optimize`/`repair` propose the reliability fix (add a replica/AZ), not just report infeasible.
6. Cost depth: end-to-end total, data-transfer/egress model, on-demand vs committed pricing.
7. Capacity estimation layer: peak factor, headroom/utilization warnings, bandwidth, storage-over-retention,
   derived node count.

**P2 — domains & deliverables**
8. Streaming semantics: ordering / partitioning / delivery-semantics / consumer-lag as first-class
   keys+SLOs (content already claims delivery semantics in doc-8 — make them verifiable).
9. Multi-tenancy: a tenant multiplier + per-tenant cost + isolation/blast-radius.
10. Security: a STRIDE/trust-boundary overlay and a Well-Architected (HRI) checklist pass.
11. Document generation: produce the design-doc sections (doc-7), a C4 view, ADRs, a capacity table and a
    cost table FROM the verified model — turn the computed truth into the architect's actual deliverable.

> The single highest-leverage theme: today SDA *verifies* a slice and *authors nothing*. The biggest unlock is
> (a) widen the verified slice to the whole NFR set with honest tails/rollups, and (b) emit the verified truth
> as the architect's documents. That is what turns "a fast calculator" into "the architect's tool".
