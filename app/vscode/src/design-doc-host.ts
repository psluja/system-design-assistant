import { deserialize } from '@sda/core';
import {
  registry,
  allManifests,
  generateDesignDoc,
  renderDesignDocHtml,
  buildLoadSweep,
  evaluateWorldsSync,
  guaranteeVerdicts,
  guaranteeVerdictRow,
  hasTrafficOrigin,
  lagVerdicts,
  lagVerdictRow,
  mergeMeasuredVerdicts,
  realCumulativeLatency,
  responseLatency,
  simResultForDoc,
  type DesignDocInput,
  type DocGroup,
  type DocWorldsInput,
  type Manifest,
} from '@sda/content';
import { makeNativeAdapter } from '@sda/solver-contract/native';
import type { Graph } from '@sda/engine-core';
import { evaluateText } from './host-eval';

// HOST-SIDE design-doc generation for the VS Code extension. THE PROTOCOL FINDING (design-doc-v2 R3): the frozen
// host↔webview `designDoc` message carries a field literally named `markdown` (protocol.ts), so a webview that
// builds the doc can only ship Markdown over it. Rather than touch the frozen protocol, we build the deliverable
// ENTIRELY HOST-SIDE from the document TEXT — exactly the `host-eval.ts` pattern the CodeLens and SLO Test Explorer
// already use — so the command owns the file path, works even when the file is opened as plain text (no live canvas
// needed), and can emit EITHER format. The webview's own `designDoc` round-trip stays untouched and simply unused by
// the file-writing command.
//
// PURE of vscode: this module compiles the text and returns a rendered string (or null when the design does not
// build), so it is unit-testable directly and cannot drift from the web/MCP surfaces (all three call the SAME
// @sda/content functions over the SAME DesignDocInput).

/** The generated document text plus the format actually produced (drives the file extension + mime the caller uses). */
export interface GeneratedDoc {
  readonly format: 'html' | 'markdown';
  readonly text: string;
}

/**
 * Build the design document from a `.sda.json` document's TEXT, in the requested format. Returns null when the design
 * does not parse or does not evaluate — the caller then reports an honest "did not build", never a misleading empty
 * document. The HTML form carries the §5 load→latency sweep (guarded on a traffic origin) and a generation timestamp
 * (minted HERE, the surface — the model stays clockless); the Markdown form omits both, matching the other surfaces.
 *
 * DES-IN-THE-DOC: the host runs the discrete-event simulation SYNCHRONOUSLY (it is deterministic and
 * needs no worker), so the written file embeds the measured tail / per-node percentiles / retry outcome and resolves
 * each lag SLO — the honest measured picture, not "no simulation results". Guarded on a traffic origin + no request
 * classes (the same guard `simulate` uses); absent either, the doc keeps the scalar picture, never a fabricated tail.
 */
