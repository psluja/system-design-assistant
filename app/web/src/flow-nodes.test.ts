import { describe, expect, it } from 'vitest';
import { portAnchorOffset, portOffsetKey } from '@sda/presenter';
import { handleTop } from './flow-nodes';

// THE HANDLE POSITION (R5, the port slide) — `handleTop` is the ONE resolution both shells render a handle (and
// its label and its "+" slot) through: the ASSIGNED offset in px when the slide set one, else the manifest
// fraction in %. The VS Code webview renders via the `@web/flow-nodes` alias, so this logic-level test covers the
// renderer of BOTH shells. The differential that matters: the renderer must resolve a port to the SAME row the
// router anchors its wire at (`portAnchorOffset` — one home, drift impossible).

describe('handleTop — assigned offset ?? fraction, one resolution for both shells', () => {
  it('no offsets ⇒ the manifest fraction (i+1)/(n+1) as a percentage (Tidy alone keeps fractions)', () => {
    expect(handleTop(undefined, 'out', 'db', 0, 3)).toBe('25%');
    expect(handleTop(undefined, 'out', 'out', 1, 3)).toBe('50%');
    expect(handleTop(undefined, 'in', 'in', 0, 1)).toBe('50%');
  });

  it('an assigned offset wins, in px — and only for its own side:port key', () => {
    const offsets = { [portOffsetKey('out', 'db')]: 29.7 };
    expect(handleTop(offsets, 'out', 'db', 0, 3)).toBe('29.7px');
    expect(handleTop(offsets, 'out', 'cache', 2, 3)).toBe('75%'); // unassigned key falls back
    expect(handleTop(offsets, 'in', 'db', 0, 1)).toBe('50%'); // same name, other side — its own key
  });

  it('DIFFERENTIAL: the rendered handle centre equals the router anchor row for every resolution', () => {
    // Handle/label CSS is translateY(-50%), so `top: X` centres the handle at X — which must be exactly the
    // anchor `portAnchorOffset` gives the router. Checked with and without an assigned offset.
    const ports = [
      { name: 'in', dir: 'in' as const },
      { name: 'db', dir: 'out' as const },
      { name: 'out', dir: 'out' as const },
      { name: 'cache', dir: 'out' as const },
    ];
    const h = 118.8;
    // fractions: handle at 25% of h ⇔ router anchor at h × 1/4
    expect((parseFloat(handleTop(undefined, 'out', 'db', 0, 3)) / 100) * h).toBeCloseTo(portAnchorOffset(ports, 'out', 'db', h), 9);
    // assigned: handle at 42px ⇔ router anchor at 42
    const offsets = { [portOffsetKey('out', 'db')]: 42 };
    expect(parseFloat(handleTop(offsets, 'out', 'db', 0, 3))).toBe(portAnchorOffset(ports, 'out', 'db', h, offsets));
  });
});
