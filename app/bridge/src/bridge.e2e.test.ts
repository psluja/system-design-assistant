import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Studio } from '@sda/core';
import { registry, commonManifests } from '@sda/content';
import { buildTools } from '@sda/mcp/tools';
import { startBridge, type Bridge } from './bridge.ts';

// End-to-end across both adapters with the REAL toolset: a stand-in canvas runs `buildTools` over a live
// Studio (exactly what app/web's bridge client does, minus the DOM) and answers calls relayed by a real
// bridge to a real MCP client. Proves an external AI's tool call mutates the actual design — the heart of
// "watch the AI drive your canvas" — without a browser. (The domain packages are dev-only test fixtures;
// the bridge's production code stays domain-free.)

interface CallMsg { t: 'call'; id: string; name: string; args?: Record<string, unknown> }

/** Wire a real Studio to the bridge as the browser would: advertise buildTools, run each call, reply. */
function canvas(studio: Studio, port: number, token: string): Promise<WebSocket> {
  const tools = buildTools(studio);
  const ws = new WebSocket(`ws://localhost:${port}/agent?token=${token}`, { origin: `http://localhost:${port}` });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as CallMsg;
    if (m.t !== 'call') return;
    const tool = tools.find((t) => t.name === m.name);
    const r = tool ? tool.run(m.args ?? {}) : { ok: false, text: `unknown tool: ${m.name}` };
    ws.send(JSON.stringify({ t: 'result', id: m.id, ok: r.ok, text: r.text }));
  });
  return new Promise((resolve) => {
    ws.on('open', () => {
      // Same advertisement shape as app/web's schemas(): name + description + inputSchema + annotations.
      ws.send(JSON.stringify({ t: 'hello', tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })) }));
      resolve(ws);
    });
  });
}

async function mcpClient(port: number, token: string): Promise<Client> {
  const c = new Client({ name: 'sda-e2e', version: '0.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp?token=${token}`)));
  return c;
}
const text = (r: unknown): string => (r as { content: { text: string }[] }).content[0]?.text ?? '';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe('AI bridge end-to-end (real Studio toolset)', () => {
  it("an MCP client's tool calls mutate the live design and read back verdicts", async () => {
    const studio = new Studio(registry, commonManifests);
    studio.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
    studio.dispatch({ kind: 'addComponent', id: 'app', type: 'compute.service' });
    studio.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['app', 'in'] });

    const bridge: Bridge = await startBridge(0);
    cleanup.push(() => bridge.close());
    const ws = await canvas(studio, bridge.port, bridge.token);
    cleanup.push(() => ws.close());
    const client = await mcpClient(bridge.port, bridge.token);
    cleanup.push(() => client.close());

    // The tool list the AI sees is the canvas's real command surface.
    for (let i = 0; i < 40 && (await client.listTools()).tools.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    const listed = (await client.listTools()).tools;
    const names = listed.map((t) => t.name);
    expect(names).toContain('add_component');
    expect(names).toContain('evaluate');

    // The schema-hygiene annotations pin over THIS transport: every real tool arrives at the external
    // MCP client with its behavior annotations intact, and openWorldHint is false everywhere (no SDA
    // tool has any egress) — the same guarantees the stdio server gives its clients.
    for (const t of listed) {
      expect(t.annotations, `${t.name}: annotations must survive the bridge relay`).toBeDefined();
      expect(t.annotations?.openWorldHint, `${t.name}: openWorldHint must be false`).toBe(false);
    }

    // AI adds a cache and wires it — the real Studio must change.
    expect(text(await client.callTool({ name: 'add_component', arguments: { id: 'cache1', type: 'cache.redis' } }))).not.toMatch(/^error/);
    expect(text(await client.callTool({ name: 'connect', arguments: { fromNode: 'app', fromPort: 'cache', toNode: 'cache1', toPort: 'in' } }))).not.toMatch(/^error/);
    expect(studio.project().instances.some((i) => i.id === 'cache1')).toBe(true);

    // AI reads verdicts back through the same surface.
    const verds = (JSON.parse(text(await client.callTool({ name: 'evaluate', arguments: {} }))) as { verdicts: Array<{ key: string; status: string }> }).verdicts;
    expect(verds.length).toBeGreaterThan(0);
  });
});
