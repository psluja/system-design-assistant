import { Key, belowFloor, exceedsCeiling, type Band, type Status } from '@sda/engine-core';
import { keys } from '../vocabulary/registry';
import { systemSummary, type ValueFn } from './system';

// @feature System promise (whole-design cost ceiling)
// @story Promise a ceiling for the WHOLE system — the entire monthly bill, off-path branches
//   included — get a system-scoped verdict, and have optimize/repair hold the same total as a
//   whole-design budget.
// @surfaces mcp (set_slo with scope:"system", app/mcp/src/tools.ts; constrains search via
//   app/mcp/src/search.ts), vscode (sda.setSystemRequirement,
//   app/vscode/src/system-requirements.ts), web (System panel rows via
//   app/presenter/src/summary.ts)
// @algorithms content/sda/src/analysis/system.ts, engine/solver-contract/src/native/search.ts,
//   engine/solve/src/minizinc/search.ts (Objective.total — one sum shared by verdict and search)
// @docs none (owner ruling 2026-07; judged against the same total the search reads)
// @e2e app/mcp/src/system-promise-cqrs.e2e.test.ts, content/sda/src/analysis/system.e2e.test.ts
// @status shipped

// SYSTEM-SCOPED PROMISES (owner ruling, 2026-07: "cost is for THE WHOLE SYSTEM"). A promise whose quantity is
// GLOBAL to the design — the whole monthly bill, not one branch's accumulated cost — cannot ride a node band
// (`Instance.bands` is node-keyed; a terminal's cumulative cost cell sums only the paths INTO that node, so an
// off-path branch like a cache is invisible to it). It is therefore its own additive top-level container on the
// project document (`ProjectDoc.systemPromises`, the lagSlos discipline): plain data `{ key, band }`, keyed by the
// registry key it bounds, ONE promise per key (replace-in-place). Absent ⇒ the whole feature is silent (no-filler).
//
// THE ONE TRUTH (the anti-drift rule). A system-cost promise is judged against Σ over every node of its OWN cost
// contribution — `systemSummary(...).totalCostUsdMonth`, the sum of `localContribution(value, …, keys.cost)`. That
// is the SAME whole-graph total the backward search reads: `Objective.total` sums the `local:<node>:cost` cells
// (engine/solve/src/minizinc/search.ts; native/search.ts `objectiveCellsOf`), and the system-band CONSTRAINT the
// search enforces is the same Σ of local cost cells. One sum, three consumers (verdict, objective, constraint) —
// so the promise the human reads, the number the doc prints and the ceiling the solver holds can never disagree.
// (`egressCost` is a SEPARATE registry key with its own sum; it is outside the `cost` promise, exactly as it is
// outside the `cost` objective.)
//
// GENERIC CONTAINER, NARROW v1 VOCABULARY. The container carries any `{ key, band }` (the growth axis: a future
// system-scoped quantity adds a key, not a schema); the JUDGE covers the v1 vocabulary (`cost`). A declared promise
// on a key the judge does not cover reads an honest `unknown` naming the covered set — declared intent is never
// silently dropped (the tool must not lie).

/** A SYSTEM-scoped promise: a band on a whole-design quantity (v1: `cost` — the monthly bill of every component,
 *  off-path branches included). Plain data `{ key, band }` so it round-trips in the project doc; `key` is the
 *  registry key id as a string (the serialized form every other doc container uses). */
export interface SystemPromise {
  readonly key: string;
  readonly band: Band;
}

/** The system-scoped promise vocabulary v1: the keys a system promise can bound TODAY (judged + solver-enforced).
 *  `cost` — the whole-design monthly total (Σ every node's own cost). The single source every surface (web picker,
 *  VS Code QuickPick, MCP `set_slo {scope:"system"}`) validates against, so the guided errors agree. */
export const SYSTEM_PROMISE_KEYS: readonly string[] = [String(keys.cost)];

/** Is `key` a system-scoped promise key (v1: cost)? The shared gate for pickers and guided errors. */
export function isSystemPromiseKey(key: string): boolean {
  return SYSTEM_PROMISE_KEYS.includes(key);
}

/** Does a design declare ANY system promise? (The no-filler gate — with none, the whole feature stays silent.) */
export function hasSystemPromises(promises: readonly SystemPromise[] | undefined): boolean {
  return promises !== undefined && promises.length > 0;
}

/** Build the whole-system COST promise for a validated ceiling (USD/month): `cost ≤ maxUsdMonth`, as a plain
 *  minTargetMax band. The ONE band-construction both shells and the MCP tool share (whole-cost form), so a promise
 *  declared anywhere is byte-identical in the document. */
export function costPromise(maxUsdMonth: number): SystemPromise {
  return { key: String(keys.cost), band: { shape: 'minTargetMax', max: maxUsdMonth } };
}

/** A computed verdict for one declared SYSTEM promise — scope-labelled `'system'` so no surface can mistake it for
 *  a node/flow verdict. `computed` is the whole-design total (undefined ⇒ unknown); `status` is judged with the
 *  SHARED band tolerances (`exceedsCeiling`/`belowFloor` — float noise at the bound is AT it, a real miss fails). */
