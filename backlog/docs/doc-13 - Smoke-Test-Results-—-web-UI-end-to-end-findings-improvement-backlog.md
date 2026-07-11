---
id: doc-13
title: Smoke Test Results — web UI end-to-end (findings + improvement backlog)
type: specification
created_date: '2026-06-30 19:12'
tags:
  - qa
  - ux
  - app
  - findings
---
# 13 — Smoke Test Results: web UI end-to-end

> Execution of doc-12. Method: a fleet of fresh-eyes agents (no build knowledge, UI-only) on separate browsers
> + orchestrator verification. Findings are from genuine first-time use.

## Method & what actually ran
- **Agent 1** (browser A) — interpret + fix an existing design (latency / health / cost / fix). Full report.
- **Agent 3** (browser B, parallel) — build + canvas + persistence (add / connect / Tidy / Group / context menus / Export-Import / undo / theme). Full report.
- **Agent 2** (2nd MCP browser) — components/palette — **failed**: the 2nd Playwright MCP had to download its own browser (~180 MB) and stalled on a **full disk**; P6 was re-covered by the orchestrator.
- **Orchestrator verification** — suggester, solver convergence (feasible vs infeasible), reliability/deploymentMode, default-seed, palette search, `+ New` custom component, multi-flow display.
- **Constraints learned:** one Playwright MCP = one browser → parallel agents need either the 2nd MCP (its browser must be pre-installed) or their own Playwright node browser. Native drag-drop gestures are **automation-hard, not UI-bad** (agents verified add/connect via pointer-event sequences). Env: **C: was ~100% full** (not the app) — flagged to the user.

## Verdict
**The tool WORKS and is genuinely VALUABLE to a senior architect — ~4/5 intuitiveness across personas.** Both agents independently said the core loop — *read the live verdict → spot the bottleneck (ρ) → Compare/apply a fix → see it Verified* — is fast and obvious, and were "never lost." Points lost are about **trust** (a solver that times out on impossible targets, a "0% load" reading that under-reports, unexplained knobs) and two **footguns** (import wipes undo; illegal connections fail silently) — not navigation.

## What delivers real value (keep / protect)
- **Live verdicts on every edit** — throughput · queueing-aware latency · availability · cost, instantly, footer + System.
- **Real-vs-ideal latency + DES p50/p95/p99 tail** — senior-grade; most diagramming tools cannot produce a p99.
- **Load per tier · ρ** — immediately fingers the bottleneck (Postgres 80%).
- **Cost breakdown** — per-component shares + 1-yr/3-yr committed pricing.
- **Compare component options → one-click apply** with before→after; the whole fix was one click.
- **"Suggested next" engine chips that add AND auto-wire a legal neighbor** — both agents' single favourite discovery.
- **Named, typed ports with live legal/illegal validation** during connect.
- **Clean, diffable Export** (schema:1, sync/async semantics, band overrides) — a real backup artifact; **Import round-trips**.
- **The generated Design doc** — C4 Mermaid, computed SLO/capacity/cost tables, reliability mapped to a tier with a sourced AWS link, and HONEST "author required" markers (no faking).
- **Honest by default** — ships a *failing* sample (saturation, ∞ latency, drops) instead of a flattering one; the "must not lie" ethos is visible. Cohesive dark mode, Tidy, context menus.

## Findings by severity → improvement backlog
**MAJOR**
- **M1 Solver infeasibility UX.** Feasible Improve goals converge (verified: feasible→Postgres 100→313, cheapest, fastest all OK). But an INFEASIBLE SLO (e.g. Cost ≤ 250 the design can't reach by sizing) makes the time-bounded solver **time out → "did not converge — simplify, fewer knobs"** instead of detecting infeasibility and naming the true cause + the real lever ("target unreachable by sizing — swap a component"). The flagship feature looks broken on hard targets. → **TASK-38**
- **M2 Utilization ρ under-reports.** A throughput-capacity component (db.cheap, cache) at its rated ceiling shows **"0% load"** (ρ only computed for concurrency/M-M-c tiers). For a "must not lie" tool this can mislead a real decision. Make ρ = offered/capacity for every tier; never "0%" at the ceiling. → **TASK-39**
- **M3 Latency SLO is mean-only.** The UI latency SLO checks the 71 ms mean; the tool simulates a 255 ms+ p99 tail that **no requirement can guard**. Add a `p99 ≤` (percentile) SLO in the UI. → **TASK-40**
- **M4 Import is a data-loss footgun.** Import **wipes Undo/Redo history** — you cannot undo an import over unsaved work. Snapshot/undoable import. → **TASK-41**
- **M5 Illegal connection rejected silently.** No reason shown though the engine knows (protocol mismatch). Surface "postgres `in` accepts sql/pg, not redis". → **TASK-41** (UX-clarity batch)

**MINOR**
- Stale Inspector after "apply" (old values until re-select). · Footer reddens **Throughput** on a *latency* violation (wrong metric). · "Verified · N issues" badge not clickable (no drill-down). · Pluralisation "1 issues"/"1 violations". · Duplicate identical wires allowed. · Export filename stays "Untitled" (not the project name). · **No "New/Clear project"** (clearing storage reloads the default seed). · Unexplained knobs: **ρ** (no tooltip), **deploymentMode** (bare 0/1/2, no Single-AZ/Multi-AZ/Region labels), **queue knobs** (Act-as-queue/Drain/Retention/Max-backlog) render on EVERY component (confusing on a DB/cache), **Per-request-time vs Latency** (two similar fields). · `+ New` custom component is **raw JSON** — powerful but the schema (keys/protocols/relations) is opaque (no guided form). · **No in-UI reliability guidance** (how to get more nines / what deploymentMode means) — advice lives only in MCP/design-doc, not on the canvas. → **TASK-41** (batch)

**POLISH**
- Design doc downloads silently (no in-app preview). · Tidy leaves crossing edges / doesn't group a node into its tier. · Port accepted-protocols not shown on hover. → **TASK-41**

**CONTENT FIDELITY**
- **db.cheap strictly dominates db.postgres** — cheaper ($90 vs $140) AND 4× faster (12 vs 50 ms) AND same 0.999 availability → makes Postgres pointless; a senior distrusts the catalog. Re-balance. → **TASK-42**

## Coverage
Palette (search ✓, facets present, 42 list ✓, `+ New` ✓) · Canvas (add ✓ click+suggester, connect ✓ + validation, Tidy ✓, Group ✓, context menus ✓, animated edge ✓) · Inspector (config ✓, cost ✓, Compare ✓, Verdict ✓, Suggested-next ✓, Edit type/label/desc/Delete ✓) · System tab (spec ✓, per-flow real latency/ρ/cost ✓, SLO inputs ✓, tail auto ✓, cost breakdown ✓, multi-flow ✓) · Improve tab (goals ✓, changing/subject-to ✓, verdict ✓, before→after ✓, apply ✓) · Top bar (Export ✓, Import ✓, Design doc ✓, undo/redo ✓, theme ✓) · Footer (✓ + Fix CTA). Not exercised: Link AI bridge (needs the bridge process), MCP-tools dropdown contents, exhaustive native drag-drop.
