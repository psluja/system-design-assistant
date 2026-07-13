// The FROZEN host ↔ webview message protocol. Both sides import THIS file (the webview via a relative
// import — it is plain types + tiny guards, no vscode/node/browser dependency). Keep it dependency-free.
//
// Direction conventions:
//   W2H = webview → host (vscode.postMessage from the canvas)
//   H2W = host → webview (webview.postMessage from the extension)
//
// DOCUMENT SYNC (the native-first design): the TextDocument is the single source of truth.
//   • The webview holds a Studio for INTERACTION; after every change it posts `docChanged` with the full
//     serialized project. The host applies it as a WorkspaceEdit — so VS Code owns dirty state, save,
//     hot-exit and NATIVE undo/redo.
//   • When the document changes OUTSIDE the webview (native undo, git checkout, manual text edit), the
//     host posts `docExternal` and the webview reloads its Studio from the text.
//   • The echo guard: both messages carry the exact `text`; each side remembers the last text it sent or
//     applied and ignores a message whose text equals it.

/** One problem row for the native Diagnostics (Problems panel). */
export interface WireProblem {
  readonly severity: 'violation' | 'warning' | 'unknown';
  /** Node id ('' for whole-design / build errors). The host maps it to a text range in the JSON. */
  readonly node: string;
  readonly key: string;
  readonly message: string; // "Overflow 3,000 req/s — Reduce overflow at pg (…)"
}

/** The live headline metrics for the status bar. */
export interface WireStatus {
  readonly throughputRps?: number;
  readonly latencyMs?: number; // finite real latency at the worst flow terminal; undefined = unknown
  readonly costUsdMonth?: number;
  readonly violations: number;
}

// ── NATIVE-VIEW data feeds ──────────────────────────────────────────────────────────────────────────────
// The webview is CANVAS-ONLY; every other view is a native VS Code control fed by these messages. The
// webview owns the engine, so after each evaluation it posts the full `summary` (System tree), and on each
// selection change / evaluation it posts `nodeDetail` for the selected node (Inspector tree + suggester
// QuickPick). Values are PRE-FORMATTED strings where display-only — the host renders, never re-derives.

/** One line of the System tree: a labelled, pre-formatted value with an optional severity tint. */
export interface SummaryRow {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'ok' | 'warn' | 'bad';
}
export interface SummarySection {
  readonly title: string;
  readonly rows: readonly SummaryRow[];
}
/** A config knob of the selected node — editable natively (InputBox → the HOST edits the document JSON). `group`
 *  is the NODE-CONTEXT-AWARE Inspector section it belongs in ('assumptions' | 'limits' — presenter's
 * `knobGroupFor`), precomputed by the webview (which alone holds the node's manifest) and carried
 *  verbatim: the host RENDERS this feed, it never re-derives a classification from the key alone. */
export interface KnobRow {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly unit: string;
  readonly group: 'assumptions' | 'limits';
}
/** One "what fits" suggestion for an open port of the selected node (native QuickPick). */
export interface SuggestRow {
  readonly port: string;
  readonly dir: 'in' | 'out' | 'bi';
  readonly options: readonly string[]; // component type ids that legally attach
}
export interface NodeDetail {
  readonly node: string; // '' = nothing selected
  readonly label: string;
  readonly typeId: string;
  readonly knobs: readonly KnobRow[];
  readonly verdicts: readonly SummaryRow[];
  readonly suggestions: readonly SuggestRow[];
}

/** One option of the quick-add picker (smoothness): computed by the webview via the shared
 *  @sda/presenter `pickerOptions` (legality-filtered when a port context exists), DISPLAYED natively —
 *  the host shows a QuickPick and answers with `pickResult`; the webview places/wires the pick. */
export interface PickerOptionWire {
  readonly type: string;
  readonly kind: string;
}

export type W2H =
  | { readonly type: 'ready' } // webview booted; host replies with docInit
  | { readonly type: 'pick'; readonly token: number; readonly options: readonly PickerOptionWire[]; readonly placeholder: string }
  | { readonly type: 'docChanged'; readonly text: string }
  | { readonly type: 'problems'; readonly items: readonly WireProblem[] }
  | { readonly type: 'status'; readonly status: WireStatus }
  | { readonly type: 'summary'; readonly sections: readonly SummarySection[] } // feeds the native System tree
  | { readonly type: 'nodeDetail'; readonly detail: NodeDetail } // feeds the native Inspector tree
  | { readonly type: 'selection'; readonly node: string | null } // canvas selection changed
  | { readonly type: 'designDoc'; readonly markdown: string; readonly title: string }
  | { readonly type: 'requestUndo' } // Ctrl+Z pressed inside the webview → run the NATIVE undo on the document
  | { readonly type: 'requestRedo' };

export type H2W =
  | { readonly type: 'docInit'; readonly text: string }
  | { readonly type: 'docExternal'; readonly text: string }
  | { readonly type: 'theme'; readonly kind: 'light' | 'dark' } // mirrors the editor color theme
  // Commands forwarded to the canvas. Canvas-GEOMETRY concerns only (placement/layout/selection); every
  // DATA mutation (config, SLO, apply-solve) happens HOST-side as a native document edit.
  // `idealLayout` is this union's ONE deliberate evolution (owner ruling: a visible command must RUN the
  // sparkle, never lecture): it triggers the canvas's own '✨ Ideal' pipeline (webview/ideal-layout.ts —
  // MEASURED node sizes, floor→polish), exactly the toolbar button path. The layout must run in the webview
  // because only the canvas knows the rendered footprints; the host merely says the word.
  | { readonly type: 'cmd'; readonly cmd: 'tidy' | 'fitView' | 'addGroup' | 'generateDesignDoc' | 'idealLayout' }
  | { readonly type: 'pickResult'; readonly token: number; readonly picked: string | null } // QuickPick answer (null = dismissed)
  | { readonly type: 'addComponent'; readonly comp: string } // palette tree click → place on canvas (webview picks a free spot)
  | { readonly type: 'select'; readonly node: string | null } // e.g. Inspector "reveal" — canvas mirrors native selection
  | { readonly type: 'wireSuggestion'; readonly node: string; readonly port: string; readonly comp: string }; // suggester QuickPick accepted

export const isW2H = (m: unknown): m is W2H => typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
export const isH2W = (m: unknown): m is H2W => typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
