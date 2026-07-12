import type { AssumptionScenario, OverrideProvenance, WorldsResult, WorldSummary } from '@sda/content';
import { fmt } from './format';
import type { SummaryRow, SummarySection } from './summary';

// THE WORLDS MATRIX + ACTIVE LENS — the ONE composition both shells render for the
// named-worlds comparison: the base world plus every declared world (the trio + custom), each a row {cost, peak ρ,
// verdict, worst violation}, all from ONE ambient EvaluateBatch. The ACTIVE world is tagged visibly (never a silent
// mix — doc tension #4): its row carries a ● marker and the section title names the lens. Plus the provenance
// rendering the derived trio needs: a `derived` value reads distinctly from a hand-set one (doc §5.3).
//
// Pure view-model: no shell state, values pre-formatted with the shared `fmt`. The web renders these rows verbatim;
// the VS Code host maps them into the frozen protocol's SummaryRow — one composition, zero drift.

/** Everything the worlds block needs: the latest all-world evaluation (null while the FIRST ambient batch is in
 *  flight), which world is the ACTIVE lens (undefined ⇒ the base lens), and whether a batch is currently running. */
export interface WorldsPresentation {
  readonly result: WorldsResult | null;
  readonly active?: string;
  readonly computing?: boolean;
}

/** The first violating verdict of a world, as "node.key" — the worst-violation cell the matrix names, or undefined
 *  when the world is feasible. */
function firstViolation(w: WorldSummary): string | undefined {
  const v = w.verdicts.find((x) => x.status === 'violation');
  return v ? `${v.scope}.${v.key}` : undefined;
}

/** One matrix row for a world: "● Real  $2,140/mo · ρ 0.55 · ok" (active) / "○ Pessimistic  … · 1 violation
 *  (kafka.overflow)". The active world is toned by its own health; an inactive violating world still reads red. */
function worldRow(w: WorldSummary, active: boolean, labelOf: (id: string) => string): SummaryRow {
  const name = w.id === 'base' ? 'base · as authored' : (w.name ?? labelOf(w.id));
  const rho = w.peakRho === undefined ? '—' : fmt(w.peakRho);
  const verdict = w.feasible ? 'ok' : `${w.violations} violation${w.violations === 1 ? '' : 's'}`;
  const worst = w.feasible ? '' : (() => { const c = firstViolation(w); return c ? ` (${c})` : ''; })();
  const stale = w.staleOverrides.length > 0 ? ` · stale skipped: ${w.staleOverrides.join(', ')}` : '';
  const tone: SummaryRow['tone'] = !w.feasible ? 'bad' : active ? 'ok' : undefined;
  return { label: `${active ? '●' : '○'} ${name}`, value: `$${fmt(w.costUsdMonth)}/mo · ρ ${rho} · ${verdict}${worst}${stale}`, ...(tone ? { tone } : {}) };
}

/** The friendly name of the active world (or "base") — the badge/title text every surface tags the lens with, so
 *  the canvas and the System header agree on which world is on screen (doc §7.1). */
export function activeLensLabel(active: string | undefined, scenarios: readonly AssumptionScenario[]): string {
  if (active === undefined) return 'base';
  return scenarios.find((s) => s.id === active)?.name ?? active;
}

/**
 * Build the "Worlds" comparison-matrix System section, or `null` when there is no declared world (only the base —
 * the no-filler rule) and nothing is computing. The section title names the ACTIVE lens; each row is a world with
 * its absolute cost, peak ρ, verdict and worst violation, the active one marked ●. Rendered identically by both
 * shells. `labelOf` maps a world/node id to a friendly label (defaults to the id).
 */
export function worldsMatrix(p: WorldsPresentation, labelOf: (id: string) => string = (id) => id): SummarySection | null {
  const res = p.result;
  if (res === null) return p.computing ? { title: 'Worlds', rows: [{ label: 'Worlds', value: 'evaluating…' }] } : null;
  if (res.worlds.length <= 1) return null; // only the base world ⇒ no named worlds declared (no-filler)
  const activeId = p.active ?? 'base';
  const activeName = res.worlds.find((w) => w.id === activeId)?.name ?? (activeId === 'base' ? 'base' : activeId);
  const rows = res.worlds.map((w) => worldRow(w, w.id === activeId, labelOf));
  return { title: `Worlds · lens: ${activeName}`, rows };
}

/** The full, distinct description of an override's provenance (doc §5.3) — the tooltip/description a shell shows on a
 *  derived value so a reader knows it awaits a measurement. `derived` reads as a live placeholder; `architect` (or a
 *  plain hand-authored override) reads as the architect's own frozen number. */
export function overrideProvenanceLabel(provenance: OverrideProvenance | undefined): string {
  switch (provenance) {
    case 'derived':
      return "derived — from the design's capacity envelope; replace with a measured value";
    case 'architect':
      return 'set by hand — frozen (clear to return it to derived tracking)';
    default:
      return 'set by hand';
  }
}

/** The compact provenance badge (doc §5.3) for a tight cell — `derived` / `frozen` / `manual`. */
export function overrideProvenanceBadge(provenance: OverrideProvenance | undefined): string {
  return provenance === 'derived' ? 'derived' : provenance === 'architect' ? 'frozen' : 'manual';
}
