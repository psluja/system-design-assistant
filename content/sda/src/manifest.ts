// @feature Flow transforms & generate (per-port traffic algebra + load curves)
// @story Declare the real traffic transfer function on a port or wire ("1 request becomes 100 log
//   lines", batch 100:1, cap, probabilistic split) or make a port ORIGINATE load with generate(level)
//   plus an optional 24h load curve — and watch it flow through evaluate and simulate alike.
// @surfaces mcp (set_transform / set_wire_transform, app/mcp/src/tools.ts), web
//   (app/web/src/transform-editor.tsx + rate pills via app/presenter/src/edge-rates.ts), vscode
//   (sda.setPortTransform / setWireTransform, app/vscode/src/port-transforms.ts)
// @algorithms engine/solve/src/network/build.ts (scalar folding), content/sda/src/sim.ts (DES route
//   means), engine/sim/src/profile.ts (load-curve arithmetic)
// @docs docs/design/flow-transformations.html, docs/design/flow-transformations-r2.html,
//   docs/design/load-curves.html
// @e2e content/sda/src/transform.e2e.test.ts, content/sda/src/generator.e2e.test.ts
// @status shipped

import {
  buildGraph,
  EdgeId,
  NodeId,
  PortId,
  ProtocolId,
  Unit,
  type Band,
  type Cell,
  type Direction,
  type Edge,
  type Graph,
  type GraphError,
  type Cycle,
  type Guarantees,
  Key,
  type Node,
  type Port,
  type Result,
  type Transform,
} from '@sda/engine-core';
import { keys } from './registry';
import { categorical } from './guarantees';

// A component MANIFEST is pure DATA (doc-3): config knobs/limits, derived relations, SLO bands and
// typed ports. It references the shared vocabulary (registry keys, protocol ids) BY ID and never
// another component — the anti-dependency-hell rule. A manifest is a template; an Instance places it.

export interface ManifestPort {
  readonly name: string;
  readonly dir: Direction;
  /** ALL protocols this (consumer) port accepts — ONE flat list, a real capability set: e.g. a function
   *  invoked over HTTPS AND triggered by SQS/SNS events. Legality treats it as a set; by convention the
   *  FIRST entry is the port's natural wire protocol (used only for display/facets). Required on in/bi. */
  readonly accepts?: readonly string[];
  /** ALL protocols this (producer) port can emit — the mirror of `accepts`: a general-purpose compute can
   *  call a SQL DB, an HTTP service, a cache or an AWS API. First entry = natural protocol. Required on out/bi. */
  readonly speaks?: readonly string[];
  /** OPTIONAL per-port traffic transfer function (doc: flow-transformations): the manifest DEFAULT emission
   *  (OUT) or consumption (IN) shaping — e.g. a logging sidecar's OUT port ratio(100), an aggregator's IN port
   *  batch(100). Pure math data; an instance may override it (Instance.transforms). Absent = identity. */
  readonly transform?: Transform;
  /** OPTIONAL categorical GUARANTEE contribution this port declares (doc: guarantee-propagation §2) — the token,
   *  per dimension, a request flow's running meet combines with as it crosses this port (a writer IN =
   *  consistency:strong; a fan-out OUT = ordering:none). Sourced behaviour carried as DATA, keyed by dimension id
   *  from the `guarantees` module. Absent = no claim = the dimension's TOP. Validated against `categorical` at build. */
  readonly guarantees?: Guarantees;
}
export interface ManifestConfig {
  readonly key: Key;
  readonly value: number;
  readonly unit: string;
  /** PROVENANCE as DATA, not a code comment (doc: design-doc-v2 §3). A config's origin was, until now, only in a
   *  TS comment — invisible at runtime, so the document generator could not read it. `source` is the primary-doc
   *  URL a `documented` value is sourced from (the same URL the comment carries: an AWS quota/SLA page, the
   *  PostgreSQL docs). Present ⇒ the assumptions register badges this value `documented` and links it. Absent and
   *  not `est` ⇒ a `default` (or, once an instance overrides it, `architect`). Kept ALONGSIDE the comment. */
  readonly source?: string;
  /** Marks this default an ESTIMATE (the manifest comment convention `est.`): an AWS-typical or workload-dependent
   *  figure that is credible but not a published number (a CDN cache-hit ratio, a per-request duration). Present ⇒
   *  the register badges it `estimate`. A value is either `documented` (has `source`), an `estimate` (`est: true`),
   *  or a plain `default` — never both sourced and estimated. */
  readonly est?: true;
}
export interface ManifestRelation {
  readonly key: Key;
  readonly reads: readonly Key[];
  readonly expr: string;
}
export interface ManifestBand {
  readonly key: Key;
  readonly band: Band;
}

