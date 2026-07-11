# Feature Catalog

<!-- GENERATED FILE — do not edit. Source of truth: `@feature` headers in the listed modules. Regenerate with `pnpm catalogs`; freshness is asserted by scripts/generate-catalogs.test.ts. -->

Every shipped domain feature, cataloged from the `@feature` header on its seam module: the user story, the surfaces it ships on, the algorithms it rides on, its design docs, and where it is tested end-to-end. 20 features.

### Assumption uncertainty (Monte Carlo + GPU)

Seam: `content/sda/src/uncertainty.ts`

- **Story:** Declare ranges on soft inputs and every conclusion becomes a distribution — percentiles, histograms, SLO confidence and a tornado — reproducibly, with optional WebGPU acceleration.
- **Surfaces:** mcp (uncertainty + set_range/clear_range, app/mcp/src/uncertainty.ts), web (app/web/src/uncertainty-worker.ts gpu|cpu modes + panel), vscode (sda.setRange/clearRange, app/vscode/webview/uncertainty-worker.ts), presenter (app/presenter/src/uncertainty-view.ts)
- **Algorithms:** `content/sda/src/uncertainty.ts`, `engine/solver-contract/src/gpu/compile.ts`, `engine/solver-contract/src/gpu/fp32.ts`, `engine/solver-contract/src/gpu/webgpu.ts`
- **Docs:** `docs/design/uncertainty-monte-carlo.html`, `docs/design/solver-contract.html`
- **E2E:** none (unit + differential: content/sda/src/uncertainty.test.ts and engine/solver-contract/src/gpu/differential.test.ts)
- **Status:** shipped (GPU backend is preview-grade fp32 with CPU fallback, by design)

### Backward search (optimize / repair / explain_infeasible / apply_solution)

Seam: `app/mcp/src/search.ts`

- **Story:** Size the design backwards: find the cheapest configuration that meets all SLOs, fix a broken design with the minimal change, learn WHY it is infeasible — then apply the found solution in one click.
- **Surfaces:** mcp (repair / optimize / explain_infeasible / apply_solution here), vscode (Improve, app/vscode/src/solver-host.ts), web (Improve in app/web/src/app.tsx)
- **Algorithms:** `engine/solver-contract/src/native/search.ts`, `engine/solve/src/minizinc/search.ts`, `content/sda/src/robust.ts` (worlds mode)
- **Docs:** `docs/design/solver-contract.html`
- **E2E:** `content/sda/src/optimize.e2e.test.ts`, `content/sda/src/sizing.e2e.test.ts`, `app/mcp/src/cqrs-escalation.e2e.test.ts`
- **Status:** shipped

### Capacity envelope

Seam: `content/sda/src/envelope.ts`

- **Story:** With no declared demand, see the maximum sustained load each traffic origin can carry with every SLO still green — plus what breaks first, the joint edge and the queueing knee.
- **Surfaces:** mcp (envelope tool, app/mcp/src/assumptions.ts), web (System panel, app/web/src/app.tsx), presenter (app/presenter/src/envelope-view.ts)
- **Algorithms:** `content/sda/src/envelope.ts`, `engine/solver-contract/src/native/search.ts`, `content/sda/src/queueing.ts`
- **Docs:** `docs/design/assumption-model.html`
- **E2E:** `content/sda/src/envelope-des.e2e.test.ts`
- **Status:** shipped

### Delivery guarantees (consistency / ordering / delivery propagation)

Seam: `content/sda/src/guarantees.ts`

- **Story:** Catch the invisible production bugs — stale reads, lost order, duplicates: declare a per-flow guarantee and see the computed end-to-end token, the provable root-cause hop, the cheapest same-family fix, and a colored strip on every wire.
- **Surfaces:** mcp (set_guarantee_slo / clear_guarantee_slo, verdicts on evaluate — app/mcp/src/tools.ts), web + vscode (wire strips + flow lines via app/presenter/src/guarantee-view.ts; sda.setGuaranteeSlo / clearGuaranteeSlo)
- **Algorithms:** `engine/solve/src/guarantee/propagate.ts`, `engine/solve/src/guarantee/datalog.ts`, `engine/core/src/lattice.ts`
- **Docs:** `docs/design/guarantee-propagation.html`
- **E2E:** `content/sda/src/guarantees.e2e.test.ts`, `content/sda/src/guarantee-slo.e2e.test.ts`
- **Status:** shipped

