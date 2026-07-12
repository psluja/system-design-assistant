import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

// The AI bridge: a local relay that lets any MCP client (Claude Desktop, Cursor, Claude Code, …) drive
// the OPEN web canvas. The AI connects over MCP-on-HTTP at a URL; the browser connects over a WebSocket
// and runs each tool against the live Studio, so you watch the AI edit YOUR design. The bridge itself is
// a pure relay — it knows nothing about system design, components, or solvers (that all lives in the
// browser, the single source of truth). Local process, no egress.

/** A tool the canvas advertises: name + description + JSON-Schema for arguments + MCP behavior
 *  annotations (mirrors ToolDef). The annotations (readOnly/destructive/idempotent/openWorld hints)
 *  matter: some strict clients treat an unannotated tool by the spec's aggressive defaults
 *  (destructive + open-world) and gate or disable it, so the relay must carry them verbatim —
 *  the SAME form the stdio server sends (pinned by bridge.test.ts / bridge.e2e.test.ts). */
export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly type: 'object'; readonly [k: string]: unknown };
  readonly annotations: ToolAnnotations;
}

export interface Bridge {
  readonly port: number;
  /** The per-run link token: the AI client appends it as `?token=…`, the canvas presents it on link. */
  readonly token: string;
  /** Whether a canvas is currently linked. */
  linked(): boolean;
  close(): Promise<void>;
}

interface Pending {
  resolve(r: { ok: boolean; text: string }): void;
  timer: ReturnType<typeof setTimeout>;
}

// Wire protocol over the canvas WebSocket. Browser → bridge: `hello`/`tools` (advertise the toolset),
// `result` (answer a forwarded call). Bridge → browser: `call` (run a tool on the live Studio).
type FromCanvas =
  | { t: 'hello' | 'tools'; tools: ToolSchema[]; instructions?: string }
  | { t: 'result'; id: string; ok: boolean; text: string };

const CALL_TIMEOUT_MS = 120_000; // a backward-search (MiniZinc/HiGHS) can take a moment in the browser
const NO_CANVAS = 'No SDA canvas is linked. Open the web app and click “Link AI”, then retry.';

// --- security: the bridge is a local relay reachable at localhost, so any web page the user visits could
// otherwise drive (or read) their design. Three gates, all loopback-only: validate Host (anti-DNS-rebind),
// validate Origin (browsers always send it; native MCP clients send none), and require a per-run link token.

