import type { Group } from '@sda/core';

// @algorithm Tidy layered auto-layout (Sugiyama recipe)
// @problem Give any design an instant, readable left-to-right layout — the floor every ideal-layout
//   stage seeds from and may never ship worse than — with zero dependencies and zero randomness.
// @approach The Sugiyama pipeline specialized for presentation: columns by longest-path depth from
//   the sources; rows within a column ordered by the barycenter of upstream neighbors (crossing
//   reduction) then vertically centered per lane; groups become stacked horizontal lanes sharing one
//   column grid; measured node sizes drive spacing.
// @complexity O(V * E) worst-case for longest-path layering (cycle-guarded relaxation); O(V log V)
//   per-column barycenter sort.
// @citations Sugiyama, Tagawa & Toda, "Methods for Visual Understanding of Hierarchical System
//   Structures", IEEE SMC 11(2), 1981.
// @invariants Pure view geometry, deterministic; every shell tidies identically (one shared
//   function); tall measured nodes never overlap within a column.
// @where-tested app/presenter/src/presenter.test.ts, app/presenter/src/layout-semantic.test.ts,
//   app/presenter/src/layout-benchmark.test.ts (as the floor of every search run)

// Auto-layout ("Tidy"): a dependency-free LAYERED layout (the Sugiyama recipe) tuned for presentation:
//   • columns = longest-path depth from the sources, so the request flow reads left→right and every tier
//     is ALIGNED to its column across the whole diagram;
//   • rows within a column are ordered by the BARYCENTER of their upstream neighbours (edge-crossing
//     reduction), then vertically CENTERED within the lane;
//   • spacing is generous and uses the nodes' MEASURED sizes when provided (the canvas knows them), so tall
//     nodes (meters + chips) never overlap;
//   • groups become stacked horizontal lanes (logical tiers) with the same column grid across lanes.
// Pure view geometry, no React. Lives in the presenter so EVERY shell tidies a diagram identically (the web
// canvas HUD and the VS Code webview call the SAME function) — moved verbatim from app/web/src/layout.ts.

export type Pos = { readonly x: number; readonly y: number };
export type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
export type Size = { readonly w: number; readonly h: number };

const COL0 = 60; // left margin
const COLW = 340; // column pitch (node 160 + a generous gutter for the orthogonal edges)
const VGAP = 56; // vertical gap between stacked nodes in one column
const LANE_GAP = 64; // gap between group lanes
const LABEL_PAD = 52; // room for the group label above the first row
const BOT_PAD = 26;
const PAD_X = 26;
const NODE_W = 160; // canvas node width (fixed by CSS)
const NODE_H = 170; // fallback height when no measured size is supplied

export function tidyLayout(
  instances: ReadonlyArray<{ readonly id: string }>,
  wires: ReadonlyArray<{ readonly from: readonly [string, string]; readonly to: readonly [string, string] }>,
  groups: ReadonlyArray<Group>,
  sizes?: Readonly<Record<string, Size>>,
): { pos: Record<string, Pos>; rects: Record<string, Rect> } {
  const ids = instances.map((i) => i.id);
  const idset = new Set(ids);
  const hOf = (id: string): number => sizes?.[id]?.h ?? NODE_H;

  // 1 — layer (column) assignment: longest path from the sources, capped to guard against cycles.
  const layer: Record<string, number> = {};
  for (const id of ids) layer[id] = 0;
  const es = wires.filter((w) => idset.has(w.from[0]) && idset.has(w.to[0]) && w.from[0] !== w.to[0]);
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const w of es) {
      const nl = (layer[w.from[0]] ?? 0) + 1;
      if (nl > (layer[w.to[0]] ?? 0)) { layer[w.to[0]] = nl; changed = true; }
    }
    if (!changed) break;
  }

  // upstream adjacency for the barycenter ordering
  const ups: Record<string, string[]> = {};
  for (const w of es) (ups[w.to[0]] ??= []).push(w.from[0]);

  // 2 — lanes: one per group (in declaration order), then one for the ungrouped rest.
  const memberGid: Record<string, string> = {};
  for (const g of groups) for (const m of g.members) if (idset.has(m)) memberGid[m] = g.id;
  const lanes: Array<{ gid: string | null; members: string[] }> = [];
  for (const g of groups) { const ms = g.members.filter((m) => idset.has(m)); if (ms.length > 0) lanes.push({ gid: g.id, members: ms }); }
  const ungrouped = ids.filter((id) => memberGid[id] === undefined);
  if (ungrouped.length > 0) lanes.push({ gid: null, members: ungrouped });

  const pos: Record<string, Pos> = {};
  const rects: Record<string, Rect> = {};
  let laneTop = 30;
  for (const lane of lanes) {
    // columns within this lane
    const byLayer = new Map<number, string[]>();
    let minL = Infinity, maxL = 0;
    for (const m of lane.members) {
      const L = layer[m] ?? 0;
      (byLayer.get(L) ?? byLayer.set(L, []).get(L))?.push(m);
      minL = Math.min(minL, L); maxL = Math.max(maxL, L);
    }
    const cols = [...byLayer.keys()].sort((a, b) => a - b);

    // 3 — barycenter ordering (two left→right sweeps): order each column's rows by the average row index of
    // their upstream neighbours in the PREVIOUS columns, so fan-outs land next to their source (fewer crossings).
    const rowIndex: Record<string, number> = {};
    for (const L of cols) (byLayer.get(L) ?? []).forEach((m, i) => { rowIndex[m] = i; });
    for (let sweep = 0; sweep < 2; sweep++) {
      for (const L of cols) {
        const arr = byLayer.get(L) ?? [];
        const bary = (m: string): number => {
          const us = (ups[m] ?? []).filter((u) => lane.members.includes(u));
          if (us.length === 0) return rowIndex[m] ?? 0; // keep current position when nothing constrains it
          return us.reduce((s, u) => s + (rowIndex[u] ?? 0), 0) / us.length;
        };
        arr.sort((a, b) => bary(a) - bary(b) || a.localeCompare(b));
        arr.forEach((m, i) => { rowIndex[m] = i; });
      }
    }

    // 4 — place: stack each column with real heights + VGAP, then CENTER it on the lane's tallest column.
    const colHeights = new Map<number, number>();
    for (const L of cols) {
      const arr = byLayer.get(L) ?? [];
      colHeights.set(L, arr.reduce((s, m) => s + hOf(m), 0) + Math.max(0, arr.length - 1) * VGAP);
    }
    const laneContentH = Math.max(...cols.map((L) => colHeights.get(L) ?? 0), NODE_H);
    for (const L of cols) {
      const arr = byLayer.get(L) ?? [];
      let y = laneTop + LABEL_PAD + (laneContentH - (colHeights.get(L) ?? 0)) / 2; // vertical centering
      for (const m of arr) {
        pos[m] = { x: COL0 + L * COLW, y };
        y += hOf(m) + VGAP;
      }
    }
    const laneH = LABEL_PAD + laneContentH + BOT_PAD;
    if (lane.gid !== null) rects[lane.gid] = { x: COL0 + minL * COLW - PAD_X, y: laneTop, w: (maxL - minL) * COLW + NODE_W + 2 * PAD_X, h: laneH };
    laneTop += laneH + LANE_GAP;
  }
  return { pos, rects };
}
