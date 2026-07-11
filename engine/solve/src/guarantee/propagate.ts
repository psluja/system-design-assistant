import type { Categorical, DimensionId, DimensionToken, EdgeId, Graph, Guarantees, Lattice, NodeId, PortId, Status } from '@sda/engine-core';

// @algorithm Lattice-meet propagation along request paths (categorical guarantees)
// @problem Qualitative guarantees (consistency, ordering, delivery) must be COMPUTED end-to-end with
//   a provable root cause, not eyeballed: which hop weakened the flow, and what survives at the
//   terminal?
// @approach Enumerate simple source->terminal paths by DFS (cycles cut), then fold each dimension's
//   tokens with the lattice MEET ("the weaker hop wins"), recording the FIRST strict drop of the
//   running meet as the root cause; meet monotonicity makes that attribution a theorem, and an
//   independent DataScript max-rank query is the differential reference for the final token.
// @complexity Meet fold O(contributions) per dimension; simple-path enumeration is exponential in
//   the worst case but paths are cycle-cut and design graphs are small.
// @citations Lattice theory (meet-semilattice folklore, Birkhoff); monotone dataflow analysis
//   framing (Kam & Ullman 1977).
// @invariants The running meet never strengthens (monotone — property-tested); first strict drop =
//   provable root cause; a path touching the declared-unknown token can never yield a certain
//   verdict; tokens are opaque — the engine names no guarantee.
// @where-tested engine/solve/src/guarantee/propagate.test.ts (monotonicity property + DataScript
//   differential)

// GUARANTEE PROPAGATION (doc: guarantee-propagation §2, §3) — the categorical counterpart of the numeric
// cell-network. Where the cell-network folds NUMBERS along the whole topology to a fixpoint, this folds
// qualitative TOKENS along ONE request path with a single mechanism: the lattice MEET ("the weaker hop wins").
//
// The result per flow per dimension is the final token PLUS the first hop where the running meet dropped —
// deterministic root-cause attribution, the same cause-chain discipline as every numeric verdict. Because meet
// is monotone (a hop can only weaken, never strengthen), the FIRST drop below any requirement is the provable
// root cause; this is a THEOREM, pinned by the monotonicity property test and the DataScript differential.
//
// The engine stays domain-agnostic: tokens are opaque strings, dimensions come from the registry's categorical
// section (content), and this module never names a guarantee. It only walks paths and meets tokens.

/** One CONTRIBUTION to a flow's guarantee: the tokens a single hop (a source's out-port, a crossed edge, a
 *  target's in-port) declares, tagged with WHERE it came from so a drop can be attributed to that exact scope. */
export interface Contribution {
  /** The port or edge that declared this contribution — the root-cause scope reported if the meet drops here. */
  readonly scope: PortId | EdgeId;
  /** The node this contribution sits at (the source for its out-port, the target for the edge + its in-port),
   *  so a verdict can name the offending NODE (a fan-out topic) alongside the precise port/edge. */
  readonly node: NodeId;
  readonly guarantees: Guarantees;
}

/** The propagated result for ONE dimension along ONE flow (doc: guarantee-propagation §2). */
export interface DimensionResult {
  readonly dimension: DimensionId;
  /** The end-to-end token: the meet of every contribution's token for this dimension (TOP if none contributed). */
  readonly token: DimensionToken;
  /** The FIRST hop that strictly weakened the running meet — the provable root cause — or null if the path never
   *  dropped below TOP (every hop was a no-op or re-stated the same token). Deterministic: the earliest drop wins. */
  readonly rootCause: { readonly scope: PortId | EdgeId; readonly node: NodeId; readonly from: DimensionToken; readonly to: DimensionToken } | null;
  /** True iff SOME contribution's token for this dimension is the dimension's declared-unknown token. A path that
   *  touches unknown cannot claim certainty — the verdict layer reads this to return `unknown`, never a fake ok
   *  (doc: guarantee-propagation §3 "refused → unknown"). Independent of `token`, which still meets normally. */
  readonly touchedUnknown: boolean;
}

/**
 * Fold a lattice's meet along an ordered contribution list, tracking the first strict drop. Pure and total: the
 * ONE place the categorical arithmetic lives (the differential's reference side mirrors it). Starts at the
 * lattice TOP — meeting with TOP is the identity, so a flow whose contributions are all no-ops (or absent for
 * this dimension) stays at TOP (its strongest guarantee), and only a real weaker token moves it down.
 */
export function propagateDimension(lattice: Lattice, contributions: readonly Contribution[]): DimensionResult {
  let running = lattice.top();
  let rootCause: DimensionResult['rootCause'] = null;
  let touchedUnknown = false;
  const unknownToken = lattice.unknown;
  for (const c of contributions) {
    const token = c.guarantees[lattice.id];
    if (token === undefined) continue; // this hop makes no claim for this dimension ⇒ a no-op meet (TOP)
    if (unknownToken !== undefined && token === unknownToken) touchedUnknown = true;
    const next = lattice.meet(running, token);
    // A STRICT drop (the meet is weaker than the running value) attributes the root cause to THIS hop — but only
    // the FIRST such drop is the reported cause; later drops are its consequences. Compared by identity because
    // meet returns one of its two arguments; a re-statement of the same token (next === running) is NOT a drop.
    if (next !== running && rootCause === null) rootCause = { scope: c.scope, node: c.node, from: running, to: next };
    running = next;
  }
  return { dimension: lattice.id, token: running, rootCause, touchedUnknown };
}

