---
id: decision-6
title: Browser-only persistence with versioned diffable export-import
date: '2026-06-28 17:37'
status: accepted
---
## Context

No backend, so state lives in the browser, which is not durable (it can be evicted).

## Decision

IndexedDB autosave plus a versioned, deterministic/diffable export/import that records plugin versions. The export file is the real backup.

## Consequences

Designs are git-diffable; imports warn on missing/incompatible plugins. See the `client-persistence` skill.
