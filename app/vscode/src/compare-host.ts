import { Studio, deserialize, serialize } from '@sda/core';
import { registry, allManifests, keys } from '@sda/content';
import { buildSynthTools } from '@sda/mcp/synthesize';
// The composition root is a PURE module (no side effects), but @sda/mcp's ROOT export runs the stdio server on
// import — which we must never trigger inside the extension host. So, exactly like solver-host.ts reaches
// `../../mcp/src/composition` for the backward-search path, we reach it directly. `bindSolvers` binds the native
// in-process solver (for sizing) + the clingo provider (for enumeration), so compare_options gets the SAME
// `SolverBindings` the search tools use (one seam; MiniZinc is the sizing rollback). esbuild bundles the
// composition + its adapters into dist/extension.js. This is the only way to use the proven compare_options path
// (clingo enumerate → in-process size → rank) without booting an MCP server.
import { bindSolvers } from '../../mcp/src/composition';

// Compare-options host. Alternatives is entirely HOST-side (the webview ships no clingo/MIP solver): the command in
// commands.ts builds a THROWAWAY Studio from the current document text, runs the @sda/mcp `compare_options` tool
// (clingo enumerates every component type that fits the node's wiring; the in-process native solver sizes each to
// meet its SLOs — MiniZinc/COIN-BC on rollback; the survivors come back ranked), and applies the accepted swap as a
// native document edit. When clingo fails or the solver cannot prove a design the tool itself returns an honest
// error string — we relay it unchanged (the tool must not lie, and neither may we by faking a result). Mirrors
// solver-host.ts's contract exactly.

/** A ranked alternative for one node, parsed from the compare_options tool output. `value` is the objective
 *  metric (cost by default) for this option; `overflow` > 0 means it could not fully serve the load. The extra
 *  trade-off metrics are optional (a demand-priced option may omit sizing/availability). */
export interface CompareOption {
  readonly type: string;
  /** The objective metric for this option (cost by default, or the caller's chosen key). Named generically here
   *  because the tool keys it by the objective key name; the host reads it back via `objectiveKey`. */
  readonly value: number;
  readonly overflow: number;
  readonly availability?: number;
  readonly throughput?: number;
  readonly sizing: ReadonlyArray<{ readonly key: string; readonly value: number }>;
}

/** The result of running compare_options against the current document for one node. Never throws — a build error,
 *  a missing solver or an empty result all resolve to a discriminated outcome the command renders honestly. */
export type CompareResult =
  | { readonly ok: true; readonly objectiveKey: string; readonly options: readonly CompareOption[] }
  /** The tool ran but there is nothing to show (e.g. "No alternative component type fits …") — the tool's own
   *  words, surfaced as an information message, never paraphrased. */
  | { readonly ok: true; readonly objectiveKey: string; readonly options: readonly CompareOption[]; readonly note: string }
  /** An honest failure (bad document, no such node, missing native minizinc, clingo failure): `error` is verbatim
   *  tool/parser text for showErrorMessage. */
  | { readonly ok: false; readonly error: string };

export interface CompareRequest {
  readonly node: string;
  readonly projectJson: string;
}

/**
 * Run compare_options for one node against the given project text. Objective defaults to cost/min — the same
 * "cheapest sizing that meets the SLOs" ranking the web's compare surface and the MCP tool use — so the extension
 * and the other shells rank identically (one behaviour, many entry points). Never throws: every failure path
 * (parse, missing node, absent solver, unexpected exception) resolves to an honest outcome.
 */
