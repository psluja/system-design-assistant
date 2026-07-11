---
id: decision-3
title: Solver stack DataScript + clingo + MiniZinc (replaces Z3)
date: '2026-06-28 17:37'
status: accepted
---
## Context

The engine needs relational checks (compatibility/permissions), enumeration (what fits), and numeric whole-chain computation/optimization — all client-side.

## Decision

DataScript (hot relational path), clingo/ASP (enumeration), MiniZinc (numeric whole-chain solve/optimize). MiniZinc replaced Z3 for readability and native multi-criteria optimization; Z3 is retained only as a possible MiniZinc backend.

## Consequences

The `smt-z3` skill is to be renamed `minizinc-modeling` (pending). See Backlog doc-2 (01 — Property System) and the `solver-composition` skill.
