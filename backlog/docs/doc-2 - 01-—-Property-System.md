---
id: doc-2
title: 01 — Property System
type: specification
created_date: '2026-06-28 17:50'
updated_date: '2026-07-02 19:07'
tags:
  - design
---
# 01 — Property System (the substrate)

> Status: **draft, layer-1 decisions locked** (see §12). This is layer (1) of the design stack:
> **(1) property system → (2) manifest contract → (3) engine/calculus → (4) MVP slice.**
> Everything — comparison, propagation, simulation, synthesis, optimization — stands on this.

## 1. Purpose

A component may declare **any number** of properties; the framework governs **what each property
means**. *Open in extent, closed in meaning.* Without a governed vocabulary, `price` / `cost` /
`$$` become three things and nothing is comparable, propagatable, or optimizable.

## 2. Property registry (controlled vocabulary)

The framework owns a **closed, versioned registry** of canonical property keys. A component author
picks keys from it; a linter rejects unknown/synonym keys at publish time.

Each registry entry:

| Field | Meaning |
|---|---|
| `id` | canonical key, e.g. `throughput`, `latency`, `cost`, `availability` |
| `type` / `unit` | dimensional type, e.g. `Rate "req/s"`, `Duration "ms"`, `Money "USD/month"` |
| `kind` | `input` (assumption) or `derived` (computed) — see §3 |
| `bandShape` | `point` \| `min/target/max` \| `percentiles(p50,p99,…)` — see §4 |
| `aggregation` | how this property composes over the topology — see §5 |
| `semantics` | short normative definition |

Units use an existing dimensional-units library (**default `js-quantities`**, swappable — an
implementation detail). Dimensional typing means `ms` can never be compared to `USD`; conversions
exist only within a dimension.

## 3. Two kinds of property: assumptions vs computations

This duality is the heart of the engine.

- **Inputs / assumptions** — declared, not derived: component config (`memory`, `concurrency`),
  **SLO bands** (§4), and **sourced** limits/prices. The designer's intent and reality's ceilings.
- **Derived / computations** — a property is defined by a **relation authored by the component
  author** over other properties (own config + values propagated from upstream/downstream tokens).

> A static value is just a constant relation. One mechanism for everything.

**Relations form a system, not a one-way pipeline.** The author defines the relationships
explicitly (`latency` and `cost` may both reference `memory`; `effective_rate` references both
producer and consumer). The framework does **not** infer dependencies behind the author's back —
the authored relations *are* the dependency graph, and the engine solves that system (§6, §8).

## 4. Bands & verdicts

An assumption is a **band**, not a point, and the band shape is part of the key (§2):

- Rate/capacity-type keys → `min` (hard floor) / `target` (desired) / `max` (ceiling).
- Latency-type / distributional keys → **percentiles** (`p50`/`p99`/`p999`) — industry standard.

The verdict = **computed value checked against the band**. This kills false alarms: a Lambda
computing `100 req/s` against a `target` of `400` would alarm on a naive threshold, but if the
`min` floor is `50`, then `100 ≥ 50` ⇒ the hard requirement is satisfied (info: below target).

A verdict is an explanatory object: `{ property, computed, band, severity, cause-chain, remediations }`.

## 5. Aggregation algebras (topology-aware)

For the engine to compute **whole chains**, each key declares **how it composes** — and that
composition depends on edge semantics (sync vs async, from doc 02/03):

| Property | Series (sync path) | Parallel | Async edge |
|---|---|---|---|
| `latency` | sum (means) ⚠ | max | **cut** (path segments; no carry) |
| `throughput` | min (bottleneck) | sum | decouple → backpressure check |
| `cost` | sum | sum | sum |
| `availability` | product | (1−∏(1−aᵢ)) | sum |

A new key + its declared algebra "just works" in propagation — **the engine never hardcodes
latency/cost**; it is generic over the registry. This is what makes the framework extensible
rather than brittle.

> ⚠ **Careful-design item — percentiles don't sum.** `p99` of a path ≠ sum of node `p99`s (worst
> cases rarely coincide). So the analytical **hot path sums means as a labelled approximation**,
> while the **cold path (DES) derives true percentiles** by simulating distributions. Getting
> end-to-end tail latency right is a known-hard part; treat it as such, do not hand-wave.

## 6. Expression language: MiniZinc — and it IS the dependency engine

