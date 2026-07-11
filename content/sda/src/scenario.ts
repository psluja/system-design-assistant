import { NodeId, type Cell, type Graph, type Key, type Node } from '@sda/engine-core';
import type { EvaluateBatch, Evaluation, Scenario } from '@sda/solver-contract';
import { isFactAssumption, keys, roleOf } from './registry';
import type { Instance, Wire } from './manifest';
import { systemSummary, type ValueFn } from './system';
import { systemPromiseVerdicts, type SystemPromise } from './system-promise';
import { realAwareVerdicts } from './verdict';
import { nodeQueues } from './queueing';

// @feature Worlds / trio (named-scenario evaluation)
// @story Compare pessimistic / real / optimistic worlds — values already derived from THIS design's
//   envelope and ranges — across cost, utilization and verdicts in one matrix, with the active lens
//   tagged.
// @surfaces mcp (derive_scenarios, declare_scenario, set/clear_scenario_value, evaluate_scenarios —
//   app/mcp/src/assumptions.ts), web (worlds matrix panel, app/web/src/app.tsx), vscode
//   (scenario-host, scenario-lens, sda.clearScenarioOverride/resetScenario), presenter
//   (app/presenter/src/worlds-view.ts)
// @algorithms engine/solve/src/fixpoint/solve.ts, content/sda/src/envelope.ts (the trio derives
//   demand from the envelope)
// @docs docs/design/assumption-model.html
// @e2e app/web/src/worlds.e2e.test.ts, app/mcp/src/cqrs-scale.e2e.test.ts
// @status shipped

// NAMED WORLDS (scenarios) — the assumption model's view two (doc: assumption-model §4). A scenario names a concrete
// POINT in the assumption space: a name plus a set of overrides `node.key → value` on the fact-assumption inputs.
// Because the point is concrete, the answers become ABSOLUTE (a monthly bill, a real utilisation, a per-world
// verdict). The keystone (doc §4.1, §7.2): a named world IS the contract's `Scenario` shape, so evaluating ALL of
// them is a single `EvaluateBatch` call — the very batch Monte-Carlo already rides.
//
// THE ROLE BOUNDARY (doc §2, §4.1): a world may override ONLY role=`fact-assumption` keys (the assumption space). A
// limit / computed / promise key is not a "world" — changing it is a design variant or a requirement change, with
// its own surface. `scenarioProblems` draws that boundary mechanically (validated on load + in the command), so it
// can never drift. A world stores only the values it CHANGES from the base layer (deltas), never a full copy.

/** WHERE a scenario override's value came from (doc §5.3) — the fifth member on the assumptions-register provenance
 *  axis, applied to a world's overrides:
 *   • `derived`   — LIVE-derived from the design's own capacity envelope / a declared range (the auto-created trio).
 *                   It re-tracks the envelope on every design edit (doc §9, tension #5) until the architect edits it.
 *   • `architect` — a value the architect typed BY HAND (a manual edit froze a derived value, or a hand-authored
 *                   override). Never silently overwritten by the re-derive; frozen.
 *   • undefined   — a plain hand-authored override with no derivation history (a custom scenario's own number) —
 *                   treated as architect for freezing purposes, but CLEAR removes it (falls back to base) rather
 *                   than un-freezing to a derived value there is none to derive.
 *  The lifecycle (coordinator directive): live-derived → (manual edit) architect/frozen → (clear) back to derived,
 *  re-tracking immediately. `clearScenarioOverride` reads THIS field to decide reset-to-derived vs remove. */
export type OverrideProvenance = 'derived' | 'architect';

/** One override on a fact-assumption input in a named world: the node, the (fact-assumption) config key, its value.
 *  DELTAS over the base layer — a world overrides only where its world genuinely differs (doc §4.1). `provenance`
 *  is additive within schema 7 (optional): absent ⇒ a hand-authored override (today, bit-for-bit); `derived` /
 *  `architect` mark the auto-trio's live / frozen values (doc §5.3). */
