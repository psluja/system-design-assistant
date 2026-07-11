---
id: doc-1
title: '00 — Architecture: domain-agnostic engine + content'
type: specification
created_date: '2026-06-28 17:49'
tags:
  - design
---
# 00 — Architecture: a domain-agnostic engine + content

> Status: **draft, foundational**. This is the spine; the layer docs (1) property system,
> (2) manifest, (3) engine, (4) MVP sit *inside* the split established here.

## 0. Thesis — the engine knows nothing about system design

The engine only **computes, simulates, iterates, solves, optimizes** over a generic structure: a
graph of nodes / ports / edges carrying **typed properties** related by **authored relations**. It
has **no concept** of AWS, Lambda, SQS, IAM, latency, or "system design." All of that lives in
**content**.

> **Product = engine (generic) + a "system-design" content pack** (cloud components, the seed
> property keys, the UI framing). The same engine could drive a different domain — supply chains,
> manufacturing pipelines, circuits — by swapping the content pack. The engine is powerful, but
> only **within its own domain**: typed-property graph computation.

This is the sharpest form of the closed-framework invariant: the framework is not merely closed to
component-specific code — it is **ignorant of the entire problem domain**.

## 1. Three layers, one direction of dependency

```
┌─────────────────────────────────────────────┐
│ App / UI shell (SDA)                         │  wires engine + content; canvas; overlays
├─────────────────────────────────────────────┤
│ Domain content pack (SDA)                    │  cloud components, seed registry keys & algebras,
│                                              │  protocols, the "system design" interpretation
├─────────────────────────────────────────────┤
│ ENGINE (domain-agnostic)                     │  meta-model + compute/simulate/iterate/solve/optimize
└─────────────────────────────────────────────┘
        dependencies point DOWN only — the engine imports nothing above it.
```

The engine never imports content; content is data + relations the engine consumes.

## 2. The precise line: engine (meta-model) vs content (SDA pack)

| Concern | Engine — generic mechanism | Content — SDA pack, as data |
|---|---|---|
| Property | what a *key* IS: `{type, unit, band-shape, aggregation}` | the keys: `latency`, `cost`, `throughput`, … |
| Aggregation | that a key *has* an algebra, applied over topology | the algebra: "latency sums on sync, cuts on async" |
| Edge | an edge carries attributes the algebras read | `sync`/`async`, which protocols are which |
| Relations | solving a system of authored relations (MiniZinc) | the actual per-component relations |
| Node | ports + properties + relations | Lambda, SQS, Postgres, … |
| Verdict | computed-vs-band + severity + cause-chain | what bands/keys mean in cloud terms |
| Permissions | generic requirement/provide satisfiability | IAM, accounts, VPC |

**Litmus test:** `grep` the engine packages for `lambda`, `iam`, `aws`, `latency` → **zero hits.**
Even `latency` is seed content, not an engine symbol.

## 3. Monorepo layout (dependency-respecting)

Engine side — **zero domain imports**:
- `engine/core` — graph / port / edge / token model, registry **meta-model**, verdict model.
- `engine/solve` — router, projectors (strategy), hot-path iterator, merger, fixpoint loop.
- `engine/solvers` — datascript / clingo / minizinc adapters behind interfaces.
- `engine/sim` — analytical + discrete-event simulation.

Content side — depends on engine, never the reverse:
- `content/registry` — seed property keys + algebras + protocols (the SDA vocabulary, **as data**).
- `content/components` — component manifests (Lambda, SQS, …) = the plugin catalog.

App side:
- `app/persistence` — IndexedDB + export/import + migrations.
- `app/ui` — canvas (React/Svelte Flow), overlays.
- `app/web` — shell wiring engine + content + ui.
- `testing` — property / differential / golden harness + arbitraries.

## 4. Patterns (provisioned for known growth — see `design-for-growth` memory)

- Hexagonal core + adapters; DI via interfaces (swap MiniZinc backend, units lib, UI lib).
- **Registry** (governed vocabulary grows as data).
- **Projector = Strategy** (per solver, pluggable).
- **Plugin** (components discovered via manifest).
- **Command + immutable store** (undo/redo, replay, collaboration-ready).
- **Worker-RPC / actor** (isolated solver workers).
- **Versioned contracts + migrations** (manifest, export, registry).

These target *known* growth axes (more components, solvers, keys, contributors) — structure, not
speculation.

## 5. Extension seams (the closed engine)

A new component / key / protocol / **entire domain pack** is added as **content**: a manifest, a
typed registry entry (with its algebra), or a relation — never engine code. If something is not
expressible, the **meta-model** evolves (a versioned act), never a per-case branch in the engine.

## 6. Consequences

- The engine is **independently testable and reusable** — exercise it on toy domains with no cloud
  at all (this is also the cleanest way to prove it's truly domain-agnostic).
- The product ships as **engine + SDA content pack**; a second content pack = a second product.
- *(Optional, later)* the engine likely warrants its own identity/name, distinct from
  "System Design Assistant," which is one application of it.

## 7. Reframing note for docs 01 & 02

Docs 01 (property system) and 02 (manifest) currently **mix** engine meta-model with SDA seed
content — they name `latency` / `cost` / `sync-async` as if built in. Re-read them through this
split: those are **seed content** illustrating the meta-model, not engine concepts. A light editing
pass will tag each item as *meta-model* vs *content*. Queued with the freeze-time follow-ups
(`smt-z3`→`minizinc-modeling` rename, `CLAUDE.md` refresh).
