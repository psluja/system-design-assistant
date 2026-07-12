import * as vscode from 'vscode';
import { formatMs } from '@sda/presenter';
import { sloItems, verdictForSlo, num, type SloItem } from './slo-tests-pure';
import { evaluateText } from './host-eval';
import { findNodeIdRange, isDimensionlessUnit } from './pure';

// The SLO Test Explorer: every USER SLO (an `instance.bands` entry — the requirements an architect states on a node)
// becomes a native TEST in VS Code's Testing view. There is no auto-run; the user presses Run and each SLO passes
// when its verdict is ok, fails with the computed value + first remediation when it breaches, and is SKIPPED (never
// a fake pass/fail) when the design does not build or the verdict is honestly `unknown`. Percentile (tail) SLOs are
// skipped with a pointer to the canvas simulation — the host has no DES tail to judge them against.
//
// Items refresh off the ACTIVE `.sda.json` text: on an active-editor change and on a (debounced) document edit, so
// the test list tracks the design the user is looking at. Everything decision-y lives in `slo-tests-pure.ts`; this
// file is the thin vscode glue (controller, run profile, item ranges).

const CONTROLLER_ID = 'sdaSlos';
const REFRESH_DEBOUNCE_MS = 300;

/**
 * Register the SLO test controller and return it as a Disposable (the caller pushes it onto subscriptions). The
 * controller owns its refresh subscriptions internally so a single dispose tears the whole feature down.
 */
export function registerSloTests(): vscode.Disposable {
  return new SdaSloTests();
}

class SdaSloTests implements vscode.Disposable {
  private readonly controller: vscode.TestController;
  private readonly subscriptions: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.controller = vscode.tests.createTestController(CONTROLLER_ID, 'SDA SLOs');

    // ONE run profile: evaluate the active design and judge each SLO. No auto-run (the user presses Run) and no
    // debug/coverage profiles — an SLO check is a plain forward evaluation.
    this.controller.createRunProfile('Check SLOs', vscode.TestRunProfileKind.Run, (request, token) => this.run(request, token), true);

