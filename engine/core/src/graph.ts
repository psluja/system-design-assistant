import type { EdgeId, Key, NodeId, PortId, ProtocolId } from './ids';
import type { Categorical, DimensionId, DimensionToken, Guarantees } from './lattice';
import { type Result, err, ok } from './result';
import type { InputValue } from './value';

/** A derived key, computed by an authored relation that reads other keys (doc-2 §3, §6). */
export interface Relation {
  readonly produces: Key;
  readonly reads: readonly Key[];
  /** Authored expression source (the readable MiniZinc-subset, doc-4 §10). Opaque to engine/core. */
  readonly expr: string;
}

/** One (owner, key) slot: an input assumption or a derived relation (doc-4 §2). */
export type Cell =
  | { readonly kind: 'input'; readonly key: Key; readonly value: InputValue }
  | { readonly kind: 'derived'; readonly key: Key; readonly relation: Relation };

export type Direction = 'in' | 'out' | 'bi';

/**
 * One k6/Gatling-style STAGE (doc: load-stages §4) — one step of a generator's schedule. Over `durationS`
 * seconds the generator's rate ramps LINEARLY to `multiplier` × its baseline `level`. Reaching a target and
 * holding it is a stage whose multiplier equals the previous one; a hard step is a stage of near-zero duration.
 * `×1` is the BASELINE (= the level itself). Pure math data like {@link Transform}; the engine stays agnostic
 * about what the flow MEANS. REPLACES the drawn LoadCurve/LoadCurvePoint — there is ONE shape atom, not two.
 */
export interface Stage {
  /** > 0 — the ramp/hold duration in seconds (a hard step is the shortest representable ramp). */
  readonly durationS: number;
  /** ≥ 0 — the TARGET multiplier reached at the END of this stage (`×1` = the baseline `level`). */
  readonly multiplier: number;
}

/**
 * One periodic shaping CYCLE (doc: load-stages §4-§5) — an ordered `stages` schedule that REPEATS every
 * `periodS` seconds. The shape starts at `×1` (the baseline) at t = 0, ramps linearly through each stage's
 * vertex `(Σ durationS ≤ i, multiplierᵢ)`, then holds `×1` to `periodS` and WRAPS. Several cycles on ONE
 * generator MULTIPLY into one stream (a daily curve × a quarterly curve — load-stages §5); the product is
 * evaluated as λ(t) = level · Π multiplierᵢ(t). A one-shot launch spike is a cycle whose `periodS` exceeds the
 * observed span, so it plays once. Empty `cycles` (or a cycle whose multipliers are all `×1`) = a FLAT
 * generator, byte-identical to today's steady `generate(level)`. Pure timing data — the mean and peak are
 * DERIVED (content), and the scalar pass never reads a cycle (the shape does not cross the scalar boundary).
 */
export interface Cycle {
  /** > 0 — the tiling period in seconds. `Σ stages.durationS ≤ periodS` (the baseline tail closes the period). */
  readonly periodS: number;
  /** The k6/Gatling schedule that repeats every `periodS`; non-empty, with at least one `multiplier > 0`. */
  readonly stages: readonly Stage[];
}

/**
 * A per-port TRANSFER FUNCTION — a closed set of pure-arithmetic transforms the engine applies to a
 * FLOW-flagged quantity as it crosses a port (doc: flow-transformations §3). Purely MATH data: `value` is the
 * single scalar parameter, `kind` the function shape; the engine stays agnostic about what the flow MEANS.
 * Semantics, with `x` the value entering the port:
 *   - `ratio`  : out = value · x          (linear scaling; value < 1 reduces, value > 1 amplifies)
 *   - `batch`  : out = x / value          (n : 1 reduction — sugar over ratio(1/value), kept a distinct tag)
 *   - `cap`    : out = min(x, value)      (a steady-state ceiling; the excess is the caller's overflow)
 *   - `window` : out = min(x, 1000/value) (a ceiling parameterised as a per-`value`-unit window)
 *   - `prob`   : out = value · x          (scalar mean; the DES draws a per-item Bernoulli — value ∈ (0, 1])
 *   - `generate`: the port ORIGINATES flow instead of reshaping it (doc: load-stages §4) — the sixth member.
 *     `level` is the BASELINE rate it originates (the `×1` the cycles multiply — load-stages tension 1, ratified);
 *     the optional `cycles` are the periodic shapes riding the generator (they MULTIPLY within a generator —
 *     load-stages §5), and `disable` is a live off-switch that keeps the authored cycles but evaluates the
 *     generator as flat. Its emission arithmetic lives at the NODE, not the edge: generated flow consumes the
 *     host node's own capacity and the served share exits this port (injection semantics — "a cron eats its
 *     host"), so the edge-seam function of a generate port is the identity over the node's served value (see
 *     applyTransform and engine/solve build). A generator is a PORT function in R1: it may sit on an out/bi port
 *     (manifest, instance override), never on an in port and never as a per-WIRE override — both refused at build.
 * Default everywhere (a port with NO transform) = identity, i.e. ratio(1) — today's behaviour, bit for bit.
 */
