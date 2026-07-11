// @feature Backward search (optimize / repair / explain_infeasible / apply_solution)
// @story Size the design backwards: find the cheapest configuration that meets all SLOs, fix a
//   broken design with the minimal change, learn WHY it is infeasible — then apply the found
//   solution in one click.
// @surfaces mcp (repair / optimize / explain_infeasible / apply_solution here), vscode (Improve,
//   app/vscode/src/solver-host.ts), web (Improve in app/web/src/app.tsx)
// @algorithms engine/solver-contract/src/native/search.ts, engine/solve/src/minizinc/search.ts,
//   content/sda/src/robust.ts (worlds mode)
// @docs docs/design/solver-contract.html
// @e2e content/sda/src/optimize.e2e.test.ts, content/sda/src/sizing.e2e.test.ts,
//   app/mcp/src/cqrs-escalation.e2e.test.ts
// @status shipped

import { NodeId, Key, type Graph } from '@sda/engine-core';
import type { Change, Escalation, Objective, OptimizeSolution, SearchEngine, SolverBindings } from '@sda/solver-contract';
import { REFERENCE_MIP_BASIS, withBudgetEscalation } from '@sda/solver-contract';
import { keys, provisioningTunables, quantizeKnob, robustOptimize, robustRepair, systemBandsOf, TARGET_UTILIZATION, type AssumptionScenario, type RobustChange, type RobustOutcome } from '@sda/content';
import type { Command, Studio } from '@sda/core';
import type { AsyncToolDef, ToolResult } from './tools';
import { EDITS, fail, json, obj, ok, READS } from './tool-kit';
import { SEARCH_MESSAGES, solverMessage, type SearchMessageKind, type SolverAudience } from './messages';

export { SEARCH_MESSAGES, solverMessage, type SearchMessageKind, type SolverAudience, type SolverMessage } from './messages';

/**
 * The REFERENCE-MIP escalation target (docs: honest escalation). When the native in-process solver declines a
 * budget-coupling trade-off, the surface reruns the SAME request on this exact optimizer of record. `resolve`
 * returns the incumbent `SolverBindings` for THIS install, or `undefined` when the install ships no MIP (a node
 * shell with no `minizinc` binary; probed honestly) — then the native decline stands with the loosen-the-ceiling
 * guidance. It is resolved LAZILY (only on a decline) and cached, so a node install never probes until it matters
 * and a browser fetches the MIP WASM only then. The composition root supplies the concrete implementation.
 */
export interface ReferenceSolver {
  resolve(): Promise<SolverBindings | undefined>;
  /** The hard time bound for one escalated solve; omit for the contract default (ESCALATION_TIMEOUT_MS). */
  readonly timeoutMs?: number;
}

// A knob change the backward search proposes, normalized to what set_config would apply (value already quantized —
// whole-unit knobs rounded UP). The store below keeps the last few so `apply_solution` can dispatch one in a single
// batch, closing F10: the agent no longer parses/rounds/fires N calls to enact what repair/optimize already found.
interface AppliableSolution {
  readonly id: string;
  readonly from: string; // which tool produced it (repair / optimize) — shown so a chosen id is unambiguous
  readonly changes: readonly { readonly node: string; readonly key: string; readonly value: number }[];
}

/** A tiny ring buffer of the last N backward-search proposals, keyed by an ascending id (sol-1, sol-2, …). One per
 *  server session; `apply_solution` reads it. Bounded so a long session cannot grow it without limit. */
class SolutionStore {
  private readonly byId = new Map<string, AppliableSolution>();
  private readonly order: string[] = [];
  private counter = 0;
  constructor(private readonly max = 10) {}
  remember(from: string, changes: AppliableSolution['changes']): string {
    this.counter += 1;
    const id = `sol-${this.counter}`;
    this.byId.set(id, { id, from, changes });
    this.order.push(id);
    while (this.order.length > this.max) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.byId.delete(evicted);
    }
    return id;
  }
  latest(): AppliableSolution | undefined {
    const id = this.order[this.order.length - 1];
    return id !== undefined ? this.byId.get(id) : undefined;
  }
  get(id: string): AppliableSolution | undefined {
    return this.byId.get(id);
  }
  ids(): readonly string[] {
    return [...this.order];
  }
}

