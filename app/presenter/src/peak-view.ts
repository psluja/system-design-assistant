import type { NodePeak } from '@sda/content';

// WORST-CASE PER-NODE LOAD (owner ruling: a peak is just traffic in a given environment + config). A node is judged
// and shown against the WORST load its declared environment produces: with a shaped generator, its worst-window ρ
// from the Tier-1 sweep; with no shape, its steady ρ (byte-identical to today). There is ONE reading everywhere —
// the canvas ρ chip (rate-row.ts → flow-nodes RateMeter), the Inspector verdict (the canonical verdict list) and
// the System 'Load per tier · ρ' rows — and a violation is a violation, with NO 'peak' vocabulary, NO '@HH:MM'
// instant and NO dual 'steady vs peak' pair. This module folds the two into the single worst-case ρ every surface
// shows; whether that ρ SATURATES (≥1 ⇒ unbounded queue) is the one truth the shared verdict list also carries.
//
// SACRED PIN (load-stages §9): a design with NO shaped generator produces no sweep ⇒ no per-node peak ⇒ every caller
// passes `peak === undefined` ⇒ `worstCaseRho` returns the steady ρ unchanged ⇒ every surface is byte-identical.

/**
 * The node's worst-case ρ over its declared environment: the larger of its steady ρ and its worst-window (shaped) ρ
 * — the load that decides whether the tier breaks. `steadyRho` is undefined for a capacity-less node (a source, a
 * pure-delay hop); its steady baseline is then 0, so a self-originating generator the sweep found saturates still
 * surfaces. `peak` undefined (no shape) ⇒ the steady ρ returned UNCHANGED (byte-identical — the sacred pin).
 * Returns undefined only when the node has neither a steady ρ nor a peak (nothing to show). Pure, deterministic.
 */
export function worstCaseRho(steadyRho: number | undefined, peak: NodePeak | undefined): number | undefined {
  const hasSteady = steadyRho !== undefined && Number.isFinite(steadyRho);
  const hasPeak = peak !== undefined && Number.isFinite(peak.rho);
  if (!hasSteady && !hasPeak) return undefined;
  const base = hasSteady ? (steadyRho as number) : 0;
  return hasPeak ? Math.max(base, (peak as NodePeak).rho) : base;
}

/**
 * The node's worst-case required units over its declared environment: the larger of its steady requiredUnits and its
 * worst-window (shaped) requiredUnits — the task count the tier's generation scaled to at the highest point. The peer
 * of {@link worstCaseRho} for the '⊞ tasks' chip, so ρ and the task count describe the SAME worst window (both are
 * monotone in that window's load). `steadyUnits` is the node's steady `requiredUnits` (undefined for a node with no
 * sizing relation); `peak.requiredUnits` is the sweep's worst-window value (undefined when the shape declares none).
 *
 * SACRED PIN: with no usable peak (no shaped generator, or a peak carrying no units) the STEADY value is returned
 * VERBATIM — including undefined / non-finite — so the chip is byte-identical to today. (Unlike `worstCaseRho`, whose
 * steady input is always a finite queue ρ, the steady requiredUnits can be non-finite for a pathological config; the
 * verbatim passthrough guarantees byte-identity there rather than reshaping a value no peak is folding into.)
 */
export function worstCaseUnits(steadyUnits: number | undefined, peak: NodePeak | undefined): number | undefined {
  const peakUnits = peak?.requiredUnits;
  if (peakUnits === undefined || !Number.isFinite(peakUnits)) return steadyUnits; // no shape ⇒ steady UNCHANGED (pin)
  const base = steadyUnits !== undefined && Number.isFinite(steadyUnits) ? steadyUnits : 0;
  return Math.max(base, peakUnits);
}
