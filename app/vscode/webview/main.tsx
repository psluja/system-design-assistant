import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { Studio, serialize, deserialize, type ProjectDoc } from '@sda/core';
import { registry, keys, allManifests, toQueueingNetwork, hasRanges, shapedOriginsOf, DEFAULT_SEED } from '@sda/content';
import App from './App';
import { getVsCodeApi, devHarness } from './vscode-api';
import simWorkerAssetUrl from './sim-worker.ts?worker&url';
import uncWorkerAssetUrl from './uncertainty-worker.ts?worker&url';
import twoTierWorkerAssetUrl from './two-tier-worker.ts?worker&url';
import type { SimWorkerRequest, SimWorkerResponse } from './sim-worker';
import type { UncWorkerRequest, UncWorkerResponse } from './uncertainty-worker';
import type { TwoTierWorkerRequest, TwoTierWorkerResponse } from './two-tier-worker';
import type { TwoTierResult } from '@sda/content';
import type { HostBridge, HostCommand, HostAction, SimTail, UncertaintyView } from './host-bridge';
import { isH2W, type H2W, type WireProblem, type WireStatus, type SummarySection, type NodeDetail, type PickerOptionWire } from '../src/protocol';
// The app's styles: import the UNMODIFIED web theme via the `@web` JS-side alias (vite resolves it), then the
// VS Code variable layer that maps editor colors onto the app's tokens and collapses the grid to the canvas.
import '@web/theme.css';
import './vscode.css';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The webview HUB. Owns the Studio and ALL host plumbing: the message channel, document sync (echo-guarded), the
// background DES simulation, the native-view feeds and the diagnostics relay. `App` is a pure CANVAS view over the
// Studio + this `HostBridge` — every non-canvas surface (palette / inspector / System / Improve / Problems) is a
// native VS Code control fed through the bridge. See host-bridge.ts for why the two concerns are split.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const api = getVsCodeApi();

// One Studio for the whole session — created empty; the host's `docInit` loads the real document.
const studio = new Studio(registry, allManifests);

// The echo guard (protocol §DOCUMENT SYNC): remember the last text we SENT or APPLIED. A `docExternal`/`docInit`
// whose text equals this is our own change echoing back — ignore it (never reload the Studio mid-interaction). And
// a `docChanged` whose text equals this is a no-op we must not re-post (breaks the send↔apply loop).
//
// IMPORTANT for the native-first design: a HOST-initiated document edit (the native inspector editing a config /
// SLO, or Improve applying a solve) arrives as `docExternal` with text DIFFERENT from anything the webview sent —
// so it is never mistaken for an echo, and the Studio reloads to reflect it. The guard only ever suppresses text
// the webview itself produced.
let lastSyncedText: string | null = null;
// EOL-insensitive canonical form for the guard comparisons — the HOST's TextDocument normalizes applied text
// to the FILE's end-of-line (a CRLF-authored file broadcasts CRLF back for our LF serialize), so raw-string
// comparison spun the docChanged⇄docExternal loop forever. Content is JSON — EOL is not meaning.
const canonicalEol = (text: string): string => text.replace(/\r\n?/g, '\n');

// The registered command / action handlers (App repoints them each render via onCommand / onAction). Nullable
// until App mounts.
let commandHandler: ((cmd: HostCommand) => void) | null = null;
let actionHandler: ((action: HostAction) => void) | null = null;

// Background-sim subscribers (App holds one). Pushed the latest tail whenever a run completes.
const simSubscribers = new Set<(sim: SimTail | null) => void>();
let lastSim: SimTail | null = null;
const pushSim = (sim: SimTail | null): void => { lastSim = sim; for (const fn of simSubscribers) fn(sim); };