export interface ScenarioOverride {
  readonly node: string;
  readonly key: string;
  readonly value: number;
  readonly provenance?: OverrideProvenance;
}

/** A named world (doc §4.1): an `id` (its canvas label + stable identifier), an optional friendly `name` (mirrors
 *  RequestClassDecl.name), and its overrides. Pure DATA on the project document (schema 7, additive) — absent
 *  everywhere ⇒ no named worlds: the base layer IS the design, evaluated once, today bit-for-bit. */
export interface AssumptionScenario {
  readonly id: string;
  readonly name?: string;
  readonly overrides: readonly ScenarioOverride[];
}

/** Does the design declare ANY named world? The no-filler gate — with none, the whole scenario machinery stays
 *  inert and the design evaluates exactly as today (the additive default). */
export function hasScenarios(scenarios: readonly AssumptionScenario[] | undefined): boolean {
  return scenarios !== undefined && scenarios.length > 0;
}

/** Is `(node, key)` a SOURCE CLIENT's throughput — the demand a client offers? A `client.*` node with no inbound
 *  wire is a pure traffic source; its `throughput` config IS its offered workload (the universal generalisation of
 *  a client's throughput-as-workload, doc §2), so a scenario may override it as a demand belief — even though
 *  `throughput` is a COMPUTED capacity on every other node. Detected STRUCTURALLY (type prefix + no inbound wire),
 *  so no catalog is needed and `deserialize` (which has no catalog) and the commands agree on the boundary. */
function isSourceClientThroughput(node: string, key: string, instances: readonly Instance[], wires: readonly Wire[]): boolean {
  if (key !== String(keys.throughput)) return false;
  const inst = instances.find((i) => i.id === node);
  if (inst === undefined || !inst.type.startsWith('client')) return false;
  return !wires.some((w) => w.to[0] === node); // a source: nothing flows INTO it
}

/** May a scenario override `(node, key)`? True for a role=`fact-assumption` input (the assumption space, doc §2) OR
 *  a source client's throughput (its offered demand). The ONE overridability gate every surface reads — the derived
 *  trio, the commands and the load validator all draw the boundary the same way, so it can never drift. */
export function isScenarioOverridable(node: string, key: string, instances: readonly Instance[], wires: readonly Wire[]): boolean {
  return isFactAssumption(key) || isSourceClientThroughput(node, key, instances, wires);
}

/**
 * Honest, guided problems in the declared scenarios (or [] when every one is well-formed) — the SAME discipline as
 * `classDeclProblems`, called by `deserialize` and the scenario commands so a corrupt scenario is rejected with a
 * message that names the fix, never silently loaded. Two HARD rules are enforced (the rest — a stale node/key — is a
 * SOFT lens, reported-and-skipped at evaluate time per doc §4.2, not a load error):
 *   1. a scenario needs a non-empty, unique id;
 *   2. every override targets an OVERRIDABLE quantity (a fact-assumption input, or a source client's throughput —
 *      {@link isScenarioOverridable}). A limit / computed / promise override is refused, NAMING the key's actual role
 *      and the right surface, because such an override would silently do nothing (the tool must not lie).
 * Design-aware (`instances` + `wires`): overridability of a client's throughput depends on it being a source.
 */
export function scenarioProblems(scenarios: readonly AssumptionScenario[], instances: readonly Instance[], wires: readonly Wire[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of scenarios) {
    if (typeof s.id !== 'string' || s.id.trim() === '') {
      problems.push('a scenario has no id (name)');
      continue;
    }
    if (seen.has(s.id)) problems.push(`duplicate scenario "${s.id}"`);
    seen.add(s.id);
    for (const o of s.overrides ?? []) {
      const p = overrideRoleProblem(o.node, o.key, instances, wires);
      if (p !== null) problems.push(`scenario "${s.id}": ${p}`);
    }
  }
  return problems;
}

