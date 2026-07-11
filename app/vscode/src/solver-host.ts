import { Studio, deserialize } from '@sda/core';
import { registry, allManifests, keys } from '@sda/content';
import { buildSearchTools } from '@sda/mcp/search';
// The composition root + the solver adapters are PURE modules (no side effects) but are not re-exported from
// a `@sda/mcp` subpath whose root export runs the stdio server on import, which we must never trigger inside the
// extension host. So we reach the source files directly (esbuild bundles them into dist/extension.js). The
// composition root is the single site that binds a solver adapter — as of the native in-process
// solver by default (no external MiniZinc needed); the proven-optimal MiniZinc/COIN-BC path is the rollback.
import { bindSolvers, referenceSolver } from '../../mcp/src/composition';
/** A backward-solve request (Improve): the goal + the serialized project to solve against. Host-internal —
 *  Improve runs entirely on the host (goal QuickPick → solve → refactor-preview document edit); the webview
 *  is not involved, so these types deliberately do NOT live in the wire protocol. */
export interface SolveRequest {
  readonly goal: 'feasible' | 'cheapest' | 'fastest';
  readonly projectJson: string;
}
export interface SolveResponse {
  readonly ok: boolean;
  /** ok=true: JSON of { changes: [{node,key,from?,to}], note? }. ok=false: the honest error text. */
  readonly body: string;
}

// Backward-solver host. Improve is entirely HOST-side: commands.ts builds a THROWAWAY Studio from the current
// document text, runs the @sda/mcp search tool (the in-process native solver by default; MiniZinc/COIN-BC on
// rollback — no external tool needed on the default path), and applies the accepted changes as a native document
// edit. When the solver cannot prove a design the tool itself returns an honest error string — we relay it
// unchanged (the tool must not lie, and neither may we by faking a result).

/**
 * Run one backward-solve and produce its SolveResponse. Never throws: a build error, a missing solver, or an
 * unexpected exception all resolve to `ok:false` with an honest message — the caller shows whatever comes
 * back, so a swallowed failure would silently mislead the user.
 */