export type Transform =
  | { readonly kind: 'ratio'; readonly value: number }
  | { readonly kind: 'batch'; readonly value: number }
  | { readonly kind: 'cap'; readonly value: number }
  | { readonly kind: 'window'; readonly value: number }
  | { readonly kind: 'prob'; readonly value: number }
  | {
      readonly kind: 'generate';
      readonly level: number;
      /** REPLACES `curve?: LoadCurve` — the superimposed periodic shapes (load-stages §4-§5). Empty/absent = flat. */
      readonly cycles?: readonly Cycle[];
      /** Live off-switch: the authored `cycles` are kept but ignored, so the generator evaluates as flat `level`. */
      readonly disable?: boolean;
    };

/**
 * The SCALAR twin of a transform: given a numeric flow `x` entering a port, return the flow leaving it.
 * This is the CANONICAL, single-source definition of the transform arithmetic — the symbolic `transformExpr`
 * in engine/solve (which builds the fixpoint expression the JS hot path and the MiniZinc emitter both project)
 * mirrors it term-for-term, and the JS↔MZN differential test pins that they agree. Presenters (edge-rate labels)
 * MUST import this rather than re-implement it, so the number on the wire is the solver's number by construction
 * (the "web is a dumb renderer" / anti-drift rule). `undefined` is identity — a transform-free port is a no-op.
 *
 * NOTE ON `cap` / `window`: these are steady-state rate CEILINGS on the FORWARD flow — exactly what this returns.
 * The DES route model uses a DIFFERENT, mean-multiplicity factor (a memoryless per-completion edge cannot see the
 * offered rate, so it does not thin for a ceiling); that intentional divergence lives in content's sim projector.
 */
export function applyTransform(t: Transform | undefined, x: number): number {
  if (t === undefined) return x;
  switch (t.kind) {
    case 'ratio': // out = value · x
    case 'prob': // scalar mean = value · x (the DES draws a per-item Bernoulli whose mean is this)
      return t.value * x;
    case 'batch': // out = x / value  (n : 1 aggregation)
      return x / t.value;
    case 'cap': // out = min(x, value)  (a steady-state throttle; the excess is the caller's overflow)
      return Math.min(x, t.value);
    case 'window': // out = min(x, 1000/value)  (a ceiling: at most one flush per `value` ms)
      return Math.min(x, 1000 / t.value);
    case 'generate': // identity at the edge seam: a generator ORIGINATES flow at its NODE (the level enters the
      // node's served value — through-flow + served level, capacity-gated, in engine/solve build), so the value
      // crossing the port is already the node's emission. The port function reshapes nothing (doc: load-curves §3
      // — `generate` replaces the reshaping slot). Presenters labelling a generate port's wire therefore show the
      // node's served value, which is the solver's number by construction.
      return x;
  }
}

