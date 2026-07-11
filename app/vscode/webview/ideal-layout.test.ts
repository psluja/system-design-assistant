import { describe, expect, it } from 'vitest';
import { MIN_PORT_GAP, portOffsetKey, routeDesignEdges, synchronousSchedule, type PortOffsets, type Pos, type Size } from '@sda/presenter';
import { startIdealLayout, type IdealStage, type LayoutCommand } from './ideal-layout';

// THE MEASURED-SIZES CONTRACT (the root-cause regression guard): the retired HOST-side `sda.idealLayout` computed
// the whole port-centric layout from DEFAULT node heights while the real canvas renders different ones — anchors
// aligned that did not exist, broken lines shipped. This harness drives the webview pipeline EXACTLY as App.tsx
// does (same request/shell seams, synchronous scheduler instead of rAF) and asserts on the geometry that the
// canvas would actually route: measured footprints in, straight wires out.

/** The owner's unequal-height shape: a 3-node chain whose MEASURED heights (80/140/100) all differ from the
 *  default (120) — a layout that ignores the measured sizes cannot make these hops straight. */
const CHAIN = {
  instances: [
    { id: 'a', type: 'svc.a' },
    { id: 'b', type: 'svc.b' },
    { id: 'c', type: 'svc.c' },
  ],
  wires: [
    { from: ['a', 'out'] as const, to: ['b', 'in'] as const },
    { from: ['b', 'out'] as const, to: ['c', 'in'] as const },
  ],
  groups: [],
} as const;
const CHAIN_SIZES: Record<string, Size> = { a: { w: 160, h: 80 }, b: { w: 160, h: 140 }, c: { w: 160, h: 100 } };
/** An arbitrary pre-✨ layout (a stacked column — nothing aligned). */
const CHAIN_LAYOUT: Record<string, Pos> = { a: { x: 0, y: 0 }, b: { x: 40, y: 300 }, c: { x: 80, y: 600 } };

interface AppliedStage {
  readonly stage: IdealStage;
  readonly cmds: readonly LayoutCommand[];
}

/** Drive the pipeline to rest synchronously (the test's scheduler) and record what the canvas would apply. */
function run(
  req: { instances: typeof CHAIN.instances; wires: typeof CHAIN.wires; sizes: Record<string, Size>; layout: Record<string, Pos>; handMoved?: ReadonlySet<string> },
): { applied: AppliedStage[]; layout: Record<string, Pos> } {
  const applied: AppliedStage[] = [];
  const layout: Record<string, Pos> = { ...req.layout };
  startIdealLayout(
    { instances: req.instances, wires: req.wires, groups: [], layout: req.layout, sizes: req.sizes, handMoved: req.handMoved ?? new Set() },
    {
      schedule: synchronousSchedule,
      apply: (stage, cmds) => {
        applied.push({ stage, cmds });
        for (const c of cmds) if (c.kind === 'move') layout[c.id] = { x: c.x, y: c.y };
      },
      fitView: () => {},
      currentLayout: () => layout,
    },
  );
  return { applied, layout };
}

/** Route the chain at the FINAL layout with the MEASURED boxes — exactly the geometry App.tsx feeds the canvas
 *  router — and return each wire's routed polyline. */
function routeChain(layout: Record<string, Pos>, sizes: Record<string, Size>) {
  const ports: Record<string, { name: string; dir: 'in' | 'out' }[]> = {
    a: [{ name: 'out', dir: 'out' }],
    b: [{ name: 'in', dir: 'in' }, { name: 'out', dir: 'out' }],
    c: [{ name: 'in', dir: 'in' }],
  };
  return routeDesignEdges({
    nodes: CHAIN.instances.map((i) => ({ id: i.id, box: { x: layout[i.id]!.x, y: layout[i.id]!.y, w: sizes[i.id]!.w, h: sizes[i.id]!.h }, ports: ports[i.id]! })),
    wires: CHAIN.wires.map((w) => ({ from: w.from, to: w.to })),
  });
}

