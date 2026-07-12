import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent as RDragEvent, type MouseEvent as RMouseEvent } from 'react';
import { parseDropType } from './drop';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap,
  useNodesState, useEdgesState, MarkerType, ConnectionLineType,
  type Connection, type Node, type Edge, type ReactFlowInstance,
} from '@xyflow/react';
import { Studio, type Group } from '@sda/core';
import {
  registry, keys, allManifests, protocolCompat,
  localContribution, requestFlows, nodeQueues, realCumulativeLatency, responseLatency, peakLoadByNode,
  realAwareVerdicts, systemSummary, hasTrafficOrigin, generateDesignDoc,
  computeEnvelope, evaluateWorlds, deriveDefaultScenarios, mergeDerivedTrio, hasScenarios, applyScenarioToGraph,
  type DocGroup, type NodeQueue, type NodePeak, type Manifest, type EnvelopeResult, type WorldsResult, type TwoTierResult,
} from '@sda/content';
import { NodeId, Key } from '@sda/engine-core';
import { portsConnect, evaluate } from '@sda/engine-solve';
import { makeNativeAdapter } from '@sda/solver-contract/native';
// The SHARED view-model layer: both shells (web + this webview) render the SAME computed models, so the two can
// never drift. The webview no longer builds problems/status/summary/nodeDetail inline — it calls the presenter and
// only maps the results onto its own wire shapes (structurally identical to the presenter's own types).
import {
  keyInfo, fmt, formatMs, routeDesignEdges, type RoutedWire, buildCandidates, suggestFor, matchingPort, type Suggestion,
  problemRows, statusLine, summarySections as presenterSummarySections, systemVerdict, nodeDetail as presenterNodeDetail, simVerdicts, measuredResponseOf, latencyTone, latencyRangeBar,
  pickerOptions, addPickedComponent, edgeRates, guaranteeSummarySections, uncertaintySection, twoTierSection, envelopeSection, worldsMatrix, activeLensLabel, rateRow, worstCaseUnits,
  type CatalogPorts, type PickerOption, type EdgeRate, type GuaranteeViewInput, type PolishPhase, type Polisher, type PolishScheduler, type PortOffsets,
} from '@sda/presenter';
// '✨ Ideal layout' — the webview-side pipeline (MEASURED sizes → the shared presenter search → Studio batches →
// the existing docChanged document-edit path). Pure orchestration, proven by ideal-layout.test.ts; this component
// only wires the canvas seams (measured footprints, rAF scheduler, dispatchBatch, fitView) into it.
import { startIdealLayout } from './ideal-layout';
import { runHostCommand } from './host-commands';
import { guaranteeVerdicts, lagVerdicts, lagVerdictRow, systemPromiseVerdicts, type LagVerdict } from '@sda/content';
// The canvas VIEW COMPONENTS (nodes, tooltip, facets, icons, theme) legitimately live in the web shell — they are
// the reused UI, not computed models — so they stay behind the `@web/*` alias, UNMODIFIED.
import { facetsOf } from '@web/facets';
import { Tooltip } from '@web/tooltip';
import { StudioCtx, nodeTypes, edgeTypes, type Tone, type Status, type NodeLoad } from '@web/flow-nodes';
// The post-insert overlap predicate behind the "Tidy?" offer — the SAME pure geometry the web shell uses.
import { insertOverlaps, FALLBACK_NODE, type Box } from '@web/overlap';
import type { HostBridge, SimTail, HostCommand, HostAction, UncertaintyView } from './host-bridge';
import type { WireProblem, WireStatus, SummarySection, NodeDetail } from '../src/protocol';
import { activeLensFeedSection } from '../src/lens-feed';

const CATALOG: Readonly<Record<string, Manifest>> = allManifests;

// The canvas context menu — a discriminated union on `kind`, so each variant carries exactly its own fields.
type Menu =
  | { readonly x: number; readonly y: number; readonly kind: 'node' | 'group'; readonly id: string }
  | { readonly x: number; readonly y: number; readonly kind: 'edge'; readonly semantics: 'sync' | 'async'; readonly from?: readonly [string, string]; readonly to?: readonly [string, string] }
  | { readonly x: number; readonly y: number; readonly kind: 'pane'; readonly flow: { readonly x: number; readonly y: number } };

/**
 * The webview canvas — CANVAS-ONLY (the user's ruling: every non-canvas view is a native VS Code control). This
 * component keeps ONLY the React Flow graph (nodes with live meters, legality-checked wiring, context menus, the
 * Group/Tidy HUD, zoom + minimap). Everything else a designer reads or edits — the palette, the inspector, the
 * System/Improve panels, the Problems list — is a native tree/QuickPick fed by the messages this component posts:
 *   • after every evaluation → `summary` (System tree) + `nodeDetail` (Inspector) + diagnostics (Problems/status),
 *   • on every selection change → `selection` (+ a fresh `nodeDetail`).
 * The host drives the canvas back through ACTIONS (addComponent / select / wireSuggestion) and geometry commands
 * (tidy / fitView / addGroup / generateDesignDoc / idealLayout). Backward-solving (Improve) is entirely host-side
 * now — this component neither initiates nor applies it.
 *
 * The `studio` is created and OWNED by `main.tsx` (which handles document sync); this component only renders and
 * mutates it. `bridge` routes all host services.
 */
