// @algorithm Load sweep (origin scaling to surface the queueing knee)
// @problem The doc and chart must show how end-to-end latency responds as traffic rises — the knee
//   where latency stops being linear and runs away — using exactly the figures the capacity table
//   reports.
// @approach Detect traffic origins (the ONE shared OriginNode definition envelope reuses), scale
//   them by fixed factors (0.5..1.5), re-run the forward evaluation at each point, and read the
//   busiest flow's real (M/M/c queueing-aware) end-to-end latency.
// @complexity O(|factors|) forward evaluations (default 5), each O(cells) via the engine solve.
// @citations None (a parameter sweep; the queueing math is content/sda/src/queueing.ts).
// @invariants Pure and deterministic (no clock, no randomness); a design with no origin returns an
//   EMPTY series honestly, never fake points; every surface reuses this one computation (no drift).
// @where-tested content/sda/src/sweep.test.ts

import type { Key, Registry } from '@sda/engine-core';
import { NodeId } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { keys } from './registry';
import { generatorLevelOf, instantiate, type Instance, type Manifest, type Wire } from './manifest';
import { nodeQueues, realCumulativeLatency } from './queueing';
import { requestFlows, type ValueFn } from './system';
import type { DocSweepPoint } from './doc-model';

// THE LOAD SWEEP — the "how does end-to-end latency respond as traffic rises?" chart series
// that surfaces the queueing KNEE (the offered load where latency stops being linear and starts to run away). It is
// a GENERATION-TIME computation, not persisted state: for each factor we scale the design's traffic origins, run a
// forward evaluation, and read the busiest flow's REAL (queueing-aware) end-to-end latency — the SAME figure the doc
// reports at the baseline point, so the chart and the capacity table agree.
//
// PURE + DETERMINISTIC: no clock, no randomness, no Studio (which lives in @sda/core and would be a dependency
// cycle). It builds the graph via content's own `instantiate` + the engine's `evaluate` — exactly the path the
// design-doc tests use — so a caller passes only the design + the registry + the merged catalog and gets the points
// back. Every surface (web, VS Code host, MCP) reuses THIS, so the sweep can never drift between them.
//
// HONESTY (no fake data): the sweep needs a traffic ORIGIN to scale. A design with none (no client, no assumedRps > 0)
// has no load to sweep — the offered-load axis would be meaningless — so we return an EMPTY series and the doc simply
// omits the chart. We never invent a workload the architect did not declare.

/** The default sweep multipliers over the design's current offered load: below, at, and above nominal — enough to
 *  show the shape of the ρ→1 knee without a costly dense sweep. The 1.0 point reproduces the doc's baseline latency. */
export const SWEEP_FACTORS: readonly number[] = [0.5, 0.75, 1.0, 1.25, 1.5];

/** Everything the sweep reads: the design's structure + the registry + the merged catalog (built-ins + project
 *  custom, exactly what every other surface compiles against). A strict subset of what a design-doc caller already
 *  holds, so no surface computes anything new to call this. */
export interface LoadSweepInput {
  readonly instances: readonly Instance[];
  readonly wires: readonly Wire[];
  readonly registry: Registry;
  /** The MERGED catalog (built-ins + project-embedded custom) — the same one used to build the design's graph. */
  readonly catalog: Readonly<Record<string, Manifest>>;
  /** Override the multipliers (defaults to SWEEP_FACTORS). Kept injectable for tests; surfaces use the default. */
  readonly factors?: readonly number[];
}

/** A node that ORIGINATES traffic in the base design, and WHICH config key carries the load we scale: a client's
 *  `throughput` preset, or any node's explicit `assumedRps`. Scaling that key IS scaling the offered load. Exported
 * so the capacity ENVELOPE reuses the SAME origin detection the sweep uses — one
 *  definition of "what is a traffic origin and which knob carries its load", never two that could drift. */
export interface OriginNode {
  readonly id: string;
  readonly key: Key;
  readonly baseValue: number;
}

/** Read a node's effective config value for a key: an instance override, else the manifest default, else undefined. */
export function effectiveConfig(inst: Instance, catalog: Readonly<Record<string, Manifest>>, key: Key): number | undefined {
  const override = inst.config?.[String(key)];
  if (override !== undefined) return override;
  return (catalog[inst.type]?.config ?? []).find((c) => c.key === key)?.value;
}

/**
 * Find the design's traffic ORIGINS and the load-bearing config key on each — the knobs the sweep scales. A
 * `client.*` node originates via its `throughput` preset; ANY node originates via `assumedRps > 0`. A node that is
 * both (a client with an explicit assumedRps) is scaled on `assumedRps` (the universal mechanism the engine folds). We
 * only take origins whose load is > 0 — a zeroed knob is not a workload to sweep.
 */
