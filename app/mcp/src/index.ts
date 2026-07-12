import { Studio } from '@sda/core';
import { allManifests, registry } from '@sda/content';
import { runStdio } from './server';
import { buildSearchTools } from './search';
import { buildSynthTools } from './synthesize';
import { buildSimTools } from './simulate';
import { buildReliabilityTools } from './reliability';
import { buildDocTools } from './document';
import { buildUncertaintyTools } from './uncertainty';
import { buildAssumptionTools } from './assumptions';
import { buildFileTools, createFileSession, nodeFs, workspaceRoots } from './file-io';
import { bindSolvers, referenceSolver } from './composition';

// The default SDA MCP server: the full seed catalogue + an empty project + the backward-search tools
// (optimize/repair/explain) and the synthesis tools (compare_options / synthesize / auto_architect). BOTH tool
// sets depend on the solver CONTRACT via the composition root (composition.ts) — the single site that binds a
// solver adapter (native in-process by default; MiniZinc incumbent on rollback) — and receive
// the SAME `SolverBindings`, so switching the runtime is one change there, and synthesis can never drift onto a
// second solver seam.
const studio = new Studio(registry, allManifests);
const solvers = bindSolvers(registry);
// The reference-MIP escalation target (docs: honest escalation) — the incumbent MiniZinc, resolved lazily only when
// the native solver declines a budget-coupling trade-off. A shell with no MiniZinc binary keeps the honest decline.
const reference = referenceSolver(registry);
// File-IO tools confine to the workspace root(s): SDA_WORKSPACE if the shell set it (the VS Code server does), else
// the process cwd (the standalone CLI runs from the project). So an agent can import/save the real .sda.json files.
// ONE FileSession is shared between the file tools (which sync it on import/save) and runStdio (whose unsaved-canvas
// reminder reads it) — the server-memory dirty tracking that stops an agent forgetting to save (the Copilot lesson).
const session = createFileSession(studio);
void runStdio(studio, [...buildFileTools(studio, nodeFs(), workspaceRoots(), session), ...buildSimTools(studio, registry), ...buildReliabilityTools(studio), ...buildDocTools(studio, solvers), ...buildSearchTools(studio, solvers, reference), ...buildSynthTools(studio, solvers), ...buildUncertaintyTools(studio, solvers), ...buildAssumptionTools(studio, registry, solvers)], session);

export { runStdio } from './server';
export { buildTools, type ToolDef, type AsyncToolDef, type AnyTool, type ToolResult } from './tools';
export { buildSearchTools } from './search';
export { buildSynthTools } from './synthesize';
export { buildSimTools } from './simulate';
export { buildReliabilityTools } from './reliability';
export { buildDocTools } from './document';
export { buildUncertaintyTools } from './uncertainty';
export { buildAssumptionTools } from './assumptions';
export { buildFileTools, createFileSession, withUnsavedReminder, nodeFs, workspaceRoots, resolveInRoots, withinRoots, displayPath, type FileSession, type FileSystemPort } from './file-io';
export { bindSolvers, type RuntimeMode } from './composition';
export { nativeSolveMzn } from './mzn-native';
export { nativeRunAsp } from './clingo-node';
export { SDA_INSTRUCTIONS } from './instructions';
