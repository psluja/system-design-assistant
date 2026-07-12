import { describe, it, expect, vi } from 'vitest';
import type { LayoutDesign } from './layout-model';
import { optimizeLayout, type OptimizeResult } from './layout-optimize';
import {
  type PolishJob,
  type PolishPhase,
  type PolishScheduler,
  createPolisher,
  synchronousSchedule,
  toLayoutDesign,
} from './layout-polish';

// The resting-handshake controller — the shell-agnostic logic both shells drive. These
// pin the CONTRACT the shells depend on: the doc→design projection, the phase machine, latest-wins supersession
// (a fresh edit orphans a stale search), idle=zero, and seeded determinism — all without a DOM, by injecting a
// scheduler exactly as the web HUD injects requestAnimationFrame.

// A small chain a→b→c with a fan-out at b — enough for the search to actually improve on Tidy.
const DESIGN: LayoutDesign = {
  nodes: [
    { id: 'a', type: 'client.web' },
    { id: 'b', type: 'compute.service' },
    { id: 'c', type: 'db.postgres' },
    { id: 'd', type: 'storage.object' },
  ],
  wires: [
    { from: ['a', 'o'], to: ['b', 'i'] },
    { from: ['b', 'o'], to: ['c', 'i'] },
    { from: ['b', 'o'], to: ['d', 'i'] },
  ],
  groups: [],
};

describe('toLayoutDesign — project → structural design', () => {
  it('carries the id/type, the origin rate (assumedRps), the wire semantics, the groups and measured sizes', () => {
    const d = toLayoutDesign(
      {
        instances: [
          { id: 'src', type: 'client.web', config: { assumedRps: 1200 } },
          { id: 'svc', type: 'compute.service' },
        ],
        wires: [{ from: ['src', 'o'], to: ['svc', 'i'], semantics: 'async' }],
        groups: [{ id: 'g1', members: ['svc'] }],
      },
      { svc: { w: 200, h: 140 } },
    );
    expect(d.nodes.find((n) => n.id === 'src')!.originRate).toBe(1200);
    expect(d.nodes.find((n) => n.id === 'src')!.size).toBeUndefined(); // no measured size supplied for src
    expect(d.nodes.find((n) => n.id === 'svc')!.size).toEqual({ w: 200, h: 140 });
    expect(d.wires[0]!.semantics).toBe('async');
    expect(d.groups[0]).toEqual({ id: 'g1', members: ['svc'] });
  });

  it('threads the CATALOG ports by type onto each node (R5) — the layout anchors at rendered handles, never at wire-derived fractions', () => {
    const catalogPorts = {
      'compute.service': [
        { name: 'in', dir: 'in' as const },
        { name: 'db', dir: 'out' as const },
        { name: 'out', dir: 'out' as const },
        { name: 'cache', dir: 'out' as const },
      ],
    };
    const d = toLayoutDesign(
      {
        instances: [
          { id: 'api', type: 'compute.service' },
          { id: 'mystery', type: 'custom.unknown' }, // no catalog entry — the wire-derived fallback stays honest
        ],
        wires: [{ from: ['api', 'db'], to: ['mystery', 'in'] }],
        groups: [],
      },
      undefined,
      catalogPorts,
    );
    // The manifest list rides the node VERBATIM, order kept (order is identity — no reorder in v1).
    expect(d.nodes.find((n) => n.id === 'api')!.ports).toEqual(catalogPorts['compute.service']);
    expect(d.nodes.find((n) => n.id === 'mystery')!.ports).toBeUndefined();
  });
});

