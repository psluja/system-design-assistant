import { describe, expect, it } from 'vitest';
import { synchronousSchedule, type Pos, type Size } from '@sda/presenter';
import { runHostCommand, type HostCommandHandlers } from './host-commands';
import { startIdealLayout } from './ideal-layout';

// The webview side of the `{type:'cmd'}` channel: the routing table is TOTAL (every protocol verb reaches exactly
// its handler — no verb can arrive and silently do nothing), and the deliberate `idealLayout` protocol evolution
// triggers the REAL ✨ orchestration (ideal-layout.ts) — the palette command lays nodes out, it does not lecture.
// The geometry itself (measured anchors, pins, determinism) is proven by ideal-layout.test.ts; here we prove the
// COMMAND VERB is wired to that pipeline the same way App.tsx wires it (request in, move batches out).

const VERBS = ['tidy', 'fitView', 'addGroup', 'generateDesignDoc', 'idealLayout'] as const;

/** Fresh spy handlers counting each verb's calls — the full Record, so the table stays compile-total here too. */
function spies(): { handlers: HostCommandHandlers; calls: Record<(typeof VERBS)[number], number> } {
  const calls = { tidy: 0, fitView: 0, addGroup: 0, generateDesignDoc: 0, idealLayout: 0 };
  const handlers: HostCommandHandlers = {
    tidy: () => { calls.tidy += 1; },
    fitView: () => { calls.fitView += 1; },
    addGroup: () => { calls.addGroup += 1; },
    generateDesignDoc: () => { calls.generateDesignDoc += 1; },
    idealLayout: () => { calls.idealLayout += 1; },
  };
  return { handlers, calls };
}

describe('runHostCommand — the total host→canvas dispatch', () => {
  it('routes every protocol verb to exactly its handler (and nothing else)', () => {
    for (const verb of VERBS) {
      const { handlers, calls } = spies();
      runHostCommand(verb, handlers);
      for (const other of VERBS) {
        expect(calls[other], `'${verb}' fires only its own handler ('${other}' checked)`).toBe(other === verb ? 1 : 0);
      }
    }
  });

  it("the 'idealLayout' verb drives the REAL ✨ orchestration — nodes move, exactly the toolbar button path", () => {
    // The unequal-height chain from ideal-layout.test.ts, wired to the verb the way App.tsx wires it: the handler
    // starts the pipeline with MEASURED sizes and applies its Studio-batch move commands. One dispatched verb must
    // yield at least the floor batch and a changed layout — the signpost era (command → toast, no movement) is dead.
    const instances = [
      { id: 'a', type: 'svc.a' },
      { id: 'b', type: 'svc.b' },
      { id: 'c', type: 'svc.c' },
    ];
    const wires = [
      { from: ['a', 'out'] as const, to: ['b', 'in'] as const },
      { from: ['b', 'out'] as const, to: ['c', 'in'] as const },
    ];
    const sizes: Record<string, Size> = { a: { w: 160, h: 80 }, b: { w: 160, h: 140 }, c: { w: 160, h: 100 } };
    const initial: Record<string, Pos> = { a: { x: 0, y: 0 }, b: { x: 40, y: 300 }, c: { x: 80, y: 600 } };
    const layout: Record<string, Pos> = { ...initial };
    let batches = 0;

    const { handlers } = spies();
    runHostCommand('idealLayout', {
      ...handlers,
      idealLayout: () =>
        void startIdealLayout(
          { instances, wires, groups: [], layout: initial, sizes, handMoved: new Set() },
          {
            schedule: synchronousSchedule,
            apply: (_stage, cmds) => {
              batches += 1;
              for (const c of cmds) if (c.kind === 'move') layout[c.id] = { x: c.x, y: c.y };
            },
            fitView: () => {},
            currentLayout: () => layout,
          },
        ),
    });

    expect(batches, 'the verb ran the pipeline (at least the floor batch applied)').toBeGreaterThanOrEqual(1);
    expect(layout, 'the layout actually changed — the command runs the sparkle').not.toEqual(initial);
  });
});
