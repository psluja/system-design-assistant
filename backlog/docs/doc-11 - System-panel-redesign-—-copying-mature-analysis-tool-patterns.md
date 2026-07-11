---
id: doc-11
title: System panel redesign — copying mature analysis-tool patterns
type: specification
created_date: '2026-06-30 16:08'
updated_date: '2026-06-30 16:36'
tags:
  - design
  - ux
  - app
---
# 11 — System panel redesign (real-by-default; copying mature analysis-tool UX)

> Status: APPROVED direction (user sign-off in-thread). Driven by three reproduced UX complaints on a real
> design (checkout-path: Web client → NGINX → Checkout API → Postgres, 2,000 rps under an SLO ≥ 5,000).
> Decision: ONE real-by-default System view (not two), the CANVAS as the live readout, and ONE legible
> Improve surface — copying proven patterns from mature tools (SPICE, FEA, USE, Excel Solver, Figma).

## 1. The problems (reproduced, with evidence)

1. **Live vs Simulate look contradictory.** Live shows `Latency 71 ms`; Simulate shows `mean 10,474 ms · p99 17,897 ms` — 147×. Root cause: Postgres is at **100% utilization**; the Live latency is the SUM OF SERVICE TIMES with **no queue wait**, so under saturation it pretends the design is fine while requests actually wait ~10 s (→ timeouts, dropped connections). The Live numbers are the ASSUMED ideal; **in reality they don't occur** — yet today they are the headline everywhere (canvas, footer). "The tool must not lie."
2. **Layout is unintuitive.** End-to-end **SLO inputs are duplicated** (Inspector AND System>Live). **Three** unclear "improve" affordances: *Auto-fix bottleneck* (status bar — user: "just hangs there, I don't know what it does"), *Optimize* (tab), *Compare options* (Inspector).
3. **Optimize is illegible.** It runs (Postgres.concurrency → 250) but the default "Min cost" leaves cost unchanged, with no "meets all SLOs ✓", no before→after, and no view of which knobs/SLOs are in play.

Root theme: the tool **conflates the model's ASSUMED numbers with the RESULTS of analysis**, and the critical truth (a tier saturating → 10 s waits) is invisible on the editor.

## 2. Patterns we copy (researched)

