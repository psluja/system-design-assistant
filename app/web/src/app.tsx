import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type DragEvent as RDragEvent, type MouseEvent as RMouseEvent } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap,
  useNodesState, useEdgesState, useUpdateNodeInternals, MarkerType, ConnectionLineType,
  type Connection, type Node, type Edge, type ReactFlowInstance,
} from '@xyflow/react';
import { Studio, serialize, deserialize, emptyProject, type Group } from '@sda/core';
import { registry, keys, allManifests, protocolCompat, protocolNote, toQueueingNetwork, provisioningTunables, quantizeKnob, localContribution, requestFlows, nodeQueues, realCumulativeLatency, responseLatency, realAwareVerdicts, systemSummary, systemPromiseVerdicts, systemBandsOf, hasTrafficOrigin, hasRanges, DEFAULT_SEED, generateDesignDoc, renderDesignDocHtml, SCOPE_STATEMENT, buildLoadSweep, guaranteeVerdicts, guaranteeVerdictRow, lagVerdicts, lagVerdictRow, TARGET_UTILIZATION, computeEnvelope, evaluateWorlds, deriveDefaultScenarios, mergeDerivedTrio, resetScenario, hasScenarios, applyScenarioToGraph, isScenarioOverridable, shapedOriginsOf, peakLoadByNode, type AssumptionScenario, type EnvelopeResult, type WorldsResult, type DesignDocInput, type DocGroup, type NodeQueue, type NodePeak, type Manifest, type GuaranteeVerdict, type LagVerdict, type Range, type TwoTierResult, type UncertaintyResult } from '@sda/content';
import { NodeId, Key, type Transform } from '@sda/engine-core';
import { portsConnect, evaluate } from '@sda/engine-solve';
import { facetsOf, KIND_LABEL } from './facets';
import { Tooltip } from './tooltip';
import { makeStudio } from './seed';
import { CommandPalette, type Command } from './command-palette';
import { iconFor } from './icons';
import { StudioCtx, nodeTypes, edgeTypes, type Tone, type Status, type NodeLoad } from './flow-nodes';
import { downloadFile } from './download';
import { loadProject, saveProject } from './idb';
import { registerWebMcp, webMcpTools } from './webmcp';
import { connectBridge, type BridgeHandle, type BridgeStatus } from './bridge';
import { bindBrowserSolvers } from './composition';
import { withBudgetEscalation, REFERENCE_MIP_BASIS, type SearchEngine, type SolverBindings } from '@sda/solver-contract';
// The SHARED view-model layer — the same functions the VS Code shell renders, so the two shells never drift.
// app.tsx imports them DIRECTLY (not via the ./layout | ./suggest | ./format | ./meta re-export stubs, which
// exist only so the `@web/*` alias consumers keep compiling).
import {
  KIND_DESC, fmt, formatMs, tidyLayout, routeDesignEdges, type RoutedWire,
  toLayoutDesign, createPolisher, groupRects, loadLayoutGpu, type Polisher, type PolishScheduler, type Placement,
  acceptedPortOffsets, type CatalogPorts, type PortOffsets,
  buildCandidates, suggestFor, matchingPort, problemRows, problemCount, statusLine, simVerdicts,
  pickerOptions, addPickedComponent, edgeRates, resolvePortTransform, resolveWireOutTransform,
  flowGuaranteeLines, guaranteeStrip, measuredResponseOf, latencyTone, latencyRangeBar, rateRow, worstCaseUnits,
  activeLensLabel, originShapeGlyph, type UncertaintyState,
  type Suggestion, type EdgeRate, type GuaranteeViewInput, type FlowGuaranteeLine, type GuaranteeStrip,
  type NodeResponseView, type PairLagView,
} from '@sda/presenter';
import { QuickPicker, type QuickPickerState } from './quick-picker';
import { ImprovePanel, type ImproveGoal, type ImproveResult } from './improve-panel';
import { TopBar, type TopPop } from './top-bar';
import { InspectorPanel } from './inspector';
import { ProblemsPanel } from './problems-panel';
import { SystemPanel } from './system-panel';
import { TransformEditor, type TransformTarget } from './transform-editor';
import { RangeEditor, type RangeTarget } from './range-editor';
import { insertOverlaps, FALLBACK_NODE, type Box } from './overlap';
import { ONBOARDED_KEY, INSP_OPEN_KEY, shouldShowOnboarding, initialInspectorOpen } from './onboarding';
// The bundled CQRS example, single-sourced from the repo's examples/ via a vite `?raw` import (one source of
// truth — the same file the docs/tests reference; the web can't read repo files at runtime). Loaded on demand.
import cqrsExampleRaw from '../../../examples/cqrs.sda.json?raw';

const CATALOG: Readonly<Record<string, Manifest>> = allManifests;

// A starter manifest shown in the component editor (components are pure JSON data).
const TEMPLATE = JSON.stringify(
  {
    type: 'custom.myservice',
    ports: [
      { name: 'in', dir: 'in', accepts: ['http'] },
      { name: 'db', dir: 'out', speaks: ['postgresql'] },
    ],
    config: [
      { key: 'concurrency', value: 200, unit: '1' },
      { key: 'perRequestDuration', value: 25, unit: 'ms' },
      { key: 'availability', value: 0.999, unit: 'ratio' },
    ],
    relations: [{ key: 'throughput', reads: ['concurrency', 'perRequestDuration'], expr: 'concurrency / (perRequestDuration / 1000)' }],
  },
  null,
  2,
);


/** The canvas context menu — a discriminated union on `kind`, so each variant carries exactly its own fields:
 *  a node/group menu has an `id`, an edge menu has the wire endpoints, a pane menu has the drop point. This
 *  makes the fields known-present per branch (no `as string` / `!` at the use sites). */
type Menu =
  | { readonly x: number; readonly y: number; readonly kind: 'node' | 'group'; readonly id: string }
  | { readonly x: number; readonly y: number; readonly kind: 'edge'; readonly semantics: 'sync' | 'async'; readonly from?: readonly [string, string]; readonly to?: readonly [string, string] }
  | { readonly x: number; readonly y: number; readonly kind: 'pane'; readonly flow: { readonly x: number; readonly y: number } };

