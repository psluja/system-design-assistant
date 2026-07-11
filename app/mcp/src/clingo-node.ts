import * as clingoWasm from 'clingo-wasm';
import { answerSets, type ClingoResult, type RunAsp } from '@sda/engine-solve/asp';

// The node ASP runner — the prebuilt clingo-wasm `run` composed with the shared `answerSets` parser, so the
// MCP server and tests enumerate topologies with the same format the browser web build produces. The engine
// never imports clingo-wasm (it stays bundle-clean); this is the node-side injection, like `nativeSolveMzn`.
//
// WHY the namespace import + fallback chain: clingo-wasm ships a CJS node build whose module.exports carries
// BOTH named exports ({run, init, Runner}) and a `default`. Which shape a default-import sees depends on the
// loader's CJS→ESM interop — vitest/vite honor __esModule (default = the run function), but esbuild's
// node-mode __toESM makes `default` the whole exports OBJECT, so `import run from 'clingo-wasm'` crashed ONLY
// inside the bundled VS Code MCP server ("import_clingo_wasm.default is not a function"). The named `run`
// exists in every shape; resolve it explicitly so ONE source works under vitest, plain node and esbuild.
type ClingoRun = (program: string, models?: number) => Promise<ClingoResult>;
const ns = clingoWasm as { run?: unknown; default?: unknown };
const viaDefault = ns.default as { run?: unknown } | ClingoRun | undefined;
const run = (ns.run ?? (typeof viaDefault === 'function' ? viaDefault : viaDefault?.run)) as ClingoRun;

export const nativeRunAsp: RunAsp = async (program, models) => answerSets(await run(program, models));
