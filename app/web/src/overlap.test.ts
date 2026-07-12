import { describe, expect, it } from 'vitest';
import { boxesOverlap, insertOverlaps, FALLBACK_NODE, type Box } from './overlap';

// The overlap predicate behind the post-insert "Tidy?" offer. Pure geometry — the whole point is that
// the collision test is decided WITHOUT a canvas, so the offer is deterministic across both shells.

const box = (x: number, y: number, w = 160, h = 170): Box => ({ x, y, w, h });

describe('boxesOverlap', () => {
  it('overlapping boxes (shared interior area) → true', () => {
    expect(boxesOverlap(box(0, 0), box(80, 80))).toBe(true); // corners overlap
    expect(boxesOverlap(box(0, 0), box(10, 10))).toBe(true); // one nearly inside the other
    expect(boxesOverlap(box(50, 50), box(0, 0))).toBe(true); // symmetric
  });

  it('non-overlapping boxes (a clear gap on either axis) → false', () => {
    expect(boxesOverlap(box(0, 0), box(300, 0))).toBe(false); // far to the right
    expect(boxesOverlap(box(0, 0), box(0, 400))).toBe(false); // far below
    expect(boxesOverlap(box(0, 0), box(200, 200))).toBe(false); // diagonal gap
  });

  it('boxes that only TOUCH at an edge do NOT count as overlap (abutting is a valid layout)', () => {
    expect(boxesOverlap(box(0, 0, 160, 170), box(160, 0, 160, 170))).toBe(false); // right edge meets left edge
    expect(boxesOverlap(box(0, 0, 160, 170), box(0, 170, 160, 170))).toBe(false); // bottom edge meets top edge
    expect(boxesOverlap(box(0, 0, 160, 170), box(160, 170, 160, 170))).toBe(false); // corner-to-corner
  });

  it('a one-pixel penetration past a touching edge DOES overlap', () => {
    expect(boxesOverlap(box(0, 0, 160, 170), box(159, 0, 160, 170))).toBe(true);
  });
});

describe('insertOverlaps', () => {
  it('the new node landing on an existing one → true', () => {
    const boxes = { app: box(0, 0), db1: box(40, 40) };
    expect(insertOverlaps(boxes, 'db1')).toBe(true);
  });

  it('the new node placed in a clear spot → false', () => {
    const boxes = { app: box(0, 0), db1: box(400, 0) };
    expect(insertOverlaps(boxes, 'db1')).toBe(false);
  });

  it('a node never collides with itself (a lone insert never nags)', () => {
    expect(insertOverlaps({ only: box(0, 0) }, 'only')).toBe(false);
  });

  it('an unknown new id (nothing was inserted) is honestly false', () => {
    expect(insertOverlaps({ app: box(0, 0) }, 'ghost')).toBe(false);
  });

  it('touching-but-not-overlapping neighbours do not trigger the offer', () => {
    const boxes = { app: box(0, 0, 160, 170), db1: box(160, 0, 160, 170) };
    expect(insertOverlaps(boxes, 'db1')).toBe(false);
  });
});

describe('FALLBACK_NODE', () => {
  it('matches the tidy layout fallback footprint (an unmeasured fresh insert)', () => {
    expect(FALLBACK_NODE).toEqual({ w: 160, h: 170 });
  });
});
