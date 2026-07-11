// @algorithm AABB insert-overlap predicate (the "Tidy?" offer)
// @problem After a picker-driven insert, the shell must decide — instantly and without false
//   positives on deliberately abutting nodes — whether the new node landed on top of an existing one.
// @approach Strict axis-aligned bounding-box intersection (interior area on BOTH axes; touching
//   edges are a zero-width seam, not a collision) scanned over all placed boxes.
// @complexity O(n) over placed nodes per insert; O(1) per pair.
// @citations AABB intersection folklore (separating-axis degenerate case).
// @invariants Pure geometry (no React/DOM), shared verbatim by both shells; a node never collides
//   with itself; absent id answers false honestly.
// @where-tested app/web/src/overlap.test.ts

// The "Tidy?" offer predicate (TASK-71): after a picker-driven insert, does the NEW node's bounding box intersect
// any OTHER node's box? If so, the shell offers a non-blocking "Tidy" toast (it never auto-reflows — no surprise
// layout changes). Pure geometry, no React/DOM, so it is unit-tested directly and SHARED by both shells (the web
// popup insert and the VS Code native-pick insert both call it). Touching edges do NOT count as an overlap — two
// nodes flush against each other are a legal, deliberate layout, not a collision.

/** An axis-aligned box in flow (canvas) coordinates: top-left corner + size. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The layout fallback footprint when a node has not been measured yet (matches the tidy layout's NODE_W/NODE_H
 *  fallbacks — a fresh insert has no measured size on the very first frame). */
export const FALLBACK_NODE: { readonly w: number; readonly h: number } = { w: 160, h: 170 };

/**
 * Two boxes OVERLAP iff they share interior area — a strict intersection on BOTH axes. Edges that merely touch
 * (`a.right === b.left`) share a zero-width seam, not area, so they return false: abutting nodes are a valid
 * deliberate layout, and we must not nag the user to tidy them.
 */
export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Does the box `newId` collide with any OTHER box in `boxes`? This is the whole predicate behind the "Tidy?"
 * offer: true ⇒ the just-inserted node landed on top of an existing one, so a reflow would help. A node never
 * collides with itself, and an absent `newId` (nothing was actually inserted) is honestly `false`.
 */
export function insertOverlaps(boxes: Readonly<Record<string, Box>>, newId: string): boolean {
  const target = boxes[newId];
  if (target === undefined) return false;
  for (const [id, box] of Object.entries(boxes)) {
    if (id === newId) continue;
    if (boxesOverlap(target, box)) return true;
  }
  return false;
}
