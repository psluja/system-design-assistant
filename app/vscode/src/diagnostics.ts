import * as vscode from 'vscode';
import type { WireProblem } from './protocol';
import { findNodeIdRange } from './pure';

// Native Problems-panel integration. The webview runs the engine, decides the problems, and hands them to the
// host as WireProblem[]; this module is the ONLY place that knows about `vscode.Diagnostic`. Keeping the
// mapping here (and the range-finding in pure.ts) means the interesting logic is testable and the vscode
// surface is a thin, obvious adapter.

/** Map a WireProblem severity to a native DiagnosticSeverity (protocol.ts: violation→Error, warning→Warning,
 *  unknown→Information — an unverified check is INFO, not an error, so it never masquerades as a failure). */
function toSeverity(severity: WireProblem['severity']): vscode.DiagnosticSeverity {
  switch (severity) {
    case 'violation':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    case 'unknown':
      return vscode.DiagnosticSeverity.Information;
  }
}

/**
 * Owns the single 'sda' DiagnosticCollection. One instance is shared by the provider; each open document's
 * problems are published under that document's URI, so VS Code shows them in the native Problems panel with
 * squiggles at the offending node's id.
 */
export class SdaDiagnostics {
  private readonly collection: vscode.DiagnosticCollection;

  constructor() {
    // A named collection groups our rows under "sda" in the Problems panel and lets us clear them wholesale.
    this.collection = vscode.languages.createDiagnosticCollection('sda');
  }

  /**
   * Replace the diagnostics for `document` with `problems`. The RANGE points at the node's `"id"` value in the
   * document text (found by findNodeIdRange); a whole-design problem (node === '' or an id not present in the
   * text) is anchored at the document start (0,0) so it is still visible and clickable, never dropped.
   */
  publish(document: vscode.TextDocument, problems: readonly WireProblem[]): void {
    const text = document.getText();
    const diagnostics = problems.map((p) => this.toDiagnostic(document, text, p));
    this.collection.set(document.uri, diagnostics);
  }

  private toDiagnostic(document: vscode.TextDocument, text: string, problem: WireProblem): vscode.Diagnostic {
    const range = this.rangeFor(document, text, problem.node);
    const diagnostic = new vscode.Diagnostic(range, problem.message, toSeverity(problem.severity));
    diagnostic.source = 'sda'; // shows as the origin next to the message in the Problems panel
    diagnostic.code = problem.key; // the registry key (e.g. "throughput") — a stable machine-readable code
    return diagnostic;
  }

  /** The text span to underline: the node id declaration, or the very first character for whole-design rows. */
  private rangeFor(document: vscode.TextDocument, text: string, node: string): vscode.Range {
    const found = findNodeIdRange(text, node);
    if (found === null) {
      // Whole-design problem, or the id is not literally in the text — anchor at the document start. Use the
      // document's own first position so the range is always valid even for an empty file.
      const start = new vscode.Position(0, 0);
      return new vscode.Range(start, start);
    }
    return new vscode.Range(new vscode.Position(found.line, found.startCol), new vscode.Position(found.line, found.endCol));
  }

  /** Clear one document's diagnostics (on close), so a closed file leaves no stale rows in the panel. */
  clear(uri: vscode.Uri): void {
    this.collection.delete(uri);
  }

  /** Release the collection (on extension deactivate). */
  dispose(): void {
    this.collection.dispose();
  }
}
