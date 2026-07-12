// The honesty vocabulary — the single home for SDA's rule that uncertainty is a VALUE, never a guess and
// never a throw. Every backward-search capability speaks
// this triad, so the distinction between "proven impossible" and "ran out of time" cannot be lost in a
// string or an exception. This module knows nothing about system design: it is pure control-flow vocabulary
// shared by Optimize, Repair, ExplainInfeasible and Enumerate.

/**
 * The MACHINE-READABLE class of a `did-not-converge` — a stable discriminant the surface layer gates on WITHOUT
 * string-matching the human `reason` (named the cause in PROSE for a reader; this names it for CODE, so a
 * consumer can branch on the exact class rather than fuzzy-matching a sentence). Domain-neutral solver vocabulary
 * (the contract core greps clean of cloud/product strings — dependency.test.ts (C)). The one class that MATTERS to
 * the surface today is `budget-coupling`: a budget-style ceiling binds against the objective — a joint knob
 * trade-off the monotone in-process search cannot make, yet the exact reference MIP solves it directly, so a
 * consumer may ESCALATE on exactly this code (and no other) — honest escalation, never a silent fallback.
 *  - `not-steady`      — the design has no steady-state fixpoint (a feedback loop); a genuine non-answer.
 *  - `saturation`      — a shared node can saturate under request classes (non-monotone processor-sharing).
 *  - `coupled`         — an SLO lies outside the monotone class (a point-target band, or a genuine sizing coupling).
 *  - `budget-coupling` — a budget-style ceiling binds AGAINST the objective (the escalatable joint trade-off).
 *  - `budget-explain`  — an explain over a design carrying a budget ceiling the single-corner model cannot place.
 *  - `eval-budget`     — the deterministic evaluation budget was exhausted without converging.
 *  - `aborted`         — the caller cancelled the search.
 *  - `model-error`     — the model could not be built (a malformed tunable / a cyclic flow).
 */
export type DidNotConvergeCode =
  | 'not-steady'
  | 'saturation'
  | 'coupled'
  | 'budget-coupling'
  | 'budget-explain'
  | 'eval-budget'
  | 'aborted'
  | 'model-error';

/**
 * The result of a backward search, as a discriminated union whose three kinds are genuinely different facts
 * that MUST NOT be conflated. Distilled from the incumbent's
 * `SolveOutcome` (engine/solve/src/minizinc/cli.ts) and the facade's two distinct error constants
 * `INFEASIBLE` / `DID_NOT_CONVERGE` (engine/solve/src/facade.ts): the contract promotes those strings into a
 * typed `kind` so the difference survives at the type level.
 *  - `solved`           — the search found a solution (for an `optimize`, the proven optimum), carrying it.
 *  - `infeasible`       — the search PROVED no solution exists (UNSAT). Actionable: explain the shortfall.
 *  - `did-not-converge` — it ran but neither found nor disproved a solution within the hard time bound.
 *                         Honest ignorance, NOT a lie of `infeasible`; simplify or set the knobs manually.
 *                         Carries an optional human `reason` AND an optional machine `code` (its class) — the two
 *                         say the SAME fact for a reader and for a consumer; the surface gates on `code`, never on
 *                         the prose (see {@link DidNotConvergeCode}).
 */
export type SearchResult<T> =
  | { readonly kind: 'solved'; readonly value: T }
  | { readonly kind: 'infeasible' }
  | { readonly kind: 'did-not-converge'; readonly reason?: string; readonly code?: DidNotConvergeCode };

/** Construct a `solved` result — the search succeeded and carries its solution. */
export const solved = <T>(value: T): SearchResult<T> => ({ kind: 'solved', value });

/** The singleton `infeasible` result — the search PROVED no solution exists (UNSAT). */
export const infeasible: SearchResult<never> = { kind: 'infeasible' };

/** The singleton `did-not-converge` result — the search neither found nor disproved a solution. Carries NO
 *  specific cause; prefer {@link didNotConvergeBecause} whenever the TRUE cause is known, so the surface layer can
 * name it honestly (a structural decline is NOT a time limit: never a cause dressed as a timeout). */
export const didNotConverge: SearchResult<never> = { kind: 'did-not-converge' };

/**
 * A `did-not-converge` carrying the TRUE cause — the honest, specific reason the search could not return an
 * answer (e.g. "the design has a point-target SLO the monotone search cannot prove", or "hit the evaluation
 * budget"). The surface layer (MCP/app) shows this verbatim instead of a generic "time limit" message, so the
 * distinction between "ran out of work" and "a construct outside the provable class" is never lost. `reason` is a plain, user-facing sentence — no stack, no jargon.
 * The optional `code` names the same fact for a CONSUMER so the surface can gate on it (e.g. escalate exactly the
 * `budget-coupling` class) without string-matching the prose — pass it whenever the class is known.
 */
export const didNotConvergeBecause = (reason: string, code?: DidNotConvergeCode): SearchResult<never> => ({
  kind: 'did-not-converge',
  reason,
  ...(code !== undefined ? { code } : {}),
});

/**
 * An optional best-effort cancellation channel for the ASYNCHRONOUS capabilities (docs/design/
 * solver-contract.html §9, owner ruling 2026-07-03: best-effort is acceptable for phase 0). "Best-effort"
 * is exact: an already-aborted signal makes the capability settle promptly WITHOUT producing a stale result,
 * and an in-flight abort means "discard the result" — a running WASM solve is not always interruptible
 * mid-CPU, so the contract promises the ANSWER is dropped, not that the CPU stops. True mid-run interruption
 * is a later item, not part of the phase-0 contract.
 */
export interface Cancellable {
  readonly signal?: AbortSignal;
}