// The QUICK-ADD picker round-trip (TASK-63). App computes the legality-filtered options and awaits `bridge.pick`;
// we mint a monotonic token, post `{type:'pick'}` and park the resolver keyed by that token. The host answers with
// `pickResult {token, picked}` (null = dismissed) which resolves the matching pending pick. SUPERSESSION: a newer
// pick request is the user starting over (a second drop, or N while a QuickPick is still open) — we resolve any
// still-pending pick with `null` (a no-op in App) before parking the new one, so only the latest can ever place a
// node, and the host hides the stale QuickPick when it sees the newer token.
let pickToken = 0;
const pendingPicks = new Map<number, (picked: string | null) => void>();
function requestPick(options: readonly PickerOptionWire[], placeholder: string): Promise<string | null> {
  for (const [, resolve] of pendingPicks) resolve(null); // supersede every in-flight pick — only the newest wins
  pendingPicks.clear();
  const token = (pickToken += 1);
  return new Promise<string | null>((resolve) => {
    pendingPicks.set(token, resolve);
    api.post({ type: 'pick', token, options, placeholder });
  });
}
function resolvePick(token: number, picked: string | null): void {
  const resolve = pendingPicks.get(token);
  if (resolve === undefined) return; // an already-superseded / unknown token — ignore honestly
  pendingPicks.delete(token);
  resolve(picked);
}

/** Load a document text into the Studio, remembering it as the last-synced text (echo guard). Returns the error
 *  string when the text is not a valid project — the file may be hand-edited JSON, so we surface it honestly
 *  rather than loading a corrupt design. */
function loadText(text: string): string | null {
  const r = deserialize(text);
  if (!r.ok) return r.error;
  lastSyncedText = canonicalEol(text);
  studio.load(r.value);
  return null;
}

/** The background DES tail over the current design → true p50/p95/p99, computed in a WEB WORKER. A VS Code
 *  webview shares the workbench renderer process, so a synchronous simulate() at a high request rate (millions
 *  of events — tens of seconds of CPU at 10k rps) froze the WHOLE editor. Off-thread + LATEST-WINS: a newer
 *  design terminates the stale run (its result would describe a design that no longer exists). The network is
 *  pure data (distributions are tagged unions), so it structured-clones across the boundary. */
let simWorker: Worker | null = null;
let simRun = 0; // async-spawn token: only the LATEST run may install its worker / deliver a result
let simBlobUrl: string | null = null; // cached blob bootstrap for the vscode-webview origin (see below)

/** Construct the sim worker. Inside a REAL VS Code webview the page origin (vscode-webview://…) differs from
 *  the resource origin, and Workers are SAME-ORIGIN-only — so there we FETCH the chunk (CSP grants
 *  connect-src to the resource origin) and boot it from a blob URL; the built chunk is a self-contained IIFE,
 *  so a CLASSIC blob worker runs it. The dev harness / a plain browser constructs directly (the dev worker is
 *  an ES module with imports — a blob could not resolve those, so the direct path is not just an
 *  optimization). The environment check is DETERMINISTIC (location.protocol), not throw-guessing: a
 *  cross-origin Worker can fail asynchronously in some engines, which a try/catch would miss. */
async function spawnSimWorker(): Promise<Worker> {
  const url = new URL(simWorkerAssetUrl, import.meta.url);
  if (location.protocol !== 'vscode-webview:') return new Worker(url, { type: 'module' });
  if (simBlobUrl === null) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`sim worker fetch failed: ${res.status}`);
    simBlobUrl = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
  }
  return new Worker(simBlobUrl);
}

