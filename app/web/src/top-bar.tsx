import { useState, type ChangeEvent, type Dispatch, type MouseEvent as RMouseEvent, type RefObject, type SetStateAction } from 'react';
import type { Studio } from '@sda/core';
import { plural } from '@sda/presenter';
import { VERIFIED_SCOPE_HINT } from '@sda/content';
import type { BridgeStatus } from './bridge';

// The HEADER bar (`.top`), extracted from app.tsx (TASK-89). One row of load-bearing controls: project identity
// (logo · name · saved), the design actions (New / Undo / Redo / Import / Export / Design doc), the agent surfaces
// (MCP tools popover · AI-bridge link) and the headline verdict. Pure presentation over App-owned state — every
// mutation goes back through props to the Studio/App handlers; the bar owns only its OWN popover state (the
// Design-doc format menu, the AI-link token prompt). The MCP-tools popover state stays in App because the global
// Escape handler closes it. Fit behavior (the slim/compact tiers, ≤1439/≤1250px) lives in theme.css "Header FIT TIERS".

/** A header popover's viewport anchor: just under its control, right edges flush. Header popovers render
 *  `position:fixed` (class `top-pop`) because `.top` clips its own box (overflow:hidden — the <1128px header-
 *  compression fix), so an absolutely-positioned card would be cut at the header's bottom edge and appear to
 *  vanish under the canvas. Measured from the clicked control at open time — the same viewport-level escape
 *  the canvas context menu and the transform/range editors use. */
export type TopPop = { readonly top: number; readonly right: number };
export const topPopAnchor = (e: RMouseEvent<HTMLElement>): TopPop => {
  const r = e.currentTarget.getBoundingClientRect();
  return { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) };
};

/** The header bar. `onTryUnlink` returns true when a live bridge handle existed and was closed (the click is
 *  consumed); false lets the click open the token prompt instead — the exact toggle the inline handler had. */