export async function runSolve(req: SolveRequest): Promise<SolveResponse> {
  try {
    // 1. Rehydrate the design the webview is currently showing. An invalid document is a real, reportable
    //    condition (never a crash) — surface the parser's own message.
    const parsed = deserialize(req.projectJson);
    if (!parsed.ok) return { ok: false, body: `error: cannot solve — the project failed to parse: ${parsed.error}` };

    // A fresh, isolated Studio per request: the solve must not mutate any shared state, and the request already
    // carries the exact project to solve against (the webview owns the live document).
    const studio = new Studio(registry, allManifests);
    studio.load(parsed.value);

    // 2. Build the exact same search tools the MCP server exposes, driven by the composition root's bindings
    //    (the native in-process solver by default; MiniZinc on rollback) — one binding site for the CLI + the extension.
    //    The reference-MIP escalation target (docs: honest escalation) is passed too: a budget-coupling decline reruns
    //    the SAME Improve on the exact MiniZinc instead of dead-ending — resolved lazily, only if a binary is present.
    //    AUDIENCE 'human': every surfaced sentence renders in the UI dialect (System panel / Promises section /
    //    Improve — the shared message table's human column), never MCP tool syntax; the MCP server keeps 'agent'.
    const tools = buildSearchTools(studio, bindSolvers(registry), referenceSolver(registry), 'human');
    const repair = tools.find((t) => t.name === 'repair');
    const optimize = tools.find((t) => t.name === 'optimize');
    if (repair === undefined || optimize === undefined) {
      // Defensive: buildSearchTools is expected to provide both; if the tool set ever changes, fail honestly.
      return { ok: false, body: 'error: internal — the backward-search tools are unavailable' };
    }

    // 3. Dispatch by goal. `feasible` = the minimal change to meet every SLO (repair). `cheapest` = minimize the
    //    WHOLE-DESIGN total cost (the optimize tool's system scope — the sum of every node's own cost, off-path
    //    branches included; dogfood F8: a single node's cumulative cell misses the branches a real bill counts).
    //    `fastest` = maximize throughput at the SLO endpoint. All subject to every SLO.
    if (req.goal === 'feasible') {
      const result = await repair.run({});
      return { ok: result.ok, body: result.ok ? normalizeBody(result.text) : result.text };
    }
    if (req.goal === 'cheapest') {
      const result = await optimize.run({ key: String(keys.cost), direction: 'min', scope: 'system' });
      return { ok: result.ok, body: result.ok ? normalizeBody(result.text) : result.text };
    }

    // `fastest`: the throughput objective is read at the same "sink" the web uses — the first node carrying an
    // SLO band, else the last placed instance (the terminal of the flow). If there is no node, say so plainly.
    const sink = pickSink(studio);
    if (sink === undefined) {
      return { ok: false, body: 'error: no target node to optimize (the design has no components)' };
    }
    const result = await optimize.run({ node: sink, key: String(keys.throughput), direction: 'max' });
    return { ok: result.ok, body: result.ok ? normalizeBody(result.text) : result.text };
  } catch (e) {
    // buildSearchTools guards its own runs, but rehydration or tool construction could still throw — never let
    // it escape as an unhandled rejection; the webview needs a body to display.
    return { ok: false, body: `error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Normalize a search tool's raw text into the protocol's `{ changes: [{node,key,from?,to}], note?, engine? }` JSON.
 * A NATIVE `repair` returns a bare JSON array of {node,key,from,to,delta}; `optimize` a bare array of {node,key,value}
 * (value mapped to `to`). An ESCALATED result (docs: honest escalation) is a LABELED object
 * {engine:"reference-mip", basis, note, assignments|changes:[…]} — its rows are read the same way and the `engine`
 * + `note` ride through so the Improve command can tell the user WHICH engine sized the design. A non-JSON body
 * (e.g. "already within SLOs — no change needed") becomes an empty change list with the tool's own words as `note`.
 */
function normalizeBody(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    // NATIVE path — a bare array of change/assignment rows.
    if (Array.isArray(parsed)) return JSON.stringify({ changes: toChanges(parsed) });
    // ESCALATED path — a labeled object carrying its rows under `changes` (repair) or `assignments` (optimize).
    if (typeof parsed === 'object' && parsed !== null) {
      const o = parsed as { engine?: unknown; note?: unknown; changes?: unknown; assignments?: unknown };
      const rows = Array.isArray(o.changes) ? o.changes : Array.isArray(o.assignments) ? o.assignments : null;
      if (rows !== null) {
        return JSON.stringify({
          changes: toChanges(rows),
          ...(typeof o.engine === 'string' ? { engine: o.engine } : {}),
          ...(typeof o.note === 'string' ? { note: o.note } : {}),
        });
      }
    }
    return JSON.stringify({ changes: [], note: text });
  } catch {
    return JSON.stringify({ changes: [], note: text });
  }
}

/** Map raw solver rows ({node,key,from?,to} for repair, {node,key,value} for optimize) to the protocol's change
 *  shape — `value` folds into `to`, an absent numeric becomes NaN (dropped downstream). */
function toChanges(rows: readonly unknown[]): Array<{ node: string; key: string; from?: number; to: number }> {
  return rows.map((c) => {
    const o = c as { node?: unknown; key?: unknown; from?: unknown; to?: unknown; value?: unknown };
    return {
      node: String(o.node ?? ''),
      key: String(o.key ?? ''),
      ...(typeof o.from === 'number' ? { from: o.from } : {}),
      to: typeof o.to === 'number' ? o.to : typeof o.value === 'number' ? o.value : NaN,
    };
  });
}

/**
 * The optimization target node, matching app/web/src/app.tsx `runImprove`: the first placed instance that carries
 * an SLO band (the design's stated requirement lives there), falling back to the LAST instance (the flow's
 * terminal, where end-to-end figures are read). Returns undefined only for an empty design.
 */
function pickSink(studio: Studio): string | undefined {
  const instances = studio.project().instances;
  const withBand = instances.find((i) => (i.bands?.length ?? 0) > 0);
  if (withBand !== undefined) return withBand.id;
  return instances.at(-1)?.id;
}
