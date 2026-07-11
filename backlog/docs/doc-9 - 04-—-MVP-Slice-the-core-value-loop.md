---
id: doc-9
title: '04 — MVP Slice: the core value loop'
type: specification
created_date: '2026-06-30 10:59'
tags:
  - design
  - mvp
---
# 04 — MVP Slice: the core value loop

> Status: **draft**. The smallest end-to-end slice that proves SDA's thesis — *a verified design, not a
> dumb diagram*. Everything here is assembled from pieces that already exist (engine evaluate/sim, the
> content catalogue, the canvas + relational suggester); this doc fixes the **scope** so the MVP is one
> coherent loop, not a pile of features. Sits at slot 04, inside the split from doc-1 (00 Architecture).

## 0. The thesis the MVP must prove

A senior architect drops two real components, connects them, and **immediately sees the tool think**: it
proposes only what *legally fits* next, and it warns — with a **number** — where the design will break. No
diagram tool does this. The MVP must earn the engine's place on the very first interaction.

## 1. The core value loop (one turn)

1. **Place** — drag an API Gateway and a function (Lambda) from the palette onto the canvas.
2. **Connect** — wire gateway → function. The wire is **protocol-validated**: an illegal drop is refused
   (verify, don't guess) — over the port accept-/speak-sets (doc-3).
3. **See what fits** — for each OPEN port the relational suggester (`whatFits`) proposes only
   protocol-compatible catalogue components (from the function: a database, a cache, a queue) — **filtered**,
   not a flat list.
4. **See the warning** — the engine evaluates live and surfaces a **quantified** verdict: at the stated
   request rate the function overflows by N rps (or its p99 tail exceeds the SLO). The number, its cause,
   and the ranked fix.
5. **Act** — accept a suggestion, or raise a knob; the loop re-runs on the <16 ms hot path. Optimize/repair
   run the same evaluation *backwards*.

The loop **is** the product: *describe coarsely → the engine fills in the verified specifics.*

## 2. In scope (the MVP does all of this)

- Palette → canvas placement (drag/drop) of the seed catalogue.
- Per-port wiring with **protocol legality at connect time** (accept-/speak-sets).
- The **engine-backed suggester** (filtered "what fits") on open ports.
- **Live verdicts** per node + end-to-end: throughput / overflow / latency / availability / cost, computed
  vs the SLO band, with status (ok / warning / violation), the cause, and a ranked fix.
- One **end-to-end requirement** (e.g. target rps) applied to the terminal node.
- The **simulate lens**: DES over the design for the true tail (p50/p95/p99) + per-tier saturation — the
  thing the average-case algebra cannot show.
- Browser-only persistence (autosave) so the loop survives a refresh.

## 3. Non-goals (deliberately OUT of this slice)

- **No red-flagging of pre-existing illegal edges** — drag-time validation already prevents creating new
  ones, so painting old ones red is deferred (decision: not needed for the MVP).
- **No multi-flow / multi-entrypoint designs** — one request flow, one terminal SLO.
- **No threat/security overlays, no consistency/ordering modelling** — later milestones.
- **No collaboration, accounts, or backend** — fully client-side (a hard invariant).
- **No exhaustive catalogue** — the seed set is enough to prove the loop; breadth is content work.
- **No design-doc / PRFAQ export** — doc-7 is the eventual target, not the MVP.

## 4. How the existing pieces realise it

| Loop step | Where it lives |
|---|---|
| place / palette / drop | `app/web/app.tsx` — palette, `onDrop`, `addComponent` |
| protocol-validated connect | `isValidConnection` (app.tsx) over `Port.accepts` / `Port.speaks` |
| filtered suggestion | `suggestFor` / `buildCandidates` (app/web/suggest.ts) → engine `whatFits` |
| quantified live warning | `createEngine().evaluate` → verdicts (computed vs band + cause + fix) |
| true tail | `simulate` (engine/sim, DES) — the simulate lens |
| persistence | `idb.ts` autosave |

## 5. Acceptance

> A user places an API Gateway and a function, connects them, sees a **filtered suggestion** for the next
> component, and a **quantified live warning** where the design breaks.

Proven at the logic level by `app/web/src/value-loop.e2e.test.ts` — the same `Studio` + suggester + engine
calls the UI makes — so the loop is guarded in CI; the UI renders that result.
