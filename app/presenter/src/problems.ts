import type { Verdict } from '@sda/engine-core';
import { keys } from '@sda/content';

// The PROBLEMS view-model (an IDE-style Error List over the ONE verdict list): every non-ok verdict —
// violations first, then warnings, then unverified (unknown) — plus the structural BUILD errors when the
// graph doesn't compile. Pure projection of already-computed values; the presenter adds NO judgement of its own.
//
// ANTI-DRIFT: this is the single source for BOTH the web Problems table (app.tsx's `problemRows` memo) AND the
// VS Code native Problems panel (the webview's `wireProblems`). Extracting it here means the severity ordering,
// the fix text and the tailLatency hint can never diverge between the two shells — they were literally copied
// once and would otherwise fall out of sync. The web renders the fields into a table; the vscode host composes
// `${label} ${value} — ${fix}` into one message string from these SAME fields.

/** One row of the Problems list — the raw fields both shells render (web columns / vscode message string). */
export interface ProblemRow {
  readonly severity: 'violation' | 'warning' | 'unknown';
  readonly node: string; // node id ('' for whole-design / build errors)
  readonly key: string; // registry key id, or 'build' for a compile error
  readonly value: number; // computed value (NaN for a build-error row — the web renders '—')
  readonly unit: string;
  readonly fix: string | undefined; // the engine's first (highest-ranked) remediation, or a tailLatency hint
}

/**
 * Build the Problems rows for a design. EXACTLY app.tsx's `problemRows` memo:
 *   • every non-ok verdict, sorted violation → warning → unknown, then by node id, then by key id;
 *   • node/key/value/unit read straight off the verdict; `fix` = the first remediation, or — for a p99 tail SLO
 *     the scalar pass cannot see — an honest hint that the simulation answers it;
 *   • BUILD-error rows (severity 'violation', node '', key 'build', value NaN) prepended when the graph does not
 *     compile, one per `evalErrors` string.
 *
 * @param verdicts   the ONE real-aware verdict list every surface reads (already computed by the shell).
 * @param evalOk     whether the design compiled (ev.ok); when false, `evalErrors` become build rows.
 * @param evalErrors the build-error strings (ev.error) — ignored when evalOk is true.
 */
export function problemRows(verdicts: readonly Verdict[], evalOk: boolean, evalErrors: readonly string[]): ProblemRow[] {
  const sev = { violation: 0, warning: 1, unknown: 2 } as const;
  const rows: ProblemRow[] = verdicts
    .filter((v) => v.status !== 'ok')
    .map((v) => ({
      severity: v.status as 'violation' | 'warning' | 'unknown',
      node: String(v.scope),
      key: String(v.key),
      value: v.computed.value,
      unit: v.computed.unit,
      fix: v.remediations[0]?.action ?? (String(v.key) === String(keys.tailLatency) ? 'not visible to the scalar pass — the simulation answers it (runs automatically)' : undefined),
    }))
    .sort((a, b) => sev[a.severity] - sev[b.severity] || a.node.localeCompare(b.node) || a.key.localeCompare(b.key));
  const buildErrors: ProblemRow[] = evalOk ? [] : evalErrors.map((e) => ({ severity: 'violation' as const, node: '', key: 'build', value: NaN, unit: '', fix: e }));
  return [...buildErrors, ...rows];
}

/** The headline PROBLEM COUNT the tab badge / "Fix all (n)" show: violations + warnings (unverified `unknown`
 *  rows are informational, never counted). Derived from `problemRows` — the SAME rule as app.tsx's `problemCount`. */
export function problemCount(rows: readonly ProblemRow[]): number {
  return rows.filter((r) => r.severity !== 'unknown').length;
}