export function TopBar({
  studio, docName, saved, projNameRef, onNewDesign,
  mcpLive, mcpTools, mcpPop, setMcpPop,
  bridge, onTryUnlink, onLinkAI,
  fileRef, onImport, onExport, docReady, onExportDocHtml, onExportDocMd,
  theme, onToggleTheme, onOpenPalette, onOpenHelp, violations, onOpenProblems,
}: {
  studio: Studio;
  docName: string;
  saved: boolean;
  projNameRef: RefObject<HTMLInputElement>;
  onNewDesign: () => void;
  mcpLive: boolean;
  mcpTools: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  mcpPop: TopPop | null;
  setMcpPop: Dispatch<SetStateAction<TopPop | null>>;
  bridge: BridgeStatus;
  onTryUnlink: () => boolean;
  onLinkAI: (token: string) => void;
  fileRef: RefObject<HTMLInputElement>;
  onImport: (e: ChangeEvent<HTMLInputElement>) => void;
  onExport: () => void;
  docReady: boolean;
  onExportDocHtml: () => void;
  onExportDocMd: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onOpenPalette: () => void;
  onOpenHelp: () => void;
  violations: number;
  onOpenProblems: () => void;
}): JSX.Element {
  // The Design-doc split control's format popover (HTML is primary; the caret opens the Markdown option).
  const [docMenu, setDocMenu] = useState<TopPop | null>(null);
  // The AI-link token prompt + its input value (seeded from the last-used token; private mode tolerated).
  const [askToken, setAskToken] = useState<TopPop | null>(null);
  const [tokenInput, setTokenInput] = useState(() => { try { return localStorage.getItem('sda.bridgeToken') ?? ''; } catch { return ''; } });
  const submitToken = (): void => {
    const t = tokenInput.trim();
    if (!t) return;
    try { localStorage.setItem('sda.bridgeToken', t); } catch { /* private mode */ }
    setAskToken(null);
    onLinkAI(t);
  };
  const toggleBridge = (e: RMouseEvent<HTMLElement>): void => {
    if (onTryUnlink()) return;
    const anchor = topPopAnchor(e); // measured NOW — the synthetic event's currentTarget is gone by updater time
    setAskToken((v) => (v ? null : anchor));
  };
  const toolCount = mcpTools.length;
  return (
    <div className="top">
      <div className="logo"><div className="mk"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}><path d="M5 13l4 4 10-11" /></svg></div> SDA</div>
      <div className="crumb">
        <input className="projname" ref={projNameRef} key={docName} defaultValue={docName} title="Project name"
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== docName) studio.dispatch({ kind: 'rename', name: v }); }} />
        <span className="slim-hide"> / checkout-path</span>
        <span className={'savedot ' + (saved ? 'is-saved' : 'is-saving')} title={saved ? 'All changes saved to this browser (IndexedDB). Export for a portable backup.' : 'Saving to this browser…'}>{saved ? '● Saved' : '○ Saving…'}</span>
      </div>
      <button className="btn" title="New design — start a fresh, empty project (Undo restores the current one)" onClick={onNewDesign}>＋ New</button>
      <button className="iconbtn" title="Undo (Ctrl+Z)" disabled={!studio.canUndo()} onClick={() => studio.undo()}>↶</button>
      <button className="iconbtn" title="Redo (Ctrl+Shift+Z)" disabled={!studio.canRedo()} onClick={() => studio.redo()}>↷</button>
      <div className="spacer" />
      <span className="ai-link-wrap">
        <button className="pill" onClick={(e) => { const anchor = topPopAnchor(e); setMcpPop((v) => (v ? null : anchor)); }} title={mcpLive ? 'Tools live on navigator.modelContext — an in-browser agent can drive this design. Click to list them.' : 'WebMCP toolset, exposed to in-browser agents. Click to list the tools.'}>
          <span className={'d' + (mcpLive ? ' live' : '')} /> MCP <code>{toolCount}</code> <span className="slim-hide">tools</span> <span className="caret">▾</span>
        </button>
        {mcpPop && (
          <div className="ai-pop ai-tools-pop top-pop" style={{ top: mcpPop.top, right: mcpPop.right }} onClick={(e) => e.stopPropagation()}>
            <div className="ai-pop-h">MCP tools · {toolCount}</div>
            <p>The commands an AI agent can drive this canvas with — {mcpLive ? 'live on navigator.modelContext.' : 'exposed where the browser supports it.'} Informational only.</p>
            <div className="ai-tools">
              {mcpTools.map((t) => (
                <div className="ai-tool" key={t.name}><code>{t.name}</code><span>{t.description}</span></div>
              ))}
            </div>
          </div>
        )}
      </span>
      <span className="ai-link-wrap">
        <button
          className={'pill aibtn' + (bridge === 'online' ? ' on' : '')}
          onClick={toggleBridge}
          title={
            bridge === 'online'
              ? 'AI bridge linked — an external MCP client (Claude Desktop / Cursor / Claude Code) is driving this canvas. Click to unlink.'
              : 'Link this canvas to the local AI bridge (run: node app/bridge/src/index.ts), then point your MCP client at the printed URL'
          }
        >
          <span className={'d' + (bridge === 'online' ? ' live' : bridge === 'connecting' ? ' warn' : '')} />{' '}
          {bridge === 'online' ? 'AI · MCP linked' : bridge === 'connecting' ? 'Linking…' : 'Link AI · MCP'}
        </button>
        {askToken && bridge !== 'online' && (
          <div className="ai-pop top-pop" style={{ top: askToken.top, right: askToken.right }} onClick={(e) => e.stopPropagation()}>
            <div className="ai-pop-h">Link AI bridge</div>
            <p>Run <code>node app/bridge/src/index.ts</code>, then paste the link token it prints:</p>
            <input
              autoFocus
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="link token"
              onKeyDown={(e) => { if (e.key === 'Enter') submitToken(); else if (e.key === 'Escape') setAskToken(null); }}
            />
            <div className="ai-pop-row">
              <button className="btn" onClick={() => setAskToken(null)}>Cancel</button>
              <button className="btn primary" onClick={submitToken}>Link</button>
            </div>
          </div>
        )}
      </span>
      <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={onImport} />
      <button className="btn" title="Import a project from a .sda.json file (replaces the current design)" onClick={() => fileRef.current?.click()}>Import</button>
      <button className="btn" title="Export the project to a portable, versioned .sda.json file — the real backup (Ctrl/⌘+S)" onClick={onExport}>Export</button>
      {/* Design doc = a SPLIT control: the primary button downloads the HTML deliverable (the human-facing report
          — C4 diagram, charts, assumptions register); the caret opens the Markdown option (for agents / RFCs). The
          caret closes on outside-click via the shared backdrop the header already uses for its popovers. */}
      <span className="split-btn">
        <button className="btn" disabled={!docReady} title="Download the design document as a self-contained HTML report (C4 diagram, charts, assumptions register) generated from the verified model" onClick={onExportDocHtml}>Design doc</button>
        <button className="btn split-caret" disabled={!docReady} title="Other formats" aria-label="Design doc formats" onClick={(e) => { const anchor = topPopAnchor(e); setDocMenu((v) => (v ? null : anchor)); }}>▾</button>
        {docMenu && (
          <>
            <div className="ctx-backdrop" onClick={() => setDocMenu(null)} />
            <div className="ai-pop doc-menu top-pop" style={{ top: docMenu.top, right: docMenu.right }} onClick={(e) => e.stopPropagation()}>
              <button className="btn" onClick={() => { setDocMenu(null); onExportDocHtml(); }}>HTML report (.html)</button>
              <button className="btn" onClick={() => { setDocMenu(null); onExportDocMd(); }}>Markdown (.md)</button>
            </div>
          </>
        )}
      </span>
      {/* compact-hide: at ≤1250px (the compact header tier — see theme.css "Header FIT TIERS") these two hide —
          both have keyboard equivalents (Ctrl/⌘+K, ?) and live in the command palette, so nothing is lost while
          the header fits the 1100–1250px band and below on one row. */}
      <button className="iconbtn compact-hide" title="Command palette (Ctrl/Cmd+K) — search and run any action" onClick={onOpenPalette}>⌘K</button>
      <button className="iconbtn compact-hide" title="Keyboard shortcuts (?)" onClick={onOpenHelp}>?</button>
      <button className="iconbtn" title="Toggle theme" onClick={onToggleTheme}>{theme === 'light' ? '☾' : '☀'}</button>
      <button className={'verdict-pill ' + (violations > 0 ? 'bad' : 'ok')} title={VERIFIED_SCOPE_HINT} onClick={onOpenProblems}><span className="dot" /> Verified · {plural(violations, 'issue')}</button>
      <div className="avatar slim-hide">PS</div>
    </div>
  );
}