function runSimulate(): void {
  const g = studio.graph();
  if (!g.ok) { pushSim(null); return; }
  try {
    const net = toQueueingNetwork(g.value);
    if (net.arrivals.length === 0) { pushSim(null); return; }
    // FLOW-SCOPED LAG (doc: latency-semantics-v2 §3): hand the declared (source, terminal) pairs to the worker so the
    // ONE run also samples each async-inclusive journey. Read off the project's lagSlos; undeclared ⇒ [] ⇒ the run is
    // bit-for-bit the pre-lag simulation (the feature is opt-in — an undeclared design pays nothing).
    const lagPairs = studio.project().lagSlos.map((s) => ({ source: s.source, terminal: s.terminal }));
    if (simWorker !== null) { simWorker.terminate(); simWorker = null; } // supersede the in-flight run
    const run = ++simRun;
    void spawnSimWorker()
      .then((w) => {
        if (run !== simRun) { w.terminate(); return; } // superseded while the worker was bootstrapping
        simWorker = w;
        w.onmessage = (e: MessageEvent<SimWorkerResponse>) => {
          if (simWorker !== w) return; // superseded while this message was in flight
          simWorker = null;
          w.terminate();
          const d = e.data;
          // The retry-outcome fields (doc: retry-feedback §3) ride along the tail so the shared summary + verdicts
          // show goodput/error/amplification. Spread only when present (exactOptionalPropertyTypes: an absent field
          // must be truly absent, not `undefined`) — undefined ⇒ no retry story ⇒ no rows.
          const retry = d.ok
            ? { goodputRps: d.goodput, errorRate: d.errorRate, amplification: d.amplification, retryPolicy: d.retryPolicy === true }
            : {};
          // Per-node response tails + declared lags (doc: latency-semantics-v2 §4, §3) ride the same tail so the
          // shared presenter (chip / System rows / per-node tail verdict) reads them — the plumbing this shell adds.
          pushSim(d.ok
            ? { mean: d.mean, p50: d.p50, p95: d.p95, p99: d.p99, ...retry, nodeResponse: d.nodeResponse, pairLag: d.pairLag }
            : null);
        };
        w.onerror = () => { if (simWorker === w) simWorker = null; w.terminate(); pushSim(null); };
        w.postMessage({ net, ...(lagPairs.length > 0 ? { lagPairs } : {}) } satisfies SimWorkerRequest);
      })
      .catch(() => pushSim(null));
  } catch { pushSim(null); }
}

// ── AMBIENT UNCERTAINTY (TASK-81) ────────────────────────────────────────────────────────────────────────────
// Monte Carlo recomputed OFF the workbench renderer thread on every design change (the runSimulate pattern),
// continuously, LATEST-WINS (a newer epoch supersedes AND aborts the stale run), idle = zero work. Only when a
// range is declared (no-filler). THE RESTING HANDSHAKE: a `gpu` run is a live fp32 `preview` cloud, then a `cpu`
// confirmation pass at the SAME seed stamps `confirmed` (fp64, verdict-grade) — fp32 is never final truth (AC#6).
// A `gpu` run that falls back to CPU (no device) is already fp64 ⇒ tagged `confirmed`, and GPU is not tried again.
// The worker is PERSISTENT so the WebGPU device is created once (not per run).
const uncSubscribers = new Set<(u: UncertaintyView | null) => void>();
let lastUnc: UncertaintyView | null = null;
const pushUnc = (u: UncertaintyView | null): void => { lastUnc = u; for (const fn of uncSubscribers) fn(u); };

let uncWorker: Worker | null = null;
let uncBlobUrl: string | null = null; // cached blob bootstrap for the vscode-webview origin (see spawnSimWorker)
let uncEpoch = 0;
let gpuMaybe = true; // attempt the GPU until a run proves there is no device in this webview
const AMBIENT_N = 500; // a modest scenario count for a real-time cadence; the MCP run_uncertainty is the full-N re-run

/** Construct the uncertainty worker — the SAME cross-origin blob bootstrap as the sim worker (a real webview's page
 *  origin differs from the resource origin; Workers are same-origin, so we fetch the self-contained IIFE chunk and
 *  boot it from a blob URL). A plain browser / the dev harness constructs directly (the module worker resolves its
 *  own imports). */
async function spawnUncWorker(): Promise<Worker> {
  const url = new URL(uncWorkerAssetUrl, import.meta.url);
  if (location.protocol !== 'vscode-webview:') return new Worker(url, { type: 'module' });
  if (uncBlobUrl === null) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`uncertainty worker fetch failed: ${res.status}`);
    uncBlobUrl = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
  }
  return new Worker(uncBlobUrl);
}

