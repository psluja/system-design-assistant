import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Studio } from '@sda/core';
import { buildTools, type AnyTool } from './tools';
import { withUnsavedReminder, type FileSession } from './file-io';
import { SDA_INSTRUCTIONS } from './instructions';

/**
 * Run the SDA command core as an MCP server over stdio. Thin glue: every tool is a pure runner over
 * the Studio (tested separately); this only adapts them to the protocol. Local process, no egress.
 * `extraTools` adds the optional backward-search tools (which await the bound backward-search solver).
 * `session` (the FILE transport's session, shared with buildFileTools) turns on the unsaved-canvas
 * reminder: every result that leaves the design drifted from the saved file carries the one ⚠ line.
 */
export async function runStdio(studio: Studio, extraTools: readonly AnyTool[] = [], session?: FileSession): Promise<void> {
  const assembled: AnyTool[] = [...buildTools(studio), ...extraTools];
  const tools: AnyTool[] = session !== undefined ? withUnsavedReminder(studio, session, assembled) : assembled;
  const server = new Server({ name: 'sda', version: '0.0.0' }, { capabilities: { tools: {} }, instructions: SDA_INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      // `annotations` are the MCP behavior hints (readOnly/destructive/idempotent/openWorld) every SDA tool
      // declares — some strict clients gate or disable a tool that lacks them (they must assume the spec's
      // aggressive defaults: destructive + open-world). Declared per tool; linted by schema-hygiene.test.ts.
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as { type: 'object' }, annotations: t.annotations })),
    }),
  );

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (tool === undefined) return { content: [{ type: 'text' as const, text: `unknown tool: ${req.params.name}` }], isError: true };
    try {
      const res = await Promise.resolve(tool.run((req.params.arguments ?? {}) as Record<string, unknown>));
      return { content: [{ type: 'text' as const, text: res.text }], isError: !res.ok };
    } catch (e) {
      // A solver adapter (e.g. the ASP/clingo runner) can throw across the DI boundary; surface it as a graceful
      // tool error (isError), never a JSON-RPC protocol crash — matching the web bridge, so a solver failure looks
      // the same on every transport.
      return { content: [{ type: 'text' as const, text: `error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
}
