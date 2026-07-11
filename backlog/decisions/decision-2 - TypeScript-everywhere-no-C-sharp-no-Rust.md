---
id: decision-2
title: 'TypeScript everywhere; no C-sharp, no Rust'
date: '2026-06-28 17:37'
status: accepted
---
## Context

A stack choice was needed. With no backend, C#/.NET has no natural home; Rust is outside the skill set and unnecessary because the heavy solvers come prebuilt as WASM.

## Decision

Use TypeScript across the whole stack, including the simulator (TS in a Web Worker).

## Consequences

One language end to end; strict TS with type-level domain modeling. See `CLAUDE.md` and the `typescript-quality` skill.
