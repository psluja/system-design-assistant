import { ClassId, EdgeId, NodeId } from '@sda/engine-core';
import type { RequestClass } from '@sda/engine-solve';
import type { Instance, Wire } from './manifest';

// @feature Request classes (multi-commodity flows over one topology)
// @story An each-to-each mesh (A calls B for orders, B calls A for reports) is cyclic as a whole but
//   each named class is acyclic — declare classes with their own origins and wire membership and get
//   honest per-class computation instead of a refusal.
// @surfaces mcp (declare_class / set_class_membership / set_class_origin / remove_class /
//   list_classes, app/mcp/src/tools.ts; per-class verdicts on evaluate), web + vscode (per-class
//   readouts via the shared presenter)
// @algorithms engine/solve/src/network/build.ts (class slicing + the processor-sharing split)
// @docs docs/design/request-classes.html
// @e2e content/sda/src/fanin.e2e.test.ts (the mesh case)
// @status partial (forward/scalar per-class shipped; per-class tails and backward search are
//   honestly declined, by design)

// REQUEST CLASSES — the authored, document-shape declaration (doc: request-classes §3, build plan R2). A CLASS is a
// named flow (a commodity): its own origins and its own wire membership over a shared, possibly cyclic, topology —
// the answer to full-mesh synchronous systems. This module is the CONTENT half of the seam: the doc form of a class
// (below) and `compileClasses`, which lowers it to the engine's `RequestClass` by resolving each wire reference to
// the SAME edge id `instantiate` assigns (wires[i] → EdgeId(`e${i}`)). Absent everywhere ⇒ ONE implicit class over
// every wire — today, bit-for-bit: `hasClasses` is the gate, and the no-class path never constructs any of this.

/** A stable reference to a wire by its (from, to) port endpoints — the SAME key `setWireSemantics` / `disconnect` /
 *  `setWireTransform` address a wire by, so a class's membership survives wire reordering and (with the reducer's
 *  rewrite) node renames. Plain tuples ⇒ it round-trips in the project doc with no Map handling. */
export interface WireRef {
  readonly from: readonly [string, string];
  readonly to: readonly [string, string];
}

/** A per-class origin (doc: request-classes §3): the rate THIS class injects at a node — its own `assumedRps`. */
export interface ClassOrigin {
  readonly node: string;
  readonly rps: number;
}

/**
 * A request-class DECLARATION as it rides on the project document (doc: request-classes §3, R2). Pure DATA: an `id`
 * (its name on the canvas, the stable identifier), an optional friendly `name`, a SET of wire refs (its membership
 * E_C — a wire may belong to MANY classes, the owner lean §10), and per-node `origins`. It serialises as plain
 * arrays/tuples (no Map), and `compileClasses` lowers it to the engine's opaque {@link RequestClass}. Named `Decl`
 * to keep it distinct from the engine type it compiles to (edge ids vs the doc's wire refs).
 */
export interface RequestClassDecl {
  readonly id: string;
  readonly name?: string;
  readonly wires: readonly WireRef[];
  readonly origins: readonly ClassOrigin[];
}

/** Same wire? Two refs/wires match when their (from, to) port endpoints are equal — the de-facto unique wire key. */
const sameEndpoints = (w: Wire, r: WireRef): boolean =>
  w.from[0] === r.from[0] && w.from[1] === r.from[1] && w.to[0] === r.to[0] && w.to[1] === r.to[1];

/** Does a design declare ANY request class? The no-filler / no-class gate: with none, the whole per-class machinery
 *  stays inert and the design evaluates bit-for-bit as the single implicit river (the additive default). */
export function hasClasses(decls: readonly RequestClassDecl[] | undefined): boolean {
  return decls !== undefined && decls.length > 0;
}

/**
 * Lower the document's class declarations to the engine's {@link RequestClass}[], resolving each wire ref to the
 * edge id `instantiate` assigns it (wires[i] → EdgeId(`e${i}`)) — the SAME index, so a class's membership names the
 * exact engine edges. A ref that resolves to no wire is dropped HERE (the engine would otherwise report an
 * unresolvable edge); `classDeclProblems` catches such refs up front with a guided message (deserialize / tools).
 * Origins map straight through (node id + rate). Pure and total.
 */
export function compileClasses(wires: readonly Wire[], decls: readonly RequestClassDecl[]): RequestClass[] {
  return decls.map((d) => {
    const edges: EdgeId[] = [];
    for (const r of d.wires) {
      wires.forEach((w, i) => {
        if (sameEndpoints(w, r)) edges.push(EdgeId(`e${i}`));
      });
    }
    return {
      id: ClassId(d.id),
      edges,
      origins: d.origins.map((o) => ({ node: NodeId(o.node), rps: o.rps })),
    };
  });
}

/**
 * The per-node TOTAL origin rate implied by the declared classes: Σ over classes of each class's origin at the node
 * (doc: request-classes §7 — "the classes' shares at a node sum to the node's total"). Under declared classes the
 * per-class origins are authoritative; this reconciled total is what content supplies as the node's class-blind
 * `assumedRps` (so the shared overflow relation `max(0, inflow + assumedRps − capacity)` reads the true total offered),
 * while the engine injects each class's share separately for the per-class served split. Empty ⇒ no origins.
 */
