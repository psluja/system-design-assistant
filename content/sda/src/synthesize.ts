import { NodeId, type Key, type Graph } from '@sda/engine-core';
import { portsConnect } from '@sda/engine-solve';
import type { Enumerate, Evaluate, Headroom, Optimize, SelectionProblem, Tunable } from '@sda/solver-contract';
import { instantiate, type Instance, type Manifest, type ManifestBand, type Wire } from './manifest';
import { protocolCompat } from './protocols';

// @feature Synthesis & compare-options (generate, size, rank)
// @story Pick a node (or an intent) and let the engine enumerate every component that legally fits
//   its wiring, size each candidate to meet the SLOs at the cheapest configuration, and rank the
//   survivors — a fair Fargate-vs-Lambda-vs-ASG comparison in one call.
// @surfaces mcp (compare_options / synthesize / auto_architect, app/mcp/src/synthesize.ts), vscode
//   (sda.compareOptions, app/vscode/src/compare-host.ts)
// @algorithms engine/solve/src/asp/clingo.ts (enumeration),
//   engine/solver-contract/src/native/search.ts (sizing), engine/solve/src/minizinc/search.ts
//   (sizing), engine/solve/src/fixpoint/solve.ts (forward ranking)
// @docs none
// @e2e content/sda/src/synthesize.e2e.test.ts
// @status shipped

// synthesize() — the "run backwards from scratch" capstone: generate → size → rank, the
// composition no single solver gives. The Enumerate capability GENERATES protocol-compatible topologies
// (clingo today); the Optimize capability SIZES each candidate to meet every SLO at the best objective (or,
// with no tunables, the Evaluate capability ranks them AS-CONFIGURED — forward, no MIP). Only feasible designs
// survive, best objective first. Every solver arrives as a CONTRACT CAPABILITY
//, injected by the composition root — the SAME `SolverBindings` the
// backward-search tools use, so synthesis can never drift onto a second solver seam.
// content depends only on the contract CORE (which itself imports @sda/engine-core alone); the concrete
// incumbent adapter / WASM loaders are bound at the app layer and never reach here. Adjacency compatibility is
// DERIVED from the manifests' port protocols, so the catalog stays the single source of truth.

/** A hole to fill: the node `id` in the wiring, chosen from candidate manifest `types`. Whichever type
 *  wins must satisfy these SLO `bands` — the numeric solver sizes it to meet them (or the candidate drops). */
export interface SynthSlot {
  readonly id: string;
  readonly node: string;
  readonly types: readonly string[];
  readonly bands?: readonly ManifestBand[];
}

export interface SynthSpec {
  /** Components present in every candidate (e.g. the client and gateway); they carry their own SLO bands. */
  readonly fixed: readonly Instance[];
  readonly slots: readonly SynthSlot[];
  /** Slot-id pairs whose chosen components must connect (protocol compat derived from manifests). */
  readonly adjacencies: ReadonlyArray<readonly [string, string]>;
  /** Wiring template over the fixed + slot node ids. */
  readonly wires: readonly Wire[];
  /** The key to size against + rank by; `min` (default) or `max`. */
  readonly objective: { readonly node: string; readonly key: Key; readonly direction?: 'min' | 'max' };
}

/** generate → size → rank: every solver is a CONTRACT CAPABILITY, injected by the composition root. Which
 *  concrete adapter answers each capability is decided ONCE at the app layer (the same `SolverBindings` the
 *  backward-search tools consume), never here — so the synthesis path can never bind a second, drifting solver. */