/** A FLOW's guarantees: the source, terminal and the per-dimension propagated results (only the dimensions the
 *  vocabulary declares appear; a dimension no hop touched still reports TOP with a null root cause — honest that
 *  the path preserves it). */
export interface FlowGuarantees {
  readonly source: NodeId;
  readonly terminal: NodeId;
  readonly dimensions: readonly DimensionResult[];
}

/**
 * Build the ordered CONTRIBUTION list for a path expressed as its edge sequence (source → … → terminal). Each
 * edge contributes, IN PATH ORDER: the source out-port's guarantee (the emission that starts the running label
 * at the first edge, and the upstream node's per-hop claim thereafter), the edge's own guarantee (content
 * decides what an async hop means per dimension), then the target in-port's guarantee (the reception). This is
 * the single definition of "which scopes a flow's guarantee passes through", reused by both the engine walk and
 * the DataScript differential so they cannot disagree on the contribution order.
 */
export function contributionsAlong(graph: Graph, edgePath: readonly EdgeId[]): readonly Contribution[] {
  const out: Contribution[] = [];
  for (const edgeId of edgePath) {
    const edge = graph.edges.get(edgeId);
    if (edge === undefined) continue; // a caller passing a bogus edge id gets it skipped, never a throw
    const fromPort = graph.ports.get(edge.from);
    const toPort = graph.ports.get(edge.to);
    if (fromPort === undefined || toPort === undefined) continue;
    if (fromPort.guarantees !== undefined) out.push({ scope: fromPort.id, node: fromPort.node, guarantees: fromPort.guarantees });
    if (edge.guarantees !== undefined) out.push({ scope: edge.id, node: toPort.node, guarantees: edge.guarantees });
    if (toPort.guarantees !== undefined) out.push({ scope: toPort.id, node: toPort.node, guarantees: toPort.guarantees });
  }
  return out;
}

/**
 * Propagate guarantees along ONE path (its edge sequence) over EVERY declared dimension. `source`/`terminal`
 * are carried through for attribution; the edge path is assumed to run source → terminal (the caller — an
 * enumerator or content flow — picks it). Deterministic: dimensions are returned in the vocabulary's order.
 */
export function propagatePath(graph: Graph, categorical: Categorical, path: { readonly source: NodeId; readonly terminal: NodeId; readonly edges: readonly EdgeId[] }): FlowGuarantees {
  const contributions = contributionsAlong(graph, path.edges);
  const dimensions = categorical.dimensions
    .map((id) => categorical.get(id))
    .filter((l): l is Lattice => l !== undefined)
    .map((l) => propagateDimension(l, contributions));
  return { source: path.source, terminal: path.terminal, dimensions };
}

/**
 * Enumerate the simple source→terminal paths as ordered edge sequences. Cycles are cut (a node is never revisited
 * within one path), so enumeration always terminates. Deterministic: each node's out-edges are explored in edge-id
 * order, so path order — and the edge order within a path — is stable across runs. The ONE walker every propagation
 * variant (whole-path result AND the per-edge strip) reads, so a surface can never disagree with a verdict on which
 * edges a flow's guarantee passes through.
 */
export function enumerateFlowPaths(graph: Graph, source: NodeId, terminal: NodeId): readonly (readonly EdgeId[])[] {
  const outEdges = new Map<NodeId, EdgeId[]>();
  for (const [id, edge] of graph.edges) {
    const fromPort = graph.ports.get(edge.from);
    if (fromPort === undefined) continue;
    const list = outEdges.get(fromPort.node);
    if (list === undefined) outEdges.set(fromPort.node, [id]);
    else list.push(id);
  }
  // Deterministic exploration: sort each node's out-edges by id so path order is stable across runs.
  for (const list of outEdges.values()) list.sort();

  const paths: EdgeId[][] = [];
  const visited = new Set<NodeId>();
  const stack: EdgeId[] = [];
  const walk = (node: NodeId): void => {
    if (node === terminal) {
      paths.push([...stack]);
      return; // a terminal ends the path even if it has further out-edges (its own metrics are the flow's end)
    }
    visited.add(node);
    for (const edgeId of outEdges.get(node) ?? []) {
      const edge = graph.edges.get(edgeId);
      if (edge === undefined) continue;
      const toPort = graph.ports.get(edge.to);
      if (toPort === undefined || visited.has(toPort.node)) continue; // cut cycles / already-on-path nodes
      stack.push(edgeId);
      walk(toPort.node);
      stack.pop();
    }
    visited.delete(node);
  };
  walk(source);
  return paths;
}