export default function App() {
  const studioRef = useRef<Studio>();
  if (!studioRef.current) studioRef.current = makeStudio();
  const studio = studioRef.current;

  const doc = useSyncExternalStore((cb) => studio.onChange(cb), () => studio.project());
  // THE ACTIVE-WORLD LENS — Studio UI state (out of the doc), subscribed on the SAME
  // stream so a lens change re-renders exactly like a doc change. Worlds are single-river only (they decline under
  // request classes, exactly as the MCP does), so a class-declared design has no active world.
  const active = useSyncExternalStore((cb) => studio.onChange(cb), () => studio.activeScenario());
  const activeWorld = useMemo(() => (doc.requestClasses.length === 0 ? doc.scenarios.find((s) => s.id === active) : undefined), [doc, active]);
  // The compiled graph, OVERLAID with the active world's fact-assumption overrides when one is selected — so every
  // downstream read (verdicts, chips, queues, the System panel) reflects THAT world, visibly tagged. No active world
  // ⇒ the base graph, byte-for-byte as authored (the additive default). Defined HERE so statusOf / saturated / the
  // badge / the design doc all read the SAME truth (web-is-a-dumb-renderer).
  const graphR = useMemo(() => {
    const base = studio.graph();
    if (!base.ok || activeWorld === undefined) return base;
    return { ok: true as const, value: applyScenarioToGraph(base.value, activeWorld) };
  }, [doc, activeWorld]);
  const graph = graphR.ok ? graphR.value : null;
  // Evaluate the (possibly world-overlaid) graph directly when a world is active; otherwise the Studio's own evaluate
  // (which also handles request classes). When no world is active this is bit-for-bit `studio.evaluate()`.
  const ev = useMemo(() => (activeWorld !== undefined && graph ? evaluate(graph, registry) : studio.evaluate()), [doc, activeWorld, graph]);
  const okEv = ev.ok ? ev.value : null;
  const valueOf = (id: string, k: Key): number | undefined => (okEv ? okEv.value(NodeId(id), k) : undefined);
  const queues = useMemo<Map<string, NodeQueue>>(
    () => (graph && okEv ? nodeQueues(graph, (id, k) => okEv.value(NodeId(id), k)) : new Map()),
    [graph, okEv],
  );
  // The DES tail (p50/p95/p99) of the busiest flow — set in the background by runSimulate; declared HERE so the
  // verdicts can judge a percentile (p99) SLO against it (the analytic forward pass only knows the mean).
  const [sim, setSim] = useState<{ mean: number; p50: number; p95: number; p99: number; rate: number; goodput: number; errorRate: number; amplification: number; retryPolicy: boolean; stations: { id: string; util: number; drop: number }[]; nodeResponse: NodeResponseView[]; pairLag: PairLagView[] } | null>(null);
  // THE AMBIENT TWO-TIER TRANSIENT — no button: whenever a generator declares periodic
  // cycles, the ρ-envelope over the auto-derived season + the worst window (Tier-1 analytic) and the survival
  // verdict at that window (Tier-2 measured) are recomputed OFF-thread as the design rests (two-tier-worker.ts),
  // rendered by the shared presenter `twoTierSection` (identical rows in VS Code). Null when no generator is shaped
  // (no-filler). The resting handshake: the Tier-1 preview lands first, the Tier-2 confirm updates it.
  const [twoTier, setTwoTier] = useState<TwoTierResult | null>(null);
  // PEAK-AWARE PER-NODE LOAD — each node's WORST-WINDOW ρ + instant from
  // the ambient Tier-1 sweep, so the canvas ρ chip, the Inspector verdict and the System ρ rows judge the declared
  // PEAK, not just the steady baseline. Null with no shaped generator (twoTier null) ⇒ every surface byte-identical.
  const peakByNode = useMemo<Map<string, NodePeak> | null>(() => (twoTier ? peakLoadByNode(twoTier.tier1) : null), [twoTier]);
  // AMBIENT UNCERTAINTY — Monte Carlo recomputed OFF-thread on every design change, shown in the System
  // panel as a distribution. The resting handshake: a fast fp32 GPU `preview` cloud while editing, then a
  // CPU-CONFIRMED (fp64, verdict-grade) pass when the design rests. Set in the background by the uncertainty loop.
  const [unc, setUnc] = useState<{ result: UncertaintyResult | null; state: UncertaintyState; backend?: 'gpu' | 'cpu'; elapsedMs?: number } | null>(null);
  // ASSUMPTION MODEL — the capacity ENVELOPE (the default answer, no demand needed)
  // and the all-world comparison MATRIX, both recomputed AMBIENTLY on the native in-process solver (optimize +
  // evaluateBatch, ms-grade) while the System panel is open, LATEST-WINS by epoch. The envelope pass also RE-TRACKS
  // the live-derived scenario values against the fresh envelope (doc §5.3, tension #5).
  const [envW, setEnvW] = useState<{ env: EnvelopeResult | null; worlds: WorldsResult | null; computing: boolean }>({ env: null, worlds: null, computing: false });
  // A guided reason shown when "Derive trio" cannot honestly derive worlds (an empty envelope) — never a silent no-op.
  const [deriveNote, setDeriveNote] = useState<string | null>(null);
  const envEpochRef = useRef(0);
  // REAL-AWARE verdicts, the ONE list every surface reads: scalar latency judged against the queueing latency
  // (∞ at ρ≥1), every saturated tier gets an explicit violation, AND the DES-fed verdicts (a percentile p99 SLO
  // judged against the SIMULATED tail; a goodput/error-rate SLO on a retrying path judged against the measured
  // outcome) — so the badge, the node verdict and the design doc agree with the System panel instead of reading
  // "71 ms · unknown". The DES-fed composition lives in the shared presenter `simVerdicts` (identical in both
  // shells + the MCP), so a new time-domain verdict is added ONCE, never re-wired here.
  const verds = useMemo(() => {
    if (!okEv || !graph) return okEv?.verdicts ?? [];
    // Fed the sweep's per-node WORST-WINDOW ρ (peakByNode) so a node calm at the mean but saturated at its declared
    // peak carries an ordinary saturation violation in this ONE list — the canvas, the Inspector, the System panel
    // AND the exported doc then show the same red tier (one truth). With no shaped generator peakByNode is null ⇒
    // byte-identical to today. `realAwareVerdicts` adds no 'peak' vocabulary — a violation is a violation.
    const base = realAwareVerdicts(okEv.verdicts, graph, (id, k) => okEv.value(NodeId(id), k), queues, peakByNode ?? undefined);
    return simVerdicts(base, graph, registry, sim);
  }, [okEv, graph, queues, sim, peakByNode]);
  // The PROBLEMS list (an IDE-style Error List over the ONE verdict list): every non-ok verdict — violations
  // first, then warnings, then unverified (unknown) — plus the structural BUILD errors when the graph doesn't
  // compile. Pure projection of already-computed values; the web adds no judgement of its own. The projection
  // LIVES in @sda/presenter now, so this list and the vscode Problems panel can never diverge.
  const problems = useMemo(() => problemRows(verds, ev.ok, ev.ok ? [] : ev.error), [verds, ev]);
  const problemCnt = useMemo(() => problemCount(problems), [problems]);
  const statusOf = (id: string): Status => {
    const vs = verds.filter((v) => v.scope === NodeId(id));
    if (vs.some((v) => v.status === 'violation')) return 'violation';
    if (vs.some((v) => v.status === 'warning')) return 'warning';
    return vs.length ? 'ok' : undefined;
  };
  // The status of ONE metric on a node, so a per-metric chip reflects THAT metric's own verdict — not the node's
  // worst (a failing Cost SLO must never paint the Throughput chip red; that contradicts its own requirement row).
  const statusOfKey = (id: string, key: Key) => verds.find((v) => v.scope === NodeId(id) && String(v.key) === String(key))?.status;

  // Independent request FLOWS = connected components of the wiring, each with its TERMINAL (deepest sink by
  // cumulative latency) whose computed values ARE the flow's end-to-end metrics. The analysis lives in the
  // shared content layer (so the MCP/AI sees the same flows) — the web only renders it.
  const flows = useMemo(() => requestFlows(doc.instances, doc.wires, valueOf), [doc, ev]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-node OWN monthly cost. `cost` aggregates as a SUM downstream, so the engine's value(node,cost) is
  // CUMULATIVE (node + everything upstream); `localContribution` recovers each node's own share. The sum of
  // those locals is the true total system cost (no double-counting on fan-in/out). We drop ~0 locals so the
  // chips only show nodes that actually cost something.
  const localCost = useMemo<Record<string, number>>(() => {
    if (!okEv) return {};
    const own = localContribution((id, k) => okEv.value(NodeId(id), k), doc.instances, doc.wires, keys.cost);
    const m: Record<string, number> = {};
    for (const [id, v] of Object.entries(own)) if (v > 0.005) m[id] = v;
    return m;
  }, [doc, okEv]);
  const totalCost = useMemo(() => Object.values(localCost).reduce((s, c) => s + c, 0), [localCost]);
  // The bill DEPTH: compute + the most-missed egress line + the committed-pricing scenarios — from the
  // shared roll-up so the System panel and the MCP `evaluate` show one breakdown (the web computes nothing extra).
  const costBreak = useMemo(() => (okEv ? systemSummary(doc.instances, doc.wires, (id, k) => okEv.value(NodeId(id), k)).cost : null), [doc, okEv]);
  // SYSTEM promises (owner ruling: cost is for THE WHOLE SYSTEM) — judged by the ONE shared content judge against
  // the whole-graph total (the exact sum Improve's system band constrains and optimize scope:'system' minimizes),
  // so this panel, the MCP `evaluate`, the worlds matrix and the generated doc can never disagree.
  const sysPromises = useMemo(
    () => systemPromiseVerdicts(doc.instances, doc.wires, okEv ? (id, k) => okEv.value(NodeId(id), k) : null, doc.systemPromises),
    [doc, okEv],
  );

  // ENGINE-INTERNAL analytic latencies (SINGLE-TRUTH LATENCY, owner decree): these stay COMPUTED — the design-doc
  // input and the Inspector's quiet model-drift diagnostic read them — but they are NEVER a shown latency value on any
  // surface. The user-facing latency is the DES measurement or nothing.
  // Per-node critical-path queueing sojourn (∞ if a hop saturates) — feeds the design-doc input only.
  const realLatByNode = useMemo<Map<string, number>>(() => (graph ? realCumulativeLatency(graph, valueOf, queues) : new Map()), [graph, queues]); // eslint-disable-line react-hooks/exhaustive-deps
  // Per-node request→response analytic estimate — feeds the edge dot-speed animation, the model-drift diagnostic and
  // the design-doc input (never a displayed latency).
  const respByNode = useMemo<Map<string, number>>(() => (graph ? responseLatency(graph, valueOf, queues) : new Map()), [graph, queues]); // eslint-disable-line react-hooks/exhaustive-deps

  // Nodes that ACTUALLY saturate — ρ≥1, where the queue grows without bound (timeouts), the timeout-causing truth
  // the editor must show even with NO SLO set. Read straight off the shared queueing model: only a genuinely
  // overloaded tier has ρ≥1 (a starved downstream tier has ρ<1, so it never lights up), and ρ≥1 catches the ρ=1
  // knife-edge where `overflow` is exactly 0 yet the wait is already unbounded. Map id → dropped rps (0 at ρ=1).
  const saturated = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (const [id, q] of queues) {
      if (q.rho < 1) continue;
      m.set(id, valueOf(id, keys.overflow) ?? 0);
    }
    return m;
  }, [queues]); // eslint-disable-line react-hooks/exhaustive-deps
  const anySaturated = saturated.size > 0;

  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    typeof location !== 'undefined' && new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light',
  );
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  // 'saved' once the debounced IndexedDB autosave has flushed; 'saving' the moment a change lands. A quiet
  // trust signal in the header (the exported .sda.json remains the real backup).
  const [saved, setSaved] = useState(true);
  // Auto-restore the last project from IndexedDB, then debounce-autosave on every change (the exported
  // .sda.json file remains the real backup). Also register the toolset on the browser agent surface.
  useEffect(() => {
    const ready = { v: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    void loadProject()
      .then((json) => { if (json) { const r = deserialize(json); if (r.ok) studio.load(r.value); } })
      .catch(() => undefined)
      .finally(() => { ready.v = true; });
    const off = studio.onChange(() => {
      if (!ready.v) return;
      setSaved(false);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { Promise.resolve(saveProject(serialize(studio.project()))).then(() => setSaved(true)).catch(() => setSaved(true)); }, 400);
    });
    setMcpLive(registerWebMcp(studio) > 0);
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [studio]);

  // Keyboard shortcuts. The listener subscribes ONCE; it calls `kbdRef.current`, which the render body keeps
  // pointing at the freshest handler (closing over live `sel` / `doc` / handlers) — no stale closures, no
  // re-subscribing on every state change. The full map lives in SHORTCUTS (single source for the cheatsheet).
  const kbdRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => kbdRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // A transient "Deleted … — Undo" toast so a destructive action is always recoverable in one click (undo
  // exists, but a silent delete gives no hint it can be reversed). Auto-dismisses.
  const [undoNotice, setUndoNotice] = useState<string | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showUndoNotice = (text: string): void => {
    setUndoNotice(text);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndoNotice(null), 6000);
  };
  // A transient "Tidy?" offer shown after a picker insert whose new node landed ON another. It NEVER
  // auto-reflows (no surprise layout changes) — it just offers the single Tidy pipeline one click away. Auto-dismisses.
  const [tidyOffer, setTidyOffer] = useState(false);
  const tidyOfferTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showTidyOffer = (): void => {
    setTidyOffer(true);
    if (tidyOfferTimer.current) clearTimeout(tidyOfferTimer.current);
    tidyOfferTimer.current = setTimeout(() => setTidyOffer(false), 6000);
  };

  const [sel, setSel] = useState<string | null>('app');
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // Forces React Flow to re-measure a node's handle (port) bounds from the DOM — used when a port SLIDES within an
  // unchanged-size node (R5 / Tidy), which RF's size-only re-measure would otherwise miss, leaving edges off the port.
  const updateNodeInternals = useUpdateNodeInternals();
  const [query, setQuery] = useState('');
  const [kindF, setKindF] = useState<Set<string>>(new Set());
  const [provF, setProvF] = useState<Set<string>>(new Set());
  const [protoF, setProtoF] = useState<Set<string>>(new Set());
  const [rfi, setRfi] = useState<ReactFlowInstance | null>(null);
  // Smart orthogonal edge routing (edge-routing.ts): on by default; the HUD toggle falls back to the plain
  // getSmoothStep wire when off (e.g. if a hand-placed layout reads better with straight-through edges).
  const [smartRoutes, setSmartRoutes] = useState(true);
  // THE IDEAL LAYOUT — the pipeline the single 'Tidy' button runs.
  // It applies the floor (an instant tidy) at once, then the shared @sda/presenter polisher searches in the
  // BACKGROUND (one search slice per animation frame — the canvas never blocks); when it rests, the better layout is
  // applied with a smooth position morph as ONE undoable edit. `polishPhase` drives the "Tidying…" HUD hint;
  // `morphing` toggles the CSS transition during the apply; the polisher is held in a ref so a fresh click supersedes
  // an in-flight polish (latest-wins).
  const [polishPhase, setPolishPhase] = useState<'idle' | 'polishing' | 'done'>('idle');
  const [morphing, setMorphing] = useState(false);
  const polisherRef = useRef<Polisher | null>(null);
  const morphTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // ASSIGNED PORT POSITIONS (R5, the port slide — presenter `assignPortOffsets`): node id → `${side}:${port}` → px
  // from the node's top. Set by the Tidy pipeline at BOTH stages (floor AND polish — the layout owns the slide).
  // VIEW state, not document data: beauty, never truth. The same map feeds the node renderer's handles AND the
  // router's anchors below, so they cannot drift apart.
  const [portOffsets, setPortOffsets] = useState<PortOffsets | null>(null);
  // Nodes the architect DRAGGED this session — the honest pin signal (§5.3): the Tidy pipeline holds these where the
  // human put them and lays out only AROUND them (a reload starts a fresh session with no pins). This is the
  // SESSION-drag signal, not a divergence heuristic, so an imported/authored layout is never spuriously frozen.
  const handMovedRef = useRef<Set<string>>(new Set());
  // Keep the whole design in view as the available space changes (window resize, opening/closing the System
  // drawer) — this is an overview tool, so the diagram should stay fitted rather than clip off the right edge.
  const cvRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = cvRef.current;
    if (el === null || rfi === null) return;
    let t: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => rfi.fitView({ padding: 0.22 }), 200); });
    ro.observe(el);
    return () => { clearTimeout(t); ro.disconnect(); };
  }, [rfi]);
  const [menu, setMenu] = useState<Menu | null>(null);
  // The in-canvas quick-add picker: opened by a wire dropped on the pane (with a port context),
  // the empty-canvas ghost CTA, the N key, or the command palette (all context-free). Its screen anchor is
  // the drop / CTA / viewport point; a picked type is placed via the SHARED addPickedComponent below.
  const [picker, setPicker] = useState<QuickPickerState | null>(null);
  // The TRANSFORM editor popover (R2, doc: flow-transformations-r2 §4; wire level §5). Opened by a click on
  // an edge pill (OUT-side ⇒ WIRE mode, IN-side ⇒ PORT mode) OR an Inspector port row (PORT mode); anchored at the
  // click. Carries the TARGET (a port or a wire) + the current transform so the popover pre-fills, and the apply
  // handler picks the command from the target's mode (setTransform vs setWireTransform).
  const [transformPop, setTransformPop] = useState<{ x: number; y: number; target: TransformTarget; current: Transform | null } | null>(null);
  // The uncertainty ± RANGE editor popover — opened from a Configuration knob's ±
  // affordance. Carries the knob context (label/unit/point value) for the header + the current range to seed the fields.
  const [rangePop, setRangePop] = useState<{ x: number; y: number; target: RangeTarget; current: Range | null; label: string; unit: string; point: number } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const projNameRef = useRef<HTMLInputElement>(null);
  // NEW DESIGN (audit F7/F8) — start a fresh EMPTY project (never the seeded demo, which is a first-run affordance
  // only). UNDOABLE via replaceDoc (Ctrl+Z restores the prior design), so the confirm is only a courtesy when the
  // current design has content. Nudge: focus + select the project-name field so naming it is the first, obvious move.
  const newDesign = (): void => {
    if (doc.instances.length > 0 && !window.confirm('Start a new, empty design? Your current design is replaced — Undo (Ctrl+Z) restores it.')) return;
    studio.replaceDoc(emptyProject('p1', 'Untitled'));
    setSel(null);
    setTimeout(() => { projNameRef.current?.focus(); projNameRef.current?.select(); }, 0);
  };
  // The System drawer (bottom) holds the WHOLE-design lenses; the right Inspector is always per-selection.
  const [lens, setLens] = useState<'system' | 'optimize' | 'problems'>(() => {
    const m = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('mode') : null;
    return m === 'optimize' ? 'optimize' : 'system'; // Live + Simulate are now ONE real-by-default "System" view
  });
  const [drawerOpen, setDrawerOpen] = useState(true);
  // The right Inspector is collapsible: a slim grip on its left edge, mirroring the System drawer.
  // Initial state honours a persisted choice, else auto-collapses ONCE on a narrow viewport (<1100px) so a
  // 1366px laptop opens with the canvas usable. Persisted so the choice survives reload; we never fight the user.
  const [inspOpen, setInspOpen] = useState(() => {
    try { return initialInspectorOpen(localStorage.getItem(INSP_OPEN_KEY), typeof window !== 'undefined' ? window.innerWidth : 1440); }
    catch { return true; }
  });
  const toggleInsp = (): void => setInspOpen((o) => { const n = !o; try { localStorage.setItem(INSP_OPEN_KEY, n ? '1' : '0'); } catch { /* private mode */ } return n; });
  // First-run onboarding: the "Start here" card shows once, only on a fresh profile (`sda.onboarded`
  // absent) over the untouched seed (or empty canvas). `onboardFlag` mirrors localStorage so setting it re-renders.
  const [onboardFlag, setOnboardFlag] = useState<string | null>(() => { try { return localStorage.getItem(ONBOARDED_KEY); } catch { return null; } });
  const dismissOnboard = (): void => { try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch { /* private mode */ } setOnboardFlag('1'); };
  const showOnboard = shouldShowOnboarding(onboardFlag, { instanceIds: doc.instances.map((i) => i.id) });
  // Load the bundled CQRS example (11 nodes) from the onboarding card. replaceDoc keeps it UNDOABLE (Ctrl+Z
  // restores the seed), and picking the example counts as onboarded — dismiss the card for good.
  const loadCqrsExample = (): void => {
    const r = deserialize(cqrsExampleRaw);
    if (r.ok) { studio.replaceDoc(r.value); setSel(null); }
    dismissOnboard();
  };
  // A real user edit dismisses onboarding for good — even one that keeps the same node set (a config tweak, a
  // rename, a new wire), which the seed-identity check alone wouldn't catch. The first change after mount, while
  // the card is still eligible, sets the flag. The IndexedDB autoload also fires onChange, but it REPLACES the seed
  // with a different design; if that design isn't the untouched seed the card is already hidden by the predicate.
  useEffect(() => {
    if (onboardFlag !== null) return; // already dismissed
    const off = studio.onChange(() => dismissOnboard());
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studio, onboardFlag]);
  const [goal, setGoal] = useState<ImproveGoal>('feasible'); // the Improve lens's backward-solve goal (default: clear violations)
  const [improve, setImprove] = useState<ImproveResult | null>(null);
  const [busy, setBusy] = useState<'' | 'sim' | 'opt'>('');
  const [mcpLive, setMcpLive] = useState(false);
  const [mcpPop, setMcpPop] = useState<TopPop | null>(null); // the MCP tools dropdown (informational)
  const [importErr, setImportErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mcpToolList = useMemo(() => webMcpTools(studio), [studio]);

  // AI bridge: link the open canvas to the local relay so an external AI client drives this live design.
  // The bridge prints a per-run token (it gates the link so a random web page can't impersonate the canvas).
  // The token PROMPT (popover + input) lives in TopBar; App owns the connection handle + status.
  const [bridge, setBridge] = useState<BridgeStatus>('offline');
  const [aiAct, setAiAct] = useState<{ name: string; ok: boolean; n: number } | null>(null);
  const bridgeRef = useRef<BridgeHandle | null>(null);
  const actSeq = useRef(0);
  const connectAI = (token: string): void => {
    bridgeRef.current?.close();
    bridgeRef.current = connectBridge(studio, {
      status: (s) => setBridge(s),
      activity: (name, ok) => setAiAct({ name, ok, n: ++actSeq.current }),
    }, token);
  };
  /** Close a live bridge handle if one exists (returns true — the header click is consumed as "unlink");
   *  false lets the header open its token prompt instead. */
  const unlinkBridge = (): boolean => {
    if (!bridgeRef.current) return false;
    bridgeRef.current.close();
    bridgeRef.current = null;
    setBridge('offline');
    return true;
  };
  useEffect(() => () => bridgeRef.current?.close(), []);
  // Auto-dismiss the "AI did X" toast a moment after each action.
  useEffect(() => {
    if (!aiAct) return;
    const t = setTimeout(() => setAiAct((a) => (a && a.n === aiAct.n ? null : a)), 2600);
    return () => clearTimeout(t);
  }, [aiAct]);

  // The catalogue the UI works against = built-ins + project-scoped custom components (custom wins).
  const catalog = useMemo<Record<string, Manifest>>(() => {
    const merged: Record<string, Manifest> = { ...CATALOG };
    for (const m of doc.components) merged[m.type] = m;
    return merged;
  }, [doc.components]);
  const candidates = useMemo(() => buildCandidates(catalog), [catalog]);
  // The CATALOG port lists by type (manifest order, name+dir only) — what the ✨ layout feeds `toLayoutDesign` so
  // every layout stage anchors at the handles this canvas actually renders (R5; the multi-out jog class pinned).
  const catalogPorts = useMemo<CatalogPorts>(
    () => Object.fromEntries(Object.entries(catalog).map(([t, m]) => [t, m.ports.map((p) => ({ name: p.name, dir: p.dir }))])),
    [catalog],
  );
  const isCustom = (t: string): boolean => doc.components.some((m) => m.type === t);
  // Display name = friendly label if set, else a prettified type. The id stays the stable identifier.
  const prettify = (type: string): string => { const s = type.split('.').pop() ?? type; return s.charAt(0).toUpperCase() + s.slice(1); };
  const labelOf = (id: string, type: string): string => doc.labels[id] ?? prettify(type);
  const typeOf = (id: string): string => doc.instances.find((x) => x.id === id)?.type ?? '';
  // SCENARIO-FIRST AUTHORING — a knob edit writes INTO the active world when that world
  // is active AND the knob is an overridable fact-assumption (offered demand, a service time…); otherwise it edits
  // the shared BASE. A limit / computed knob is never a world belief, so it always edits the base. The role boundary
  // is the SAME `isScenarioOverridable` the command + the load validator use, so the routing can never drift.
  const commitConfig = (node: string, key: string, value: number): void => {
    if (active !== undefined && isScenarioOverridable(node, key, doc.instances, doc.wires)) {
      studio.dispatch({ kind: 'setScenarioOverride', scenario: active, node, key, value });
    } else {
      studio.dispatch({ kind: 'setConfig', node, key, value });
    }
  };
  const manifestOf = (id: string): Manifest | undefined => catalog[typeOf(id)];
  const descOf = (id: string): string => doc.descriptions[id] ?? '';

  // ── GUARANTEE PROPAGATION — the qualitative-guarantee surface, all read from the
  // SHARED presenter/content (so the human, the AI and the design doc read ONE truth). Silent until a requirement
  // is declared (the no-filler rule): with no guaranteeSlos and no degradation these are empty and draw nothing.
  const guaranteeInput = useMemo<GuaranteeViewInput | null>(
    () => (graph && okEv ? { graph, instances: doc.instances, wires: doc.wires, value: valueOf, catalog, slos: doc.guaranteeSlos } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, okEv, doc, catalog],
  );
  // Per-flow LAG verdicts — the async-inclusive propagation deadlines. When a sim has
  // run, the DES's measured mean RESOLVES each to a real ok/violation (basis 'measured'); otherwise the scalar pass
  // proves a violation or reads honest `unknown`. The SAME `lagVerdicts` the MCP + vscode read (one truth) — the web
  // renders these in the System drawer's "Propagation lag" section, closing the gap where only the sibling shell showed it.
  const lagV = useMemo<LagVerdict[]>(() => {
    if (!(graph && okEv && doc.lagSlos.length > 0)) return [];
    const lag = sim?.pairLag && sim.pairLag.length > 0
      ? (s: string, t: string): number | undefined => {
          const p = sim.pairLag.find((x) => x.source === s && x.terminal === t);
          return p && Number.isFinite(p.mean) ? p.mean : undefined;
        }
      : undefined;
    return lagVerdicts(graph, valueOf, doc.lagSlos, queues, lag);
  }, [graph, okEv, doc, queues, sim]); // eslint-disable-line react-hooks/exhaustive-deps

  // SINGLE-TRUTH LATENCY (owner decree): the canvas latency BAR per node — the MEASURED p50→p99 range (verdict-toned),
  // or absent when the DES has measured nothing (measured-or-nothing; no analytic fallback, no selection gate). SHARED
  // with the VS Code canvas via the presenter so the two never drift; painted by the node renderer in the build below.
  const latBars = useMemo(
    () => new Map(doc.instances.flatMap((i) => { const m = measuredResponseOf(sim, i.id); return m ? [[i.id, latencyRangeBar(m, latencyTone(verds, i.id))] as const] : []; })),
    [doc.instances, sim, verds],
  );

  // The per-flow guarantee LINES (System panel) and the judged VERDICTS (Problems + the requirement rows' read-back).
  const guaranteeLines = useMemo<readonly FlowGuaranteeLine[]>(() => (guaranteeInput ? flowGuaranteeLines(guaranteeInput) : []), [guaranteeInput]);
  const gVerdicts = useMemo<readonly GuaranteeVerdict[]>(
    () => (guaranteeInput && guaranteeInput.slos.length > 0 ? guaranteeVerdicts(guaranteeInput.graph, guaranteeInput.catalog, guaranteeInput.instances, guaranteeInput.wires, guaranteeInput.value, guaranteeInput.slos) : []),
    [guaranteeInput],
  );
  // The per-WIRE guarantee STRIP segment: for every declared requirement, the engine paints each participating edge
  // (teal holds · red from the degrading hop · gray unknown); across requirements the WORST tone wins per wire (the
  // honest floor). Empty when no requirement is declared ⇒ the canvas draws zero strip pixels (no-filler).
  const guaranteeStripByWire = useMemo<Map<number, { tone: 'ok' | 'bad' | 'unknown'; hover: string }>>(() => {
    const out = new Map<number, { tone: 'ok' | 'bad' | 'unknown'; hover: string }>();
    if (!guaranteeInput || guaranteeInput.slos.length === 0) return out;
    const rank: Record<'ok' | 'bad' | 'unknown', number> = { ok: 0, unknown: 1, bad: 2 };
    for (const slo of guaranteeInput.slos) {
      const strip: GuaranteeStrip | null = guaranteeStrip(guaranteeInput, slo);
      if (strip === null) continue;
      for (const seg of strip.segments) {
        const prev = out.get(seg.wire);
        if (prev === undefined || rank[seg.tone] > rank[prev.tone]) out.set(seg.wire, { tone: seg.tone, hover: seg.hover });
      }
    }
    return out;
  }, [guaranteeInput]);
  // GUARANTEE violations as Problems rows — a broken qualitative promise is a real defect, listed in the SAME
  // Problems panel as the numeric ones. The `fix` is the computed remediation (R2 —
  // swap + ceiling + cost) or the honest reason none exists; the row's `node` is the root cause (click → select).
  const guaranteeProblems = useMemo(
    () => gVerdicts.filter((v) => v.status === 'violation').map((v) => ({ verdict: v, fix: v.remediation?.action ?? v.noRemediationReason })),
    [gVerdicts],
  );
  const guaranteeProblemCnt = guaranteeProblems.length;

  // custom-component editor (CRUD) — `?editor=1` deep-links straight into it. One editor, three intents:
  // `new` (blank), `edit` (an existing project component), `customize` (a built-in → save creates a custom
  // override of the SAME type that shadows it; the built-in data is never mutated — the closed-framework rule).
  type EditorMode = { kind: 'new' } | { kind: 'edit'; type: string } | { kind: 'customize'; type: string };
  const [editorOpen, setEditorOpen] = useState(() => typeof location !== 'undefined' && new URLSearchParams(location.search).get('editor') === '1');
  const [editorText, setEditorText] = useState(TEMPLATE);
  const [editorErr, setEditorErr] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>({ kind: 'new' });
  const compFileRef = useRef<HTMLInputElement>(null);
  const openEditor = () => { setEditorMode({ kind: 'new' }); setEditorText(TEMPLATE); setEditorErr(null); setEditorOpen(true); };
  // Open the editor on an existing type. A project-scoped component is edited in place; a built-in is loaded
  // as a starting point and saved as a custom override (so the original catalogue entry stays intact).
  const editType = (type: string) => {
    const custom = doc.components.find((m) => m.type === type);
    const manifest = custom ?? CATALOG[type];
    if (manifest === undefined) return;
    setEditorText(JSON.stringify(manifest, null, 2));
    setEditorMode(custom ? { kind: 'edit', type } : { kind: 'customize', type });
    setEditorErr(null);
    setEditorOpen(true);
  };
  const saveComponent = () => {
    let parsed: unknown;
    try { parsed = JSON.parse(editorText); } catch (e) { setEditorErr(`Invalid JSON: ${String(e)}`); return; }
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      const r = studio.dispatch({ kind: 'defineComponent', manifest: m as Manifest });
      if (!r.ok) { setEditorErr(r.error); return; }
    }
    setEditorErr(null);
    setEditorOpen(false);
  };
  const onImportComponent = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) setEditorText(await file.text());
  };
  const exportComponent = (m: Manifest) => downloadFile(`${m.type}.component.json`, JSON.stringify(m, null, 2), 'application/json');

  useEffect(() => {
    const groupOf: Record<string, Group> = {};
    for (const g of doc.groups) for (const m of g.members) groupOf[m] = g;

    // Which (node, port) pairs are WIRED — so the node renderer shows the inline "+" only on OPEN ports.
    // A port is wired if it appears as either endpoint of any wire.
    const wiredPorts = new Set<string>();
    for (const w of doc.wires) { wiredPorts.add(`${w.from[0]} ${w.from[1]}`); wiredPorts.add(`${w.to[0]} ${w.to[1]}`); }

    // SHAPED ORIGINS — the nodes whose generator declares non-flat cycles,
    // from content's ONE detector (shapedOriginsOf), so the ⚡-shape chip below marks exactly the origins the ambient
    // two-tier evaluates. A flat/disabled generator is absent here ⇒ its node is unchanged (no-filler). The combined
    // cycles per node feed the presenter glyph, so the chip's silhouette IS the evaluated shape (web-is-a-dumb-renderer).
    const shapeGlyph = new Map<string, string>();
    const gg = studio.graph();
    if (gg.ok) for (const o of shapedOriginsOf(gg.value)) shapeGlyph.set(o.nodeId, originShapeGlyph(o.gens.flatMap((g) => [...g.cycles])));

    // Groups render first (React Flow requires a parent before its children) and sit behind nodes.
    const groupNodes: Node[] = doc.groups.map((g) => ({
      id: g.id,
      type: 'group',
      position: { x: g.rect.x, y: g.rect.y },
      selected: g.id === sel,
      data: { label: g.label },
      style: { width: g.rect.w, height: g.rect.h },
    }));

    const compNodes: Node[] = doc.instances.map((inst) => {
      const kind = facetsOf(inst.type).kind;
      const st = statusOf(inst.id);
      const tp = valueOf(inst.id, keys.throughput);
      const sat = saturated.get(inst.id);
      const q = queues.get(inst.id);
      const chips: { t: string; k: Tone }[] = [];
      // RPS — ONE FORM (the rate row): every node's rate rides the SAME meter row (flow-nodes RateMeter), built by
      // the shared presenter so both shells render it identically (web-is-a-dumb-renderer). A capacity-bearing tier
      // carries capacity+ρ (the utilisation fill); a capacity-less tier (a source / origin, or a pure-delay hop with
      // no finite ceiling) carries the rate alone, verdict-toned — never a separate rps chip.
      const load: NodeLoad | undefined = rateRow(q, tp, st, peakByNode?.get(inst.id));
      // '⊞ tasks' — the units the node's generation scaled to at its HIGHEST point: the WORST-window requiredUnits when
      // this node has a shaped generator (peakByNode carries it, coherent with the peak ρ the rate row shows), else the
      // steady requiredUnits (no shape ⇒ peakByNode absent ⇒ worstCaseUnits returns it verbatim — byte-identical).
      const units = worstCaseUnits(valueOf(inst.id, keys.requiredUnits), peakByNode?.get(inst.id));
      if (units !== undefined && units > 0) chips.push({ t: `⊞ ${Math.ceil(units)} tasks`, k: '' });
      // A SHAPED GENERATOR — a distinct ⚡ chip carrying the shape silhouette, so a
      // time-varying origin is legible on the canvas at a glance. Flat generators carry no chip (their rate rides
      // the meter row + the wire pill, unchanged).
      const glyph = shapeGlyph.get(inst.id);
      if (glyph !== undefined) chips.push({ t: `⚡ ${glyph}`, k: '' });
      const cst = localCost[inst.id];
      if (cst !== undefined) chips.push({ t: `$${fmt(cst)}/mo`, k: '' });
      if (sat !== undefined) chips.push({ t: `⚠ overloaded · ${fmt(sat)} rps dropped`, k: 'bad' });
      const abs = doc.layout[inst.id] ?? { x: 0, y: 0 };
      const g = groupOf[inst.id];
      const position = g ? { x: abs.x - g.rect.x, y: abs.y - g.rect.y } : abs; // child positions are parent-relative
      const ports = (catalog[inst.type]?.ports ?? []).map((p) => ({ ...p, wired: wiredPorts.has(`${inst.id} ${p.name}`) }));
      const latBar = latBars.get(inst.id);
      // The ASSIGNED port positions for this node (R5, the port slide) — handles render at these px offsets and
      // the router below anchors from the SAME map, so wire and handle land on one row. Absent ⇒ fractions.
      const offs = portOffsets?.[inst.id];
      // The "!" flag lights on a violation or a saturated tier. WORST-CASE LOAD (owner ruling): a node saturated at
      // its declared peak now carries an ordinary saturation violation in `verds`, so `st === 'violation'` already
      // covers it — a node calm at the mean but over capacity at its worst window never reads green (one truth).
      const flag = st === 'violation' || sat !== undefined;
      const base: Node = { id: inst.id, type: 'sda', position, selected: inst.id === sel, data: { name: labelOf(inst.id, inst.type), desc: descOf(inst.id), id: inst.id, ty: inst.type, kind, chips, flag, ports, onPortAdd, ...(offs !== undefined ? { portOffsets: offs } : {}), ...(load ? { load } : {}), ...(latBar ? { lat: latBar, refreshing: busy === 'sim' } : {}) } };
      return g ? { ...base, parentId: g.id, extent: 'parent' as const } : base;
    });

    // R2 — the per-wire RATE + transform PILLS come from the SHARED presenter (edgeRates), so the web and the VS
    // Code webview draw the SAME numbers on the wire (anti-drift; doc: flow-transformations-r2 §2). The presenter
    // runs the engine's own applyTransform on the engine's served value — the web computes no rate arithmetic itself.
    const rates: EdgeRate[] = edgeRates({ instances: doc.instances, wires: doc.wires, catalog, value: okEv ? valueOf : null });
    // SMART EDGE ROUTING (edge-routing.ts): route every wire around the node + tidied-group boxes so a wire never
    // cuts through a component. Uses the canvas's MEASURED node sizes (falling back to the layout footprint) — the
    // same source Tidy reads. Toggled by `smartRoutes`; off ⇒ empty map ⇒ FlowEdge draws the default getSmoothStep.
    const routeSizes = new Map<string, { w: number; h: number }>();
    for (const n of nodes) {
      const w = n.measured?.width ?? n.width;
      const h = n.measured?.height ?? n.height;
      if (typeof w === 'number' && typeof h === 'number') routeSizes.set(n.id, { w, h });
    }
    const routeNodes = doc.instances.flatMap((inst) => {
      const at = doc.layout[inst.id];
      if (at === undefined) return [];
      const sz = routeSizes.get(inst.id) ?? FALLBACK_NODE;
      const offs = portOffsets?.[inst.id]; // the SAME assigned offsets the handles render at (one home)
      return [{ id: inst.id, box: { x: at.x, y: at.y, w: sz.w, h: sz.h }, ports: (catalog[inst.type]?.ports ?? []).map((p) => ({ name: p.name, dir: p.dir })), ...(offs !== undefined ? { portOffsets: offs } : {}) }];
    });
    const routes: Map<number, RoutedWire> = smartRoutes
      ? routeDesignEdges({
          nodes: routeNodes,
          wires: doc.wires,
          groups: doc.groups.map((g) => ({ id: g.id, rect: g.rect, members: g.members })),
        })
      : new Map<number, RoutedWire>();
    const flowEdges = doc.wires.map((w, i) => ({
      id: `w${i}`, source: w.from[0], target: w.to[0], sourceHandle: w.from[1], targetHandle: w.to[1], type: 'flow',
      // the packet dot's round-trip time ∝ the RESPONSE latency of the target (what the caller actually waits for
      // when it calls across this edge — its downstream included), not the target's own per-hop sojourn. So an edge
      // into a fast tier that itself calls a slow one reads slow too — consistent with the response the node's latency bar shows.
      data: {
        status: statusOf(w.to[0]), rate: valueOf(w.to[0], keys.throughput), latency: respByNode.get(w.to[0]),
        saturated: saturated.has(w.to[0]), from: w.from, to: w.to, semantics: w.semantics ?? 'sync',
        wire: i, pills: rates[i]?.pills ?? [], carried: rates[i]?.carried, onTransformClick,
        // The guarantee STRIP segment for this wire — present only when a declared
        // requirement's flow passes through it. Absent ⇒ the edge draws no strip (zero pixels; the no-filler rule).
        ...(guaranteeStripByWire.get(i) ? { guarantee: guaranteeStripByWire.get(i) } : {}),
        // The precomputed orthogonal route for this wire (avoids node + group boxes); absent ⇒ default edge look.
        ...(routes.get(i) ? { route: routes.get(i) } : {}),
      },
    }));
    // MERGE the freshly-derived nodes into React Flow's EXISTING ones BY ID — never a wholesale replace. A fresh node
    // object carries only OUR fields (position / selected / data); it lacks React Flow's internal state (`measured`
    // dimensions, `dragging`, positionAbsolute). This effect fires on every sim / busy / queue / latBar tick, so
    // replacing all nodes each time drops every node back to "uninitialised" for a frame — and a drag (or a just-added
    // node) in that window throws React Flow error #015 and BLANKS THE CANVAS (the owner's intermittent add / Tidy /
    // Improve crash — not a React throw, so the error boundary can't catch it). Spreading the OLD node first preserves
    // those RF-managed fields; we overlay the derived ones and hold a node the user is actively dragging at its live
    // position (never yank it back to the lagging layout mid-drag). New nodes pass through untouched (RF measures them);
    // removed nodes fall away (absent from the derived list).
    const derivedNodes = [...groupNodes, ...compNodes];
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return derivedNodes.map((d) => {
        const old = prevById.get(d.id);
        if (old === undefined) return d; // a NEW node — React Flow measures + initialises it
        // Keep the live node's React Flow state (spread OLD first): `measured` dimensions + `dragging` + internals, so
        // RF never treats it as uninitialised (→ error #015 → blank canvas on a drag). Overlay our derived fields, and
        // hold a node the user is actively dragging at its live position (never yank it to the lagging layout). The
        // handle-bounds staleness this could cause (edges anchoring off the port after a port slide) is corrected by
        // the updateNodeInternals effect below — one forces the port re-measure this merge deliberately avoids.
        return { ...old, ...d, position: old.dragging ? old.position : d.position };
      });
    });
    setEdges(flowEdges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // `rfi` is a dep so the port-"+" callback (`onPortAdd`, baked into node data) is rebuilt once the React Flow
    // instance is ready — else its closure captures the null `rfi` from first render and the "+" silently no-ops.
  }, [doc, ev, sel, localCost, queues, rfi, guaranteeStripByWire, latBars, busy, smartRoutes, portOffsets, peakByNode]);

  // PORT-SLIDE HANDLE RE-MEASURE — React Flow caches each node's handle (port) bounds and re-measures them only when
  // the node's SIZE changes, NEVER when a handle MOVES within a same-size node. Our ports slide (R5) and Tidy
  // re-places them, so after such a change RF's cached bounds are stale and every edge anchors a few px off its port
  // (the "connection lands beside the port, at an angle" bug). updateNodeInternals forces RF to re-read the handle DOM
  // so the anchor follows the moved port. Keyed on the port offsets + the design, so it fires exactly when a handle
  // can have moved — the counterpart to the node merge above, which deliberately preserves RF state (incl. the stale
  // bounds) to avoid the #015 blank-canvas crash.
  useEffect(() => {
    updateNodeInternals(doc.instances.map((i) => i.id));
    // Mirror the node-sync effect's triggers: any of these can resize a node (a chip / meter / latency bar appears)
    // or slide its ports, both of which move the handles. Re-measuring on the SAME set keeps the edge anchored on the
    // port after an ambient re-eval (sim / envelope tick) too — not only after an explicit port slide or design edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateNodeInternals, doc, ev, localCost, queues, latBars, busy, portOffsets, peakByNode]);

  // Surface WHY an illegal drag was refused (the engine knows: protocol mismatch). React Flow fires `onConnect`
  // ONLY for a VALID drop, but `onConnectEnd` for EVERY drag end — so a flag set in `onConnect` and checked in
  // `onConnectEnd` distinguishes "connected" from "refused". `onConnectStart` resets the flag per drag and
  // captures the source port's emitted protocols so the refusal toast can name them.
  const connectMade = useRef(false);
  const connectFromProtocols = useRef<string[] | null>(null);
  // The SOURCE port of the in-flight drag (node + port), captured so a drop on empty pane can open the
  // legality-filtered quick-add picker for exactly that port (drop-to-pick).
  const connectFromPort = useRef<{ node: string; port: string } | null>(null);
  const onConnect = (c: Connection) => {
    connectMade.current = true;
    if (c.source && c.target) studio.dispatch({ kind: 'connect', from: [c.source, c.sourceHandle ?? 'out'], to: [c.target, c.targetHandle ?? 'in'] });
  };
  const onConnectStart = (_: unknown, p: { nodeId: string | null; handleId: string | null; handleType: 'source' | 'target' | null }): void => {
    connectMade.current = false;
    // What the SOURCE port emits, so a refusal can name the protocols. A back-drag from a target handle has no
    // producer protocols to report — leave the list empty (still a port drag → generic message + tooltips).
    const man = p.nodeId ? manifestOf(p.nodeId) : undefined;
    const port = man?.ports.find((pp) => pp.name === p.handleId);
    connectFromProtocols.current = port && (port.dir === 'out' || port.dir === 'bi') ? [...(port.speaks ?? [])] : [];
    connectFromPort.current = p.nodeId && p.handleId ? { node: p.nodeId, port: p.handleId } : null;
  };
  // The drag ended. Three outcomes: a valid connection (onConnect already fired) — nothing to do; a drop ON an
  // incompatible PORT (a target handle) — the refusal toast, UNCHANGED (acceptance #5); a drop on the PANE (empty
  // canvas) — open the quick-add picker at the mouse for the source port's legal fits (drop-to-pick). React Flow
  // fires this even for a drop on a handle, so `.react-flow__handle` distinguishes a port drop from a pane drop.
  const onConnectEnd = (e: MouseEvent | TouchEvent): void => {
    if (connectMade.current || connectFromProtocols.current === null) { connectFromPort.current = null; return; }
    const spoken = connectFromProtocols.current;
    const from = connectFromPort.current;
    connectFromProtocols.current = null;
    connectFromPort.current = null;
    const tgt = e.target as HTMLElement | null;
    const onPane = tgt !== null && tgt.closest('.react-flow__handle') === null;
    if (onPane && from) {
      // Drop on empty canvas → the picker, filtered to what LEGALLY attaches to the source port (whatFits). An
      // empty list is shown honestly by the popover's empty-state ("nothing attaches to this port").
      const pt = 'clientX' in e ? { x: e.clientX, y: e.clientY } : { x: 0, y: 0 };
      setPicker({ x: pt.x, y: pt.y, options: pickerOptions(studio, catalog, from), context: from });
      return;
    }
    const detail = spoken.length ? ` This port speaks ${spoken.join(', ')}.` : '';
    setFixMsg(`Connection refused — those ports speak incompatible protocols.${detail} Hover a port to see what it accepts.`);
  };
  // A type was picked in the quick-add popover: place it at the drop point (screen→flow), or at the EXPLICIT
  // flow-space placement the port-"+" supplied, and — when the picker carried a port context — wire it with the
  // SAME rule the suggester uses (all through the shared presenter). Then run the post-insert overlap check.
  const onPick = (type: string): void => {
    if (!picker || !rfi) return;
    const flow = picker.place ?? rfi.screenToFlowPosition({ x: picker.x, y: picker.y });
    const r = addPickedComponent(studio, catalog, type, { x: Math.round(flow.x), y: Math.round(flow.y) }, picker.context);
    setPicker(null);
    if (r.ok) { setSel(r.id); offerTidyIfOverlapping(r.id); }
    else setFixMsg(r.error); // the tool must not lie about why an add was refused
  };
  // After a picker-driven insert, offer "Tidy?" if the NEW node's box intersects any other. Reads the
  // authoritative positions from the just-committed document (the layout is updated synchronously by dispatch;
  // the React Flow `nodes` state only catches up next render) and the MEASURED sizes from the current canvas
  // nodes, falling back to the layout footprint for the brand-new (unmeasured) node. Pure predicate, no reflow.
  const offerTidyIfOverlapping = (newId: string): void => {
    const project = studio.project();
    const measured = new Map<string, { w: number; h: number }>();
    for (const n of nodes) {
      const w = n.measured?.width ?? n.width;
      const h = n.measured?.height ?? n.height;
      if (typeof w === 'number' && typeof h === 'number') measured.set(n.id, { w, h });
    }
    const boxes: Record<string, Box> = {};
    for (const inst of project.instances) {
      const p = project.layout[inst.id] ?? { x: 0, y: 0 };
      const s = measured.get(inst.id) ?? FALLBACK_NODE;
      boxes[inst.id] = { x: p.x, y: p.y, w: s.w, h: s.h };
    }
    if (insertOverlaps(boxes, newId)) showTidyOffer();
  };
  // Open the picker with NO context (whole catalog) at a screen point — the ghost CTA, the N key, the palette.
  const openPicker = (x: number, y: number): void => setPicker({ x, y, options: pickerOptions(studio, catalog) });
  // The inline "+" on an OPEN port: open the SAME legality-filtered picker as drop-to-pick, anchored on
  // screen near the port, but with an EXPLICIT flow-space placement — to the RIGHT of the source for an out port,
  // to the LEFT for an in port, at the tidy column pitch (~340) and the source's y — so the pick lands like a tidy
  // column neighbour rather than under the popover. `dir` is the SOURCE port's flow direction.
  const onPortAdd = (nodeId: string, port: string, dir: 'out' | 'in'): void => {
    if (!rfi) return;
    const base = doc.layout[nodeId] ?? { x: 200, y: 160 };
    const place = { x: base.x + (dir === 'out' ? 340 : -340), y: base.y };
    // Anchor the popover near the source port on screen: the node's right/left edge, midway down (~36px).
    const w = nodes.find((n) => n.id === nodeId)?.measured?.width ?? 160;
    const anchorFlow = { x: dir === 'out' ? base.x + w + 12 : base.x - 12, y: base.y + 36 };
    const anchor = rfi.flowToScreenPosition(anchorFlow);
    setPicker({ x: anchor.x, y: anchor.y, options: pickerOptions(studio, catalog, { node: nodeId, port }), context: { node: nodeId, port }, place });
  };
  // A click on an edge transform PILL (R2; wire level §5): open the transform editor. An OUT-side pill edits
  // THAT WIRE (a routing split — the pill lives on the wire, the most natural place to declare "this edge carries
  // 70%"); an IN-side pill edits the target PORT (consumption shape is the receiver's, one per in-port). We pre-fill
  // the popover with the CURRENT effective transform, resolved with the SAME precedence the engine + presenter use.
  const onTransformClick = (wire: number, node: string, port: string, side: 'out' | 'in'): void => {
    const w = doc.wires[wire];
    const p = doc.layout[node] ?? { x: 200, y: 160 };
    const width = nodes.find((n) => n.id === node)?.measured?.width ?? 160;
    // anchor a touch to the right of the owning node, midway down — near the wire, clear of the pill itself.
    const anchor = rfi ? rfi.flowToScreenPosition({ x: p.x + width + 20, y: p.y + 40 }) : { x: 300, y: 300 };
    setSel(node);
    if (side === 'out' && w !== undefined) {
      // WIRE mode: resolve the wire's effective OUT transform (wire override > port default) to pre-fill.
      const current = resolveWireOutTransform(w, doc.instances.find((i) => i.id === w.from[0]), catalog[typeOf(w.from[0])], w.from[1]).transform ?? null;
      setTransformPop({ x: anchor.x, y: anchor.y, target: { mode: 'wire', from: w.from, to: w.to }, current });
      return;
    }
    const current = resolvePortTransform(doc.instances.find((i) => i.id === node), catalog[typeOf(node)], port) ?? null;
    setTransformPop({ x: anchor.x, y: anchor.y, target: { mode: 'port', node, port }, current });
  };
  // Open the transform editor from the INSPECTOR port row — always PORT mode (the row edits the port default; a
  // wire-level split is edited from its pill on the canvas). Anchored at the row's on-screen rect.
  const openTransformEditor = (node: string, port: string, anchor: { x: number; y: number }): void => {
    const current = resolvePortTransform(doc.instances.find((i) => i.id === node), catalog[typeOf(node)], port) ?? null;
    setTransformPop({ x: anchor.x, y: anchor.y, target: { mode: 'port', node, port }, current });
  };
  // Open the uncertainty ± RANGE editor from a Configuration knob's ± affordance.
  // Anchored at the button's on-screen rect; carries the knob's label/unit/point value + its current range (to seed).
  const openRangeEditor = (node: string, key: string, label: string, unit: string, point: number, current: Range | null, anchor: { x: number; y: number }): void => {
    setRangePop({ x: anchor.x, y: anchor.y, target: { node, key }, current, label, unit, point });
  };
  // The N key / palette open the picker at the canvas midpoint (its screen centre).
  const openPickerAtCenter = (): void => {
    const el = cvRef.current;
    const rect = el?.getBoundingClientRect();
    if (rect) openPicker(rect.left + rect.width / 2, rect.top + rect.height / 2);
    else openPicker((typeof window !== 'undefined' ? window.innerWidth : 1280) / 2, (typeof window !== 'undefined' ? window.innerHeight : 800) / 2);
  };

  // Delete via keyboard (Del/Backspace) or context — routed through the command core. Groups removed as
  // groups (members kept), components as nodes (their wires cleaned), edges as disconnects.
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
  // Reconnect: drag an edge endpoint to a different node/port → rewire (disconnect old, connect new).
  const onReconnect = (oldEdge: Edge, c: Connection) => {
    if (!c.source || !c.target) return;
    const d = oldEdge.data as { from?: readonly [string, string]; to?: readonly [string, string] } | undefined;
    if (d?.from && d?.to) studio.dispatch({ kind: 'disconnect', from: d.from, to: d.to });
    studio.dispatch({ kind: 'connect', from: [c.source, c.sourceHandle ?? 'out'], to: [c.target, c.targetHandle ?? 'in'] });
  };

  const onNodeDragStop = (_: unknown, n: Node) => {
    if (n.type === 'group') {
      studio.dispatch({ kind: 'moveGroup', id: n.id, x: n.position.x, y: n.position.y }); // members travel along
      return;
    }
    // a child node reports a parent-relative position — convert back to absolute for the document
    const parent = n.parentId ? doc.groups.find((g) => g.id === n.parentId) : undefined;
    const abs = parent ? { x: n.position.x + parent.rect.x, y: n.position.y + parent.rect.y } : { x: n.position.x, y: n.position.y };
    studio.dispatch({ kind: 'move', id: n.id, x: abs.x, y: abs.y });
    handMovedRef.current.add(n.id); // a deliberate hand-placement — Ideal layout will hold it as a pin (§5.3)
    if (!parent) {
      // a free node dropped inside a boundary is adopted by it
      const cx = abs.x + 80, cy = abs.y + 36;
      const into = doc.groups.find((g) => cx >= g.rect.x && cx <= g.rect.x + g.rect.w && cy >= g.rect.y && cy <= g.rect.y + g.rect.h);
      if (into) studio.dispatch({ kind: 'assignGroup', node: n.id, group: into.id });
    }
  };

  // Export = download the diffable JSON backup. Import = replace the project from a chosen file.
  const onExport = () => {
    const d = studio.project();
    downloadFile(`${d.name || 'design'}.sda.json`, serialize(d), 'application/json');
  };
  // The architect's DELIVERABLE, generated FROM the verified model by the SAME content functions the AI's
  // generate_doc calls (the web stays a dumb renderer — it computes nothing the engine didn't). The ONE input
  // both output formats read is built here; the two `onExportDoc*` entries just render it as HTML (the human
  // deliverable, primary) or Markdown (agents diff text, secondary). Returns null while the design has build
  // errors (nothing verified to document — the button is disabled anyway).
  const buildDesignDocInput = (): DesignDocInput | null => {
    if (!okEv) return null;
    const groups: DocGroup[] = doc.groups.map((g) => ({ id: g.id, label: g.label, members: g.members }));
    return {
      name: doc.name,
      instances: doc.instances,
      wires: doc.wires,
      groups,
      labels: doc.labels,
      descriptions: doc.descriptions,
      // The merged catalog unlocks the v2 assumptions register + risks (provenance is derived against the catalog);
      // the layout carries canvas positions into the DocModel's architecture view (R2 C4 SVG). Same wiring as MCP.
      catalog: studio.mergedCatalog(),
      layout: doc.layout,
      verdicts: verds, // REAL-aware: queueing latency + worst-case ρ≥1 saturation — the doc shows exactly what the canvas does
      value: (id, k) => okEv.value(NodeId(id), k),
      realLatencyByNode: graph ? Object.fromEntries(realLatByNode) : undefined,
      responseLatencyByNode: graph ? Object.fromEntries(respByNode) : undefined,
      // The saturated tiers, at the WORST load the environment produces: the steady ρ≥1 set PLUS any node the shaped
      // sweep found saturates at its worst window — so the doc's capacity table marks the same broken tier the
      // verdicts (and the canvas) do. No shape ⇒ just the steady set (byte-identical).
      saturated: [...new Set([...saturated.keys(), ...(peakByNode ? [...peakByNode].filter(([, p]) => p.rho >= 1).map(([id]) => id) : [])])],
      tail: sim ? { p50: sim.p50, p95: sim.p95, p99: sim.p99 } : undefined,
      // The retry outcome so §4 reports goodput vs offered + error rate when a policy is live.
      retry: sim && (sim.retryPolicy || sim.amplification > 1 || sim.errorRate > 0)
        ? { goodputRps: sim.goodput, errorRate: sim.errorRate, amplification: sim.amplification }
        : undefined,
      // Per-flow qualitative guarantee verdicts — the SAME `guaranteeVerdicts` the
      // System panel + the MCP read, so the deliverable's Guarantees section matches the live verdicts. Empty (no
      // requirement declared, or the graph is unavailable) ⇒ the section is omitted (the no-filler rule).
      guaranteeVerdicts: graph && doc.guaranteeSlos.length > 0
        ? guaranteeVerdicts(graph, studio.mergedCatalog(), doc.instances, doc.wires, (id, k) => okEv.value(NodeId(id), k), doc.guaranteeSlos).map(guaranteeVerdictRow)
        : undefined,
      // Per-flow LAG verdicts, RESOLVED by the sim when one has run — the SAME `lagV`
      // the System panel shows, so the exported doc's propagation-lag block matches the live surface. Empty ⇒ omitted.
      lagVerdicts: lagV.length > 0 ? lagV.map(lagVerdictRow) : undefined,
      // Per-node SIMULATED response percentiles — the DES tail for §4's requirement-
      // bearing-node table. Present only after a sim ran (the doc-model filters to nodes with a latency/tailLatency SLO).
      responsePercentilesByNode: sim ? Object.fromEntries(sim.nodeResponse.map((n) => [n.id, { mean: n.mean, p50: n.p50, p95: n.p95, p99: n.p99, samples: n.samples }])) : undefined,
      // The scenario-comparison section (assumption-model doc §8) — the ALREADY-computed ambient all-world evaluation
      // (envW.worlds, one EvaluateBatch) plus the declarations for the provenance mix. Only the base world (no named
      // worlds) ⇒ the doc-model omits the section (no-filler). Reusing envW keeps the doc identical to the System panel.
      worlds: envW.worlds ? { result: envW.worlds, scenarios: doc.scenarios } : undefined,
      // The declared SYSTEM promises (owner ruling: cost is for THE WHOLE SYSTEM) — §2/§3 render them scope-
      // labelled `system`, judged against the same whole-graph total the System panel shows.
      systemPromises: doc.systemPromises.length > 0 ? doc.systemPromises : undefined,
      // The §5 load→latency sweep — a set of forward evaluations at scaled offered load, computed FRESH here (never
      // persisted state). Guarded: only when the design has a traffic origin, so we never invent a workload. Same
      // pure builder every surface uses, over the merged catalog (built-ins + project custom).
      sweep: designHasOrigin ? buildLoadSweep({ instances: doc.instances, wires: doc.wires, registry, catalog: studio.mergedCatalog() }) : undefined,
      // The generation timestamp is minted ONLY here, at the surface — the model + renderers stay pure (no clock).
      generatedAt: new Date().toISOString(),
    };
  };
  // Primary: the HTML deliverable (self-contained, C4 SVG + charts + register) a senior architect hands to a review
  // board. Disabled while the design has build errors (nothing verified to document).
  const onExportDocHtml = () => {
    const input = buildDesignDocInput();
    if (!input) return;
    downloadFile(`${doc.name || 'design'}-design-doc.html`, renderDesignDocHtml(input), 'text/html');
  };
  // Secondary: the Markdown form (agents diff text; paste into an RFC / git). Same input, same numbers.
  const onExportDocMd = () => {
    const input = buildDesignDocInput();
    if (!input) return;
    downloadFile(`${doc.name || 'design'}-design-doc.md`, generateDesignDoc(input), 'text/markdown');
  };
  const onImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const r = deserialize(await file.text());
    // Import REPLACES the design but stays UNDOABLE — Ctrl+Z restores the pre-import work (never a silent wipe).
    if (r.ok) { studio.replaceDoc(r.value); setSel(null); setImportErr(null); }
    else setImportErr(r.error);
  };

  // palette filtering
  const types = Object.keys(catalog).sort();
  const kinds = [...new Set(types.map((t) => facetsOf(t).kind))].sort();
  // Facet tags stay tidy: each port contributes its NATURAL protocol (first of its list), not the whole
  // capability set — otherwise every service would match a dozen protocol filters.
  const protocolsOf = (t: string): string[] => (catalog[t]?.ports ?? []).map((p) => (p.dir === 'out' ? p.speaks?.[0] : p.accepts?.[0]) ?? p.accepts?.[0] ?? p.speaks?.[0]).filter((x): x is string => x !== undefined);
  const protocols = [...new Set(types.flatMap((t) => protocolsOf(t)))].sort();
  const toggle = (set: Set<string>, v: string, fn: (s: Set<string>) => void) => { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); fn(n); };
  const filtered = types.filter((t) => {
    const f = facetsOf(t);
    if (kindF.size && !kindF.has(f.kind)) return false;
    if (provF.size && !provF.has(f.provider)) return false;
    if (protoF.size && !protocolsOf(t).some((p) => protoF.has(p))) return false;
    if (query && !t.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });
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
  const addComp = (type: string) => {
    const id = mintId(facetsOf(type).kind);
    studio.dispatch({ kind: 'addComponent', id, type, x: 160 + (doc.instances.length % 4) * 60, y: 130 + (doc.instances.length % 5) * 60 });
    setSel(id);
  };
  // Drag a palette item onto the canvas → add it where dropped (uses the flow's screen→graph mapping).
  const onDrop = (e: RDragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/sda');
    if (!type || !rfi) return;
    const p = rfi.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const id = mintId(facetsOf(type).kind);
    studio.dispatch({ kind: 'addComponent', id, type, x: Math.round(p.x), y: Math.round(p.y) });
    const into = doc.groups.find((g) => p.x >= g.rect.x && p.x <= g.rect.x + g.rect.w && p.y >= g.rect.y && p.y <= g.rect.y + g.rect.h);
    if (into) studio.dispatch({ kind: 'assignGroup', node: id, group: into.id });
    setSel(id);
  };

  // Engine-backed "propose the next logical element": suggestions for the selected node's open ports.
  const suggestions = useMemo(() => (sel ? suggestFor(studio, catalog, candidates, sel) : []), [doc, sel, studio, catalog, candidates]);
  const addSuggestion = (s: Suggestion, type: string) => {
    if (!sel) return;
    const target = matchingPort(catalog, type, s);
    if (!target) return;
    const id = mintId(facetsOf(type).kind);
    const base = doc.layout[sel] ?? { x: 280, y: 240 };
    const downstream = s.dir === 'out' || s.dir === 'bi';
    // Adding a suggested component AND wiring it is ONE user action — apply both as a single undoable unit, so a
    // single Undo removes the node and its wire together (matching Improve/Compare Apply; not two Undo presses).
    const connect = downstream
      ? { kind: 'connect' as const, from: [sel, s.port] as [string, string], to: [id, target] as [string, string] }
      : { kind: 'connect' as const, from: [id, target] as [string, string], to: [sel, s.port] as [string, string] };
    studio.dispatchBatch([{ kind: 'addComponent', id, type, x: base.x + (downstream ? 260 : -260), y: base.y + 130 }, connect]);
    setSel(id);
  };

  // The selection, resolved once — the Inspector renders it; the shortcuts / context menu / addGroup read it too.
  const selInst = sel ? doc.instances.find((i) => i.id === sel) : undefined;
  const selMan = selInst ? catalog[selInst.type] : undefined;
  const selGroup = sel ? doc.groups.find((g) => g.id === sel) : undefined;

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

  // The canvas's MEASURED node footprints (tall meter/chip nodes) — the same source Tidy reads, so the ideal search
  // scores what actually ships. Falls back to the layout footprint for a just-inserted (unmeasured) node.
  const measuredSizes = (): Record<string, { w: number; h: number }> => {
    const sizes: Record<string, { w: number; h: number }> = {};
    for (const n of nodes) {
      const w = n.measured?.width ?? n.width;
      const h = n.measured?.height ?? n.height;
      if (typeof w === 'number' && typeof h === 'number') sizes[n.id] = { w, h };
    }
    return sizes;
  };
  // The background scheduler (doc §3.6): run ONE search slice per animation frame so the polisher never blocks the
  // canvas (idle = zero — the loop stops the instant the search rests or is superseded).
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
  // Apply a polished placement with a smooth position MORPH as ONE undoable edit (doc §3.6): flip on the transition
  // class, dispatch every move + the group boxes hugged to the new member positions in a SINGLE batch (one undo
  // frame), then re-fit. Nothing is applied if the placement did not actually move anything (no pointless undo).
  const applyIdeal = (placement: Placement, offsets: PortOffsets, design: ReturnType<typeof toLayoutDesign>): void => {
    setPortOffsets(offsets); // the winner's slide always lands — even when no BOX moved, the PORTS may have
    const cur = studio.project().layout;
    const moved = Object.entries(placement).filter(([id, p]) => {
      const c = cur[id];
      return c === undefined || Math.round(c.x) !== Math.round(p.x) || Math.round(c.y) !== Math.round(p.y);
    });
    if (moved.length === 0) return; // already optimal — the instant Tidy was already the best layout
    setMorphing(true);
    const cmds = moved.map(([id, p]) => ({ kind: 'move' as const, id, x: Math.round(p.x), y: Math.round(p.y) }));
    const rectCmds = groupRects(design, placement).map((g) => ({ kind: 'resizeGroup' as const, id: g.id, x: Math.round(g.rect.x), y: Math.round(g.rect.y), w: Math.round(g.rect.w), h: Math.round(g.rect.h) }));
    studio.dispatchBatch([...cmds, ...rectCmds]);
    if (morphTimer.current !== undefined) clearTimeout(morphTimer.current);
    morphTimer.current = setTimeout(() => setMorphing(false), 520);
    setTimeout(() => rfi?.fitView({ padding: 0.15, duration: 420 }), 40);
  };
  // '✨ Ideal layout': Tidy instantly (the floor), then polish in the background and morph to the
  // better layout. HAND-PLACED nodes (diverged from Tidy of the current topology) are inferred as PINS and held —
  // the polisher lays out only around them, never fighting a deliberate placement (§5.3). Seeded ⇒ same design →
  // same layout (§5.2). A fresh click supersedes an in-flight polish (latest-wins).
  const idealLayout = (): void => {
    if (doc.instances.length === 0) return;
    const sizes = measuredSizes();
    // CATALOG ports ride the design (R5): the layout anchors at the handles THIS canvas renders, never at
    // wire-derived fractions that put a partially-wired multi-port side somewhere else (the multi-out jog).
    const design = toLayoutDesign({ instances: doc.instances, wires: doc.wires, groups: doc.groups }, sizes, catalogPorts);
    const stored = studio.project().layout; // hold hand-placed nodes at exactly where the architect dropped them
    const pins = new Set([...handMovedRef.current].filter((id) => stored[id] !== undefined));
    // Instant floor: Tidy the FREE nodes (pinned nodes keep their hand position), so the canvas improves at once.
    const { pos, rects } = tidyLayout(doc.instances, doc.wires, doc.groups, sizes);
    const floor = [
      ...Object.entries(pos).filter(([id]) => !pins.has(id)).map(([id, p]) => ({ kind: 'move' as const, id, x: p.x, y: p.y })),
      ...Object.entries(rects).map(([gid, r]) => ({ kind: 'resizeGroup' as const, id: gid, x: r.x, y: r.y, w: r.w, h: r.h })),
    ];
    if (floor.length > 0) studio.dispatchBatch(floor);
    // The floor's PORT SLIDE (R5): assign offsets on the geometry the floor just applied (a pinned node keeps its
    // hand position — its ports still slide: position is node-level, ports are ours).
    const floorPlacement: Record<string, { x: number; y: number }> = {};
    for (const inst of doc.instances) {
      const at = pins.has(inst.id) ? stored[inst.id] : (pos[inst.id] ?? stored[inst.id]);
      if (at !== undefined) floorPlacement[inst.id] = at;
    }
    setPortOffsets(acceptedPortOffsets(design, floorPlacement, sizes));
    setTimeout(() => rfi?.fitView({ padding: 0.15, duration: 400 }), 60);
    // Background polish (latest-wins): supersede any running polish, then search around the pins.
    polisherRef.current?.cancel();
    const polisher = createPolisher(
      { onPhase: setPolishPhase, onDone: (r) => applyIdeal(r.placement, r.portOffsets, design) },
      rafSchedule,
    );
    polisherRef.current = polisher;
    const baseOptions = { seed: 1, sizes, pins, anchors: stored, budgetMs: 2500 };
    // THE GPU PROPOSER. When a real WebGPU device is present, inject the fp32
    // straight-line proxy as the beam's batch scorer: it RANKS candidates fast (the kernel's device-faithful twin;
    // a card, when present, is the proven-equivalent accelerator for large batches at 50+ nodes). The CPU still
    // routes + re-scores every survivor and the winner EXACTLY, so this NEVER changes the applied layout — on these
    // designs it is byte-identical to the CPU-only search — it only speeds the proposal at scale. Lazily imported so
    // the WebGPU driver stays out of the entry bundle. Absent a device (or on any failure) the CPU-exact scorer runs.
    void (async () => {
      let batchScore: import('@sda/presenter').BatchScorer | undefined;
      try {
        const gpu = await loadLayoutGpu();
        if (await gpu.probeLayoutGpu()) batchScore = gpu.makeLayoutBatchScorer(design, { sizes }).batchScore;
      } catch {
        batchScore = undefined; // best-effort beauty: the CPU-exact scorer produces the identical layout
      }
      if (polisherRef.current !== polisher) return; // superseded while the proposer loaded — drop this request
      polisher.request({ design, options: batchScore !== undefined ? { ...baseOptions, batchScore } : baseOptions });
    })();
  };
  useEffect(() => () => polisherRef.current?.cancel(), []); // idle = zero: stop any polish on unmount

  // Auto-fix = run the design backwards: free the provisioning knobs and let the solver find the change
  // that meets every SLO, then apply it as commands. As of the DEFAULT is the native in-process
  // solver (no MiniZinc WASM fetch); the MiniZinc/HiGHS path stays selectable as the rollback and referees in CI.
  // The knobs the backward-search may vary come from the shared `provisioningTunables` (content) over the
  // built graph — one source of truth with the MCP tools and synthesize (no per-surface re-derivation).
  const [fixMsg, setFixMsg] = useState<string | null>(null);
  // The ONE backward-solve action. repair = make it meet every SLO (the old "Auto-fix"); optimize =
  // cheapest / fastest under every SLO. It produces a LEGIBLE result (verdict + before→after) the panel renders —
  // no silent toast. `goalArg` lets the status-bar Fix→ CTA force 'feasible' without waiting on a state update.
  const runImprove = async (goalArg: ImproveGoal = goal): Promise<void> => {
    const g = goalArg;
    // Solve the SAME reality the panel shows — the graph OVERLAID with the active world (graphR), not the base
    // (studio.graph()). Else Improve sizes the base (feasible) and reports "already meets every SLO" while the
    // pessimistic world the user is viewing still violates — a lie (owner, 2026-07-11). No active world ⇒ base.
    const gr = graphR;
    if (!gr.ok) { setImprove({ goal: g, status: 'error', message: 'Design has build errors — resolve those first.', changes: [] }); return; }
    const graph = gr.value;
    const tunables = provisioningTunables(graph);
    if (tunables.length === 0) { setImprove({ goal: g, status: 'error', message: 'No tunable provisioning knobs (concurrency / replicas / units) in this design — nothing to size.', changes: [] }); return; }
    const sink = doc.instances.find((i) => (i.bands?.length ?? 0) > 0)?.id ?? doc.instances.at(-1)?.id;
    setBusy('opt');
    try {
      // The backward solve goes through the composition root (SolverBindings, the solver contract): it binds
      // the native in-process solver by default (MiniZinc/HiGHS on rollback), so switching the runtime is a
      // change there, not here. Search failures come back as the honesty triad (`infeasible` /
      // `did-not-converge`), which we map to the SAME messages Improve showed before.
      const solvers = await bindBrowserSolvers(registry);
      // Capacity headroom: size each tier to ρ ≤ TARGET_UTILIZATION so the result has FINITE latency, not the
      // ρ=1 knife-edge (throughput met, queue unbounded). Solver-only — the forward-pass verdicts are unchanged.
      const headroom = { key: keys.throughput, factor: TARGET_UTILIZATION };
      // The declared SYSTEM promises ride the search as whole-graph SUM bands (owner ruling: cost is for THE
      // WHOLE SYSTEM) — Improve must land INSIDE the declared system ceiling, or decline/escalate honestly.
      const sysBands = systemBandsOf(doc.systemPromises);
      const systemBands = sysBands.length > 0 ? { systemBands: sysBands } : {};
      // Any non-solved outcome — whether the model proved INFEASIBLE or the solver TIMED OUT
      // (did-not-converge) — first tries to explain the infeasibility. The relaxed model used by
      // explainInfeasible is always satisfiable (soft penalties absorb any shortfall), so a non-empty
      // shortfall set is a real "no sizing can meet this SLO" answer regardless of the outcome kind.
      // Only if it yields nothing actionable do we surface the raw "did not converge" message.
      const explainFailure = async (rawMessage: string): Promise<ImproveResult> => {
        let shortfalls: NonNullable<ImproveResult['shortfalls']> = [];
        try {
          const ex = await solvers.explainInfeasible!({ graph, tunables });
          if (ex.kind === 'solved') shortfalls = ex.value.map((s) => ({ node: String(s.node), key: String(s.key), bound: s.bound, amount: s.amount }));
        } catch { /* explainInfeasible can itself time out / reject — fall back to the raw message */ }
        if (shortfalls.length === 0) return { goal: g, status: 'error', message: rawMessage, changes: [] };
        const lead = shortfalls[0]!;
        const amount = Math.round(lead.amount * 100) / 100;
        return {
          goal: g,
          status: 'infeasible',
          message: `No setting of the knobs can meet every SLO. Shortfall: ${lead.key} at ${lead.node} short by ${amount} (${lead.bound}). The fix is a structural change (swap a faster/cheaper component or add a tier/replica), not just sizing.`,
          changes: [],
          shortfalls,
        };
      };
      // The two honest failure messages the engine facade used to return as error strings (kept verbatim so the
      // Improve panel reads identically now that the typed kinds replace the strings).
      const INFEASIBLE_MSG = 'no configuration of the tunables can satisfy every SLO (proven infeasible — use explainInfeasible for the exact shortfall)';
      const DID_NOT_CONVERGE_MSG = 'the search did not converge within the time limit — simplify the design (fewer free knobs) or set the knobs manually';
      const failMessage = (kind: 'infeasible' | 'did-not-converge'): string => (kind === 'infeasible' ? INFEASIBLE_MSG : DID_NOT_CONVERGE_MSG);
      // HONEST ESCALATION (docs: honest escalation): when the native in-process solver declines a budget-coupled
      // trade-off, rerun the SAME request on the exact reference MIP — the vendored MiniZinc/HiGHS WASM, reached
      // through the composition root's `incumbent` mode (imported LAZILY, only here, only on a decline; bundle
      // separation stays green). Its answer is used and LABELED, so the design is never a dead end while we ship the
      // solver of record. The extended guidance (loosen the ceiling) is the fallback only if even the MIP cannot.
      let incumbentP: Promise<SolverBindings> | undefined;
      const resolveReference = (): Promise<SolverBindings> => (incumbentP ??= bindBrowserSolvers(registry, 'incumbent'));
      const LOOSEN_HINT = 'loosen or remove the budget-style ceiling (the cost limit forcing the trade-off) so Improve can find the true minimal cost — then compare it to your budget, or set the knobs manually';
      if (g === 'feasible') {
        const native = await solvers.repair!({ graph, tunables, headroom, ...systemBands });
        const esc = await withBudgetEscalation(native, async (signal) => (await resolveReference()).repair?.({ graph, tunables, headroom, signal, ...systemBands }));
        const engine: SearchEngine = esc.via === 'escalated' ? 'reference-mip' : 'native';
        const r = esc.result;
        if (r.kind !== 'solved') {
          if (esc.via !== 'native') { setImprove({ goal: g, status: 'error', message: `A budget ceiling binds against this goal — ${LOOSEN_HINT}.`, changes: [] }); return; }
          setImprove(await explainFailure(failMessage(r.kind))); return;
        }
        const basis = engine === 'reference-mip' ? { basis: REFERENCE_MIP_BASIS } : {};
        if (r.value.length === 0) {
          // The solver proposed NO sizing change. That is "already meets every SLO" ONLY if the reality on screen
          // (verds — the active world, INCLUDING the DES tail + saturation the sizing solver cannot touch) is truly
          // clean. If violations REMAIN, sizing cannot clear them — say so honestly, never claim a false success.
          const world = activeWorld ? ` in world “${activeWorld.name ?? activeWorld.id}”` : '';
          const remaining = verds.filter((v) => v.status === 'violation').length;
          if (remaining > 0) {
            setImprove({ goal: g, status: 'infeasible', message: `Sizing the provisioning knobs did not clear ${remaining} problem${remaining === 1 ? '' : 's'}${world} — ${remaining === 1 ? 'it needs' : 'they need'} a structural change (a faster component or another tier/replica), not just sizing. See the Problems tab.`, changes: [] });
            return;
          }
          setImprove({ goal: g, status: 'noop', message: `Already meets every SLO${world} — nothing to change.`, changes: [], ...basis });
          return;
        }
        setImprove({ goal: g, status: 'solved', message: 'Meets every SLO with the minimal sizing change.', changes: r.value.map((c) => ({ node: String(c.node), key: String(c.key), from: c.from, to: c.to })), ...basis });
        return;
      }
      const objKey: Key = g === 'cheapest' ? keys.cost : keys.throughput;
      const direction = g === 'cheapest' ? ('min' as const) : ('max' as const);
      if (!sink) { setImprove({ goal: g, status: 'error', message: 'No target node to optimise.', changes: [] }); return; }
      const objective = { node: NodeId(sink), key: objKey, direction } as const;
      const native = await solvers.optimize!({ graph, tunables, objective, headroom, ...systemBands });
      const esc = await withBudgetEscalation(native, async (signal) => (await resolveReference()).optimize?.({ graph, tunables, objective, headroom, signal, ...systemBands }));
      const engine: SearchEngine = esc.via === 'escalated' ? 'reference-mip' : 'native';
      const r = esc.result;
      if (r.kind !== 'solved') {
        if (esc.via !== 'native') { setImprove({ goal: g, status: 'error', message: `A budget ceiling binds against this goal — ${LOOSEN_HINT}.`, changes: [] }); return; }
        setImprove(await explainFailure(failMessage(r.kind))); return;
      }
      const basis = engine === 'reference-mip' ? { basis: REFERENCE_MIP_BASIS } : {};
      const changes = r.value.assignments
        .map((a) => ({ node: String(a.node), key: String(a.key), from: valueOf(String(a.node), a.key) ?? NaN, to: a.value }))
        .filter((c) => Math.abs(c.to - c.from) > 1e-6);
      const objectiveView = { label: g === 'cheapest' ? 'Cost' : 'Throughput', key: String(objKey), before: valueOf(sink, objKey), after: r.value.value(NodeId(sink), objKey) };
      // Same honesty guard as repair: an optimum with NO effective change is "meets every SLO" only if the reality on
      // screen (verds — active world + DES tail + saturation, which the sizing solver can't touch) is truly clean.
      const remaining = verds.filter((v) => v.status === 'violation').length;
      if (changes.length === 0 && remaining > 0) {
        const world = activeWorld ? ` in world “${activeWorld.name ?? activeWorld.id}”` : '';
        setImprove({ goal: g, status: 'infeasible', message: `Already at the ${g === 'cheapest' ? 'cheapest' : 'fastest'} feasible sizing, but ${remaining} problem${remaining === 1 ? '' : 's'}${world} remain that sizing can't clear — a structural change (a faster component or another tier/replica) is needed. See the Problems tab.`, changes: [], objective: objectiveView });
        return;
      }
      setImprove({ goal: g, status: 'solved', message: 'Meets every SLO.', changes, objective: objectiveView, ...basis });
    } catch (e) {
      setImprove({ goal: g, status: 'error', message: `The in-browser solver needs cross-origin isolation (COOP/COEP): ${String(e)}`, changes: [] });
    } finally {
      setBusy('');
    }
  };
  /** Apply the proposed sizing as config commands, then return to the live view to read the result. */
  const applyImprove = (): void => {
    if (!improve) return;
    // ONE undoable action: the optimizer resizes several knobs together, so a single Undo restores the whole
    // prior verified design — never a hybrid where only some tiers reverted.
    studio.dispatchBatch(
      improve.changes.map((c) => {
        return { kind: 'setConfig' as const, node: c.node, key: c.key, value: quantizeKnob(c.key, c.to) };
      }),
    );
    setImprove(null);
    setLens('system');
  };

  // Right-click context menu (node / edge / group / empty pane) + the actions it offers.
  const closeMenu = () => setMenu(null);
  const onNodeCtx = (e: RMouseEvent, n: Node) => { e.preventDefault(); setSel(n.id); setMenu({ x: e.clientX, y: e.clientY, kind: n.type === 'group' ? 'group' : 'node', id: n.id }); };
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
  const ctxDuplicate = (id: string) => { const inst = doc.instances.find((i) => i.id === id); if (!inst) return; const nid = mintId(facetsOf(inst.type).kind); studio.dispatch({ kind: 'duplicateNode', id, newId: nid, dx: 40, dy: 40 }); setSel(nid); };
  const ctxWrap = (id: string) => { const gid = mintGroupId(); const p = doc.layout[id] ?? { x: 200, y: 160 }; studio.dispatch({ kind: 'addGroup', id: gid, label: 'New group', x: p.x - 40, y: p.y - 70, w: 280, h: 220 }); studio.dispatch({ kind: 'assignGroup', node: id, group: gid }); setSel(gid); };
  const ctxRename = (id: string) => { setSel(id); setTimeout(() => { nameRef.current?.focus(); nameRef.current?.select(); }, 0); };

  // Block illegal drags at connect time: producer→consumer with protocol-compatible ports (verify, don't guess).
  const isValidConnection = (c: Connection | Edge): boolean => {
    if (!c.source || !c.target || c.source === c.target) return false;
    const sm = manifestOf(c.source);
    const tm = manifestOf(c.target);
    const sp = sm?.ports.find((p) => p.name === c.sourceHandle);
    const tp = tm?.ports.find((p) => p.name === c.targetHandle);
    if (!sp || !tp) return true; // unknown ports → don't block
    if (!(sp.dir === 'out' || sp.dir === 'bi') || !(tp.dir === 'in' || tp.dir === 'bi')) return false;
    // Both sides are SETS: a producer can emit several protocols (a function calls any backend), a consumer
    // accepts several (a Lambda is invoked by HTTP OR by an SQS/SNS event). The ONE engine predicate decides.
    return portsConnect(sp.speaks ?? [], tp.accepts ?? [], protocolCompat);
  };

  // The DES (time engine) over the current design → true tail latency. Runs SILENTLY in the background (no
  // toasts) so it can auto-refresh on every design change without nagging; the panel shows the state inline.
  // It runs in a WEB WORKER (see sim-worker.ts): a synchronous simulate() at a high request rate costs tens of
  // seconds of CPU and froze the whole tab (the same bug froze the entire VS Code window in the sibling shell,
  // where this fix landed first). LATEST-WINS: a newer design terminates the stale run — its result would
  // describe a design that no longer exists.
  const simWorkerRef = useRef<Worker | null>(null);
  const runSimulate = (): void => {
    const g = studio.graph();
    if (!g.ok) { setSim(null); return; }
    try {
      const net = toQueueingNetwork(g.value);
      if (net.arrivals.length === 0) { setSim(null); return; }
      setBusy('sim');
      // FLOW-SCOPED LAG: hand the declared (source, terminal) pairs to the worker so
      // the one run also samples each async-inclusive journey (undeclared ⇒ [] ⇒ the run is byte-identical).
      const lagPairs = studio.project().lagSlos.map((s) => ({ source: s.source, terminal: s.terminal }));
      if (simWorkerRef.current !== null) simWorkerRef.current.terminate(); // supersede the in-flight run
      const w = new Worker(new URL('./sim-worker.ts', import.meta.url), { type: 'module' });
      simWorkerRef.current = w;
      w.onmessage = (e: MessageEvent<import('./sim-worker').SimWorkerResponse>) => {
        if (simWorkerRef.current !== w) return; // superseded while the message was in flight
        simWorkerRef.current = null;
        w.terminate();
        const d = e.data;
        // Per-node response tails + declared lags (doc §4, §3) ride the tail so the shared presenter reads them (the
        // chip / System rows / per-node tail verdict, sink-gate dropped). NaN inside them = honest `unknown` upstream.
        setSim(d.ok ? { mean: d.mean, p50: d.p50, p95: d.p95, p99: d.p99, rate: d.rate, goodput: d.goodput, errorRate: d.errorRate, amplification: d.amplification, retryPolicy: d.retryPolicy, stations: [...d.stations], nodeResponse: [...d.nodeResponse], pairLag: [...d.pairLag] } : null);
        setBusy('');
      };
      w.onerror = () => { if (simWorkerRef.current === w) simWorkerRef.current = null; w.terminate(); setSim(null); setBusy(''); };
      w.postMessage({ net, ...(lagPairs.length > 0 ? { lagPairs } : {}) });
    } catch { setSim(null); setBusy(''); }
  };

  // THE AMBIENT TWO-TIER runner — same worker discipline as runSimulate (off-thread,
  // latest-wins, terminate the superseded run), but AMBIENT: no button. When a generator declares cycles it posts
  // the graph to two-tier-worker.ts, which runs the live Tier-1 sweep (preview) then the Tier-2 DES refine
  // (confirm) and posts each back. A flat/disabled design (no shaped origin) clears the block (no-filler).
  const twoTierWorkerRef = useRef<Worker | null>(null);
  const runTwoTier = (): void => {
    const g = studio.graph();
    if (!g.ok || shapedOriginsOf(g.value).length === 0) { setTwoTier(null); return; } // no shaped generator ⇒ nothing to show
    try {
      if (twoTierWorkerRef.current !== null) twoTierWorkerRef.current.terminate(); // supersede the in-flight run
      const w = new Worker(new URL('./two-tier-worker.ts', import.meta.url), { type: 'module' });
      twoTierWorkerRef.current = w;
      w.onmessage = (e: MessageEvent<import('./two-tier-worker').TwoTierWorkerResponse>) => {
        if (twoTierWorkerRef.current !== w) return; // superseded while the message was in flight (a newer design)
        // The worker posts a `preview` (Tier-1) then a `final` (Tier-2-confirmed) — the resting handshake. Keep the
        // worker alive across the preview; clear the ref only on the terminal message.
        setTwoTier(e.data.ok ? e.data.result : null);
        if (!e.data.ok || e.data.phase === 'final') { if (twoTierWorkerRef.current === w) twoTierWorkerRef.current = null; w.terminate(); }
      };
      w.onerror = () => { if (twoTierWorkerRef.current === w) twoTierWorkerRef.current = null; w.terminate(); setTwoTier(null); };
      w.postMessage({ graph: g.value });
    } catch { setTwoTier(null); }
  };

  // Auto-run the backward solve when deep-linked via ?mode=optimize (the System view computes instantly).
  useEffect(() => { if (lens === 'optimize') void runImprove(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // The simulated tail runs in the BACKGROUND (no button): debounced after each design change while the System
  // view is open, so p50/p95/p99 are always shown without asking. The instant metrics never wait on it.
  useEffect(() => {
    if (lens !== 'system' || !drawerOpen) return;
    const t = setTimeout(() => runSimulate(), 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, lens, drawerOpen]);

  // THE AMBIENT TWO-TIER TRANSIENT — the resting refine: debounced a touch after the sim so
  // it fires as the design settles, off-thread, latest-wins, idle = zero work. `runTwoTier` self-gates on a shaped
  // generator (no cycles ⇒ the block clears — no-filler). Terminated on unmount.
  useEffect(() => {
    if (lens !== 'system' || !drawerOpen) return;
    const t = setTimeout(() => runTwoTier(), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, lens, drawerOpen, activeWorld]);
  useEffect(() => () => twoTierWorkerRef.current?.terminate(), []);

  // ── AMBIENT UNCERTAINTY LOOP ───────────────────────────────────────────────────────────────────────
  // Monte Carlo recomputes in a PERSISTENT worker (off-thread), continuously on every design change, LATEST-WINS
  // (a newer epoch supersedes the stale run's result AND aborts its GPU/CPU work), idle = ZERO work (no polling —
  // the effect below arms one debounce per change and disarms on cleanup). It runs ONLY when the design declares a
  // range (no-filler: with none the loop never even spawns) and the System panel is open. THE RESTING HANDSHAKE:
  // a `gpu` run renders as an fp32 `preview` cloud, then a `cpu` confirmation pass at the SAME seed stamps
  // `confirmed` (fp64, verdict-grade) — so fp32 is never presented as final truth (AC#6). If a `gpu` run falls
  // back to CPU (no device), that result is ALREADY fp64, so it is tagged `confirmed` and GPU is not tried again.
  const uncWorkerRef = useRef<Worker | null>(null);
  const uncEpochRef = useRef(0);
  const gpuMaybeRef = useRef(true); // attempt the GPU until a run proves there is no device here
  const AMBIENT_N = 500; // a modest scenario count for a real-time cadence; the MCP run_uncertainty is the full-N re-run

  const postUnc = (mode: 'gpu' | 'cpu', seed: number, epoch: number): void => {
    const g = studio.graph();
    if (!g.ok) return;
    const proj = studio.project();
    // Center the sample on the ACTIVE world (doc §6 — "a range is a cloud around a point"): its fact-assumption
    // overrides become the point the ranges blur around. No active world (or under request classes, which have no
    // world lens) ⇒ the base design, bit-for-bit today.
    const activeId = studio.activeScenario();
    const scenario = proj.requestClasses.length === 0 && activeId !== undefined ? proj.scenarios.find((s) => s.id === activeId) : undefined;
    if (uncWorkerRef.current === null) {
      const w = new Worker(new URL('./uncertainty-worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<import('./uncertainty-worker').UncWorkerResponse>) => {
        const d = e.data;
        if (d.epoch !== uncEpochRef.current) return; // superseded by a newer design — drop
        if (!d.ok) return; // a transient error: keep the last good numbers rather than blanking the block
        if (d.mode === 'gpu' && d.backend === 'gpu') {
          // The fp32 preview cloud — then confirm on the CPU at the SAME seed (the resting handshake).
          setUnc({ result: d.result, state: 'preview', backend: 'gpu', elapsedMs: d.elapsedMs });
          postUnc('cpu', d.result.seed, d.epoch);
        } else {
          if (d.mode === 'gpu' && d.backend === 'cpu') gpuMaybeRef.current = false; // no device here — stop trying GPU
          setUnc({ result: d.result, state: 'confirmed', backend: 'cpu', elapsedMs: d.elapsedMs });
        }
      };
      w.onerror = () => {}; // keep the last result; the loop retries on the next edit
      uncWorkerRef.current = w;
    }
    uncWorkerRef.current.postMessage({ epoch, mode, graph: g.value, instances: proj.instances, wires: proj.wires, n: AMBIENT_N, seed, ...(scenario ? { scenario } : {}) });
  };

  const runUncertaintyAmbient = (): void => {
    const proj = studio.project();
    if (!hasRanges(proj.instances)) { setUnc(null); return; } // no-filler: nothing ranged ⇒ nothing to model
    const g = studio.graph();
    if (!g.ok) { setUnc(null); return; }
    const epoch = ++uncEpochRef.current;
    setUnc((prev) => (prev ? prev : { result: null, state: 'computing' })); // show 'computing' only on the very first pass
    postUnc(gpuMaybeRef.current ? 'gpu' : 'cpu', DEFAULT_SEED, epoch);
  };

  // Arm the ambient loop on every design change while the System panel is open (idle = zero work: no timer when
  // nothing changes). Only when a range is declared — otherwise the worker never even spawns.
  useEffect(() => {
    if (lens !== 'system' || !drawerOpen) return;
    if (!hasRanges(doc.instances)) { setUnc(null); return; }
    const t = setTimeout(() => runUncertaintyAmbient(), 500);
    return () => clearTimeout(t);
    // `active` is a dep so switching the world lens RE-CENTERS the cloud on the newly-active world (doc §6).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, lens, drawerOpen, active]);

  // Terminate the ambient worker on unmount (it holds the WebGPU device).
  useEffect(() => () => uncWorkerRef.current?.terminate(), []);

  // ── AMBIENT ENVELOPE + WORLDS LOOP ───────────────────────────────────────────
  // On every design change while the System panel is open, recompute the capacity ENVELOPE (native `optimize`) and,
  // when named worlds are declared, the all-world MATRIX (native `evaluateBatch`) — both in-process (ms-grade), no
  // worker needed. LATEST-WINS by epoch (a newer design supersedes a stale run). Between the two, RE-TRACK the
  // live-derived scenario values against the fresh envelope (reconcileDerivedScenarios) so a `derived` value always
  // reads a true fraction of current capacity. Worlds/envelope decline under request classes (class-blind), exactly
  // as the MCP does — so a class-declared design shows neither, honestly.
  useEffect(() => {
    if (lens !== 'system' || !drawerOpen) return;
    const proj = studio.project();
    if (proj.requestClasses.length > 0) { setEnvW({ env: null, worlds: null, computing: false }); return; }
    const epoch = ++envEpochRef.current;
    setEnvW((p) => ({ ...p, computing: true }));
    const t = setTimeout(async () => {
      const solvers = await bindBrowserSolvers(registry);
      if (epoch !== envEpochRef.current || solvers.optimize === undefined) return;
      const catalog = studio.mergedCatalog();
      const env = await computeEnvelope({ instances: proj.instances, wires: proj.wires, registry, catalog }, solvers.optimize);
      if (epoch !== envEpochRef.current) return;
      // Re-track the live-derived values (frozen/architect ones are preserved) before evaluating the worlds.
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
  }, [doc, lens, drawerOpen]);

  // "Do it for me" (doc §5) — derive the pessimistic/real/optimistic trio from THIS design's envelope, badged
  // `derived`, preserving any value the architect already froze. Honest no-op when there is nothing to derive from
  // (the envelope section shows the reason). One undoable batch.
  const deriveTrio = async (): Promise<void> => {
    setDeriveNote(null);
    const proj = studio.project();
    if (proj.requestClasses.length > 0) { setDeriveNote('Worlds are unavailable under request classes — they are computed class-blind. Remove the request classes to derive a trio.'); return; }
    const solvers = await bindBrowserSolvers(registry);
    if (solvers.optimize === undefined) return;
    const catalog = studio.mergedCatalog();
    const env = await computeEnvelope({ instances: proj.instances, wires: proj.wires, registry, catalog }, solvers.optimize);
    const derived = deriveDefaultScenarios({ instances: proj.instances, wires: proj.wires, catalog, envelope: env });
    // EMPTY ENVELOPE (R2 finding) — the trio has nothing honest to size from (no traffic origin, no ranged
    // fact-assumption). EXPLAIN it (never mint degenerate zero-worlds): surface the derivation's own reason so the
    // architect knows the fix (declare a demand / a range) rather than pressing a button that silently does nothing.
    if (derived.scenarios.length === 0) {
      setDeriveNote(derived.reason ?? "Nothing to derive worlds from — declare a traffic origin (a client, or a generator on a node's output port) and an SLO first, so the trio has a capacity envelope to size against.");
      return;
    }
    const merged = mergeDerivedTrio(proj.scenarios, derived.scenarios);
    studio.dispatchBatch(merged.map((s) => ({ kind: 'declareScenario', decl: s })));
    studio.setActiveScenario('real'); // land on the realistic lens
  };

  // RESET ONE WORLD — the NON-preserving twin of deriveTrio. A
  // derived-trio world is wiped back to its freshly-derived values (any FROZEN edit dropped, re-tracking the envelope);
  // a custom world has its overrides cleared (it falls back to base). ONE undoable declareScenario (replace-in-place).
  const resetWorld = async (id: string): Promise<void> => {
    setDeriveNote(null);
    const proj = studio.project();
    if (proj.requestClasses.length > 0) return; // worlds are inert under request classes
    const catalog = studio.mergedCatalog();
    let fresh: readonly AssumptionScenario[] = [];
    const solvers = await bindBrowserSolvers(registry);
    if (solvers.optimize !== undefined) {
      const env = await computeEnvelope({ instances: proj.instances, wires: proj.wires, registry, catalog }, solvers.optimize);
      fresh = deriveDefaultScenarios({ instances: proj.instances, wires: proj.wires, catalog, envelope: env }).scenarios;
    }
    const reset = resetScenario(proj.scenarios, fresh, id);
    if (reset === undefined) return;
    studio.dispatch({ kind: 'declareScenario', decl: reset });
  };

  // rollup at the SLO endpoint (or last node)
  const sinkId = doc.instances.find((i) => (i.bands?.length ?? 0) > 0)?.id ?? doc.instances.at(-1)?.id;
  const av = sinkId ? valueOf(sinkId, keys.availability) : undefined;
  // The footer's headline figures (throughput / real latency / cost / violations) come from the SHARED
  // presenter `statusLine`, the SAME view-model the vscode status bar reads — so the two shells can never show a
  // different number for the same design. Availability + the per-metric chip stay web-specific (not in the shared
  // WireStatus contract). SINGLE-TRUTH LATENCY (owner decree): `latencyMs` is the MEASURED tail (the DES p50) — omitted
  // until a sim measures it (never the analytic scalar).
  // Whether ANY node drives the design (a client OR a node with assumedRps > 0). When false, the footer shows the
  // honest "no traffic origin" reason instead of a silent blank — a client-less migration is a valid design.
  const designHasOrigin = ev.ok ? hasTrafficOrigin(doc.instances, doc.wires, valueOf) : true;
  const status = statusLine(sinkId ? valueOf(sinkId, keys.throughput) : undefined, sim ? sim.p50 : undefined, totalCost, verds, ev.ok, ev.ok ? 0 : ev.error.length, designHasOrigin);

  // The command palette's action list (Ctrl/Cmd+K). Every command DELEGATES to a handler already defined
  // above — the palette is a keyboard-first index of the app's actions, never a second source of truth.
  const hasViolations = verds.some((v) => v.status === 'violation');
  const commands: Command[] = [
    { id: 'tidy', group: 'Layout', label: 'Tidy — auto-layout the diagram', keywords: 'arrange align layout clean beautiful optimal polish ideal symmetry compact', run: () => idealLayout() },
    { id: 'group', group: 'Layout', label: 'Add group (tier / VPC / zone)', keywords: 'boundary container', run: () => addGroup() },
    { id: 'fit', group: 'View', label: 'Fit diagram to view', keywords: 'zoom center', run: () => rfi?.fitView({ padding: 0.15, duration: 400 }) },
    { id: 'theme', group: 'View', label: `Switch to ${theme === 'light' ? 'dark' : 'light'} theme`, keywords: 'dark light appearance', run: () => setTheme(theme === 'light' ? 'dark' : 'light') },
    { id: 'view-system', group: 'Panel', label: 'Show System panel', keywords: 'metrics throughput latency cost', run: () => { setLens('system'); setDrawerOpen(true); } },
    { id: 'view-problems', group: 'Panel', label: 'Show Problems list', keywords: 'errors warnings issues verdicts', run: () => { setLens('problems'); setDrawerOpen(true); } },
    { id: 'fixall', group: 'Solve', label: `Fix all issues${hasViolations ? '' : ' (none)'}`, keywords: 'repair solve slo feasible', disabled: !hasViolations, run: () => { setGoal('feasible'); setLens('optimize'); setDrawerOpen(true); void runImprove('feasible'); } },
    { id: 'improve-cheap', group: 'Solve', label: 'Improve — cheapest under SLOs', keywords: 'optimize cost minimize', run: () => { setGoal('cheapest'); setLens('optimize'); setDrawerOpen(true); void runImprove('cheapest'); } },
    { id: 'improve-fast', group: 'Solve', label: 'Improve — fastest (max throughput)', keywords: 'optimize speed maximize', run: () => { setGoal('fastest'); setLens('optimize'); setDrawerOpen(true); void runImprove('fastest'); } },
    { id: 'export', group: 'Project', label: 'Export project (.json)', keywords: 'save download backup', run: () => onExport() },
    { id: 'import', group: 'Project', label: 'Import project (.json)…', keywords: 'load open upload', run: () => fileRef.current?.click() },
    { id: 'doc-html', group: 'Project', label: 'Generate design doc (HTML report)', keywords: 'document export report deliverable html c4', disabled: !okEv, run: () => onExportDocHtml() },
    { id: 'doc-md', group: 'Project', label: 'Generate design doc (Markdown)', keywords: 'document export report markdown rfc', disabled: !okEv, run: () => onExportDocMd() },
    { id: 'add', group: 'Edit', label: 'Add component…', hint: 'N', keywords: 'new node insert picker create', run: () => openPickerAtCenter() },
    { id: 'undo', group: 'Edit', label: 'Undo', hint: 'Ctrl+Z', run: () => studio.undo() },
    { id: 'redo', group: 'Edit', label: 'Redo', hint: 'Ctrl+Shift+Z', run: () => studio.redo() },
    { id: 'duplicate', group: 'Edit', label: 'Duplicate selected node', hint: 'Ctrl+D', keywords: 'copy clone', disabled: !(sel && selInst), run: () => { if (sel && selInst) ctxDuplicate(sel); } },
    { id: 'help', group: 'Help', label: 'Keyboard shortcuts', hint: '?', keywords: 'keys cheatsheet', run: () => setHelpOpen(true) },
  ];

  // The keyboard cheatsheet — the SINGLE source for both the '?' overlay and the handler below, so a shortcut
  // and its documentation can never drift apart.
  const SHORTCUTS: ReadonlyArray<{ keys: string; label: string }> = [
    { keys: 'Ctrl / ⌘ + K', label: 'Command palette' },
    { keys: '?', label: 'This shortcuts cheatsheet' },
    { keys: 'Ctrl / ⌘ + Z', label: 'Undo' },
    { keys: 'Ctrl / ⌘ + Shift + Z', label: 'Redo' },
    { keys: 'Ctrl / ⌘ + S', label: 'Export project (.json)' },
    { keys: 'Ctrl / ⌘ + D', label: 'Duplicate selected node' },
    { keys: 'N', label: 'Add component (picker)' },
    { keys: 'Delete / Backspace', label: 'Delete selection' },
    { keys: '← ↑ → ↓', label: 'Nudge selected node (Shift = ×5)' },
    { keys: 'F', label: 'Fit diagram to view' },
    { keys: 'Esc', label: 'Close palette / menu · deselect' },
  ];

  // The freshest keyboard handler, re-assigned every render (see kbdRef above).
  kbdRef.current = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'k') { e.preventDefault(); setPaletteOpen((o) => !o); return; }
    if (e.key === 'Escape') {
      if (picker) { setPicker(null); return; }
      if (paletteOpen) { setPaletteOpen(false); return; }
      if (helpOpen) { setHelpOpen(false); return; }
      if (menu || mcpPop) { setMenu(null); setMcpPop(null); return; }
      setSel(null);
      return;
    }
    const tag = (e.target as HTMLElement | null)?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA';
    if (mod) {
      if (typing && k !== 's') return; // Ctrl+S should still export while a field is focused
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); studio.undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); studio.redo(); }
      else if (k === 's') { e.preventDefault(); onExport(); }
      else if (k === 'd') { e.preventDefault(); if (sel && selInst) ctxDuplicate(sel); }
      return;
    }
    if (typing) return;
    if (k === '?') { e.preventDefault(); setHelpOpen((o) => !o); }
    else if (k === 'n') { e.preventDefault(); openPickerAtCenter(); } // quick-add picker at the viewport centre
    else if (k === 'f') { e.preventDefault(); rfi?.fitView({ padding: 0.15, duration: 400 }); }
    else if (sel && selInst && (k === 'arrowleft' || k === 'arrowright' || k === 'arrowup' || k === 'arrowdown')) {
      e.preventDefault();
      const step = e.shiftKey ? 50 : 10;
      const p = doc.layout[sel] ?? { x: 200, y: 160 };
      const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0;
      const dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0;
      studio.dispatch({ kind: 'move', id: sel, x: p.x + dx, y: p.y + dy });
    }
  };

  return (
    <StudioCtx.Provider value={studio}>
    <Tooltip />
    <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
    <QuickPicker state={picker} onPick={onPick} onClose={() => setPicker(null)} />
    {transformPop && (
      <TransformEditor
        target={transformPop.target}
        current={transformPop.current}
        x={transformPop.x}
        y={transformPop.y}
        onApply={(target, transform) => {
          // Pick the command from the target's LEVEL: a wire routing split ⇒ setWireTransform (addressed by its
          // from/to port tuple); a port default ⇒ setTransform. Both are undoable core commands.
          const r =
            target.mode === 'wire'
              ? studio.dispatch({ kind: 'setWireTransform', from: target.from, to: target.to, transform })
              : studio.dispatch({ kind: 'setTransform', node: target.node, port: target.port, transform });
          if (!r.ok) setFixMsg(r.error); // honest: never silently drop a failed transform edit
        }}
        onClose={() => setTransformPop(null)}
      />
    )}
    {rangePop && (
      <RangeEditor
        target={rangePop.target}
        label={rangePop.label}
        unit={rangePop.unit}
        point={rangePop.point}
        current={rangePop.current}
        x={rangePop.x}
        y={rangePop.y}
        onApply={(target, range) => {
          // A real range ⇒ setRange (upsert by config key); null ⇒ clearRange, but only when a range actually exists
          // (clearing an absent range would fail honestly — so we no-op it here rather than surface a phantom error).
          if (range === null && rangePop.current === null) return; // nothing to clear
          const r =
            range === null
              ? studio.dispatch({ kind: 'clearRange', node: target.node, key: target.key })
              : studio.dispatch({ kind: 'setRange', node: target.node, key: target.key, range });
          if (!r.ok) setFixMsg(r.error); // honest: never silently drop a failed range edit
        }}
        onClose={() => setRangePop(null)}
      />
    )}
    {helpOpen && (
      <div className="cmd-backdrop" onMouseDown={() => setHelpOpen(false)}>
        <div className="help-box" onMouseDown={(e) => e.stopPropagation()}>
          <div className="help-hd"><h4>About &amp; shortcuts</h4><button className="iconbtn" onClick={() => setHelpOpen(false)} aria-label="Close">✕</button></div>
          <p className="help-scope">{SCOPE_STATEMENT}</p>
          <div className="help-list">
            {SHORTCUTS.map((s) => (
              <div className="help-row" key={s.label}>
                <span className="help-label">{s.label}</span>
                <span className="help-keys">{s.keys.split(' + ').map((part, i, arr) => <Fragment key={i}><kbd>{part}</kbd>{i < arr.length - 1 ? ' + ' : ''}</Fragment>)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    )}
    <div className="app">
      <TopBar
        studio={studio} docName={doc.name} saved={saved} projNameRef={projNameRef} onNewDesign={newDesign}
        mcpLive={mcpLive} mcpTools={mcpToolList} mcpPop={mcpPop} setMcpPop={setMcpPop}
        bridge={bridge} onTryUnlink={unlinkBridge} onLinkAI={connectAI}
        fileRef={fileRef} onImport={onImport} onExport={onExport}
        docReady={okEv !== null} onExportDocHtml={onExportDocHtml} onExportDocMd={onExportDocMd}
        theme={theme} onToggleTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        onOpenPalette={() => setPaletteOpen(true)} onOpenHelp={() => setHelpOpen(true)}
        violations={verds.filter((v) => v.status === 'violation').length}
        onOpenProblems={() => { setLens('problems'); setDrawerOpen(true); }}
      />

      {aiAct && (
        <div className={'ai-toast' + (aiAct.ok ? '' : ' bad')} key={aiAct.n}>
          <span className="ai-spark">✦</span> AI · <code>{aiAct.name}</code> {aiAct.ok ? 'applied' : 'failed'}
        </div>
      )}

      <div className="mid">
        <aside className="rail">
          <div className="search"><input placeholder="Search blocks…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          <div className="facets">
            {['aws', 'oss'].map((p) => <button key={p} className={'facet' + (provF.has(p) ? ' on' : '')} onClick={() => toggle(provF, p, setProvF)}>{p}</button>)}
          </div>
          <div className="facets">
            {kinds.map((k) => <button key={k} className={'facet' + (kindF.has(k) ? ' on' : '')} onClick={() => toggle(kindF, k, setKindF)}>{KIND_LABEL[k] ?? k}</button>)}
          </div>
          <h5>Protocols</h5>
          <div className="facets">
            {protocols.map((p) => <button key={p} className={'facet' + (protoF.has(p) ? ' on' : '')} title={protocolNote(p)} onClick={() => toggle(protoF, p, setProtoF)}>{p}</button>)}
          </div>
          <div className="rail-h"><h5 style={{ margin: 0 }}>{filtered.length} components</h5><button className="lnk" onClick={openEditor}>＋ New</button></div>
          <div className="palette">
            {filtered.map((t) => {
              const f = facetsOf(t);
              return (
                <div key={t} className="pi" draggable
                  onDragStart={(e) => { e.dataTransfer.setData('application/sda', t); e.dataTransfer.effectAllowed = 'copy'; }}
                  onClick={() => addComp(t)}
                  data-tip={`${t} — ${KIND_DESC[f.kind] ?? KIND_LABEL[f.kind] ?? f.kind}\n\nClick to add, or drag onto the canvas.`}>
                  <span className="ic">{iconFor(f.kind)}</span>
                  <div><b>{t}</b><span>{f.provider} · {KIND_LABEL[f.kind] ?? f.kind}{isCustom(t) ? ' · custom' : ''}</span></div>
                  <button className="pi-edit" tabIndex={-1}
                    title={isCustom(t) ? 'Edit this component' : 'Customize — saves a project copy that overrides the built-in'}
                    onClick={(e) => { e.stopPropagation(); editType(t); }}>✎</button>
                </div>
              );
            })}
          </div>
        </aside>

        <div className="right">
        <div className={'work' + (inspOpen ? '' : ' insp-collapsed')}>
        <main className={'cv' + (morphing ? ' morphing' : '')} ref={cvRef} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }} onDrop={onDrop}>
          <div className="hud">
            <div className="tagpill">checkout · SLO throughput ≥ 5,000 rps</div>
            <button className="hud-btn" onClick={addGroup} title="Add a grouping boundary (tier / VPC / zone)">▣ Group</button>
            <button className={'hud-btn' + (polishPhase === 'polishing' ? ' on' : '')} onClick={idealLayout} title="Tidy: arrange the diagram left→right by request flow (tiers as lanes), then polish in the background (aligned lanes, mirrored branches, tight columns) and smoothly apply the better layout. Hand-placed nodes stay put.">{polishPhase === 'polishing' ? '⤢ Tidying…' : '⤢ Tidy'}</button>
            <button className={'hud-btn' + (smartRoutes ? ' on' : '')} onClick={() => setSmartRoutes((v) => !v)} title="Smart routing: draw right-angle wires that route AROUND components (avoid overlaps). Toggle off for straight edges.">⌐ Routes</button>
          </div>
          <ReactFlow
            nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            connectionLineType={ConnectionLineType.SmoothStep}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onInit={(inst) => { setRfi(inst); setTimeout(() => inst.fitView({ padding: 0.22 }), 80); }}
            onReconnect={onReconnect}
            isValidConnection={isValidConnection}
            onNodeClick={(_, n) => { setSel(n.id); closeMenu(); }}
            onPaneClick={closeMenu}
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
            {/* The minimap earns its space (and its occlusion of a corner node) only on a big design; a 4-node
                diagram doesn't need it — showing it there is clutter that hides the terminal tier. */}
            {doc.instances.length > 8 && <MiniMap pannable zoomable nodeColor="var(--accent)" maskColor="rgba(0,0,0,0.06)" style={{ width: 150, height: 100 }} />}
          </ReactFlow>
          {/* Empty-canvas ghost CTA (n8n's "Add first step"): a non-blocking dashed prompt that opens the
              quick-add picker; the picked component lands at the canvas centre. Disappears on the first add. */}
          {doc.instances.length === 0 && (
            <button className="ghost-cta" onClick={openPickerAtCenter} title="Add your first component (or press N)">
              <span className="ghost-plus">＋</span>
              Add first component
              <small>drag a block from the left, or press N</small>
            </button>
          )}
          {/* First-run onboarding: three honest quick-actions + the bundled CQRS example. Shown once on
              a fresh profile over the untouched seed; dismissed by X or any real edit (never shows again). */}
          {showOnboard && (
            <div className="onboard" role="dialog" aria-label="Getting started">
              <div className="onboard-h"><b>Start here</b><button className="onboard-x" onClick={dismissOnboard} aria-label="Dismiss">✕</button></div>
              <ul>
                <li><span className="ob-ic">＋</span>Drag a block from the palette onto the canvas.</li>
                <li><kbd>N</kbd>Quick-add a component at the centre.</li>
                <li><span className="ob-ic">⌥</span>Drop a wire on the empty canvas to add what fits.</li>
              </ul>
              <p className="onboard-scope">{SCOPE_STATEMENT}</p>
              <button className="btn primary" onClick={loadCqrsExample} title="Load a bundled CQRS example (11 components) to explore a real design">Open the CQRS example</button>
            </div>
          )}
        </main>

        {/* Inspector collapse grip — the middle column of the .work grid; mirrors the System drawer's
            sd-grip. Collapsed → the inspector column is 0-width and the canvas takes the freed space. */}
        <button className="insp-grip" onClick={toggleInsp} title={inspOpen ? 'Collapse the Inspector' : 'Expand the Inspector'} aria-label="Toggle Inspector" aria-expanded={inspOpen}>
          <span className="chev">{inspOpen ? '›' : '‹'}</span>
        </button>
        <InspectorPanel
          studio={studio} doc={doc} sel={sel} onSelect={setSel}
          selInst={selInst} selMan={selMan} selGroup={selGroup}
          verds={verds} simResponses={sim ? sim.nodeResponse : null} respByNode={respByNode} localCost={localCost} valueOf={valueOf}
          activeWorld={activeWorld} active={active} onCommitConfig={commitConfig}
          suggestions={suggestions} onAddSuggestion={addSuggestion}
          isCustom={isCustom} onEditType={editType} labelOf={labelOf} descOf={descOf}
          onEditTransform={openTransformEditor} onEditRange={openRangeEditor} onError={setFixMsg} nameRef={nameRef}
        />
        </div>{/* .work — canvas + inspector */}

        <section className={'sysdrawer' + (drawerOpen ? '' : ' collapsed')}>
          <div className="sysdrawer-h">
            <button className="sd-grip" onClick={() => setDrawerOpen((o) => !o)} title={drawerOpen ? 'Collapse the System panel' : 'Expand the System panel'} aria-label="Toggle System panel">{drawerOpen ? '▾' : '▸'}</button>
            <span className="sd-title">System</span>
            {active !== undefined && <span className="world-badge" title="The canvas verdicts, chips and metrics reflect this world (the active lens). Click a world in the Worlds panel to change, or 'base' to return.">world: {activeLensLabel(active, doc.scenarios)}</span>}
            <div className="sd-tabs">
              <button className={lens === 'system' ? 'on' : ''} onClick={() => { setLens('system'); setDrawerOpen(true); }} data-tip="The whole design, real by default: each request flow’s end-to-end throughput, REAL (queueing-aware) latency, availability and cost, the per-tier load ρ, its promises, and the simulated tail on demand.">System</button>
              <button className={lens === 'optimize' ? 'on' : ''} onClick={() => { setLens('optimize'); setDrawerOpen(true); void runImprove(); }} data-tip="Improve the design BACKWARDS: pick a goal (meet the SLOs / cheapest / fastest) and the solver sizes the knobs to reach it — showing what changes before you apply.">Improve</button>
              <button className={(lens === 'problems' ? 'on' : '') + (problemCnt + guaranteeProblemCnt > 0 ? ' has-problems' : '')} onClick={() => { setLens('problems'); setDrawerOpen(true); }} data-tip="Every problem in one list (like an IDE's Error List): violations, warnings and unverified checks — numeric AND qualitative-guarantee — each with the node, the computed value and the engine's ranked fix. Click a row to select the node.">Problems{problemCnt + guaranteeProblemCnt > 0 ? ` · ${problemCnt + guaranteeProblemCnt}` : ''}</button>
            </div>
          </div>
          {drawerOpen && (
          <div className="sysbody">
          {lens === 'system' && (
            <SystemPanel
              studio={studio} doc={doc} flows={flows} valueOf={valueOf} verds={verds}
              sim={sim} simRefreshing={busy === 'sim'}
              queues={queues} saturated={saturated} totalCost={totalCost}
              sysPromises={sysPromises} costBreak={costBreak}
              envW={envW} deriveNote={deriveNote} onDeriveTrio={() => void deriveTrio()} onResetWorld={(id) => void resetWorld(id)} active={active}
              unc={unc} lagV={lagV} twoTier={twoTier} peakByNode={peakByNode}
              guaranteeLines={guaranteeLines} gVerdicts={gVerdicts}
              labelOf={labelOf} typeOf={typeOf} onSelect={setSel} rfi={rfi}
              onOpenProblems={() => { setLens('problems'); setDrawerOpen(true); }}
            />
          )}


          {lens === 'optimize' && (
            <ImprovePanel
              graph={graph} instances={doc.instances} goal={goal} onGoal={setGoal}
              improve={improve} solving={busy === 'opt'} nameOf={(id) => labelOf(id, typeOf(id))}
              onRun={() => void runImprove()} onApply={applyImprove}
            />
          )}
          {lens === 'problems' && (
            <ProblemsPanel
              problems={problems} problemCnt={problemCnt} guaranteeProblems={guaranteeProblems}
              nameOf={(id) => labelOf(id, typeOf(id))} onSelect={setSel}
              onFixAll={() => { setGoal('feasible'); setLens('optimize'); void runImprove('feasible'); }}
            />
          )}
          </div>
          )}
        </section>
        </div>
      </div>

      <div className="bottom">
        <div className="metric"><span className="lab">Throughput</span><span className="num">{fmt(status.throughputRps)}<span style={{ color: 'var(--ink3)' }}> rps</span></span>{sinkId && <span className={'st ' + (statusOfKey(sinkId, keys.throughput) ?? 'unknown')}>{statusOfKey(sinkId, keys.throughput) ?? 'n/a'}</span>}</div>
        <div className="sep" />
        <div className="metric"><span className="lab">Latency</span><span className="num" title="MEASURED headline latency — the discrete-event simulation's median sojourn (p50). The single truth; the analytic estimate is engine-internal and never shown. Shows — until a sim measures it.">{status.latencyMs !== undefined ? formatMs(status.latencyMs) : '—'}</span></div>
        <div className="sep" />
        <div className="metric"><span className="lab">Availability</span><span className="num">{av !== undefined ? `${(av * 100).toFixed(2)}%` : '—'}</span></div>
        <div className="sep" />
        <div className="metric"><span className="lab">Cost</span><span className="num">${status.costUsdMonth !== undefined ? fmt(status.costUsdMonth) : '—'}<span style={{ color: 'var(--ink3)' }}> /mo</span></span></div>
        {anySaturated && <><div className="sep" /><div className="metric"><span className="lab" style={{ color: 'var(--bad)' }}>Saturated</span><span className="num" style={{ color: 'var(--bad)' }} title={`Dropping load at: ${[...saturated.keys()].map((id) => labelOf(id, typeOf(id))).join(', ')}. Real latency is the tail (Simulate), not the figure left of here.`}>{saturated.size} tier{saturated.size > 1 ? 's' : ''} ⚠</span></div></>}
        {/* No traffic origin: the flow figures above are vacuous — say WHY (any node can originate via a generator). */}
        {status.reason && <><div className="sep" /><div className="metric"><span className="num" style={{ color: 'var(--ink3)' }} title={status.reason}>{status.reason}</span></div></>}
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn primary" style={{ padding: '6px 12px' }} disabled={busy === 'opt'} title="Open Improve: the solver sizes the knobs to a goal (clear the violations / cheapest / fastest) and shows what changes before you apply." onClick={() => { const fix = verds.some((v) => v.status === 'violation'); const gk: ImproveGoal = fix ? 'feasible' : 'cheapest'; setGoal(gk); setLens('optimize'); setDrawerOpen(true); void runImprove(gk); }}>{busy === 'opt' ? 'Solving…' : verds.some((v) => v.status === 'violation') ? '→ Fix issues' : '→ Improve'}</button>
      </div>

      {importErr && <div className="toast" onClick={() => setImportErr(null)}>Import failed: {importErr}</div>}
      {fixMsg && <div className="toast info" onClick={() => setFixMsg(null)}>{fixMsg}</div>}
      {undoNotice && (
        <div className="toast info undo-toast">
          <span>{undoNotice}</span>
          <button onClick={() => { studio.undo(); setUndoNotice(null); }}>Undo</button>
        </div>
      )}
      {tidyOffer && (
        <div className="toast info undo-toast">
          <span>New component overlaps another.</span>
          <button onClick={() => { setTidyOffer(false); idealLayout(); }}>Tidy</button>
        </div>
      )}

      {menu && (
        <>
          <div className="ctx-backdrop" onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu(); }} />
          <div className="ctxmenu" style={{ left: menu.x, top: menu.y }}>
            {menu.kind === 'node' && (
              <>
                <button onClick={() => { ctxRename(menu.id); closeMenu(); }}>Rename</button>
                <button onClick={() => { ctxDuplicate(menu.id); closeMenu(); }}>Duplicate</button>
                <button onClick={() => { ctxWrap(menu.id); closeMenu(); }}>Wrap in group</button>
                <div className="ctx-sep" />
                <button className="danger" onClick={() => { studio.dispatch({ kind: 'removeNode', id: menu.id }); if (sel === menu.id) setSel(null); closeMenu(); }}>Delete</button>
              </>
            )}
            {menu.kind === 'group' && (
              <>
                <button onClick={() => { setSel(menu.id); closeMenu(); }}>Rename / edit</button>
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

      {editorOpen && (
        <div className="modal-bg" onClick={() => setEditorOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-h">
              <b>{editorMode.kind === 'edit' ? `Edit ${editorMode.type}` : editorMode.kind === 'customize' ? `Customize ${editorMode.type}` : 'New component'}</b>
              <button className="iconbtn" onClick={() => setEditorOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p className="muted">
                {editorMode.kind === 'customize'
                  ? `${editorMode.type} is a built-in. Saving keeps the original intact and creates a project-scoped copy of the same type that overrides it everywhere it is used.`
                  : 'Components are pure JSON data — type, ports, config, relations, SLO bands. They save and export with the project, and become placeable in the palette.'}
              </p>
              <textarea className="code" spellCheck={false} value={editorText} onChange={(e) => setEditorText(e.target.value)} />
              {editorErr && <div className="modal-err">{editorErr}</div>}
              <div className="modal-actions">
                <input ref={compFileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={onImportComponent} />
                <button className="btn" onClick={() => compFileRef.current?.click()}>Import .json</button>
                <div style={{ flex: 1 }} />
                <button className="btn primary" onClick={saveComponent}>
                  {editorMode.kind === 'edit' ? 'Save changes' : editorMode.kind === 'customize' ? 'Save project copy' : 'Save component'}
                </button>
              </div>
              {doc.components.length > 0 && (
                <div className="custom-list">
                  <h6>In this project · {doc.components.length}</h6>
                  {doc.components.map((m) => (
                    <div className="vr" key={m.type}>
                      <span className="k">{m.type}</span>
                      <span style={{ display: 'flex', gap: 12 }}>
                        <button className="lnk" onClick={() => editType(m.type)}>edit</button>
                        <button className="lnk" onClick={() => exportComponent(m)}>export</button>
                        <button className="lnk" onClick={() => { const r = studio.dispatch({ kind: 'removeComponentDef', type: m.type }); if (!r.ok) setEditorErr(r.error); }}>delete</button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
    </StudioCtx.Provider>
  );
}
