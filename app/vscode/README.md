# System Design Assistant — VS Code Extension (host)

Open a `.sda.json` design file and it renders as a **canvas** inside VS Code. The webview is **canvas-only**;
**every other view is a native VS Code control** — that is the whole point of shipping in VS Code rather than a
webview app. The host renders what the canvas computes (web-is-a-dumb-renderer); it never re-derives a number.

- The **`.sda.json` TextDocument is the single source of truth** — native save, dirty indicator, hot-exit, and
  undo/redo all work because every edit (from the canvas OR a native command) is applied as a `WorkspaceEdit`.
- **Components palette** (`sda.components`) — a native tree of every catalog component, grouped by KIND with
  themed codicons. Click one → it is placed on the canvas.
- **System** (`sda.system`) — a native tree of the whole-design summary (throughput/latency/cost/…), tone-tinted
  (`$(error)`/`$(warning)`), rendered verbatim from the canvas's `summary` feed after each evaluation.
- **Selected Node** (`sda.inspector`) — a native tree for the selected node: **Configuration** (click a knob →
  native `InputBox` → the host edits the document → native undo), **Verdicts**, and **Suggestions** (click →
  suggester `QuickPick` → the canvas wires the chosen component).
- **Verdicts appear in the native Problems panel** (violation → Error, warning → Warning, unverified → Info),
  each squiggle anchored to the offending node's `"id"` in the JSON.
- **Live headline metrics in the status bar** (`$(pulse) 2,000 rps · 71 ms · $285/mo · $(error) 2`), visible
  only while an SDA editor is focused. Click it to open **Improve** (or Problems when the design is clean).
- **Improve** (`sda.improve`) — a native flow: pick a goal (meet SLOs / cheapest / fastest) → progress
  notification → multi-select the proposed changes → applied as ONE document edit (native undo).
- **Backward solving runs on the host** via `@sda/mcp` — by default on SDA's own in-process solver (no external
  tool needed; TASK-79 phase 3). The generic MiniZinc/COIN-BC path stays selectable as a one-line rollback and
  referees the in-process answers in CI. If the solver cannot prove a design, the tool returns an honest error
  the host shows verbatim (it never invents an answer).

## Architecture (host side — `src/`)

This half is the **extension host** (Node). It owns the document, the native views, the diagnostics, the status
bar, the solver, and the host↔webview bridge. The **webview** (the canvas UI, in `webview/`) is a separate
agent's deliverable and is CANVAS-ONLY.

| File | Responsibility |
|---|---|
| `extension.ts` | `activate`: register the custom editor, the three native tree views, all `sda.*` commands, the status bar. `sda.newDesign` writes a starter design and opens it. |
| `editor-provider.ts` | `SdaEditorProvider` — the `CustomTextEditorProvider`: CSP webview HTML, document ⇄ canvas sync (echo-guarded), relays solve/problems/status/doc/theme, and forwards the `summary`/`nodeDetail`/`selection` feeds into `ActiveEditorRegistry`. |
| `active-editor.ts` | `ActiveEditorRegistry` — the observable holder of the active editor's document/webview + latest feeds. The trees and commands consume it; the provider publishes to it. Clears on blur/close. |
| `commands.ts` | The native DATA commands: `addComponent`, `revealNode`, `editKnob` (InputBox → host edit), `suggest` (QuickPick), `improve` (goal → solve → multi-select apply). |
| `document-edits.ts` | Pure `(text, intent) → new text` edits, round-tripped through `@sda/core` `serialize`/`deserialize` (percentile-SLO Maps survive); `applyChanges` quantizes via `@sda/content` `quantizeKnob`. |
| `document-write.ts` | `replaceWholeDocument` — the one vscode-facing helper that applies new text as a single full-range `WorkspaceEdit` (one native undo step). Shared by the provider's canvas-sync and every native command. |
| `views/components-tree.ts` | Native palette: catalog components grouped by KIND, click → `sda.addComponent`. |
| `views/system-tree.ts` | Native System view: the `summary` feed rendered as sections + tone-tinted rows. |
| `views/inspector-tree.ts` | Native Inspector: node header → Configuration / Verdicts / Suggestions from `nodeDetail`. |
| `diagnostics.ts` | The `'sda'` `DiagnosticCollection`: maps `WireProblem[]` → native diagnostics on the document URI. |
| `statusbar.ts` | The one live-metrics status-bar item; click → Improve (violations) or Problems (clean). |
| `doc-command.ts` | Opens the generated design doc Markdown beside the canvas. |
| `solver-host.ts` | Runs a `SolveRequest` through a throwaway `Studio` + `@sda/mcp` search tools (in-process solver by default; MiniZinc on rollback). |
| `pure.ts` | vscode-free logic (range-finding, echo guard, status/row formatting, tone icons) — the unit-tested core. |
| `protocol.ts` | **FROZEN** host↔webview message contract (shared with the webview). |

### Native editing loop & the echo guard (integrator note)

A knob edit or an Improve-apply is a **host-initiated** document edit. It goes through `commands.ts`
`applyDocumentEdit`, which applies the new text as a whole-document `WorkspaceEdit` but **deliberately does NOT
arm the provider's echo guard**. The guard only exists to stop the webview's OWN `docChanged` echoing back to it;
a host edit is genuinely external to the canvas, so it must flow through `onDidChangeTextDocument` as a
`docExternal` and the canvas reloads. The webview's `docExternal` handler then records the text as its
last-synced, so it will not bounce a `docChanged` back (no ping-pong).

### Document sync (native-first)

The webview holds a `Studio` for interaction and, after each change, posts `docChanged` with the full
serialized project. The host applies it as a whole-document `WorkspaceEdit` (→ native dirty/undo). When the
document changes *outside* the webview (native undo/redo, git checkout, a manual text edit), the host posts
`docExternal` and the webview reloads. An **echo guard** (`EchoGuard` in `pure.ts`) remembers the last text each
side sent/applied and drops the identical text coming back, so the two never ping-pong. `Ctrl+Z`/`Ctrl+Y` inside
the canvas post `requestUndo`/`requestRedo`; the host runs the built-in `undo`/`redo`, which VS Code routes to
the active custom editor's document — one native history, not a parallel one.

## Build & test

```powershell
pnpm --filter sda-vscode run build:host   # esbuild → dist/extension.js (self-contained; 'vscode' external)
pnpm --filter sda-vscode run build:webview # vite   → dist/webview/*   (the other agent's canvas)
pnpm --filter sda-vscode exec vitest run   # host unit tests (src/host.test.ts, via vitest.config.ts)
```