    // Refresh the item tree whenever the active editor changes (a different `.sda.json` gains focus) and whenever an
    // open `.sda.json` is edited (debounced — an edit fires many change events). The active TEXT is the source.
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (isSdaDoc(e.document)) this.scheduleRefresh();
      }),
      vscode.workspace.onDidCloseTextDocument((d) => {
        // Drop a closed design's items so the Testing view never shows SLOs for a file that is no longer open.
        if (isSdaDoc(d)) this.refresh();
      }),
    );

    this.refresh(); // seed from whatever is active at activation
  }

  /** Debounce a burst of document changes into one refresh (VS Code fires onDidChangeTextDocument per keystroke). */
  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  /**
   * Rebuild the item tree from the ACTIVE `.sda.json` text: one root item per design file, one child per user SLO.
   * A non-SDA active editor (or none) clears the items — the Testing view then shows only what the current design
   * declares, never stale SLOs. Each SLO item is anchored to its node's `"id"` line so "Go to Test" jumps there.
   */
  private refresh(): void {
    const doc = activeSdaDocument();
    // Rebuild from scratch each time — the SLO set is small and this keeps the tree exactly in sync with the text
    // (no orphaned items when an SLO is deleted). `replaceItems([])` clears when there is no SDA design active.
    if (doc === undefined) {
      this.controller.items.replace([]);
      return;
    }

    const text = doc.getText();
    const slos = sloItems(text);
    const fileItem = this.controller.createTestItem(doc.uri.toString(), doc.uri.path.split('/').pop() ?? 'design', doc.uri);
    fileItem.canResolveChildren = false;
    for (const slo of slos) {
      const item = this.controller.createTestItem(`${doc.uri.toString()}::${slo.id}`, slo.label, doc.uri);
      const anchor = findNodeIdRange(text, slo.node);
      if (anchor !== null) {
        // Anchor at the node's id VALUE so the Testing view's "Go to Test" reveals the owning node in the text view.
        item.range = new vscode.Range(anchor.line, anchor.startCol, anchor.line, anchor.endCol);
      }
      fileItem.children.add(item);
    }
    // Only surface the file root when it actually carries SLOs — an SDA design with no user SLO shows nothing rather
    // than an empty group (no absent-feature filler).
    this.controller.items.replace(slos.length > 0 ? [fileItem] : []);
  }

  /**
   * Run the requested SLO tests: evaluate the design ONCE, then judge each item. Honest outcomes only:
   *   • the design does not build            → every requested item is `errored` (we cannot judge it);
   *   • a percentile (tail) SLO              → `skipped` (answered by the DES on the canvas, not the host);
   *   • the matching verdict is `unknown`    → `skipped` with the reason (never a fake pass/fail);
   *   • the verdict is `ok`                  → `passed`;
   *   • otherwise (violation / warning)      → `failed` with the computed value + first remediation.
   */
  private run(request: vscode.TestRunRequest, token: vscode.CancellationToken): void {
    const run = this.controller.createTestRun(request);
    const items = this.requestedItems(request);

    // Resolve the design text from the first item's uri (all items in one run share the active design file).
    const uri = items[0]?.uri;
    const doc = uri !== undefined ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) : undefined;
    if (doc === undefined) {
      for (const item of items) run.skipped(item);
      run.end();
      return;
    }

    const text = doc.getText();
    const evalResult = evaluateText(text);
    const slos = new Map(sloItems(text).map((s) => [`${uri!.toString()}::${s.id}`, s]));

    for (const item of items) {
      if (token.isCancellationRequested) break;
      run.started(item);
      const slo = slos.get(item.id);
      if (slo === undefined) {
        // The item no longer maps to a declared SLO (the text changed since the tree was built) — skip honestly.
        run.skipped(item);
        continue;
      }
      this.judge(run, item, slo, evalResult);
    }
    run.end();
  }

  /** Apply the honest verdict → test-result mapping for one SLO item. Pure decision, side-effect only on `run`. */
  private judge(run: vscode.TestRun, item: vscode.TestItem, slo: SloItem, evalResult: ReturnType<typeof evaluateText>): void {
    if (evalResult === null) {
      // The design does not build/evaluate — we cannot honestly pass OR fail the SLO. `errored` says "could not run".
      run.errored(item, new vscode.TestMessage('The design does not build — cannot evaluate this SLO. Fix the build errors in the Problems panel first.'));
      return;
    }

    if (slo.isPercentile) {
      // A tail (percentile) SLO needs the DES tail, which the host does not compute. Skip with a clear pointer,
      // UNLESS the forward path already produced a verdict for it (below) — checked next.
      const v = verdictForSlo(slo, evalResult.verdicts);
      if (v === undefined || v.status === 'unknown' || v.status === 'did-not-converge') {
        run.skipped(item);
        run.appendOutput(`${slo.label}: answered by the simulation (tail) — run it on the canvas.\r\n`, undefined, item);
        return;
      }
      // A percentile SLO that DID get a concrete verdict falls through to the normal judging below.
    }

    const verdict = verdictForSlo(slo, evalResult.verdicts);
    if (verdict === undefined) {
      run.skipped(item);
      run.appendOutput(`${slo.label}: no verdict was produced for this SLO (unknown).\r\n`, undefined, item);
      return;
    }

    switch (verdict.status) {
      case 'ok':
        run.passed(item);
        return;
      case 'unknown':
      case 'did-not-converge':
        // Honest ignorance is a SKIP, never a pass or fail (the tool must not lie).
        run.skipped(item);
        run.appendOutput(`${slo.label}: ${verdict.status} — the engine could not determine this value.\r\n`, undefined, item);
        return;
      case 'violation':
      case 'warning': {
        run.failed(item, new vscode.TestMessage(failureMessage(slo, verdict)));
        return;
      }
    }
  }

  /** The items a run request targets: its explicit `include`, or every item in the tree when `include` is absent
   *  (a top-level "Run All"). We flatten to the leaf SLO items (the file root is not itself a test). */
  private requestedItems(request: vscode.TestRunRequest): vscode.TestItem[] {
    const roots: vscode.TestItem[] = [];
    if (request.include !== undefined && request.include.length > 0) {
      roots.push(...request.include);
    } else {
      this.controller.items.forEach((i) => roots.push(i));
    }
    const excluded = new Set(request.exclude ?? []);
    const leaves: vscode.TestItem[] = [];
    const visit = (item: vscode.TestItem): void => {
      if (excluded.has(item)) return;
      if (item.children.size === 0) {
        leaves.push(item);
        return;
      }
      item.children.forEach(visit);
    };
    for (const r of roots) visit(r);
    return leaves;
  }

  dispose(): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    for (const s of this.subscriptions) s.dispose();
    this.controller.dispose();
  }
}

/** The failure message for a breaching SLO: the computed value in its unit, then the first (top-ranked) remediation
 *  the verdict carries — verbatim, never paraphrased (the engine authored it; we relay it). */
function failureMessage(slo: SloItem, verdict: { computed: { value: number; unit: string }; remediations: readonly { action: string; rank: number }[] }): string {
  const computed = verdict.computed.unit === 'ms'
    ? formatMs(verdict.computed.value) // a TIME verdict rounds to whole ms (the shared token carries the unit)
    : `${num(verdict.computed.value)}${isDimensionlessUnit(verdict.computed.unit) ? '' : ` ${verdict.computed.unit}`}`;
  const first = [...verdict.remediations].sort((a, b) => a.rank - b.rank)[0];
  const fix = first !== undefined ? ` — ${first.action}` : '';
  return `${slo.label}: computed ${computed}${fix}`;
}

/** True when a document is an SDA design file (by the `.sda.json` filename pattern). */
function isSdaDoc(doc: vscode.TextDocument): boolean {
  return doc.uri.fsPath.endsWith('.sda.json');
}

/**
 * The `.sda.json` document currently in view — the ACTIVE text editor's document if it is one, else any visible SDA
 * text editor. The custom canvas editor is NOT a text editor, so when the user is on the canvas there is no active
 * text editor; we fall back to a visible SDA text document so the SLO tests still track the open design.
 */
function activeSdaDocument(): vscode.TextDocument | undefined {
  const active = vscode.window.activeTextEditor?.document;
  if (active !== undefined && isSdaDoc(active)) return active;
  const visible = vscode.window.visibleTextEditors.find((e) => isSdaDoc(e.document));
  if (visible !== undefined) return visible.document;
  // Last resort: the first open SDA text document (e.g. the canvas is focused but the file is also open as text).
  return vscode.workspace.textDocuments.find(isSdaDoc);
}