export interface SystemPromiseVerdict {
  readonly key: string;
  readonly band: Band;
  readonly scope: 'system';
  /** The whole-design computed total (v1 cost: USD/month) — undefined when the design does not evaluate. */
  readonly computed?: number;
  readonly unit?: string;
  readonly status: Status;
  /** A one-line, computed explanation of the verdict / of what would resolve an `unknown` (honest, never a guess). */
  readonly note: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** minTargetMax status with the SHARED boundary tolerances: above `max` or below `min` is a violation; below
 *  `target` a warning; else ok — the same grammar every scalar band verdict speaks (`verdict.ts statusForRate`). */
function bandStatus(v: number, band: Extract<Band, { shape: 'minTargetMax' }>): Status {
  if (band.max !== undefined && exceedsCeiling(v, band.max)) return 'violation';
  if (band.min !== undefined && belowFloor(v, band.min)) return 'violation';
  if (band.target !== undefined && belowFloor(v, band.target)) return 'warning';
  return 'ok';
}

type Inst = { readonly id: string; readonly type?: string };
type WireLike = { readonly from: readonly [string, string]; readonly to: readonly [string, string] };

/**
 * Judge every declared SYSTEM promise against the solved design and produce a {@link SystemPromiseVerdict} each.
 * THE SINGLE SHARED COMPUTATION (the lagVerdicts discipline) — MCP `evaluate`, the web System panel, the VS Code
 * summary, the worlds matrix and the generated document all call THIS, so the human and the AI can never read
 * different system verdicts. The judged total for `cost` is `systemSummary(...).totalCostUsdMonth` — Σ of every
 * node's OWN cost, the exact sum `Objective.total` optimizes and the solver's system band constrains (one truth).
 *
 * @param instances the document instances (id + type — the systemSummary inputs).
 * @param wires     the document wires.
 * @param value     the engine's solved value lookup, or null when the design has build errors (⇒ honest unknown).
 * @param promises  the declared system promises.
 */
export function systemPromiseVerdicts(
  instances: readonly Inst[],
  wires: readonly WireLike[],
  value: ValueFn | null,
  promises: readonly SystemPromise[],
): SystemPromiseVerdict[] {
  const out: SystemPromiseVerdict[] = [];
  for (const p of promises) {
    const base = { key: p.key, band: p.band, scope: 'system' as const };
    if (!isSystemPromiseKey(p.key)) {
      // Declared intent on a key outside the v1 vocabulary — honest unknown naming the covered set, never a drop.
      out.push({ ...base, status: 'unknown', note: `"${p.key}" is not a system-scoped quantity this version judges — covered: [${SYSTEM_PROMISE_KEYS.join(', ')}]` });
      continue;
    }
    if (value === null) {
      out.push({ ...base, status: 'unknown', note: 'the design has build errors — fix them so the whole-system total can be computed' });
      continue;
    }
    if (p.band.shape !== 'minTargetMax') {
      out.push({ ...base, status: 'unknown', note: `a system ${p.key} promise is a scalar floor/ceiling (minTargetMax) — a ${p.band.shape} band is not judged here` });
      continue;
    }
    // v1: cost — the whole-design monthly total, Σ of every node's own contribution (the Objective.total sum).
    const computed = systemSummary(instances, wires, value).totalCostUsdMonth;
    const status = bandStatus(computed, p.band);
    const bound = p.band.max !== undefined ? `≤ ${p.band.max}` : p.band.min !== undefined ? `≥ ${p.band.min}` : `target ${p.band.target ?? '—'}`;
    out.push({
      ...base,
      computed,
      unit: 'USD/month',
      status,
      note:
        status === 'violation'
          ? `the whole system costs ${round2(computed)} USD/month — outside the promised ${bound} (every component summed, off-path branches included)`
          : `the whole system costs ${round2(computed)} USD/month, within the promised ${bound}`,
    });
  }
  return out;
}

/** A whole-graph SUM band for the backward search: bound Σ over every node of its LOCAL `key` contribution — the
 *  system-scoped twin of a node band, structurally identical to the solver contract's `SystemBand` (the RequestClass
 *  redeclaration pattern, so content never imports a solver package). */
export interface SystemBandSpec {
  readonly key: Key;
  readonly floor?: number;
  readonly ceiling?: number;
}

/**
 * Lower the declared system promises to the backward search's SUM-band constraints — the seam every search entry
 * point (MCP repair/optimize, web + VS Code Improve) calls, so a declared system ceiling binds the SAME solve
 * everywhere. Only judgeable v1 promises lower (a scalar minTargetMax on a covered key); everything else is a
 * verdict-layer concern (`systemPromiseVerdicts` reads it `unknown`), never a silent constraint.
 */
export function systemBandsOf(promises: readonly SystemPromise[] | undefined): SystemBandSpec[] {
  const out: SystemBandSpec[] = [];
  for (const p of promises ?? []) {
    if (!isSystemPromiseKey(p.key) || p.band.shape !== 'minTargetMax') continue;
    if (p.band.min === undefined && p.band.max === undefined) continue; // target-only: a warning line, not a hard constraint
    out.push({
      key: Key(p.key),
      ...(p.band.min !== undefined ? { floor: p.band.min } : {}),
      ...(p.band.max !== undefined ? { ceiling: p.band.max } : {}),
    });
  }
  return out;
}