function handleUncResult(d: UncWorkerResponse): void {
  if (d.epoch !== uncEpoch) return; // superseded by a newer design — drop the stale answer (latest-wins)
  if (!d.ok) return; // a transient error: keep the last good numbers rather than blanking the block
  if (d.mode === 'gpu' && d.backend === 'gpu') {
    pushUnc({ result: d.result, state: 'preview', backend: 'gpu', elapsedMs: d.elapsedMs });
    postUnc('cpu', d.result.seed, d.epoch); // confirm on the CPU at the SAME seed (the resting handshake)
  } else {
    if (d.mode === 'gpu' && d.backend === 'cpu') gpuMaybe = false; // no device here — stop trying GPU
    pushUnc({ result: d.result, state: 'confirmed', backend: 'cpu', elapsedMs: d.elapsedMs });
  }
}

function postUnc(mode: 'gpu' | 'cpu', seed: number, epoch: number): void {
  const g = studio.graph();
  if (!g.ok) return;
  const proj = studio.project();
  // Center the sample on the ACTIVE world (doc §6 — "a range is a cloud around a point"); no active world (or under
  // request classes, which have no world lens) ⇒ the base design, bit-for-bit today.
  const activeId = studio.activeScenario();
  const scenario = proj.requestClasses.length === 0 && activeId !== undefined ? proj.scenarios.find((s) => s.id === activeId) : undefined;
  const send = (w: Worker): void => w.postMessage({ epoch, mode, graph: g.value, instances: proj.instances, wires: proj.wires, n: AMBIENT_N, seed, ...(scenario ? { scenario } : {}) } satisfies UncWorkerRequest);
  if (uncWorker !== null) { send(uncWorker); return; }
  void spawnUncWorker()
    .then((w) => {
      uncWorker = w;
      w.onmessage = (e: MessageEvent<UncWorkerResponse>) => handleUncResult(e.data);
      w.onerror = () => {}; // keep the last result; the loop retries on the next edit
      send(w);
    })
    .catch(() => {});
}

function runUncertaintyPass(): void {
  const proj = studio.project();
  if (!hasRanges(proj.instances)) { pushUnc(null); return; } // no-filler: nothing ranged ⇒ nothing to model
  const g = studio.graph();
  if (!g.ok) { pushUnc(null); return; }
  const epoch = ++uncEpoch;
  if (lastUnc === null) pushUnc({ result: null, state: 'computing' }); // 'computing' only on the very first pass
  postUnc(gpuMaybe ? 'gpu' : 'cpu', DEFAULT_SEED, epoch);
}

// ── THE AMBIENT TWO-TIER TRANSIENT (doc: load-stages §10) ─────────────────────────────────────────────────────
// Recomputed OFF the workbench renderer thread on every design change (the runSimulate pattern), latest-wins, idle =
// zero work. Only when a generator declares cycles (no-filler). THE RESTING HANDSHAKE: the worker posts a Tier-1
// `preview` (the live ρ-envelope + worst window) then a Tier-2 `final` (the DES-confirmed survival verdict). App
// composes the result into the System-tree summary via the shared `twoTierSection` presenter.
const twoTierSubscribers = new Set<(t: TwoTierResult | null) => void>();
let lastTwoTier: TwoTierResult | null = null;
const pushTwoTier = (t: TwoTierResult | null): void => { lastTwoTier = t; for (const fn of twoTierSubscribers) fn(t); };

let twoTierWorker: Worker | null = null;
let twoTierRun = 0; // async-spawn token: only the LATEST run may install its worker / deliver a result
let twoTierBlobUrl: string | null = null; // cached blob bootstrap for the vscode-webview origin (see spawnSimWorker)

/** Construct the two-tier worker — the SAME cross-origin blob bootstrap as the sim/uncertainty workers (a real
 *  webview's page origin differs from the resource origin; Workers are same-origin, so we fetch the self-contained
 *  IIFE chunk and boot it from a blob URL). A plain browser / the dev harness constructs directly. */
