import { applyTransform, type Key, type Transform } from '@sda/engine-core';
import type { Instance, Manifest, Wire } from '@sda/content';
import { fmt } from './format';

// The SHARED edge-rate view-model: for every wire, the TRUE carried rate and any transform pills to draw on it.
// Both shells (web canvas, VS Code webview) render THESE verbatim, so the number on a wire can never drift between
// them — and, per the anti-drift rule, the rate is computed with the ENGINE's own
// `applyTransform` (imported, never re-implemented), seeded from the ENGINE's solved throughput. The presenter does
// no domain arithmetic of its own: it reads the solver's served value and pushes it through the solver's function.
//
// Honesty: a wire whose source has NO solved throughput (no declared traffic origin) gets `rate: undefined` — the
// pill then shows the FUNCTION only (e.g. "×100"), never a fabricated number. The tool must not lie about a rate it
// cannot know (doc §3, last grammar row).

// The engine's flow key — the single quantity port transforms act on (registry marks it `flow: true`). Kept as a
// bare string literal (its stable id) so the presenter needs no runtime import of the content registry for it.
const THROUGHPUT = 'throughput' as unknown as Key;

/** How a transform reads at a glance — drives the pill's COLOUR so the shape of the system is legible without
 *  reading numbers (doc §3): amber = amplification (k>1), teal = reduction (k<1), gray = a ceiling, prob = a
 *  dashed split. Purely presentational; the engine stays agnostic. */
export type TransformTone = 'amp' | 'reduce' | 'cap' | 'prob' | 'gen';

/** Where an OUT-side transform was RESOLVED FROM — so a UI can mark provenance
 *  ("this wire" vs the shared "port default"): `wire` = the per-wire override, `instance` = the instance port
 *  override, `manifest` = the manifest port default. Always `wire` for an IN-side pill only when the in-port itself
 *  is instance/manifest sourced — IN-side has no wire level (consumption shape is per-port), so it is never `wire`. */
export type TransformSource = 'wire' | 'instance' | 'manifest';

/** One persistent pill to render on an edge: the transform, its resulting rate (undefined ⇒ no traffic origin,
 *  show the function only), which END of the wire it sits on, and its tone. */
export interface EdgePill {
  readonly transform: Transform;
  /** The rate LEAVING this side of the wire after the transform, or undefined when the source has no solved flow. */
  readonly rate: number | undefined;
  /** 'out' = the source out-port's emission shaping (drawn mid-edge); 'in' = the target in-port's consumption
   *  shaping (drawn near the target end, doc §3). */
  readonly side: 'out' | 'in';
  readonly tone: TransformTone;
  /** The compact, honest label the pill shows, e.g. "×100 → 100k/s" (with a rate) or "÷100" (without). */
  readonly label: string;
  /** Which resolution level this transform came from (see {@link TransformSource}) — lets a UI mark a per-wire
   *  routing split distinctly from a shared port default (the pill on the wire says whether editing it edits THE
   *  WIRE or the PORT). */
  readonly source: TransformSource;
}

/** The edge-rate model for ONE wire: its true carried rate (for the identity-edge hover pill) plus 0..2 transform
 *  pills (an out-side and/or an in-side one). A pure-identity edge has an empty `pills` array and a `carried` rate. */
export interface EdgeRate {
  /** Index of the wire in `doc.wires` — the shells key their edges by `w${i}`, so this addresses the same edge. */
  readonly wire: number;
  readonly from: readonly [string, string];
  readonly to: readonly [string, string];
  /** The exact rate this wire delivers to its target (after both ends' transforms), or undefined with no origin.
   *  Shown on HOVER for identity edges (which carry no persistent pill) so the quiet default stays inspectable. */
  readonly carried: number | undefined;
  /** The persistent pills to draw: the non-identity transforms on this wire (0, 1 for one side, or 2 for both). */
  readonly pills: readonly EdgePill[];
}

/** Everything `edgeRates` needs — the document's instances + wires, the engine's solved value reader (null when the
 *  design has build errors), and the merged catalog (built-ins + project components) so a port's manifest transform
 *  default is resolvable. Instance override beats manifest default, exactly as `instantiate` resolves it. */
export interface EdgeRatesInput {
  readonly instances: readonly Instance[];
  readonly wires: readonly Wire[];
  readonly catalog: Readonly<Record<string, Manifest>>;
  /** The engine's solved value accessor (string id → key → number), or null when the design failed to build. */
  readonly value: ((id: string, key: Key) => number | undefined) | null;
}

/** Resolve a port's effective transform for an instance: the per-instance override WINS over the manifest port's
 *  default, and a port with neither is identity (undefined). Mirrors `instantiate`'s `overrides[name] ?? p.transform`
 *  — the single resolution rule, so the label matches the solved graph. */
export function resolvePortTransform(inst: Instance | undefined, man: Manifest | undefined, port: string): Transform | undefined {
  if (inst === undefined || man === undefined) return undefined;
  const override = inst.transforms?.[port];
  if (override !== undefined) return override;
  return man.ports.find((p) => p.name === port)?.transform;
}

/** Resolve the OUT-side transform of ONE wire with its full precedence:
 *  WIRE override > instance out-port override > manifest out-port default > identity — the SAME order the engine
 *  seam applies (`edge.transform ?? from.transform`, and `from.transform` is `instantiate`'s port resolution). The
 *  returned `source` marks which level won, so the pill can distinguish a per-wire routing split from a shared port
 *  default. `undefined` transform ⇒ identity (a quiet edge). */
