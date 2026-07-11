import type { Size } from './layout';
import type { LayoutDesign, LayoutGroup, LayoutNode, LayoutWire } from './layout-model';
import type { PortLike } from './edge-routing';
import { type LayoutSearch, type OptimizeOptions, type OptimizeResult, createLayoutSearch } from './layout-optimize';

// @feature Ideal layout (semantic auto-layout)
// @story Click the ideal-layout button and get a tidy, meaningful placement — tiers and flow read
//   left to right, wires straighten, pinned nodes are never fought — instantly floored at Tidy and
//   polished in the background.
// @surfaces web (HUD button, app/web/src/app.tsx via app/web/src/layout.ts), vscode
//   (sda.idealLayout + the webview pipeline app/vscode/webview/ideal-layout.ts), presenter
//   (createPolisher here — both shells drive the identical logic)
// @algorithms app/presenter/src/layout.ts, app/presenter/src/layout-semantic.ts,
//   app/presenter/src/layout-refine.ts, app/presenter/src/layout-ports.ts,
//   app/presenter/src/layout-optimize.ts, app/presenter/src/layout-objective.ts,
//   app/presenter/src/edge-routing.ts, app/presenter/src/layout-model.ts,
//   app/presenter/src/layout-gpu/proxy.ts
// @docs docs/design/ideal-layout.html
// @e2e none (unit + benchmark gate: app/presenter/src/layout-benchmark.test.ts over the committed
//   examples)
// @status shipped (GPU proposer is an acceleration seam; CPU decides every applied layout)

// THE IDEAL LAYOUT — the shared SHELL HANDSHAKE (doc: ideal-layout §3.6, the resting handshake). Both shells apply
// Tidy INSTANTLY, then run the background polisher; when it comes to REST they apply the better layout smoothly.
// The two shell-agnostic pieces live HERE so the web HUD and the VS Code command drive IDENTICAL logic (one
// presenter, zero drift — web-is-a-dumb-renderer):
//   • {@link toLayoutDesign} — project doc (instances/wires/groups) → the structural LayoutDesign the search reads,
//     the SAME projection the benchmark uses (origin rate from `assumedRps`, wire `semantics` carried through).
//   • {@link createPolisher} — the latest-wins / idle=zero state machine. It owns the epoch guard and the phase, and
//     drives a RESUMABLE {@link createLayoutSearch} through an INJECTED scheduler (the shell decides HOW to run off
//     the critical path: the web HUD uses requestAnimationFrame slices; a test/host uses {@link synchronousSchedule}).
//     No DOM, no worker, no timer of its own — so it is pure and unit-testable, and the shell owns the platform seam.

/** The minimal project view the layout reads — exactly the fields both shells already hold on their doc. */
export interface LayoutDocView {
  readonly instances: readonly { readonly id: string; readonly type: string; readonly config?: Readonly<Record<string, number>> }[];
  readonly wires: readonly { readonly from: readonly [string, string]; readonly to: readonly [string, string]; readonly semantics?: 'sync' | 'async' }[];
  readonly groups: readonly { readonly id: string; readonly members: readonly string[] }[];
}

/** The CATALOG port lists by component type (manifest order — name + dir is all the layout reads), as both shells
 *  hold them on their catalog. Threaded onto each node so every layout stage anchors at the handles the canvas
 *  actually renders (R5 — the multi-out jog class pinned shut: wire-derived ports mis-place a partially-wired
 *  multi-port side). */
export type CatalogPorts = Readonly<Record<string, readonly PortLike[]>>;

/**
 * Project doc → the structural {@link LayoutDesign} the search optimises. A node's origin rate rides the same
 * `config.assumedRps` the System roll-up reads (a mid-graph emitter still laid out as a lane source); a wire keeps
 * its `sync`/`async` semantics (async wants a distinct spur); a group becomes a member set (the placement band).
 * `sizes` are the shell's MEASURED node footprints — passed onto each node so Tidy, the router and the objective all
 * agree with what actually renders — and `catalogPorts` the manifest port lists by type, for the same reason at the
 * PORT level (R5). Pure and dependency-free (mirrors the benchmark's own loader).
 */