export function originNodes(instances: readonly Instance[], catalog: Readonly<Record<string, Manifest>>): OriginNode[] {
  const origins: OriginNode[] = [];
  for (const inst of instances) {
    // A GENERATOR port is the primitive origin declaration; `assumedRps` is its sugar. The
    // precedence mirrors `instantiate` exactly (explicit instance config > generator total > manifest default),
    // and the scaled knob stays `assumedRps` either way — an explicit instance config WINS over the generator
    // total at instantiate, so `scaledInstances` writing that config scales a generator-declared origin identically.
    const declared = inst.config?.[String(keys.assumedRps)];
    const generated = declared === undefined ? generatorLevelOf(inst, catalog[inst.type]) : 0;
    const origin = declared ?? (generated > 0 ? generated : effectiveConfig(inst, catalog, keys.assumedRps) ?? 0);
    if (origin > 0) {
      origins.push({ id: inst.id, key: keys.assumedRps, baseValue: origin });
      continue;
    }
    // A client is a dedicated source: its `throughput` config IS its offered workload (the convenience preset over
    // the universal origin mechanism). Only a client — a general node's `throughput` is its CAPACITY, not its load.
    if (inst.type.startsWith('client')) {
      const tput = effectiveConfig(inst, catalog, keys.throughput) ?? 0;
      if (tput > 0) origins.push({ id: inst.id, key: keys.throughput, baseValue: tput });
    }
  }
  return origins;
}

/** Clone the instances with every origin node's load-bearing config scaled by `factor` (rounded to an integer rps —
 *  a fractional request rate is meaningless and would make the sweep's x labels noisy). Non-origin nodes untouched.
 * Exported for the ENVELOPE: scaling a SUBSET of origins (pass just one) frees a single
 *  origin's demand; scaling ALL of them at once holds the current ratio for the JOINT envelope. */
export function scaledInstances(instances: readonly Instance[], origins: readonly OriginNode[], factor: number): Instance[] {
  const byId = new Map(origins.map((o) => [o.id, o]));
  return instances.map((inst) => {
    const o = byId.get(inst.id);
    if (o === undefined) return inst;
    return { ...inst, config: { ...(inst.config ?? {}), [String(o.key)]: Math.round(o.baseValue * factor) } };
  });
}

/**
 * Compute the load→latency sweep for a design (doc §5). For each factor: scale the traffic origins, run one forward
 * evaluation, and read the busiest flow's REAL (queueing-aware) end-to-end latency at its terminal. Returns the
 * points sorted by offered load, or an EMPTY array when there is no traffic origin (nothing to sweep — the doc omits
 * the chart rather than invent a workload).
 *
 * PURE and deterministic: the same design always yields the same series (the engine + queueing model are pure). A
 * factor whose design fails to build/evaluate contributes no point (an honest gap, never a fabricated latency).
 */
export function buildLoadSweep(input: LoadSweepInput): DocSweepPoint[] {
  const { instances, wires, registry, catalog } = input;
  const factors = input.factors ?? SWEEP_FACTORS;

  const origins = originNodes(instances, catalog);
  if (origins.length === 0) return []; // no traffic origin — nothing to sweep (never fake a workload)
  // The offered load we plot on the x-axis is the busiest flow's origin load. All origins scale by the SAME factor,
  // so the busiest flow's offered load is simply its baseline value × factor; we take the total declared origin as
  // the headline offered figure (a single-origin design — the common case — makes this exactly that origin's rate).
  const baseOffered = origins.reduce((s, o) => s + o.baseValue, 0);

  const points: DocSweepPoint[] = [];
  for (const factor of factors) {
    const scaled = scaledInstances(instances, origins, factor);
    const g = instantiate(catalog, scaled, wires);
    if (!g.ok) continue; // this scaling did not build — no fabricated point
    const ev = evaluate(g.value, registry);
    if (!ev.ok) continue;
    const value: ValueFn = (id, k) => ev.value.value(NodeId(id), k);

    // The busiest flow's terminal carries the end-to-end metrics; its REAL latency is what the doc reports.
    const flows = requestFlows(scaled, wires, value);
    const busiest = flows[0];
    if (busiest === undefined) continue;
    const queues = nodeQueues(g.value, value);
    const realLatency = realCumulativeLatency(g.value, value, queues).get(busiest.terminal);
    if (realLatency === undefined) continue;

    points.push({ offeredRps: Math.round(baseOffered * factor), latencyMs: realLatency });
  }
  // Sort by offered load so the chart's polyline reads left→right regardless of factor order.
  return points.sort((a, b) => a.offeredRps - b.offeredRps);
}