export function originByNode(decls: readonly RequestClassDecl[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of decls) for (const o of d.origins) out.set(o.node, (out.get(o.node) ?? 0) + o.rps);
  return out;
}

/**
 * Diagnose a CYCLIC single-river flow. WITHOUT request classes a design is ONE implicit commodity over
 * every wire, and a directed cycle in that flow (A → B → … → A) has no finite steady state — the throughput feeds
 * back into itself, so the least-fixpoint solve lands on a DEGENERATE value (a runaway or a double-counted rate),
 * not an honest number. Rather than report that degenerate fixpoint, NAME the cycle and point to the remedy: request
 * classes carve the shared (possibly cyclic) topology into per-class ACYCLIC slices (doc: request-classes §4.2), so
 * the mesh can loop while every commodity's own path is acyclic — e.g. a saga's follow-up commands flowing back are
 * a DISTINCT class from the originating writes. Returns the cycle + a guided message, or undefined when the flow is
 * acyclic. Self-loops (a node wired to itself) are the `self()` primitive, not a multi-node feedback, so excluded.
 * Only meaningful for the single implicit river — under declared classes, build.ts enforces per-class acyclicity.
 */
export function cyclicFlowDiagnosis(wires: readonly Wire[]): { readonly cycle: readonly string[]; readonly message: string } | undefined {
  const cycle = findWireCycle(wires);
  if (cycle === undefined) return undefined;
  const path = cycle.join(' → ');
  return {
    cycle,
    message:
      `cyclic flow: ${path}. The single-river flow model has no finite steady state for a loop — the throughput feeds back into itself, so evaluate would land on a degenerate fixpoint, not a real number. ` +
      `Break it with REQUEST CLASSES: declare each commodity as its own class (declare_scenario is unrelated — use the request-class tools) so the shared topology can loop while every class's path stays acyclic (doc: request-classes §4.2) — e.g. the follow-up writes flowing back are a distinct class from the originating request.`,
  };
}

/** Find a directed MULTI-node cycle in the wire graph (vertices = components, edges = wires from→to), or undefined
 *  when acyclic. Self-loops are excluded (a node's own feedback is the `self()` primitive, not a mesh loop).
 *  Deterministic — vertices and edges are explored in input order — so the reported cycle is stable. Returns the
 *  cycle as a CLOSED node path [A, B, …, A] (the back-edge repeats the first node), matching build.ts's cycle shape. */
function findWireCycle(wires: readonly Wire[]): string[] | undefined {
  const adj = new Map<string, string[]>();
  const order: string[] = [];
  const see = (n: string): void => {
    if (!adj.has(n)) {
      adj.set(n, []);
      order.push(n);
    }
  };
  for (const w of wires) {
    const from = w.from[0];
    const to = w.to[0];
    if (from === to) continue; // a self-loop is the self() primitive, not a multi-node feedback
    see(from);
    see(to);
    adj.get(from)!.push(to);
  }
  const state = new Map<string, 1 | 2>(); // 1 = on the current DFS path, 2 = fully explored
  const path: string[] = [];
  const walk = (u: string): string[] | undefined => {
    state.set(u, 1);
    path.push(u);
    for (const v of adj.get(u) ?? []) {
      if (state.get(v) === 1) return [...path.slice(path.indexOf(v)), v]; // v … u → v — the back-edge closes it
      if (!state.has(v)) {
        const found = walk(v);
        if (found !== undefined) return found;
      }
    }
    path.pop();
    state.set(u, 2);
    return undefined;
  };
  for (const n of order) {
    if (!state.has(n)) {
      const found = walk(n);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Honest, guided problems in the declared classes against the design (unknown wire / node), or [] when every class
 * resolves. A class's membership is STRUCTURAL — it defines the commodity — so a ref that names a wire or node the
 * design does not contain is a corruption to surface, not a soft requirement to defer (unlike a lag/guarantee SLO,
 * whose dangling endpoint is an honest `unknown` at evaluate time). `deserialize` and the MCP class tools call this
 * so a broken class is rejected with a message that names the fix, never silently dropped or crashed on.
 */
export function classDeclProblems(instances: readonly Instance[], wires: readonly Wire[], decls: readonly RequestClassDecl[]): string[] {
  const nodeIds = new Set(instances.map((i) => i.id));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const d of decls) {
    if (typeof d.id !== 'string' || d.id.trim() === '') {
      problems.push('a request class has no id (name)');
      continue;
    }
    if (seen.has(d.id)) problems.push(`duplicate request class "${d.id}"`);
    seen.add(d.id);
    for (const r of d.wires) {
      if (!wires.some((w) => sameEndpoints(w, r))) {
        problems.push(`class "${d.id}": unknown wire ${r.from[0]}.${r.from[1]} → ${r.to[0]}.${r.to[1]} — draw it, or remove it from the class`);
      }
    }
    for (const o of d.origins) {
      if (!nodeIds.has(o.node)) problems.push(`class "${d.id}": unknown origin node "${o.node}" — it is not a component in this design (was it renamed or removed?)`);
    }
  }
  return problems;
}