export interface Port {
  readonly id: PortId;
  readonly node: NodeId;
  readonly dir: Direction;
  /** ALL protocols a CONSUMER (in/bi) port accepts — one flat list, treated as a SET by legality. Lets one
   *  input model a component that can be driven several ways — e.g. a function invoked over HTTPS OR by an
   *  SQS/SNS event. By convention the FIRST entry is the port's natural wire protocol (display only).
   *  Optional; its absence means "protocol legality not checked here". */
  readonly accepts?: readonly ProtocolId[];
  /** ALL protocols a PRODUCER (out/bi) port can emit — the mirror of `accepts`: a general-purpose compute
   *  (a function / service) can CALL any backend — SQL, HTTP, a cache, an AWS API — so its outbound port
   *  speaks many client protocols. First entry = the natural wire protocol (display convention). */
  readonly speaks?: readonly ProtocolId[];
  /** OPTIONAL per-port transfer function applied to a FLOW-flagged quantity crossing this port (default =
   *  identity). On an OUT port it shapes what the port EMITS onto its edges (the sender's emission); on an IN
   *  port it shapes what the port INTAKES from its incoming edges (the receiver's consumption). Pure math data;
   *  what the flow means and which port carries which transform is CONTENT — the engine only does the arithmetic. */
  readonly transform?: Transform;
  /** OPTIONAL categorical GUARANTEE contribution this port declares (doc: guarantee-propagation §2): the token,
   *  per dimension, the flow's running meet is combined with as it crosses this port. A SOURCE's OUT port carries
   *  the guarantee it PROVIDES (an Aurora writer's OUT = consistency:strong); a hop's port DEGRADES it (a
   *  fan-out's OUT = ordering:none). Absent, or a dimension absent from the record, = "no claim" = the dimension's
   *  TOP (a no-op meet). Opaque tokens keyed by dimension id — meaning is CONTENT; the engine only meets them. */
  readonly guarantees?: Guarantees;
}

export interface Node {
  readonly id: NodeId;
  readonly ports: readonly PortId[];
  readonly cells: readonly Cell[];
}

export interface Edge {
  readonly id: EdgeId;
  readonly from: PortId;
  readonly to: PortId;
  readonly semantics: 'sync' | 'async';
  /** OPTIONAL per-WIRE OUT-side transfer function (doc: flow-transformations-r2 §5) — a ROUTING SPLIT that a
   *  per-port transform cannot express. When set it OVERRIDES the source out-port's transform for THIS edge's
   *  emission (f_out), so one out port can feed several edges with DIFFERENT shares (e.g. prob(0.7) on one wire,
   *  prob(0.3) on another — a 70/30 split). Absent ⇒ the source port's transform (or identity) applies — today's
   *  broadcast behaviour, bit for bit. The IN-side stays PORT-level (consumption shape is the receiver's, one per
   *  in-port). Pure math data; what the flow means is CONTENT — the engine only does the arithmetic. */
  readonly transform?: Transform;
  /** OPTIONAL categorical GUARANTEE contribution this EDGE declares (doc: guarantee-propagation §2). Content
   *  decides what an async edge means per dimension (e.g. an async projection hop contributes consistency:eventual)
   *  — the engine just meets the token into the flow's running value at this hop. Absent = "no claim" = TOP.
   *  Same opaque-token vocabulary as a port's `guarantees`; validated against the categorical section in buildGraph. */
  readonly guarantees?: Guarantees;
}

/** A structurally-valid design graph. Construct via {@link buildGraph}; an invalid one is unrepresentable. */
export interface Graph {
  readonly nodes: ReadonlyMap<NodeId, Node>;
  readonly ports: ReadonlyMap<PortId, Port>;
  readonly edges: ReadonlyMap<EdgeId, Edge>;
}

