# @sda/bridge — the AI bridge

Let any MCP client (Claude Desktop, Cursor, Claude Code, …) **drive the open SDA canvas live**. You
point the AI at a URL, open the web app, click **Link AI** — and then you watch the AI place blocks,
wire them, set SLOs, run the design backwards (repair/optimize), and read verdicts, all on *your*
canvas in real time.

```
 AI client ──MCP over HTTP──▶  bridge (this package)  ──WebSocket──▶  web canvas
 (a URL)        /mcp           pure relay, no domain        /agent     runs each tool on the
                               knowledge                                live Studio, replies
```

The bridge is a **pure relay**: it knows nothing about components, solvers, or system design. The
browser is the single source of truth — it advertises the toolset and runs every call against the live
`Studio` (the same `buildTools` command surface the stdio MCP server and WebMCP expose, plus the
backward-search tools wired to the browser's own HiGHS solver). Local process, no egress.

## Run

```bash
node app/bridge/src/index.ts            # defaults to port 7777
node app/bridge/src/index.ts 8080       # or: PORT=8080 node app/bridge/src/index.ts
# or, from anywhere in the repo:
pnpm --filter @sda/bridge start
```

On start it prints a **per-run link token** and the full MCP URL with the token embedded. Then:

1. **Open the canvas first**, click **Link AI** (top bar), and paste the token. It connects to
   `ws://localhost:7777/agent?token=…` and reconnects automatically if the bridge restarts (the token is
   remembered in `localStorage`). The pill turns green when linked.
2. **Point your MCP client** at the printed URL (Streamable HTTP transport). For example, in an MCP client
   config:
   ```json
   { "mcpServers": { "sda": { "url": "http://localhost:7777/mcp?token=PASTE_TOKEN" } } }
   ```
3. Ask the AI to design something. Its tool calls land on your canvas; a toast shows each action.

> Order matters: the bridge advertises whatever toolset the **linked canvas** reports, so link the
> canvas before (or reconnect the client after) opening the AI session. With no canvas linked, tool
> calls return a clear "open the web app and click Link AI" error instead of hanging.

`GET http://localhost:7777/` prints a one-line status (port, whether a canvas is linked, tool count).

## Security

The bridge is reachable on `localhost`, so without care any web page you visit could drive (or read) your
design. It is locked down on three axes, all enforced on **both** the `/mcp` and `/agent` handshakes:

- **Loopback only.** Binds to `127.0.0.1` (never the LAN). Rejects any request whose `Host` isn't a
  loopback name (anti-DNS-rebinding).
- **Origin allowlist.** Browsers always send `Origin`; only loopback web origins are accepted, and CORS
  echoes that single origin — **never** `*`. Native MCP clients send no `Origin` and pass.
- **Per-run link token.** A random token (printed at startup) must be presented as `?token=…` (or
  `Authorization: Bearer`). A drive-by page can't know it, so it can't drive the AI endpoint or
  impersonate the canvas.

`last-canvas-wins` is intentional: every accepted `/agent` socket is already token-authenticated and
loopback-origin (the same user), so a reopened tab / reconnect takes over rather than being locked out by
a stale socket.

## Why a relay (not the stdio server)?

The stdio MCP server (`@sda/mcp`) drives a *headless* Studio in the Node process — great for batch/agent
use, but you don't *see* it. The bridge instead drives the Studio that's **already open in your browser**,
so the design you're looking at is the one the AI edits. One toolset, three transports: Node stdio,
in-page WebMCP, and this HTTP↔WebSocket bridge.
