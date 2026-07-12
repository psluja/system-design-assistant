// The in-VS-Code test suite (loaded by @vscode/test-electron). A minimal hand-rolled runner — no mocha:
// each check throws on failure; the exported run() rejects and the launcher exits non-zero.
//
// What an END-TO-END pass proves: the extension activates on a real .sda.json, the CUSTOM EDITOR resolves
// (webview bundle loads), the webview boots the engine, evaluates the design and posts problems back, and
// the host republishes them as NATIVE diagnostics — the full host↔webview↔engine loop.
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

/** A saturated two-tier design (client 10,000 rps → postgres capped at 2000) — guaranteed violations, so
 *  diagnostics MUST appear. The HIGH rate doubles as the FREEZE-REGRESSION test: a synchronous DES at 10k rps
 *  once blocked the webview (and the whole workbench) for tens of seconds — if that regresses, the problems
 *  post never reaches the host inside the 30s diagnostics timeout and this suite fails.
 *
 *  The `pg` node also carries a USER SLO (throughput ≥ 5,000 req/s — the exact persisted band shape from
 *  examples/cqrs.sda.json): this exercises the SLO Test Explorer's refresh path at activation and on text-open
 *  with real SLO content present, without throwing. (The controller's item→result mapping is covered exhaustively
 *  by the pure unit tests in src/slo-tests-pure.test.ts — VS Code exposes no public API to enumerate a controller's
 *  items, so we don't assert them fragilely here; we assert the extension stays healthy with SLO content.) */
