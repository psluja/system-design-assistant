// '✨ Ideal layout' — the webview-side pipeline (doc: ideal-layout §3.6), EXACTLY the web shell's: the canvas's
// MEASURED node footprints feed the SAME shared @sda/presenter search (Tidy floor instantly, background polish,
// apply on rest), and each stage lands through the webview's EXISTING document-edit path — a Studio batch →
// one `docChanged` → one host WorkspaceEdit → ONE native undo step per stage (frozen protocol untouched).
//
// WHY THE WEBVIEW (not the host): layout positions are document data, but the geometry that makes a layout IDEAL
// exists only where nodes are RENDERED. The port-anchor math (R4b/R4c) is height-dependent — anchors sit at
// height × portFraction — so a layout computed from DEFAULT heights aligns anchors that do not exist on the real
// canvas: broken lines and cramped corridors, the exact defect the retired host-side `sda.idealLayout` shipped.
// The web shell has always run ✨ canvas-side for this reason; this module makes the two shells ONE form.
//
// This is the PURE orchestration — no React, no DOM, no message channel — so the webview harness
// (ideal-layout.test.ts) can PROVE the pipeline routes through measured sizes; App.tsx only wires the canvas
// (measured sizes, rAF scheduler, Studio batches, fitView) into the seams below.
import type { Group } from '@sda/core';
import {
  acceptedPortOffsets,
  createPolisher,
  groupRects,
  tidyLayout,
  toLayoutDesign,
  type CatalogPorts,
  type LayoutDesign,
  type LayoutDocView,
  type Placement,
  type PolishPhase,
  type PolishScheduler,
  type Polisher,
  type PortOffsets,
  type Pos,
  type Size,
} from '@sda/presenter';

/** The seed both shells pass (§5.2): same design + same measured sizes ⇒ byte-identical layout. */
export const IDEAL_SEED = 1;
/** The wall-clock safety cap both shells pass (§3.6): the search rests within this budget, keeping best-so-far. */
export const IDEAL_BUDGET_MS = 2500;

/** One layout mutation of a stage — structurally the Studio's own `move` / `resizeGroup` commands, so the shell
 *  hands a stage's commands straight to `studio.dispatchBatch` (ONE undoable document edit per stage). */
export type LayoutCommand =
  | { readonly kind: 'move'; readonly id: string; readonly x: number; readonly y: number }
  | { readonly kind: 'resizeGroup'; readonly id: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number };

/** The two stages the pipeline applies: `floor` — the instant Tidy (the canvas improves at once) — then `polish`
 *  — the searched refinement when the polisher rests (the stage the shell morphs). The web shell's two-step
 *  resting handshake, expressed as a value so the shell renders each stage in its own form. */
export type IdealStage = 'floor' | 'polish';

/** What the pipeline needs at CLICK time: the document view, the stored positions, the canvas's MEASURED node
 *  footprints and the session-drag pins. */
export interface IdealLayoutRequest {
  readonly instances: LayoutDocView['instances'];
  readonly wires: LayoutDocView['wires'];
  readonly groups: readonly Group[];
  /** The stored positions (`doc.layout`) — the pin anchors and the polished-apply diff base. */
  readonly layout: Readonly<Record<string, Pos>>;
  /** The canvas's MEASURED node footprints — the whole point: Tidy, the router and the objective must score the
   *  boxes that actually render, never the defaults. */
  readonly sizes: Readonly<Record<string, Size>>;
  /** The CATALOG port lists by component type (manifest order) — the same reason as `sizes`, at the PORT level
   *  (R5): the layout must anchor at the handles the canvas renders, never at wire-derived fractions (the
   *  multi-out jog). Absent (older callers) ⇒ the wire-derived fallback. */
  readonly catalogPorts?: CatalogPorts;
  /** Nodes the architect dragged THIS session — held as pins (§5.3): the search lays out only around them. */
  readonly handMoved: ReadonlySet<string>;
}

/** The canvas seams the pipeline drives — implemented by App.tsx over the Studio + React Flow. */
export interface IdealLayoutShell {
  /** Apply one stage's commands as ONE undoable unit (`studio.dispatchBatch` → one docChanged → one edit). */
  readonly apply: (stage: IdealStage, cmds: readonly LayoutCommand[]) => void;
  /** Re-fit the viewport after a stage (the shell owns the timing/animation). */
  readonly fitView: (stage: IdealStage) => void;
  /** The FRESH stored positions at polish-apply time — so an unmoved node produces no pointless command. */
  readonly currentLayout: () => Readonly<Record<string, Pos>>;
  /** The ASSIGNED PORT POSITIONS of a stage (R5, the port slide) — VIEW state, not document data: the shell
   *  threads the map to the node renderer's handles and the router's anchors (one home). Fired at BOTH stages
   *  (floor and polish — the sparkle owns the slide); a plain Tidy clears it back to fractions. Optional so a
   *  fraction-only harness stays valid. */
  readonly setPortOffsets?: (offsets: PortOffsets) => void;
  /** Phase transitions for the HUD hint ("✨ Polishing…"). Optional. */
  readonly onPhase?: (phase: PolishPhase) => void;
  /** How the resumable search runs off the critical path (the canvas passes an rAF slicer; tests synchronous). */
  readonly schedule: PolishScheduler;
}

