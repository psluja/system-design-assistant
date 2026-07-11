---
id: decision-5
title: 'Property system: registry, assumptions vs computations, percentile bands, fixpoint'
date: '2026-06-28 17:37'
status: accepted
---
## Context

Component properties must be comparable, propagatable across chains, and optimizable.

## Decision

A governed registry of typed keys (type/unit/band-shape/aggregation). Inputs (assumptions, SLO bands) vs derived (computations authored as MiniZinc relations). Latency-type keys use percentiles. The whole chain is solved as one interdependent system iterated to a fixpoint.

## Consequences

Two careful-design items remain: end-to-end percentile/tail-latency aggregation (percentiles don't sum) and the least/steady-state fixpoint for backpressure. See Backlog doc-2 (01 — Property System).