export type GraphError =
  | { readonly kind: 'duplicate-node'; readonly id: NodeId }
  | { readonly kind: 'duplicate-port'; readonly id: PortId }
  | { readonly kind: 'duplicate-edge'; readonly id: EdgeId }
  | { readonly kind: 'port-unknown-node'; readonly port: PortId; readonly node: NodeId }
  | { readonly kind: 'edge-unknown-port'; readonly edge: EdgeId; readonly port: PortId }
  | { readonly kind: 'edge-direction'; readonly edge: EdgeId }
  /** A port's transform carries an out-of-range parameter: every reshaping kind needs `value > 0` (a 0 or negative
   *  ratio/batch/cap/window is not a meaningful traffic transfer), `prob` additionally needs `value ≤ 1`
   *  (a probability), and `generate` needs a finite `level ≥ 0` plus well-formed cycles (see `cyclesProblem`).
   *  Caught here so a malformed transform is unrepresentable in a built graph. */
  | { readonly kind: 'transform-value'; readonly port: PortId; readonly transform: Transform }
  /** An EDGE's per-wire transform carries an out-of-range parameter — the same well-formedness rule as a port's
   *  (`validTransform`), reported against the edge so a malformed wire-level split is unrepresentable in a built graph. */
  | { readonly kind: 'edge-transform-value'; readonly edge: EdgeId; readonly transform: Transform }
  /** A `generate` sits on an IN port (doc: load-curves §3 validation): a generator ORIGINATES flow, so it lives on
   *  an out/bi port — refused naming the port and its direction so the fix is guided, never a silent no-op. */
  | { readonly kind: 'generate-on-in-port'; readonly port: PortId }
  /** A `generate` rides a per-WIRE transform override. R1 scopes generators to PORTS (a wire-level generator is a
   *  documented later round of load-curves §3); refused honestly rather than silently treated as identity. */
  | { readonly kind: 'generate-on-edge'; readonly edge: EdgeId }
  /** A port/edge `guarantees` names a DIMENSION not declared in the categorical vocabulary — an unknown
   *  categorical key. Caught here (given a `categorical`) so a mislabelled contribution is unrepresentable in a
   *  built graph, exactly as an unregistered numeric key fails the network build. `scope` is the offending port/edge. */
  | { readonly kind: 'guarantee-unknown-dimension'; readonly scope: PortId | EdgeId; readonly dimension: DimensionId }
  /** A port/edge `guarantees` names a TOKEN not in its dimension's lattice (a typo'd 'strogn' for 'strong', or a
   *  token from another dimension). Caught here so a token the meet could not rank is unrepresentable in a built graph. */
  | { readonly kind: 'guarantee-unknown-token'; readonly scope: PortId | EdgeId; readonly dimension: DimensionId; readonly token: DimensionToken };

/**
 * Build a validated graph from raw parts, collecting ALL structural errors (not just the first).
 * Makes an inconsistent graph — dangling edges, duplicate ids, out←out wiring — impossible to hold.
 *
 * `categorical` is OPTIONAL: when supplied, every port/edge `guarantees` contribution is validated against it
 * (unknown dimension or token = a GraphError), so a mislabelled guarantee is unrepresentable in a built graph.
 * Omitted (or a graph with no `guarantees` anywhere) ⇒ the guarantee check is a no-op and the build is
 * bit-for-bit as before — the whole feature stays silent for a design that declares none (the no-filler rule).
 */
export function buildGraph(
  parts: {
    readonly nodes: readonly Node[];
    readonly ports: readonly Port[];
    readonly edges: readonly Edge[];
  },
  categorical?: Categorical,
): Result<Graph, readonly GraphError[]> {
  const errors: GraphError[] = [];

  const nodes = new Map<NodeId, Node>();
  for (const n of parts.nodes) {
    if (nodes.has(n.id)) errors.push({ kind: 'duplicate-node', id: n.id });
    else nodes.set(n.id, n);
  }

  const ports = new Map<PortId, Port>();
  for (const p of parts.ports) {
    if (ports.has(p.id)) errors.push({ kind: 'duplicate-port', id: p.id });
    else ports.set(p.id, p);
    if (!nodes.has(p.node)) errors.push({ kind: 'port-unknown-node', port: p.id, node: p.node });
    if (p.transform !== undefined && !validTransform(p.transform)) errors.push({ kind: 'transform-value', port: p.id, transform: p.transform });
    // A generator originates flow, so it lives on an out/bi port only (doc: load-curves §3) — an in-port generate
    // would be a silent no-op (nothing consumes an in-port's "emission"), so it is refused, naming the port.
    if (p.transform?.kind === 'generate' && p.dir === 'in') errors.push({ kind: 'generate-on-in-port', port: p.id });
    checkGuarantees(p.id, p.guarantees, categorical, errors);
  }

  const edges = new Map<EdgeId, Edge>();
  for (const e of parts.edges) {
    if (edges.has(e.id)) errors.push({ kind: 'duplicate-edge', id: e.id });
    else edges.set(e.id, e);
    const from = ports.get(e.from);
    const to = ports.get(e.to);
    if (!from) errors.push({ kind: 'edge-unknown-port', edge: e.id, port: e.from });
    if (!to) errors.push({ kind: 'edge-unknown-port', edge: e.id, port: e.to });
    if (from && to && !canConnect(from.dir, to.dir)) errors.push({ kind: 'edge-direction', edge: e.id });
    if (e.transform !== undefined && !validTransform(e.transform)) errors.push({ kind: 'edge-transform-value', edge: e.id, transform: e.transform });
    // R1 scopes `generate` to PORTS (a wire-level generator is a later load-curves round) — refused honestly.
    if (e.transform?.kind === 'generate') errors.push({ kind: 'generate-on-edge', edge: e.id });
    checkGuarantees(e.id, e.guarantees, categorical, errors);
  }

  return errors.length > 0 ? err(errors) : ok({ nodes, ports, edges });
}

