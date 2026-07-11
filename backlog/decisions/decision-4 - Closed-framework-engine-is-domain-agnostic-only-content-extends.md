---
id: decision-4
title: 'Closed framework: engine is domain-agnostic, only content extends'
date: '2026-06-28 17:37'
status: accepted
---
## Context

Open-source project where only components should be extended, never the engine core.

## Decision

The engine is domain-agnostic — it computes, simulates, iterates, solves, and optimizes over a typed-property graph and knows nothing about "system design." All domain knowledge (components, registry keys, algebras, protocols) is content/data.

## Consequences

`grep` of the engine for `lambda`/`aws`/`iam`/`latency` must return zero; the meta-model must be complete so new needs are content, not core changes. See Backlog doc-1 (00 — Architecture).