// The backward-search MCP tools (doc-4 §4: optimize / repair / explain). These are async — they await
// the bound solver — and live apart from the synchronous command tools so a shell that binds only `evaluate`
// never tries to register them. The set of knobs the search may vary is the shared `provisioningTunables`
// (content) — one source of truth for app + MCP + synthesize.
//
// The tools depend on the solver CONTRACT (`SolverBindings`, docs/design/solver-contract.html §5), not on a
// concrete engine: the composition root (composition.ts) binds an adapter and hands it in. As of TASK-79
// phase 3 the DEFAULT is the NATIVE in-process solver (no MiniZinc process/WASM); the incumbent MiniZinc/COIN-BC
// path stays selectable as the one-argument rollback and referees the native answers in CI. The honesty kinds
// (`solved` / `infeasible` / `did-not-converge`) map to the SAME tool output strings the facade produced before,
// so the tool surface is byte-identical to callers regardless of which solver is bound.

// The honest failure a search reports. Infeasible and did-not-converge are DIFFERENT facts and must read
// differently — conflating them is a lie (doc-4). And a did-not-converge is NOT always a time limit: the native
// solver mostly declines for a STRUCTURAL reason (an SLO outside its monotone class), which it names via the
// SearchResult's `reason` (TASK-86 F1). We surface that true cause verbatim — never a cause dressed as a timeout.
//
// EVERY fixed sentence lives in the shared MESSAGE TABLE (./messages) with ONE form per kind and TWO renderings
// (agent vs human — the audience axis), so a native shell (VS Code Improve) never surfaces MCP tool syntax while
// the agent dialect stays byte-identical. The parameterised messages below COMPOSE table forms, never ad-hoc text.

/**
 * Build the backward-search tools for one audience. `audience` picks the DIALECT of every surfaced message
 * (./messages): `'agent'` (the default — the MCP tool surface, where naming the next tool call IS the UI) or
 * `'human'` (a native shell such as VS Code Improve, which must speak in panels and sections, never tool syntax).
 * The tool BEHAVIOUR is identical either way — only the vocabulary of the honest sentences changes.
 */
