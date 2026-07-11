import { describe, expect, it } from 'vitest';
import { rateRow } from './rate-row';

// RPS — ONE FORM. A source, a pure-delay hop and a capacity-limited tier must all yield the SAME kind of row (the
// shell then renders one family: a rate, plus the ρ fill only where there is a finite ceiling). This pins the
// projection so a node can never render its rate two different ways across the two shells.
describe('rateRow — the ONE-FORM rps row', () => {
  it('a capacity-bearing tier yields the ρ meter (offered + finite capacity + rho, no separate tone)', () => {
    const r = rateRow({ offered: 800, capacity: 1000, rho: 0.8 }, 800, 'ok');
    expect(r).toEqual({ offered: 800, capacity: 1000, rho: 0.8 });
    expect(r?.tone).toBeUndefined(); // metered ⇒ the % + fill carry the tone, not the number
  });

  it('a source (no queue) yields the rate-only row from its declared throughput, verdict-toned', () => {
    const r = rateRow(undefined, 5000, 'ok');
    expect(r).toEqual({ offered: 5000, tone: 'ok' });
    expect(r?.capacity).toBeUndefined();
    expect(r?.rho).toBeUndefined();
  });

  it('a pure-delay tier (queue present but INFINITE capacity) is capacity-less too — rate only, no fill', () => {
    const r = rateRow({ offered: 300, capacity: Infinity, rho: 0 }, 300, 'ok');
    expect(r).toEqual({ offered: 300, tone: 'ok' }); // no capacity/rho ⇒ the shell draws the same row minus the fill
  });

  it('a zero/negative capacity falls back to capacity-less (never a divide-by-zero meter)', () => {
    expect(rateRow({ offered: 10, capacity: 0, rho: 0 }, 10, 'ok')).toEqual({ offered: 10, tone: 'ok' });
  });

  it('tone follows the verdict status for a capacity-less rate (violation ⇒ bad, warning ⇒ warn, else ok)', () => {
    expect(rateRow(undefined, 5000, 'violation')?.tone).toBe('bad');
    expect(rateRow(undefined, 5000, 'warning')?.tone).toBe('warn');
    expect(rateRow(undefined, 5000, undefined)?.tone).toBe('ok');
  });

  it('no queue AND no throughput ⇒ no rate row at all (a node with nothing to show)', () => {
    expect(rateRow(undefined, undefined, 'ok')).toBeUndefined();
  });

  it('the capacity tier reads its rate from the QUEUE (real offered load), not the declared throughput', () => {
    const r = rateRow({ offered: 1200, capacity: 1000, rho: 1.2 }, 999, 'violation');
    expect(r).toEqual({ offered: 1200, capacity: 1000, rho: 1.2 });
  });

  // WORST-CASE LOAD (owner ruling: a peak is just traffic in a given environment): the optional 4th `peak` arg is the
  // node's worst-window ρ from the Tier-1 sweep. The row shows the WORST-CASE ρ (the larger of steady and worst-window)
  // as a SINGLE number — no separate 'peak' key, no '@HH:MM'. Whether it saturates is the truth the verdict list carries.
  it('SACRED PIN: with no peak arg the row is byte-identical to today (no `peak` key)', () => {
    expect(rateRow({ offered: 800, capacity: 1000, rho: 0.8 }, 800, 'ok', undefined)).toEqual({ offered: 800, capacity: 1000, rho: 0.8 });
    expect(rateRow(undefined, 5000, 'ok', undefined)).toEqual({ offered: 5000, tone: 'ok' });
  });

  it('a metered tier calm at the mean but SATURATED at its worst window reads the worst-case ρ (offered = ρ × capacity)', () => {
    const cap = 1000, worst = 1.41;
    const r = rateRow({ offered: 400, capacity: cap, rho: 0.4 }, 400, 'ok', { rho: worst, atS: 61_200 });
    expect(r).toEqual({ offered: worst * cap, capacity: cap, rho: worst });
    expect('peak' in (r as object)).toBe(false); // one worst-case number — no 'peak' key, no '@HH:MM'
  });

  it('a worst window no worse than the steady baseline leaves the row byte-identical (the steady offered is kept exactly)', () => {
    const r = rateRow({ offered: 800, capacity: 1000, rho: 0.8 }, 800, 'ok', { rho: 0.6, atS: 100 });
    expect(r).toEqual({ offered: 800, capacity: 1000, rho: 0.8 });
  });

  it('a capacity-LESS origin carries NO peak on the rate-only row — its saturation rides the shared verdict status', () => {
    const r = rateRow(undefined, 400, 'ok', { rho: 1.3, atS: 64_800 });
    expect(r).toEqual({ offered: 400, tone: 'ok' }); // no peak key; the verdict list flags the self-origin saturation
  });
});
