---
id: m-4
title: "Latency composition & response-time model"
---

## Description

Model per-node REQUEST→RESPONSE latency (response time), grounded in the engine. A node's response latency = its own queueing sojourn (M/M/c) combined with the response of the SYNCHRONOUS downstream it calls, where the combination operator is a DESIGN CHOICE per node: sequential (sum), parallel/scatter-gather (max), cache-aside (hit-ratio weighted), hedged/race (min). Async hops decouple the wait and are excluded; ∞ propagates from a saturated sync dependency. The engine owns the mechanism (backward-flow aggregation + per-node-selectable operator, a meta-model evolution of the existing per-key monoid); content declares the key + the per-node knob; every surface (canvas, MCP, design-doc) only displays it. Industry: queueing theory (sojourn), critical-path/fork-join, "The Tail at Scale" (Dean & Barroso) for parallel fan-out, cache-aside hit-ratio, hedged requests.
