---
id: doc-15
title: Latency composition & response-time model (m-4 design)
type: specification
created_date: '2026-07-01 17:37'
updated_date: '2026-07-01 21:42'
tags:
  - m-4
  - engine
  - latency
  - meta-model
---
# Latency composition & response-time model

**Milestone:** m-4 · **Status:** SHIPPED (core; TASK-60 cache-aside parked) · **Owner of the computation: CONTENT** (see §4 decision).

## 1. Goal

Throughout design, every component shows the **request→response latency** a caller can expect from it — live, so adding a component immediately shows its effect on the response time of every synchronous ancestor. Before m-4 the node showed only its own service/queue time; the accumulation across a component's downstream calls was not modelled, and where SDA did accumulate latency it did so in the WRONG direction (source→node) with a FIXED operator.

## 2. The core idea

How a component's latency combines across the things it calls is **a design decision, not derivable from topology** — the same class of insight as sync/async, one level deeper. A node's response time is its own queued sojourn plus the responses of its **synchronous** downstream dependencies, combined by an operator the architect chooses per node:

- **sequential** (auth → cache → DB → respond) → **sum**
- **parallel / scatter-gather / fork-join** (fan out, await all) → **max** (the critical path)
- **cache-aside / look-aside** → **hit-ratio weighted** (NOT min): `E[R] = R_cache + (1 − h)·R_backend` (TASK-60, parked)
- **hedged / race / tied requests** → **min** (first responder wins)

Async downstream is **excluded** (a fire-and-forget / queue hop decouples the caller's wait). A **saturated** synchronous dependency makes the response **∞** (you wait forever) — this propagates up every sync ancestor.

## 3. Industry grounding (naming + calculation)

- **Response time / sojourn** `R = W + S` (queue wait + service) — queueing theory; SDA computes the M/M/c sojourn (`nodeQueues.sojournMs`). That sojourn is the node's OWN term.
- **Sequential composition → sum**; **critical-path method (CPM) / fork-join → max**. Waiting for the slowest of N parallel branches: **"The Tail at Scale"** (Dean & Barroso, CACM 2013) — fan-out amplifies the tail.
- **Cache-aside** (a.k.a. look-aside) with a **hit ratio** `h`: you always pay the cache probe, and pay the backend on a miss ⇒ `E[R] = R_cache + (1 − h)·R_backend`. At `h=1` ≈ min; at `h=0` ≈ sum. Modelling `h` is what makes it insightful.
- **Hedged / speculative / tied requests → min** (Dean & Barroso).
- **Honesty caveat:** for the analytic MEAN under parallel fan-out, `max(means)` UNDER-estimates the true `E[max]` (Jensen's inequality). The scalar pass reports the critical-path approximation; the true fork-join **tail** is the DES's job — consistent with SDA's "scalar approximation + DES truth" split.

### Formal model
```
resp(N) = sojourn(N)  ⊕_N  { resp(c) : c ∈ syncDownstream(N) }
  ⊕_N = sum | max | min | weighted(h)   (a per-node choice; weighted = TASK-60)
  leaf (no sync downstream): resp = sojourn(N)
  any sync c with resp = ∞  ⇒  resp(N) = ∞
  async edges excluded from syncDownstream
```

## 4. AS BUILT — the computation lives in CONTENT (decision record)

**Shipped shape:** `responseLatency(graph, value, queues?)` + `latencyBreakdown(...)` (base/queue/downstream/response) in `content/sda/src/queueing.ts`, with the per-node knob `latencyComposition` (0 sequential=sum · 1 parallel=max · 2 fastest=min; default sequential — the conservative must-not-lie bound) declared in `content/sda/src/registry.ts`. It is a leaves-up fold over SYNC successors, cycle-guarded, ∞-propagating; the node's own-term is the M/M/c sojourn from `nodeQueues`.

**Why content, not the engine (ADR):** the own-term is the **queueing sojourn** — non-linear (Erlang-C) and domain-specific. The engine's linear, domain-agnostic cell-network cannot and must not compute it. Response time is therefore a content projector OVER the solved values, exactly like `realCumulativeLatency`/`realAwareVerdicts` (the established "engine ideal + content real overlay" pattern). This is still fully BACKEND: the front end renders only; MCP has first-class access.

**Engine backward-flow mechanism — built, then removed.** TASK-58 first added a generic backward-flow aggregation (`Aggregation.flow:'backward'` + per-node `composeBy`) to the engine. A post-ship audit (two independent reviewers) found it was **speculative generality**: no content consumed it, and it could never power response-time (the own-term is content's sojourn). Kept, it would have left two parallel encodings of the composition convention with no differential test binding them. It was **removed** (engine reverted byte-identical to pre-TASK-58); the composition convention has ONE encoding, in content. If a future metric genuinely needs a backward ENGINE key (a linear own-term the cells can compute), rebuild it from the TASK-58 commit (`cf32abe`) — the design is proven and tested there.

**One truth (all surfaces read the same function):**
- canvas: the per-node latency bar (base·queue·downstream proportions) from `latencyBreakdown`;
- MCP `evaluate`: `responseLatencyMs` per node (∞ serialised as the string "∞");
- design-doc (web + MCP `generate_doc`): the "Response latency per tier" table.

## 5. Invariants (held)

- **Engine domain-agnostic:** unchanged by m-4 (the temporary backward mechanism was removed).
- **Components are pure DATA:** the composition is the `latencyComposition` config knob; components never reference each other.
- **The tool must not lie:** default composition = sequential (sum), the conservative bound; ∞ is honest; the true parallel/cache TAIL is the DES's answer.
- **Web is a dumb renderer / one truth:** computed once in content; canvas, MCP `evaluate` and `generate_doc` all render it.
- **Additive:** the existing forward `latency` key is untouched. Reconciling the two ("does response time supersede the source-sum latency for the caller-facing SLO?") remains a recorded follow-up decision.

## 6. Status

1. ~~Engine mechanism~~ — built (TASK-58), then removed by the §4 decision; design preserved at commit `cf32abe`.
2. **Content** — `responseLatency` + `latencyComposition` + `latencyBreakdown` — SHIPPED (TASK-59), fully tested (incl. base+queue+downstream=response and both ∞ cases).
3. **Cache-aside (hit-ratio) + per-edge role** — PARKED as TASK-60 (full self-contained work-order in the task).
4. **Web** — per-node proportional composition bar + "Downstream calls" control — SHIPPED (TASK-61).
5. **MCP + design-doc** — `responseLatencyMs` + per-tier table — SHIPPED (TASK-62). A response-time SLO verdict remains deferred with the §5 reconciliation.