export interface Manifest {
  readonly type: string;
  readonly ports: readonly ManifestPort[];
  readonly config?: readonly ManifestConfig[];
  readonly relations?: readonly ManifestRelation[];
  readonly bands?: readonly ManifestBand[];
}

/** A UNIFORM uncertainty range on a config value: every value in `[lo, hi]` is equally likely. The honest shape
 *  when all that is known is a plausible interval (a traffic figure "1,500–3,000", no most-likely point). */
export interface UniformRange {
  readonly lo: number;
  readonly hi: number;
}
/** A TRIANGULAR uncertainty range: a most-likely `mode` in `[lo, hi]` with linear falloff to the bounds — the
 *  honest shape when a point estimate is known but soft (a cache-hit ratio ~0.8, credibly 0.6–0.9). */
export interface TriangularRange {
  readonly lo: number;
  readonly mode: number;
  readonly hi: number;
}
/** An OPTIONAL uncertainty RANGE on an instance config value (doc: uncertainty-monte-carlo §2) — the honest
 *  admission that a soft input is not a point. Two shapes and nothing fancier in v1: `{lo, hi}` UNIFORM or
 *  `{lo, mode, hi}` TRIANGULAR (heavier distributions need evidence we don't have; declaring them would itself
 *  be a guess). Discriminated by the presence of `mode`. Pure data with provenance, like `source`/`est` — a
 *  register row. Sampled by content's uncertainty module; the base graph always uses the point config value, so
 *  a ranged design evaluates bit-identically until a Monte-Carlo run draws from the range. */
export type Range = UniformRange | TriangularRange;

/** Is this range TRIANGULAR (has a `mode`), or UNIFORM? The single discriminator every reader shares. */
export function isTriangularRange(r: Range): r is TriangularRange {
  return (r as Partial<TriangularRange>).mode !== undefined;
}

/** A placed component: a manifest type, optional config overrides, and any scenario SLO bands. */
export interface Instance {
  readonly id: string;
  readonly type: string;
  readonly config?: Readonly<Record<string, number>>;
  readonly bands?: readonly ManifestBand[];
  /** PER-INSTANCE port transform overrides, by PORT NAME (doc: flow-transformations). The owner requirement:
   *  a transform is changeable on EVERY placed component, not only where the manifest declares one. An entry
   *  here WINS over the manifest's port transform for that port; a port absent here keeps the manifest default.
   *  An override naming a port the manifest does not have is an honest InstantiateError (never a silent drop). */
  readonly transforms?: Readonly<Record<string, Transform>>;
  /** PER-INSTANCE uncertainty RANGES (doc: uncertainty-monte-carlo §2), keyed by CONFIG KEY — the additive twin of
   *  `config`/`transforms`: a soft input declares it is a range, not a point, so a Monte-Carlo run can draw from it.
   *  Absent ⇒ the whole uncertainty feature is silent for this node (no-filler); the base graph always uses the
   *  point `config` value, so a ranged design evaluates bit-identically until sampled. A range that does not bracket
   *  its value (lo>hi, or a triangular mode outside [lo,hi]) is an honest InstantiateError naming the key — never a
   *  silent bad draw that would poison every scenario. */
  readonly ranges?: Readonly<Record<string, Range>>;
}