/** Why an override on `(node, key)` is illegal (its role forbids it), or null when it is overridable
 *  ({@link isScenarioOverridable}). The guided message names the actual role and the surface that DOES own that
 *  quantity — the MCP/error contract. Design-aware so a source client's throughput passes while a service's
 *  throughput (a computed capacity, not demand) is refused with a message that points at the origin instead. */
export function overrideRoleProblem(node: string, key: string, instances: readonly Instance[], wires: readonly Wire[]): string | null {
  if (isScenarioOverridable(node, key, instances, wires)) return null;
  const role = roleOf(key as Key);
  if (key === String(keys.throughput))
    return `"${key}" is a computed capacity here — a scenario overrides offered DEMAND only at a traffic origin (a source client, or a node with assumedRps). "${node}" is not an origin, so a throughput override would silently do nothing`;
  if (role === undefined) return `"${key}" is not a known quantity — a scenario overrides a fact-assumption input (offered load, a service time, a payload size)`;
  const where =
    role === 'resource-limit'
      ? 'a resource limit — change it with set_config (or the Improve search), it is a design variant, not a world'
      : role === 'computed'
        ? 'a computed result — it is an OUTPUT, not an input a world can set'
        : 'a promise target (SLO) — set it with set_slo, it is a requirement, not a belief';
  return `"${key}" is ${where}; a scenario may override only fact-assumption inputs (doc: assumption-model §2)`;
}

/** Lower a named world to the contract's `Scenario` (doc §4.1): its overrides become the `"node|key" → value` map
 *  the `EvaluateBatch` substitutes onto the fixed input cells — the SAME addressing Monte-Carlo uses. */
export function toContractScenario(s: AssumptionScenario): Scenario {
  const overrides: Record<string, number> = {};
  for (const o of s.overrides) overrides[`${o.node}|${o.key}`] = o.value;
  return { overrides };
}

/** Overlay a named world's overrides onto the base graph — the graph a shell EVALUATES / judges when that world is
 *  the ACTIVE lens (doc §7.1). The single source of the overlay surgery both the batch adapter and the active-lens
 *  canvas share (never re-implemented): an override substitutes a FIXED input cell; an override on a non-fixed cell
 *  is ignored (a computed value cannot be a world coordinate). Pure engine-core, no solver, no domain knowledge. */
export function applyScenarioToGraph(graph: Graph, s: AssumptionScenario): Graph {
  return applyOverrides(graph, toContractScenario(s));
}

/** One world's evaluated summary (doc §7.2 matrix): its absolute cost, its per-node verdicts (queueing-aware), the
 *  feasibility roll-up, and the peak utilisation ρ (the headroom read). */
export interface WorldSummary {
  /** The scenario id, or `'base'` for the always-included base world. */
  readonly id: string;
  readonly name?: string;
  readonly costUsdMonth: number;
  readonly feasible: boolean;
  readonly violations: number;
  /** Peak node utilisation ρ across the design (the headroom read); undefined when no node queues. */
  readonly peakRho: number | undefined;
  readonly verdicts: readonly WorldVerdict[];
  /** Overrides that named a node/key the design does not carry as a fixed input — reported and SKIPPED (doc §4.2:
   *  a scenario is a soft lens, not a structural claim), never silently applied to nothing. */
  readonly staleOverrides: readonly string[];
}

/** One node's verdict in a world — the queueing-aware read every surface shares. */
export interface WorldVerdict {
  readonly scope: string;
  readonly key: string;
  readonly status: string;
  readonly value: number | undefined;
  readonly unit: string;
}

/** The whole comparison matrix (doc §7.2): the base world plus every declared world, all from ONE EvaluateBatch. */
export interface WorldsResult {
  readonly worlds: readonly WorldSummary[];
}

/** Everything `evaluateWorlds` reads: the compiled base graph, the instances/wires (for the roll-up), and the
 *  declared scenarios. A strict subset of what any evaluate caller already holds. */