/**
 * Propagate guarantees along every simple source→terminal path. A flow with a fan-out has SEVERAL paths
 * (source→topic→worker-A, source→topic→worker-B); every one is returned so a per-consumer requirement can be judged
 * on ITS path. Deterministic order: paths follow `enumerateFlowPaths`; within a result dimensions follow the
 * vocabulary order.
 *
 * This is the engine seam a content flow-projector calls: it hands (source, terminal) — the same source/terminal
 * content already computes for numeric roll-ups (requestFlows) — and gets back the categorical verdict inputs.
 */
export function propagateFlow(graph: Graph, categorical: Categorical, source: NodeId, terminal: NodeId): readonly FlowGuarantees[] {
  return enumerateFlowPaths(graph, source, terminal).map((edges) => propagatePath(graph, categorical, { source, terminal, edges }));
}

/** The running-meet state at ONE edge of a path, for ONE dimension — the per-edge datum a canvas STRIP paints:
 *  the token BEFORE this edge's contributions, the token AFTER them, and whether the path has touched the
 *  declared-unknown token by this point. `edge` is the graph edge id (the caller maps it to its `w${i}` wire). */
export interface EdgeMeet {
  readonly edge: EdgeId;
  readonly from: DimensionToken;
  readonly to: DimensionToken;
  readonly touchedUnknown: boolean;
}

/** One path's per-edge running meet for one dimension (source→terminal edge order) — a strip walks these in order,
 *  colouring each edge teal while `to` still satisfies the floor and red from the first edge whose `to` drops below. */
export interface PathEdgeMeets {
  readonly edges: readonly EdgeMeet[];
}

/**
 * Fold ONE dimension's meet along each source→terminal path, EXPOSING the per-edge running-meet transition (not
 * just the whole-path result). This is the strip's data source: for each path, walk its edges in order and record,
 * at each edge, the running token before and after that edge's contributions. It reuses `enumerateFlowPaths` (the
 * SAME walker `propagateFlow` uses) and `contributionsAlong` (the SAME contribution order), so the per-edge story
 * a canvas paints can never disagree with the whole-path token a verdict judges — the differential test pins it.
 *
 * Returns [] when the dimension is not in the vocabulary or the two nodes are not connected — the caller paints
 * nothing (there is no edge to colour).
 */
export function propagateFlowEdges(graph: Graph, categorical: Categorical, dimension: DimensionId, source: NodeId, terminal: NodeId): readonly PathEdgeMeets[] {
  const lattice = categorical.get(dimension);
  if (lattice === undefined) return [];
  const unknownToken = lattice.unknown;
  return enumerateFlowPaths(graph, source, terminal).map((edgePath): PathEdgeMeets => {
    let running = lattice.top();
    let touchedUnknown = false;
    const edges: EdgeMeet[] = [];
    for (const edgeId of edgePath) {
      // The contributions of THIS single edge, in path order (source out-port · edge · target in-port).
      const before = running;
      for (const c of contributionsAlong(graph, [edgeId])) {
        const token = c.guarantees[lattice.id];
        if (token === undefined) continue; // no claim for this dimension ⇒ a no-op meet
        if (unknownToken !== undefined && token === unknownToken) touchedUnknown = true;
        running = lattice.meet(running, token);
      }
      edges.push({ edge: edgeId, from: before, to: running, touchedUnknown });
    }
    return { edges };
  });
}

/** A categorical REQUIREMENT declared on a flow (doc: guarantee-propagation §4): the flow's computed token for
 *  `dimension` must be AT LEAST AS STRONG as `atLeast` (rank ≤ the required token's rank). The engine treats the
 *  required token as opaque; "Ordering ≥ per-key" / "Consistency = strong" is content phrasing. */
export interface GuaranteeRequirement {
  readonly dimension: DimensionId;
  readonly atLeast: DimensionToken;
}

/**
 * Judge one dimension's propagated result against a requirement, honestly (doc: guarantee-propagation §3):
 *   - `unknown`   if the required token is not in the lattice (a malformed requirement) OR the path TOUCHED the
 *                 declared-unknown token — no fake certainty when a hop's contribution is itself unknown.
 *   - `ok`        if the computed token is at least as strong as required (rank ≤ required rank).
 *   - `violation` otherwise — the guarantee degraded below the requirement; the root-cause hop is the fix site.
 * Never `warning`/`did-not-converge`: a categorical requirement is a hard floor with a certain answer or an
 * honest unknown — there is no soft-target band for a qualitative promise.
 */
export function judgeGuarantee(lattice: Lattice, result: DimensionResult, requirement: GuaranteeRequirement): Status {
  const need = lattice.rank(requirement.atLeast);
  if (need === undefined) return 'unknown'; // a requirement naming a token outside the lattice — cannot judge
  if (result.touchedUnknown) return 'unknown'; // an unknown hop ⇒ the whole path is honestly unknown
  const got = lattice.rank(result.token);
  if (got === undefined) return 'unknown'; // defensive: a computed token outside the lattice (unreachable if validated)
  return got <= need ? 'ok' : 'violation'; // smaller rank = stronger; ok iff computed is stronger-or-equal to required
}
