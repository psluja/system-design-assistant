import { describe, expect, it } from 'vitest';
import { MinHeap } from './heap';

describe('MinHeap (future-event set)', () => {
  it('pops items in non-decreasing order regardless of push order', () => {
    const heap = new MinHeap<number>((a, b) => a < b);
    const input = [5, 1, 9, 3, 3, 7, 0, 2, 8, 4, 6];
    for (const x of input) heap.push(x);
    const out: number[] = [];
    for (;;) {
      const x = heap.pop();
      if (x === undefined) break;
      out.push(x);
    }
    expect(out).toEqual([...input].sort((a, b) => a - b));
    expect(heap.size).toBe(0);
  });

  it('breaks time ties by a sequence field (total order ⇒ deterministic pops)', () => {
    const heap = new MinHeap<{ t: number; seq: number }>((a, b) => a.t < b.t || (a.t === b.t && a.seq < b.seq));
    heap.push({ t: 1, seq: 2 });
    heap.push({ t: 1, seq: 0 });
    heap.push({ t: 1, seq: 1 });
    expect(heap.pop()?.seq).toBe(0);
    expect(heap.pop()?.seq).toBe(1);
    expect(heap.pop()?.seq).toBe(2);
  });
});