const SATURATED_DESIGN = JSON.stringify({
  schema: 3,
  id: 'it',
  name: 'integration',
  instances: [
    { id: 'client', type: 'client.web', config: { throughput: 10000 } },
    // The percentile SLO doubles as the SIM-WORKER PROBE: a p99 verdict can ONLY come from the DES tail
    // (the scalar pass returns `unknown` for percentiles), so an Error-severity tailLatency diagnostic
    // proves the webview's Web Worker actually booted and simulated inside a REAL VS Code webview.
    { id: 'pg', type: 'db.postgres', bands: [
      { key: 'throughput', band: { shape: 'minTargetMax', min: 5000 } },
      { key: 'tailLatency', band: { shape: 'percentiles', targets: { __map: [['p99', 300]] } } },
    ] },
  ],
  wires: [{ from: ['client', 'out'], to: ['pg', 'in'] }],
  layout: {}, labels: {}, descriptions: {}, groups: [], components: [],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, check, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what} (${timeoutMs} ms)`);
    await sleep(250);
  }
}

exports.run = async function run() {
  // 1 — all contributed commands are registered once the extension activates.
  const file = path.join(os.tmpdir(), `sda-it-${Date.now()}.sda.json`);
  // CRLF REGRESSION (the "Copilot file" freeze): write the design with WINDOWS line endings, exactly like a
  // file authored by an AI agent's file tools. The TextDocument then normalizes every applied LF edit back to
  // CRLF; before the EchoGuard became EOL-insensitive that spun the docChanged<->docExternal loop forever
  // (constant re-evaluation, permanently dirty, a frozen "self-reopening" editor). With the loop alive, the
  // diagnostics/tidy/dirty steps below never settle inside their timeouts - this suite catches the regression.
  fs.writeFileSync(file, JSON.stringify(JSON.parse(SATURATED_DESIGN), null, 2).replace(/\n/g, '\r\n'), 'utf8');
  const uri = vscode.Uri.file(file);
  await vscode.commands.executeCommand('vscode.openWith', uri, 'sda.designEditor');

  // the tab must be OUR custom editor
  await until('the sda custom editor tab', () => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return tab && tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'sda.designEditor';
  }, 15000);

  const cmds = await vscode.commands.getCommands(true);
  for (const c of ['sda.newDesign', 'sda.tidy', 'sda.idealLayout', 'sda.fitView', 'sda.improve', 'sda.compareOptions', 'sda.suggest', 'sda.addComponent', 'sda.editKnob', 'sda.setSlo', 'sda.setSystemRequirement', 'sda.removeSlo', 'sda.setGuaranteeSlo', 'sda.clearGuaranteeSlo', 'sda.setPortTransform', 'sda.clearPortTransform', 'sda.setWireTransform', 'sda.setRange', 'sda.clearRange', 'sda.generateDesignDoc']) {
    assert.ok(cmds.includes(c), `command ${c} is registered`);
  }

  // NATIVE VIEWS: each contributed tree view gets an auto-generated `<id>.focus` command; executing it
  // proves the view is registered and its container resolves (throws on an unknown view).
  for (const v of ['sda.components.focus', 'sda.system.focus', 'sda.inspector.focus']) {
    await vscode.commands.executeCommand(v);
  }
  // return focus to the canvas tab for the remaining checks
  await vscode.commands.executeCommand('vscode.openWith', uri, 'sda.designEditor');

  // 2 — the webview engine evaluates and the host republishes NATIVE diagnostics for the saturated design.
  const diags = await until('sda diagnostics on the document', () => {
    const ds = vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'sda');
    return ds.length > 0 ? ds : null;
  }, 30000);
  assert.ok(diags.some((d) => d.severity === vscode.DiagnosticSeverity.Error), 'at least one ERROR-severity diagnostic (the saturated tier)');
  const text = diags.map((d) => d.message).join(' | ');
  assert.ok(/overflow|throughput/i.test(text), `diagnostic messages mention the real bottleneck (got: ${text.slice(0, 200)})`);

  // 2b — the SIM WORKER runs inside the real webview AND the LATENCY v2 per-node RESPONSE plumbing is wired end to
  // end. The p99 SLO on `pg` (a requirement-bearing node) is now judged against
  // pg's OWN response tail — the per-node reservoir the DES produces, carried through the shared SimTail's
  // `nodeResponse` and read by the presenter's `simVerdicts` with the sink gate DROPPED. A REAL (Error) tailLatency
  // diagnostic whose message carries the measured p99 ms proves the WHOLE chain: worker → main SimTail{nodeResponse}
  // → presenter → native diagnostic. Were the per-node payload dropped, pg's tail would read `unknown` and NO Error
  // tailLatency diagnostic would appear — so this asserts the R3 plumbing, not merely "a worker ran". The same
  // per-node number feeds the canvas response chip + the native Inspector row (not enumerable via the VS Code API,
  // so proven by the presenter unit tests + app/web's latency-chips e2e; here we assert the number it computes).
  const tailDiag = await until('the tail-latency (DES per-node response) diagnostic — proves the R3 per-node payload', () => {
    const ds = vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'sda');
    return ds.find((d) => String(d.code) === 'tailLatency' && d.severity === vscode.DiagnosticSeverity.Error) ?? null;
  }, 90000);
  assert.ok(/\d/.test(tailDiag.message) && /ms/i.test(tailDiag.message), `the tail-latency diagnostic carries the measured per-node p99 in ms (got: ${tailDiag.message.slice(0, 160)})`);

  // 2c — THE WHOLE-SYSTEM PROMISE (owner ruling, final: the system 'Add promise…' offers ONLY cost — the whole-
  // design sum). Drive the REAL `sda.setSystemRequirement` command with the UI surfaces intercepted (the standard
  // extension-test technique: the test runner shares the extension host's `vscode` API object). THE ASSERTION THAT
  // IS THE POINT: because there is exactly ONE quantity, the command AUTO-SELECTS cost — it shows NO QuickPick at
  // all (no quantity pick, and certainly no flow pick), mirroring how the node flow pre-targets. It goes straight to
  // the value InputBox and lands the promise in the document's top-level `systemPromises` container (schema 9) —
  // never a node band in disguise. Latency/availability/throughput are JOURNEY quantities set on a NODE (sda.setSlo).
  const quickPicks = [];
  const realShowQuickPick = vscode.window.showQuickPick;
  const realShowInputBox = vscode.window.showInputBox;
  try {
    vscode.window.showQuickPick = async (items, options) => {
      // Any QuickPick at all is a regression — cost is auto-selected. Record its title and cancel so a stray pick
      // can never silently complete some multi-quantity path.
      quickPicks.push(options && options.title ? String(options.title) : '(untitled)');
      return undefined;
    };
    vscode.window.showInputBox = async () => '12345';
    await vscode.commands.executeCommand('sda.setSystemRequirement');
    const promiseDoc = await until('the whole-system cost promise to land in doc.systemPromises', () => {
      const d = vscode.workspace.textDocuments.find((x) => x.uri.fsPath === uri.fsPath);
      if (!d) return null;
      try {
        const parsed = JSON.parse(d.getText());
        const p = Array.isArray(parsed.systemPromises) ? parsed.systemPromises.find((x) => x.key === 'cost') : undefined;
        return p && p.band && p.band.max === 12345 ? parsed : null;
      } catch { return null; }
    }, 30000);
    assert.strictEqual(quickPicks.length, 0, `the system 'Add promise…' offers ONLY cost, so it auto-selects (NO QuickPick — no quantity pick, no flow pick); got: ${quickPicks.join(' | ')}`);
    // The promise is DATA in the top-level container — and no instance gained a cost band in disguise.
    assert.ok((promiseDoc.instances || []).every((i) => !(i.bands || []).some((b) => b.key === 'cost')), 'no node cost band was written — the promise is system-scoped data');
  } finally {
    vscode.window.showQuickPick = realShowQuickPick;
    vscode.window.showInputBox = realShowInputBox;
  }

  // 2d — ONE FORM on the REAL surface (the consistency bug fix): the System 'Promises' section is a real PARENT whose
  // children are the declared promise row(s) AND 'Add promise…' as the LAST child — NEVER a floating top-level Add.
  // VS Code exposes NO public API to enumerate a TreeDataProvider's items, so we read the LIVE provider VS Code
  // actually renders from, exposed via the extension's activate() API (SdaExtensionApi). We assert on the exact tree
  // the human sees: getChildren(root) must NOT contain 'Add promise…'; getChildren(Promises) MUST (as its last
  // child), alongside the whole-system cost promise row that step 2c declared. This is the verify-on-owner-surface
  // discipline for a native tree we cannot pixel-dump — the getChildren hierarchy IS the rendered structure.
  await vscode.commands.executeCommand('vscode.openWith', uri, 'sda.designEditor');
  const api = vscode.extensions.getExtension('sda.sda-vscode')?.exports;
  assert.ok(api && api.systemTree && typeof api.promisesTitle === 'string', 'the extension exposes { systemTree, promisesTitle } for real-surface verification');
  const treeLabel = (item) => {
    const ti = api.systemTree.getTreeItem(item);
    return typeof ti.label === 'string' ? ti.label : (ti.label && ti.label.label) || '';
  };
  const promisesShape = await until('the System tree Promises parent to carry the cost row + the Add child', async () => {
    const roots = await api.systemTree.getChildren();
    if (!Array.isArray(roots) || roots.length === 0) return null;
    const rootLabels = roots.map(treeLabel);
    const promisesRoots = roots.filter((r) => r.kind === 'section' && treeLabel(r) === api.promisesTitle);
    if (promisesRoots.length !== 1) return null; // exactly ONE Promises parent (the shared title)
    const children = await api.systemTree.getChildren(promisesRoots[0]);
    const childLabels = children.map(treeLabel);
    const hasAddChild = childLabels.includes('Add promise…');
    const hasCostRow = childLabels.some((l) => /cost\s*≤/i.test(l) && /whole system/i.test(l));
    const addAtRoot = rootLabels.includes('Add promise…');
    return hasAddChild && hasCostRow && !addAtRoot ? { rootLabels, childLabels } : null;
  }, 30000);
  assert.ok(!promisesShape.rootLabels.includes('Add promise…'), `no floating top-level 'Add promise…' at the System tree root (got roots: ${promisesShape.rootLabels.join(' | ')})`);
  assert.strictEqual(promisesShape.childLabels.at(-1), 'Add promise…', `'Add promise…' is the LAST child of the Promises section (got: ${promisesShape.childLabels.join(' | ')})`);
  assert.ok(promisesShape.childLabels.some((l) => /cost\s*≤/i.test(l) && /whole system/i.test(l)), `the whole-system cost promise row is a child of the Promises section (got: ${promisesShape.childLabels.join(' | ')})`);
  console.log(`System 'Promises' parent children (real VS Code tree): ${promisesShape.childLabels.join(' | ')}`);

  // 3 — a canvas command round-trips without throwing (tidy mutates layout → the document goes dirty).
  await vscode.commands.executeCommand('sda.tidy');
  await until('the document to become dirty after tidy', () => {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    return doc?.isDirty === true;
  }, 10000);

  // 3a — '✨ Ideal layout' from the palette now RUNS the canvas pipeline. INTENT INVERTED, BY DESIGN: this step
  // used to assert TEXT STABILITY, because the command was an honest SIGNPOST toast while the host↔webview
  // protocol carried no trigger channel (and the elder HOST-side layout had written default-height fiction).
  // The owner ruled the signpost a dead affordance ("a visible command must DO the thing — or not exist"), so
  // the protocol made its one deliberate evolution (`cmd: 'idealLayout'`) and the command now forwards to the
  // CANVAS's own ✨ pipeline (webview/ideal-layout.ts, MEASURED node sizes). The success signal is therefore the
  // OPPOSITE of the old assertion: the DOCUMENT CHANGES, proving the full loop — palette command → host posts
  // the cmd → webview orchestration → move batch → docChanged → WorkspaceEdit. We first SCATTER the layout into
  // a vertical stack no layout pass would produce (an external-style whole-document edit, reloaded via
  // docExternal), so the pipeline provably has work to do; then assert the canvas re-laid it out. The
  // no-fiction/no-write contract lives on where it still applies: the measured-size geometry in
  // webview/ideal-layout.test.ts, and step 4b below (no active canvas ⇒ warns, writes NOTHING).
  await vscode.commands.executeCommand('vscode.openWith', uri, 'sda.designEditor');
  const idealDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  // Quiesce first: step 3's Tidy lands as SEVERAL webview docChanged→WorkspaceEdit hops; the scatter below must
  // land on a settled document or a trailing tidy edit would race it.
  await until('the document text to settle before the scatter', async () => {
    const a = idealDoc.getText();
    await sleep(1500);
    return idealDoc.getText() === a ? a : null;
  }, 30000);
  const scattered = JSON.parse(idealDoc.getText());
  scattered.layout = { client: { x: 0, y: 0 }, pg: { x: 40, y: 600 } };
  const scatterEdit = new vscode.WorkspaceEdit();
  scatterEdit.replace(uri, new vscode.Range(idealDoc.positionAt(0), idealDoc.positionAt(idealDoc.getText().length)), JSON.stringify(scattered, null, 2));
  await vscode.workspace.applyEdit(scatterEdit);
  const textBeforeIdeal = await until('the scattered layout to settle (webview reloaded it via docExternal)', async () => {
    const a = idealDoc.getText();
    await sleep(1500);
    return idealDoc.getText() === a ? a : null;
  }, 30000);
  assert.strictEqual(JSON.parse(textBeforeIdeal).layout.pg.y, 600, 'the scatter landed (pg parked at y=600)');
  await vscode.commands.executeCommand('sda.idealLayout');
  const laidOut = await until('sda.idealLayout to CHANGE the document (the canvas ✨ pipeline ran)', () => {
    const t = idealDoc.getText();
    if (t === textBeforeIdeal) return null;
    const parsed = JSON.parse(t);
    const pg = parsed.layout && parsed.layout.pg;
    // pg leaves its scattered park spot — the floor lays the chain out as a row (client → pg), not a stack.
    return pg && !(pg.x === 40 && pg.y === 600) ? parsed : null;
  }, 30000);
  assert.ok(laidOut.layout.client, 'the pipeline wrote a position for client too');

  // 3b — GENERATE DESIGN DOC (design-doc-v2 R3): the host-side command builds the deliverable from the document text
  // and WRITES it as `<name>-design-doc.html` next to the .sda.json. We pass the format as the command arg so the
  // QuickPick is skipped (headless). Assert the file lands next to the design and carries the C4 SVG + the honest
  // scope sentence — proving the whole host-side build → write path (evaluateText → renderDesignDocHtml → fs.write).
  // The canvas tab must be active (the command reads the active editor); tidy left it focused. First re-open the
  // canvas to be certain focus is on it after the tidy round-trip.
  await vscode.commands.executeCommand('vscode.openWith', uri, 'sda.designEditor');
  const docHtmlPath = uri.fsPath.replace(/\.sda\.json$/i, '') + '-design-doc.html';
  await vscode.commands.executeCommand('sda.generateDesignDoc', 'html');
  await until('the generated design-doc HTML file next to the design', () => (fs.existsSync(docHtmlPath) ? true : null), 15000);
  const docHtml = fs.readFileSync(docHtmlPath, 'utf8');
  assert.ok(docHtml.startsWith('<!DOCTYPE html>'), 'the design doc is a standalone HTML document');
  assert.ok(docHtml.includes('class="c4"'), 'the design doc carries the rendered C4 SVG diagram');
  assert.ok(docHtml.includes('capacity, latency, availability, cost'), 'the design doc states the honest scope sentence');
  fs.rmSync(docHtmlPath, { force: true }); // clean up the artifact this test produced

  // 4 — the SAME file opened as PLAIN TEXT gets the native text INSIGHTS: a hover over a component type string
  // and a per-node verdict codelens. We revert the dirty (tidy) buffer first so `vscode.open` reads the on-disk
  // text, then open it in the DEFAULT (text) editor via openWith 'default' (our custom editor is the default for
  // the .sda.json filename pattern, so `vscode.open` alone would re-open the canvas).
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
  const textDoc = await until('the file open as a text document', () => {
    const active = vscode.window.activeTextEditor;
    return active && active.document.uri.fsPath === uri.fsPath ? active.document : null;
  }, 15000);

  // HOVER: place the position inside the `db.postgres` type string and require a hover that names the type id.
  const raw = textDoc.getText();
  const typeOffset = raw.indexOf('db.postgres');
  assert.ok(typeOffset >= 0, 'the design text contains the db.postgres type');
  const typePos = textDoc.positionAt(typeOffset + 2); // a couple of chars into the id, safely inside the quotes
  const hovers = await until('a hover over the type string', async () => {
    const hs = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, typePos);
    return Array.isArray(hs) && hs.length > 0 ? hs : null;
  }, 15000);
  const hoverText = hovers
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === 'string' ? c : c.value))
    .join('\n');
  assert.ok(hoverText.includes('db.postgres'), `the hover names the component type (got: ${hoverText.slice(0, 200)})`);

  // CODELENS: at least one lens (one per node) with a non-empty verdict roll-up title.
  const lenses = await until('at least one codelens on the design', async () => {
    const ls = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri);
    return Array.isArray(ls) && ls.length > 0 ? ls : null;
  }, 15000);
  assert.ok(lenses.length >= 1, `at least one node codelens (got ${lenses.length})`);
  assert.ok(lenses.some((l) => l.command && typeof l.command.title === 'string' && l.command.title.length > 0), 'a codelens carries a verdict roll-up title');

  // 4b — NO ACTIVE CANVAS (owner: no dead affordances, so honestly ABSENT): with the design focused as TEXT, the
  // palette / editor-title / keybinding entries for sda.idealLayout are hidden by their `when` clause
  // (activeCustomEditorId == sda.designEditor) — VS Code offers no dead entry to click. The command ID itself
  // remains programmatically invokable (executeCommand ignores `when`), and that unreachable last resort must
  // stay honest: it warns ("open a design first") and writes NOTHING — the buffer is byte-identical after it.
  // Settle first: the RETAINED (hidden) webview re-populates the empty layout after step 4's revert; snapshot on
  // a quiet buffer so that late edit cannot masquerade as an idealLayout write.
  const textBeforeNoCanvas = await until('the text buffer to settle before the no-canvas check', async () => {
    const a = textDoc.getText();
    await sleep(1500);
    return textDoc.getText() === a ? a : null;
  }, 30000);
  await vscode.commands.executeCommand('sda.idealLayout');
  await sleep(1500); // give any (regressed) stray edit time to land — it must not
  assert.strictEqual(textDoc.getText(), textBeforeNoCanvas, 'sda.idealLayout with no active canvas edits nothing (honest warning only)');

  // 5 — the SLO Test Explorer coexists healthily. We can't publicly enumerate a controller's items, so we assert
  // the Testing surface is reachable and the refresh command runs without throwing while an SLO-bearing design is
  // open as text (the controller's refresh evaluated the design with a real user SLO present). The item→result
  // mapping itself is proven by src/slo-tests-pure.test.ts.
  await vscode.commands.executeCommand('workbench.view.testing.focus');
  await vscode.commands.executeCommand('testing.refreshTests'); // no-throw: the controller registered a run profile
  const testCmds = await vscode.commands.getCommands(true);
  assert.ok(testCmds.includes('testing.runAll'), 'the Testing view is available (built-in run command present)');

  // 6 — LIVE-RELOAD ROUND-TRIP: an EXTERNAL write to the open .sda.json — exactly what the MCP
  // save_design tool does — must live-reload the canvas through the editor-provider's docExternal path (the whole
  // "AI moves my canvas" mechanism). Open a fresh SATURATED design in the custom editor (Error diagnostics appear),
  // then externally overwrite the SAME file with a HEALTHY design and assert the Error diagnostics CLEAR: that can
  // only happen if the webview reloaded the changed-on-disk document and re-evaluated it. The MCP unit tests prove
  // save_design writes the right bytes to the right path; this proves writing those bytes to the OPEN file reloads
  // the canvas — together, the full save_design → live-canvas chain.
  // The file MUST live inside a watched workspace folder, or VS Code never detects the external write and cannot
  // reload the open document (the launcher opens a temp folder as the workspace for exactly this).
  const wsFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
    ? vscode.workspace.workspaceFolders[0].uri.fsPath
    : os.tmpdir();
  const reloadFile = path.join(wsFolder, `sda-reload-${Date.now()}.sda.json`);
  fs.writeFileSync(reloadFile, JSON.stringify(JSON.parse(SATURATED_DESIGN), null, 2), 'utf8');
  const reloadUri = vscode.Uri.file(reloadFile);
  await vscode.commands.executeCommand('vscode.openWith', reloadUri, 'sda.designEditor');
  await until('reload: the saturated design produces Error diagnostics', () => {
    const ds = vscode.languages.getDiagnostics(reloadUri).filter((d) => d.source === 'sda' && d.severity === vscode.DiagnosticSeverity.Error);
    return ds.length > 0 ? ds : null;
  }, 30000);
  // The webview populates the design's empty `layout` on load → the document goes DIRTY, and VS Code will not
  // auto-reload a dirty document on an external change. Save it (clean) first, so the external write below is
  // detected and reloaded — mirroring the real flow where the human's file is saved before the agent edits it.
  await vscode.commands.executeCommand('workbench.action.files.save');
  await until('reload: the open document is clean (not dirty) before the external write', () => {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === reloadUri.fsPath);
    return doc && doc.isDirty === false ? true : null;
  }, 10000);
  // A HEALTHY design (client 100 rps → postgres at default capacity, no SLO) written to the SAME path — an external
  // write exactly like save_design. The clean, watched document reloads it (editor-provider docExternal).
  const HEALTHY_DESIGN = JSON.stringify({
    schema: 3, id: 'reloaded', name: 'reloaded',
    instances: [{ id: 'client', type: 'client.web', config: { throughput: 100 } }, { id: 'pg', type: 'db.postgres' }],
    wires: [{ from: ['client', 'out'], to: ['pg', 'in'] }],
    layout: {}, labels: {}, descriptions: {}, groups: [], components: [],
  });
  fs.writeFileSync(reloadFile, JSON.stringify(JSON.parse(HEALTHY_DESIGN), null, 2), 'utf8');
  await until('reload: the canvas picked up the external write (Error diagnostics cleared = docExternal live-reload)', () => {
    const ds = vscode.languages.getDiagnostics(reloadUri).filter((d) => d.source === 'sda' && d.severity === vscode.DiagnosticSeverity.Error);
    return ds.length === 0 ? true : null;
  }, 30000);
  // 6b — LOAD STAGES (the ambient two-tier transient): the global `sda.stressProbe` command is DELETED (doc:
  // load-stages §2). The transient question is now answered by the AMBIENT two-tier read-out, composed in the
  // webview and surfaced as a plain System-tree summary section (no command to drive). Its pure computation +
  // presenter mapping are pinned by content/sda/src/analysis/two-tier.e2e.test.ts, app/mcp/src/simulate-load-stages.test.ts
  // and app/presenter/src/two-tier-view.test.ts; authoring cycles from the webview UI lands in a later round (R3).
  fs.rmSync(reloadFile, { force: true });

  console.log(`PASS — custom editor resolved, ${diags.length} native diagnostic(s), system promise picker verified (Cost = whole system, auto-selected, NO QuickPick, no flow asked, landed in systemPromises — no node band), System 'Promises' section is a real parent with 'Add promise…' as its LAST child (no floating top-level Add — one form with the node Inspector), tidy round-tripped to a dirty document, palette idealLayout ran the canvas ✨ pipeline (document re-laid out; no-canvas invocation wrote nothing), ${hovers.length} hover + ${lenses.length} codelens on the text view; SLO Test Explorer coexists (refresh ran clean); external-write live-reload (save_design → docExternal) verified; the global stress-probe command is removed (the load-stages transient is ambient)`);
};
