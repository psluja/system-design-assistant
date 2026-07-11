import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// One global, styled tooltip. Any element with a `data-tip="…"` attribute gets a rich hover description —
// rendered into a portal at <body> (position: fixed), so it NEVER clips inside the scrolling inspector or
// the canvas. No per-element wiring beyond the attribute; positions itself below the element, flips above
// when near the bottom, and clamps to the viewport.

interface Tip {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly above: boolean;
}

const WIDTH = 280;

export function Tooltip(): JSX.Element | null {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    const closestTip = (n: EventTarget | null): HTMLElement | null =>
      n instanceof Element ? (n.closest('[data-tip]') as HTMLElement | null) : null;

    const onOver = (e: MouseEvent): void => {
      const el = closestTip(e.target);
      const text = el?.getAttribute('data-tip');
      if (!el || !text) {
        setTip(null);
        return;
      }
      const r = el.getBoundingClientRect();
      const above = r.bottom > window.innerHeight - 150;
      setTip({
        text,
        x: Math.min(Math.max(10, r.left), window.innerWidth - WIDTH - 10),
        y: above ? r.top - 8 : r.bottom + 8,
        above,
      });
    };
    const onOut = (e: MouseEvent): void => {
      if (closestTip(e.target) && closestTip(e.relatedTarget) !== closestTip(e.target)) setTip(null);
    };

    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    window.addEventListener('scroll', () => setTip(null), true);
    return () => {
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
    };
  }, []);

  if (tip === null) return null;
  return createPortal(
    <div className="tip-box" style={{ left: tip.x, top: tip.y, maxWidth: WIDTH, transform: tip.above ? 'translateY(-100%)' : 'none' }}>
      {tip.text}
    </div>,
    document.body,
  );
}