### Design-doc generator (the authored deliverable)

Seam: `content/sda/src/design-doc.ts`

- **Story:** Turn the verified model into the architect's actual deliverable — a Markdown or self-contained HTML design document with COMPUTED NFR numbers (promises, capacity, C4, cost, reliability, bottlenecks, assumption register); nothing hand-entered, author-required sections flagged.
- **Surfaces:** mcp (generate_doc, app/mcp/src/document.ts), vscode (sda.generateDesignDoc, app/vscode/src/design-doc-host.ts), web (export button in app/web/src/app.tsx — the same pure function, identical output)
- **Algorithms:** `content/sda/src/system.ts`, `content/sda/src/queueing.ts`, `content/sda/src/sweep.ts`, `engine/sim/src/des.ts` (measured verdicts via doc-sim)
- **Docs:** `docs/design/design-doc-v2.html`, `docs/design/final-acceptance-design-doc.html`, `docs/design/sample-generated-design-doc.html`
- **E2E:** none (golden: content/sda/src/design-doc.golden.test.ts and the render/model suites)
- **Status:** shipped

### File-based IO (the agent edits the open .sda.json)

Seam: `app/mcp/src/file-io.ts`

- **Story:** The AI reads and writes the SAME .sda.json file the human has open — confined to the workspace — so "the AI moves my canvas" just works, with an unsaved-canvas reminder instead of a forked copy.
- **Surfaces:** mcp (import_design / save_design here; get_project / import_project in app/mcp/src/tools.ts), vscode (custom editor live-reloads external writes, app/vscode/src/editor-provider.ts), web (import/export via app/web/src/download.ts + IndexedDB autosave app/web/src/idb.ts)
- **Algorithms:** none (data/plumbing)
- **Docs:** none (TASK-84; workflow context in docs/design/readiness-audit.html)
- **E2E:** `app/mcp/src/real-architectures.e2e.test.ts` (drives the file path end to end)
- **Status:** shipped

### Flow transforms & generate (per-port traffic algebra + load curves)

Seam: `content/sda/src/manifest.ts`

- **Story:** Declare the real traffic transfer function on a port or wire ("1 request becomes 100 log lines", batch 100:1, cap, probabilistic split) or make a port ORIGINATE load with generate(level) plus an optional 24h load curve — and watch it flow through evaluate and simulate alike.
- **Surfaces:** mcp (set_transform / set_wire_transform, app/mcp/src/tools.ts), web (app/web/src/transform-editor.tsx + rate pills via app/presenter/src/edge-rates.ts), vscode (sda.setPortTransform / setWireTransform, app/vscode/src/port-transforms.ts)
- **Algorithms:** `engine/solve/src/network/build.ts` (scalar folding), `content/sda/src/sim.ts` (DES route means), `engine/sim/src/profile.ts` (load-curve arithmetic)
- **Docs:** `docs/design/flow-transformations.html`, `docs/design/flow-transformations-r2.html`, `docs/design/load-curves.html`
- **E2E:** `content/sda/src/transform.e2e.test.ts`, `content/sda/src/generator.e2e.test.ts`
- **Status:** shipped

### Honest solver escalation

Seam: `engine/solver-contract/src/escalate.ts`

- **Story:** The tool never dead-ends while it owns the answer: when the fast native solver declines a budget-coupling trade-off, the SAME request reruns on the exact reference MIP, hard-time-bounded, and the answer is labelled with the engine that produced it — never a silent fallback.
- **Surfaces:** mcp (search tools via app/mcp/src/search.ts + app/mcp/src/composition.ts), vscode (app/vscode/src/solver-host.ts), user wording in app/mcp/src/messages.ts
- **Algorithms:** `engine/solver-contract/src/native/search.ts` (the decliner), `engine/solve/src/minizinc/search.ts` (the reference MIP it escalates to)
- **Docs:** `docs/design/solver-contract.html`
- **E2E:** `app/mcp/src/cqrs-escalation.e2e.test.ts`
- **Status:** shipped