/** A connection between two instance ports (`[instanceId, portName]`). */
export interface Wire {
  readonly from: readonly [string, string];
  readonly to: readonly [string, string];
  readonly semantics?: 'sync' | 'async';
  /** OPTIONAL per-WIRE OUT-side transform override (doc: flow-transformations-r2 §5) — a ROUTING SPLIT a per-port
   *  transform cannot express. It WINS over the source out-port's transform for THIS wire's emission, so ONE out
   *  port can feed several wires with DIFFERENT shares (70/30). Additive: an old document without it is unchanged,
   *  and the default (absent) is the source port's transform / identity — today's broadcast fan-out. */
  readonly transform?: Transform;
  /** OPTIONAL categorical GUARANTEE the WIRE itself declares (doc: guarantee-propagation §2). Content decides what
   *  an async hop means per dimension — e.g. an async materialised-view projection wire carries consistency:eventual,
   *  so a CQRS read's eventual freshness is attributed to that exact hop. Absent = no claim = TOP. Validated at build. */
  readonly guarantees?: Guarantees;
}

/**
 * Compile manifests + instances + wiring into an engine Graph — the seam between content and the
 * domain-agnostic engine. Pure data in, a validated Graph out (or the structural errors). Config
 * overrides replace a manifest's default value for that key; instance bands add scenario SLOs.
 */
/** Instantiation can fail on CONTENT-level grounds the engine's structural GraphError cannot express —
 *  an instance referencing a type absent from every installed catalog (a hand-edited or agent-authored
 *  document is the normal way this happens). Returned as data, never thrown: the shells surface it as an
 *  honest build-problem row instead of a crash or silence. */
export type InstantiateError =
  | GraphError
  | { readonly kind: 'unknown-type'; readonly id: string; readonly type: string }
  /** A per-instance transform override (Instance.transforms) names a port the instance's manifest does not
   *  declare — surfaced as data so the shell reports "no such port" instead of silently dropping the override. */
  | { readonly kind: 'unknown-transform-port'; readonly id: string; readonly port: string }
  /** A per-instance uncertainty range (Instance.ranges) does not bracket its value — lo>hi, or a triangular mode
   *  outside [lo,hi], or a non-finite bound. Surfaced as data (naming the key + WHY) so the shell reports an honest
   *  build problem instead of silently sampling a poisoned range (doc: uncertainty-monte-carlo §2). */
  | { readonly kind: 'invalid-range'; readonly id: string; readonly key: string; readonly reason: string };

/** Why a range is unsound, or `null` when it is well-formed — the single sanity check `instantiate` and the
 *  shells share, so a Monte-Carlo run never draws from a range that cannot bracket its value. */
export function rangeProblem(range: Range): string | null {
  const { lo, hi } = range;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return `bounds must be finite numbers (got lo=${lo}, hi=${hi})`;
  if (lo > hi) return `lo ${lo} exceeds hi ${hi} — a range must bracket its value (lo ≤ hi)`;
  if (isTriangularRange(range)) {
    const { mode } = range;
    if (!Number.isFinite(mode)) return `triangular mode must be a finite number (got ${mode})`;
    if (mode < lo || mode > hi) return `triangular mode ${mode} is outside [${lo}, ${hi}]`;
  }
  return null;
}

/** One resolved GENERATOR on a placed instance (doc: load-stages §4): the port it sits on, its `level` (the
 *  BASELINE rate the cycles multiply, req/s) and its optional periodic `cycles`. Resolution is the family's own
 *  precedence — instance port override > manifest port default (wire-level generators are refused at build). */
export interface ResolvedGenerator {
  readonly port: string;
  readonly level: number;
  readonly cycles?: readonly Cycle[];
}

