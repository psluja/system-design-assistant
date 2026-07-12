import type { Studio } from '@sda/core';
import { buildTools, type ToolAnnotations } from '@sda/mcp/tools';

// WebMCP (navigator.modelContext): expose the SAME command tools the stdio MCP server exposes, but
// in-browser, so a page-level AI agent drives the live design directly. This is the MCP-first payoff:
// one toolset (buildTools over the Studio), two transports — Node stdio and the browser agent surface.
// The Web standard is still emerging (W3C WebMCP / Chromium origin trial), so we adapt defensively to
// whichever shape the runtime exposes (declarative provideContext, or imperative registerTool).

interface WebMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** MCP behavior hints, relayed verbatim from the ToolDef — the SAME form the stdio server sends
   *  (a tool without them reads as destructive+open-world to strict clients). openWorldHint is always
   *  false: no SDA tool has any egress. Pinned per transport by webmcp.test.ts. */
  readonly annotations: ToolAnnotations;
  execute(args: Record<string, unknown>): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;
}
interface ModelContext {
  registerTool?(tool: WebMcpTool): { unregister(): void } | void;
  provideContext?(ctx: { tools: WebMcpTool[] }): void;
}
declare global {
  // Not yet in lib.dom — declared here so feature detection type-checks.
  interface Navigator {
    readonly modelContext?: ModelContext;
  }
}

/** The design toolset, shaped for the browser agent surface (count = buildTools length). */
export function webMcpTools(studio: Studio): WebMcpTool[] {
  return buildTools(studio).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
    execute: (args) => {
      const r = t.run(args ?? {});
      return Promise.resolve({ content: [{ type: 'text' as const, text: r.text }], ...(r.ok ? {} : { isError: true }) });
    },
  }));
}

/**
 * Register the design tools with the browser's model-context surface if present.
 * Returns the number of tools made live (0 when WebMCP is unavailable — the tools still exist and
 * drive the in-app flow; only the cross-agent exposure is gated on browser support).
 */
export function registerWebMcp(studio: Studio): number {
  const mc = typeof navigator !== 'undefined' ? navigator.modelContext : undefined;
  if (!mc) return 0;
  const tools = webMcpTools(studio);
  if (typeof mc.provideContext === 'function') {
    mc.provideContext({ tools });
    return tools.length;
  }
  if (typeof mc.registerTool === 'function') {
    for (const t of tools) mc.registerTool(t);
    return tools.length;
  }
  return 0;
}
