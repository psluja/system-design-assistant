---
id: doc-14
title: >-
  UX/Intuitiveness Polish Loop — plan (alignment, consistency, predictable
  layout)
type: specification
created_date: '2026-06-30 19:54'
tags:
  - ux
  - design
  - app
  - polish
---
# 14 — UX / Intuitiveness Polish Loop (plan)

> Queued after the functional smoke-test loop (doc-12/13) reaches "no big objections". A SEPARATE autonomous
> loop focused ONLY on visual & interaction quality — NOT functional correctness. Goal: every control aligned,
> precise, in a predictable place; consistent spacing/typography/patterns; no chaos; nothing cramped, overlapping
> or truncated. The UI must feel deliberately designed, pixel-precise, and self-evident.

## Scope (this loop changes presentation only)
- CSS / layout / spacing / alignment / typography / colour-hierarchy / responsive fit. The app styles by
  className (`.modepanel`, `.sec`, `.vr`, `.field`, `.slo-row`, `.syshdr`, `.node`, `.rail`, `.bottom`, …) →
  edits land in the web CSS + small JSX structure tweaks. NO engine/content changes; no new features.

## Visual & interaction rubric (score each screen/state)
- **Alignment** — controls align to a consistent grid; labels/values/inputs line up; no ragged edges; numbers right-aligned where compared.
- **Spacing** — one consistent spacing scale (4/8px rhythm); equal padding in like containers; no cramped or floating elements.
- **Predictable placement** — the same kind of control sits in the same place across panels; primary action bottom-right; related things grouped.
- **Consistency** — buttons, inputs, chips, section headers, toggles share one visual language; tone/weights/radii consistent; icon usage consistent.
- **Hierarchy & clarity** — clear primary/secondary; a glance tells you what matters; no wall of equal-weight text.
- **No chaos** — nothing overlaps, truncates, wraps awkwardly, or jumps on hover/state change; tooltips/toasts positioned sanely.
- **Flow legibility** — a first-timer reads each panel top-to-bottom and understands the next step without guessing.
- **Theme parity** — light AND dark are equally polished; contrast adequate; no theme-specific breakage.
- **Empty/edge states** — blank canvas, no-SLO, long labels, many nodes, multi-flow, narrow viewport all look intentional.

## Method (the loop)
1. **Review** — fresh-eyes review agents SCREENSHOT every state (canvas + selection, palette + filtered, Inspector for several component kinds, System tab, Improve tab + each Goal, New-component dialog, Link-AI popover, context menus, footer, toasts, both themes, multi-flow, blank canvas) and score against the rubric → a prioritised visual-defect list (with the exact element + what's wrong + the fix).
2. **Triage** (orchestrator) — keep real defects, drop noise; group by area (Inspector, System panel, palette, canvas, top bar/footer, dialogs).
3. **Fix** — fix agents apply CSS/layout fixes per area (sequential where they touch the same stylesheet); typecheck + build stay green.
4. **Verify** — before/after screenshots; the orchestrator confirms the fix and no regression.
5. Repeat until a full review pass finds no alignment/consistency/chaos issues worth fixing.

## Coverage checklist
Top bar · palette (search/facets/list/+New) · canvas (nodes, ports, edges, groups, minimap, zoom, Tidy/Group) · Inspector (config, cost, alternatives, verdict, suggested-next, group panel) · System tab (spec, per-flow metrics, load-per-tier, requirements incl. the new p99 row, tail, cost breakdown, multi-flow) · Improve tab (goal/changing/subject-to/result/sizing/apply, infeasible state) · footer · dialogs (New component, Link AI) · context menus · toasts · light + dark.

## Disk note
Visual review NEEDS screenshots (~1-2 MB each) — keep the disk clean (delete artifacts promptly); the machine is tight (~3 GB free). Use one or both browsers; clean `.playwright-mcp` between batches.