/** Validate one port/edge's guarantee record against the categorical vocabulary. No `categorical` (or no
 *  `guarantees`) ⇒ a no-op, so a guarantee-free graph builds exactly as before. Each unknown dimension/token is
 *  reported separately (against the offending scope) so content sees every mislabel at once. */
function checkGuarantees(scope: PortId | EdgeId, guarantees: Guarantees | undefined, categorical: Categorical | undefined, errors: GraphError[]): void {
  if (guarantees === undefined || categorical === undefined) return;
  for (const [dim, token] of Object.entries(guarantees)) {
    const dimension = dim as DimensionId;
    const lattice = categorical.get(dimension);
    if (lattice === undefined) {
      errors.push({ kind: 'guarantee-unknown-dimension', scope, dimension });
      continue;
    }
    if (lattice.rank(token) === undefined) errors.push({ kind: 'guarantee-unknown-token', scope, dimension, token });
  }
}

/** An edge is structurally legal only out|bi → in|bi. (Protocol/permission legality is a separate concern.) */
function canConnect(from: Direction, to: Direction): boolean {
  return (from === 'out' || from === 'bi') && (to === 'in' || to === 'bi');
}

/** A transform is well-formed iff its parameter is finite and `> 0` (a non-positive ratio/batch/cap/window is
 *  not a meaningful transfer), `prob` additionally lies in (0, 1] (it is a probability), and `generate` carries a
 *  finite `level ≥ 0` (0 = a declared-but-silent generator, like an inert origin) plus well-formed cycles. */
function validTransform(t: Transform): boolean {
  if (t.kind === 'generate') {
    if (!Number.isFinite(t.level) || t.level < 0) return false;
    return t.cycles === undefined || cyclesProblem(t.cycles) === null;
  }
  if (!Number.isFinite(t.value) || t.value <= 0) return false;
  return t.kind !== 'prob' || t.value <= 1;
}

/**
 * Why a generator's {@link Cycle} list is malformed, or `null` when it is well-formed — the guided-error
 * discipline (doc: load-stages §4 validation, the `ranges` precedent): every rule names the fix, never a silent
 * divide-by-zero. Structural only — an EMPTY list is legal (a flat generator, silent). For each cycle: `periodS`
 * is positive/finite; `stages` is non-empty; every `durationS > 0`; every `multiplier ≥ 0`; and `Σ durationS ≤
 * periodS` (the stages fit inside one period, leaving the baseline tail). ACROSS the cycles, at least one
 * `multiplier > 0` (an all-zero shape has no traffic — refused, naming the fix). The mean/peak ARITHMETIC has its
 * one home in content, not here. Shared by buildGraph and every content/shell validator so the boundary cannot
 * drift. REPLACES `loadCurveProblem` — one validator repurposed, not a second.
 */
export function cyclesProblem(cycles: readonly Cycle[]): string | null {
  let anyPositive = false;
  for (const cycle of cycles) {
    if (!Number.isFinite(cycle.periodS) || cycle.periodS <= 0) return `periodS must be a positive number of seconds (got ${cycle.periodS})`;
    if (cycle.stages.length === 0) return 'a cycle needs at least one stage (each is {durationS > 0, multiplier ≥ 0})';
    let total = 0;
    for (const s of cycle.stages) {
      if (!Number.isFinite(s.durationS) || s.durationS <= 0) return `stage durationS=${s.durationS} must be a positive number of seconds`;
      if (!Number.isFinite(s.multiplier) || s.multiplier < 0) return `stage multiplier=${s.multiplier} must be a finite number ≥ 0 (×1 = the baseline)`;
      if (s.multiplier > 0) anyPositive = true;
      total += s.durationS;
    }
    if (total > cycle.periodS) return `the stages total ${total}s but periodS is ${cycle.periodS}s — Σ durationS must be ≤ periodS`;
  }
  if (cycles.length > 0 && !anyPositive) return 'every multiplier is 0 — an all-zero shape has no traffic; raise at least one stage above 0';
  return null;
}