export default function App({ studio, bridge }: { studio: Studio; bridge: HostBridge }): JSX.Element {
  const doc = useSyncExternalStore((cb) => studio.onChange(cb), () => studio.project());
  // THE ACTIVE-WORLD LENS — Studio UI state (out of the doc), subscribed on the SAME
  // stream. Single-river only (worlds decline under request classes). Identical wiring to the web shell.
  const active = useSyncExternalStore((cb) => studio.onChange(cb), () => studio.activeScenario());
  const activeWorld = useMemo(() => (doc.requestClasses.length === 0 ? doc.scenarios.find((s) => s.id === active) : undefined), [doc, active]);
  // The compiled graph, OVERLAID with the active world's fact-assumption overrides when one is selected — so every
  // downstream read (verdicts, chips, queues, the System tree) reflects THAT world. No active world ⇒ the base graph.
  const graphR = useMemo(() => {
    const base = studio.graph();
    if (!base.ok || activeWorld === undefined) return base;
    return { ok: true as const, value: applyScenarioToGraph(base.value, activeWorld) };
  }, [doc, activeWorld]);
  const graph = graphR.ok ? graphR.value : null;
  const ev = useMemo(() => (activeWorld !== undefined && graph ? evaluate(graph, registry) : studio.evaluate()), [doc, activeWorld, graph]);
  const okEv = ev.ok ? ev.value : null;
  const valueOf = (id: string, k: Key): number | undefined => (okEv ? okEv.value(NodeId(id), k) : undefined);
  const queues = useMemo<Map<string, NodeQueue>>(
    () => (graph && okEv ? nodeQueues(graph, (id, k) => okEv.value(NodeId(id), k)) : new Map()),
    [graph, okEv],
  );

  // The DES tail (p50/p95/p99) of the busiest flow — computed by the HOST-independent background sim wired by
  // main.tsx (the sim engine is pure JS and runs fine in a webview). Declared HERE so the verdicts can judge a
  // percentile (p99) SLO against it, and so the summary's tail section reads it.
  const [sim, setSim] = useState<SimTail | null>(null);
  // AMBIENT UNCERTAINTY — the background Monte-Carlo view (fp32 preview / fp64 confirmed), fed by
  // main.tsx's uncertainty worker; composed into the System-tree summary below via the shared presenter.
  const [unc, setUnc] = useState<UncertaintyView | null>(null);
  // AMBIENT TWO-TIER TRANSIENT — the ρ-envelope + worst window (Tier-1) and the survival
  // verdict (Tier-2), fed by main.tsx's two-tier worker; composed into the System-tree summary below via the shared
  // presenter (identical rows to the web System panel). Null when no generator declares cycles (no-filler).
  const [twoTier, setTwoTier] = useState<TwoTierResult | null>(null);
  // PEAK-AWARE PER-NODE LOAD — each node's WORST-WINDOW ρ + instant from
  // the ambient Tier-1 sweep, so the canvas ρ chip, the Inspector verdict and the System ρ rows judge the declared
  // PEAK, not just the steady baseline (identical to the web shell). Null with no shaped generator ⇒ byte-identical.
  const peakByNode = useMemo<Map<string, NodePeak> | null>(() => (twoTier ? peakLoadByNode(twoTier.tier1) : null), [twoTier]);
  // ASSUMPTION MODEL — the capacity ENVELOPE (default answer) and the all-world
  // MATRIX, recomputed ambiently on the in-process native solver (optimize + evaluateBatch, ms-grade), folded into
  // the System tree. Same wiring as the web shell; the native adapter is pure TS (already bundled in the webview).
  const [envW, setEnvW] = useState<{ env: EnvelopeResult | null; worlds: WorldsResult | null; computing: boolean }>({ env: null, worlds: null, computing: false });
  const envEpochRef = useRef(0);
  const solverRef = useRef<ReturnType<typeof makeNativeAdapter>>();
  if (!solverRef.current) solverRef.current = makeNativeAdapter({ registry });

  // REAL-AWARE verdicts, the ONE list every surface reads. Identical wiring to the web shell: the scalar-aware
  // correction from content, then the DES-fed verdicts (tail p99 + retry goodput/error) merged by the SHARED
  // presenter `simVerdicts` — so the two shells + the MCP compose the same time-domain verdicts, never re-wired.
  const verds = useMemo(() => {
    if (!okEv || !graph) return okEv?.verdicts ?? [];
    // Fed the sweep's per-node WORST-WINDOW ρ (peakByNode) so a node saturated at its declared peak carries an
    // ordinary saturation violation in this ONE list — the canvas, the native Inspector/System tree and the exported
    // doc show the same red tier (one truth). No shaped generator ⇒ peakByNode null ⇒ byte-identical. No 'peak' label.
    const base = realAwareVerdicts(okEv.verdicts, graph, (id, k) => okEv.value(NodeId(id), k), queues, peakByNode ?? undefined);
    return simVerdicts(base, graph, registry, sim);
  }, [okEv, graph, queues, sim, peakByNode]);

  const statusOf = (id: string): Status => {
    const vs = verds.filter((v) => v.scope === NodeId(id));
    if (vs.some((v) => v.status === 'violation')) return 'violation';
    if (vs.some((v) => v.status === 'warning')) return 'warning';
    return vs.length ? 'ok' : undefined;
  };

  // ── AMBIENT ENVELOPE + WORLDS LOOP ───────────────────────────────────────────
  // Recompute the envelope (native `optimize`) and the all-world matrix (native `evaluateBatch`) on every design
  // change, LATEST-WINS by epoch, RE-TRACKING the live-derived scenario values from the fresh envelope. Both decline
  // under request classes (class-blind) — a class-declared design shows neither, honestly. Native = ms-grade.
  useEffect(() => {
    const solvers = solverRef.current!;
    const proj = studio.project();
    if (proj.requestClasses.length > 0 || solvers.optimize === undefined) { setEnvW({ env: null, worlds: null, computing: false }); return; }
    const epoch = ++envEpochRef.current;
    setEnvW((p) => ({ ...p, computing: true }));
    const t = setTimeout(async () => {
      const catalog = studio.mergedCatalog();
      const env = await computeEnvelope({ instances: proj.instances, wires: proj.wires, registry, catalog }, solvers.optimize!);
      if (epoch !== envEpochRef.current) return;
      if (hasScenarios(proj.scenarios)) {
        const fresh = deriveDefaultScenarios({ instances: proj.instances, wires: proj.wires, catalog, envelope: env });
        if (fresh.scenarios.length > 0) studio.reconcileDerivedScenarios(fresh.scenarios);
      }
      const proj2 = studio.project();
      const g = studio.graph();
      let worlds: WorldsResult | null = null;
      if (g.ok && hasScenarios(proj2.scenarios) && solvers.evaluateBatch) {
        worlds = await evaluateWorlds({ graph: g.value, instances: proj2.instances, wires: proj2.wires, scenarios: proj2.scenarios, systemPromises: proj2.systemPromises }, solvers.evaluateBatch);
      }
      if (epoch !== envEpochRef.current) return;
      setEnvW({ env, worlds, computing: false });
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // "Derive the trio" (doc §5) — fill pessimistic/real/optimistic from THIS design's envelope, preserving frozen edits.
  const deriveTrio = async (): Promise<void> => {
    const solvers = solverRef.current!;
    const proj = studio.project();
    if (proj.requestClasses.length > 0 || solvers.optimize === undefined) return;
    const catalog = studio.mergedCatalog();
    const env = await computeEnvelope({ instances: proj.instances, wires: proj.wires, registry, catalog }, solvers.optimize);
    const derived = deriveDefaultScenarios({ instances: proj.instances, wires: proj.wires, catalog, envelope: env });
    if (derived.scenarios.length === 0) return;
    studio.dispatchBatch(mergeDerivedTrio(proj.scenarios, derived.scenarios).map((s) => ({ kind: 'declareScenario', decl: s })));
    studio.setActiveScenario('real');
  };

  // The PROBLEMS list posted to the native Problems panel — the SHARED presenter `problemRows` (identical severity
  // ordering, fix text and tailLatency hint as the web shell) mapped onto WireProblem. The host renders one message
  // STRING per row, so we compose it here from the SAME ProblemRow fields the web table renders as columns:
  // "<label> <value>" plus " — <fix>" when there is a remediation. Build-error rows carry the error text as `fix`.
  // The catalogue = built-ins + project-scoped custom components (custom wins). Declared here (before the guarantee
  // memos that need it) so the merged catalog is available to compute the guarantee verdicts/sections.
  const catalog = useMemo<Record<string, Manifest>>(() => {
    const merged: Record<string, Manifest> = { ...CATALOG };
    for (const m of doc.components) merged[m.type] = m;
    return merged;
  }, [doc.components]);
  // The CATALOG port lists by type (manifest order, name+dir only) — what the ✨ layout feeds `toLayoutDesign` so
  // every layout stage anchors at the handles this canvas actually renders (R5). Same as the web shell.
  const catalogPorts = useMemo<CatalogPorts>(
    () => Object.fromEntries(Object.entries(catalog).map(([t, m]) => [t, m.ports.map((p) => ({ name: p.name, dir: p.dir }))])),
    [catalog],
  );

  // The GUARANTEE view input — the built graph + solved value + declared
  // requirements, the SAME handles the shared presenter's guarantee view-models take. Only meaningful with a graph
  // and a solved value; when the design does not build, no guarantee section/problem is produced (honest silence).
  const guaranteeInput = useMemo<GuaranteeViewInput | null>(() => {
    if (!graph || !okEv) return null;
    return { graph, instances: doc.instances, wires: doc.wires, value: (id, k) => okEv.value(NodeId(id), k), catalog, slos: doc.guaranteeSlos };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, okEv, doc, catalog]);

  // Per-flow guarantee VERDICTS (the judged requirements) — computed once, shared by the Problems feed (violations)
  // and read alongside the summary sections. Empty when no requirement is declared (the no-filler rule keeps the
  // guarantee feature silent). The SAME `guaranteeVerdicts` the MCP `evaluate` + the design doc read — one truth.
  const gVerdicts = useMemo(
    () => (guaranteeInput && guaranteeInput.slos.length > 0 ? guaranteeVerdicts(guaranteeInput.graph, guaranteeInput.catalog, guaranteeInput.instances, guaranteeInput.wires, guaranteeInput.value, guaranteeInput.slos) : []),
    [guaranteeInput],
  );

  // Per-flow LAG verdicts, SCALAR pass — the async-inclusive propagation deadlines
  // judged live: a provable violation, or an honest `unknown` pointing at the sim (the queue wait is invisible to
  // the scalar). The SAME `lagVerdicts` the MCP `evaluate` reads (one truth); the DES-measured resolution is R3.
  const lagV = useMemo<LagVerdict[]>(
    () => {
      if (!(graph && okEv && doc.lagSlos.length > 0)) return [];
      // When a sim has run, RESOLVE each declared lag with the DES's async-inclusive measured mean (doc §3) — turning
      // the scalar `unknown` into a real ok/violation with `basis: 'measured'`, exactly as MCP `simulate` does. The
      // `pairLag` means are already in ms; absent ⇒ the scalar lower bound alone (provable violation / honest unknown).
      const lag = sim?.pairLag && sim.pairLag.length > 0
        ? (s: string, t: string): number | undefined => {
            const p = sim.pairLag!.find((x) => x.source === s && x.terminal === t);
            return p && Number.isFinite(p.mean) ? p.mean : undefined;
          }
        : undefined;
      return lagVerdicts(graph, (id, k) => okEv.value(NodeId(id), k), doc.lagSlos, queues, lag);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, okEv, doc, queues, sim],
  );

  // SYSTEM promises (owner ruling: cost is for THE WHOLE SYSTEM) — judged by the ONE shared content judge against
  // the whole-graph total (the exact sum Improve's system band constrains), so the native System tree, the web
  // panel, the MCP `evaluate` and the generated doc can never disagree. Empty when none declared (no-filler).
  const sysPromV = useMemo(
    () => systemPromiseVerdicts(doc.instances, doc.wires, okEv ? (id, k) => okEv.value(NodeId(id), k) : null, doc.systemPromises),
    [doc, okEv],
  );
  const wireProblems = useMemo<readonly WireProblem[]>(() => {
    const rows = problemRows(verds, ev.ok, ev.ok ? [] : ev.error).map((r) => {
      const label = r.key === 'build' ? '' : keyInfo(r.key).label;
      const value = Number.isNaN(r.value) ? '' : r.unit === 'ms' ? formatMs(r.value) : `${fmt(r.value)}${r.unit ? ` ${r.unit}` : ''}`;
      const head = [label, value].filter((s) => s !== '').join(' ');
      const message = r.fix ? (head ? `${head} — ${r.fix}` : r.fix) : head;
      return { severity: r.severity, node: r.node, key: r.key, message };
    });
    // GUARANTEE violations flow into the SAME Problems panel. A broken qualitative
    // promise is a real defect, anchored at its root-cause node, carrying the computed remediation (from R2 — swap +
    // ceiling + cost) as the fix text, or the honest reason none exists. Rides the existing WireProblem shape (the
    // frozen protocol is untouched): severity=violation, node=root cause, key=dimension, message = the verdict + fix.
    const gRows: WireProblem[] = gVerdicts
      .filter((v) => v.status === 'violation')
      .map((v) => {
        const fix = v.remediation?.action ?? v.noRemediationReason;
        const head = `${v.dimension} degraded to ${v.computed} on ${v.source} → ${v.terminal} (needs ≥ ${v.required})`;
        return { severity: 'violation' as const, node: v.rootCauseNode ?? '', key: v.dimension, message: fix ? `${head} — ${fix}` : head };
      });
    return [...rows, ...gRows];
  }, [verds, ev, gVerdicts]);

  // Independent request FLOWS = connected components of the wiring, each with its terminal (deepest sink).
  const flows = useMemo(() => requestFlows(doc.instances, doc.wires, valueOf), [doc, ev]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-node OWN monthly cost (the engine's value is CUMULATIVE; localContribution recovers each node's share).
  const localCost = useMemo<Record<string, number>>(() => {
    if (!okEv) return {};
    const own = localContribution((id, k) => okEv.value(NodeId(id), k), doc.instances, doc.wires, keys.cost);
    const m: Record<string, number> = {};
    for (const [id, v] of Object.entries(own)) if (v > 0.005) m[id] = v;
    return m;
  }, [doc, okEv]);
  const totalCost = useMemo(() => Object.values(localCost).reduce((s, c) => s + c, 0), [localCost]);
  // The full cost DEPTH (compute + egress + committed-pricing) — from the shared roll-up, the same figures the web
  // System panel's "Cost · breakdown" shows. The web computes nothing extra; neither do we (web-is-a-dumb-renderer).
  const costBreak = useMemo(() => (okEv ? systemSummary(doc.instances, doc.wires, (id, k) => okEv.value(NodeId(id), k)).cost : null), [doc, okEv]);

  const realLatByNode = useMemo<Map<string, number>>(() => (graph ? realCumulativeLatency(graph, valueOf, queues) : new Map()), [graph, queues]); // eslint-disable-line react-hooks/exhaustive-deps
  const respByNode = useMemo<Map<string, number>>(() => (graph ? responseLatency(graph, valueOf, queues) : new Map()), [graph, queues]); // eslint-disable-line react-hooks/exhaustive-deps

  // Nodes that ACTUALLY saturate (ρ≥1) — the timeout-causing truth, shown even with no SLO set.
  const saturated = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (const [id, q] of queues) { if (q.rho < 1) continue; m.set(id, valueOf(id, keys.overflow) ?? 0); }
    return m;
  }, [queues]); // eslint-disable-line react-hooks/exhaustive-deps

  const [sel, setSel] = useState<string | null>(null);

  // SINGLE-TRUTH LATENCY (owner decree): the canvas latency BAR per node — the MEASURED p50→p99 range (verdict-toned),
  // or absent when the DES has measured nothing (measured-or-nothing; no analytic fallback, no selection gate). SHARED
  // with the web canvas via the presenter so the two never drift; painted by the node renderer in the build below.
  const latBars = useMemo(
    () => new Map(doc.instances.flatMap((i) => { const m = measuredResponseOf(sim, i.id); return m ? [[i.id, latencyRangeBar(m, latencyTone(verds, i.id))] as const] : []; })),
    [doc.instances, sim, verds],
  );
  // The INLINE rename overlay (replaces window.prompt, which VS Code webviews BLOCK). A single absolutely-positioned
  // input floated over the node/group being renamed; `anchor` is its screen (client) top-left, `value` the current
  // display text. Opened from the context menu's Rename OR a double-click on the label — the familiar canvas gesture.
  const [rename, setRename] = useState<{ readonly kind: 'node' | 'group'; readonly id: string; readonly value: string; readonly anchor: { readonly x: number; readonly y: number } } | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [rfi, setRfi] = useState<ReactFlowInstance | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [fixMsg, setFixMsg] = useState<string | null>(null);
  const [undoNotice, setUndoNotice] = useState<string | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cvRef = useRef<HTMLElement>(null);
  const showUndoNotice = (text: string): void => {
    setUndoNotice(text);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndoNotice(null), 6000);
  };
  // A transient "Tidy?" offer after a picker insert whose new node landed ON another. It NEVER
  // auto-reflows — it just offers the single Tidy pipeline one click away. Auto-dismisses, same cadence as undo.
  const [tidyOffer, setTidyOffer] = useState(false);
  const tidyOfferTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showTidyOffer = (): void => {
    setTidyOffer(true);
    if (tidyOfferTimer.current) clearTimeout(tidyOfferTimer.current);
    tidyOfferTimer.current = setTimeout(() => setTidyOffer(false), 6000);
  };

  // THE IDEAL LAYOUT — the web shell's ✨ pipeline run HERE, in the
  // canvas, because only the canvas knows its MEASURED node footprints (webview/ideal-layout.ts names the root
  // cause: the retired host-side command laid out from DEFAULT heights and drew broken lines). `polishPhase` drives
  // the "✨ Polishing…" HUD hint; `morphing` toggles the CSS transition during the polish apply; the polisher is
  // held in a ref so a fresh click supersedes an in-flight polish (latest-wins).
  const [polishPhase, setPolishPhase] = useState<PolishPhase>('idle');
  const [morphing, setMorphing] = useState(false);
  const polisherRef = useRef<Polisher | null>(null);
  const morphTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // ASSIGNED PORT POSITIONS (R5, the port slide — presenter `assignPortOffsets` via the Tidy pipeline's seam):
  // node id → `${side}:${port}` → px from the node's top. Set at BOTH stages (floor AND polish). VIEW state, not
  // document data; the SAME map feeds the node renderer's handles and the router's anchors below (one home — drift
  // impossible). Same as the web shell.
  const [portOffsets, setPortOffsets] = useState<PortOffsets | null>(null);
  // Nodes the architect DRAGGED this session — the honest pin signal (§5.3): the Tidy pipeline holds these where the
  // human put them and lays out only AROUND them (a reload starts a fresh session with no pins). This is the
  // SESSION-drag signal, not a divergence heuristic, so an imported/authored layout is never spuriously frozen.
  const handMovedRef = useRef<Set<string>>(new Set());

  // Keep the design fitted as the canvas resizes (the webview IS the whole editor pane now).
  useEffect(() => {
    const el = cvRef.current;
    if (el === null || rfi === null) return;
    let t: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => rfi.fitView({ padding: 0.22 }), 200); });
    ro.observe(el);
    return () => { clearTimeout(t); ro.disconnect(); };
  }, [rfi]);

  const candidates = useMemo(() => buildCandidates(catalog), [catalog]);
  const prettify = (type: string): string => { const s = type.split('.').pop() ?? type; return s.charAt(0).toUpperCase() + s.slice(1); };
  const labelOf = (id: string, type: string): string => doc.labels[id] ?? prettify(type);
  const typeOf = (id: string): string => doc.instances.find((x) => x.id === id)?.type ?? '';
  const manifestOf = (id: string): Manifest | undefined => catalog[typeOf(id)];
  const descOf = (id: string): string => doc.descriptions[id] ?? '';

  // The canvas's MEASURED node footprints (tall meter/chip nodes) — the ONE source Tidy, the smart router, the
  // overlap offer and the ✨ ideal search all read, so every geometry consumer scores what actually ships. A
  // just-inserted (unmeasured) node is simply absent; each consumer falls back to its own footprint default.
  const measuredSizes = (): Record<string, { w: number; h: number }> => {
    const sizes: Record<string, { w: number; h: number }> = {};
    for (const n of nodes) {
      const w = n.measured?.width ?? n.width;
      const h = n.measured?.height ?? n.height;
      if (typeof w === 'number' && typeof h === 'number') sizes[n.id] = { w, h };
    }
    return sizes;
  };

  // Build the React Flow nodes/edges from the document + evaluation — one effect, identical to the web shell.
  useEffect(() => {
    const groupOf: Record<string, Group> = {};
    for (const g of doc.groups) for (const m of g.members) groupOf[m] = g;

    // Which (node, port) pairs are WIRED — so the renderer shows the inline "+" only on OPEN ports.
    const wiredPorts = new Set<string>();
    for (const w of doc.wires) { wiredPorts.add(`${w.from[0]} ${w.from[1]}`); wiredPorts.add(`${w.to[0]} ${w.to[1]}`); }

    const groupNodes: Node[] = doc.groups.map((g) => ({
      id: g.id, type: 'group', position: { x: g.rect.x, y: g.rect.y }, selected: g.id === sel,
      data: { label: g.label }, style: { width: g.rect.w, height: g.rect.h },
    }));

    const compNodes: Node[] = doc.instances.map((inst) => {
      const kind = facetsOf(inst.type).kind;
      const st = statusOf(inst.id);
      const tp = valueOf(inst.id, keys.throughput);
      const sat = saturated.get(inst.id);
      const q = queues.get(inst.id);
      const chips: { t: string; k: Tone }[] = [];
      // RPS — ONE FORM (the rate row): the SAME shared presenter builder as the web shell (anti-drift). A
      // capacity-bearing tier carries capacity+ρ (the utilisation fill); a capacity-less tier (a source / origin, a
      // pure-delay hop) carries the rate alone, verdict-toned — never a separate rps chip.
      const load: NodeLoad | undefined = rateRow(q, tp, st, peakByNode?.get(inst.id));
      // '⊞ tasks' — the units the node's generation scaled to at its HIGHEST point: the WORST-window requiredUnits when
      // this node has a shaped generator (peakByNode carries it, coherent with the peak ρ the rate row shows), else the
      // steady requiredUnits (no shape ⇒ peakByNode absent ⇒ worstCaseUnits returns it verbatim — byte-identical).
      const units = worstCaseUnits(valueOf(inst.id, keys.requiredUnits), peakByNode?.get(inst.id));
      if (units !== undefined && units > 0) chips.push({ t: `⊞ ${Math.ceil(units)} tasks`, k: '' });
      const cst = localCost[inst.id];
      if (cst !== undefined) chips.push({ t: `$${fmt(cst)}/mo`, k: '' });
      if (sat !== undefined) chips.push({ t: `⚠ overloaded · ${fmt(sat)} rps dropped`, k: 'bad' });
      const abs = doc.layout[inst.id] ?? { x: 0, y: 0 };
      const g = groupOf[inst.id];
      const position = g ? { x: abs.x - g.rect.x, y: abs.y - g.rect.y } : abs;
      const ports = (catalog[inst.type]?.ports ?? []).map((p) => ({ ...p, wired: wiredPorts.has(`${inst.id} ${p.name}`) }));
      const latBar = latBars.get(inst.id);
      // The ASSIGNED port positions for this node (R5, the port slide) — handles render at these px offsets and
      // the router below anchors from the SAME map, so wire and handle land on one row. Absent ⇒ fractions.
      const offs = portOffsets?.[inst.id];
      // The "!" flag lights on a violation or a saturated tier. WORST-CASE LOAD (owner ruling): a node saturated at
      // its declared peak now carries an ordinary saturation violation in `verds`, so `st === 'violation'` already
      // covers it — a node calm at the mean but over capacity at its worst window never reads green (one truth).
      const flag = st === 'violation' || sat !== undefined;
      const base: Node = { id: inst.id, type: 'sda', position, selected: inst.id === sel, data: { name: labelOf(inst.id, inst.type), desc: descOf(inst.id), id: inst.id, ty: inst.type, kind, chips, flag, ports, onPortAdd, ...(offs !== undefined ? { portOffsets: offs } : {}), ...(load ? { load } : {}), ...(latBar ? { lat: latBar } : {}) } };
      // parentId makes the child position group-relative; NO `extent: 'parent'` — RF's clampPositionToParent (which
      // that triggers) reads the parent group's measured size and CRASHES when the group isn't measured yet (fresh
      // after Tidy), which aborts this child's handle re-measure and leaves its edges anchored off the port. Group
      // membership is owned by onNodeDragStop (assignGroup / detach), not RF's hard extent clamp.
      return g ? { ...base, parentId: g.id } : base;
    });

    // R2 — the SAME shared presenter drives the rate + transform PILLS as the web shell (anti-drift). A pill click
    // in the webview does NOT open a form: per the native-first doctrine it posts the existing `select` (via setSel →
    // postSelection) so the NATIVE Selected-Node tree reveals that node's Ports section, where the edit is native.
    const rates: EdgeRate[] = edgeRates({ instances: doc.instances, wires: doc.wires, catalog, value: okEv ? valueOf : null });
    const onTransformClick = (_wire: number, node: string): void => { setSel(node); };
    // SMART EDGE ROUTING (edge-routing.ts) — the SAME presenter router the web shell uses, so a wire routes around
    // node + group boxes identically in both shells (anti-drift). Uses the canvas's measured node sizes.
    const routeSizes = measuredSizes();
    const routeNodes = doc.instances.flatMap((inst) => {
      const at = doc.layout[inst.id];
      if (at === undefined) return [];
      const sz = routeSizes[inst.id] ?? { w: 160, h: 170 };
      const offs = portOffsets?.[inst.id]; // the SAME assigned offsets the handles render at (one home)
      return [{ id: inst.id, box: { x: at.x, y: at.y, w: sz.w, h: sz.h }, ports: (catalog[inst.type]?.ports ?? []).map((p) => ({ name: p.name, dir: p.dir })), ...(offs !== undefined ? { portOffsets: offs } : {}) }];
    });
    const routes: Map<number, RoutedWire> = routeDesignEdges({
      nodes: routeNodes,
      wires: doc.wires,
      groups: doc.groups.map((g) => ({ id: g.id, rect: g.rect, members: g.members })),
    });
    const flowEdges = doc.wires.map((w, i) => ({
      id: `w${i}`, source: w.from[0], target: w.to[0], sourceHandle: w.from[1], targetHandle: w.to[1], type: 'flow',
      data: {
        status: statusOf(w.to[0]), rate: valueOf(w.to[0], keys.throughput), latency: respByNode.get(w.to[0]),
        saturated: saturated.has(w.to[0]), from: w.from, to: w.to, semantics: w.semantics ?? 'sync',
        wire: i, pills: rates[i]?.pills ?? [], carried: rates[i]?.carried, onTransformClick,
        ...(routes.get(i) ? { route: routes.get(i) } : {}),
      },
    }));
    setNodes([...groupNodes, ...compNodes]);
    setEdges(flowEdges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, ev, sel, localCost, queues, latBars, portOffsets, peakByNode]);

  // The QUICK-ADD picker ("canvas smoothness"): open the native QuickPick with the shared, legality-filtered
  // options (`pickerOptions` — the ONE contract both shells use so they can never offer different components), and on
  // a non-null pick place + wire the component via `addPickedComponent`. A dismissal (null) or superseded pick is a
  // no-op. `context` is the SOURCE port a wire was dragged from (drop-to-pick); undefined = whole-catalog add (empty
  // canvas CTA / N key). `pos` is where the node lands (flow-space). Selects the new node, mirroring every other add.
  const openPicker = async (
    options: readonly PickerOption[],
    placeholder: string,
    pos: { readonly x: number; readonly y: number },
    context?: { readonly node: string; readonly port: string },
  ): Promise<void> => {
    const picked = await bridge.pick(options.map((o) => ({ type: o.type, kind: o.kind })), placeholder);
    if (picked === null) return; // dismissed or superseded — honest no-op
    const r = addPickedComponent(studio, catalog, picked, { x: Math.round(pos.x), y: Math.round(pos.y) }, context);
    if (!r.ok) { setFixMsg(r.error); return; }
    setSel(r.id);
    offerTidyIfOverlapping(r.id);
  };
  // Open the CONTEXT-FREE picker (whole catalogue) at a flow-space point — the empty-canvas CTA and the N key.
  const openCatalogPicker = (pos: { readonly x: number; readonly y: number }): void => {
    void openPicker(pickerOptions(studio, catalog), 'Add a component', pos);
  };
  // The inline "+" on an OPEN port: open the SAME native pick as drop-to-pick for that port, placing the
  // new node to the RIGHT of the source (out port) / LEFT (in port) at the tidy column pitch (~340), source's y.
  const onPortAdd = (nodeId: string, port: string, dir: 'out' | 'in'): void => {
    const base = doc.layout[nodeId] ?? { x: 200, y: 160 };
    const pos = { x: base.x + (dir === 'out' ? 340 : -340), y: base.y };
    const label = doc.labels[nodeId] ?? prettify(typeOf(nodeId));
    void openPicker(pickerOptions(studio, catalog, { node: nodeId, port }), `Add a component that fits ${label}.${port}…`, pos, { node: nodeId, port });
  };
  // After a picker-driven insert, offer "Tidy?" if the NEW node's box intersects any other. Reads the
  // authoritative positions from the just-committed document and the MEASURED sizes from the current canvas nodes,
  // falling back to the layout footprint for the brand-new (unmeasured) node. Pure predicate, no reflow.
  const offerTidyIfOverlapping = (newId: string): void => {
    const project = studio.project();
    const measured = measuredSizes();
    const boxes: Record<string, Box> = {};
    for (const inst of project.instances) {
      const p = project.layout[inst.id] ?? { x: 0, y: 0 };
      const s = measured[inst.id] ?? FALLBACK_NODE;
      boxes[inst.id] = { x: p.x, y: p.y, w: s.w, h: s.h };
    }
    if (insertOverlaps(boxes, newId)) showTidyOffer();
  };

  // Connect legality + refusal reason (protocol mismatch), copied from the web shell — EXTENDED for drop-to-pick:
  // `onConnectStart` also remembers WHICH port the wire started from, so a drop on empty canvas can open the
  // legality-filtered picker for that port (the n8n "add node on edge drop" pattern) instead of only refusing.
  const connectMade = useRef(false);
  const connectFromProtocols = useRef<string[] | null>(null);
  const connectFrom = useRef<{ node: string; port: string } | null>(null);
  const onConnect = (c: Connection) => {
    connectMade.current = true;
    if (c.source && c.target) studio.dispatch({ kind: 'connect', from: [c.source, c.sourceHandle ?? 'out'], to: [c.target, c.targetHandle ?? 'in'] });
  };
  const onConnectStart = (_: unknown, p: { nodeId: string | null; handleId: string | null; handleType: 'source' | 'target' | null }): void => {
    connectMade.current = false;
    const man = p.nodeId ? manifestOf(p.nodeId) : undefined;
    const port = man?.ports.find((pp) => pp.name === p.handleId);
    connectFromProtocols.current = port && (port.dir === 'out' || port.dir === 'bi') ? [...(port.speaks ?? [])] : [];
    connectFrom.current = p.nodeId && p.handleId ? { node: p.nodeId, port: p.handleId } : null;
  };
  // React Flow fires this for EVERY drag end. `connectionState.toNode === null` ⇒ dropped on the empty PANE → open
  // the drop-to-pick picker (filtered to what legally attaches to the source port). Dropped ON a node/port but no
  // connection made ⇒ an incompatible target → keep the honest refusal toast (unchanged behaviour).
  const onConnectEnd = (event: MouseEvent | TouchEvent, connectionState: { toNode: unknown }): void => {
    const spoken = connectFromProtocols.current;
    const from = connectFrom.current;
    connectFromProtocols.current = null;
    connectFrom.current = null;
    if (connectMade.current) return; // a valid connection was made — nothing to do

    const onPane = connectionState.toNode === null; // no node under the pointer at release
    if (onPane && from && rfi) {
      const client = 'clientX' in event ? { x: event.clientX, y: event.clientY } : { x: event.touches[0]?.clientX ?? 0, y: event.touches[0]?.clientY ?? 0 };
      const pos = rfi.screenToFlowPosition(client);
      const label = doc.labels[from.node] ?? prettify(typeOf(from.node));
      const options = pickerOptions(studio, catalog, { node: from.node, port: from.port });
      void openPicker(options, `Add a component that fits ${label}.${from.port}…`, pos, from);
      return;
    }
    if (spoken === null) return; // not a port drag at all
    const detail = spoken.length ? ` This port speaks ${spoken.join(', ')}.` : '';
    setFixMsg(`Connection refused — those ports speak incompatible protocols.${detail} Hover a port to see what it accepts.`);
  };

  const onNodesDelete = (deleted: Node[]) => {
    for (const n of deleted) studio.dispatch(n.type === 'group' ? { kind: 'removeGroup', id: n.id } : { kind: 'removeNode', id: n.id });
    if (deleted.some((n) => n.id === sel)) setSel(null);
    const first = deleted[0];
    const label = first ? (first.type === 'group' ? 'group' : labelOf(first.id, typeOf(first.id))) : 'item';
    showUndoNotice(deleted.length === 1 ? `Deleted "${label}"` : `Deleted ${deleted.length} items`);
  };
  const onEdgesDelete = (deleted: Edge[]) => {
    for (const e of deleted) {
      const d = e.data as { from?: readonly [string, string]; to?: readonly [string, string] } | undefined;
      if (d?.from && d?.to) studio.dispatch({ kind: 'disconnect', from: d.from, to: d.to });
    }
  };
  const onReconnect = (oldEdge: Edge, c: Connection) => {
    if (!c.source || !c.target) return;
    const d = oldEdge.data as { from?: readonly [string, string]; to?: readonly [string, string] } | undefined;
    if (d?.from && d?.to) studio.dispatch({ kind: 'disconnect', from: d.from, to: d.to });
    studio.dispatch({ kind: 'connect', from: [c.source, c.sourceHandle ?? 'out'], to: [c.target, c.targetHandle ?? 'in'] });
  };

  const onNodeDragStop = (_: unknown, n: Node) => {
    if (n.type === 'group') { studio.dispatch({ kind: 'moveGroup', id: n.id, x: n.position.x, y: n.position.y }); return; }
    const parent = n.parentId ? doc.groups.find((g) => g.id === n.parentId) : undefined;
    const abs = parent ? { x: n.position.x + parent.rect.x, y: n.position.y + parent.rect.y } : { x: n.position.x, y: n.position.y };
    studio.dispatch({ kind: 'move', id: n.id, x: abs.x, y: abs.y });
    handMovedRef.current.add(n.id); // a deliberate hand-placement — Ideal layout will hold it as a pin (§5.3)
    if (!parent) {
      const cx = abs.x + 80, cy = abs.y + 36;
      const into = doc.groups.find((g) => cx >= g.rect.x && cx <= g.rect.x + g.rect.w && cy >= g.rect.y && cy <= g.rect.y + g.rect.h);
      if (into) studio.dispatch({ kind: 'assignGroup', node: n.id, group: into.id });
    }
  };

  // id minting — reused for palette adds, suggestions, duplicates and host-driven `addComponent`.
  const mintId = (kind: string): string => {
    const used = new Set(doc.instances.map((i) => i.id));
    let n = 1;
    while (used.has(`${kind}${n}`)) n += 1;
    return `${kind}${n}`;
  };
  const mintGroupId = (): string => {
    const used = new Set(doc.groups.map((g) => g.id));
    let n = 1;
    while (used.has(`group${n}`)) n += 1;
    return `group${n}`;
  };
  // Place a new component at a sensible free spot — the same staggered fan-out the web palette uses, so a native
  // palette pick lands somewhere visible rather than stacked on the origin. Selects it (mirrors the web shell).
  const addComp = (type: string): void => {
    if (!catalog[type]) { setFixMsg(`Unknown component "${type}".`); return; }
    const id = mintId(facetsOf(type).kind);
    studio.dispatch({ kind: 'addComponent', id, type, x: 160 + (doc.instances.length % 4) * 60, y: 130 + (doc.instances.length % 5) * 60 });
    setSel(id);
  };
  // Read the dropped component TYPE id from a drag. Two sources land here as ordinary HTML5 drops:
  //   • the NATIVE Components tree (ComponentsDragController) — the type id under our custom `application/x-sda-component`;
  //   • the web shell's own palette (unused in the webview today, kept for parity) — under `application/sda`.
  // FALLBACK: if only the built-in tree mime is present, VS Code may expose its handle-list JSON there — but that
  // carries opaque handles, not our type, so it cannot yield a placeable id. We rely on the custom mime, which the
  // controller always sets, and return undefined otherwise (an honest no-op rather than a guessed placement).
  const dropType = (dt: DataTransfer): string | undefined => parseDropType((mime) => dt.getData(mime));
  const onDrop = (e: RDragEvent) => {
    e.preventDefault();
    const type = dropType(e.dataTransfer);
    if (!type || !rfi) return;
    if (!catalog[type]) { setFixMsg(`Unknown component "${type}".`); return; }
    const p = rfi.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    // Place via the SHARED presenter path (the same one the quick-add picker uses), so a dropped node is minted +
    // added identically to every other add — one atomic, undoable change. No wire context on a bare palette drop.
    const r = addPickedComponent(studio, catalog, type, { x: Math.round(p.x), y: Math.round(p.y) });
    if (!r.ok) { setFixMsg(r.error); return; }
    const into = doc.groups.find((g) => p.x >= g.rect.x && p.x <= g.rect.x + g.rect.w && p.y >= g.rect.y && p.y <= g.rect.y + g.rect.h);
    if (into) studio.dispatch({ kind: 'assignGroup', node: r.id, group: into.id });
    setSel(r.id);
    offerTidyIfOverlapping(r.id);
  };

  // Engine-backed "propose the next logical element" for the selected node's open ports — reused to build the
  // `nodeDetail.suggestions` feed AND to replicate a native suggester accept (`wireSuggestion`).
  const suggestions = useMemo(() => (sel ? suggestFor(studio, catalog, candidates, sel) : []), [doc, sel, studio, catalog, candidates]);
  // Add `type` and auto-wire it to the selected node's open port `s` — the exact web-shell suggester accept, as
  // ONE undoable action. Shared by the (host-driven) wireSuggestion action.
  const addSuggestion = (nodeId: string, s: Suggestion, type: string): void => {
    const target = matchingPort(catalog, type, s);
    if (!target) { setFixMsg(`"${type}" has no port that fits ${nodeId}.${s.port}.`); return; }
    const id = mintId(facetsOf(type).kind);
    const base = doc.layout[nodeId] ?? { x: 280, y: 240 };
    const downstream = s.dir === 'out' || s.dir === 'bi';
    const connect = downstream
      ? { kind: 'connect' as const, from: [nodeId, s.port] as [string, string], to: [id, target] as [string, string] }
      : { kind: 'connect' as const, from: [id, target] as [string, string], to: [nodeId, s.port] as [string, string] };
    studio.dispatchBatch([{ kind: 'addComponent', id, type, x: base.x + (downstream ? 260 : -260), y: base.y + 130 }, connect]);
    setSel(id);
  };

  const selInst = sel ? doc.instances.find((i) => i.id === sel) : undefined;

  const addGroup = () => {
    const id = mintGroupId();
    if (selInst) {
      const p = doc.layout[selInst.id] ?? { x: 200, y: 160 };
      studio.dispatch({ kind: 'addGroup', id, label: 'New group', x: p.x - 40, y: p.y - 70, w: 260, h: 220 });
      studio.dispatch({ kind: 'assignGroup', node: selInst.id, group: id });
    } else {
      studio.dispatch({ kind: 'addGroup', id, label: 'New group', x: 120, y: 110, w: 360, h: 260 });
    }
    setSel(id);
  };

  // The background scheduler (doc §3.6): run ONE search slice per animation frame so the polisher never blocks the
  // canvas (idle = zero — the loop stops the instant the search rests or is superseded). Same as the web shell.
  const rafSchedule: PolishScheduler = (step) => {
    let raf = 0;
    let stopped = false;
    const tick = (): void => {
      if (stopped) return;
      if (step()) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  };
  // '✨ Ideal layout': Tidy instantly (the floor), then polish in the background and morph to
  // the better layout — the WEB SHELL'S OWN pipeline (ideal-layout.ts), fed the MEASURED node footprints. Each
  // stage lands as ONE Studio batch → one docChanged → one host WorkspaceEdit → one NATIVE undo step. Hand-placed
  // nodes (dragged this session) are held as pins; seeded ⇒ same design → same layout (§5.2). A fresh click
  // supersedes an in-flight polish (latest-wins).
  const idealLayout = (): void => {
    polisherRef.current?.cancel();
    polisherRef.current = startIdealLayout(
      { instances: doc.instances, wires: doc.wires, groups: doc.groups, layout: studio.project().layout, sizes: measuredSizes(), catalogPorts, handMoved: handMovedRef.current },
      {
        schedule: rafSchedule,
        onPhase: setPolishPhase,
        currentLayout: () => studio.project().layout,
        setPortOffsets, // the slide lands as VIEW state — handles + router read the one map (R5)
        apply: (stage, cmds) => {
          // The polish apply gets the smooth position MORPH (flip the transition class on, batch, ease off) —
          // the floor is instant, exactly like the web shell.
          if (stage === 'polish') {
            setMorphing(true);
            if (morphTimer.current !== undefined) clearTimeout(morphTimer.current);
            morphTimer.current = setTimeout(() => setMorphing(false), 520);
          }
          studio.dispatchBatch(cmds);
        },
        fitView: (stage) => setTimeout(() => rfi?.fitView({ padding: 0.15, duration: stage === 'floor' ? 400 : 420 }), stage === 'floor' ? 60 : 40),
      },
    );
  };
  useEffect(() => () => polisherRef.current?.cancel(), []); // idle = zero: stop any polish on unmount

  // Context menu (node / edge / group / pane).
  const closeMenu = () => setMenu(null);
  const onNodeCtx = (e: RMouseEvent, n: Node) => { e.preventDefault(); setSel(n.id); setMenu({ x: e.clientX, y: e.clientY, kind: n.type === 'group' ? 'group' : 'node', id: n.id }); };
  // Double-click a node/group opens the SAME inline rename as the context menu — the familiar canvas gesture. Close
  // any open menu first so the overlay is the only floating surface.
  const onNodeDblClick = (_: RMouseEvent, n: Node) => { closeMenu(); setSel(n.id); beginRename(n.type === 'group' ? 'group' : 'node', n.id); };
  const onEdgeCtx = (e: RMouseEvent, ed: Edge) => {
    e.preventDefault();
    const d = ed.data as { from?: readonly [string, string]; to?: readonly [string, string]; semantics?: 'sync' | 'async' } | undefined;
    setMenu({ x: e.clientX, y: e.clientY, kind: 'edge', semantics: d?.semantics ?? 'sync', ...(d?.from ? { from: d.from } : {}), ...(d?.to ? { to: d.to } : {}) });
  };
  const onPaneCtx = (e: RMouseEvent | MouseEvent) => {
    e.preventDefault();
    const flow = rfi ? rfi.screenToFlowPosition({ x: e.clientX, y: e.clientY }) : { x: 0, y: 0 };
    setMenu({ x: e.clientX, y: e.clientY, kind: 'pane', flow });
  };
  // The flow-space centre of the visible canvas — where the N key and the empty-canvas CTA drop a new node so it
  // lands in view regardless of pan/zoom (converts the DOM element's centre through the current viewport).
  const viewportCenter = (): { x: number; y: number } => {
    const el = cvRef.current;
    if (!el || !rfi) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return rfi.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  };
  const ctxDuplicate = (id: string) => { const inst = doc.instances.find((i) => i.id === id); if (!inst) return; const nid = mintId(facetsOf(inst.type).kind); studio.dispatch({ kind: 'duplicateNode', id, newId: nid, dx: 40, dy: 40 }); setSel(nid); };
  const ctxWrap = (id: string) => { const gid = mintGroupId(); const p = doc.layout[id] ?? { x: 200, y: 160 }; studio.dispatch({ kind: 'addGroup', id: gid, label: 'New group', x: p.x - 40, y: p.y - 70, w: 280, h: 220 }); studio.dispatch({ kind: 'assignGroup', node: id, group: gid }); setSel(gid); };
  // Open the INLINE rename over a node or group. window.prompt is a no-op inside a VS Code webview, so the canvas
  // edits the label in place: an input floated at the element's on-screen top-left (via flowToScreenPosition — the
  // exact inverse of the drop mapping), pre-filled with the current display text. The GROUP path reads its label
  // from the document; the NODE path reads the friendly label (falling back to the prettified type). Absent element
  // ⇒ nothing to rename (honest no-op).
  const beginRename = (kind: 'node' | 'group', id: string): void => {
    if (!rfi) return;
    if (kind === 'group') {
      const g = doc.groups.find((x) => x.id === id);
      if (!g) return;
      const anchor = rfi.flowToScreenPosition({ x: g.rect.x, y: g.rect.y });
      setRename({ kind, id, value: g.label, anchor });
      return;
    }
    const inst = doc.instances.find((i) => i.id === id);
    if (!inst) return;
    const p = doc.layout[id] ?? { x: 0, y: 0 };
    const anchor = rfi.flowToScreenPosition({ x: p.x, y: p.y });
    setRename({ kind, id, value: labelOf(id, inst.type), anchor });
  };
  // Commit the inline edit. A NODE's display name is `setLabel` (the id stays the stable identifier); a GROUP's is
  // `renameGroup`. Empty/whitespace commits are dropped (no destructive blank rename) — for a node an empty label
  // would clear the override, which we treat as "no change" here to match the old prompt's guard. Always closes.
  const commitRename = (text: string): void => {
    const cur = rename;
    setRename(null);
    if (!cur) return;
    const next = text.trim();
    if (next === '') return;
    if (cur.kind === 'group') studio.dispatch({ kind: 'renameGroup', id: cur.id, label: next });
    else studio.dispatch({ kind: 'setLabel', id: cur.id, label: next });
  };

  // Block illegal drags at connect time (protocol-compatible producer→consumer).
  const isValidConnection = (c: Connection | Edge): boolean => {
    if (!c.source || !c.target || c.source === c.target) return false;
    const sm = manifestOf(c.source);
    const tm = manifestOf(c.target);
    const sp = sm?.ports.find((p) => p.name === c.sourceHandle);
    const tp = tm?.ports.find((p) => p.name === c.targetHandle);
    if (!sp || !tp) return true;
    if (!(sp.dir === 'out' || sp.dir === 'bi') || !(tp.dir === 'in' || tp.dir === 'bi')) return false;
    return portsConnect(sp.speaks ?? [], tp.accepts ?? [], protocolCompat);
  };

  // The Markdown design doc — generated FROM the verified model by the SAME content function the web shell and the
  // AI use. Posted to the host (which owns file writing / preview) rather than downloaded in-page.
  const buildDesignDoc = (): { markdown: string; title: string } | null => {
    if (!okEv) return null;
    const groups: DocGroup[] = doc.groups.map((g) => ({ id: g.id, label: g.label, members: g.members }));
    const md = generateDesignDoc({
      name: doc.name,
      instances: doc.instances,
      wires: doc.wires,
      groups,
      labels: doc.labels,
      descriptions: doc.descriptions,
      // The merged catalog (built-ins + project-scoped custom) unlocks the v2 assumptions register + risks
      // (provenance is derived against the catalog); the layout carries positions into the architecture view.
      catalog,
      layout: doc.layout,
      verdicts: verds,
      value: (id, k) => okEv.value(NodeId(id), k),
      realLatencyByNode: graph ? Object.fromEntries(realLatByNode) : undefined,
      responseLatencyByNode: graph ? Object.fromEntries(respByNode) : undefined,
      saturated: [...saturated.keys()],
      tail: sim ? { p50: sim.p50, p95: sim.p95, p99: sim.p99 } : undefined,
      // The retry outcome so §4 reports goodput vs offered when a policy is live.
      retry: sim && sim.goodputRps !== undefined && sim.errorRate !== undefined && sim.amplification !== undefined && (sim.retryPolicy || sim.amplification > 1 || sim.errorRate > 0)
        ? { goodputRps: sim.goodputRps, errorRate: sim.errorRate, amplification: sim.amplification }
        : undefined,
      // Per-node SIMULATED response percentiles from the ambient DES —
      // so the written doc prints measured p50/p95/p99 per requirement-bearing node, matching the web shell. Absent
      // sim ⇒ omitted (no-filler); the renderer shows only requirement-bearing nodes.
      responsePercentilesByNode: sim?.nodeResponse ? Object.fromEntries(sim.nodeResponse.map((n) => [n.id, { mean: n.mean, p50: n.p50, p95: n.p95, p99: n.p99, samples: n.samples }])) : undefined,
      // Per-flow LAG verdicts — the async-inclusive deadlines, judged by the scalar
      // pass (the same `lagV` the System panel shows). Empty ⇒ the §5 propagation-lag block is omitted (no-filler).
      lagVerdicts: lagV.length > 0 ? lagV.map(lagVerdictRow) : undefined,
      // The scenario-comparison section (assumption-model doc §8) — the ALREADY-computed ambient all-world evaluation
      // (envW.worlds) + the declarations. Only the base world ⇒ the section is omitted (no-filler). Same as the web shell.
      worlds: envW.worlds ? { result: envW.worlds, scenarios: doc.scenarios } : undefined,
    });
    return { markdown: md, title: `${doc.name || 'design'}.design-doc.md` };
  };

  // The headline STATUS for the native status bar — computed the way the web shell computes its footer: sink
  // throughput, the MEASURED tail latency (single-truth), the whole-design cost, and the violation count.
  const sinkId = doc.instances.find((i) => (i.bands?.length ?? 0) > 0)?.id ?? doc.instances.at(-1)?.id;
  // Whether ANY node drives the design (a client OR a node with assumedRps > 0) — keeps the status computation
  // consistent with the presenter's tail reason (the native status bar renders the WireStatus subset; the System
  // tree's tail section already shows the "no traffic origin" reason via the shared summarySections).
  const designHasOrigin = okEv ? hasTrafficOrigin(doc.instances, doc.wires, (id, k) => okEv.value(NodeId(id), k)) : true;
  const wireStatus = useMemo<WireStatus>(
    // SINGLE-TRUTH LATENCY (owner decree): the status bar's latency is the MEASURED tail (the DES p50), omitted until a
    // sim measures it — never the analytic scalar.
    () => statusLine(sinkId ? valueOf(sinkId, keys.throughput) : undefined, sim ? sim.p50 : undefined, totalCost, verds, ev.ok, ev.ok ? 0 : ev.error.length, designHasOrigin),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sinkId, sim, totalCost, verds, ev, designHasOrigin],
  );

  // ── The native-view FEEDS ────────────────────────────────────────────────────────────────────────────────────
  // The System tree (native): mirrors the web shell's System tab exactly. A "Design" section (counts), one section
  // PER FLOW (systemSummary figures — throughput / MEASURED latency / availability / cost, pre-formatted), a
  // simulated-tail section, a per-tier load (ρ) section, and the cost breakdown. Pure projection.
  const summarySections = useMemo<readonly SummarySection[]>(
    () => {
      const base = presenterSummarySections({
        instances: doc.instances,
        wires: doc.wires,
        value: okEv ? (id, k) => okEv.value(NodeId(id), k) : null,
        flows,
        queues,
        saturated,
        totalCost,
        costBreak,
        verdicts: verds,
        evalOk: ev.ok,
        evalErrorCount: ev.ok ? 0 : ev.error.length,
        sim,
        lag: lagV,
        systemPromises: sysPromV,
        labelOf,
        typeOf,
        ...(peakByNode ? { peakByNode } : {}),
      });
      // Append the per-flow GUARANTEE sections — one section per flow with a
      // qualitative promise or a declared requirement, toned by verdict, the root cause named. Empty (no requirement,
      // no degradation) ⇒ no section (no-filler). `rootCauseNode` is dropped here (SummaryRow carries no id field —
      // the protocol is frozen); the row TEXT names the node in parentheses, which the System tree shows verbatim.
      const gSections: SummarySection[] = guaranteeInput
        ? guaranteeSummarySections(guaranteeInput).map((s) => ({ title: s.title, rows: s.rows.map((r) => ({ label: r.label, value: r.value, ...(r.tone !== undefined ? { tone: r.tone } : {}) })) }))
        : [];
      // AMBIENT UNCERTAINTY — the Monte-Carlo distribution block, from the SHARED presenter (identical to
      // the web System panel), mapped to the frozen protocol's SummarySection (SummaryRow reused, protocol untouched —
      // the R3 pattern). Present only when a range is declared AND a run exists (no-filler); the state tag carries
      // the resting handshake (fp32 preview vs fp64 confirmed). The native System tree renders it verbatim.
      const uSection = unc ? uncertaintySection({ result: unc.result, state: unc.state, ...(unc.backend ? { backend: unc.backend } : {}), ...(unc.elapsedMs !== undefined ? { elapsedMs: unc.elapsedMs } : {}) }, (id) => labelOf(id, typeOf(id))) : null;
      const uSections: SummarySection[] = uSection ? [{ title: uSection.title, rows: uSection.rows.map((r) => ({ label: r.label, value: r.value, ...(r.tone !== undefined ? { tone: r.tone } : {}) })) }] : [];
      // AMBIENT TWO-TIER TRANSIENT — the ρ-envelope + worst window + survival verdict, from the
      // SHARED presenter (identical to the web System panel), mapped onto the frozen protocol's SummarySection
      // (SummaryRow reused; protocol untouched). Present only when a generator declares cycles (no-filler).
      const tSection = twoTier ? twoTierSection(twoTier, (id) => labelOf(id, typeOf(id))) : null;
      const tSections: SummarySection[] = tSection ? [{ title: tSection.title, rows: tSection.rows.map((r) => ({ label: r.label, value: r.value, ...(r.tone !== undefined ? { tone: r.tone } : {}) })) }] : [];
      // ASSUMPTION MODEL — the envelope-by-default headline and the worlds matrix,
      // from the SHARED presenter (identical to the web System panel), mapped onto the frozen protocol's
      // SummarySection (SummaryRow reused; protocol untouched). The envelope is the DEFAULT answer (shows even on a
      // demand-less design — the guided-emptiness fix); the matrix carries the ACTIVE-lens tag in its title.
      const mapSection = (s: SummarySection | null): SummarySection[] => (s ? [{ title: s.title, rows: s.rows.map((r) => ({ label: r.label, value: r.value, ...(r.tone !== undefined ? { tone: r.tone } : {}) })) }] : []);
      const eSections = doc.requestClasses.length === 0 ? mapSection(envelopeSection({ result: envW.env, computing: envW.computing && envW.env === null }, (id) => labelOf(id, typeOf(id)))) : [];
      const wSections = doc.requestClasses.length === 0
        ? mapSection(worldsMatrix({ result: envW.worlds, computing: envW.computing && hasScenarios(doc.scenarios) && envW.worlds === null, ...(active !== undefined ? { active } : {}) }, (id) => labelOf(id, typeOf(id))))
        : [];
      // THE ACTIVE-WORLD LENS SIDE-CHANNEL (lens-feed.ts) — ride the active world id in the summary feed so the native
      // Inspector routes a fact-assumption edit INTO the world the canvas shows (the frozen protocol has no field for
      // this VIEW state). Appended only for a non-base lens, and only single-river (worlds are inert under request
      // classes — the SAME guard `activeWorld` uses for the canvas overlay, so host routing and canvas can't disagree).
      // The host reads + strips it (never a visible System row).
      const lensSection = active !== undefined && doc.requestClasses.length === 0 ? [activeLensFeedSection(active)] : [];
      // THE VERDICT (owner-approved story) — the one-line answer as the TOP section, computed by the SHARED presenter
      // `systemVerdict` (the SAME one the web pill renders, so the two surfaces can never disagree). The ✓/✗ title
      // prefix drives its pass/error glyph (sectionIcon); the three headline numbers ride as its single child row.
      const cap = envW.env ? (envW.env.joint?.maxTotalRps ?? envW.env.perOrigin.reduce<number | undefined>((m, o) => (o.maxRps !== undefined && (m === undefined || o.maxRps > m) ? o.maxRps : m), undefined)) : undefined;
      const v = systemVerdict({
        violations: verds.filter((x) => x.status === 'violation').length + sysPromV.filter((x) => x.status === 'violation').length,
        saturated: saturated.size,
        capacityRps: cap,
        p99Ms: sim?.p99,
        costUsdMonth: totalCost,
      });
      const verdictSection: SummarySection = { title: `${v.status === 'ok' ? '✓' : '✗'} ${v.headline}`, rows: v.numbers ? [{ label: v.numbers, value: '' }] : [] };
      return [verdictSection, ...base, ...eSections, ...wSections, ...uSections, ...tSections, ...gSections, ...lensSection];
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [okEv, ev, doc, flows, queues, saturated, sim, unc, twoTier, peakByNode, envW, active, costBreak, totalCost, verds, guaranteeInput, lagV, sysPromV],
  );

  // The Inspector feed (native) for the CURRENT selection: the node's manifest config KNOBS (key/label/value/unit
  // via keyInfo), its VERDICT rows (pre-formatted `value` + tone), and the engine SUGGESTIONS for its open ports.
  // '' node = nothing selected (the host shows an empty inspector). Refreshed on every evaluation too.
  const nodeDetail = useMemo<NodeDetail>(() => {
    const inst = sel ? doc.instances.find((i) => i.id === sel) : undefined;
    // The selected node's simulated RESPONSE tail from the last run — the presenter
    // expands it into the full mean/p50/p95/p99 (+ samples) row. Present only after a sim ran (no-filler).
    const resp = sel && sim?.nodeResponse ? sim.nodeResponse.find((n) => n.id === sel) : undefined;
    const detail = presenterNodeDetail({
      sel,
      instance: inst,
      manifest: inst ? catalog[inst.type] : undefined,
      verdicts: verds,
      suggestions,
      labelOf,
      ...(resp ? { response: resp } : {}),
      // WORST-CASE LOAD (owner ruling): a node saturated at its declared peak already carries an ordinary saturation
      // violation in `verds` (fed the sweep's per-node peak above), rendered as a verdict row like any other — no
      // separate peak input, no 'Load' row, no '@HH:MM'. The native Inspector shows the same red tier as the canvas.
    });
    // The frozen host↔webview protocol carries no dedicated response field, so — the R2b pattern of reusing the
    // existing SummaryRow shape (protocol untouched) — the response row rides in `verdicts`, and the native Inspector
    // renders it VERBATIM under Verdicts, the same expanded picture the compact canvas chip summarises.
    return detail.response ? { ...detail, verdicts: [...detail.verdicts, detail.response] } : detail;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, doc, catalog, verds, suggestions, sim, peakByNode, queues]);

  // Push the native feeds after every evaluation (summary + nodeDetail + diagnostics), the same cadence as the
  // web shell re-rendering its panels. The host renders them into native trees / the Problems panel / status bar.
  useEffect(() => {
    bridge.postSummary(summarySections);
    bridge.postDiagnostics(wireProblems, wireStatus);
  }, [bridge, summarySections, wireProblems, wireStatus]);
  useEffect(() => { bridge.postNodeDetail(nodeDetail); }, [bridge, nodeDetail]);
  // Announce a selection change so the native views follow it (a fresh nodeDetail rides the effect above).
  useEffect(() => { bridge.postSelection(sel); }, [bridge, sel]);

  // The command router the host drives via `{type:'cmd'}` — GEOMETRY only now (Improve is host-side). The stable
  // dispatcher subscribes ONCE; `cmdRef` is repointed each render at the freshest handler (live state). Routing
  // goes through the total `runHostCommand` table (host-commands.ts), so every protocol verb MUST have a handler
  // here — a new verb that reached the canvas with nothing to do would not typecheck.
  const cmdRef = useRef<(cmd: HostCommand) => void>(() => {});
  cmdRef.current = (cmd: HostCommand) =>
    runHostCommand(cmd, {
      // Both geometry verbs run the ONE layout pipeline now (owner ruling: the single 'Tidy' button IS the ideal
      // pipeline). `sda.tidy` (native toolbar / System view / Ctrl+Alt+T) rides the `tidy` verb; `sda.idealLayout`
      // (palette / Ctrl+Alt+I power alias) rides the `idealLayout` verb — both drive the SAME measured-size layout.
      tidy: idealLayout,
      fitView: () => rfi?.fitView({ padding: 0.15, duration: 400 }),
      addGroup,
      generateDesignDoc: () => { const d = buildDesignDoc(); if (d) bridge.postDesignDoc(d); },
      idealLayout,
    });
  useEffect(() => bridge.onCommand((cmd) => cmdRef.current(cmd)), [bridge]);

  // The ACTION router — the native palette / inspector / suggester driving the canvas. Same repoint-each-render
  // pattern so the handlers close over the freshest doc/selection.
  const actRef = useRef<(action: HostAction) => void>(() => {});
  actRef.current = (action: HostAction) => {
    switch (action.kind) {
      case 'addComponent':
        addComp(action.comp);
        break;
      case 'select':
        setSel(action.node);
        // Re-fit to the revealed node if it exists (nice-to-have: keep it in view when the reveal came off-screen).
        if (action.node && rfi && doc.instances.some((i) => i.id === action.node)) {
          setTimeout(() => rfi.fitView({ padding: 0.35, duration: 300, nodes: [{ id: action.node! }] }), 0);
        }
        break;
      case 'wireSuggestion': {
        // Replicate a suggester QuickPick accept: find the target node's open port and add+wire `comp` to it.
        const s = (sel === action.node ? suggestions : suggestFor(studio, catalog, candidates, action.node)).find((x) => x.port === action.port);
        if (!s) { setFixMsg(`Port ${action.node}.${action.port} is no longer open.`); break; }
        addSuggestion(action.node, s, action.comp);
        break;
      }
    }
  };
  useEffect(() => bridge.onAction((action) => actRef.current(action)), [bridge]);

  // Keyboard: Ctrl/Cmd+Z / Shift+Z → the NATIVE undo owns history, so we POST to the host. Everything else
  // (Delete, nudge, fit, duplicate) stays local; the palette / save / theme are native.
  const selInstForKbd = selInst;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') { if (menu) { setMenu(null); return; } setSel(null); return; }
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA';
      if (mod) {
        if (typing) return;
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); bridge.post({ type: 'requestUndo' }); }
        else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); bridge.post({ type: 'requestRedo' }); }
        else if (k === 'd') { e.preventDefault(); if (sel && selInstForKbd) ctxDuplicate(sel); }
        return;
      }
      if (typing) return;
      if (k === 'f') { e.preventDefault(); rfi?.fitView({ padding: 0.15, duration: 400 }); }
      // N (n8n's quick-add) → the context-free picker at the viewport centre. Guard on a menu being open so it
      // doesn't fire while the context menu is up.
      else if (k === 'n' && !menu) { e.preventDefault(); openCatalogPicker(viewportCenter()); }
      else if (sel && selInstForKbd && (k === 'arrowleft' || k === 'arrowright' || k === 'arrowup' || k === 'arrowdown')) {
        e.preventDefault();
        const step = e.shiftKey ? 50 : 10;
        const p = doc.layout[sel] ?? { x: 200, y: 160 };
        const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0;
        const dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0;
        studio.dispatch({ kind: 'move', id: sel, x: p.x + dx, y: p.y + dy });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, sel, selInstForKbd, doc, rfi]);

  // The background DES sim (true tail) — the sim engine is pure JS; main.tsx runs it debounced and feeds us the
  // percentiles via the bridge. We only need the latest so the p99 verdict and the tail summary read it.
  useEffect(() => bridge.onSim(setSim), [bridge]);
  useEffect(() => bridge.onUncertainty(setUnc), [bridge]);
  useEffect(() => bridge.onTwoTier(setTwoTier), [bridge]);

  return (
    <StudioCtx.Provider value={studio}>
    <Tooltip />
    <main className={'cv canvas-only' + (morphing ? ' morphing' : '')} ref={cvRef} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }} onDrop={onDrop}>
      <div className="hud">
        <button className="hud-btn" onClick={addGroup} title="Add a grouping boundary (tier / VPC / zone)">▣ Group</button>
        <button className={'hud-btn' + (polishPhase === 'polishing' ? ' on' : '')} onClick={idealLayout} title="Tidy: arrange the diagram left→right by request flow (tiers as lanes), then polish in the background (aligned lanes, mirrored branches, tight columns) and smoothly apply the better layout. Hand-placed nodes stay put.">{polishPhase === 'polishing' ? '⤢ Tidying…' : '⤢ Tidy'}</button>
        {/* ASSUMPTION MODEL (doc §7.1) — the active-world lens selector: pick a world and the canvas + System tree
            reflect it (tagged); a demand/service-time edit then writes into that world. "✨ Worlds" derives the trio. */}
        {doc.requestClasses.length === 0 && (doc.scenarios.length === 0
          ? <button className="hud-btn" onClick={() => void deriveTrio()} title="Fill the pessimistic / real / optimistic worlds with values derived from THIS design's capacity envelope (badged 'derived')">✨ Worlds</button>
          : <>
              <button className={'hud-btn' + (active === undefined ? ' on' : '')} onClick={() => studio.setActiveScenario(undefined)} title="The base design (no world)">base</button>
              {doc.scenarios.map((s) => (
                <button key={s.id} className={'hud-btn' + (active === s.id ? ' on' : '')} onClick={() => studio.setActiveScenario(active === s.id ? undefined : s.id)} title={`View the "${s.name ?? s.id}" world — a demand/service-time edit writes into it`}>{s.name ?? s.id}</button>
              ))}
            </>)}
        {active !== undefined && <span className="hud-badge" title="The canvas + System reflect this world (the active lens)">world: {activeLensLabel(active, doc.scenarios)}</span>}
      </div>
      <ReactFlow
        nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        connectionLineType={ConnectionLineType.SmoothStep}
        onConnect={onConnect} onConnectStart={onConnectStart} onConnectEnd={onConnectEnd}
        onInit={(inst) => { setRfi(inst); setTimeout(() => inst.fitView({ padding: 0.22 }), 80); }}
        onReconnect={onReconnect}
        isValidConnection={isValidConnection}
        onNodeClick={(_, n) => { setSel(n.id); closeMenu(); }}
        onNodeDoubleClick={onNodeDblClick}
        onPaneClick={() => { setSel(null); closeMenu(); }}
        onNodeContextMenu={onNodeCtx}
        onEdgeContextMenu={onEdgeCtx}
        onPaneContextMenu={onPaneCtx}
        onNodeDragStop={onNodeDragStop}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        deleteKeyCode={['Backspace', 'Delete']}
        nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: 'flow', reconnectable: true, markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--edge)' } }}
        fitView fitViewOptions={{ padding: 0.2 }} minZoom={0.3} maxZoom={2} proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--grid)" />
        <Controls showInteractive={false} />
        {doc.instances.length > 8 && <MiniMap pannable zoomable nodeColor="var(--accent)" maskColor="rgba(0,0,0,0.06)" style={{ width: 150, height: 100 }} />}
      </ReactFlow>

      {/* Empty-canvas ghost CTA (n8n's "Add first step"): a centred dashed affordance that opens the
          whole-catalogue picker and places the pick at the flow-space centre. Only when the design has no nodes. */}
      {doc.instances.length === 0 && (
        <button type="button" className="ghost-cta" onClick={() => openCatalogPicker(viewportCenter())}>
          <span className="ghost-plus">＋</span>
          <span>Add first component</span>
        </button>
      )}

      {fixMsg && <div className="toast info" onClick={() => setFixMsg(null)}>{fixMsg}</div>}
      {undoNotice && (
        <div className="toast info undo-toast">
          <span>{undoNotice}</span>
          <button onClick={() => { bridge.post({ type: 'requestUndo' }); setUndoNotice(null); }}>Undo</button>
        </div>
      )}
      {tidyOffer && (
        <div className="toast info undo-toast">
          <span>New component overlaps another.</span>
          <button onClick={() => { setTidyOffer(false); idealLayout(); }}>Tidy</button>
        </div>
      )}

      {rename && (
        <InlineRename
          key={`${rename.kind}:${rename.id}`}
          anchor={rename.anchor}
          initial={rename.value}
          onCommit={commitRename}
          onCancel={() => setRename(null)}
        />
      )}

      {menu && (
        <>
          <div className="ctx-backdrop" onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu(); }} />
          <div className="ctxmenu" style={{ left: menu.x, top: menu.y }}>
            {menu.kind === 'node' && (
              <>
                <button onClick={() => { const id = menu.id; closeMenu(); beginRename('node', id); }}>Rename</button>
                <button onClick={() => { ctxDuplicate(menu.id); closeMenu(); }}>Duplicate</button>
                <button onClick={() => { ctxWrap(menu.id); closeMenu(); }}>Wrap in group</button>
                <div className="ctx-sep" />
                <button className="danger" onClick={() => { studio.dispatch({ kind: 'removeNode', id: menu.id }); if (sel === menu.id) setSel(null); closeMenu(); }}>Delete</button>
              </>
            )}
            {menu.kind === 'group' && (
              <>
                <button onClick={() => { const id = menu.id; closeMenu(); beginRename('group', id); }}>Rename</button>
                <button className="danger" onClick={() => { studio.dispatch({ kind: 'removeGroup', id: menu.id }); if (sel === menu.id) setSel(null); closeMenu(); }}>Delete group</button>
              </>
            )}
            {menu.kind === 'edge' && (() => {
              const { from, to, semantics } = menu;
              if (!from || !to) return null;
              return (
                <>
                  <button onClick={() => { studio.dispatch({ kind: 'setWireSemantics', from, to, semantics: semantics === 'async' ? 'sync' : 'async' }); closeMenu(); }}>
                    Make {semantics === 'async' ? 'sync' : 'async'}
                  </button>
                  <div className="ctx-sep" />
                  <button className="danger" onClick={() => { studio.dispatch({ kind: 'disconnect', from, to }); closeMenu(); }}>Delete connection</button>
                </>
              );
            })()}
            {menu.kind === 'pane' && (
              <>
                <button onClick={() => { const id = mintGroupId(); const f = menu.flow; studio.dispatch({ kind: 'addGroup', id, label: 'New group', x: f.x, y: f.y, w: 320, h: 240 }); setSel(id); closeMenu(); }}>Add group here</button>
                <button onClick={() => { rfi?.fitView({ padding: 0.2 }); closeMenu(); }}>Fit view</button>
              </>
            )}
          </div>
        </>
      )}
    </main>
    </StudioCtx.Provider>
  );
}