export function buildSearchTools(studio: Studio, solvers: SolverBindings, reference?: ReferenceSolver, audience: SolverAudience = 'agent'): AsyncToolDef[] {
  /** The audience's rendering of a table message kind — the one lookup every fixed sentence goes through. */
  const M = (kind: SearchMessageKind): string => solverMessage(SEARCH_MESSAGES[kind], audience);
  /** The honest did-not-converge message: the TRUE cause (`reason`, the solver's own words) followed by the
   *  guidance. Absent a reason, the generic honest lead — never the old "within the time limit" claim, which
   *  mislabels a structural decline as a timeout (TASK-86 F1). */
  const didNotConvergeMsg = (reason?: string): string =>
    reason !== undefined && reason.length > 0 ? `${reason} — ${M('didNotConvergeGuidance')}` : `${M('didNotConvergeFallback')} — ${M('didNotConvergeGuidance')}`;
  /** A budget-coupling decline that is the FINAL answer — the reference MIP was unavailable on this install, or
   *  was consulted and also could not within the time bound. The honest cause + the loosen-the-ceiling hint. */
  const budgetCouplingMsg = (reason: string | undefined, referenceTried: boolean): string => {
    const cause = referenceTried ? M('budgetReferenceTried') : reason ?? M('budgetFallbackCause');
    return `${cause} — ${M('loosenCeiling')}, or ${M('didNotConvergeGuidance')}`;
  };
  // Size each tier to ρ ≤ TARGET_UTILIZATION so the solution has FINITE queueing latency, not the ρ=1 knife-edge
  // (throughput met but the queue unbounded). Same headroom the web's Improve uses — one behaviour for human + AI.
  const headroom = { key: keys.throughput, factor: TARGET_UTILIZATION };
  // HONEST ESCALATION plumbing (docs: honest escalation). The reference MIP is resolved LAZILY and cached for the
  // session — a node install without a `minizinc` binary probes once and stays `undefined`; a budget-coupling
  // decline is the ONLY trigger, so the common (native) path never touches it.
  let referenceBindings: Promise<SolverBindings | undefined> | undefined;
  const resolveReference = (): Promise<SolverBindings | undefined> => {
    if (reference === undefined) return Promise.resolve(undefined);
    referenceBindings ??= reference.resolve();
    return referenceBindings;
  };
  const graph = (): Graph | null => {
    const g = studio.graph();
    return g.ok ? g.value : null;
  };
  /** True when the design declares request classes ⇒ the backward search must decline honestly (multiClassDecline). */
  const multiClass = (): boolean => studio.project().requestClasses.length > 0;
  // A backward-search reports non-convergence as a VALUE (an honest did-not-converge, named), never a throw. This
  // wrapper is the last-resort net for a GENUINE internal error (a bug), and it must NOT dress that as a timeout —
  // a throw and a time limit are different facts (TASK-86 F1). It surfaces the error honestly as an internal error.
  const guarded = (run: (a: Record<string, unknown>) => Promise<ToolResult>) => async (a: Record<string, unknown>): Promise<ToolResult> => {
    try {
      return await run(a);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return fail(`the solver failed with an internal error (not a timeout): ${detail}. Please report this design; meanwhile ${M('didNotConvergeGuidance')}.`);
    }
  };
  // The two search capabilities this file uses are always bound by the composition root (native by default,
  // incumbent MiniZinc on rollback). If a caller ever binds only `evaluate`, the tool reports it honestly
  // rather than throwing an unhandled error.
  const needOptimize = solvers.optimize;
  const needRepair = solvers.repair;
  const needExplain = solvers.explainInfeasible;
  // The last-few applyable proposals (F10) and whether the design carries ANY numeric SLO band — repair on a
  // design with no requirement is a confusing no-op, so it is answered with guidance instead.
  const solutions = new SolutionStore();
  const hasSlo = (): boolean => studio.project().instances.some((i) => (i.bands?.length ?? 0) > 0);

  // ── HONEST ESCALATION renderers (docs: honest escalation) ────────────────────────────────────────────────────
  // A native solve is rendered byte-for-byte its prior bare array (existing agents/tests unchanged). A reference-MIP
  // solve is a LABELED object {engine:'reference-mip', basis, note, assignments|changes} so the escalation is
  // VISIBLE (never a silent fallback). A budget-coupling dead end — no MIP on this install, or the MIP also could
  // not within the bound — is the honest cause + the loosen-the-ceiling hint (extended guidance). Every other
  // outcome (infeasible, a non-budget decline) reads exactly as before.
  const timeoutMs = reference?.timeoutMs;
  const REFERENCE_ENGINE: SearchEngine = 'reference-mip';
  const renderOptimize = (esc: Escalation<OptimizeSolution>): ToolResult => {
    const r = esc.result;
    if (esc.via === 'unavailable') return fail(budgetCouplingMsg(r.kind === 'did-not-converge' ? r.reason : undefined, false));
    if (r.kind === 'infeasible') return fail(M('infeasible'));
    if (r.kind === 'did-not-converge') return fail(esc.via === 'escalated' ? budgetCouplingMsg(undefined, true) : didNotConvergeMsg(r.reason));
    const id = solutions.remember('optimize', r.value.assignments.map((x) => ({ node: String(x.node), key: String(x.key), value: quantizeKnob(String(x.key), x.value) })));
    const rows = r.value.assignments.map((x) => ({ node: x.node, key: x.key, value: x.value, solution: id }));
    if (esc.via === 'escalated') return json({ engine: REFERENCE_ENGINE, basis: REFERENCE_MIP_BASIS, note: M('escalatedNote'), assignments: rows });
    return json(rows);
  };
  const renderRepair = (esc: Escalation<readonly Change[]>): ToolResult => {
    const r = esc.result;
    if (esc.via === 'unavailable') return fail(budgetCouplingMsg(r.kind === 'did-not-converge' ? r.reason : undefined, false));
    if (r.kind === 'infeasible') return fail(M('infeasible'));
    if (r.kind === 'did-not-converge') return fail(esc.via === 'escalated' ? budgetCouplingMsg(undefined, true) : didNotConvergeMsg(r.reason));
    if (r.value.length === 0) {
      // Distinguish "your requirements are already met" from "you declared none" (the audit's confusing no-op) —
      // the native path exactly as before; an escalated no-change carries the reference-MIP label so it stays visible.
      if (esc.via === 'escalated') return json({ engine: REFERENCE_ENGINE, basis: REFERENCE_MIP_BASIS, note: M('escalatedNoChange'), changes: [] });
      return hasSlo() ? ok(M('alreadyWithinSlos')) : fail(M('noSlosDeclared'));
    }
    const id = solutions.remember('repair', r.value.map((c) => ({ node: String(c.node), key: String(c.key), value: quantizeKnob(String(c.key), c.to) })));
    const rows = r.value.map((c) => ({ node: c.node, key: c.key, from: c.from, to: c.to, delta: c.delta, solution: id }));
    if (esc.via === 'escalated') return json({ engine: REFERENCE_ENGINE, basis: REFERENCE_MIP_BASIS, note: M('escalatedNote'), changes: rows });
    return json(rows);
  };

  // ROBUST IMPROVE across named worlds (assumption-model doc §8) — an OPT-IN on repair/optimize. Absent `worlds` ⇒
  // the base single-graph search below is UNTOUCHED (bit-for-bit). Present ⇒ the search runs once per selected world
  // and the knob values are combined (content `robustRepair`/`robustOptimize`), so the SLOs hold in ALL of them.
  const ROBUST_HINT =
    "Optional — hold the SLOs in MULTIPLE named worlds, not just the base design (assumption-model §8). 'all' = every declared world; a [id,…] array = those worlds; omit for today's single-design search. The base world is always included. Each result knob names the world that BINDS it.";
  /** Resolve the `worlds` arg to the SELECTED named worlds, or `null` for the untouched single-graph path. `'active'`
   *  has no server-side lens here, so it resolves to the base design only (robust over the base world). */
  const resolveWorlds = (arg: unknown): readonly AssumptionScenario[] | null => {
    if (arg === undefined || arg === null || arg === '') return null; // default path — untouched
    const scenarios = studio.project().scenarios;
    if (arg === 'all') return scenarios;
    if (arg === 'active') return [];
    if (Array.isArray(arg)) { const want = new Set(arg.map((x) => String(x))); return scenarios.filter((s) => want.has(s.id)); }
    const one = scenarios.find((s) => s.id === String(arg));
    return one ? [one] : [];
  };
  /** A solved robust outcome → the SAME pure `json()` envelope the base search speaks (renderRepair/renderOptimize),
   *  storing the changes as an applyable solution. The robust facts ride the rows themselves — each row carries the
   *  `bindingWorld` that binds its knob (the robust signal + the "each knob names its world" note) — so the framing
   *  prose is no longer prepended; the enact-with-apply_solution cue lives in the tool descriptions. An empty change
   *  set stays a plain sentence, exactly like the base "already within SLOs" path. */
  const okRobust = (out: Extract<RobustOutcome, { kind: 'solved' }>, from: string): ToolResult => {
    // The table's no-change form with the world list appended before the em-dash tail (one form, both dialects).
    if (out.changes.length === 0) {
      return ok(M('alreadyWithinSlos').replace(' — ', ` across worlds [${out.worlds.join(', ')}] — `));
    }
    const id = solutions.remember(from, out.changes.map((c: RobustChange) => ({ node: c.node, key: c.key, value: c.value })));
    const rows = out.changes.map((c: RobustChange) => ({ node: c.node, key: c.key, value: c.value, bindingWorld: c.bindingWorld, solution: id }));
    return json(rows);
  };
  /** A non-solved robust outcome → the honest failure, NAMING the world that drove it (infeasible ≠ did-not-converge). */
  const failRobust = (out: Exclude<RobustOutcome, { kind: 'solved' }>): ToolResult =>
    out.kind === 'infeasible'
      ? fail(`${M('infeasible')} — infeasible in world "${out.world}"`)
      : fail(`${didNotConvergeMsg(out.reason)} (world "${out.world}")`);
  /** The batch evaluator robust improve needs (per-world overlay verification). */
  const needBatch = solvers.evaluateBatch;

  return [
    {
      name: 'repair',
      description: 'Run backwards (exact, in-process solver): find the MINIMAL change to provisioning knobs (concurrency/replicas/throughput) that makes every SLO hold — sizing each tier with capacity headroom (ρ ≤ 80%) so the result has finite latency, not a saturated knife-edge. Returns PROPOSED changes {node, key, from, to} and stores them as an applyable solution: enact the whole set in ONE call with apply_solution (whole-unit knobs rounded UP) instead of firing N set_config calls. With no SLO declared it declines with guidance (there is nothing to make hold). If the in-process solver declines a budget-coupled trade-off, the exact reference MIP answers instead and the result is a labeled object {engine:"reference-mip", basis, note, changes:[…]}. Pass `worlds` to make the fix ROBUST — holding every SLO across the selected named worlds (assumption-model §8), not just the base design; the robust result is an applyable solution too (each row names the world that binds its knob), enact it in ONE call with apply_solution. e.g. {} (or {worlds:"all"}).',
      inputSchema: obj({ worlds: { description: ROBUST_HINT } }),
      // Not a pure read: it STORES the applyable proposal (session state, not the design/canvas) for apply_solution.
      annotations: EDITS,
      run: guarded(async (a) => {
        if (multiClass()) return fail(M('multiClassDecline'));
        const g = graph();
        if (g === null) return fail(M('buildErrors'));
        if (needRepair === undefined) return fail(`${M('noSearchSolver')} — ${audience === 'agent' ? 'repair' : 'Improve'} is unavailable`);
        // ROBUST across worlds (opt-in) — run the SAME repair per world and combine (content `robustRepair`). Absent
        // `worlds` ⇒ fall through to the untouched single-graph path below.
        const selected = resolveWorlds(a.worlds);
        if (selected !== null) {
          if (needBatch === undefined) return fail(M('noBatchSolver'));
          const proj = studio.project();
          const out = await robustRepair({ graph: g, instances: proj.instances, wires: proj.wires, worlds: selected }, needRepair, needBatch);
          return out.kind === 'solved' ? okRobust(out, 'repair') : failRobust(out);
        }
        const tunables = provisioningTunables(g);
        // The declared SYSTEM promises ride the search as whole-graph SUM bands (owner ruling: cost is for THE
        // WHOLE SYSTEM) — a repair must land INSIDE the declared system ceiling, or decline/escalate honestly.
        const systemBands = systemBandsOf(studio.project().systemPromises);
        const native = await needRepair({ graph: g, tunables, headroom, ...(systemBands.length > 0 ? { systemBands } : {}) });
        // HONEST ESCALATION: a budget-coupling decline (and ONLY that class) reruns the SAME repair on the exact
        // reference MIP; every other outcome passes straight through. renderRepair speaks the honesty triad + the label.
        const esc = await withBudgetEscalation(native, async (signal) => (await resolveReference())?.repair?.({ graph: g, tunables, headroom, signal, ...(systemBands.length > 0 ? { systemBands } : {}) }), timeoutMs);
        return renderRepair(esc);
      }),
    },
    {
      name: 'explain_infeasible',
      description: 'Explain WHY the SLOs cannot be met: the exact shortfall (by how much) per unmet SLO, even after tuning every knob. Reach for this when repair returns infeasible. e.g. {}',
      inputSchema: obj({}),
      annotations: READS,
      run: guarded(async () => {
        if (multiClass()) return fail(M('multiClassDecline'));
        const g = graph();
        if (g === null) return fail(M('buildErrors'));
        if (needExplain === undefined) return fail(`${M('noSearchSolver')} — ${audience === 'agent' ? 'explain_infeasible' : 'the infeasibility explainer'} is unavailable`);
        const r = await needExplain({ graph: g, tunables: provisioningTunables(g) });
        // The relaxed model is always satisfiable, so the only non-solved outcome is an honest non-convergence
        // (e.g. a budget-style ceiling the single-corner explainer cannot place) — named by the solver's `reason`.
        if (r.kind !== 'solved') return fail(didNotConvergeMsg(r.kind === 'did-not-converge' ? r.reason : undefined));
        return r.value.length > 0 ? json(r.value) : ok('feasible — every SLO can be met by tuning the knobs');
      }),
    },
    {
      name: 'optimize',
      description: 'Run backwards (exact): minimize/maximize a key (e.g. cost) subject to all SLOs, over the provisioning knobs. Returns the chosen knob values and stores them as an applyable solution — enact them in ONE call with apply_solution instead of transcribing each set_config. Pass scope:"system" to optimize the WHOLE-DESIGN total of the key — the sum of every node\'s own contribution (e.g. the full monthly bill, off-path branches like a cache included; `node` is then optional). Default scope is the value at `node` (its cumulative path cell). If the in-process solver declines a budget-coupled trade-off (a cost ceiling binding against the objective), the exact reference MIP answers instead and the result is a labeled object {engine:"reference-mip", basis, note, assignments:[…]}. Pass `worlds` for a ROBUST objective — the cheapest configuration that holds every SLO across the selected named worlds (assumption-model §8), not just the base design; the robust result is an applyable solution too (each row names the world that binds its knob), enact it in ONE call with apply_solution. e.g. {node:"db", key:"cost", direction:"min"} or {key:"cost", direction:"min", scope:"system"}',
      inputSchema: obj(
        {
          key: { type: 'string' },
          node: { type: 'string', description: 'The node whose value is optimized. Optional with scope:"system" (the total needs no anchor).' },
          direction: { type: 'string', enum: ['min', 'max'] },
          scope: { type: 'string', enum: ['node', 'system'], description: '"system" = the WHOLE-DESIGN total of `key` (sum of every node\'s own contribution — the honest full bill for cost). Default "node" = the value at `node`.' },
          worlds: { description: ROBUST_HINT },
        },
        ['key'],
      ),
      // Not a pure read: it STORES the applyable proposal (session state, not the design/canvas) for apply_solution.
      annotations: EDITS,
      run: guarded(async (a) => {
        if (multiClass()) return fail(M('multiClassDecline'));
        const g = graph();
        if (g === null) return fail(M('buildErrors'));
        if (needOptimize === undefined) return fail(`${M('noSearchSolver')} — ${audience === 'agent' ? 'optimize' : 'Improve'} is unavailable`);
        const direction = a.direction === 'max' ? 'max' : 'min';
        const system = a.scope === 'system';
        // The SYSTEM scope (dogfood F8): the objective is the WHOLE-DESIGN total — `total: true`, the sum of every
        // node's own contribution to `key` — so an off-path branch (a cache beside the flow) is priced too, which no
        // single node's cumulative cell can see. `node` then only anchors the read-back, so it may be omitted; the
        // first instance stands in. Without the system scope, `node` is required — the guided error self-corrects.
        const anchor = typeof a.node === 'string' && a.node !== '' ? String(a.node) : system ? studio.project().instances[0]?.id : undefined;
        if (anchor === undefined) {
          return fail(system ? 'the design has no components to optimize — add a node first' : M('optimizeNeedsTarget'));
        }
        const objective: Objective = { node: NodeId(anchor), key: Key(String(a.key)), direction, ...(system ? { total: true } : {}) };
        // ROBUST across worlds (opt-in) — run the SAME optimize per world and combine (content `robustOptimize`).
        const selected = resolveWorlds(a.worlds);
        if (selected !== null) {
          if (needBatch === undefined) return fail(M('noBatchSolver'));
          const proj = studio.project();
          const out = await robustOptimize({ graph: g, instances: proj.instances, wires: proj.wires, worlds: selected }, objective, needOptimize, needBatch);
          return out.kind === 'solved' ? okRobust(out, 'optimize') : failRobust(out);
        }
        const tunables = provisioningTunables(g);
        // The declared SYSTEM promises ride the search as whole-graph SUM bands (owner ruling: cost is for THE
        // WHOLE SYSTEM) — the optimum must sit inside the declared system ceiling, or decline/escalate honestly.
        const systemBands = systemBandsOf(studio.project().systemPromises);
        const native = await needOptimize({ graph: g, tunables, objective, headroom, ...(systemBands.length > 0 ? { systemBands } : {}) });
        // HONEST ESCALATION: a budget-coupling decline (a budget ceiling binding against THIS objective) reruns the
        // SAME optimize on the exact reference MIP; every other outcome passes straight through. See renderOptimize.
        const esc = await withBudgetEscalation(native, async (signal) => (await resolveReference())?.optimize?.({ graph: g, tunables, objective, headroom, signal, ...(systemBands.length > 0 ? { systemBands } : {}) }), timeoutMs);
        return renderOptimize(esc);
      }),
    },
    {
      name: 'apply_solution',
      description:
        'Apply a stored backward-search proposal (from repair or optimize) to the design in ONE call — the server holds the last few, whole-unit knobs already rounded UP. Pass {} to apply the MOST RECENT proposal, or {id:"sol-N"} (the id each repair/optimize result carries) for a specific earlier one. Returns what was applied + the new violation count (call evaluate for the full picture). The no-transcription path: repair/optimize propose, apply_solution enacts. e.g. {} (apply the latest) or {id:"sol-2"}',
      inputSchema: obj({ id: { type: 'string' } }),
      annotations: EDITS,
      run: async (a): Promise<ToolResult> => {
        const idArg = a.id !== undefined && a.id !== null && String(a.id) !== '' ? String(a.id) : undefined;
        const sol = idArg !== undefined ? solutions.get(idArg) : solutions.latest();
        if (sol === undefined) {
          const ids = solutions.ids();
          return fail(
            idArg !== undefined
              ? `no stored solution "${idArg}" — the held solutions are [${ids.join(', ') || 'none'}]; run repair or optimize first, then apply_solution`
              : 'no backward-search proposal to apply yet — run repair or optimize first, then apply_solution to enact it',
          );
        }
        if (sol.changes.length === 0) return ok(`solution ${sol.id} (${sol.from}) proposed no change — the design already meets its SLOs`);
        const cmds: Command[] = sol.changes.map((c) => ({ kind: 'setConfig', node: c.node, key: c.key, value: c.value }));
        const res = studio.dispatchBatch(cmds);
        if (!res.ok) return fail(res.error);
        const violations = studio.verdicts().filter((v) => v.status === 'violation').length;
        return ok(`applied ${sol.id} (${sol.from}): ${sol.changes.map((c) => `${c.node}.${c.key}=${c.value}`).join(', ')}. The design now has ${violations} SLO violation(s) — call evaluate for the full verified picture.`);
      },
    },
  ];
}
