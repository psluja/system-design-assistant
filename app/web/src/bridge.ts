import type { Studio } from '@sda/core';
import { buildTools, type AnyTool, type ToolAnnotations } from '@sda/mcp/tools';
import { buildSearchTools } from '@sda/mcp/search';
import { buildSynthTools } from '@sda/mcp/synthesize';
import { bindBrowserSolvers } from './composition';
import { buildSimTools } from '@sda/mcp/simulate';
import { buildReliabilityTools } from '@sda/mcp/reliability';
import { buildDocTools } from '@sda/mcp/document';
import { SDA_INSTRUCTIONS } from '@sda/mcp/instructions';
import { registry } from '@sda/content';

// Browser end of the AI bridge (see app/bridge): connect to the local relay over a WebSocket, advertise
// the SAME toolset the in-page agent gets (WebMCP command tools + the backward-search tools, wired to the
// browser's own HiGHS solver), and run each forwarded call against the LIVE Studio. Because the canvas
// subscribes to that Studio, the AI's edits re-render in front of the user. The relay holds no domain
// logic — the browser is the single source of truth.

export type BridgeStatus = 'offline' | 'connecting' | 'online';

export interface BridgeEvents {
  status(s: BridgeStatus): void;
  activity(name: string, ok: boolean): void;
}
export interface BridgeHandle {
  close(): void;
}

type CallMsg = { t: 'call'; id: string; name: string; args?: Record<string, unknown> };

const DEFAULT_URL = 'ws://localhost:7777/agent';
const RETRY_MS = 1500;

/** Connect this canvas to the local AI bridge. `token` is the per-run link token the bridge prints; it
 *  gates the handshake so a random web page can't impersonate the canvas. */
export function connectBridge(studio: Studio, ev: BridgeEvents, token: string, base: string = DEFAULT_URL): BridgeHandle {
  const url = `${base}?token=${encodeURIComponent(token)}`;
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  // Build the toolset once. The sync command tools are immediate; the backward-search tools bind the native
  // in-process solver (no MiniZinc WASM) — clingo still loads lazily for enumerate/synthesize on first use.
  const runners = new Map<string, AnyTool>();
  const ready: Promise<void> = (async () => {
    const sync = buildTools(studio);
    // BOTH the backward-search AND the synthesis tools go through the composition root (SolverBindings, the solver
    // contract): the native in-process adapter for the numeric capabilities + the lazily-imported clingo provider
    // for enumerate. One binding, one seam — switching the runtime is a change in composition.ts, not here (native
    // default; MiniZinc rollback, TASK-79 phase 3). No MiniZinc WASM is fetched on the default path; clingo's WASM
    // still loads only on the first enumeration.
    const solvers = await bindBrowserSolvers(registry);
    const search = buildSearchTools(studio, solvers);
    const synth = buildSynthTools(studio, solvers);
    const sim = buildSimTools(studio, registry);
    const reli = buildReliabilityTools(studio);
    const docs = buildDocTools(studio, solvers);
    for (const t of [...sync, ...search, ...synth, ...sim, ...reli, ...docs]) runners.set(t.name, t);
  })();
  // The advertisement carries each tool's MCP behavior annotations so the bridge can relay them to the
  // external client — the SAME form the stdio server sends (a bare tool reads as destructive+open-world
  // to strict clients). Pinned end-to-end by app/bridge's transport tests.
  const schemas = (): { name: string; description: string; inputSchema: Record<string, unknown>; annotations: ToolAnnotations }[] =>
    [...runners.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }));

  const send = (sock: WebSocket, data: unknown): void => {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(data));
  };

  const open = (): void => {
    if (closed) return;
    ev.status('connecting');
    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch {
      schedule();
      return;
    }
    ws = sock;

    sock.onopen = () => {
      void ready.then(() => {
        if (ws !== sock) return;
        send(sock, { t: 'hello', tools: schemas(), instructions: SDA_INSTRUCTIONS });
        ev.status('online');
      });
    };

    sock.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== 'string') return;
      let m: CallMsg;
      try {
        m = JSON.parse(e.data) as CallMsg;
      } catch {
        return;
      }
      if (m.t !== 'call' || typeof m.id !== 'string') return;
      void ready.then(async () => {
        const tool = runners.get(m.name);
        let r: { ok: boolean; text: string };
        if (tool === undefined) r = { ok: false, text: `unknown tool: ${m.name}` };
        else {
          try {
            r = await tool.run(m.args ?? {});
          } catch (err) {
            r = { ok: false, text: `error: ${String(err)}` };
          }
        }
        send(sock, { t: 'result', id: m.id, ok: r.ok, text: r.text });
        ev.activity(m.name, r.ok);
      });
    };

    sock.onclose = () => {
      if (ws === sock) {
        ws = null;
        ev.status('offline');
        schedule();
      }
    };
    sock.onerror = () => {
      try {
        sock.close();
      } catch {
        /* onclose schedules the retry */
      }
    };
  };

  const schedule = (): void => {
    if (closed) return;
    if (retry) clearTimeout(retry);
    retry = setTimeout(open, RETRY_MS);
  };

  open();

  return {
    close: () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
      ev.status('offline');
    },
  };
}