export interface WorldsInput {
  readonly graph: Graph;
  readonly instances: readonly Instance[];
  readonly wires: readonly Wire[];
  readonly scenarios: readonly AssumptionScenario[];
  /** The declared SYSTEM promises (owner ruling: cost is for THE WHOLE SYSTEM) — judged PER WORLD against that
   *  world's whole-graph total, so the matrix shows the global promise's fate in every world (a row's violation
   *  count and worst-violation cell include `system.cost` exactly like a node verdict). Absent/empty ⇒ unchanged. */
  readonly systemPromises?: readonly SystemPromise[];
  readonly signal?: AbortSignal;
}

/**
 * Evaluate the design under the base world AND every named world, in ONE `EvaluateBatch` call (doc §7.2). The base
 * world is ALWAYS first. Each world lowers to a contract `Scenario`; the batch substitutes its fact-assumption
 * overrides onto the fixed input cells and returns one `Evaluation` per world, in order. For each we read the
 * absolute cost, the queueing-aware verdicts (judged on the world's OVERRIDDEN graph, so the human and the AI see
 * one truth), and the peak ρ. SEEDED/deterministic (the batch is pure). Stale overrides (a node/key the design does
 * not carry) are reported per world and skipped — a soft lens, never a build error.
 */
export async function evaluateWorlds(input: WorldsInput, evaluateBatch: EvaluateBatch): Promise<WorldsResult> {
  const { graph, instances, wires, scenarios } = input;
  const fixedCells = fixedInputCells(graph);
  // The batch scenarios: the base world (no overrides) first, then each named world lowered. ONE call.
  const batch: Scenario[] = [{ overrides: {} }, ...scenarios.map(toContractScenario)];
  const results = await evaluateBatch({ graph, scenarios: batch, ...(input.signal ? { signal: input.signal } : {}) });

  const worlds: WorldSummary[] = [];
  const m = Math.min(results.length, batch.length);
  for (let i = 0; i < m; i++) {
    const decl = i === 0 ? undefined : scenarios[i - 1];
    const og = applyOverrides(graph, batch[i]!);
    worlds.push(summarizeWorld(decl, og, results[i]!, instances, wires, fixedCells, input.systemPromises));
  }
  return { worlds };
}

/** A SYNCHRONOUS forward evaluation of one graph — the sync `Evaluate` capability adapted to `Evaluation | undefined`
 *  (a build error ⇒ undefined). Lets a SYNC caller (the MCP `generate_doc` tool, which must not await) evaluate worlds
 *  without the async `EvaluateBatch`. */
export type EvaluateGraph = (graph: Graph) => Evaluation | undefined;

/**
 * The SYNCHRONOUS twin of {@link evaluateWorlds}: evaluate the base world + every named world by overlaying each and
 * calling the sync `Evaluate` capability, sharing the SAME per-world summarisation (so a sync surface and the ambient
 * async loop can never report a different matrix). A world whose overlaid graph fails to build is skipped honestly.
 */
export function evaluateWorldsSync(input: WorldsInput, evaluate: EvaluateGraph): WorldsResult {
  const { graph, instances, wires, scenarios } = input;
  const fixedCells = fixedInputCells(graph);
  const decls: (AssumptionScenario | undefined)[] = [undefined, ...scenarios];
  const worlds: WorldSummary[] = [];
  for (const decl of decls) {
    const og = decl === undefined ? graph : applyOverrides(graph, toContractScenario(decl));
    const ev = evaluate(og);
    if (ev !== undefined) worlds.push(summarizeWorld(decl, og, ev, instances, wires, fixedCells, input.systemPromises));
  }
  return { worlds };
}