export interface SynthDeps {
  /** GENERATE protocol-valid topologies (the contract's Enumerate — clingo today). A solver error or timeout
   *  comes back as an honest `did-not-converge`, never a throw (the contract's no-throw discipline). */
  readonly enumerate: Enumerate;
  /** FORWARD-evaluate a candidate as-configured (the contract's Evaluate). The ranking path when no knob is
   *  freed — the same synchronous hot path the canvas runs on every edit. */
  readonly evaluate: Evaluate;
  /** SIZE each candidate to its best-objective fit (the contract's Optimize). Required only when `tunables`
   *  frees knobs; omit for forward (as-configured) ranking. */
  readonly optimize?: Optimize;
  /** Knobs the numeric solver may size per candidate. Omit (or return []) to rank candidates AS-CONFIGURED
   *  (forward — no MIP needed). Pass `provisioningTunables` to SIZE each candidate to its cheapest fit. */
  readonly tunables?: (graph: Graph) => Tunable[];
  /** Capacity headroom (ρ ≤ factor) applied while sizing each candidate, so a winner has FINITE queueing latency
   *  rather than the ρ=1 knife-edge (throughput met but the queue unbounded). The SAME headroom Improve uses, so
   *  compare/synthesize never recommends a saturated design that the forward verdict then flags. Omit for ρ ≤ 1. */
  readonly headroom?: Headroom;
}

export interface RankedDesign {
  /** slot id → chosen manifest type. */
  readonly selection: Readonly<Record<string, string>>;
  /** The objective value under the chosen sizing (the ranking key). */
  readonly objective: number;
  /** The sizing to apply to the winner (empty in forward mode). */
  readonly assignments: ReadonlyArray<{ readonly node: NodeId; readonly key: Key; readonly value: number }>;
  /** Any computed value of the synthesized design under that sizing. */
  value(node: string, key: Key): number | undefined;
}

// The protocols one SPECIFIC port speaks (OUT) or accepts (IN) — the wire actually rides ONE named port on each
// side, so compatibility must be judged on THOSE ports, not on the manifest's whole port set (a generic `out`
// port that also speaks the target's protocol must not make an incompatible `db`-port wire look legal).
const portSpeaks = (m: Manifest, port: string): readonly string[] => m.ports.find((p) => p.name === port && (p.dir === 'out' || p.dir === 'bi'))?.speaks ?? [];
const portAccepts = (m: Manifest, port: string): readonly string[] => m.ports.find((p) => p.name === port && (p.dir === 'in' || p.dir === 'bi'))?.accepts ?? [];

/** Two manifests connect OVER A SPECIFIC WIRE when `a`'s out-port `aPort` can produce a protocol `b`'s in-port
 *  `bPort` will consume — the SAME accept/speak-set rule the legality layer uses (`portsConnect`), judged on the
 *  EXACT ports the wire uses. This is what keeps synthesis and legality from disagreeing: a candidate pairing that
 *  is only "compatible" over some OTHER port (a generic `out` that happens to speak the target's protocol) is NOT
 *  wireable on this wire and must be rejected, or synthesis would return a design `apply_design`/`illegalEdges`
 *  then refuses. */
function connects(a: Manifest | undefined, aPort: string, b: Manifest | undefined, bPort: string): boolean {
  if (a === undefined || b === undefined) return false;
  return portsConnect(portSpeaks(a, aPort), portAccepts(b, bPort), protocolCompat);
}

