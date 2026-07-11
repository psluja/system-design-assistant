import * as vscode from 'vscode';

// The ONE way host code writes a whole new document text. Both the canvas-sync path (the provider applying a
// webview `docChanged`) and every native command (Inspector knob edit, Improve apply) replace the ENTIRE document
// with freshly-serialized text; doing it as a single full-range `WorkspaceEdit` is deliberate — VS Code coalesces
// it into ONE native undo step (dirty/undo/save for free), never a targeted diff the user didn't author. This is
// vscode-facing glue, so it lives apart from the pure `document-edits.ts` (which stays free of the vscode module).

/**
 * Replace the ENTIRE `document` text with `text` as one full-range `WorkspaceEdit`. A no-op when the text already
 * matches (an empty edit would push a spurious, confusing undo entry). Returns the `applyEdit` result so a caller
 * that cares (e.g. a native refactor preview) can tell whether VS Code committed it.
 */
export async function replaceWholeDocument(document: vscode.TextDocument, text: string): Promise<boolean> {
  if (document.getText() === text) return true; // nothing to do — avoids an empty edit / spurious undo entry
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  edit.replace(document.uri, fullRange, text);
  return vscode.workspace.applyEdit(edit);
}