export function toLayoutDesign(doc: LayoutDocView, sizes?: Readonly<Record<string, Size>>, catalogPorts?: CatalogPorts): LayoutDesign {
  const nodes: LayoutNode[] = doc.instances.map((i) => {
    const originRate = i.config?.assumedRps;
    const size = sizes?.[i.id];
    const ports = catalogPorts?.[i.type];
    return {
      id: i.id,
      type: i.type,
      ...(originRate !== undefined ? { originRate } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(ports !== undefined && ports.length > 0 ? { ports } : {}),
    };
  });
  const wires: LayoutWire[] = doc.wires.map((w) => (w.semantics !== undefined ? { from: w.from, to: w.to, semantics: w.semantics } : { from: w.from, to: w.to }));
  const groups: LayoutGroup[] = doc.groups.map((g) => ({ id: g.id, members: g.members }));
  return { nodes, wires, groups };
}

/** The resting-handshake phase (doc §3.6): `idle` (no work, zero timers), `polishing` (the background search is
 *  running), `done` (the better layout has been handed to the shell). */
export type PolishPhase = 'idle' | 'polishing' | 'done';

/** One polish request — the design to optimise + the search options (seed, budget, pins, anchors, measured sizes)
 *  + the per-slice wall-clock the scheduler grants each step (default 12ms — under a frame). */
export interface PolishJob {
  readonly design: LayoutDesign;
  readonly options?: OptimizeOptions;
  readonly sliceMs?: number;
}

export interface PolishHandlers {
  /** Phase transitions — the shell shows "polishing…" on `polishing` and clears it on `done`/`idle`. Optional. */
  readonly onPhase?: (phase: PolishPhase) => void;
  /** The finished, CPU-proven, Tidy-floored result — the shell applies `result.placement` (animated). Fires ONCE
   *  per request that reaches rest, and NEVER for a superseded one (latest-wins). */
  readonly onDone: (result: OptimizeResult) => void;
}

/**
 * The platform seam: run `step` (one search slice) repeatedly OFF the critical path until it returns `false`, then
 * stop. Returns a `cancel` that halts further steps. The web HUD implements this with requestAnimationFrame (a step
 * per frame, so the canvas never drops one); a test or the VS Code host uses {@link synchronousSchedule}.
 */
export type PolishScheduler = (step: () => boolean) => () => void;

/** A synchronous scheduler — drain the search to completion in one go. For tests and for a host (Node) context
 *  where blocking is fine; NEVER for a live canvas (it would freeze it). */
export const synchronousSchedule: PolishScheduler = (step) => {
  while (step()) {
    /* drain */
  }
  return () => {
    /* already complete — nothing to cancel */
  };
};

export interface Polisher {
  /** Start polishing `job`, SUPERSEDING any in-flight polish (latest-wins) — a fresh edit always wins over a stale
   *  search still running. */
  request(job: PolishJob): void;
  /** Abandon any in-flight polish and return to `idle` (idle = zero work). Call on unmount / when the design is
   *  cleared. */
  cancel(): void;
  /** The current phase (also delivered via `onPhase`). */
  readonly phase: PolishPhase;
}

/**
 * The resting-handshake controller (doc §3.6): latest-wins, idle=zero, seeded-deterministic. It epoch-guards every
 * request so a superseded search can neither apply its result nor keep stepping, and it holds NO platform
 * dependency — the injected `schedule` decides how the resumable search runs off the critical path. Pure logic:
 * unit-tested by driving it with {@link synchronousSchedule} + a fake clock, exactly as the shells drive it with rAF.
 */
export function createPolisher(handlers: PolishHandlers, schedule: PolishScheduler = synchronousSchedule): Polisher {
  let epoch = 0;
  let cancelCurrent: (() => void) | null = null;
  let phase: PolishPhase = 'idle';

  const setPhase = (next: PolishPhase): void => {
    if (next === phase) return;
    phase = next;
    handlers.onPhase?.(next);
  };

  const stopCurrent = (): void => {
    if (cancelCurrent !== null) {
      const c = cancelCurrent;
      cancelCurrent = null;
      c();
    }
  };

  return {
    get phase() {
      return phase;
    },
    request(job: PolishJob): void {
      const mine = ++epoch; // latest-wins token: a newer request bumps this and orphans the old step loop
      stopCurrent();
      let search: LayoutSearch;
      try {
        search = createLayoutSearch(job.design, job.options);
      } catch {
        // Building the search can only fail on a malformed design; polishing is best-effort beauty, never a hard
        // failure — fall back to idle (the shell keeps its instant Tidy).
        setPhase('idle');
        return;
      }
      setPhase('polishing');
      const sliceMs = job.sliceMs ?? 12;
      const step = (): boolean => {
        if (mine !== epoch) return false; // superseded mid-flight — stop stepping, apply nothing
        const more = search.runSlice(sliceMs);
        if (more) return true;
        if (mine === epoch) {
          const result = search.result();
          cancelCurrent = null;
          setPhase('done');
          handlers.onDone(result);
        }
        return false;
      };
      cancelCurrent = schedule(step);
    },
    cancel(): void {
      epoch++; // orphan any in-flight step loop
      stopCurrent();
      setPhase('idle');
    },
  };
}
