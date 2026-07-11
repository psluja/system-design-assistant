import { NodeId, type Graph, type Key } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import type { SolverBindings } from '@sda/solver-contract';
import type { Studio } from '@sda/core';
import { registry, generateDesignDoc, renderDesignDocHtml, buildLoadSweep, evaluateWorldsSync, guaranteeVerdicts, guaranteeVerdictRow, lagVerdicts, lagVerdictRow, hasTrafficOrigin, nodeQueues, realAwareVerdicts, realCumulativeLatency, responseLatency, simResultForDoc, mergeMeasuredVerdicts, timeSweep, peakLoadByNode, LOAD_STAGES_DEFAULTS, type EvaluateGraph, type DesignDocInput, type DocGroup, type DocWorldsInput } from '@sda/content';
import type { ToolDef } from './tools';
import { fail, obj, ok, READS, str } from './tool-kit';

// The DELIVERABLE generator as an MCP tool — `generate_doc` turns the verified model into the architect's
// actual output: a Markdown design document (doc-7 sections, a C4 view, a capacity table and a cost table)
// with the COMPUTED NFR numbers filled in. The generation itself lives in @sda/content (a pure function of
// the model), so the AI `generate_doc` and the web "export" emit the IDENTICAL document — one truth, no
// recomputation on either surface (doc-10's "no deliverables" gap; the web stays a dumb renderer).

