---
id: doc-12
title: 'Smoke Test Plan — web UI end-to-end (personas, coverage, rubric)'
type: specification
created_date: '2026-06-30 18:32'
tags:
  - qa
  - ux
  - app
---
# 12 — Smoke Test Plan: web UI end-to-end

> Goal: prove the frontend WORKS, every feature is INTUITIVE / self-explanatory, and above all DELIVERS VALUE
> to a senior architect. Method: persona-driven, fresh-eyes (a tester who knows nothing of the build, sees only
> the UI), every feature covered. First this plan; then execute (results → doc-13).

## Environment
- App: http://localhost:5175/ (vite dev). Reset between personas: clear IndexedDB (`indexedDB.deleteDatabase('sda')`) + reload → blank canvas, OR start from the persisted design where the task says so.
- Driver: the browser only (playwright-edge MCP). Testers must NOT read source — judge purely from the UI.
- The AI bridge (Link AI) needs the bridge process; out of scope unless running.

## Rubric (score each touched feature)
- **Works** — does the action succeed and produce a correct result?
- **Intuitive** — could a first-time architect do it WITHOUT guessing? (record every guess.)
- **Self-explanatory** — are labels / tooltips / states clear without external help?
- **Valuable** — does it answer a real architect question / produce something they'd use?
- For each: note what BROKE, what was CONFUSING (had to guess), what would be BETTER.

## Feature inventory (coverage — every item must be exercised)
1. **Palette**: search; facets (aws/oss, kind, protocol); 42-component list; `+ New` (define custom component).
2. **Canvas**: drag-add a component; connect ports (drag); the click-"+" / suggester; select node; the animated edge (colour = health, dash = throughput, dot speed = real latency, crawl on saturation); groups/boundaries; minimap; zoom; `Tidy` (auto-layout); `Group`; context menus (node / edge / group / pane).
3. **Inspector (right)**: config inputs; live recompute; Cost (unitCost breakdown); `Compare component options`; Verdict; Suggested-next (engine); `Edit type`; label / description; Delete.
4. **System panel — System tab**: design specification; per-flow throughput / **real latency (+ ideal)** / availability / cost; **Load per tier · ρ** (+ saturation); **Requirements (end-to-end) SLO** inputs; **Tail latency** (auto, background); **Cost · breakdown** (compute / egress / total / committed 1-yr / 3-yr).
5. **System panel — Improve tab**: Goal (feasible / cheapest / fastest); Changing (knobs); Subject to (SLOs); Result verdict; Sizing before→after; Apply.
6. **Top bar**: project name edit; undo / redo; MCP tools dropdown; Link AI; Import; Export (.sda.json); **Design doc** (.md); theme toggle; `Verified · N issues`.
7. **Footer**: throughput / latency / availability / cost + saturation flag + `Fix issues` / `Improve` CTA.
8. **Persistence**: autosave (reload keeps the design); Import/Export round-trip; Design-doc content quality.

## Personas & tasks (each = a fresh tester, one task)
- **P1 — First build (blank canvas).** "Design a web API that serves 5,000 req/s backed by a database, and make it actually meet that load." → add components, connect, set the throughput SLO, evaluate, Improve→Apply, confirm it passes. Covers: palette, canvas add/connect, SLO input, System read, Improve.
- **P2 — Health check (existing design).** Start from the persisted design. "Is this healthy? Where are the risks, and fix them." → read Verified count, ρ / saturation, the Fix CTA, Improve→feasible. Covers: System read, footer, Improve, canvas signals.
- **P3 — Cost.** "What does this cost? Make it cheaper. What about data-transfer and a 1/3-yr commitment?" → Cost · breakdown, Improve→cheapest, egress (add an internet gateway + payload). Covers: cost depth.
- **P4 — Latency/tail.** "What latency do users feel? Is the p99 acceptable? Why is a tier red?" → real latency vs ideal, Load per tier ρ, Tail latency, the animated edge. Covers: queueing latency, tail, animation legibility.
- **P5 — Reliability.** "What's the availability? How do I get more nines?" → availability read; can the UI raise it? (deploymentMode? reliability advice?). Covers: reliability surfacing gaps.
- **P6 — Component work.** "Find a message queue; swap the compute for a cheaper option; define a custom component." → palette search/facets, Compare options, set_type/apply, `+ New`. Covers: catalog + alternatives + custom.
- **P7 — Deliverable.** "Produce a design document I can hand to my team. Is it usable?" → Design doc export, read the .md, judge completeness/accuracy. Covers: the deliverable.

## Output (→ doc-13)
A findings table: `Feature | Persona | Works | Intuitive | Value | Severity | Note`, the top friction points, and a prioritised improvement backlog (→ TASK-*). Severity: blocker / major / minor / polish.