describe('startIdealLayout — routes through the MEASURED node sizes (the host-side default-height fiction is dead)', () => {
  it('the 80/140/100 chain ships ONE straight segment per hop at the MEASURED port anchors', () => {
    const { layout } = run({ instances: CHAIN.instances, wires: CHAIN.wires, sizes: CHAIN_SIZES, layout: CHAIN_LAYOUT });
    // The port-anchor law at MEASURED heights: a single-port side anchors at h/2, so straight means
    // y(a) + 40 = y(b) + 70 = y(c) + 50. Default heights (120 ⇒ +60 everywhere) would align the TOPS instead,
    // leaving the measured anchors 30px/20px apart — this assertion is exactly the defect detector.
    expect(layout['a']!.y + 40).toBe(layout['b']!.y + 70);
    expect(layout['b']!.y + 70).toBe(layout['c']!.y + 50);
    // And the router — the arbiter — draws each hop as ONE straight segment on the measured boxes.
    const routed = routeChain(layout, CHAIN_SIZES);
    CHAIN.wires.forEach((_, i) => {
      const pts = routed.get(i)!.points;
      expect(pts.length, `hop ${i} is ONE straight segment`).toBe(2);
      expect(pts[0]!.y, `hop ${i} rides one row`).toBeCloseTo(pts[1]!.y, 9);
    });
  });

  it('each stage lands as ONE batch — floor first, polish second (one native undo step per stage)', () => {
    const { applied } = run({ instances: CHAIN.instances, wires: CHAIN.wires, sizes: CHAIN_SIZES, layout: CHAIN_LAYOUT });
    expect(applied.length).toBeLessThanOrEqual(2);
    expect(applied[0]!.stage).toBe('floor');
    if (applied.length === 2) expect(applied[1]!.stage).toBe('polish');
  });

  it('is seeded-deterministic: the same design + measured sizes apply the byte-identical layout', () => {
    const one = run({ instances: CHAIN.instances, wires: CHAIN.wires, sizes: CHAIN_SIZES, layout: CHAIN_LAYOUT });
    const two = run({ instances: CHAIN.instances, wires: CHAIN.wires, sizes: CHAIN_SIZES, layout: CHAIN_LAYOUT });
    expect(one.layout).toEqual(two.layout);
    expect(JSON.stringify(one.applied)).toBe(JSON.stringify(two.applied));
  });

  it('holds a session hand-placement as a pin: neither the floor nor the polish moves it', () => {
    const pinnedAt: Pos = { x: 777, y: 555 };
    const { applied, layout } = run({
      instances: CHAIN.instances,
      wires: CHAIN.wires,
      sizes: CHAIN_SIZES,
      layout: { ...CHAIN_LAYOUT, b: pinnedAt },
      handMoved: new Set(['b']),
    });
    expect(layout['b']).toEqual(pinnedAt);
    for (const stage of applied) for (const c of stage.cmds) expect(c.kind === 'move' ? c.id : '').not.toBe('b');
  });

  it('an empty design is an honest no-op (no polisher, nothing applied)', () => {
    const applied: AppliedStage[] = [];
    const polisher = startIdealLayout(
      { instances: [], wires: [], groups: [], layout: {}, sizes: {}, handMoved: new Set() },
      { schedule: synchronousSchedule, apply: (stage, cmds) => applied.push({ stage, cmds }), fitView: () => {}, currentLayout: () => ({}) },
    );
    expect(polisher).toBeNull();
    expect(applied).toEqual([]);
  });
});

