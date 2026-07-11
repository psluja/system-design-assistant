// @algorithm Binary min-heap (future-event set)
// @problem The discrete-event simulator must always process the earliest pending event next, with
//   deterministic ordering, from a set that grows and shrinks on every step.
// @approach Classic array-backed binary min-heap (sift-up on push, sift-down on pop) over a
//   caller-supplied total order.
// @complexity O(log n) push/pop, O(1) peek/size, O(n) space, for n pending events.
// @citations Williams 1964 (heapsort's heap); standard priority-queue folklore, e.g. CLRS ch. 6.
// @invariants Heap order: every parent is `less`-or-equal to its children; `less` must be a TOTAL
//   order (event time, then a monotonic sequence tie-break) so popping is deterministic regardless
//   of insertion order (doc-4 §3c).
// @where-tested engine/sim/src/heap.test.ts, engine/sim/src/des.test.ts (drives the event loop)

/**
 * A binary min-heap — the discrete-event future-event set. `less` must impose a TOTAL order (event
 * time, then a monotonic sequence tie-break) so popping is deterministic regardless of insertion
 * order (doc-4 §3c).
 */
export class MinHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly less: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.items.length;
  }

  push(x: T): void {
    const items = this.items;
    items.push(x);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(items[i] as T, items[parent] as T)) break;
      [items[i], items[parent]] = [items[parent] as T, items[i] as T];
      i = parent;
    }
  }

  pop(): T | undefined {
    const items = this.items;
    const n = items.length;
    if (n === 0) return undefined;
    const top = items[0] as T;
    const last = items.pop() as T;
    if (n > 1) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < items.length && this.less(items[l] as T, items[smallest] as T)) smallest = l;
        if (r < items.length && this.less(items[r] as T, items[smallest] as T)) smallest = r;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest] as T, items[i] as T];
        i = smallest;
      }
    }
    return top;
  }
}