**Decision:** relations are authored in **MiniZinc** — an existing, readable, declarative
constraint+optimization language with a WASM build (`minizinc-js`), no backend. (Supersedes Z3 as
the numeric engine; Z3 kept only as a possible MiniZinc backend if ever needed.)

Why MiniZinc is the right answer to "how do property dependencies work": a constraint solver's
whole job is **solving a system of mutually-dependent relations**. The author writes per-component
relations; the framework assembles them + aggregation algebras + topology into **one whole-chain
MiniZinc model**; MiniZinc finds the consistent assignment for the entire chain **including
feedback loops** (the "iterate until stable" happens inside the solve).

- **Authors** write small, readable relations, e.g. `throughput = concurrency / perRequestDuration`,
  kept to a readable arithmetic/constraint subset (UX goal).
- **Bidirectional**: the same model **evaluates** (fix inputs → compute) and
  **optimizes/synthesizes** (`solve minimize totalLatency` / `cost` / lexicographic / Pareto).
  *Computing whole chains under various criteria is the center of the mechanism.*

### Two execution engines, one source ("describe once")

| Path | Engine | Use |
|---|---|---|
| **HOT** | lightweight JS iterator over the same relations | live, steppable, approximate whole-chain compute at 60 fps |
| **COLD** | MiniZinc (WASM, in a Worker) | exact whole-chain solve, multi-criteria optimization, synthesis, ranking (top-K / Pareto) |

Both compute the **whole chain** (the hot path loops visibly; MiniZinc solves) and **must agree**
on forward evaluation — a differential test guards this, exactly like the solver-consistency rule.
Two encodings that drift = the tool lies.

## 7. Cost normalization (the hard case)

Cost is **derived + billing-model-specific + load-dependent**, so it is a **relation, not a
number**:

- Lambda: `cost = f(requests, duration, memory, price)`; EC2: `cost = f(instanceType, hours, price)`.
- The component supplies a **pure, deterministic** cost relation; the framework solves it with the
  **propagated load** and reduces to the **canonical unit** (`USD/month at the given load`).
- Comparison is meaningful **only at equal workload** → cost is load-parameterized, never a sticker
  price.
- Price inputs are **sourced** data, **bundled in the component for now**; later a separate,
  updatable price-data file shipped alongside the WASM (region/version-tagged). Pricing pipeline is
  **out of layer-1 scope** (§12).

## 8. The core: iterative whole-chain solving + determinism

**This is the heart of the simulator**, not a tuning detail: the engine computes the *entire chain*
as one interdependent system, iterating until it settles.

- **Cold path:** MiniZinc solves the constraint system in one go (feedback handled internally).
- **Hot path:** an explicit JS iterator evaluates the relations, feeds outputs back, repeats to a
  fixpoint — fast and steppable for the live view.
