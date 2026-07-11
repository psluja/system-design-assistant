---
id: doc-4
title: 03 — Engine Calculus
type: specification
created_date: '2026-06-28 18:34'
updated_date: '2026-06-28 19:42'
tags:
  - design
  - engine
---
# 03 — Engine Calculus (the core)

> Status: **draft, rev.3**. Layer (3): (1) property system → (2) manifest → **(3) engine** → (4) MVP.
> The engine is the heart of SDA; this doc is its blueprint. Builds on doc-1, doc-2, doc-3.
>
> rev.3 locks two spike-measured/validated facts: **(A)** MiniZinc WASM has a ~177 ms per-solve floor
> → a fast **JS evaluator is required** for the interactive hot path (MiniZinc is the debounced
> verifier + search engine) — the hot/cold split is now *measured*, not preference; **(B)** the
> least-fixpoint for backpressure is obtained by a **post-fixpoint inequality + `minimize`**
> (Knaster–Tarski), solver-validated on real Gecode.

## 0. The engine in one breath

A pure, headless, **domain-agnostic** function over a typed-property graph. Given a graph (nodes,
ports, edges, tokens) whose nodes carry properties related by authored relations, the engine
**solves the whole chain — forward (evaluate/check) or backward (synthesize/optimize/repair) — and
returns an honest, explanatory verdict.** It knows nothing of system design (doc-1); the cloud
meaning is content.

## 1. Quality charter — the monument

One bar: **solid, exact, pure, beautiful, fast.** Non-negotiable:

- **Pure & deterministic.** A pure function of `(registry, graph, config)`. No wall clock / ambient
  state / unseeded randomness. Same input ⇒ byte-identical output.
- **Illegal states unrepresentable** (branded ids, discriminated unions, exhaustive matches).
- **Zero domain knowledge.** `grep` the engine for `aws`/`lambda`/`iam`/`latency` ⇒ nothing.
- **Total & honest.** Every path returns a typed result; uncertainty is a value (`unknown` /
  `did-not-converge`), never a lie or a throw.
- **One numeric semantics, two execution engines.** A relation has a single meaning; it is executed
  by a fast JS evaluator (hot) and by MiniZinc (cold), which are **differential-tested to agree** (§5).
- **Proven, not hoped.** The public surface is property-tested; overlapping engines are
  differential-tested; determinism is snapshot-tested.
- **Fast.** The hot path settles the reference graph in < 16 ms; nothing interactive blocks.
- **Documented.** Every public symbol carries a doc comment; this file is its spec.

**Gate:** do not move past the engine until all of §9 holds.

## 2. Meta-model (what the engine reasons over)

An abstract, domain-free graph. Branded ids prevent mix-ups. (Implemented in `engine/core`.)

```ts
type NodeId = string & { readonly _: 'NodeId' }; /* …PortId, EdgeId, Key … */
interface KeyDef { key: Key; unit: Unit; band: BandShape; aggregate: Aggregation; kind: 'input'|'derived' }
type Aggregation = { series: 'sum'|'min'|'max'|'product'; onAsyncEdge: 'carry'|'cut' };
interface Graph { nodes: ReadonlyMap<NodeId,Node>; ports: …; edges: … }
type Cell = { kind:'input'; key:Key; value:Banded } | { kind:'derived'; key:Key; relation:RelationRef };
```

`Relation` is the authored, readable MiniZinc-subset expression (doc-2 §6). The engine never
interprets cloud semantics — it solves relations and composes keys by their declared `Aggregation`.

## 3. The numeric core — one model, two execution engines

From `(graph, registry, relations)` build **one cell network**: variables are `(owner, key)` cells;
equations are the authored relations plus, across each edge, the target key's `Aggregation` per the
edge's `sync/async` semantics. **This single model is the source of truth for every numeric question;**
evaluation = solve with inputs fixed, search = free vars + objective. It is *executed* two ways —
a spike measurement proved we need both:

| Engine | Role | When |
|---|---|---|
| **JS evaluator (hot)** | fast forward evaluation of the network (Kleene iteration to fixpoint) | every edit, < 16 ms |
| **MiniZinc (cold)** | exact solve: verify on pause + search (synthesize/optimize/repair) | debounced / on-demand |

> **Measured (spike):** MiniZinc WASM has a **~177 ms fixed per-solve floor** (worker IPC + process
> start + flatten), flat to ~200 nodes, ~440 ms at 1000. Fine as a **debounced** verifier (≤ a few
> hundred nodes); **impossible per-keystroke** (~10 dropped frames). So the **JS evaluator is
> required**, not optional. The two engines share one relation semantics and are differential-tested
> to agree — that is how "one numeric semantics" survives two engines.

### 3a. Least-fixpoint encoding (spike-validated, Knaster–Tarski)

Backpressure feedback makes cells cyclic; we want the **least (natural steady-state) fixpoint**.

- For each cyclic flow var, encode the equilibrium as a **post-fixpoint inequality** `F(t) ≤ t`, with
  **demand as a lower-bounding term** (e.g. `min(C, max(R, t)) ≤ t`), and **`solve minimize sum(flows)`**.
- By Knaster–Tarski the optimum is the least post-fixpoint = the least fixpoint = the Kleene limit
  from ⊥ — the natural steady state. Plain `solve satisfy` admits **spurious** fixpoints (validated:
  `{3,4,5,6,7}` for R=3,C=7); `minimize` discards them. **Demand must be a lower bound or `minimize`
  collapses to 0.**