// THE PORT SLIDE THROUGH THE PIPELINE (R5): the ✨ stages hand the shell an ASSIGNED-offsets map through the
// `setPortOffsets` seam — floor first (on the tidied geometry), then the polish winner's — computed from the
// CATALOG ports the request threads (the multi-out jog class: the layout must speak the handles the canvas
// renders). App.tsx puts the map on the node renderer AND the router input; here the harness proves the pipeline
// delivers it, deterministic, gap-lawful, and anchored where the routed wires land.
describe('startIdealLayout — the port slide rides the seams (catalog ports in, assigned offsets out)', () => {
  /** The owner's multi-out shape: api's MANIFEST out side [db,out,cache], only db wired — the 29.7px-jog class. */
  const MULTI = {
    instances: [
      { id: 'client', type: 'client.web' },
      { id: 'api', type: 'compute.service' },
      { id: 'pg', type: 'db.postgres' },
    ],
    wires: [
      { from: ['client', 'out'] as const, to: ['api', 'in'] as const },
      { from: ['api', 'db'] as const, to: ['pg', 'in'] as const },
    ],
    catalogPorts: {
      'client.web': [{ name: 'out', dir: 'out' as const }],
      'compute.service': [
        { name: 'in', dir: 'in' as const },
        { name: 'db', dir: 'out' as const },
        { name: 'out', dir: 'out' as const },
        { name: 'cache', dir: 'out' as const },
      ],
      'db.postgres': [{ name: 'in', dir: 'in' as const }],
    },
  } as const;
  const MULTI_SIZES: Record<string, Size> = { client: { w: 160, h: 100 }, api: { w: 160, h: 118.8 }, pg: { w: 160, h: 140 } };
  const MULTI_LAYOUT: Record<string, Pos> = { client: { x: 0, y: 0 }, api: { x: 30, y: 260 }, pg: { x: 60, y: 520 } };

  function runMulti(): { layout: Record<string, Pos>; offsets: (PortOffsets | null)[] } {
    const layout: Record<string, Pos> = { ...MULTI_LAYOUT };
    const offsets: (PortOffsets | null)[] = [];
    startIdealLayout(
      {
        instances: MULTI.instances,
        wires: MULTI.wires,
        groups: [],
        layout: MULTI_LAYOUT,
        sizes: MULTI_SIZES,
        catalogPorts: MULTI.catalogPorts,
        handMoved: new Set(),
      },
      {
        schedule: synchronousSchedule,
        apply: (_stage, cmds) => {
          for (const c of cmds) if (c.kind === 'move') layout[c.id] = { x: c.x, y: c.y };
        },
        fitView: () => {},
        currentLayout: () => layout,
        setPortOffsets: (o) => offsets.push(o),
      },
    );
    return { layout, offsets };
  }

  it('fires setPortOffsets at BOTH stages (floor, then the polish winner) — the sparkle owns the slide', () => {
    const { offsets } = runMulti();
    expect(offsets.length).toBe(2);
  });

  it('the multi-out jog closes END-TO-END: api.db→pg.in routes as ONE straight segment at the delivered offsets', () => {
    const { layout, offsets } = runMulti();
    const final = offsets[offsets.length - 1]!;
    // Route exactly as App.tsx feeds the canvas router: manifest ports + the delivered offset map.
    const routed = routeDesignEdges({
      nodes: MULTI.instances.map((i) => ({
        id: i.id,
        box: { x: layout[i.id]!.x, y: layout[i.id]!.y, w: MULTI_SIZES[i.id]!.w, h: MULTI_SIZES[i.id]!.h },
        ports: [...MULTI.catalogPorts[i.type]],
        ...(final[i.id] !== undefined ? { portOffsets: final[i.id]! } : {}),
      })),
      wires: MULTI.wires.map((w) => ({ from: w.from, to: w.to })),
    });
    MULTI.wires.forEach((_, i) => {
      const pts = routed.get(i)!.points;
      expect(pts.length, `wire ${i} ships ONE straight segment`).toBe(2);
      expect(pts[0]!.y, `wire ${i} rides one row`).toBeCloseTo(pts[1]!.y, 6);
    });
    // and api's assigned out side keeps manifest order at ≥ the minimum gap
    const outs = ['db', 'out', 'cache'].map((p) => final['api']![portOffsetKey('out', p)]!);
    expect(outs[0]!).toBeLessThanOrEqual(outs[1]! - MIN_PORT_GAP + 1e-9);
    expect(outs[1]!).toBeLessThanOrEqual(outs[2]! - MIN_PORT_GAP + 1e-9);
  });

  it('is deterministic: the same request delivers byte-identical offset maps', () => {
    expect(JSON.stringify(runMulti().offsets)).toBe(JSON.stringify(runMulti().offsets));
  });

  it('a hand-pinned node still slides its ports — position is node-level, ports are ours', () => {
    const layout: Record<string, Pos> = { ...MULTI_LAYOUT };
    const offsets: (PortOffsets | null)[] = [];
    startIdealLayout(
      { instances: MULTI.instances, wires: MULTI.wires, groups: [], layout: MULTI_LAYOUT, sizes: MULTI_SIZES, catalogPorts: MULTI.catalogPorts, handMoved: new Set(['pg']) },
      {
        schedule: synchronousSchedule,
        apply: (_stage, cmds) => {
          for (const c of cmds) if (c.kind === 'move') layout[c.id] = { x: c.x, y: c.y };
        },
        fitView: () => {},
        currentLayout: () => layout,
        setPortOffsets: (o) => offsets.push(o),
      },
    );
    expect(layout['pg']).toEqual(MULTI_LAYOUT['pg']); // the pin held the BOX…
    const final = offsets[offsets.length - 1]!;
    expect(final['pg']).toBeDefined(); // …while its ports still slid (the slide is ours, not the architect's)
  });
});