export function buildDesignDocText(text: string, format: 'html' | 'markdown'): GeneratedDoc | null {
  const parsed = deserialize(text);
  if (!parsed.ok) return null;
  const ev = evaluateText(text);
  if (ev === null) return null;

  const proj = parsed.value;
  const groups: DocGroup[] = proj.groups.map((g) => ({ id: g.id, label: g.label, members: g.members }));
  // The scenario-comparison section (assumption-model doc §8) — evaluated SYNCHRONOUSLY via the native adapter's sync
  // `Evaluate` capability (no worker, no await), so the WRITTEN file carries the per-world table when the design
  // declares named worlds. Absent worlds ⇒ omitted (the no-filler rule, like the DES tail the host cannot run).
  const worlds: DocWorldsInput | undefined = (() => {
    if (proj.scenarios.length === 0) return undefined;
    const adapter = makeNativeAdapter({ registry });
    const evaluateGraph = (gr: Graph) => { const r = adapter.evaluate({ graph: gr }); return r.ok ? r.value : undefined; };
    const result = evaluateWorldsSync({ graph: ev.graph, instances: proj.instances, wires: proj.wires, scenarios: proj.scenarios, systemPromises: proj.systemPromises }, evaluateGraph);
    return { result, scenarios: proj.scenarios };
  })();
  // DES-IN-THE-DOC: run the simulation synchronously so the file carries the measured tail / per-node
  // percentiles / retry outcome and a RESOLVED lag verdict. Guarded on a traffic origin + no request classes (the
  // single-river DES cannot yet route per-class) — absent either, the doc keeps the honest scalar picture.
  const docSim = proj.requestClasses.length === 0 && hasTrafficOrigin(proj.instances, proj.wires, ev.value)
    ? simResultForDoc(ev.graph, registry, proj.lagSlos)
    : undefined;
  const input: DesignDocInput = {
    name: proj.name,
    instances: proj.instances,
    wires: proj.wires,
    groups,
    labels: proj.labels,
    descriptions: proj.descriptions,
    // The merged catalog (built-ins + project-embedded custom) unlocks the v2 assumptions register + risks; the
    // layout carries the canvas positions into the C4 SVG. Same wiring as the web + MCP surfaces.
    catalog: mergedCatalog(proj.components),
    layout: proj.layout,
    // REAL-aware scalar verdicts (queueing latency + ρ≥1 saturation), then the DES-measured tail/goodput verdicts
    // merged OVER them (F3) — a p99 SLO the run proved reads its real verdict, not "unknown". Same as MCP/web.
    verdicts: docSim ? mergeMeasuredVerdicts(ev.verdicts, docSim.verdicts) : ev.verdicts,
    value: ev.value,
    realLatencyByNode: Object.fromEntries(realCumulativeLatency(ev.graph, ev.value, ev.queues)),
    responseLatencyByNode: Object.fromEntries(responseLatency(ev.graph, ev.value, ev.queues)),
    // The saturated tiers at the WORST load the environment produces: the steady ρ≥1 set PLUS any node the shaped
    // sweep found saturates at its worst window — so the capacity table marks the same broken tier the verdicts do.
    saturated: [...new Set([...[...ev.queues].filter(([, q]) => q.rho >= 1).map(([id]) => id), ...(ev.peak ? [...ev.peak].filter(([, p]) => p.rho >= 1).map(([id]) => id) : [])])],
    // Per-flow qualitative guarantee verdicts (doc: guarantee-propagation §4) — the SAME `guaranteeVerdicts` the MCP
    // `generate_doc` and the canvas read, so the deliverable's Guarantees section matches the live verdicts on every
    // surface. Empty (no requirement declared) ⇒ the section is omitted (the no-filler rule). The graph + value come
    // from the SAME host evaluation, so a swap the architect applied is reflected in the tokens the doc prints.
    guaranteeVerdicts: proj.guaranteeSlos.length > 0
      ? guaranteeVerdicts(ev.graph, mergedCatalog(proj.components), proj.instances, proj.wires, ev.value, proj.guaranteeSlos).map(guaranteeVerdictRow)
      : undefined,
    // Per-flow LAG verdicts (doc: latency-semantics-v2 §3) — MEASURED (async queue waits included) when the DES ran
    // (F3), resolving the scalar `unknown` into a real ok/violation; else omitted. The §5 block reports them.
    lagVerdicts: proj.lagSlos.length > 0 ? lagVerdicts(ev.graph, ev.value, proj.lagSlos, ev.queues, docSim?.lag).map(lagVerdictRow) : undefined,
    // The measured DES tail / per-node response percentiles / retry outcome (F3) — present only when the run happened.
    ...(docSim ? { tail: docSim.tail, responsePercentilesByNode: docSim.responsePercentilesByNode, retry: docSim.retry } : {}),
    ...(worlds !== undefined ? { worlds } : {}),
    // The declared SYSTEM promises (owner ruling: cost is for THE WHOLE SYSTEM) — §2/§3 render them scope-
    // labelled `system`, judged against the same whole-graph total every other surface reads.
    ...(proj.systemPromises.length > 0 ? { systemPromises: proj.systemPromises } : {}),
    // HTML-only extras: the sweep (fresh forward evaluations at scaled load, guarded on a traffic origin so we never
    // invent a workload) and the generation timestamp (minted only here, at the surface).
    ...(format === 'html'
      ? {
          sweep: hasTrafficOrigin(proj.instances, proj.wires, ev.value)
            ? buildLoadSweep({ instances: proj.instances, wires: proj.wires, registry, catalog: mergedCatalog(proj.components) })
            : undefined,
          generatedAt: new Date().toISOString(),
        }
      : {}),
  };

  return { format, text: format === 'html' ? renderDesignDocHtml(input) : generateDesignDoc(input) };
}

/** The merged catalog = built-in manifests + the project's own embedded component definitions (the latter win). The
 *  same merge `Studio.mergedCatalog()` does; recreated here because the host builds off the parsed doc, not a Studio. */
function mergedCatalog(components: readonly Manifest[]): Record<string, Manifest> {
  const merged: Record<string, Manifest> = { ...allManifests };
  for (const m of components) merged[m.type] = m;
  return merged;
}
