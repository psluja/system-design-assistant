import * as vscode from 'vscode';
import * as path from 'node:path';

// Presenting the generated design doc. Two paths:
//   • openDesignDoc — the LEGACY webview round-trip (the canvas authors Markdown and posts it): opened as an
//     untitled Markdown document beside the canvas. Kept intact (protocol.ts is frozen; the message field is
//     literally `markdown`), even though the file-writing command below no longer uses it.
//   • writeDesignDocBesideSource — the R3 file-writing path: the doc is built HOST-SIDE (design-doc-host.ts) and
//     WRITTEN as `<name>-design-doc.<ext>` next to the source .sda.json, then opened. An HTML report opens in the
//     default browser (so its inline SVG/charts render properly); a Markdown doc opens in the editor (native
//     Markdown preview). Either way we show an info toast naming the file, so the write is never silent-and-hidden.

/**
 * Open `markdown` as a new untitled Markdown document beside the active editor. `title` is not a filename (an
 * untitled doc has none) but is used to log/annotate; VS Code shows the untitled tab as "Untitled-N". The
 * content becoming a real file is the user's explicit Save — the doc is a derivable artifact, never silently
 * persisted.
 */
export async function openDesignDoc(markdown: string, _title: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown });
  // Beside the canvas (ViewColumn.Beside) so the design and its document sit side by side — the natural
  // "read the spec next to the diagram" layout. `preview: false` keeps it as a real tab, not a transient peek.
  await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
}

/**
 * Write the generated design doc as `<source-basename>-design-doc.<ext>` NEXT TO the source `.sda.json`, then open
 * it: an HTML report in the default browser (so the inline C4 SVG + charts render — VS Code's Simple Browser can't
 * load a `file://` under its CSP), a Markdown doc in the editor beside the source (native Markdown preview). An info
 * message names the written file (with a Reveal action), so the write is explicit, not a silent side effect. Returns
 * the written file URI (the file-writing command / its test read it back).
 */
export async function writeDesignDocBesideSource(source: vscode.Uri, text: string, format: 'html' | 'markdown'): Promise<vscode.Uri> {
  const ext = format === 'html' ? 'html' : 'md';
  // Strip the source's own extension(s) so `checkout.sda.json` → `checkout-design-doc.html` (not `checkout.sda-…`).
  const dir = path.dirname(source.fsPath);
  const base = path.basename(source.fsPath).replace(/\.sda\.json$/i, '').replace(/\.[^.]+$/, '');
  const target = vscode.Uri.file(path.join(dir, `${base}-design-doc.${ext}`));

  await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));

  if (format === 'html') {
    // The default handler renders the self-contained report (inline SVG/CSS) properly — the least surprising place
    // to read a finished HTML deliverable. The editor's Simple Browser blocks a file:// under its CSP, so we don't
    // use it here.
    await vscode.env.openExternal(target);
  } else {
    const document = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  }

  // The toast is FIRE-AND-FORGET (not awaited): the file is already written and opened — the command's job is done,
  // so it must resolve now. Awaiting `showInformationMessage` would stall the command until the toast is dismissed
  // (it resolves only on click / auto-dismiss), hanging a caller that awaits the command (e.g. the e2e test).
  void vscode.window
    .showInformationMessage(`SDA: wrote ${path.basename(target.fsPath)} next to the design.`, 'Reveal in Explorer')
    .then((choice) => (choice === 'Reveal in Explorer' ? vscode.commands.executeCommand('revealFileInOS', target) : undefined));
  return target;
}