/** Summarise ONE evaluated world into its {@link WorldSummary} — the SINGLE per-world roll-up both `evaluateWorlds`
 *  (async batch) and `evaluateWorldsSync` (sync) share, so the two paths can never disagree. Judges the SLOs on the
 *  world's OVERRIDDEN graph `og` (its drawn service times/loads) — `nodeQueues` reads config off the graph cells, so
 *  the queueing verdict must see the overridden values, exactly as a single evaluate would. `decl === undefined` ⇒
 *  the base world. */
function summarizeWorld(
  decl: AssumptionScenario | undefined,
  og: Graph,
  ev: Evaluation,
  instances: readonly Instance[],
  wires: readonly Wire[],
  fixedCells: Set<string>,
  systemPromises?: readonly SystemPromise[],
): WorldSummary {
  const value: ValueFn = (id, k) => ev.value(NodeId(id), k);
  const queues = nodeQueues(og, value);
  const verdicts: WorldVerdict[] = realAwareVerdicts(ev.verdicts, og, value, queues).map((v) => ({
    scope: String(v.scope),
    key: String(v.key),
    status: v.status,
    value: v.computed.value,
    unit: v.computed.unit,
  }));
  // The SYSTEM promises (owner ruling), judged against THIS world's whole-graph total — the same one-truth judge
  // every surface calls. A `system.cost` violation counts and names itself in the matrix like any node verdict.
  for (const v of systemPromiseVerdicts(instances, wires, value, systemPromises ?? [])) {
    verdicts.push({ scope: v.scope, key: v.key, status: v.status, value: v.computed, unit: v.unit ?? '' });
  }
  const violations = verdicts.filter((v) => v.status === 'violation').length;
  let peakRho: number | undefined;
  for (const q of queues.values()) if (Number.isFinite(q.rho)) peakRho = peakRho === undefined ? q.rho : Math.max(peakRho, q.rho);
  return {
    id: decl?.id ?? 'base',
    ...(decl?.name !== undefined ? { name: decl.name } : {}),
    costUsdMonth: systemSummary(instances, wires, value).cost.totalUsdMonth,
    feasible: violations === 0,
    violations,
    peakRho,
    verdicts,
    staleOverrides: decl === undefined ? [] : decl.overrides.filter((o) => !fixedCells.has(`${o.node}|${o.key}`)).map((o) => `${o.node}.${o.key}`),
  };
}

/** The set of `"node|key"` coordinates that are FIXED input cells in the graph — the only cells an override can
 *  substitute (a computed value cannot be a world coordinate). Used to flag stale overrides honestly. */
function fixedInputCells(graph: Graph): Set<string> {
  const out = new Set<string>();
  for (const node of graph.nodes.values()) {
    for (const c of node.cells) {
      if (c.kind === 'input' && c.value.kind === 'fixed') out.add(`${String(node.id)}|${String(c.key)}`);
    }
  }
  return out;
}

/**
 * Overlay a world's numeric overrides onto the base graph — the graph to judge SLOs against for that world. Mirrors
 * the native adapter's private overlay (and Monte-Carlo's): an override names a FIXED input cell to substitute; an
 * override on a non-fixed cell is ignored (a computed value cannot be a world coordinate). Pure engine-core surgery,
 * no solver, no domain knowledge — so the world evaluation stays domain-agnostic at the engine boundary.
 */
function applyOverrides(graph: Graph, scenario: Scenario): Graph {
  const overrides = scenario.overrides;
  if (Object.keys(overrides).length === 0) return graph;
  const nodes = new Map<NodeId, Node>(graph.nodes);
  for (const [id, node] of nodes) {
    let changed = false;
    const cells = node.cells.map((c): Cell => {
      if (c.kind !== 'input' || c.value.kind !== 'fixed') return c;
      const v = overrides[`${String(id)}|${String(c.key)}`];
      if (v === undefined) return c;
      changed = true;
      return { ...c, value: { kind: 'fixed', quantity: { ...c.value.quantity, value: v } } };
    });
    if (changed) nodes.set(id, { ...node, cells });
  }
  return { nodes, ports: graph.ports, edges: graph.edges };
}