/** Loopback-only Host (anti-DNS-rebinding): never honour a request addressed to a non-loopback name. */
function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const h = host.replace(/:\d+$/, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}
/** Allow only loopback web origins. `undefined` (no Origin header) = a native MCP client, which is allowed. */
function isLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
}
/** The link token from `?token=` (query) or an `Authorization: Bearer` header. */
function tokenFromReq(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const q = (req.url ?? '').indexOf('?');
  if (q >= 0) {
    const t = new URLSearchParams((req.url ?? '').slice(q + 1)).get('token');
    if (t !== null && t !== '') return t;
  }
  return null;
}
/** Constant-time token compare (cheap belt-and-braces even over loopback). */
function tokenOk(provided: string | null, token: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startBridge(port = 7777, token: string = randomBytes(16).toString('hex')): Promise<Bridge> {
  // Relay state: the single connected canvas, its advertised toolset, and the calls in flight.
  let agent: WebSocket | null = null;
  let tools: ToolSchema[] = [];
  let instructions = ''; // the flow guide, advertised by the canvas in `hello` and relayed at MCP initialize
  const pending = new Map<string, Pending>();
  let seq = 0;
  let boundPort = port;

  const log = (m: string): void => void process.stderr.write(`[sda-bridge] ${m}\n`);
  const isOpen = (): boolean => agent !== null && agent.readyState === WebSocket.OPEN;

  /** Send a tool call to the canvas and await its result (or a timeout / no-canvas error). */
  function forward(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    if (agent === null || agent.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, text: NO_CANVAS });
    const sock = agent;
    const id = `c${seq++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, text: 'the canvas did not respond in time' });
      }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      sock.send(JSON.stringify({ t: 'call', id, name, args }));
    });
  }

  // A fresh MCP server+transport per POST (stateless mode); both just relay to the canvas.
  function makeServer(): Server {
    const server = new Server({ name: 'sda-bridge', version: '0.0.0' }, { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) });
    server.setRequestHandler(ListToolsRequestSchema, () =>
      Promise.resolve({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as { type: 'object' }, annotations: t.annotations })) }),
    );
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const r = await forward(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: r.text }], isError: !r.ok };
    });
    return server;
  }

  function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.length === 0) return resolve(undefined);
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
      req.on('error', reject);
    });
  }

  const denied = (res: http.ServerResponse, code: number, message: string): void => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000 - (code - 400), message }, id: null }));
  };

  const httpServer = http.createServer((req, res) => {
    // Gate 1 — anti-DNS-rebinding: only loopback Hosts are honoured.
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return void res.end('forbidden host');
    }
    const origin = req.headers.origin;
    const originOk = isLoopbackOrigin(origin);

    if (req.method === 'OPTIONS') {
      // CORS preflight: echo ONLY a loopback origin (never wildcard); a foreign origin gets no headers,
      // so the browser blocks the follow-up request.
      if (origin !== undefined && originOk) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? 'authorization, content-type, accept, mcp-session-id, mcp-protocol-version');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      }
      res.writeHead(204);
      return void res.end();
    }

    const url = req.url ?? '/';
    if (!url.startsWith('/mcp')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return void res.end(`SDA AI bridge on :${boundPort}\nMCP endpoint:  http://localhost:${boundPort}/mcp?token=…\nCanvas linked: ${isOpen()}\nTools:         ${tools.length}\n`);
    }
    // Gate 2 — Origin: block cross-origin browser pages (native MCP clients send no Origin, so pass).
    if (origin !== undefined && !originOk) return void denied(res, 403, 'forbidden origin');
    if (origin !== undefined) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    // Gate 3 — link token: a drive-by page can't know it, so it can't drive the AI endpoint.
    if (!tokenOk(tokenFromReq(req), token)) return void denied(res, 401, 'unauthorized: missing or invalid link token');

    if (req.method !== 'POST') {
      // Stateless server: no standalone SSE stream (GET) or session teardown (DELETE).
      res.writeHead(405, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: use POST).' }, id: null }));
    }
    void (async () => {
      const server = makeServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        const body = await readBody(req);
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        log(`mcp error: ${String(e)}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }));
        }
      }
    })();
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/agent',
    // Same three gates on the canvas handshake: loopback Host + Origin, and a valid link token.
    verifyClient: ({ req }, done) => {
      const ok = isLoopbackHost(req.headers.host) && isLoopbackOrigin(req.headers.origin) && tokenOk(tokenFromReq(req), token);
      if (!ok) log('rejected canvas handshake (bad host/origin/token)');
      done(ok, ok ? undefined : 401, 'unauthorized');
    },
  });
  wss.on('connection', (ws: WebSocket) => {
    // Last canvas wins — every connection here is already token-authenticated and loopback-origin (i.e. the
    // same user), so a reopened tab / reconnect should take over rather than be locked out by a stale socket.
    if (agent !== null && agent !== ws) {
      try {
        agent.close();
      } catch {
        /* ignore */
      }
    }
    agent = ws;
    log('canvas connected');
    ws.on('message', (raw: RawData) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
      } catch {
        return;
      }
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as Partial<FromCanvas>;
      if ((m.t === 'hello' || m.t === 'tools') && Array.isArray(m.tools)) {
        tools = m.tools;
        if (typeof m.instructions === 'string') instructions = m.instructions;
        log(`canvas advertised ${tools.length} tools`);
        return;
      }
      if (m.t === 'result' && typeof m.id === 'string') {
        const p = pending.get(m.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(m.id);
          p.resolve({ ok: m.ok === true, text: String(m.text ?? '') });
        }
      }
    });
    ws.on('close', () => {
      if (agent === ws) {
        agent = null;
        tools = [];
        instructions = '';
        log('canvas disconnected');
      }
    });
    ws.on('error', () => {
      /* the close handler does the cleanup */
    });
  });

  return new Promise<Bridge>((resolve) => {
    // Bind to loopback only — never expose the bridge on the LAN.
    httpServer.listen(port, '127.0.0.1', () => {
      boundPort = (httpServer.address() as AddressInfo | null)?.port ?? port;
      log(`listening on http://127.0.0.1:${boundPort}  ·  MCP: /mcp  ·  canvas WS: /agent`);
      resolve({
        port: boundPort,
        token,
        linked: isOpen,
        close: () =>
          new Promise<void>((done) => {
            for (const p of pending.values()) {
              clearTimeout(p.timer);
              p.resolve({ ok: false, text: 'bridge closing' });
            }
            pending.clear();
            wss.close(() => httpServer.close(() => done()));
          }),
      });
    });
  });
}