async function spawnTwoTierWorker(): Promise<Worker> {
  const url = new URL(twoTierWorkerAssetUrl, import.meta.url);
  if (location.protocol !== 'vscode-webview:') return new Worker(url, { type: 'module' });
  if (twoTierBlobUrl === null) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`two-tier worker fetch failed: ${res.status}`);
    twoTierBlobUrl = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
  }
  return new Worker(twoTierBlobUrl);
}

function runTwoTier(): void {
  const g = studio.graph();
  if (!g.ok || shapedOriginsOf(g.value).length === 0) { pushTwoTier(null); return; } // no shaped generator ⇒ nothing to show
  if (twoTierWorker !== null) { twoTierWorker.terminate(); twoTierWorker = null; } // supersede the in-flight run
  const run = ++twoTierRun;
  void spawnTwoTierWorker()
    .then((w) => {
      if (run !== twoTierRun) { w.terminate(); return; } // superseded while bootstrapping
      twoTierWorker = w;
      w.onmessage = (e: MessageEvent<TwoTierWorkerResponse>) => {
        if (twoTierWorker !== w) return; // superseded while this message was in flight
        const d = e.data;
        pushTwoTier(d.ok ? d.result : null);
        // Keep the worker alive across the Tier-1 preview; retire it on the terminal (Tier-2 `final`) message.
        if (!d.ok || d.phase === 'final') { if (twoTierWorker === w) twoTierWorker = null; w.terminate(); }
      };
      w.onerror = () => { if (twoTierWorker === w) twoTierWorker = null; w.terminate(); pushTwoTier(null); };
      w.postMessage({ graph: g.value } satisfies TwoTierWorkerRequest);
    })
    .catch(() => pushTwoTier(null));
}

// The HostBridge implementation App consumes. Everything App needs from the host flows through here. There is NO
// `solve` — backward-solving (Improve) is entirely host-side now (the host owns the in-process solver + the
// document edit that applies it); the webview neither initiates nor applies it.
const bridge: HostBridge = {
  post: (message) => api.post(message),
  pick: (options, placeholder) => requestPick(options, placeholder),
  serialize: (doc: ProjectDoc) => serialize(doc),
  onCommand: (handler) => { commandHandler = handler; return () => { if (commandHandler === handler) commandHandler = null; }; },
  onAction: (handler) => { actionHandler = handler; return () => { if (actionHandler === handler) actionHandler = null; }; },
  onSim: (handler) => { simSubscribers.add(handler); handler(lastSim); return () => simSubscribers.delete(handler); },
  onUncertainty: (handler) => { uncSubscribers.add(handler); handler(lastUnc); return () => uncSubscribers.delete(handler); },
  onTwoTier: (handler) => { twoTierSubscribers.add(handler); handler(lastTwoTier); return () => twoTierSubscribers.delete(handler); },
  postDesignDoc: ({ markdown, title }) => api.post({ type: 'designDoc', markdown, title }),
  postDiagnostics: (problems: readonly WireProblem[], status: WireStatus) => {
    api.post({ type: 'problems', items: problems });
    api.post({ type: 'status', status });
  },
  postSummary: (sections: readonly SummarySection[]) => api.post({ type: 'summary', sections }),
  postNodeDetail: (detail: NodeDetail) => api.post({ type: 'nodeDetail', detail }),
  postSelection: (node: string | null) => api.post({ type: 'selection', node }),
};

/**
 * The root: renders the canvas once a document is loaded, an honest full-pane error when the document text is not
 * valid, or a quiet "waiting for the host" state before the first `docInit`. Subscribes to the host message
 * channel; posts `docChanged` on every Studio change (echo-guarded); debounces the background sim.
 */