- **Precondition: `F` monotone** (min/max/+/non-neg-weighted sums). Non-monotone feedback (batching
  economies, retry amplification, AIMD, hysteresis) has no lattice guarantee → **defer to DES** (§3b).
  Use integer-scaled rates for exact finite-lattice termination.
- The hot JS evaluator computes the same lfp by **Kleene iteration from ⊥** (cap + ε); the iterator
  and MiniZinc's `minimize` must agree (differential).

### 3b. Dynamics over time — the simulator (a different question)

DES is **not** a second calculator of the same number; it answers **"what happens over time"** —
transients, oscillation, non-monotone feedback, and the **true latency tail** by pushing synthetic
load through the graph. MiniZinc gives the steady-state value; DES gives the behaviour reaching it.

### 3c. Determinism contract

Canonical cell ordering; fixed MiniZinc solver + config; seeded RNG only; total order on ranked output
with a canonical tie-break; bounded fixpoint (cap + ε) with honest `did-not-converge`; reproducible
across runs and machines.

## 4. The mode family — one core, many uses

| Mode | Input | Output | Engine |
|---|---|---|---|
| `evaluate` | graph | fully-valued graph | JS evaluator (hot) / MiniZinc (verify) |
| `check` | graph | verdicts (ok/warning/violation) | JS evaluator |
| `suggest` | graph + open port | ranked admissible attachments | DataScript + clingo |
| `synthesize` | endpoints + SLOs | ranked full designs (top-K / Pareto) | clingo + MiniZinc |
| `optimize` | graph + objective | improved design | MiniZinc |
| `repair` | graph + violation | minimal change to satisfy | MiniZinc |
| `explain` | graph / verdict | cause-chain + remediations | MiniZinc (+ DataScript) |
| *(time)* | graph + load | dynamics, true percentiles | DES |

**UNSAT is explained, never bare:** soft constraints + `minimize` (violated constraints + magnitude →
graded remediations), with `findMUS` for a minimal hard-constraint conflict.

## 5. Projectors — the seam between content and solvers

A **projector** is a pure, total, deterministic function `(graph, registry) → solver input`; the only
solver-aware code. The numeric relation is authored once and emitted to **both** the JS evaluator and
MiniZinc; **they are differential-tested to agree on forward evaluation** (the core consistency
guarantee — a disagreement is a P0). DataScript (legality) and MiniZinc (numeric admissibility) are
differential-tested on shared questions too.

## 6. The verdict — the honest output

```ts
interface Verdict {
  key: Key; scope: NodeId|EdgeId; computed: Banded;
  status: 'ok'|'warning'|'violation'|'unknown'|'did-not-converge';
  cause: CauseChain; remediations: readonly Remediation[];
}
```

`status` separates a hard-floor breach (`violation`) from a soft-target miss (`warning`) from honest
ignorance. `cause` traces a downstream failure to its upstream origin. `remediations` are ranked.

## 7. Engine architecture (packages & boundaries)

- `engine/core` — meta-model types, registry shape, verdict model. **Zero dependencies.** (done)
- `engine/solve` — network constructor, **JS Kleene evaluator (hot)**, MiniZinc projection (cold),
  mode dispatcher, merger.
- `engine/solvers` — adapters behind one `Solver` interface (`datascript`, `clingo`, `minizinc`); DI.
- `engine/sim` — discrete-event simulation (the time engine; §3b).

## 8. Public API — the facade

```ts
interface Engine {
  evaluate(graph: Graph): Valued;                 // hot (JS), synchronous-ish
  check(graph: Graph): readonly Verdict[];        // hot
  suggest(graph: Graph, port: PortId): Promise<readonly Candidate[]>;
  synthesize(goals: Goals): Promise<readonly RankedDesign[]>;
  optimize(graph: Graph, objective: Objective): Promise<RankedDesign>;
  repair(graph: Graph, v: Verdict): Promise<readonly Remediation[]>;
  explain(graph: Graph, v: Verdict): Explanation;
  simulate(graph: Graph, load: Load): Promise<Timeline>;
}
```

## 9. Definition of perfect (the gate)

- [ ] Pure & deterministic; reproducible across runs/machines (snapshot-tested).
- [ ] `grep` for domain strings ⇒ zero; illegal states unrepresentable; exhaustive `switch`es.
- [ ] **JS-evaluator ↔ MiniZinc** differential agreement on forward eval; both ↔ DataScript on legality.
- [ ] Least-fixpoint via post-fixpoint inequality + `minimize` (validated); Kleene iterator agrees;
      bounded; honest `did-not-converge`; non-monotone feedback routed to DES.
- [ ] UNSAT yields a cause-chain + graded remediations (soft-constraints / MUS), never bare "unsat".
- [ ] Hot path (JS evaluator) < 16 ms; MiniZinc debounced-on-pause verify (≤ few-hundred nodes).
- [ ] DES validated against closed-form models (M/M/1, Little's law); true percentiles correct.
- [ ] Every public symbol documented; this spec matches the code.

## 10. Open for the build (TASK-5 … TASK-9, TASK-14)

- Exact `Relation` subset grammar (readable, MiniZinc-compatible arithmetic) + the JS evaluator's
  matching semantics (the differential contract).
- The cell-network construction algorithm + canonical ordering + SCC detection (for the fixpoint).
- Edge-transport selection representation (doc-3 §8 open item).
- Composite-node recursion (doc-3 §3) inside the solve.
- Tail-latency percentiles: DES is the source of truth; analytic mean-based estimate labelled approx.

> Resolved by spikes (rev.3): live-latency measurement → JS evaluator required; least-fixpoint
> encoding → post-fixpoint inequality + `minimize`.
