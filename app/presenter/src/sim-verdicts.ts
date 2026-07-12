import { NodeId, type Graph, type Key, type Registry, type Verdict } from '@sda/engine-core';
import { keys, checkGoodputBands } from '@sda/content';
import { checkTailBands, type TailProvider } from '@sda/engine-solve';
import type { SimTail } from './summary';

// THE SINGLE SEAM for DES-FED verdicts. The scalar forward pass cannot judge
// anything about TIME — a percentile (p99) latency SLO, and the goodput/error-rate of a retrying path, both read
// `unknown` on it. The discrete-event simulation answers them. Wiring that answer into the ONE verdict list every
// surface reads was DUPLICATED, byte-for-byte, in both shells' `verds` memos (web app.tsx + vscode App.tsx): each
// built a TailProvider from the sim tail, called `checkTailBands`, and merged. This module is that wiring, ONCE —
// so the web System panel, the VS Code Problems panel and the MCP `simulate` verdicts can never disagree, and a
// new DES-fed verdict family (goodput here) is added in a SINGLE place and both shells get it for free.
//
// Why here and not folded into content's `realAwareVerdicts`: that function is the SCALAR-INDEPENDENT correction
// (queueing-aware latency, ρ≥1 saturation) that runs on EVERY canvas edit with no simulation in hand. The DES-fed
// verdicts are a different pass — they exist only once a sim result lands. Keeping them separate keeps the scalar
// path sim-free (fast, deterministic) and groups the two time-domain twins (tail + goodput) together where the
// sim payload lives. Pure: no clock/DOM/state — just the graph, the registry and the sim's plain numbers.

/** Compose the DES-fed verdicts and MERGE them into the base (real-aware) list. With `sim === null` (no run yet)
 *  the base is returned unchanged: the tail / goodput bands keep the `unknown` the scalar pass left them, never a
 *  guess. When the sim ran, any tail or goodput verdict it can answer REPLACES the matching base entry (same
 *  scope+key), so the surface shows the measured ok/violation instead of `unknown`.
 *
 *  @param base   the real-aware verdict list (run `realAwareVerdicts` first).
 *  @param graph  the compiled engine graph the verdicts are scoped against.
 *  @param registry the property registry (units for the tail verdicts).
 *  @param sim    the background DES outcome, or null before the first run. */
export function simVerdicts(base: readonly Verdict[], graph: Graph, registry: Registry, sim: SimTail | null): Verdict[] {
  if (!sim) return [...base];

  // LATENCY SEMANTICS v2 (doc §4) — the sink-gate fix (R2's flagged gap): a percentile (p99) SLO is judged against
  // the node's OWN response tail, from the same run, on ANY node — not only a flow terminal. This is the DES twin of
  // the scalar `responseLatency` and matches what MCP `simulate` already does, so the human and the AI can never read
  // a different tail verdict. Before v2 the sink gate meant a non-terminal tailLatency band stayed `unknown`; now the
  // per-node reservoir answers it. A node with no recorded response (NaN) ⇒ undefined ⇒ the band keeps its honest
  // `unknown` — never a fabricated number. With no per-node data at all (an old sim payload) every tail reads
  // `unknown` too, which is the honest fallback.
  const respByNode = new Map((sim.nodeResponse ?? []).map((n) => [n.id, n]));
  const tail: TailProvider = (node: NodeId, key: Key, q: number) => {
    if (String(key) !== String(keys.tailLatency)) return undefined;
    const r = respByNode.get(String(node));
    if (r === undefined) return undefined;
    const p = Math.abs(q - 0.99) < 1e-9 ? r.p99 : Math.abs(q - 0.95) < 1e-9 ? r.p95 : Math.abs(q - 0.5) < 1e-9 ? r.p50 : undefined;
    return p !== undefined && Number.isFinite(p) ? p : undefined; // NaN (no recorded response) ⇒ honest `unknown`
  };

  // Both DES-fed families: percentile (tail) latency + retry-feedback outcome (goodput / error rate). The goodput
  // bands need the raw outcome; when the sim carries no retry story its goodput/errorRate are the pre-retry world
  // (goodput = served, errorRate 0), so a plain goodput SLO still verifies honestly.
  const outcome = sim.goodputRps !== undefined && sim.errorRate !== undefined ? { goodputRps: sim.goodputRps, errorRate: sim.errorRate } : undefined;
  const fed = [...checkTailBands(graph, registry, tail), ...checkGoodputBands(graph, outcome)];
  if (fed.length === 0) return [...base];

  // A DES-fed verdict REPLACES the scalar-pass entry for the same scope+key (which was `unknown`) — otherwise the
  // surface would show both the stale `unknown` and the measured verdict for one SLO.
  const replaced = new Set(fed.map((v) => `${String(v.scope)}:${String(v.key)}`));
  return [...base.filter((v) => !replaced.has(`${String(v.scope)}:${String(v.key)}`)), ...fed];
}