export async function runCompare(req: CompareRequest): Promise<CompareResult> {
  try {
    // 1. Rehydrate the design the canvas is currently showing. An invalid document is a real, reportable condition
    //    (never a crash) — surface the parser's own message, exactly like solver-host.ts.
    const parsed = deserialize(req.projectJson);
    if (!parsed.ok) return { ok: false, error: `cannot compare — the design failed to parse: ${parsed.error}` };

    // A fresh, isolated Studio per request: the compare must not mutate any shared state, and the request already
    // carries the exact project (the canvas owns the live document).
    const studio = new Studio(registry, allManifests);
    studio.load(parsed.value);

    // 2. Build the exact synthesis tools the MCP server exposes, driven by the composition root's bindings
    //    (the native in-process solver for sizing + clingo for enumeration; MiniZinc on rollback) — the proven
    //    node-side wiring, one binding site for the CLI + the extension (mirrors app/mcp/src/index.ts, solver-host.ts).
    const tools = buildSynthTools(studio, bindSolvers(registry));
    const compare = tools.find((t) => t.name === 'compare_options');
    if (compare === undefined) {
      // Defensive: buildSynthTools is expected to provide compare_options; fail honestly if the tool set changes.
      return { ok: false, error: 'internal — the compare_options tool is unavailable' };
    }

    // 3. Run against the selected node. Objective is cost/min (the default the tool applies when key is omitted),
    //    so we surface `cost` as the objective column and rank cheapest-first.
    const objectiveKey = String(keys.cost);
    const result = await compare.run({ node: req.node });
    if (!result.ok) return { ok: false, error: result.text }; // no node / no connections / solver error — verbatim

    // The tool returns EITHER a JSON array of options OR a plain-text note (e.g. "No alternative component type
    // fits …" / "No option … can meet its SLOs."). Distinguish by shape and relay the note verbatim.
    const options = parseOptions(result.text);
    if (options === undefined) return { ok: true, objectiveKey, options: [], note: result.text };
    return { ok: true, objectiveKey, options };
  } catch (e) {
    // buildSynthTools guards its own runs, but rehydration or tool construction could still throw — never let it
    // escape as an unhandled rejection; the command needs an outcome to display.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Parse the compare_options JSON body into typed options. Returns undefined when the body is NOT the options array
 * (a plain-text note), so the caller relays the note verbatim rather than inventing rows. Each row keys its
 * objective metric by the objective key name (e.g. `cost`); we read it back generically as `value`.
 */
function parseOptions(text: string): CompareOption[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined; // a plain-text note, not JSON
  }
  if (!Array.isArray(raw)) return undefined;
  const objectiveKey = String(keys.cost);
  const options: CompareOption[] = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue;
    const o = r as Record<string, unknown>;
    const type = typeof o.type === 'string' ? o.type : undefined;
    if (type === undefined) continue;
    const value = typeof o[objectiveKey] === 'number' ? (o[objectiveKey] as number) : NaN;
    const overflow = typeof o.overflow === 'number' ? o.overflow : 0;
    const sizing = Array.isArray(o.sizing)
      ? o.sizing.flatMap((s) => {
          if (typeof s !== 'object' || s === null) return [];
          const so = s as { key?: unknown; value?: unknown };
          return typeof so.key === 'string' && typeof so.value === 'number' ? [{ key: so.key, value: so.value }] : [];
        })
      : [];
    options.push({
      type,
      value,
      overflow,
      ...(typeof o.availability === 'number' ? { availability: o.availability } : {}),
      ...(typeof o.throughput === 'number' ? { throughput: o.throughput } : {}),
      sizing,
    });
  }
  return options;
}

/** The result of building a type-swap document edit. */
export type SwapResult = { readonly ok: true; readonly text: string; readonly from: string } | { readonly ok: false; readonly error: string };

/**
 * Build the NEW document text for swapping `node` to `newType`, using the SAME `setType` command the web/canvas use
 * (via a throwaway Studio) — so the swap keeps the id, wires, groups, labels and SLO bands and resets capacity
 * config to the new type's defaults, IDENTICALLY to every other shell. Pure `(text) → Result<text>`; the caller
 * turns it into a WorkspaceEdit with a native refactor-preview confirmation. Returns the node's OLD type too, so
 * the caller can label the preview `node: oldType → newType`. Fails honestly on a bad document / unknown node.
 */
export function swapTypeText(text: string, node: string, newType: string): SwapResult {
  const parsed = deserialize(text);
  if (!parsed.ok) return { ok: false, error: `the design is not valid JSON: ${parsed.error}` };
  const from = parsed.value.instances.find((i) => i.id === node)?.type;
  if (from === undefined) return { ok: false, error: `node "${node}" is not in the design` };

  // Route the swap through the SAME @sda/core command the canvas dispatches (`setType`), not a hand-rolled instance
  // rewrite — so the extension can never drift from the documented set_type semantics (keep id/wires/SLOs, drop
  // capacity config). The Studio validates the type against the merged catalogue and reports honestly if unknown.
  const studio = new Studio(registry, allManifests);
  studio.load(parsed.value);
  const applied = studio.dispatch({ kind: 'setType', id: node, type: newType });
  if (!applied.ok) return { ok: false, error: applied.error };
  return { ok: true, text: serialize(studio.project()), from };
}
