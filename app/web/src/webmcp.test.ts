import { afterEach, describe, expect, it, vi } from 'vitest';
import { Studio } from '@sda/core';
import { commonManifests, registry } from '@sda/content';
import { buildTools } from '@sda/mcp/tools';
import { registerWebMcp, webMcpTools } from './webmcp';

// WebMCP adapts the ONE MCP toolset (buildTools over the Studio) to whatever shape the browser exposes:
// declarative `provideContext`, imperative `registerTool`, or nothing at all. These tests inject stub
// `navigator.modelContext` variants and assert the live-tool count for each, plus the ok→isError inversion
// that lets a page-level agent SEE a failed command (not a silent green).

const studio = (): Studio => new Studio(registry, commonManifests);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WebMCP browser-agent surface', () => {
  it('webMcpTools mirrors the buildTools set (count = buildTools length; shape)', () => {
    const s = studio();
    const tools = webMcpTools(s);
    expect(tools.length).toBe(buildTools(s).length);
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(typeof t.inputSchema).toBe('object');
      expect(typeof t.execute).toBe('function');
    }
  });

  // The schema-hygiene annotations pin, extended to THIS transport: the browser agent surface must
  // carry each tool's MCP behavior annotations verbatim (a bare tool reads as destructive+open-world
  // to strict clients), with the SDA invariant openWorldHint:false everywhere — no tool has any egress.
  it('every tool carries its MCP annotations verbatim (present, openWorldHint false)', () => {
    const s = studio();
    const source = new Map(buildTools(s).map((t) => [t.name, t.annotations]));
    for (const t of webMcpTools(s)) {
      expect(t.annotations, `${t.name}: annotations must be relayed to the WebMCP surface`).toBeDefined();
      expect(t.annotations, `${t.name}: annotations must match the ToolDef exactly`).toEqual(source.get(t.name));
      expect(t.annotations.openWorldHint, `${t.name}: openWorldHint must be false — no SDA tool has any egress`).toBe(false);
    }
  });

  it('declarative provideContext surface makes EVERY tool live', () => {
    const s = studio();
    const expected = webMcpTools(s).length;
    let received: { tools: unknown[] } | undefined;
    vi.stubGlobal('navigator', {
      modelContext: { provideContext: (ctx: { tools: unknown[] }) => { received = ctx; } },
    });
    expect(registerWebMcp(s)).toBe(expected);
    expect(received?.tools.length).toBe(expected); // handed the whole toolset in one call
  });

  it('imperative registerTool surface registers each tool exactly once', () => {
    const s = studio();
    const expected = webMcpTools(s).length;
    const registered: string[] = [];
    vi.stubGlobal('navigator', {
      modelContext: { registerTool: (t: { name: string }) => { registered.push(t.name); } },
    });
    expect(registerWebMcp(s)).toBe(expected);
    expect(registered.length).toBe(expected); // one registerTool call per tool
  });

  it('a modelContext exposing NEITHER method makes zero tools live', () => {
    vi.stubGlobal('navigator', { modelContext: {} });
    expect(registerWebMcp(studio())).toBe(0);
  });

  it('no WebMCP surface at all → zero live tools (the tools still exist for the in-app flow)', () => {
    vi.stubGlobal('navigator', {}); // navigator present, but no modelContext
    expect(registerWebMcp(studio())).toBe(0);
  });

  it('a FAILING tool run surfaces { isError: true } to the browser agent (ok→isError inversion)', async () => {
    const add = webMcpTools(studio()).find((t) => t.name === 'add_component');
    expect(add).toBeDefined();

    // Failure (unknown component type): ok:false in the core → isError:true for the agent.
    const bad = await add!.execute({ id: 'x', type: 'no-such-type' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.type).toBe('text');
    expect(bad.content[0]?.text).toBeTruthy(); // the honest error text is carried, not swallowed

    // Success carries NO isError flag (the inversion is exactly ok ⇒ absent, !ok ⇒ true).
    const good = await add!.execute({ id: 'redis', type: 'cache.redis' });
    expect(good.isError).toBeUndefined();
    expect(good.content[0]?.type).toBe('text');
  });
});