### Ideal layout (semantic auto-layout)

Seam: `app/presenter/src/layout-polish.ts`

- **Story:** Click the ideal-layout button and get a tidy, meaningful placement — tiers and flow read left to right, wires straighten, pinned nodes are never fought — instantly floored at Tidy and polished in the background.
- **Surfaces:** web (HUD button, app/web/src/app.tsx via app/web/src/layout.ts), vscode (sda.idealLayout + the webview pipeline app/vscode/webview/ideal-layout.ts), presenter (createPolisher here — both shells drive the identical logic)
- **Algorithms:** `app/presenter/src/layout.ts`, `app/presenter/src/layout-semantic.ts`, `app/presenter/src/layout-refine.ts`, `app/presenter/src/layout-ports.ts`, `app/presenter/src/layout-optimize.ts`, `app/presenter/src/layout-objective.ts`, `app/presenter/src/edge-routing.ts`, `app/presenter/src/layout-model.ts`, `app/presenter/src/layout-gpu/proxy.ts`
- **Docs:** `docs/design/ideal-layout.html`
- **E2E:** none (unit + benchmark gate: app/presenter/src/layout-benchmark.test.ts over the committed examples)
- **Status:** shipped (GPU proposer is an acceleration seam; CPU decides every applied layout)

### Lag SLOs (flow-scoped propagation deadlines)

Seam: `content/sda/src/lag-slo.ts`

- **Story:** Require that a change captured at the source reaches the destination within X ms — the CDC/replication deadline that INCLUDES async queue waits — and read an honest ok / violation / unknown back on every surface.
- **Surfaces:** mcp (set_lag_slo / clear_lag_slo, verdicts on evaluate + simulate — app/mcp/src/tools.ts), vscode (SLO/requirements hosts, app/vscode/src/slo-requirements.ts), presenter (lag rows in app/presenter/src/summary.ts)
- **Algorithms:** `content/sda/src/queueing.ts` (the Dijkstra scalar lower bound), `engine/sim/src/des.ts` (measured async-inclusive lag)
- **Docs:** `docs/design/latency-semantics-v2.html`
- **E2E:** `content/sda/src/lag-slo.e2e.test.ts`
- **Status:** shipped

### Load stages (traffic that changes over time + peak-aware verdicts)

Seam: `content/sda/src/load-stages.ts`

- **Story:** A traffic origin declares a k6/Gatling-style STAGES table wrapped in periodic CYCLES; the engine plays the shape live (a launch spike, a diurnal rhythm, a quarterly season), evaluates the whole auto-derived season in two labelled tiers, and judges every per-node surface at the declared PEAK — so a node calm at the mean but over capacity at its daily peak reads a violation on the canvas ρ chip / Inspector / System ρ rows, not green. Supersedes the deleted one-click spike probe (the net-negative ledger): its survival verdict lives on per-window.
- **Surfaces:** web + vscode (the ⚡ generator + cycles-table editor, the ambient two-tier System block, and the PEAK-AWARE ρ chip / Inspector verdict / System ρ rows — app/presenter/src/peak-view.ts), mcp (via `simulate`)
- **Algorithms:** `content/sda/src/load-stages.ts` (the multi-cycle rate product), `content/sda/src/time-sweep.ts` (the Tier-1 quasi-static sweep + per-node peak), `content/sda/src/two-tier.ts` (propose/prove), `content/sda/src/sim.ts` (DES lowering)
- **Docs:** `docs/design/load-stages.html`
- **E2E:** `content/sda/src/two-tier.e2e.test.ts`, `content/sda/src/generator.e2e.test.ts`, `app/web/src/two-tier.e2e.test.ts`, `app/presenter/src/two-tier-view.test.ts`
- **Status:** shipped

