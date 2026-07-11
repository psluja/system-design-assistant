// The seam between the pure canvas (`App.tsx`) and the host plumbing (`main.tsx`). App renders and mutates the
// Studio; it reaches the host ONLY through this interface — so the message protocol, the native-view feeds and
// the background simulation scheduling all live in main.tsx, and App stays a testable view. The web shell fuses
// these concerns into one 1600-line component; splitting them here is the VS Code variant's one structural
// improvement (a future shared extraction would push app/web the same way).
//
// CANVAS-ONLY: the webview keeps ONLY the React Flow graph. Every other surface (palette, inspector, System /
// Improve panels, Problems) is a NATIVE VS Code control fed by the messages below. So the bridge is a pure OUTBOUND
// feed (summary / nodeDetail / selection / diagnostics / designDoc) plus an INBOUND action stream (the native
// palette / inspector / suggester driving the canvas). Backward-solving (Improve) is entirely HOST-side now — the
// webview neither initiates nor applies it, so `solve` is gone from this seam.
import type { ProjectDoc } from '@sda/core';
import type { NodeResponseView, PairLagView, UncertaintyState } from '@sda/presenter';
import type { UncertaintyResult, TwoTierResult } from '@sda/content';
import type { W2H, WireProblem, WireStatus, SummarySection, NodeDetail, PickerOptionWire } from '../src/protocol';

/** The DES tail percentiles the background simulation produces (ms). The shape App holds and the summary feed /
 *  p99 verdict read. Kept minimal — only what the webview surfaces (the full sim result stays in main.tsx).
 *  RETRY OUTCOME (doc: retry-feedback §3): goodput/failures/amplification + whether a policy is declared, carried
 *  so the shared summary + verdicts show the retry rows. Optional — absent with no retry story (no filler rows).
 *  LATENCY SEMANTICS v2 (doc §4): per-node RESPONSE tails + declared flow-scoped LAGs, from the same run — carried
 *  so the shared presenter (chip / System rows / per-node tail verdict, sink-gate dropped) reads them off one run. */
export interface SimTail {
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly goodputRps?: number;
  readonly errorRate?: number;
  readonly amplification?: number;
  readonly retryPolicy?: boolean;
  readonly nodeResponse?: readonly NodeResponseView[];
  readonly pairLag?: readonly PairLagView[];
}

/** The ambient Monte-Carlo view the background loop produces (TASK-81): the latest result (null while the first
 *  pass is in flight), the resting-handshake state (fp32 `preview` vs fp64 `confirmed`), which backend ran, and the
 *  measured cadence. App composes it into the System-tree summary via the shared `uncertaintySection` presenter. */
export interface UncertaintyView {
  readonly result: UncertaintyResult | null;
  readonly state: UncertaintyState;
  readonly backend?: 'gpu' | 'cpu';
  readonly elapsedMs?: number;
}

/** The geometry commands the host forwards from the native palette (mirrors the protocol's `cmd` union). Every
 *  DATA mutation (config, SLO, Improve) is now a HOST-side document edit — only layout/selection verbs remain.
 *  `idealLayout` mirrors the union's one deliberate evolution: the palette/keybinding face of the canvas's own
 *  '✨ Ideal' button — the command RUNS the sparkle (measured sizes, floor→polish), never a signpost. */
export type HostCommand = 'tidy' | 'fitView' | 'addGroup' | 'generateDesignDoc' | 'idealLayout';

/**
 * A host→canvas ACTION that changes the graph or the selection — the native palette/inspector/suggester driving
 * the canvas. A discriminated union so each variant carries exactly its own fields (mirrors the protocol's
 * `addComponent` / `select` / `wireSuggestion` H2W messages).
 *  • `addComponent` — a native palette pick: place the component at a free spot and select it.
 *  • `select`       — a native "reveal": mirror the selection on the canvas (and re-fit if off-screen).
 *  • `wireSuggestion` — a native suggester QuickPick accept: add `comp` and auto-wire it to `node.port`.
 */
export type HostAction =
  | { readonly kind: 'addComponent'; readonly comp: string }
  | { readonly kind: 'select'; readonly node: string | null }
  | { readonly kind: 'wireSuggestion'; readonly node: string; readonly port: string; readonly comp: string };

/**
 * The host services App needs. Implemented by main.tsx over the VS Code postMessage channel:
 *  • `post` — any raw W2H message (undo/redo requests, etc.).
 *  • `pick` — the QUICK-ADD picker (TASK-63): hand the host the legality-filtered options (computed by App via
 *    the shared `pickerOptions`) and a placeholder; the host shows a NATIVE QuickPick and answers with the picked
 *    type id, or `null` when dismissed. Token correlation + supersession live in main.tsx, so App just awaits the
 *    Promise. A newer `pick` supersedes any pending one (the older Promise resolves `null` — a no-op for App).
 *  • `serialize` — the exact serializer the host expects (kept here so App doesn't import @sda/core's serialize
 *    twice / diverge; main injects the real one). Used for the design-doc title and nothing else now.
 *  • `onCommand` — register the handler for `{type:'cmd'}` messages (native palette → canvas geometry actions).
 *    App re-registers each render so the handler closes over the freshest state; the LAST registration wins.
 *  • `onAction` — register the handler for host ACTIONS (addComponent / select / wireSuggestion). Same
 *    last-registration-wins repointing as `onCommand`.
 *  • `onSim` — subscribe to background DES tail updates; returns an unsubscribe.
 *  • `postDesignDoc` — hand the generated Markdown to the host (which owns file writing / preview).
 *  • `postDiagnostics` — push the REAL-aware problems + status (the ones the human sees) to the host after every
 *    evaluation, so the native Problems panel and status bar mirror the canvas (web-is-a-dumb-renderer).
 *  • `postSummary` — feed the native System tree after every evaluation (whole-design lenses).
 *  • `postNodeDetail` — feed the native Inspector tree + suggester QuickPick for the current selection.
 *  • `postSelection` — tell the host the canvas selection changed (so the native views follow it).
 * App owns all the computation (it has the sim tail + real-aware verdicts); main only relays.
 */
export interface HostBridge {
  post(message: W2H): void;
  /** Show the native quick-add picker with `options` (already legality-filtered by App) and resolve to the picked
   *  component type id, or `null` when the user dismissed it (or a newer pick superseded this one). */
  pick(options: readonly PickerOptionWire[], placeholder: string): Promise<string | null>;
  serialize(doc: ProjectDoc): string;
  onCommand(handler: (cmd: HostCommand) => void): () => void;
  onAction(handler: (action: HostAction) => void): () => void;
  onSim(handler: (sim: SimTail | null) => void): () => void;
  /** Subscribe to ambient Monte-Carlo updates (TASK-81); returns an unsubscribe. Latest-wins, off-thread. */
  onUncertainty(handler: (unc: UncertaintyView | null) => void): () => void;
  /** Subscribe to the ambient two-tier transient (doc: load-stages §10); returns an unsubscribe. Latest-wins,
   *  off-thread — the Tier-1 preview lands first, the Tier-2 confirm updates it. Null when no generator is shaped. */
  onTwoTier(handler: (twoTier: TwoTierResult | null) => void): () => void;
  postDesignDoc(doc: { readonly markdown: string; readonly title: string }): void;
  postDiagnostics(problems: readonly WireProblem[], status: WireStatus): void;
  postSummary(sections: readonly SummarySection[]): void;
  postNodeDetail(detail: NodeDetail): void;
  postSelection(node: string | null): void;
}