/**
 * Run the '✨ Ideal layout' pipeline: Tidy the FREE nodes instantly (pinned nodes keep their hand position), then
 * polish in the background and apply the better layout when the search rests. Returns the polisher so the CALLER
 * owns latest-wins (it cancels the previous polisher before starting a new one, and on unmount), or null for an
 * empty design (nothing to lay out — honest no-op).
 *
 * No GPU proposer here: the CPU-exact search ships the identical layout (fp32 never decides the applied
 * placement — doc §3.3), so the webview skips the WebGPU seam entirely rather than probing a device it may not have.
 */
export function startIdealLayout(req: IdealLayoutRequest, shell: IdealLayoutShell): Polisher | null {
  if (req.instances.length === 0) return null;
  // CATALOG ports ride the design (R5): every layout stage anchors at the handles the canvas renders, never at
  // wire-derived fractions that mis-place a partially-wired multi-port side (the multi-out jog).
  const design = toLayoutDesign({ instances: req.instances, wires: req.wires, groups: req.groups }, req.sizes, req.catalogPorts);
  const stored = req.layout; // hold hand-placed nodes at exactly where the architect dropped them
  const pins = new Set([...req.handMoved].filter((id) => stored[id] !== undefined));
  // Instant floor: Tidy the FREE nodes (pinned nodes keep their hand position), so the canvas improves at once.
  const { pos, rects } = tidyLayout(req.instances, req.wires, req.groups, req.sizes);
  const floor: LayoutCommand[] = [
    ...Object.entries(pos).filter(([id]) => !pins.has(id)).map(([id, p]) => ({ kind: 'move' as const, id, x: p.x, y: p.y })),
    ...Object.entries(rects).map(([gid, r]) => ({ kind: 'resizeGroup' as const, id: gid, x: r.x, y: r.y, w: r.w, h: r.h })),
  ];
  if (floor.length > 0) shell.apply('floor', floor);
  // The floor's PORT SLIDE (R5): assign offsets on the geometry the floor just applied. A pinned node keeps its
  // hand position — its ports still slide (position is node-level, ports are ours).
  const floorPlacement: Record<string, Pos> = {};
  for (const inst of req.instances) {
    const at = pins.has(inst.id) ? stored[inst.id] : (pos[inst.id] ?? stored[inst.id]);
    if (at !== undefined) floorPlacement[inst.id] = at;
  }
  shell.setPortOffsets?.(acceptedPortOffsets(design, floorPlacement, req.sizes));
  shell.fitView('floor');
  // Background polish: search around the pins; when it rests, apply the refinement (latest-wins is the caller's).
  const polisher = createPolisher(
    { ...(shell.onPhase !== undefined ? { onPhase: shell.onPhase } : {}), onDone: (r) => applyPolished(r.placement, r.portOffsets, design, shell) },
    shell.schedule,
  );
  polisher.request({ design, options: { seed: IDEAL_SEED, sizes: req.sizes, pins, anchors: stored, budgetMs: IDEAL_BUDGET_MS } });
  return polisher;
}

/** Apply the polished placement as ONE batch (moves for what actually moved + the group boxes hugged to the new
 *  member positions) — nothing is applied when the placement did not move anything (no pointless undo step). The
 *  winner's PORT SLIDE always lands (even a box-identical winner may slide ports), through the same seam. */
function applyPolished(placement: Placement, offsets: PortOffsets, design: LayoutDesign, shell: IdealLayoutShell): void {
  shell.setPortOffsets?.(offsets);
  const cur = shell.currentLayout();
  const moved = Object.entries(placement).filter(([id, p]) => {
    const c = cur[id];
    return c === undefined || Math.round(c.x) !== Math.round(p.x) || Math.round(c.y) !== Math.round(p.y);
  });
  if (moved.length === 0) return; // already optimal — the instant Tidy was already the best layout
  const cmds: LayoutCommand[] = [
    ...moved.map(([id, p]) => ({ kind: 'move' as const, id, x: Math.round(p.x), y: Math.round(p.y) })),
    ...groupRects(design, placement).map((g) => ({ kind: 'resizeGroup' as const, id: g.id, x: Math.round(g.rect.x), y: Math.round(g.rect.y), w: Math.round(g.rect.w), h: Math.round(g.rect.h) })),
  ];
  shell.apply('polish', cmds);
  shell.fitView('polish');
}