/**
 * The ACTIVE generators of a placed instance — `generate` transforms on its out/bi ports with level > 0 (a
 * 0-level generator is declared-but-silent, exactly like an inert `assumedRps`). The ONE resolution every
 * consumer shares (instantiate's origin lowering, the sweep/envelope origin detection, the DES projection reads
 * the same ports off the compiled graph), so "which ports generate, how much" can never drift between surfaces.
 */
export function generatorsOf(inst: Instance, m: Manifest | undefined): ResolvedGenerator[] {
  if (m === undefined) return [];
  const out: ResolvedGenerator[] = [];
  for (const p of m.ports) {
    if (p.dir === 'in') continue;
    const t = inst.transforms?.[p.name] ?? p.transform;
    if (t?.kind === 'generate' && t.level > 0) out.push({ port: p.name, level: t.level, ...(t.cycles !== undefined ? { cycles: t.cycles } : {}) });
  }
  return out;
}

/** The total level a placed instance's generators originate (Σ over its generate ports), or 0 with none — the
 *  reconciled class-blind origin figure (doc: load-curves §3 "one address for worlds / MC"). */
export function generatorLevelOf(inst: Instance, m: Manifest | undefined): number {
  return generatorsOf(inst, m).reduce((s, g) => s + g.level, 0);
}

/** The per-instance CLASS CONTEXT (doc: request-classes §4.1, R2). Present ONLY when the design declares request
 *  classes — its presence is the "classes declared" signal. It carries the reconciled per-node total origin rate
 *  (Σ over classes of each class's origin at the node, from `originByNode`). Under classes the engine injects each
 *  class's origin share separately for the per-class served split, so content must NOT fold origin into a source's
 *  throughput here — it supplies PURE CAPACITY as the node's `local(throughput)` (R1's PS cells read it as the
 *  shared ceiling) and this reconciled total as the class-blind `assumedRps` (so the shared overflow relation still
 *  reads the true total offered). Absent ⇒ the single implicit river: the origin fold runs exactly as today. */
export interface ClassContext {
  readonly originByNode: ReadonlyMap<string, number>;
}