### Reliability advisor (nines tiers + DR ladder)

Seam: `content/sda/src/reliability.ts`

- **Story:** Per flow: the computed end-to-end availability, the AWS-documented nines tier it meets, the sourced remedy for a target, and a DR-tier recommendation derived from RPO/RTO — quoted, never opinion.
- **Surfaces:** mcp (reliability, app/mcp/src/reliability.ts), design doc (reliability section via content/sda/src/design-doc.ts)
- **Algorithms:** `content/sda/src/system.ts` (the series-product availability it interprets)
- **Docs:** none (primary AWS sources are cited inline below)
- **E2E:** none (unit: content/sda/src/reliability.test.ts, `app/mcp/src/reliability.test.ts)`
- **Status:** shipped

### Request classes (multi-commodity flows over one topology)

Seam: `content/sda/src/request-class.ts`

- **Story:** An each-to-each mesh (A calls B for orders, B calls A for reports) is cyclic as a whole but each named class is acyclic — declare classes with their own origins and wire membership and get honest per-class computation instead of a refusal.
- **Surfaces:** mcp (declare_class / set_class_membership / set_class_origin / remove_class / list_classes, app/mcp/src/tools.ts; per-class verdicts on evaluate), web + vscode (per-class readouts via the shared presenter)
- **Algorithms:** `engine/solve/src/network/build.ts` (class slicing + the processor-sharing split)
- **Docs:** `docs/design/request-classes.html`
- **E2E:** `content/sda/src/fanin.e2e.test.ts` (the mesh case)
- **Status:** partial (forward/scalar per-class shipped; per-class tails and backward search are honestly declined, by design)

### Response percentiles & real-aware verdicts

Seam: `content/sda/src/verdict.ts`

- **Story:** Set a mean or p99 latency SLO: the scalar pass judges against REAL (queueing-aware) response latency with explicit saturation violations, honestly answers `unknown` for tails, and the DES then measures every node's percentiles and turns them into real verdicts.
- **Surfaces:** mcp (simulate, app/mcp/src/simulate.ts), web (latency chips + sim worker, app/web/src/sim-worker.ts), vscode (Test-Explorer SLO verdicts, app/vscode/src/slo-tests.ts), presenter (app/presenter/src/latency.ts, app/presenter/src/sim-verdicts.ts)
- **Algorithms:** `content/sda/src/queueing.ts`, `engine/sim/src/des.ts`, `engine/sim/src/stats.ts`
- **Docs:** `docs/design/latency-semantics-v2.html`
- **E2E:** `content/sda/src/tail.e2e.test.ts`, `content/sda/src/response-latency.e2e.test.ts`, `app/web/src/latency-chips.e2e.test.ts`
- **Status:** shipped

### Retry feedback & goodput collapse

Seam: `content/sda/src/sim.ts`

- **Story:** Model caller timeouts, retries and backoff so the simulation shows retry amplification and the goodput-collapse death spiral, not a naive steady state.
- **Surfaces:** mcp (simulate reads goodput + amplification), web + vscode (config knobs timeoutMs / retryCount / retryBackoffMs via set_config and the inspectors)
- **Algorithms:** `engine/sim/src/des.ts`, `content/sda/src/sim.ts`
- **Docs:** `docs/design/retry-feedback.html`
- **E2E:** `content/sda/src/retry-feedback.e2e.test.ts`
- **Status:** shipped

### Robust improve (across worlds)

Seam: `content/sda/src/robust.ts`

- **Story:** Size the design to the cheapest configuration that holds every SLO in ALL selected worlds, not just the "real" one.
- **Surfaces:** mcp (optimize/repair with worlds, app/mcp/src/search.ts), vscode (Improve, app/vscode/src/solver-host.ts)
- **Algorithms:** `content/sda/src/robust.ts`, `engine/solver-contract/src/native/search.ts`
- **Docs:** `docs/design/assumption-model.html`
- **E2E:** none (property + unit: content/sda/src/robustness.property.test.ts)
- **Status:** shipped (surfaced through the search tools, no standalone tool name)

### Synthesis & compare-options (generate, size, rank)

Seam: `content/sda/src/synthesize.ts`

- **Story:** Pick a node (or an intent) and let the engine enumerate every component that legally fits its wiring, size each candidate to meet the SLOs at the cheapest configuration, and rank the survivors — a fair Fargate-vs-Lambda-vs-ASG comparison in one call.
- **Surfaces:** mcp (compare_options / synthesize / auto_architect, app/mcp/src/synthesize.ts), vscode (sda.compareOptions, app/vscode/src/compare-host.ts)
- **Algorithms:** `engine/solve/src/asp/clingo.ts` (enumeration), `engine/solver-contract/src/native/search.ts` (sizing), `engine/solve/src/minizinc/search.ts` (sizing), `engine/solve/src/fixpoint/solve.ts` (forward ranking)
- **Docs:** `docs/design/solver-contract.html`
- **E2E:** `content/sda/src/synthesize.e2e.test.ts`
- **Status:** shipped

### System evaluation & roll-up

Seam: `content/sda/src/system.ts`

- **Story:** Every edit yields the verified end-to-end picture — per-flow throughput, latency, availability, cost and honest verdicts — identical on the canvas, in the doc and over MCP.
- **Surfaces:** mcp (evaluate / apply_design, app/mcp/src/tools.ts), web (canvas + System panel), vscode (System tree, diagnostics, status bar), presenter (summary/status/problems)
- **Algorithms:** `content/sda/src/system.ts`, `engine/solve/src/fixpoint/solve.ts`, `engine/solve/src/network/build.ts`, `content/sda/src/queueing.ts`
- **Docs:** none (the engine calculus and coverage map live in the Backlog docs doc-4 / doc-8)
- **E2E:** `content/sda/src/architectures.e2e.test.ts`, `content/sda/src/system.e2e.test.ts`, `app/web/src/value-loop.e2e.test.ts`
- **Status:** shipped

### System promise (whole-design cost ceiling)

Seam: `content/sda/src/system-promise.ts`

- **Story:** Promise a ceiling for the WHOLE system — the entire monthly bill, off-path branches included — get a system-scoped verdict, and have optimize/repair hold the same total as a whole-design budget.
- **Surfaces:** mcp (set_slo with scope:"system", app/mcp/src/tools.ts; constrains search via app/mcp/src/search.ts), vscode (sda.setSystemRequirement, app/vscode/src/system-requirements.ts), web (System panel rows via app/presenter/src/summary.ts)
- **Algorithms:** `content/sda/src/system.ts`, `engine/solver-contract/src/native/search.ts`, `engine/solve/src/minizinc/search.ts` (Objective.total — one sum shared by verdict and search)
- **Docs:** none (owner ruling 2026-07; judged against the same total the search reads)
- **E2E:** `app/mcp/src/system-promise-cqrs.e2e.test.ts`, `content/sda/src/system.e2e.test.ts`
- **Status:** shipped

### Worlds / trio (named-scenario evaluation)

Seam: `content/sda/src/scenario.ts`

- **Story:** Compare pessimistic / real / optimistic worlds — values already derived from THIS design's envelope and ranges — across cost, utilization and verdicts in one matrix, with the active lens tagged.
- **Surfaces:** mcp (derive_scenarios, declare_scenario, set/clear_scenario_value, evaluate_scenarios — app/mcp/src/assumptions.ts), web (worlds matrix panel, app/web/src/app.tsx), vscode (scenario-host, scenario-lens, sda.clearScenarioOverride/resetScenario), presenter (app/presenter/src/worlds-view.ts)
- **Algorithms:** `engine/solve/src/fixpoint/solve.ts`, `content/sda/src/envelope.ts` (the trio derives demand from the envelope)
- **Docs:** `docs/design/assumption-model.html`
- **E2E:** `app/web/src/worlds.e2e.test.ts`, `app/mcp/src/cqrs-scale.e2e.test.ts`
- **Status:** shipped
