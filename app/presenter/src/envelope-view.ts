import type { EnvelopeResult, OriginEnvelope } from '@sda/content';
import { fmt } from './format';
import type { SummaryRow, SummarySection } from './summary';

// THE ENVELOPE AS THE DEFAULT ANSWER (doc: assumption-model §3) — the ONE composition both shells render for the
// capacity envelope. With NO declared demand the tool still answers: how far each origin can be pushed before an SLO
// breaks, WHAT breaks first, and where the queueing knee sits. This is the guided-emptiness fix (TASK-85): a
// simulated surface that needs demand SAYS SO and names the enabling move, instead of sitting empty-and-mute.
//
// Pure view-model: no shell state, values pre-formatted with the shared `fmt` (∞ / '—' preserved honestly). The web
// renders these rows verbatim (its bespoke System JSX); the VS Code host maps them into the frozen protocol's
// SummaryRow — one composition, zero drift.

/** Everything the envelope block needs: the latest computed envelope (null while the FIRST ambient pass is still in
 *  flight), and whether a pass is currently running (so the block shows an honest "measuring…" instead of blank). */
export interface EnvelopePresentation {
  readonly result: EnvelopeResult | null;
  readonly computing?: boolean;
}

/** The compact headline for one origin's edge (doc §3.2): "holds to 5,000 req/s (first break: kafka) · saturation",
 *  or the band form "holds 2,000–5,000 req/s …" when a floor SLO makes the feasible set a band, or the honest note
 *  when the edge could not be computed. The knee is a design-wide row (below), not repeated per origin. */
function originHeadline(o: OriginEnvelope, labelOf: (id: string) => string): string {
  if (o.maxRps === undefined) return o.note ?? 'edge unknown';
  const band = o.minRps !== undefined ? `handles ${fmt(o.minRps)}–${fmt(o.maxRps)} req/s` : `handles up to ${fmt(o.maxRps)} req/s`;
  const brk = o.firstBreak ? ` — first to break: ${labelOf(o.firstBreak.node)}` : '';
  return `${band}${brk}`;
}

/**
 * Build the "Capacity envelope" System section, or `null` when there is nothing to show yet (no result and not
 * computing). One section rendered identically by both shells:
 *   • no traffic origin ⇒ ONE row carrying the honest reason (which names the enabling move — add a generator on a
 *     node's output port / add a client), so the section is never empty-and-mute;
 *   • otherwise ⇒ one headline row per origin ("holds to X req/s (first break: Y)"), a joint row when several origins
 *     drive the design, the queueing-knee row, and a footer reminding that ABSOLUTE cost/utilisation/confidence need
 *     a declared demand (declare a world) — the two-view split (§3.2) made visible.
 * `labelOf` maps a node id to its friendly label (the shell's own), defaulting to the id.
 */
export function envelopeSection(p: EnvelopePresentation, labelOf: (id: string) => string = (id) => id): SummarySection | null {
  const env = p.result;
  if (env === null) return p.computing ? { title: 'Load limits', rows: [{ label: 'Capacity', value: 'measuring…' }] } : null;

  // No origin ⇒ the guided-emptiness row: WHY there is no envelope, and the move that unlocks it (env.note already
  // names it — NO_ORIGIN_REASON / a build-error explanation). Never a fabricated boundary.
  if (env.perOrigin.length === 0) {
    return { title: 'Load limits', rows: [{ label: 'Capacity', value: env.note ?? "no traffic origin — add a generator on a node's output port (or add a client)" }] };
  }

  const rows: SummaryRow[] = [];
  for (const o of env.perOrigin) rows.push({ label: labelOf(o.node), value: originHeadline(o, labelOf) });
  if (env.joint) {
    const j = env.joint;
    const v =
      j.maxTotalRps === undefined
        ? 'edge unknown'
        : `${j.minTotalRps !== undefined ? `handles ${fmt(j.minTotalRps)}–${fmt(j.maxTotalRps)}` : `handles up to ${fmt(j.maxTotalRps)}`} req/s total${j.firstBreak ? ` — first to break: ${labelOf(j.firstBreak.node)}` : ''}`;
    rows.push({ label: 'All entry points together', value: v });
  }
  if (env.knee) rows.push({ label: 'Latency stays healthy', value: `up to ~${fmt(env.knee.atRps)} req/s (${labelOf(env.knee.node)} reaches ${Math.round(env.knee.utilization * 100)}% load — the tail grows fast past this)`, tone: 'warn' });
  // The honest two-view line (§3.2): these limits are RELATIVE (no demand assumed); an exact bill/utilisation needs a chosen load.
  rows.push({ label: 'For an exact bill', value: 'set a demand scenario above (an exact monthly bill needs a chosen load)' });
  return { title: 'Load limits', rows };
}