describe('createPolisher — the handshake reaches rest', () => {
  it('runs the search to done and applies a layout at least as good as Tidy (the floor)', () => {
    const phases: PolishPhase[] = [];
    let applied: OptimizeResult | null = null;
    const p = createPolisher({ onPhase: (ph) => phases.push(ph), onDone: (r) => (applied = r) }, synchronousSchedule);
    expect(p.phase).toBe('idle');
    p.request({ design: DESIGN, options: { seed: 1, iterations: 20, budgetMs: 100000 } });
    expect(phases).toEqual(['polishing', 'done']); // idle is the initial (unemitted) phase
    expect(p.phase).toBe('done');
    expect(applied).not.toBeNull();
    const r = applied as unknown as OptimizeResult;
    expect(r.score.feasible).toBe(true);
    expect(r.score.quality).toBeGreaterThanOrEqual(r.tidy.score.quality - 1e-9);
  });

  it('is seeded-deterministic: the polisher applies the same placement optimizeLayout computes for the same job', () => {
    const job: PolishJob = { design: DESIGN, options: { seed: 3, iterations: 25, budgetMs: 100000 } };
    let applied: OptimizeResult | null = null;
    createPolisher({ onDone: (r) => (applied = r) }, synchronousSchedule).request(job);
    const direct = optimizeLayout(job.design, job.options);
    expect(JSON.stringify((applied as unknown as OptimizeResult).placement)).toEqual(JSON.stringify(direct.placement));
  });
});

/** A scheduler that never runs on its own — it captures each step so a test can drive (or NOT drive) it by hand,
 *  and interleave a superseding request mid-flight. Mirrors the rAF driver's contract without any timer. */
function manualScheduler(): { schedule: PolishScheduler; steps: (() => boolean)[]; cancels: number } {
  const steps: (() => boolean)[] = [];
  const state = { cancels: 0 };
  const schedule: PolishScheduler = (step) => {
    steps.push(step);
    return () => {
      state.cancels++;
    };
  };
  return {
    schedule,
    steps,
    get cancels() {
      return state.cancels;
    },
  };
}

describe('createPolisher — latest-wins (a fresh request supersedes an in-flight search)', () => {
  it('orphans the earlier search: its step becomes a no-op and only the latest request applies', () => {
    const m = manualScheduler();
    const onDone = vi.fn<(result: OptimizeResult) => void>();
    const p = createPolisher({ onDone }, m.schedule);

    p.request({ design: DESIGN, options: { seed: 1, iterations: 40, budgetMs: 100000 } }); // step[0]
    p.request({ design: DESIGN, options: { seed: 2, iterations: 40, budgetMs: 100000 } }); // supersedes → step[1]

    expect(m.cancels).toBeGreaterThanOrEqual(1); // the first schedule was cancelled when the second arrived
    // Driving the SUPERSEDED step must do nothing and never apply.
    expect(m.steps[0]!()).toBe(false);
    expect(onDone).not.toHaveBeenCalled();
    // Driving the LATEST step to completion applies exactly once, with the seed-2 result.
    while (m.steps[1]!()) {
      /* drain */
    }
    expect(onDone).toHaveBeenCalledTimes(1);
    const applied = onDone.mock.calls[0]![0];
    const expected = optimizeLayout(DESIGN, { seed: 2, iterations: 40, budgetMs: 100000 });
    expect(JSON.stringify(applied.placement)).toEqual(JSON.stringify(expected.placement));
  });
});

describe('createPolisher — idle = zero (cancel abandons the in-flight search)', () => {
  it('returns to idle and never applies after cancel', () => {
    const m = manualScheduler();
    const onDone = vi.fn<(result: OptimizeResult) => void>();
    const phases: PolishPhase[] = [];
    const p = createPolisher({ onDone, onPhase: (ph) => phases.push(ph) }, m.schedule);
    p.request({ design: DESIGN, options: { seed: 1, iterations: 40, budgetMs: 100000 } });
    expect(p.phase).toBe('polishing');
    p.cancel();
    expect(p.phase).toBe('idle');
    expect(m.cancels).toBeGreaterThanOrEqual(1);
    // Even if a stray step fires after cancel, it must be a no-op (the epoch moved).
    expect(m.steps[0]!()).toBe(false);
    expect(onDone).not.toHaveBeenCalled();
    expect(phases).toEqual(['polishing', 'idle']);
  });
});
