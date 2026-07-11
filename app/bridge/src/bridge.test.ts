import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startBridge, type Bridge } from './bridge.ts';

// The bridge is a pure relay, so the test stands in a mock "canvas" (a ws client that advertises one
// tool and answers calls) and a real MCP client over HTTP. It proves the whole loop the AI experiences:
// list the canvas's tools, call one, and get the canvas's answer back — without a browser or a real AI.

interface CallMsg {
  readonly t: 'call';
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

const ECHO_TOOL = {
  name: 'echo',
  description: 'Echo a message back (stands in for a real design tool).',
  inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  // The MCP behavior annotations every SDA tool declares (schema-hygiene pin) — the relay must carry
  // them verbatim, or strict clients assume the spec's aggressive defaults (destructive + open-world).
  annotations: { readOnlyHint: true, openWorldHint: false },
};

/** A fake browser canvas: advertises ECHO_TOOL and answers `call` with `echo:<msg>`. */
function mockCanvas(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/agent?token=${token}`, { origin: `http://localhost:${port}` });
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as CallMsg;
      if (m.t === 'call') ws.send(JSON.stringify({ t: 'result', id: m.id, ok: true, text: `echo:${String(m.args.msg)}` }));
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', tools: [ECHO_TOOL] }));
      resolve(ws);
    });
  });
}

async function mcpClient(port: number, token: string): Promise<Client> {
  const client = new Client({ name: 'sda-bridge-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp?token=${token}`)));
  return client;
}

/** Retry until the canvas's `hello` has propagated and the tool shows up (avoids a brittle fixed sleep). */
async function waitForTool(client: Client, name: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const list = await client.listTools();
    if (list.tools.some((t) => t.name === name)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`tool ${name} never advertised`);
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe('SDA AI bridge (MCP-on-HTTP ⇄ canvas WebSocket relay)', () => {
  it('relays a tool call from an MCP client to the linked canvas and back', async () => {
    const bridge: Bridge = await startBridge(0);
    cleanup.push(() => bridge.close());
    const canvas = await mockCanvas(bridge.port, bridge.token);
    cleanup.push(() => canvas.close());
    const client = await mcpClient(bridge.port, bridge.token);
    cleanup.push(() => client.close());

    await waitForTool(client, 'echo');
    expect(bridge.linked()).toBe(true);

    const res = (await client.callTool({ name: 'echo', arguments: { msg: 'hi' } })) as { content: { type: string; text: string }[]; isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toBe('echo:hi');
  });

  // The schema-hygiene annotations pin, extended to this transport: what the stdio server sends
  // (`annotations` per tool), the bridge must relay unchanged — presence AND the openWorldHint:false
  // invariant (no SDA tool has any egress). A dropped field here would make strict clients gate or
  // disable every canvas tool.
  it('relays the canvas tool annotations verbatim (present, openWorldHint false)', async () => {
    const bridge = await startBridge(0);
    cleanup.push(() => bridge.close());
    const canvas = await mockCanvas(bridge.port, bridge.token);
    cleanup.push(() => canvas.close());
    const client = await mcpClient(bridge.port, bridge.token);
    cleanup.push(() => client.close());

    await waitForTool(client, 'echo');
    const echo = (await client.listTools()).tools.find((t) => t.name === 'echo');
    expect(echo?.annotations).toBeDefined();
    expect(echo?.annotations).toEqual(ECHO_TOOL.annotations);
    expect(echo?.annotations?.openWorldHint).toBe(false);
  });

  it('returns an error (not a hang) when no canvas is linked', async () => {
    const bridge = await startBridge(0);
    cleanup.push(() => bridge.close());
    const client = await mcpClient(bridge.port, bridge.token);
    cleanup.push(() => client.close());

    expect(bridge.linked()).toBe(false);
    const res = (await client.callTool({ name: 'echo', arguments: { msg: 'hi' } })) as { content: { type: string; text: string }[]; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('No SDA canvas');
  });

  it('rejects an MCP connection with no/invalid token', async () => {
    const bridge = await startBridge(0);
    cleanup.push(() => bridge.close());
    const client = new Client({ name: 'evil', version: '0.0.0' });
    // No ?token= → the bridge answers 401 and the transport fails to initialize.
    await expect(client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${bridge.port}/mcp`)))).rejects.toThrow();
  });

  it('rejects a canvas WebSocket handshake with a bad token', async () => {
    const bridge = await startBridge(0);
    cleanup.push(() => bridge.close());
    const ws = new WebSocket(`ws://localhost:${bridge.port}/agent?token=wrong`, { origin: `http://localhost:${bridge.port}` });
    const rejected = await new Promise<boolean>((resolve) => {
      ws.on('error', () => resolve(true));
      ws.on('open', () => resolve(false));
    });
    expect(rejected).toBe(true);
    expect(bridge.linked()).toBe(false);
  });

  it('rejects an MCP request from a foreign (non-loopback) Origin', async () => {
    const bridge = await startBridge(0);
    cleanup.push(() => bridge.close());
    const res = await fetch(`http://localhost:${bridge.port}/mcp?token=${bridge.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', origin: 'https://evil.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(403);
  });
});