export function resolveWireOutTransform(
  wire: Wire,
  srcInst: Instance | undefined,
  srcMan: Manifest | undefined,
  srcPort: string,
): { readonly transform: Transform | undefined; readonly source: TransformSource } {
  if (wire.transform !== undefined) return { transform: wire.transform, source: 'wire' };
  const instOverride = srcInst?.transforms?.[srcPort];
  if (instOverride !== undefined) return { transform: instOverride, source: 'instance' };
  return { transform: srcMan?.ports.find((p) => p.name === srcPort)?.transform, source: 'manifest' };
}

/** The tone a transform reads as (see {@link TransformTone}). `ratio(k)`/`batch(n)` split by whether they amplify
 *  or reduce; `cap`/`window` are ceilings; `prob` is its own dashed split. */
function toneOf(t: Transform): TransformTone {
  switch (t.kind) {
    case 'prob':
      return 'prob';
    case 'cap':
    case 'window':
      return 'cap';
    case 'batch':
      return 'reduce'; // out = x / n, always a reduction (n > 0)
    case 'ratio':
      return t.value >= 1 ? 'amp' : 'reduce';
    case 'generate':
      return 'gen'; // an ORIGIN, not a reshaping — its own tone
  }
}

/** A compact rate for a pill: reuse the shared `fmt` but abbreviate thousands (100,000 → 100k, 2,500,000 → 2.5M) so
 *  the pill stays short on the wire. Small values keep `fmt`'s ≤2-decimal form. `undefined` ⇒ '—' (never faked). */
function compactRate(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '—';
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '−∞';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(n / 1_000)}k`;
  return fmt(n);
}
/** Drop a trailing ".0" so 100.0k reads as 100k, but keep one decimal of real precision (2.5k, 1.2M). */
const trim = (n: number): string => {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : String(r);
};

/** The operator glyph a transform announces with — the SHAPE the architect scans for (× amplify, ÷ batch, cap,
 *  window, p split). Chosen to read like the doc's grammar examples (×100 → 100k/s · ÷100 → 10/s · cap 500/s). */
function opLabel(t: Transform, rate: number | undefined): string {
  const arrow = rate === undefined ? '' : ` → ${compactRate(rate)}/s`;
  switch (t.kind) {
    case 'ratio':
      return `×${trim(t.value)}${arrow}`;
    case 'batch':
      return `÷${trim(t.value)}${arrow}`;
    case 'cap':
      return `cap ${compactRate(t.value)}/s`;
    case 'window':
      return `window ${trim(t.value)}ms`;
    case 'prob':
      return `p=${trim(t.value)}${arrow}`;
    case 'generate':
      // A generator pill: the baseline level it originates, plus the emitted rate when known. The cycles (if any)
      // are an editor/inspector affordance (load-stages R4), not a wire glyph.
      return `⚡${compactRate(t.level)}/s${arrow}`;
  }
}

/**
 * Build the per-wire edge-rate model. For each wire from [srcNode, srcPort] to [dstNode, dstPort]:
 *   • the source's SERVED throughput `s = value(srcNode, throughput)` is what its out-port emits (the solver's own
 *     served value, capacity-capped — exactly the seed the engine uses at the edge-contribution seam);
 *   • the OUT-side rate is `applyTransform(f_out, s)` — the engine's arithmetic, imported not re-derived;
 *   • the IN-side rate is `applyTransform(f_in, out-side rate)` — the target in-port's consumption shaping on THIS
 *     wire's contribution (the engine applies f_in to the port's whole fan-in; per single wire this is its share);
 *   • `carried` (the hover figure) is the in-side rate (or the out-side rate if the target port is identity).
 * A side with no transform contributes no pill (identity edges stay quiet, doc §3). With no solved value the rates
 * are undefined and pills show the function only — never a fabricated number.
 */
export function edgeRates(input: EdgeRatesInput): EdgeRate[] {
  const { instances, wires, catalog, value } = input;
  const instById = new Map<string, Instance>(instances.map((i) => [i.id, i]));
  const manifestFor = (id: string): Manifest | undefined => {
    const inst = instById.get(id);
    return inst ? catalog[inst.type] : undefined;
  };

  return wires.map((w, wire): EdgeRate => {
    const [srcNode, srcPort] = w.from;
    const [dstNode, dstPort] = w.to;
    // OUT-side resolution includes the per-WIRE override (wire > instance port > manifest port), tracking WHICH
    // level won so the pill can mark provenance; the IN-side stays PORT-level (consumption shape is the receiver's).
    const { transform: fOut, source: fOutSource } = resolveWireOutTransform(w, instById.get(srcNode), manifestFor(srcNode), srcPort);
    const fInInstance = instById.get(dstNode)?.transforms?.[dstPort] !== undefined;
    const fIn = resolvePortTransform(instById.get(dstNode), manifestFor(dstNode), dstPort);

    // The source's served throughput seeds the edge. `undefined` (no origin / build error) ⇒ every downstream rate
    // is unknown, and the pills below fall back to the function-only label — the tool must not invent a rate.
    const served = value ? value(srcNode, THROUGHPUT) : undefined;
    const outRate = served === undefined ? undefined : applyTransform(fOut, served);
    const inRate = outRate === undefined ? undefined : applyTransform(fIn, outRate);

    const pills: EdgePill[] = [];
    if (fOut !== undefined) pills.push({ transform: fOut, rate: outRate, side: 'out', tone: toneOf(fOut), label: opLabel(fOut, outRate), source: fOutSource });
    if (fIn !== undefined) pills.push({ transform: fIn, rate: inRate, side: 'in', tone: toneOf(fIn), label: opLabel(fIn, inRate), source: fInInstance ? 'instance' : 'manifest' });

    // The exact rate the wire ultimately delivers to its target — after both ends. Shown on hover for a quiet
    // identity edge; for a transformed edge the pill already carries the number, but `carried` stays available.
    const carried = inRate;
    return { wire, from: w.from, to: w.to, carried, pills };
  });
}
