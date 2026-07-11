---
id: decision-1
title: 'Fully client-side, no backend (all WASM/JS)'
date: '2026-06-28 17:37'
status: accepted
---
## Context

Originally planned as a Python backend on AWS Lambda. Every solver we need (DataScript, clingo, MiniZinc) ships as prebuilt WASM/JS, so no server-side compute is required.

## Decision

Run entirely in the browser. No backend. All state lives client-side.

## Consequences

Open-source and static-hostable; sharing is via export files; persistence is browser-only (decision-6). See Backlog doc-1 (00 — Architecture).
