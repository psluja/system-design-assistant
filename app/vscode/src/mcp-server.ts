import { Studio } from '@sda/core';
import { allManifests, registry } from '@sda/content';
import { buildSearchTools } from '@sda/mcp/search';
import { buildSynthTools } from '@sda/mcp/synthesize';
import { buildSimTools } from '@sda/mcp/simulate';
import { buildReliabilityTools } from '@sda/mcp/reliability';
import { buildDocTools } from '@sda/mcp/document';
import { buildFileTools, createFileSession, nodeFs, workspaceRoots } from '@sda/mcp/file-io';
// `@sda/mcp` does not export subpaths for the uncertainty/assumption builders (they are only on the ROOT export,
// whose import side-effect boots its OWN server). We reach their PURE source modules directly — exactly like the
// server/composition imports below — so this bundled server registers the SAME full toolset as the CLI (index.ts)
// with no second Studio booted. (This closes the drift the readiness audit flagged: the built server had been
// missing run_uncertainty + every scenario/envelope tool.)
import { buildUncertaintyTools } from '../../mcp/src/uncertainty';
import { buildAssumptionTools } from '../../mcp/src/assumptions';
// `runStdio` and the composition root are PURE source modules; we reach them directly (exactly like
// solver-host.ts / compare-host.ts reach `../../mcp/src/composition`) rather than through the `@sda/mcp` ROOT export,
// whose import side-effect boots ITS OWN server on ITS OWN Studio. Reaching `server`/`composition` source keeps this
// entry the single owner of the Studio it serves. `bindSolvers` binds the native in-process solver (for the
// numeric capabilities) + the clingo provider (for enumerate) behind the composition root, so both the search AND
// synthesis tools get the SAME `SolverBindings` (one seam; MiniZinc is the numeric rollback). esbuild bundles all
// of these into dist/mcp-server.cjs — which no longer needs an external MiniZinc for optimize, only clingo for enumerate.
import { runStdio } from '../../mcp/src/server';
import { bindSolvers, referenceSolver } from '../../mcp/src/composition';

// The STANDALONE SDA MCP server that ships INSIDE the VS Code extension (dist/mcp-server.cjs). VS Code's native MCP
// registration (extension.ts) spawns THIS as a stdio child process, so agent chat in the same editor gets SDA's full
// toolset: the command core + backward-search (optimize/repair/explain, the in-process native solver) + synthesis
// (compare_options/synthesize/auto_architect, clingo enumerate + in-process sizing) + simulation, reliability and
// design-doc tools. (MiniZinc/COIN-BC stays as the numeric rollback + CI referee.)
//
// HONEST SCOPE (must not mislead): this server operates on its OWN in-memory Studio (a fresh empty project), exactly
// like the standalone `@sda/mcp` binary — it is NOT wired to the live canvas document. The live-canvas bridge remains
// app/bridge (Link AI). An agent uses this server to design/evaluate/repair a design in-conversation; to act on the
// OPEN .sda.json it reads/writes the file through the workspace like any other tool. This mirrors app/mcp/src/index.ts
// deliberately (one server definition, two shells) so behaviour cannot drift between the CLI and the bundled server.
const studio = new Studio(registry, allManifests);
const solvers = bindSolvers(registry);
// Reference-MIP escalation (docs: honest escalation): the bundled MiniZinc/COIN-BC, resolved lazily only on a
// budget-coupling decline. This bundled server ships the minizinc binary path via the incumbent adapter, so a
// budget-coupled optimize an agent runs here escalates to the exact MIP instead of dead-ending.
const reference = referenceSolver(registry);
// ONE FileSession shared between the file tools (synced on import/save) and runStdio (the unsaved-canvas reminder):
// on this FILE transport the human's canvas only moves when save_design writes the open file, so every result that
// leaves the design drifted from the saved file carries the one ⚠ unsaved line (the Copilot forgot-to-save lesson).
const session = createFileSession(studio);
void runStdio(studio, [
  // FILE-IO (TASK-84): the agent imports/saves the .sda.json the human has open, confined to the workspace root(s)
  // the extension passes in SDA_WORKSPACE — saving to the open file live-reloads the canvas (editor-provider docExternal).
  ...buildFileTools(studio, nodeFs(), workspaceRoots(), session),
  ...buildSimTools(studio, registry),
  ...buildReliabilityTools(studio),
  ...buildDocTools(studio, solvers),
  ...buildSearchTools(studio, solvers, reference),
  ...buildSynthTools(studio, solvers),
  ...buildUncertaintyTools(studio, solvers),
  ...buildAssumptionTools(studio, registry, solvers),
], session);