export async function synthesize(
  manifests: Readonly<Record<string, Manifest>>,
  spec: SynthSpec,
  deps: SynthDeps,
): Promise<RankedDesign[]> {
  const slotById = new Map(spec.slots.map((s) => [s.id, s]));

  const compatible: Array<[string, string]> = [];
  for (const [sa, sb] of spec.adjacencies) {
    const A = slotById.get(sa);
    const B = slotById.get(sb);
    if (A === undefined || B === undefined) continue;
    // The adjacency is realised by a WIRE in the template; judge compatibility on THAT wire's exact ports (a slot's
    // component may carry several out/in ports — only the WIRED one carries the connection, so a generic `out` that
    // also speaks the target's protocol must not make an incompatible `db`-port wire look legal). Adjacencies key on
    // slot IDs but wires reference the slots' NODE ids, so match on the node ids. Skip an adjacency with no wire.
    const wire = spec.wires.find((w) => (w.from[0] === A.node && w.to[0] === B.node) || (w.from[0] === B.node && w.to[0] === A.node));
    if (wire === undefined) continue;
    const producerIsA = wire.from[0] === A.node; // is slot A on the OUT side of the wire?
    const [outPort, inPort] = [wire.from[1], wire.to[1]];
    // A pair (ta ∈ sa, tb ∈ sb) connects iff the wire's producer-side type can speak to its consumer-side type over
    // the wire's exact ports. `compatible` is keyed to the adjacency's (sa, sb) order, so always push [ta, tb].
    for (const ta of A.types) {
      for (const tb of B.types) {
        const [prodType, consType] = producerIsA ? [ta, tb] : [tb, ta];
        if (connects(manifests[prodType], outPort, manifests[consType], inPort)) compatible.push([ta, tb]);
      }
    }
  }

  const problem: SelectionProblem = {
    slots: spec.slots.map((s) => ({ id: s.id, candidates: s.types })),
    adjacencies: spec.adjacencies,
    compatible,
  };
  // Enumerate through the contract capability: a proven-empty result is UNSAT (no protocol-valid topology), a
  // `did-not-converge` is an honest solver error/timeout. Either way there is nothing to synthesize, so return an
  // empty ranking (the tools then say "no topology meets the SLOs") rather than throwing — the contract's
  // "search never throws / never hangs" discipline the raw runner did not honour.
  const enumeration = await deps.enumerate({ problem });
  if (enumeration.kind !== 'enumerated') return [];
  const selections = enumeration.selections;

  const direction = spec.objective.direction ?? 'min';
  const objNode = NodeId(spec.objective.node);

  const designs: RankedDesign[] = [];
  for (const sel of selections) {
    const slotInstances: Instance[] = spec.slots.map((s) => ({
      id: s.node,
      type: sel[s.id] as string,
      ...(s.bands !== undefined ? { bands: s.bands } : {}),
    }));
    const g = instantiate(manifests, [...spec.fixed, ...slotInstances], spec.wires);
    if (!g.ok) continue;

    const knobs = deps.tunables?.(g.value) ?? [];
    if (knobs.length > 0) {
      // SIZED: the numeric solver finds the best-objective sizing that meets every band, with capacity headroom
      // (ρ ≤ factor) so the winner is not the saturated ρ=1 knife-edge. A candidate that cannot be sized — no
      // Optimize capability bound, or a proven `infeasible` / `did-not-converge` — simply drops from the ranking
      // (honest: it could not be shown to meet the SLOs), exactly as the old `!r.ok` guard dropped it.
      if (deps.optimize === undefined) continue;
      const r = await deps.optimize({
        graph: g.value,
        tunables: knobs,
        objective: { node: objNode, key: spec.objective.key, direction },
        ...(deps.headroom !== undefined ? { headroom: deps.headroom } : {}),
      });
      if (r.kind !== 'solved') continue; // infeasible OR did-not-converge: no sizing meets the SLOs
      const objective = r.value.value(objNode, spec.objective.key);
      if (objective === undefined) continue;
      designs.push({ selection: sel, objective, assignments: r.value.assignments, value: (n, k) => r.value.value(NodeId(n), k) });
    } else {
      // FORWARD: rank as-configured; keep only designs whose every band already holds (no MIP needed).
      const e = deps.evaluate({ graph: g.value });
      if (!e.ok || !e.value.converged) continue;
      if (e.value.verdicts.some((v) => v.status === 'violation')) continue;
      const objective = e.value.value(objNode, spec.objective.key);
      if (objective === undefined) continue;
      designs.push({ selection: sel, objective, assignments: [], value: (n, k) => e.value.value(NodeId(n), k) });
    }
  }

  return designs.sort((a, b) => (direction === 'min' ? a.objective - b.objective : b.objective - a.objective));
}
