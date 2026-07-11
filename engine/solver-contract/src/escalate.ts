// @feature Honest solver escalation
// @story The tool never dead-ends while it owns the answer: when the fast native solver declines a
//   budget-coupling trade-off, the SAME request reruns on the exact reference MIP, hard-time-bounded,
//   and the answer is labelled with the engine that produced it — never a silent fallback.
// @surfaces mcp (search tools via app/mcp/src/search.ts + app/mcp/src/composition.ts), vscode
//   (app/vscode/src/solver-host.ts), user wording in app/mcp/src/messages.ts
// @algorithms engine/solver-contract/src/native/search.ts (the decliner),
//   engine/solve/src/minizinc/search.ts (the reference MIP it escalates to)
// @docs docs/design/solver-contract.html
// @e2e app/mcp/src/cqrs-escalation.e2e.test.ts
// @status shipped

// HONEST ESCALATION — the rule that the tool never dead-ends while it OWNS the answer (docs/design/
// solver-contract.html §3.2; owner ruling 2026-07-04). The native in-process solver is EXACT on its monotone
// class and, outside it, declines HONESTLY (a value, never a lie — TASK-86 F1). But for ONE declined class —
// `budget-coupling`, a budget-style ceiling binding against the objective — we already SHIP the exact optimizer
// that resolves it: the incumbent MIP (the reference solver of record). Dead-ending there ("set the knobs
// manually") while owning that solver is bad design. So the surface ESCALATES: on exactly that class, it reruns
// the SAME request on the reference MIP, hard-time-bounded, and returns ITS answer LABELLED — never a silent
// fallback (the engine that answered always rides the result).
//
// This module is pure control-flow vocabulary — it knows nothing about system design and imports only ./honesty
// (dependency.test.ts (A)/(C)). It carries the GATE (which decline class escalates) and the time-bound; the shells
// (MCP/VS Code/web) supply how to RESOLVE the reference MIP for their runtime and how to RENDER the label.

import { didNotConverge, type SearchResult } from './honesty';

/** Which solver produced a search answer — the honest-escalation label. `native` = the in-process monotone
 *  solver; `reference-mip` = the exact incumbent MIP, consulted only when the native solver declines the
 *  escalatable class. Rides every escalated result so a consumer (and the human/agent) sees WHO answered. */
export type SearchEngine = 'native' | 'reference-mip';

/** The user-facing BASIS phrase for a reference-MIP answer (the one-form basis discipline: measured / exact /
 *  estimate). The reference MIP is the exact optimizer of record, so its answer is `exact` — shared here so every
 *  shell labels an escalated result with the SAME words. */
export const REFERENCE_MIP_BASIS = 'exact (reference MIP)';

/** The default hard time bound for a single escalated reference-MIP solve (solver-time-bounded discipline: a tool
 *  that can hang is poison for an AI flow). The incumbent MIP is itself internally time-bounded (~10 s); this outer
 *  race is the backstop — generous enough to let an exact solve finish, bounded so the surface always returns.
 *  (On a node shell the incumbent solves SYNCHRONOUSLY under its own process timeout, which is the real bound
 *  there; this race is the guarantee for the asynchronous browser WASM path.) */
export const ESCALATION_TIMEOUT_MS = 30_000;

/**
 * Whether a search result is the ESCALATABLE decline — the `budget-coupling` class and ONLY it (a joint knob
 * trade-off outside the monotone class that the exact reference MIP resolves). Gated on the machine `code`, never
 * the prose, so no OTHER decline (a point-band coupling, a saturation, a genuinely non-steady design, a budget the
 * explainer cannot place, a timeout, a cancellation) is ever escalated by accident — the reason-class gate.
 */
export function isBudgetCouplingDecline(r: SearchResult<unknown>): boolean {
  return r.kind === 'did-not-converge' && r.code === 'budget-coupling';
}

/**
 * The outcome of an escalation attempt, carrying WHICH engine answered so the surface labels it honestly:
 *  - `native`      — the native answer STANDS (it did not hit the escalatable class); `result` is the native one.
 *  - `escalated`   — the reference MIP was consulted and ANSWERED; `result` is ITS answer (a solve, a proven
 *                    infeasible, or — if even the MIP could not within the bound — a reference did-not-converge).
 *  - `unavailable` — the escalatable class WAS hit but this install ships no reference MIP (a shell with no MIP
 *                    binary); `result` is the native decline, to be shown with the loosen-the-ceiling guidance.
 */
export type Escalation<T> =
  | { readonly via: 'native'; readonly result: SearchResult<T> }
  | { readonly via: 'escalated'; readonly result: SearchResult<T> }
  | { readonly via: 'unavailable'; readonly result: SearchResult<T> };

/**
 * HONEST ESCALATION — never a silent fallback. Given a native search `result` and a way to run the SAME request on
 * the reference MIP, escalate EXACTLY the budget-coupling class: run the MIP under a hard time bound and return ITS
 * answer as `escalated`; every other native outcome passes through untouched as `native`. `runReference` resolves
 * the MIP LAZILY and returns `undefined` when this install ships no MIP — so a browser only fetches the WASM on
 * escalation, and a node install without a binary stays on the honest native decline (`unavailable`). A reference
 * solve that throws or exceeds the bound settles as a reference `did-not-converge` (still `escalated`: the MIP WAS
 * consulted, and the caller then shows the loosen-the-ceiling guidance).
 */
export async function withBudgetEscalation<T>(
  result: SearchResult<T>,
  runReference: (signal: AbortSignal) => Promise<SearchResult<T> | undefined>,
  timeoutMs: number = ESCALATION_TIMEOUT_MS,
): Promise<Escalation<T>> {
  if (!isBudgetCouplingDecline(result)) return { via: 'native', result };
  const controller = new AbortController();
  const ref = await withHardBound(runReference, controller, timeoutMs);
  if (ref === undefined) return { via: 'unavailable', result }; // no reference MIP here — the native decline stands
  return { via: 'escalated', result: ref };
}

/** Race the reference solve against the hard bound: on timeout, ABORT (best-effort) and settle as an honest
 *  reference `did-not-converge`; a throw settles the same way (the search never throws across the seam). Returns
 *  `undefined` only when the reference itself reports "no MIP installed" (resolved before the bound — the probe is
 *  cheap). First settle wins, so a late reference result after a timeout is discarded (Cancellable §best-effort). */
function withHardBound<T>(
  run: (signal: AbortSignal) => Promise<SearchResult<T> | undefined>,
  controller: AbortController,
  ms: number,
): Promise<SearchResult<T> | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: SearchResult<T> | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(didNotConverge);
    }, ms);
    run(controller.signal).then(finish, () => finish(didNotConverge));
  });
}
