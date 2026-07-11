---
id: doc-3
title: 02 — Manifest Contract
type: specification
created_date: '2026-06-28 17:50'
updated_date: '2026-06-28 19:25'
tags:
  - design
---
# 02 — Manifest Contract (the single extension point)

> Status: **draft, rev.2**. Layer (2) of: (1) property system → **(2) manifest** → (3) engine →
> (4) MVP. Builds on doc-2 (property system).
>
> rev.2 (from review): a component is **pure data**; the core is just `config / bands / relations /
> ports`; permissions/IAM are deferred (§8) as a domain of their own. The earlier IAM-laden example
> was wrong — cut.

## 0. Governing invariant — the closed framework

**The framework (engine + meta-model) is closed for modification; only content is open.** Content =
components (data) + the registry keys they contribute. Adding any component — even an exotic future
one — must never require touching engine code. If something is not expressible, the **meta-model**
evolves (a versioned act), never a per-component special case in the engine.

## 1. A component is pure data

A component is a **JSON manifest** — knobs, SLOs, a few arithmetic relations, and ports. **No code,
ever.** Its "behaviour" is its `relations` (expressions the engine evaluates), which are data too.
Pure data cannot import anything → **no dependency hell**. (Authoring in TS is optional sugar for
autocomplete; the artifact is data.)

**Anti-dependency-hell invariant:** components reference a shared, flat, governed **vocabulary by id**
(registry keys, protocol ids, capability tags) and **never each other**. Lambda does not import or
name SQS — it declares a port speaking `aws.sqs.send`; the engine matches whoever else speaks it.
Adding the 200th component touches none of the other 199. The only dependency is the vocabulary +
manifest `schemaVersion` — one, stable.

**A component affects the world in exactly two ways:** its **relations** (its arithmetic — what it
"does") and its **ports** (what it connects to). The engine never "understands" a component; it
evaluates the relations and matches the ports. `throughput = concurrency / duration` *is* what Lambda
does — there is no hidden semantics.

**The relation expression language is fully specified in
`docs/design/expression-reference.html`** — the user-facing reference for anyone authoring a
custom component in the ✎ editor: the exact grammar the parser accepts (and rejects, with real
error messages), the `inflow`/`self`/`outflow` semantics and fixpoint evaluation, the
three-compiler guarantee (JS / MiniZinc / WGSL, differential-tested), a twelve-recipe cookbook
lifted from the shipped catalogs, and the honest boundary of what relations must not model
(time → DES, categorical → guarantees, cross-node references → wires).

## 2. Anatomy — four core parts

```jsonc
{
  "id": "aws.lambda", "version": "1.0.0", "title": "AWS Lambda",
  "kind": "primitive",                         // or "composite" (§3)
  "hierarchy": ["compute", "serverless", "function"], "tags": ["aws", "compute"],

  "config":    [ /* knobs the user sets; each references a registry key by id */ ],
  "bands":     [ /* SLOs to check, per key */ ],
  "relations": [ /* derived properties = the ONLY behaviour; arithmetic over keys, as strings */ ],
  "ports":     [ /* typed connectors: protocols[] + capabilityTags[] + dir + arity */ ],

  "failureModes": [ /* optional: named conditions (boolean relations) the simulator surfaces */ ]
}
```

Every referenced key is a registry id (doc-2 §2). `cost` is just a relation producing the `cost` key.
That is the whole component.

## 3. Primitive vs composite — recursion = scale

- **Primitive** — declares its own `relations` (its transfer function).
- **Composite** — `kind: "composite"` + an internal `graph` of other components that exposes ports
  like any block; its properties are derived by running the same engine on its internal graph.

Composites keep very complex architectures manageable and cost the framework nothing — a composite is
*just a graph*, which the engine already evaluates. A meta-model feature, not a special case.

## 4. Variants & conditional declarations

- **Variants = distinct manifests** in a shared `family` (e.g. `aws.sqs.standard` vs `aws.sqs.fifo`).
  Pure content; the suggester groups by `family`. Zero framework features.
- **Conditional declarations (included up-front):** a port/relation may be gated by a config
  predicate — a general mechanism (never product-specific) so one component can carry internal modes
  (e.g. single-node vs replicated) without swapping the block. Built into the meta-model now because
  the framework is closed (§0); a later need would force a forbidden core change.

## 5. Generality validation (does the meta-model hold?)

| Case | Expressed via | Core change? |
|---|---|---|
| SQS standard vs FIFO | separate manifests, shared `family` | none |
| Encapsulated sub-system | `composite` + internal graph | none |
| Multi-region | `region` as a generic config key; cross-region edge carries latency | none |
| Tiers / instance sizes | `config` params + `relations` that read them | none |
| A property nobody anticipated | new registry key (governed data) + a relation | none |

## 6. Governance & linting

- Manifest validates against the current `schemaVersion`; **every key is a registry id** (no
  free-form fields); `relations` are lint-checked against the registry at load (unknown key in an
  `expr` → publish error).
- Adding a registry key is a versioned, typed act (id, unit, band shape, aggregation) — reviewed like
  a dictionary entry.
- Plugin `version` is semver; breaking a port/protocol/relation = MAJOR. Exports record `{id,
  version}`; import warns on missing/incompatible (doc-2 / client-persistence skill).

## 7. Worked example — same skeleton, different values

```jsonc
// aws.lambda (compute)
{
  "id": "aws.lambda", "title": "AWS Lambda", "kind": "primitive",
  "config": [
    { "key": "concurrency", "default": 1000 },
    { "key": "perRequestDuration", "default": 200, "unit": "ms" }
  ],
  "bands": [ { "key": "throughput", "shape": "minTargetMax", "min": 50, "target": 400, "unit": "req/s" } ],
  "relations": [ { "produces": "throughput", "expr": "concurrency / (perRequestDuration / 1000)" } ],
  "ports": [ { "name": "trigger", "dir": "in", "protocols": ["http.req-resp"], "arity": "one" } ]
}

// apache.kafka (broker) — identical shape, different knobs/relations/ports
{
  "id": "apache.kafka", "title": "Apache Kafka", "kind": "primitive",
  "config": [
    { "key": "partitions", "default": 12 },
    { "key": "perPartitionThroughput", "default": 10000, "unit": "msg/s" }
  ],
  "bands": [ { "key": "throughput", "shape": "minTargetMax", "min": 50000, "unit": "msg/s" } ],
  "relations": [ { "produces": "throughput", "expr": "partitions * perPartitionThroughput" } ],
  "ports": [ { "name": "consume", "dir": "out", "protocols": ["kafka.consume"], "arity": "many" } ]
}
```

The engine treats both identically — solve relations, check bands, match ports. It knows neither
"Lambda" nor "Kafka".

## 8. Deferred (not in v1): permissions / IAM — a domain of its own

IAM is a *framework within a framework* (principals, roles, policies, actions, conditions). It does
not reduce to a knob or a relation, so we **do not model it now** — we don't model everything. When we
do, it is a **separate capability layer**, not core behaviour: components declare required/provided
capability tokens **by id**; the framework only **matches tokens** ("required token present in
context? no → warn, with the author's note") and **never understands IAM**. IAM entities (roles,
policies) most likely become their own **components/nodes** in the graph — consistent with §0. Out of
scope for v1.

## 9. Slots & follow-ups

- Supersedes the data-shape parts of the `plugin-contract-design` skill; reconcile after the engine.
- Pending: `smt-z3` → `minizinc-modeling` skill rename; `CLAUDE.md` refresh (MiniZinc-over-Z3,
  English-only, closed-framework invariant).
