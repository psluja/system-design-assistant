// CAPABILITY: Enumerate — generate legal topologies. GENERATE
// candidate discrete structures (not check one): return every valid selection — exactly one option per slot
// such that adjacent choices are compatible and placement rules hold. ASYNCHRONOUS. Distilled from
// `enumerateSelections` over clingo-wasm (engine/solve/src/asp/clingo.ts).
//
// The selection-problem models below are DELIBERATELY re-declared here (not imported from engine/solve): they
// are pure opaque-id data with no engine dependency, and the contract is their canonical home
// (docs §3 "lifts the models out into the shared package"). They stay structurally identical to today's
// `SelectionProblem` / `Selection` so the incumbent adapter maps them by an identity spread — the anti-drift
// pin is the conformance suite, not a shared import (which would couple the contract core to engine/solve and
// break the "imports only engine-core" rule, owner ruling 2026-07-03).
//
// Same repeated template as every capability module: types, request, result/domain models, interface,
// two-implementations note.

import type { Cancellable } from '../honesty';

/**
 * A discrete selection problem: choose exactly one option per slot such that every adjacency's chosen options
 * are compatible and any placement rules hold. Domain-agnostic — slots, options and compatibility are opaque
 * string ids; the SDA meaning (archetypes, protocol matching) is content. Shape-identical to today's
 * `SelectionProblem` (engine/solve/src/asp/clingo.ts).
 */
export interface SelectionProblem {
  readonly slots: readonly { readonly id: string; readonly candidates: readonly string[] }[];
  /** Slot pairs `[from, to]` whose chosen options must be compatible. */
  readonly adjacencies: readonly (readonly [string, string])[];
  /** Allowed `[fromOption, toOption]` value pairs (e.g. derived from protocol matching). */
  readonly compatible: readonly (readonly [string, string])[];
  /** Placement rule: choosing option A anywhere requires option B chosen somewhere (`[A, B]`). */
  readonly requires?: readonly (readonly [string, string])[];
  /** Placement rule: options A and B may not both be chosen (`[A, B]`). */
  readonly conflicts?: readonly (readonly [string, string])[];
}

/** One solution: the option chosen for each slot. Shape-identical to today's `Selection`. */
export type Selection = Readonly<Record<string, string>>;

/**
 * The input to an enumeration. `limit` of 0 or omitted means "all answer sets"; `signal` is the optional
 * best-effort cancellation channel.
 */
export interface EnumerateRequest extends Cancellable {
  readonly problem: SelectionProblem;
  readonly limit?: number;
}

/**
 * The result of an enumeration. UNSAT is NOT an error — it is an `enumerated` result carrying an EMPTY
 * selection list (there simply is no valid structure). The `did-not-converge` kind is NEW relative to today's
 * raw runner (which throws on a solver error and has no time bound): the contract requires Enumerate to obey
 * the same "search never throws / never hangs" discipline the MiniZinc path already honours, so a solver
 * error or a timeout surfaces here as an honest `did-not-converge` rather than an exception
 *.
 */
export type EnumerateResult =
  | { readonly kind: 'enumerated'; readonly selections: readonly Selection[] }
  | { readonly kind: 'did-not-converge' };

/** Construct an `enumerated` result — the enumeration ran; `selections` may be empty (UNSAT). */
export const enumerated = (selections: readonly Selection[]): EnumerateResult => ({ kind: 'enumerated', selections });

/** The singleton Enumerate `did-not-converge` — the enumeration errored or timed out (no-throw, no-hang). */
export const enumerateDidNotConverge: EnumerateResult = { kind: 'did-not-converge' };

/**
 * GENERATE candidate discrete structures (not check one): return every valid selection — exactly one option
 * per slot such that all adjacent choices are compatible and placement rules (requires/conflicts) hold. The
 * enumeration is deterministic: selections come back in a canonical order so reproducible callers/tests can
 * rely on it. UNSAT ⇒ an `enumerated` result with an EMPTY list; a solver error or timeout ⇒
 * `did-not-converge` (never a throw, never a hang).
 *
 * Two implementations justify this interface:
 *   (1) `enumerateSelections` over clingo-wasm (engine/solve/src/asp/clingo.ts) — whose node and browser
 *       `RunAsp` providers (app/mcp/src/clingo-node.ts, app/web/src/clingo.ts) already exercise the same
 *       `SelectionProblem` → `Selection[]` contract through two independent WASM wirings;
 * (2) a future in-house series-parallel enumerator (exploited-structure).
 */
export interface Enumerate {
  (req: EnumerateRequest): Promise<EnumerateResult>;
}
