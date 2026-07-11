import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Bundles the two Node targets a self-contained .vsix needs:
//   • dist/extension.js  — the EXTENSION HOST. 'vscode' stays external (provided by the host at runtime).
//   • dist/mcp-server.cjs — the STANDALONE stdio MCP server (src/mcp-server.ts), spawned as a child process by the
//     native MCP registration in extension.ts. It never touches the `vscode` module (it is a plain Node process),
//     so nothing is external here — everything (the SDK, @sda/*, engine, clingo-wasm, the MiniZinc adapter) is
//     bundled in so the server boots from a single file with no node_modules resolution at the user's machine.
// Both share the same platform (node) so the workspace packages (@sda/core, @sda/content, @sda/mcp, engine) bundle
// cleanly; a .vsix must carry all of its own code.
const common = { bundle: true, platform: 'node', target: 'node18', sourcemap: true, logLevel: 'info' };

await Promise.all([
  build({ ...common, entryPoints: ['src/extension.ts'], format: 'cjs', outfile: 'dist/extension.js', external: ['vscode'] }),
  // A stdio MCP server is a bare Node entry (no `vscode`): bundle everything, output CJS so it runs under
  // `node dist/mcp-server.cjs` with no ESM/loader flags. `.cjs` makes the format explicit regardless of package type.
  build({ ...common, entryPoints: ['src/mcp-server.ts'], format: 'cjs', outfile: 'dist/mcp-server.cjs' }),
]);

// clingo-wasm's Node build resolves its `clingo.wasm` binary RELATIVE TO ITS OWN FILE (emscripten's
// `__dirname + '/clingo.wasm'`). Once bundled, `__dirname` is dist/, so the wasm must sit next to mcp-server.cjs —
// esbuild inlines the JS but NOT the .wasm data file. Copy it into dist/ so the synthesis tools (compare_options,
// clingo enumeration) find their engine at runtime. This is the same reason the web app ships public/clingo/clingo.wasm.
// `clingo-wasm` is a dependency of @sda/mcp (not of this package), so we resolve it FROM the mcp package's location
// under pnpm's strict node_modules — resolving from here would fail. `@sda/mcp/synthesize` is an exported subpath we
// can resolve, and its directory anchors the search for clingo-wasm.
const require = createRequire(import.meta.url);
const mcpDir = dirname(require.resolve('@sda/mcp/synthesize'));
const wasmSrc = join(dirname(require.resolve('clingo-wasm', { paths: [mcpDir] })), 'clingo.wasm');
await mkdir('dist', { recursive: true });
await copyFile(wasmSrc, join('dist', 'clingo.wasm'));
console.log('copied clingo.wasm → dist/clingo.wasm');