/**
 * The inline rename input — a tiny controlled overlay floated at `anchor` (screen coordinates). It replaces the
 * dead window.prompt: VS Code webviews block prompt()/confirm(), so a canvas rename must be an in-page editor. It
 * autofocuses and selects-all on mount (type-over immediately), Enter/blur COMMIT, Escape CANCELS. Blur commits so
 * clicking away behaves like every inline editor the user knows (and matches the old prompt's "OK" being implicit).
 * `commitOnBlur` is guarded so pressing Enter (which blurs) or Escape (which we mark handled) never commits twice.
 */
function InlineRename({
  anchor,
  initial,
  onCommit,
  onCancel,
}: {
  readonly anchor: { readonly x: number; readonly y: number };
  readonly initial: string;
  readonly onCommit: (text: string) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  // Once a key path (Enter/Escape) has decided the outcome, the following blur must not fire a second commit/cancel.
  const settled = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (el) { el.focus(); el.select(); }
  }, []);
  return (
    <input
      ref={ref}
      className="inline-rename"
      style={{ left: anchor.x, top: anchor.y }}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        // Keep canvas keyboard shortcuts (Delete/N/arrows) from firing while typing a name.
        e.stopPropagation();
        if (e.key === 'Enter') { settled.current = true; onCommit(text); }
        else if (e.key === 'Escape') { settled.current = true; onCancel(); }
      }}
      onBlur={() => { if (!settled.current) { settled.current = true; onCommit(text); } }}
      spellCheck={false}
      aria-label="Rename"
    />
  );
}