function Root(): JSX.Element {
  // `null` = not yet loaded (waiting for docInit); string = the last load error; false = loaded OK.
  const [loadError, setLoadError] = useState<string | null | false>(null);
  // Bump to force a re-mount of <App/> when a fresh document is loaded (clears its transient local UI state).
  const [docEpoch, setDocEpoch] = useState(0);

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const m: unknown = e.data;
      if (!isH2W(m)) return;
      const msg = m as H2W;
      switch (msg.type) {
        case 'docInit':
        case 'docExternal': {
          // Ignore our own change echoing back (the host applied our docChanged and re-broadcast it). A HOST edit
          // (native inspector / Improve apply) has DIFFERENT text, so it passes the guard and reloads the Studio.
          if (canonicalEol(msg.text) === lastSyncedText) return;
          const err = loadText(msg.text);
          if (err) { setLoadError(err); return; }
          setLoadError(false);
          setDocEpoch((n) => n + 1);
          break;
        }
        case 'theme':
          document.documentElement.dataset.theme = msg.kind;
          break;
        case 'cmd':
          commandHandler?.(msg.cmd);
          break;
        // Host ACTIONS driving the canvas (native palette / inspector reveal / suggester QuickPick). Routed to App
        // through the action handler so it can place/select/wire against the freshest document.
        case 'addComponent':
          actionHandler?.({ kind: 'addComponent', comp: msg.comp });
          break;
        case 'select':
          actionHandler?.({ kind: 'select', node: msg.node });
          break;
        case 'wireSuggestion':
          actionHandler?.({ kind: 'wireSuggestion', node: msg.node, port: msg.port, comp: msg.comp });
          break;
        // The native quick-add QuickPick answered (TASK-63): resolve the pending pick by token so App can place +
        // wire the chosen component (or no-op on a null dismissal / superseded token).
        case 'pickResult':
          resolvePick(msg.token, msg.picked);
          break;
      }
    };
    window.addEventListener('message', onMessage);
    // Tell the host we're ready; it replies with docInit. (The dev harness feeds a sample docInit instead.)
    api.post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Post `docChanged` on every Studio change, guarded against echoing a text we just sent/applied. This is what
  // makes the TextDocument the source of truth — the host applies it as a WorkspaceEdit (owns dirty/undo/save).
  useEffect(() => {
    const off = studio.onChange(() => {
      const text = serialize(studio.project());
      if (canonicalEol(text) === lastSyncedText) return; // no real change vs the last synced text (EOL-insensitive)
      lastSyncedText = canonicalEol(text);
      api.post({ type: 'docChanged', text });
    });
    return off;
  }, []);

  // Debounce the background DES sim after each change (and once a document loads), the same cadence as the web
  // shell. Runs only when there is a loaded design.
  useEffect(() => {
    if (loadError !== false) return;
    let t: ReturnType<typeof setTimeout>;
    const schedule = (): void => { clearTimeout(t); t = setTimeout(runSimulate, 450); };
    schedule();
    const off = studio.onChange(schedule);
    return () => { clearTimeout(t); off(); };
  }, [loadError, docEpoch]);

  // Debounce the AMBIENT UNCERTAINTY loop after each change (TASK-81), the same latest-wins/off-thread discipline
  // as the sim. `runUncertaintyPass` self-gates on `hasRanges` (idle = zero work when nothing is ranged).
  useEffect(() => {
    if (loadError !== false) return;
    let t: ReturnType<typeof setTimeout>;
    const schedule = (): void => { clearTimeout(t); t = setTimeout(runUncertaintyPass, 500); };
    schedule();
    const off = studio.onChange(schedule);
    return () => { clearTimeout(t); off(); };
  }, [loadError, docEpoch]);

  // Debounce the AMBIENT TWO-TIER TRANSIENT after each change (doc: load-stages §10) — the resting refine, a touch
  // after the sim so it fires as the design settles. `runTwoTier` self-gates on a shaped generator (idle = zero work).
  useEffect(() => {
    if (loadError !== false) return;
    let t: ReturnType<typeof setTimeout>;
    const schedule = (): void => { clearTimeout(t); t = setTimeout(runTwoTier, 600); };
    schedule();
    const off = studio.onChange(schedule);
    return () => { clearTimeout(t); off(); };
  }, [loadError, docEpoch]);

  if (loadError === null) {
    return <div className="pane-state"><div className="pane-msg"><b>Loading design…</b><span>Waiting for the document from VS Code.</span></div></div>;
  }
  if (typeof loadError === 'string') {
    return (
      <div className="pane-state error">
        <div className="pane-msg">
          <b>Cannot open this design</b>
          <span>The file is not a valid SDA project (it may have been hand-edited). Fix the JSON and reopen.</span>
          <code className="pane-err">{loadError}</code>
        </div>
      </div>
    );
  }
  return <App key={docEpoch} studio={studio} bridge={bridge} />;
}

