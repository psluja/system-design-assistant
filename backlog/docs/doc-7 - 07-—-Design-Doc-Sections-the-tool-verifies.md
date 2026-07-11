---
id: doc-7
title: 07 — Design-Doc Sections the tool verifies
type: specification
created_date: '2026-06-28 19:40'
tags:
  - research
---
# 07 — Design-Doc Sections the tool produces / verifies

> Status: draft, from research (Software Engineering at Google ch.10; "Design Docs at Google";
> C4 model; AWS Well-Architected). This is the long-term output the tool helps produce and check.

Ordered sections the tool should help produce — and actively **verify the presence of** the hallmark ones:

1. Context / background
2. Goals & non-goals
3. Requirements (functional + non-functional / SLOs)
4. Capacity & back-of-the-envelope estimation
5. High-level architecture (C4 system-context + container diagram)
6. Data model & schema
7. API / interface design
8. Detailed design
9. Scalability & bottleneck analysis
10. **Failure modes & resilience** (timeouts, retries + jitter, idempotency, circuit breakers, backpressure)
11. **Security & privacy** (+ i18n, storage — Google's mandated template fields)
12. **Cost analysis**
13. **Alternatives considered + explicit trade-offs**
14. Rollout / migration plan
15. Open questions

**Sections 10–13 are the staff-vs-junior hallmarks.** A design doc is a *gating artifact* at Google,
and the best docs enumerate alternatives with their strong/weak points — so the tool actively flags
the absence of resilience, security, cost, and alternatives-with-tradeoffs. The **C4** abstraction
levels (system → container → component → code) define the diagram hierarchy; the SDA canvas maps onto
the container/component levels.

Sources: Software Engineering at Google ch.10; industrialempathy.com "Design Docs at Google";
c4model.com; AWS Well-Architected Framework.