- **SPICE** — `.OP` (steady-state, no time) vs `.TRAN` (over time) are two named analyses, never conflated. ([Cadence](https://resources.pcb.cadence.com/blog/2019-transient-analysis-for-circuits-with-spice-simulations))
- **FEA Studies** — analyses are named, results kept separate from the model. ([SolidWorks](https://www.solidworks.com/product/solidworks-simulation))
- **USE method / capacity** — saturation = work queued because a resource can't keep up; **utilization ρ is the bridge**; warn ~80%. ([USE](https://www.connected.app/library/use-method-sv42wsv))
- **Excel Solver** — Objective + Changing cells + Constraints + explicit "all constraints satisfied" verdict. ([Microsoft](https://support.microsoft.com/en-us/office/define-and-solve-a-problem-by-using-solver-5d1a388f-079d-43ac-a7eb-f63e45925040))
- **Figma/Blender** — ONE selection inspector; no duplicated inputs. ([Cocos](https://docs.cocos.com/creator/3.8/manual/en/editor/inspector/index.html))
- **Cloudcraft** — live cost on the canvas. ([Datadog](https://www.datadoghq.com/blog/cloud-architecture-diagrams-cost-compliance-cloudcraft-datadog/))

## 3. The redesign — real by default, the canvas is the readout

**Key realisation:** between Live and Simulate, only **latency** diverges — throughput, availability and cost are identical (structural, not simulated). And **saturation is instant**: a tier overloaded (`overflow > 0`, ρ≥1) is already known in the forward pass — no slow simulation needed. So the critical truth can be shown LIVE on every edit; the DES only sharpens the latency tail.

### 3a. ONE System view (merge Live + Simulate; real by default)
- Throughput · Availability · Cost — shown once (identical in both analyses), instant.
- **Latency = the REAL (with-queueing) value** is the headline; the ideal "no-queue" number (71 ms) survives only as a small labelled reference *"ideal · no queue"*. The assumed value is demoted everywhere; reality is the default.
- Per-tier **ρ (load)** + a saturation banner; **p50/p95/p99** tail from the DES.
- Live's exact verdicts/cause-chains/remediations stay (they're the engine's explanation) — just not as the latency headline.

### 3b. The CANVAS is the live readout (animation = data)
The animation already has three channels; we point them at REALITY so one glance reads the system:
- **Colour = health** (green→amber→red by **saturation / drops**, not only the SLO verdict) — a saturated tier is red even with no SLO set. (Today colour = SLO status only, so an overloaded node with no SLO looks fine.)
- **Dash speed = throughput (Tr)** — busier wire, faster dashes. (Keep.)
- **Dot speed = real (queueing-aware) latency (La)** — a saturated hop's dot **crawls/stalls**, making the bottleneck visible. (Today it uses the no-queue service time, so the dot mistakenly races on a melting tier.)
- **Per node:** ρ + a ⚠ "saturated / dropping" badge (instant, from `overflow`). This is where you SEE the DB at 100% → ~10 s — the critical info that was missing on the editor.
- **Footer:** always the real end-to-end (throughput · **real latency** · availability · cost) + saturation flag — never the falsely-calm 71 ms.

### 3c. Compute layering (how it stays live on every edit)
- **Instant layer (every edit):** throughput, availability, cost, `overflow`/saturation, ρ, and a **queueing-aware latency** (analytic, e.g. service/(1−ρ)) — feeds the canvas, animation, footer and headline. Engine-side, differential-tested against the DES (engine charter).
- **Precise tail (on demand / debounced):** the DES p50/p95/p99 + drops → the System panel's distribution. Saturation/colour never wait on it.

### 3d. ONE legible Improve surface (Excel-Solver-shaped) — folds in Auto-fix + Optimize + Compare
```
─ Improve  (solve the design backwards) ───────────────────────────
  Goal:  (•) Make it meet its SLOs   ( ) Cheapest under SLOs
         ( ) Fastest                 ( ) Swap a component
  Changing:   Postgres.concurrency, Checkout.concurrency   (tunable knobs)
  Subject to: Throughput ≥ 5,000                           (your SLOs)
  ───────────────────────────────────────────────
  ✓ Solution found — all SLOs satisfied
       Cost                   $285 → $410 /mo
       Postgres.concurrency    100 → 250
  [ Apply ]
```
"Make it meet its SLOs" IS `repair` — the **default Goal** when the design has a violation. The orphaned status-bar "Auto-fix bottleneck" becomes a single `Fix →` CTA that OPENS this surface (no silent toast). No SLOs set → guidance; infeasible → the explained gap.

### 3e. ONE home for SLOs
End-to-end requirements live only in the System/flow view. The Inspector keeps per-node CONFIG; the duplicated SLO block is removed.

## 4. Decisions (agreed)

- **One real-by-default System view** (merge Live/Simulate); the ideal/no-queue numbers demoted to a labelled reference. Tabs become **[ System ] [ Improve ]**.
- **Canvas/footer show REAL values, live on edit**; saturation/ρ instant from the forward pass; the latency tail from the DES (debounced).
- **Animation channels:** colour = health/saturation, dash = throughput (Tr), dot speed = real queueing-aware latency (La).
- **Improve** folds Optimize + Auto-fix + Compare; default Goal by state (violation → feasible). Status bar keeps a `Fix →` CTA that opens Improve.
- **SLO home:** the System/flow view; drop the Inspector duplicate.

## 5. Tasks this spawns (build order)

- **T-real-canvas (FIRST — instant win, no new engine math):** surface `overflow`/saturation on nodes (ρ + ⚠ badge); recolour edges by real health (saturated/dropping = red even without an SLO); make the incoming dot crawl/stall on a saturated hop; footer shows the real picture + saturation. Fixes "I didn't see the 10 s on the DB".
- **T-queue-latency (engine/content):** an instant queueing-aware latency (analytic, differential-tested vs the DES) → precise dot speed + the real latency headline.
- **T-merge-view:** collapse Live/Simulate into one real-by-default System view; demote the ideal numbers to a labelled reference; keep verdicts/percentiles.
- **T-improve:** the Solver-shaped Improve surface; fold in Auto-fix (status-bar `Fix →` CTA) + Compare; verdict + before→after.
- **T-slo-home:** remove the SLO duplication.