createRoot(document.getElementById('root')!).render(<Root />);

// DEV HARNESS: when running in a plain browser (`pnpm --filter sda-vscode run dev:webview`), there is no host to
// send a docInit. Feed a sample design so the canvas is explorable — the same checkout path the web shell seeds.
// No-op inside a real webview (devHarness only injects under the dev stub). A frame later, so the message listener
// (mounted in Root's effect) is already attached.
if (!api.isHost) {
  setTimeout(() => devHarness()({ type: 'docInit', text: serialize(sampleProject()) }), 0);
}

/** A small, explorable seed for the dev harness: the checkout path (client → NGINX → API → Postgres) with a
 *  throughput SLO on Postgres and two tier boundaries — mirrors the web shell's seed. Built via the Studio's own
 *  commands so it is guaranteed valid, then serialized as the docInit text. */
function sampleProject(): ProjectDoc {
  const s = new Studio(registry, allManifests);
  const add = (id: string, type: string, x: number, y: number): void => void s.dispatch({ kind: 'addComponent', id, type, x, y });
  add('client', 'client.web', 40, 250);
  add('nginx', 'proxy.nginx', 260, 250);
  add('app', 'compute.service', 500, 250);
  add('pg', 'db.postgres', 780, 250);
  s.dispatch({ kind: 'setLabel', id: 'client', label: 'Web client' });
  s.dispatch({ kind: 'setLabel', id: 'nginx', label: 'NGINX' });
  s.dispatch({ kind: 'setLabel', id: 'app', label: 'Checkout API' });
  s.dispatch({ kind: 'setLabel', id: 'pg', label: 'Postgres' });
  s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['nginx', 'in'] });
  s.dispatch({ kind: 'connect', from: ['nginx', 'out'], to: ['app', 'in'] });
  s.dispatch({ kind: 'connect', from: ['app', 'db'], to: ['pg', 'in'] });
  s.dispatch({ kind: 'setSLO', node: 'pg', key: keys.throughput, band: { shape: 'minTargetMax', min: 5000 } });
  // A per-port TRANSFORM so the dev harness shows the R2 edge pill (doc: flow-transformations-r2): the API emits
  // ×100 writes to Postgres (a chatty write path) — the DB edge earns an amber "×100 → …" pill. Dev-only seed.
  s.dispatch({ kind: 'setTransform', node: 'app', port: 'db', transform: { kind: 'ratio', value: 100 } });
  s.dispatch({ kind: 'addGroup', id: 'g-edge', label: 'Edge / ingress', x: 10, y: 175, w: 440, h: 200 });
  s.dispatch({ kind: 'assignGroup', node: 'client', group: 'g-edge' });
  s.dispatch({ kind: 'assignGroup', node: 'nginx', group: 'g-edge' });
  s.dispatch({ kind: 'addGroup', id: 'g-app', label: 'Application tier', x: 465, y: 175, w: 480, h: 200 });
  s.dispatch({ kind: 'assignGroup', node: 'app', group: 'g-app' });
  s.dispatch({ kind: 'assignGroup', node: 'pg', group: 'g-app' });
  return s.project();
}
