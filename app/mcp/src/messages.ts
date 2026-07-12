// THE SOLVER MESSAGE TABLE — one form per message KIND, rendered per AUDIENCE (owner finding, 2026-07): the
// SAME solver outcome is read by two very different readers. An AI agent drives the MCP tool surface, so its
// rendering names the exact next tool call (`set_slo {node, key, max/min}`, `apply_solution`) — that syntax IS
// the agent's UI. A human in VS Code never sees those tools; their UI is the System panel, a node's Promises
// section and the Improve command, so the SAME fact must speak THAT language. One table, two renderings per
// kind, chosen once at `buildSearchTools(…, audience)` — so the two dialects can never drift apart in meaning,
// only in vocabulary, and a new message kind must state both renderings deliberately.
//
// HARD RULE (pinned by app/vscode/src/solver-dialect.test.ts): no `human` rendering may contain MCP tool syntax
// (a tool name, a `{...}` argument shape). The `agent` renderings are byte-identical to the strings the MCP
// tools always spoke, so no agent-facing contract moved.

/** Who reads the rendered message: an AI agent on the MCP surface, or a human in a native shell (VS Code). */
export type SolverAudience = 'agent' | 'human';

/** One message kind: the same fact in both dialects. */
export interface SolverMessage {
  readonly agent: string;
  readonly human: string;
}

/** Render a message kind for an audience — the one lookup every surfaced solver string goes through. */
export const solverMessage = (m: SolverMessage, audience: SolverAudience): string => m[audience];

/** The table — every fixed sentence the backward-search tools surface, keyed by kind. Parameterised messages
 *  (a solver-named reason, a world id) are composed in search.ts FROM these fixed forms, never ad hoc. */
export const SEARCH_MESSAGES = {
  /** A proven-UNSAT search: no knob setting can satisfy every promise. */
  infeasible: {
    agent: 'no configuration of the tunables can satisfy every SLO (proven infeasible — use explainInfeasible for the exact shortfall)',
    human: 'no configuration of the provisioning knobs can satisfy every promise (proven infeasible) — loosen a promise, or change the design (a faster or cheaper component, an extra tier or replica)',
  },
  /** The actionable tail every did-not-converge message ends with (what the reader can DO about it). */
  didNotConvergeGuidance: {
    agent: 'set the provisioning knobs manually, or simplify the design (fewer free knobs / SLOs)',
    human: 'set the provisioning knobs manually, or simplify the design (fewer free knobs / promises)',
  },
  /** The generic did-not-converge lead when the solver reported no specific reason. */
  didNotConvergeFallback: {
    agent: 'the exact in-process solver could not size this design',
    human: 'the exact in-process solver could not size this design',
  },
  /** The loosen-the-ceiling hint for a budget-coupling dead end (docs: honest escalation). */
  loosenCeiling: {
    agent: 'loosen or remove the budget-style ceiling (the cost limit forcing the trade-off) so Improve can find the true minimal cost — then compare it to your budget',
    human: 'loosen or remove the budget-style ceiling (the cost limit forcing the trade-off) so Improve can find the true minimal cost — then compare it to your budget',
  },
  /** The budget-coupling cause when the reference MIP was consulted and ALSO could not size it. */
  budgetReferenceTried: {
    agent: 'the exact reference MIP was consulted for this budget-coupled trade-off but could not size it within the time bound',
    human: 'the exact reference MIP was consulted for this budget-coupled trade-off but could not size it within the time bound',
  },
  /** The budget-coupling cause when no reason was named and no reference MIP exists on this install. */
  budgetFallbackCause: {
    agent: 'a budget-style ceiling binds against the objective — a joint knob trade-off outside the in-process solver’s monotone class',
    human: 'a budget-style ceiling binds against the objective — a joint knob trade-off outside the in-process solver’s monotone class',
  },
  /** The one-line note on an ESCALATED (reference-MIP) result: which engine answered, why, and how to enact. */
  escalatedNote: {
    agent: 'the in-process solver declined this budget-coupled trade-off; the exact reference MIP solved it (a longer solve). Enact with apply_solution.',
    human: 'the in-process solver declined this budget-coupled trade-off; the exact reference MIP solved it (a longer solve). Review and apply the proposed changes.',
  },
  /** An escalated result that proposes NO change: the reference MIP confirms the design already holds. */
  escalatedNoChange: {
    agent: 'the exact reference MIP confirms the design already meets every SLO — no change needed.',
    human: 'the exact reference MIP confirms the design already meets every promise — no change needed.',
  },
  /** Repair on a design that already satisfies everything — a no-op stated plainly. */
  alreadyWithinSlos: {
    agent: 'already within SLOs — no change needed',
    human: 'already meets every promise — no change needed',
  },
  /** Repair with NOTHING declared: there is no promise to make hold, so the reader must declare one first. */
  noSlosDeclared: {
    agent: 'no SLOs declared — repair has nothing to make hold. Declare a requirement first (set_slo {node, key, max/min}), or call envelope to see the current limits and what breaks first.',
    human: 'no promises declared — Improve has nothing to make hold. Declare a promise first: in the System panel (a promise on a flow) or on a node’s Promises section.',
  },
  /** The multi-class honest decline — search under declared request classes. */
  multiClassDecline: {
    agent: 'multi-class search is not yet available — request classes break per-class monotonicity at shared saturated nodes, so the native solver must first be certified by the oracle harness’s class axis. Evaluate per class instead, remove the request classes to search the single-river design, or set the provisioning knobs manually.',
    human: 'searching a design with request classes is not available yet — classes break the solver’s per-class monotonicity at shared saturated nodes. Remove the request classes to search the single-flow design, or set the provisioning knobs manually.',
  },
  /** The design text does not compile into a graph — nothing can be solved until the errors are fixed. */
  buildErrors: {
    agent: 'design has build errors',
    human: 'the design has build errors — fix the entries in the Problems panel first',
  },
  /** A shell that bound no backward-search solver (interface segregation) — the capability is absent, honestly. */
  noSearchSolver: {
    agent: 'this server has no backward-search solver bound',
    human: 'this install has no backward-search solver bound',
  },
  /** A shell that bound no batch evaluator — robust (multi-world) improve cannot verify per world. */
  noBatchSolver: {
    agent: 'this server has no batch-evaluation backend bound — robust improve across worlds is unavailable',
    human: 'this install has no batch-evaluation backend bound — robust improve across worlds is unavailable',
  },
  /** Optimize called with neither a target node nor the system scope — the self-correcting guidance. */
  optimizeNeedsTarget: {
    agent: 'optimize needs a target: pass {node} for one node’s value, or scope:"system" to optimize the whole-design total of the key',
    human: 'Improve needs a target: pick a node, or optimize the whole-design total',
  },
} as const satisfies Record<string, SolverMessage>;

/** Every message kind in the table — the sweep test iterates this to pin the human dialect clean. */
export type SearchMessageKind = keyof typeof SEARCH_MESSAGES;