export function instantiate(
  manifests: Readonly<Record<string, Manifest>>,
  instances: readonly Instance[],
  wires: readonly Wire[],
  classCtx?: ClassContext,
): Result<Graph, readonly InstantiateError[]> {
  const unknown: InstantiateError[] = instances
    .filter((i) => manifests[i.type] === undefined)
    .map((i) => ({ kind: 'unknown-type', id: i.id, type: i.type }));
  if (unknown.length > 0) return { ok: false, error: unknown };

  // RANGE SANITY (doc: uncertainty-monte-carlo §2): an uncertainty range must bracket its point (lo ≤ hi, a
  // triangular mode inside [lo,hi]). A range that does not is an honest build error naming the key — never a
  // silent bad draw that would poison every Monte-Carlo scenario. Validated here, independent of the manifest;
  // ranges never change the base forward evaluation (the point config value is used until sampled).
  const rangeErrors: InstantiateError[] = [];
  for (const inst of instances) {
    for (const [key, range] of Object.entries(inst.ranges ?? {})) {
      const reason = rangeProblem(range);
      if (reason !== null) rangeErrors.push({ kind: 'invalid-range', id: inst.id, key, reason });
    }
  }
  if (rangeErrors.length > 0) return { ok: false, error: rangeErrors };

  const nodes: Node[] = [];
  const ports: Port[] = [];
  const overrideErrors: InstantiateError[] = [];

  // UNIVERSAL TRAFFIC ORIGIN — a node ORIGINATES traffic (assumedRps > 0) when it acts as a SOURCE (no inbound
  // wire): it emits its own workload rather than relaying upstream load. Whether a node is a source is a TOPOLOGY
  // fact, so the fold happens HERE (where the wiring is known), not in the manifest. A RELAY keeps its throughput
  // = capacity untouched (so cost / queue / the search's ρ-headroom keep reading a true capacity). This mirrors
  // how a client seeds the flow — a client is simply a source whose whole job is to originate.
  const hasInbound = new Set(wires.map((w) => w.to[0]));
  const ORIGIN = String(keys.assumedRps);
  // Under DECLARED request classes (doc: request-classes §4.1) the per-class origins are authoritative — the
  // engine injects each class's share separately for the per-class served split (`buildNetwork` reads them off the
  // RequestClass), so content must NOT fold origin into a source's throughput here. It instead supplies PURE
  // CAPACITY as the node's `local(throughput)` (R1's PS cells read it as the shared ceiling) and RECONCILES the
  // node's class-blind `assumedRps` input to the classes' total at the node (Σ over classes, from `originByNode`) —
  // so the shared overflow relation still reads the true total offered, and the system roll-up still detects a
  // class-injected source (`hasTrafficOrigin`/`requestFlows` read `assumedRps`). Absent ⇒ the single implicit
  // river: the origin fold below runs exactly as today (the additive default, byte-for-byte).
  const classesDeclared = classCtx !== undefined;

  for (const inst of instances) {
    const m = manifests[inst.type];
    if (m === undefined) continue; // unreachable — guarded above; keeps the narrowing local

    const reconciledOrigin = classCtx?.originByNode.get(inst.id); // the classes' total origin at THIS node, or undefined
    // GENERATORS (doc: load-curves §3): `generate` on the instance's out/bi ports is the primitive traffic-origin
    // declaration; a node-level `assumedRps` is sugar for one. The RECONCILED class-blind level is the generators'
    // total — supplied on the `assumedRps` input cell, the ONE address worlds / Monte-Carlo / the envelope already
    // manipulate. An explicit instance `assumedRps` config WINS over the generator total (it is how the sweep and
    // the envelope scale an origin by rewriting config — and how a hand-edited document stays unambiguous).
    const generatorTotal = generatorLevelOf(inst, m);
    const assumedRps = inst.config?.[ORIGIN] ?? (generatorTotal > 0 ? generatorTotal : undefined) ?? (m.config ?? []).find((c) => c.key === keys.assumedRps)?.value ?? 0;
    const isSource = !hasInbound.has(inst.id);
    // A node that declares origin traffic emits it (capped by its own capacity), through the SAME `assumedRps`
    // cell in both forms. At a SOURCE the throughput becomes `min(capacity, assumedRps)` — byte-for-byte the
    // historical fold, so a migrated `assumedRps` declaration compiles to the IDENTICAL cells. A MID-CHAIN node
    // with a GENERATOR (the relay-and-generate case the port family newly allows) gets the through-flow form
    // `min(capacity, inflow + assumedRps)` — its own relation then OWNS the emission (the engine's generator rule:
    // out = local for a relation-local generator node), so the origin finally rides out of a relay. A mid-chain
    // node with only a legacy `assumedRps` config keeps today's behaviour (no fold — the recorded limitation),
    // bit for bit. NEVER under declared classes — the engine owns per-class origin injection there.
    const foldOrigin = assumedRps > 0 && !classesDeclared && (isSource || generatorTotal > 0);
    const throughputRel = (m.relations ?? []).find((r) => r.key === keys.throughput);
    const throughputCfg = (m.config ?? []).find((c) => c.key === keys.throughput);
    // Is the node's `throughput` a genuine CAPACITY, or a WORKLOAD PRESET? A node that RECEIVES work (an in/bi
    // port) serves requests, so its `throughput` is a capacity that must bound the emission (relay-and-generate:
    // served = min(capacity, inflow + level)). A PURE SOURCE (a `client.*` — no input port) declares `throughput`
    // as its throughput-AS-WORKLOAD preset (common.ts), NOT a served capacity: it originates traffic, it does not
    // serve it (and `withOverflow` gives it no overflow band for the same reason). So an ORIGIN that overrides the
    // preset — a generator on its out port, or an explicit `assumedRps` — is the AUTHORITATIVE emission and must
    // NOT be clamped by the preset. Without this, a generator/spike on a client is silently capped at the preset
    // (the owner's "peaks are not felt at the source" bug: generate(10000) on client.web emitted only 5000).
    const throughputIsCapacity = m.ports.some((p) => p.dir === 'in' || p.dir === 'bi');
    const offered = isSource ? 'self(assumedRps)' : 'inflow(throughput) + self(assumedRps)'; // a source's inflow is 0 — kept off the expr so a migrated source compiles byte-identically
    const originThroughputExpr: string | null = !foldOrigin
      ? null
      : throughputRel !== undefined
        ? `min((${throughputRel.expr}), ${offered})`
        : throughputCfg !== undefined && throughputIsCapacity
          ? `min(${throughputCfg.value}, ${offered})`
          : offered;
    const originThroughputReads: readonly Key[] = [...new Set([...(throughputRel?.reads ?? []), ...(isSource ? [] : [keys.throughput]), keys.assumedRps])];

    const cells: Cell[] = [];
    for (const c of m.config ?? []) {
      // When folding origin at a SOURCE, its throughput CONFIG becomes the derived origin-emission relation
      // (below) — skip the raw config cell so the two do not both claim the throughput key.
      if (originThroughputExpr !== null && c.key === keys.throughput) continue;
      // Under declared classes, the node's class-blind `assumedRps` input is RECONCILED to the classes' total at
      // this node (Σ over classes) — overriding the manifest/instance point so the overflow relation and the
      // roll-up read the true offered. A node no class originates at falls through to its own config default.
      // GENERATORS reconcile the same way (doc: load-curves §3): with no explicit instance config, the cell is
      // the generators' total level — the one address every override surface keeps using — while an explicit
      // instance config still wins (the sweep/envelope scale origins by writing it).
      // Under classes the classes' reconciled total wins; a node NO class originates at still reads its own
      // generator total (mirroring how its explicit `assumedRps` config behaved before migration) — the
      // generator is then flow-inert (the engine injects per-class origins only) but the overflow relation and
      // the roll-up keep seeing the true class-blind offered, exactly as the sugar did.
      const overrideOrigin = classesDeclared && c.key === keys.assumedRps ? reconciledOrigin : undefined;
      const generatorOrigin = c.key === keys.assumedRps && generatorTotal > 0 ? generatorTotal : undefined;
      const value = overrideOrigin ?? inst.config?.[c.key] ?? generatorOrigin ?? c.value;
      cells.push({ kind: 'input', key: c.key, value: { kind: 'fixed', quantity: { value, unit: Unit(c.unit) } } });
    }
    // Instance config for a key the manifest does NOT declare (e.g. a per-node behaviour knob like
    // latencyComposition, set from the inspector / set_config): still a real input cell — silently dropping
    // it would make the knob a no-op while the UI/tool reports success (the tool must not lie). The registry
    // still governs the vocabulary downstream (an unknown key fails the build with "not in registry").
    const declared = new Set<string>((m.config ?? []).map((c) => String(c.key)));
    for (const [key, value] of Object.entries(inst.config ?? {})) {
      if (declared.has(key)) continue;
      cells.push({ kind: 'input', key: Key(key), value: { kind: 'fixed', quantity: { value, unit: Unit('1') } } });
    }
    // A class ORIGIN on a component whose manifest never declared `assumedRps` (a hand-authored custom component;
    // every built-in gets it from `withOrigin`): still materialise the reconciled origin, so the source is never
    // silently dropped from the roll-up. The engine still injects the per-class rate; this only keeps the
    // class-blind `assumedRps` honest for the overflow relation and source detection.
    if (classesDeclared && reconciledOrigin !== undefined && !declared.has(ORIGIN) && inst.config?.[ORIGIN] === undefined) {
      cells.push({ kind: 'input', key: keys.assumedRps, value: { kind: 'fixed', quantity: { value: reconciledOrigin, unit: Unit('req/s') } } });
    }
    // A GENERATOR on a component whose manifest never declared `assumedRps` (a hand-authored custom component):
    // materialise the reconciled cell the same way, so the level stays world/MC-addressable and the roll-up sees
    // the origin (doc: load-curves §3). Built-ins get the cell from `withOrigin`'s default via the loop above.
    if (generatorTotal > 0 && !declared.has(ORIGIN) && inst.config?.[ORIGIN] === undefined && (!classesDeclared || reconciledOrigin === undefined)) {
      cells.push({ kind: 'input', key: keys.assumedRps, value: { kind: 'fixed', quantity: { value: generatorTotal, unit: Unit('req/s') } } });
    }
    for (const r of m.relations ?? []) {
      // Replace the throughput relation with the origin-emission relation at a folding source (see above).
      if (originThroughputExpr !== null && r.key === keys.throughput) continue;
      cells.push({ kind: 'derived', key: r.key, relation: { produces: r.key, reads: r.reads, expr: r.expr } });
    }
    if (originThroughputExpr !== null)
      cells.push({ kind: 'derived', key: keys.throughput, relation: { produces: keys.throughput, reads: originThroughputReads, expr: originThroughputExpr } });
    for (const b of [...(m.bands ?? []), ...(inst.bands ?? [])]) {
      cells.push({ kind: 'input', key: b.key, value: { kind: 'band', band: b.band } });
    }

    const nodeId = NodeId(inst.id);
    const portIds: PortId[] = [];
    // Per-instance transform overrides WIN over the manifest port's default (owner requirement: changeable on
    // every placed component). An override naming a port the manifest lacks is an honest error (below), never
    // silently applied to nothing — the tool must not lie about a knob it dropped.
    const overrides = inst.transforms ?? {};
    const portNames = new Set(m.ports.map((p) => p.name));
    for (const name of Object.keys(overrides)) {
      if (!portNames.has(name)) overrideErrors.push({ kind: 'unknown-transform-port', id: inst.id, port: name });
    }
    for (const p of m.ports) {
      const pid = PortId(`${inst.id}.${p.name}`);
      portIds.push(pid);
      const transform = overrides[p.name] ?? p.transform; // instance override wins; else manifest default; else none
      ports.push({
        id: pid,
        node: nodeId,
        dir: p.dir,
        ...(p.accepts ? { accepts: p.accepts.map(ProtocolId) } : {}),
        ...(p.speaks ? { speaks: p.speaks.map(ProtocolId) } : {}),
        ...(transform ? { transform } : {}),
        // The port's declared guarantee contribution rides onto the engine Port as opaque tokens; the meaning is
        // in `guarantees`/the registry categorical section, validated by buildGraph below. Absent ⇒ no claim.
        ...(p.guarantees ? { guarantees: p.guarantees } : {}),
      });
    }
    nodes.push({ id: nodeId, ports: portIds, cells });
  }
  if (overrideErrors.length > 0) return { ok: false, error: overrideErrors };

  // A wire's OPTIONAL per-wire transform (doc: flow-transformations-r2 §5) rides onto its engine edge as the
  // OUT-side override. Well-formedness is validated by buildGraph (edge-transform-value), the same discipline as a
  // port transform — so a malformed wire split is an honest build error, never silently applied.
  const edges: Edge[] = wires.map((w, i) => ({
    id: EdgeId(`e${i}`),
    from: PortId(`${w.from[0]}.${w.from[1]}`),
    to: PortId(`${w.to[0]}.${w.to[1]}`),
    semantics: w.semantics ?? 'sync',
    ...(w.transform ? { transform: w.transform } : {}),
    // A wire's declared guarantee (e.g. an async projection hop = consistency:eventual) rides onto the engine
    // edge; validated against the categorical vocabulary by buildGraph, like a port's.
    ...(w.guarantees ? { guarantees: w.guarantees } : {}),
  }));

  // Pass the categorical vocabulary so any mislabelled guarantee (unknown dimension/token) is an honest build
  // error, exactly as an unregistered numeric key fails the network build. A guarantee-free document is unaffected.
  return buildGraph({ nodes, ports, edges }, categorical);
}