export function buildDocTools(studio: Studio, solvers?: SolverBindings): ToolDef[] {
  return [
    {
      name: 'generate_doc',
      description:
        "Generate the architect's deliverable FROM the verified model. It fills the design-doc sections with COMPUTED numbers — promises/SLOs (declared vs computed vs status), a capacity table (per-flow throughput·latency·availability·cost + node overflow), a C4 container view, a cost table (true total + per-node share), reliability (the AWS nines tier each flow meets + the sourced remedy), and the bottleneck analysis (every breach, its cause and fix). Nothing is hand-entered. Sections SDA does not model (security, data model, rollout, alternatives) are flagged *author required* so the gating hallmarks are never silently missing. `format`: 'markdown' (default — Mermaid C4, easy to diff/paste into an RFC) or 'html' (the human deliverable — a self-contained HTML report with a rendered C4 SVG, capacity/utilisation charts, a load→latency sweep, and the assumptions register; hand it to a review board). Always consistent with the live design. Generate it AFTER the design verifies. e.g. {format:\"html\"}",
      inputSchema: obj({
        format: { type: 'string', enum: ['markdown', 'html'], description: "Output format: 'markdown' (default, diffable) or 'html' (the self-contained human deliverable)." },
      }),
      annotations: READS,
      run: (a) => {
        const format = str(a.format) === 'html' ? 'html' : 'markdown'; // default markdown — agents diff text
        const ev = studio.evaluate();
        if (!ev.ok) return fail('design has build errors: ' + ev.error.join('; '));
        const proj = studio.project();
        const groups: DocGroup[] = proj.groups.map((g) => ({ id: g.id, label: g.label, members: g.members }));
        const value = (id: string, k: Key) => ev.value.value(NodeId(id), k);
        // REAL-aware (queueing latency + ρ≥1 saturation), exactly like the web export — so the AI's deliverable
        // never launders a saturated tier into a clean number. The graph is available since the design evaluated.
        const g = studio.graph();
        const queues = g.ok ? nodeQueues(g.value, value) : undefined;
        // WORST-CASE LOAD (owner ruling: a peak is just traffic in a given environment): when a generator declares
        // periodic cycles, run the ambient Tier-1 sweep (the SAME coarse live budget the canvas worker uses) and fold
        // each node's worst-window ρ into the verdicts + the saturated-tier list, so the deliverable's bottleneck /
        // risks / capacity sections mark the same broken tier the canvas + MCP `evaluate` do (one truth). Silent for a
        // flat design ⇒ byte-identical. No 'peak' vocabulary — the node is judged against its worst load.
        const evalDI: EvaluateGraph = (gr) => { const r = evaluate(gr, registry); return r.ok ? r.value : undefined; };
        const sweep = g.ok ? timeSweep({ graph: g.value, evaluate: evalDI, pointsPerCycle: LOAD_STAGES_DEFAULTS.livePointsPerCycle, maxWindows: LOAD_STAGES_DEFAULTS.liveWindowTarget }) : undefined;
        const peak = sweep !== undefined ? peakLoadByNode(sweep) : undefined;
        const catalog = studio.mergedCatalog();
        // DES-IN-THE-DOC (TASK-87 F3): run the discrete-event simulation ONCE and EMBED the measured tail / per-node
        // response percentiles / retry outcome, and RESOLVE each declared lag SLO's honest scalar `unknown` into a
        // real measured verdict — so the deliverable no longer reads "p99 unknown / run the simulation" when the tool
        // could measure it. Guarded EXACTLY as the `simulate` tool: a traffic origin to simulate, and no request
        // classes (the single-river DES cannot yet route per-class). With neither, we skip the run and the doc keeps
        // the honest scalar picture — never a fabricated tail. Same cost the architect already pays for `simulate`.
        const canSim = g.ok && proj.requestClasses.length === 0 && hasTrafficOrigin(proj.instances, proj.wires, value);
        const docSim = canSim && g.ok ? simResultForDoc(g.value, registry, proj.lagSlos) : undefined;
        // REAL-aware (queueing latency + ρ≥1 saturation) scalar verdicts, then MERGE the DES-measured tail/goodput
        // verdicts OVER them (F3) — so a p99 SLO the run proved reads its real ok/violation, not the stale "unknown".
        const baseVerdicts = g.ok ? realAwareVerdicts(ev.value.verdicts, g.value, value, queues, peak) : ev.value.verdicts;
        // The scenario-comparison section (assumption-model doc §8) — computed SYNCHRONOUSLY via the sync `Evaluate`
        // capability (this tool must not await), so the deliverable carries the per-world table when the design
        // declares named worlds. Absent worlds or no bound solver ⇒ omitted (the no-filler rule, like the DES tail).
        const worlds: DocWorldsInput | undefined =
          g.ok && solvers !== undefined && proj.scenarios.length > 0
            ? {
                result: evaluateWorldsSync(
                  { graph: g.value, instances: proj.instances, wires: proj.wires, scenarios: proj.scenarios, systemPromises: proj.systemPromises },
                  (gr: Graph) => { const r = solvers.evaluate({ graph: gr }); return r.ok ? r.value : undefined; },
                ),
                scenarios: proj.scenarios,
              }
            : undefined;
        const input: DesignDocInput = {
          name: proj.name,
          instances: proj.instances,
          wires: proj.wires,
          groups,
          labels: proj.labels,
          descriptions: proj.descriptions,
          // The MERGED catalog unlocks the v2 assumptions register + risks sections (provenance is derived against
          // the catalog). The layout carries the canvas positions into the DocModel's architecture view (R2 C4 SVG).
          catalog,
          layout: proj.layout,
          verdicts: docSim ? mergeMeasuredVerdicts(baseVerdicts, docSim.verdicts) : baseVerdicts,
          value,
          realLatencyByNode: g.ok ? Object.fromEntries(realCumulativeLatency(g.value, value, queues)) : undefined,
          responseLatencyByNode: g.ok ? Object.fromEntries(responseLatency(g.value, value, queues)) : undefined,
          saturated: [...new Set([...(queues ? [...queues].filter(([, q]) => q.rho >= 1).map(([id]) => id) : []), ...(peak ? [...peak].filter(([, p]) => p.rho >= 1).map(([id]) => id) : [])])],
          // Per-flow qualitative guarantee verdicts (doc: guarantee-propagation §4) — the SAME computation `evaluate`
          // surfaces, so the deliverable's Guarantees section matches the live verdicts. Empty (no requirement) ⇒
          // the section is omitted (the no-filler rule).
          guaranteeVerdicts: g.ok && proj.guaranteeSlos.length > 0
            ? guaranteeVerdicts(g.value, catalog, proj.instances, proj.wires, value, proj.guaranteeSlos).map(guaranteeVerdictRow)
            : undefined,
          // Per-flow LAG verdicts (doc: latency-semantics-v2 §3) — the async-inclusive propagation deadlines. When the
          // DES ran (F3) it MEASURED the true async-inclusive mean, resolving the scalar `unknown` into a real
          // ok/violation (basis 'measured'); without a run it is the scalar lower-bound verdict. Empty ⇒ omitted.
          lagVerdicts: g.ok && proj.lagSlos.length > 0 ? lagVerdicts(g.value, value, proj.lagSlos, queues, docSim?.lag).map(lagVerdictRow) : undefined,
          // The measured DES tail / per-node response percentiles / retry outcome (F3) — present ONLY when the run
          // happened (a traffic origin, no request classes); the doc then prints measured p99s with their basis
          // instead of "unknown". The retry story still renders only when a policy is declared (buildSimulation gates it).
          ...(docSim ? { tail: docSim.tail, responsePercentilesByNode: docSim.responsePercentilesByNode, retry: docSim.retry } : {}),
          ...(worlds !== undefined ? { worlds } : {}),
          // The declared SYSTEM promises (owner ruling) — the doc's §2/§3 render them scope-labelled `system`,
          // judged against the same whole-graph total every other surface reads.
          ...(proj.systemPromises.length > 0 ? { systemPromises: proj.systemPromises } : {}),
          // The HTML report carries the §5 load→latency sweep + a generation timestamp. The sweep is a set of forward
          // evaluations at scaled offered load, computed FRESH here (never persisted) and guarded on a traffic origin
          // (never a fabricated workload). `generatedAt` is minted ONLY at this surface — the model stays clockless.
          ...(format === 'html'
            ? {
                sweep: hasTrafficOrigin(proj.instances, proj.wires, value) ? buildLoadSweep({ instances: proj.instances, wires: proj.wires, registry, catalog }) : undefined,
                generatedAt: new Date().toISOString(),
              }
            : {}),
        };
        return ok(format === 'html' ? renderDesignDocHtml(input) : generateDesignDoc(input));
      },
    },
  ];
}