- **Careful-design item — the right fixpoint.** Async + backpressure create cycles (a consumer's
  rate limits the producer's effective rate). We want the *natural steady state* (least fixpoint);
  a raw solve may admit other solutions, so the model must be well-posed (monotonicity / minimize
  flow / explicit equilibrium condition). Design this deliberately.
- **Determinism contract:** pure relations; fixed MiniZinc solver + config; no wall clock / no
  unseeded RNG; total order on results with a canonical tie-break (so "sorted from best" is
  reproducible). The hot-path iterator has a max-iteration cap + convergence epsilon; on
  non-convergence it returns a labelled `did-not-converge` verdict — **never a silently wrong
  number** (honesty rule). Exact cap/epsilon are tuned in implementation.

## 9. The dataflow model

- **Token** (e.g. a `request`) carries a property bundle (throughput bands, payload size, …).
- **Component = transfer function** over token properties, parameterized by its config:
  `in-properties + config → out-properties + resource usage (cost, concurrency)`.
- **Edges** wire `out → in` per each property's aggregation algebra and the edge's sync/async
  semantics.

## 10. Worked example: `request → Lambda`

```
request (token):   throughput.min = 50/s,  throughput.target = 400/s,  payload = 8 KB
lambda  (config):  concurrency = 20,  perRequestDuration = 200 ms,  memory = 512 MB
```

MiniZinc relation (illustrative):

```minizinc
throughput_out = concurrency / (perRequestDuration / 1000.0);   % 20 / 0.2 = 100 /s
```

Verdict: `computed = 100/s`; band `[min 50, target 400]`. `100 ≥ 50` ⇒ **OK**, severity = info
("below target 400; no headroom"). Remediations (derived from tunables): raise `concurrency`,
lower `perRequestDuration`, add a queue to decouple. Cost: `f(load = 100/s, memory = 512, price)`
→ `USD/month`.

## 11. Slots & follow-ups

- Extends `plugin-contract-design` (manifest references registry keys, not free-form fields) and
  `domain-modeling-infra` (modeling a block = mapping real properties → keys + cost relation).
- **Pending (after layer 1 freeze):** rename/replace the `smt-z3` skill with `minizinc-modeling`;
  refresh `CLAUDE.md` stack/architecture and cross-links to reflect MiniZinc-over-Z3.

## 12. Resolved decisions (layer 1)

1. **Band shape** — distributional keys (latency) use **percentiles** (p50/p99); rate/capacity keys
   use min/target/max. Declared per key.
2. **Units** — existing lib, default **`js-quantities`**, swappable.
3. **Dependencies** — **authored explicitly** by the component author as relations (not inferred);
   the authored relations *are* the dependency system, solved by MiniZinc.
4. **Iterative whole-chain solving** — the **core engine**: MiniZinc solves the system (cold), a JS
   iterator approximates it (hot); commit to the fixpoint contract, tune cap/epsilon later.
5. **Pricing** — out of layer-1 scope; in-component now, updatable bundled data file later.

### Remaining careful-design items (not blocking the freeze, but flagged hard)
- End-to-end **percentile/tail latency** aggregation (percentiles don't sum).
- The **least/steady-state fixpoint** for backpressure feedback (well-posed model).

## 13. Design correction — universal traffic origins

**Problem (product-owner call-out).** The seed model assumed every architecture has a *client*: the
scalar flow was seeded only from a `client.*` node's `throughput` config, the DES emitted arrivals
only from topological sources whose `throughput` config was read as offered load, and search froze
"the workload" only on client nodes. But **not every architecture has a client** — a DB-to-DB
migration, a cron/batch worker, two connected services that emit events. *Every* node must be able to
play the traffic-origin role, and requirements must hold at every node. Treating the client as the
only source was a design bug.

**Decision.** Add ONE new registry key **`assumedRps`** (unit `req/s`, `kind: input`, node-**local**,
`point` band, default **0**): the workload a node **ORIGINATES** itself, as distinct from the load it
**relays** from upstream. `arrivalRate` was NOT reused — it means "rate arriving AT a queue FROM
producers" (queue-mode ingress, `msg/s`), a genuinely different quantity from "rate this node
originates"; conflating them would overload the queue algebra.

**Mechanism (content + app only; the engine stays domain-agnostic).**

- A node's `throughput` still carries the offered/served load down the graph; the engine's algebra is
  unchanged (`out = min(self(throughput), inflow)`; a source emits `out = local`). Crucially the
  engine keeps a node's OWN value (`self(throughput)` — read by cost / the queue ingest ceiling / the
  search's ρ-headroom as **capacity**) separate from what it EMITS.
- Whether a node ORIGINATES vs RELAYS is a **topology** fact (a source has no inbound wire), so the
  origin is folded in **per-instance at `instantiate`** (which knows the wiring), NOT in the manifest:
  a source with `assumedRps > 0` gets its throughput rewritten to `min(capacity, self(assumedRps))`, so
  it emits its own workload capped by its own capacity; a **relay keeps `throughput = capacity`
  untouched**, so cost / queue / ρ-headroom keep reading a true ceiling and the MiniZinc search stays
  linear and feasible.
- `withOrigin` (behaviors.ts) makes every node *capable* of originating by adding the default
  `assumedRps = 0` knob. The universal overflow relation now reads the offered load as
  `inflow(throughput) + self(assumedRps)`, so overflow = `max(0, offered − capacity)` is correct
  whether load arrives from upstream or is originated locally. Default 0 ⇒ **every existing design is
  byte-for-byte identical** (a client is simply a preset: a node whose whole job is to originate).
- **DES** emits arrivals for any node with `assumedRps > 0` (in addition to the legacy client path); a
  node that both originates and serves stays a station.
- **Search honesty** (memory `search-tunables-no-cheating`): `assumedRps` is FROZEN — never a tunable —
  so the optimizer can never lower declared origin traffic to fake a cheaper design (exactly as a
  client's workload is frozen).
- **Honest empty state:** with no origin anywhere (no client and no `assumedRps > 0`), the status line
  and the tail section say WHY ("No traffic origin — set assumedRps on a node (or add a client) …")
  rather than a silent blank.

This makes the traffic origin a first-class, universal concept; the client becomes one convenience
preset over it.
