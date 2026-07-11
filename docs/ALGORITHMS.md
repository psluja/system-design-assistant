# Algorithm Catalog

<!-- GENERATED FILE — do not edit. Source of truth: `@algorithm` headers in the listed modules. Regenerate with `pnpm catalogs`; freshness is asserted by scripts/generate-catalogs.test.ts. -->

Every algorithmic module in the codebase, cataloged from its `@algorithm` header: the problem it solves, the approach, its complexity, citations, the invariants it maintains, and where it is tested. 54 algorithms.

## engine/core

### Totally-ordered token lattice with meet (categorical dimension compiler)

`engine/core/src/lattice.ts`

- **Problem:** Qualitative guarantees need an algebra before they can be computed: an ordered vocabulary of opaque tokens and a combining rule that says what survives when hops of different strength compose.
- **Approach:** Compile an ordered token list (strongest first = TOP) into a rank-lookup lattice whose MEET returns the larger-rank (weaker) token; boolean monotone flags are the degenerate two-element case, so one mechanism serves consistency, ordering and delivery alike; declarations are validated (no duplicates, unknown token must be a member).
- **Complexity:** Compile O(dimensions * tokens); rank and meet O(1) via the precomputed map.
- **Citations:** Semilattice basics (Birkhoff, "Lattice Theory"); the total order makes meet = max-rank.
- **Invariants:** Meet is commutative, idempotent, monotone (never strengthens); index 0 is TOP and the meet identity; tokens are opaque strings — the engine names no guarantee vocabulary.
- **Tested:** `engine/core/src/lattice.test.ts`, `engine/solve/src/guarantee/propagate.test.ts`

### Dual float-tolerance regimes (equivalence vs band boundary)

`engine/core/src/tolerance.ts`

- **Problem:** Float comparisons can make the tool lie in BOTH directions: a bare > flips an SLO verdict on 1e-8 summation residue, while one coarse relative tolerance would swallow a real five-nines vs eleven-nines durability gap (~1e-5 near ratio 1).
- **Approach:** Two deliberately different epsilons: EQUIVALENCE (closeEnough, relative + absolute 1e-4) for "do two independently computed optima agree", scaling with MIP feasibility tolerance; BAND BOUNDARY (exceedsCeiling/belowFloor/withinBound, absolute floor 1e-6 + tiny relative 1e-9) that rescues rounding noise without ever absorbing a genuine SLO miss.
- **Complexity:** O(1) per comparison.
- **Citations:** Relative/absolute epsilon comparison folklore (Goldberg 1991, "What Every Computer Scientist Should Know About Floating-Point Arithmetic"); constants are the module's own, argued in the header.
- **Invariants:** Boundary tolerances are never slack budgets — any meaningful miss still reads as a violation; every caller shares these single definitions (no bespoke epsilons elsewhere).
- **Tested:** `engine/core/src/tolerance.test.ts`

## engine/sim

### Closed-form queueing formulas (M/M/1, M/M/c via Erlang-B/C, M/G/1 P-K, Little)

`engine/sim/src/analytic.ts`

- **Problem:** Give mean utilization/queue/wait/sojourn for a single station in closed form — the oracle the discrete-event simulator is validated against, and the cheap estimate when simulation is overkill.
- **Approach:** Textbook steady-state results: M/M/1 algebra; M/M/c through the numerically stable Erlang-B recursion B(k) = aB(k-1)/(k + aB(k-1)) lifted to the Erlang-C wait probability (no factorials, no overflow); Pollaczek-Khinchine mean wait for M/G/1 parameterized by the service SCV; Little's law as the L = lambda*W bridge.
- **Complexity:** O(c) for M/M/c (the Erlang-B recursion over c servers); O(1) for the rest.
- **Citations:** Erlang 1917 (B/C); Pollaczek 1930 / Khinchine 1932; Little 1961; stable Erlang-B recursion as in Cooper, "Introduction to Queueing Theory" (2nd ed., 1981).
- **Invariants:** Instability (rho >= 1) answers Infinity honestly, never a throw; c = 1 reduces exactly to M/M/1; SCV = 1 recovers M/M/1, SCV = 0 gives M/D/1.
- **Tested:** `engine/sim/src/des.test.ts` (DES vs closed forms), `engine/sim/src/response.test.ts`

### Discrete-event queueing-network simulation (event list + reservoir percentiles)

`engine/sim/src/des.ts`

- **Problem:** Produce true time-domain behavior — utilization, drops, retries, response/lag tails — of a queueing network that closed forms cannot cover (fan-out, async hops, deadlines, cold starts), deterministically under a seed and in bounded memory at any arrival rate.
- **Approach:** Classic next-event-time-advance DES: a binary min-heap future-event set drives arrivals, service starts and completions across stations; sojourn/response/lag percentiles are estimated from fixed-size uniform reservoirs (Vitter's Algorithm R once a cap is hit), means stay exact over all observations; warm-up completions are discarded for steady-state runs.
- **Complexity:** O(events * log events) time for the event loop; memory bounded by stations + in-flight jobs + fixed reservoir caps (percentile memory does not grow with run length).
- **Citations:** Law & Kelton, "Simulation Modeling and Analysis" (next-event time advance); Vitter, "Random Sampling with a Reservoir", ACM TOMS 11(1), 1985 (Algorithm R).
- **Invariants:** Fixed seed => byte-identical results (single mulberry32 stream, total event order via sequence tie-break); no-data metrics answer NaN, never 0; validated differentially against the closed forms (M/M/1, M/M/c, Little, P-K) within confidence tolerances.
- **Tested:** `engine/sim/src/des.test.ts`, `engine/sim/src/response.test.ts`, `engine/sim/src/lag.test.ts`, `engine/sim/src/drops.test.ts`, `engine/sim/src/retry.test.ts`, `engine/sim/src/coldstart.test.ts`, `engine/sim/src/transient.test.ts`

### Inverse-CDF duration sampling (exponential / uniform / cold-start mixture)

`engine/sim/src/distribution.ts`

- **Problem:** Draw interarrival and service times from typed duration distributions deterministically — each shape must consume a fixed number of uniforms so seeded runs stay reproducible.
- **Approach:** Inverse-CDF transform per shape: -ln(1-u)/rate for the exponential (1-u keeps log finite), affine stretch for the uniform, and a Bernoulli mixture for the cold-start penalty; analytic means are computed per shape for the queueing checks.
- **Complexity:** O(1) per draw (cold-start recurses once into its base shape).
- **Citations:** Inverse transform sampling — Devroye, "Non-Uniform Random Variate Generation" (1986), ch. 2.
- **Invariants:** Samples are non-negative; exponential consumes exactly one uniform, cold-start exactly one more than its base; mean() agrees with the distribution's analytic expectation.
- **Tested:** `engine/sim/src/des.test.ts`, `engine/sim/src/coldstart.test.ts`

### Binary min-heap (future-event set)

`engine/sim/src/heap.ts`

- **Problem:** The discrete-event simulator must always process the earliest pending event next, with deterministic ordering, from a set that grows and shrinks on every step.
- **Approach:** Classic array-backed binary min-heap (sift-up on push, sift-down on pop) over a caller-supplied total order.
- **Complexity:** O(log n) push/pop, O(1) peek/size, O(n) space, for n pending events.
- **Citations:** Williams 1964 (heapsort's heap); standard priority-queue folklore, e.g. CLRS ch. 6.
- **Invariants:** Heap order: every parent is `less`-or-equal to its children; `less` must be a TOTAL order (event time, then a monotonic sequence tie-break) so popping is deterministic regardless of insertion order (doc-4 §3c).
- **Tested:** `engine/sim/src/heap.test.ts`, `engine/sim/src/des.test.ts` (drives the event loop)

### NHPP arrival sampling by inversion (rate profiles)

`engine/sim/src/profile.ts`

- **Problem:** Generate arrivals of a non-homogeneous Poisson process whose rate follows a periodic, piecewise-linear load curve, consuming exactly ONE uniform per arrival so a flat profile stays byte-identical to plain exponential sampling and the RNG stream never drifts.
- **Approach:** Time-change/inversion: draw E ~ Exp(1) and advance to the time where the integrated rate grows by E; for a piecewise-linear rate the integral is piecewise-quadratic with a closed-form per-segment inverse, so inversion is exact and rejection-free. Multipliers are normalized at read (divide by the period mean) so a generator's level keeps meaning the period's MEAN rate.
- **Complexity:** O(k) per arrival and per mean/peak read, for k profile vertices (linear segment scan; profiles are a handful of drawn points, never hot).
- **Citations:** Çinlar, "Introduction to Stochastic Processes" (1975) — time-change/inversion; Lewis & Shedler 1979 (thinning — the documented fallback for non-piecewise-linear profiles).
- **Invariants:** Effective multiplier m(t)/mean has mean 1 by construction; exactly one uniform consumed per arrival; a flat profile reduces byte-for-byte to exponential sampling; evaluation wraps periodically for any t >= 0.
- **Tested:** `engine/sim/src/profile.test.ts`

### mulberry32 (seeded PRNG)

`engine/sim/src/rng.ts`

- **Problem:** The simulator needs a deterministic, seedable source of uniform randomness so that a fixed seed reproduces byte-identical runs across machines (doc-4 §3c); Math.random is unseedable.
- **Approach:** mulberry32 — a 32-bit counter-increment + multiply/xorshift mixer; every draw in the DES flows through this one Rng interface.
- **Complexity:** O(1) per draw; 32 bits of state.
- **Citations:** Tommy Ettinger's mulberry32 (public domain; popularized by bryc's JS PRNG collection).
- **Invariants:** Pure given seed (no global state); output uniform in [0, 1); same seed => same stream.
- **Tested:** `engine/sim/src/rng.test.ts`, `engine/sim/src/des.test.ts` (determinism under seed)

### Nearest-rank percentile

`engine/sim/src/stats.ts`

- **Problem:** Turn a sorted latency sample into the tail statistic (p95/p99) a verdict compares against a band, without optimistic smoothing on small samples.
- **Approach:** Nearest-rank order statistic (the ceil(p*n)-th sorted value), chosen over interpolating estimators as the conservative tail read; empty samples answer NaN (honest: no data, no estimate).
- **Complexity:** O(1) per query on an already-sorted sample (sorting is the caller's O(n log n)).
- **Citations:** Nearest-rank percentile = type 1 in Hyndman & Fan, "Sample Quantiles in Statistical Packages", The American Statistician 50(4), 1996.
- **Invariants:** Result is always an element of the sample (never interpolated); p clamped to [0,1]; NaN only for the empty sample.
- **Tested:** `engine/sim/src/stats.test.ts`

### Transient (windowed) DES observation with bounded reservoirs

`engine/sim/src/transient.ts`

- **Problem:** Answer "what happens during and after a TEMPORARY overload?" — a steady-state run discards exactly the warm-up transient the question is about, and an overload window can generate unbounded events and samples.
- **Approach:** A time-bounded run over [0, horizonS] with no warm-up discard, bucketed into fixed windows; per-window sojourn percentiles come from a capped uniform reservoir (Vitter's Algorithm R past the cap), backlog is tracked as a per-station per-window max, and a hard event budget stops the run honestly (`truncated`) rather than scaling the workload.
- **Complexity:** O(events * log stations) simulation time (heap-driven DES); memory O(windows * reservoir-cap + stations * windows), bounded regardless of arrival rate.
- **Citations:** Vitter, "Random Sampling with a Reservoir", ACM TOMS 11(1), 1985 (Algorithm R).
- **Invariants:** Counts are attributed to the window where they HAPPEN; the last window is clipped, never stretched; truncation is explicit (endS < horizonS), results cover exactly the observed prefix; empty windows answer NaN, never 0.
- **Tested:** `engine/sim/src/transient.test.ts`

## engine/solve

### ASP program generation for topology enumeration (generate-and-test)

`engine/solve/src/asp/clingo.ts`

- **Problem:** Synthesis must ENUMERATE every valid discrete structure — which option fills each slot so all adjacency compatibilities and placement rules hold — rather than check or size a given one.
- **Approach:** Emit an Answer Set Programming program: a cardinality choice { choose(S,O) : candidate } = 1 per slot, integrity constraints for adjacency compatibility and requires/conflicts placement rules; the injected clingo runner (prebuilt WASM or node) solves it and the answer sets are parsed back into canonically ordered selections.
- **Complexity:** Program size O(slots * options + compat facts); solving is clingo's (NP-complete in general), bounded by the requested model count.
- **Citations:** Gelfond & Lifschitz 1988 (stable model semantics); Gebser et al., clingo / Potassco (the ASP system used, via clingo-wasm).
- **Invariants:** Domain-agnostic (slots/options/compat are opaque ids supplied as data); clingo is injected, never imported (bundle-clean engine); selections are canonically sorted so enumeration order is deterministic for the caller.
- **Tested:** `engine/solve/src/asp/clingo.test.ts`

### Kleene least-fixpoint iteration (Gauss-Seidel) over the cell network

`engine/solve/src/fixpoint/solve.ts`

- **Problem:** The numeric hot path must settle a system of mutually referencing cells — including backpressure feedback loops — on the natural steady state, in milliseconds, without a solver process.
- **Approach:** Kleene iteration from bottom with Gauss-Seidel sweeps in the cells' canonical Map order: derived cells start at bottom (default 0) and are recomputed until max change <= epsilon or maxIter; for a monotone system this is the LEAST fixpoint — the same answer the MiniZinc post-fixpoint + minimize encoding certifies (doc-4 §3a).
- **Complexity:** O(sweeps * cells * expr size); one sweep suffices when cells arrive in dependency order (network/build.ts emits them topologically), maxIter (default 1000) bounds cyclic systems.
- **Citations:** Kleene fixed-point theorem; Gauss-Seidel iteration (chaotic iteration as in Cousot & Cousot 1977's abstract-interpretation framing).
- **Invariants:** Deterministic (fixed sweep order); non-convergence and non-finite values are reported honestly (converged: false), never returned as numbers; monotone systems land on the least fixpoint (differential vs MiniZinc).
- **Tested:** `engine/solve/src/fixpoint/solve.test.ts`, `engine/solve/src/minizinc/differential.test.ts`

### Relational meet via max-rank aggregation (DataScript differential reference)

`engine/solve/src/guarantee/datalog.ts`

- **Problem:** The forward meet fold (propagate.ts) needs an INDEPENDENT implementation to agree with — the two-engines-agree rigor that guards "the tool must not lie" for categorical guarantees.
- **Approach:** Exploit that meet is a commutative idempotent monoid: the end-to-end token is order-free and equals the WEAKEST (max-rank) contributed token, which a relational engine computes naturally — load each contribution's rank as a datom, take the Datalog max per dimension (plus the touched-unknown flag).
- **Complexity:** One aggregate query over O(contributions) datoms per dimension.
- **Citations:** Semilattice-as-monoid folklore; Datalog aggregation (DataScript).
- **Invariants:** Agrees with the forward fold on the final token and unknown flag for every input (the differential test's contract); order-independence is the mathematical basis, so no path order is consulted.
- **Tested:** `engine/solve/src/guarantee/propagate.test.ts` (the differential)

### Lattice-meet propagation along request paths (categorical guarantees)

`engine/solve/src/guarantee/propagate.ts`

- **Problem:** Qualitative guarantees (consistency, ordering, delivery) must be COMPUTED end-to-end with a provable root cause, not eyeballed: which hop weakened the flow, and what survives at the terminal?
- **Approach:** Enumerate simple source->terminal paths by DFS (cycles cut), then fold each dimension's tokens with the lattice MEET ("the weaker hop wins"), recording the FIRST strict drop of the running meet as the root cause; meet monotonicity makes that attribution a theorem, and an independent DataScript max-rank query is the differential reference for the final token.
- **Complexity:** Meet fold O(contributions) per dimension; simple-path enumeration is exponential in the worst case but paths are cycle-cut and design graphs are small.
- **Citations:** Lattice theory (meet-semilattice folklore, Birkhoff); monotone dataflow analysis framing (Kam & Ullman 1977).
- **Invariants:** The running meet never strengthens (monotone — property-tested); first strict drop = provable root cause; a path touching the declared-unknown token can never yield a certain verdict; tokens are opaque — the engine names no guarantee.
- **Tested:** `engine/solve/src/guarantee/propagate.test.ts` (monotonicity property + DataScript differential)

### Datalog protocol legality + "what fits" suggester

`engine/solve/src/legality/legality.ts`

- **Problem:** Every edit must instantly answer "is this connection legal?" and "which catalog blocks fit this open port?" over emit/accept protocol sets — the hot relational path behind the canvas.
- **Approach:** DataScript (Datalog) queries over port/edge/compat datoms: illegal edges are computed POSITIVELY (query the compatible set, take the complement) so no Datalog negation is needed; the suggester matches accept/speak sets against the compat relation and ranks exact-protocol matches before cross-protocol ones.
- **Complexity:** Datalog join cost over O(ports + edges + compat facts) datoms per query; suggester linear in catalog port-types after the join.
- **Citations:** Datalog / DataScript query semantics; complement-instead-of-negation is a standard stratification dodge.
- **Invariants:** Domain-agnostic (protocol ids are opaque; compatibility arrives as data); the compat relation is used reflexively as given, never inferred; deterministic ranking (exact first).
- **Tested:** `engine/solve/src/legality/legality.test.ts`

### Constant folding + Knaster-Tarski least-fixpoint MiniZinc encoding

`engine/solve/src/minizinc/chain.ts`

- **Problem:** The JS solver's cyclic cell systems must be certified by an independent solver, but a finite MiniZinc float cannot hold the +/-Infinity identities empty min/max aggregations carry.
- **Approach:** Constant-propagate to a fixpoint, inlining known cells and applying aggregation identities (min(x,+inf)=x, x+0, x*1, ...) so the infinities vanish structurally; project the cyclic residue to a model where each variable carries the post-fixpoint inequality F(t) <= t and the objective minimizes their sum — by Knaster-Tarski the optimum of a monotone F is its least fixpoint, i.e. exactly the Kleene answer.
- **Complexity:** Folding iterates to a fixpoint over cells: O(passes * cells * expr size); model size linear in the un-folded residue.
- **Citations:** Knaster-Tarski fixed-point theorem (Tarski 1955); Kleene iteration equivalence for monotone maps; standard compiler constant propagation.
- **Invariants:** Folding preserves semantics exactly (pure-numeric subtrees folded through evalExpr, the reference evaluator); the encoding's optimum equals the JS least fixpoint (differential- tested forward and on chains).
- **Tested:** `engine/solve/src/minizinc/chain.test.ts`, `engine/solve/src/minizinc/chain.property.test.ts`, `engine/solve/src/minizinc/differential.test.ts`

### Backward-search MIP compilation (interval boxing, PS-split linearization, reachability prune)

`engine/solve/src/minizinc/search.ts`

- **Problem:** Turn optimize / repair / explain-infeasible over the cell network into a continuous optimization model a MIP/LP solver (COIN-BC / HiGHS) can prove optimal — Gecode's float branch-and-bound cannot terminate its optimality proof on these objectives.
- **Approach:** Constant-fold the fixed cells; box every free variable by SOUND interval evaluation (over-approximating reachable values); rewrite the processor-sharing split offered*cap/max(total,cap) to its headroom-linear min(cap, offered) form; encode bands as hard constraints (repair adds L1-distance minimization, UNSAT-explain relaxes bands to soft penalties); prune tunables that cannot reach the objective by cell-graph reachability (the fix for the 319s free-tunable degeneracy).
- **Complexity:** Model construction linear in cells + expression sizes (interval eval, DFS cycle test, reachability DFS); solve cost is the MIP solver's, hard time-bounded by the caller.
- **Citations:** Interval arithmetic (Moore 1966); big-M-free linearization by headroom restriction; L1 goal programming for minimal repair (standard OR practice).
- **Invariants:** Interval boxes are sound (never exclude a reachable value); linearization is exact on the headroom-feasible region the model enforces; emitted model semantics match the JS evaluator (differential-tested); degenerate free knobs are pruned, never silently explored.
- **Tested:** `engine/solve/src/minizinc/search.test.ts`, `engine/solve/src/minizinc/transform.differential.test.ts`

### Seeded LCG corpus generation (class-free golden population)

`engine/solve/src/network/__fixtures__/no-class-corpus.ts`

- **Problem:** The request-classes equivalence gate needs a stable, varied population of class-free graphs whose golden cell values survive machines and runs byte-for-byte — fast-check's own generators do not promise cross-version stability.
- **Approach:** A plain linear congruential generator (Numerical Recipes constants 1664525 / 1013904223, 32-bit wrap) drives deterministic construction of chains, fan-in/fan-out, per-wire/per-port transforms, async cut/carry and cyclic meshes — the seams the class branch could disturb. (This is the repo's third PRNG home, distinct from mulberry32 in engine/sim/rng and harness/generator: an LCG, chosen for fixture simplicity.)
- **Complexity:** O(1) per draw; corpus construction linear in nodes + edges.
- **Citations:** Press et al., "Numerical Recipes" (the LCG constants); Knuth TAOCP v2 (LCG theory).
- **Invariants:** Same seed => same corpus => same golden, across machines; no class declarations anywhere (the single-implicit-river world the class dimension must leave byte-identical).
- **Tested:** `engine/solve/src/network/build.class.test.ts` (equivalence vs captured golden)

### Graph-to-cell-network projection (PS split, class slicing, topological cell order)

`engine/solve/src/network/build.ts`

- **Problem:** Compile a typed-property graph plus registry algebra into the flat cell system the fixpoint solver computes — including multi-commodity request classes contending for one node's finite capacity — while keeping the solve fast and per-class flows honest.
- **Approach:** Emit inflow/outflow/local/served expressions per (node, key, class); shared capacity is divided by the processor-sharing split served = offered * cap / max(totalOffered, cap); each class's wire membership is checked acyclic by a colored (white/gray/black) DFS; cells are emitted in dependency-first topological order via iterative DFS post-order (cycle back-edges skipped) so Gauss-Seidel settles a DAG in ONE sweep.
- **Complexity:** O(cells + refs) for the build and the topological sort; the ordering turns an acyclic solve from O(cells^2) into O(cells).
- **Citations:** Processor-sharing discipline (Kleinrock 1967); Tarjan-style iterative DFS ordering; multi-commodity flow framing (standard).
- **Invariants:** No classes => byte-for-byte the single-class build (property-pinned); one class over all wires collapses the PS split to min(cap, offered) exactly; cyclic class membership is rejected with a deterministic witness cycle, never solved wrongly.
- **Tested:** `engine/solve/src/network/build.test.ts`, `engine/solve/src/network/build.class.test.ts`, `engine/solve/src/network/transform.test.ts`, `engine/solve/src/network/generator.test.ts`

### Forward AST evaluation (the reference numeric semantics)

`engine/solve/src/relation/evaluate.ts`

- **Problem:** One expression tree must mean exactly one number everywhere: the JS hot path, the MiniZinc projection and the GPU bytecode all claim to compute "the same" value, so a single reference evaluator has to define that value.
- **Approach:** Recursive tree walk in IEEE-754 float64; comparisons yield 1/0; generic over the ref type R so the identical evaluator serves Expr<Key> (relations) and Expr<CellId> (the cell network).
- **Complexity:** O(nodes) per expression.
- **Citations:** None (elementary tree interpretation); IEEE 754 determinism is the load-bearing fact.
- **Invariants:** Deterministic per IEEE-754; total for well-formed ASTs; it IS the differential reference — MiniZinc projection and fp32 bytecode are tested to agree with it.
- **Tested:** `engine/solve/src/relation/relation.test.ts`, `engine/solve/src/minizinc/differential.test.ts`, `engine/solver-contract/src/gpu/differential.test.ts`

### Recursive-descent parser for the relation expression language

`engine/solve/src/relation/parse.ts`

- **Problem:** Manifests declare numeric semantics as expression STRINGS (the closed framework's only formula surface); they must become a typed AST totally — bad input yields a Result error with position, never a throw or a partial parse.
- **Approach:** Hand-written tokenizer + recursive-descent / precedence-climbing parser (compare -> add -> mul -> unary -> primary, with min/max/inflow/outflow/self call forms); a typed ParseError is used internally and converted to Result at the boundary.
- **Complexity:** O(n) in source length (single token stream pass, no backtracking).
- **Citations:** Standard precedence-climbing / recursive-descent construction (e.g. Norvell 1999; Crenshaw's tradition); grammar is the module's own.
- **Invariants:** Total (never throws to callers); whole-input consumption enforced (expectEnd); deterministic single parse tree per input.
- **Tested:** `engine/solve/src/relation/relation.test.ts`

### Binding-branch root-cause walk (cause chains + ranked remediations)

`engine/solve/src/verdict/explain.ts`

- **Problem:** A violated band must come with WHY: which node's contribution actually binds the computed value, through which aggregation hops — and what change would move it.
- **Approach:** Greedy descent from the violated (node, key) along the BINDING branch of each aggregation — the bottleneck for min/product, the dominant contributor for sum/max — re-reading already-solved cell values (no new solve) until an origin's own local contribution binds; emits the hop chain plus remediations ranked by leverage.
- **Complexity:** O(depth * branching) cell reads, depth-bounded (64) and cycle-guarded by a seen set.
- **Citations:** None (structural attribution over the solved network; kin to critical-path tracing).
- **Invariants:** Pure and deterministic — only re-reads solved values; the walk terminates (bound + cycle guard); every link names the aggregation role that made it binding.
- **Tested:** `engine/solve/src/verdict/explain.test.ts`

## engine/solver-contract

### Cell-network to stack-machine bytecode compiler (the GPU payload)

`engine/solver-contract/src/gpu/compile.ts`

- **Problem:** Monte-Carlo batch evaluation needs the SAME cell values the CPU forward pass produces, executable thousands of times per second on a GPU — without interpreting arbitrary domain code.
- **Approach:** Compile each derived cell's closed arithmetic Expr into flat RPN bytecode (14 opcodes, 1:1 with Expr node kinds) with a deduplicated constant pool and stack high-water tracking; the Kleene sweep count is taken honestly from a CPU base solve; structural limits (cells, instructions, stack) or non-convergence DECLINE to CPU rather than mis-encode.
- **Complexity:** Compilation linear in cells * expr size; caps MAX_CELLS 2^16, MAX_INSTR 2^18, MAX_STACK 256.
- **Citations:** Stack-machine / RPN code generation (classic compiler construction, e.g. Aho et al.).
- **Invariants:** One instruction set shared by the WGSL kernel and the JS fp32 executor (they compute the same thing by construction); the closed op set covers EVERY design's forward numerics — declines are structural, never arithmetic; payload is domain-agnostic cell data.
- **Tested:** `engine/solver-contract/src/gpu/compile.test.ts`, `engine/solver-contract/src/gpu/differential.test.ts`

### Deviceless fp32 stack-machine executor (the GPU kernel's numeric twin)

`engine/solver-contract/src/gpu/fp32.ts`

- **Problem:** The WGSL kernel's arithmetic must be provable in CI with no GPU: a JS run that computes BIT-FOR-BIT what the device computes, so the differential can pin the device against it.
- **Approach:** Interpret the compiled bytecode over Float32Array-backed scratch — every store rounds to fp32, the same single-rounding-per-op semantics WGSL f32 has; per scenario: copy base cells, overlay overrides, run the compiled sweep count of Gauss-Seidel passes (Kleene from bottom, reads see earlier updates within a sweep, matching engine solve()); the shared Evaluation builder judges verdicts through the engine's own evaluateBands.
- **Complexity:** O(scenarios * sweeps * instructions) time; scratch memory O(cells + stack cap).
- **Citations:** IEEE 754 single-precision rounding semantics; WGSL f32 rounds once per op (W3C WGSL spec) — the fact that makes fround emulation exact.
- **Invariants:** Bit-identical to the WebGPU driver on the same bytecode (differential-pinned); fp32 results are preview-grade by policy — anything verdict-grade is CPU-confirmed.
- **Tested:** `engine/solver-contract/src/gpu/fp32.test.ts`, `engine/solver-contract/src/gpu/differential.test.ts`

### Per-design WGSL compute-kernel generation (batch scenario evaluation on device)

`engine/solver-contract/src/gpu/webgpu.ts`

- **Problem:** Thousands of Monte-Carlo scenarios must evaluate on a real GPU in one dispatch while computing exactly what the deviceless fp32 executor computes — no silent numeric drift.
- **Approach:** Generate a per-design WGSL compute shader (workgroup size 64, one invocation per scenario) that replays the compiled stack-machine bytecode with design dimensions baked as consts; upload base cells + override table, dispatch ceil(n/64) workgroups, map the settled cell arrays back; balanced error scopes, best-effort abort, destroy-on-exit.
- **Complexity:** Kernel O(sweeps * instructions) per invocation; transfer O(scenarios * cells).
- **Citations:** W3C WebGPU / WGSL specifications; bytecode-replay kernel design shared with engine/solver-contract/src/gpu/fp32.ts (the twin).
- **Invariants:** Bit-for-bit agreement with the fp32 twin (differential-tested on real devices); reached only via dynamic import so no entry bundle statically pulls the driver (bundle-separation invariant); a lost/absent device degrades to CPU, never to wrong numbers.
- **Tested:** `engine/solver-contract/src/gpu/differential.test.ts` (device arm)

### Seeded coverage-axis instance generation (solver-contract problems)

`engine/solver-contract/src/harness/generator.ts`

- **Problem:** The hand-checked conformance corpus pins obvious answers but not the SHAPE space a real solver meets; the differential suite needs many random-but-reproducible problems whose SAT/UNSAT regime is true by construction, aimed at the corners random sampling rarely hits.
- **Approach:** A self-contained mulberry32 PRNG (rngOf — deterministic across Node and browser, seeds are inputs, no Date/Math.random) drives per-coverage-axis planners (boundary, magnitude, depth, multiband, transforms, zero-traffic, latency, class, budget, scale, objective-tie, declined-*): each computes the exact achievable capacity/ceiling analytically so floors land exactly on or off the edge as the axis demands.
- **Complexity:** Per instance linear in tier count (up to ~100 for depth axes); the whole corpus is a fixed seeded batch.
- **Citations:** Property-based generation discipline (QuickCheck lineage, Claessen & Hughes 2000); mulberry32 (Tommy Ettinger, public domain).
- **Invariants:** Same seed => same instance, byte-for-byte; generated regimes (sat/unsat/declined) are correct by construction, not by solver opinion; imports ONLY @sda/engine-core (meta-model portability, dependency.test.ts).
- **Tested:** `engine/solver-contract/src/harness/generator.test.ts`, `engine/solver-contract/src/harness/harness.test.ts` (consumes the corpus)

### Differential + property grading of a candidate solver (the oracle harness runner)

`engine/solver-contract/src/harness/harness.ts`

- **Problem:** A second solver must be proven equivalent to the incumbent across a generated corpus — by the CONTRACT's equivalence, not knob-for-knob identity — plus laws no pair of agreeing-but- wrong solvers could fake.
- **Approach:** Two layers: differential — per capability, compare candidate vs certified oracle answer (optimize: same kind + float-tolerant objective + SLO satisfaction; repair: same total L1 distance; explain: same shortfall set; enumerate: exact order-independent selection set); and properties — determinism under seed, monotonicity, per-instance budget; a separate declines-honestly section asserts the candidate returns did-not-converge on the declined class while the oracle still solves; the incumbent grading itself is the sanity gate.
- **Complexity:** O(corpus size) instances, each one candidate call + comparisons.
- **Citations:** Differential testing (McKeeman 1998); metamorphic/property lineage (Claessen & Hughes 2000); equivalence rules are the contract's own (docs/design/solver-contract.html §5).
- **Invariants:** Seed offsets reproduce byte-identical corpora (SDA_HARNESS_SEED); any divergence carries its repro seed; equivalence never accepts a wrong KIND, and a decline is only honest where the oracle solves.
- **Tested:** `engine/solver-contract/src/harness/harness.test.ts` (incumbent as its own candidate), `engine/solver-contract/src/native/index.test.ts` (the native candidate)

### Metamorphic instance transforms (a-priori laws on the optimum)

`engine/solver-contract/src/harness/metamorphic.ts`

- **Problem:** A differential harness cannot see a bug BOTH solvers share — agreement with itself proves nothing; the suite needs perturbations whose effect on the optimum is known a-priori, as a LAW.
- **Approach:** Pure graph surgery with proven consequences: uniform rate scaling by k (the feasibility polytope is positively homogeneous of degree 1, so the optimal objective scales by exactly k); node/edge permutation via a seeded Fisher-Yates shuffle (optimum invariant); monotone band tightening (optimum never improves); repair-coherence transforms — then the runner asserts each law on the solver's answers.
- **Complexity:** O(graph size) per transform; shuffle O(n).
- **Citations:** Metamorphic testing (Chen, Cheung & Yiu 1998); Fisher-Yates shuffle (Knuth TAOCP v2); degree-1 homogeneity argument stated inline.
- **Invariants:** Transforms are solver-free algebra (imports only engine-core + the generator); seeds are inputs — every divergence reproduces from its integer seed.
- **Tested:** `engine/solver-contract/src/harness/metamorphic.test.ts`

### Oracle answer certification (fan-safe whole-graph total inversion)

`engine/solver-contract/src/harness/oracle.ts`

- **Problem:** The differential suite needs each generated instance's CERTIFIED answer, distilled to the equivalence surface (honesty kind + objective value + SLO satisfaction) — including a whole-graph objective total that no single cumulative out-cell accumulates on fan-out designs.
- **Approach:** Run the answering adapter (the incumbent binds here) through the same contract call the candidate uses; read the whole-graph total by INVERTING the cumulative out-cells — sum over nodes of out(n) minus sum over edges of out(parent) — the exact inverse of the sum aggregation, correct under fan-in/fan-out; re-evaluate the returned assignment to record epsilon-tolerant SLO satisfaction facts.
- **Complexity:** O(nodes + edges) for the inversion plus one adapter re-evaluation per instance.
- **Citations:** None (algebraic inversion of the network's own cumulative-sum fold).
- **Invariants:** Engine-core-pure (the adapter is a parameter — no WASM, no engine-solve import); nothing cached to disk (answers certified in-run); the distilled surface is exactly the contract's equivalence, no more.
- **Tested:** `engine/solver-contract/src/harness/oracle.test.ts`

### Callable knob-vector evaluator over the cell network (the native search model)

`engine/solver-contract/src/native/model.ts`

- **Problem:** The native search needs the design as an exactly-evaluable pure function x -> (objective(x), band-values(x)) — computed by the SAME arithmetic the oracle certifies, so the search can be exact about WHICH x it picks without re-implementing any math.
- **Approach:** Constant-fold everything independent of the tunables, verify the derived residue is acyclic (iterative-DFS cycle test — cyclic free flow is declined honestly), then evaluate by overlaying x onto the tunable config cells and running the engine's own least-fixpoint solve(); bands lift to floor/ceiling constraints and processor-sharing contention sites are extracted so the search can detect the saturation decline class.
- **Complexity:** One engine solve per probe (O(sweeps * cells * expr)); cycle test and site extraction linear in cells + refs; unbounded knob domains boxed to BOUND = 1e9 exactly like the incumbent.
- **Citations:** None (structural reduction; the exactness argument rides the engine's fixpoint and the JS<->MiniZinc differential, doc-4 §5).
- **Invariants:** Evaluation is engine-exact by construction (no drift possible); acyclicity is checked, never assumed; knob boxing mirrors the incumbent so both solvers search the same space.
- **Tested:** `engine/solver-contract/src/native/model.test.ts`

### Monotone corner-witness search (branch-and-bound collapse + per-knob bisection + coordinate descent)

`engine/solver-contract/src/native/search.ts`

- **Problem:** Answer optimize / repair / explain-infeasible in-process, fast enough for a canvas edit — no WASM, no spawned MIP — while matching the incumbent's continuous optimum exactly within the contract tolerance, and declining honestly outside the class it can prove.
- **Approach:** Exploit that the model is a pure, acyclic, MONOTONE function of the knob vector: (1) feasibility is decided at ONE box corner (the witness — the root prune a branch-and-bound would make, exact by monotonicity); (2) the optimum is found by per-knob binary-search inversion of each band threshold (the engine evaluator is the exact oracle at every probe), swept by coordinate descent to a fixpoint — which converges in one sweep because thresholds are independent; outside the monotone class (point bands, floor/ceiling coupling, saturating PS split, budget coupling) it DECLINES rather than guessing.
- **Complexity:** ~40 evaluations per knob (bisection to BISECT_TOL 1e-9), low thousands per design; deterministic hard budget MAX_EVALS = 200000 evaluation COUNT (not wall-clock).
- **Citations:** Branch-and-bound bounding (Land & Doig 1960) degenerate case; bisection; coordinate descent convergence under separable constraints (standard).
- **Invariants:** Every probe value is engine-exact (the same least-fixpoint the hot path runs); returned assignments genuinely satisfy every band (feasible side of each boundary); objective matches the incumbent within closeEnough (1e-4), enforced by the oracle harness referee; declines are honest, never a wrong number.
- **Tested:** `engine/solver-contract/src/native/search.test.ts`, `engine/solver-contract/src/native/index.test.ts` (oracle referee), `engine/solver-contract/src/harness/harness.test.ts` (differential + property laws)

## content/sda

### Envelope inversion (max demand s.t. SLOs) with exponential-search + bisection referee

`content/sda/src/envelope.ts`

- **Problem:** With no declared demand the tool must still answer: how much sustained load can each origin carry with every SLO green, what breaks first as load grows, and where is the queueing knee?
- **Approach:** Per-origin maxRps by solver INVERSION — free the origin's demand key (legal: it is a fact-assumption) and maximize it subject to the SLOs via the injected Optimize capability; the breaking order / joint edge / knee come from a generalized load sweep — exponential search for a bracketing factor, then bisection (40 halvings, ~1e-12) against forward evaluations; the sweep is also the honest fallback when the solver declines the inversion.
- **Complexity:** O(origins) injected optimize calls + O(origins * (log2(FACTOR_CAP) + 40)) forward evaluations for the sweep arms.
- **Citations:** Bisection / exponential search (folklore); the inversion is the no-cheating rule run backwards (docs/design/assumption-model.html §3).
- **Invariants:** Pure and deterministic aside from the injected solver (no clock, no randomness, fixed iteration counts); honest states — no origin => no envelope, broken at zero => maxRps 0, solver decline => sweep fallback, never a guess; native inversion and brute-force edge agree (differential-tested).
- **Tested:** `content/sda/src/envelope.test.ts`, `content/sda/src/envelope-des.e2e.test.ts`

### Multi-cycle λ(t) generator rate (baseline-anchored piecewise product)

`content/sda/src/load-stages.ts`

- **Problem:** A generator's demand is not one ramp but SEVERAL periodic shapes at once (a diurnal rhythm times a quarterly-report window), and every surface — the DES arrival stream, the Tier-1 sweep, the editor preview and the derived mean/peak — must read the SAME instantaneous rate, or the DRAWN shape and the EVALUATED shape drift.
- **Approach:** Model each cycle as a k6-style piecewise-linear MULTIPLIER anchored at ×1, and read the generator's instantaneous rate as the scalar product λ(t) = level · Π_cycles m_c(t mod periodS_c). Derive the mean (cost) and peak (verdicts) by sampling that product over one slowest period; lowering to the DES samples the same product to a fine piecewise-linear profile (the ×m̄ baseline compensation, §9), so drawn == evaluated.
- **Complexity:** O(cycles) per instant; O(restPointsPerCycle) samples per slowest period for the mean/peak + profile.
- **Citations:** k6 ramping-arrival-rate stages; Gatling injection profiles; superposition of periodic demand.
- **Invariants:** A FLAT generator (no cycles / all ×1) is byte-identical to steady generate(level) — the sacred pin; the product of piecewise-linear cycles is piecewise-quadratic, so the scalar λ(t) is the exact reader (§5).
- **Tested:** `content/sda/src/load-stages.test.ts`

### Analytic queueing twin (M/M/c per node, critical-path folds, Dijkstra lag bound)

`content/sda/src/queueing.ts`

- **Problem:** The canvas must show what users actually FEEL — queueing-aware latency, saturation, lag — live on every edit, where the forward pass's no-queue service sum stays finite even past saturation and a full DES is too slow.
- **Approach:** Model every node as the SAME M/M/c station the DES builds (c = concurrency servers, mu = 1/service; Erlang-C sojourn via engine mmc), fold real end-to-end latency as a memoized cycle-guarded critical-path MAX over predecessors, fold caller-facing response over the sync subtree per latencyComposition, and lower-bound flow lag with Dijkstra over every edge (the simple O(V^2) selection — graphs are small).
- **Complexity:** O(V + E) memoized folds; Dijkstra O(V^2); mmc O(c) per node.
- **Citations:** Erlang C / M/M/c (via engine/sim/src/analytic.ts); Little's law; Dijkstra 1959.
- **Invariants:** Agrees with the DES within tolerance (differential-tested); rho >= 1 answers Infinity honestly (unbounded queue), never a finite lie; the ideal (no-queue) figure is kept alongside, demoted not deleted.
- **Tested:** `content/sda/src/queueing.e2e.test.ts` (analytic vs DES), `content/sda/src/response-latency.e2e.test.ts`, `content/sda/src/origin-latency.e2e.test.ts`, `content/sda/src/headroom.test.ts`

### Robust sizing by per-world solve + knob-wise max

`content/sda/src/robust.ts`

- **Problem:** A design sized against ONE point of the assumption space is fragile; the search must find the cheapest configuration that holds every SLO across ALL selected worlds — with no new solver.
- **Approach:** Run the same injected repair/optimize once per world (base world always included), then combine by taking each provisioning knob's MAXIMUM across the per-world solutions — sound because every provisioning knob is monotone capacity-increasing, so max(worlds) satisfies each world at once; the world supplying a knob's max is derived as its binding constraint; the combined graph is re-verified in every world and any residual violation DECLINES honestly.
- **Complexity:** O(|worlds| + 1) injected solves + O(knobs * worlds) max reduction + O(|worlds|) verification evaluations.
- **Citations:** Robust optimization framing (Ben-Tal & Nemirovski, scenario-based reduction); the monotone knob-wise-max argument is stated inline.
- **Invariants:** Binding worlds are derived from actual per-world solves, never assumed; verification is mandatory — a combination that fails any world returns did-not-converge, not a guess; deterministic given the injected solver.
- **Tested:** `content/sda/src/robust.test.ts`, `content/sda/src/robustness.property.test.ts`

### DES network projection (graph to queueing network, transform means, Little's-law pools)

`content/sda/src/sim.ts`

- **Problem:** The typed-property graph must become the DES's queueing network — arrival sources, M/M/c stations, route edges — with flow transforms and retry policies translated into pure timing terms the simulator understands, staying consistent with the analytic twin.
- **Approach:** Project each node through the SAME capacity/server reads the analytic model uses (graph-read.ts — one definition, differential-consistent); translate per-port/per-wire transforms to mean per-completion multiplicities (ratio k, prob p, batch 1/n; rate ceilings cap/window induce no memoryless route thinning — the forward pass owns them); size connection pools by Little's-law algebra; lower generator cycles to baseline-anchored rate profiles; attach caller retry policies as DES AttemptPolicy.
- **Complexity:** O(V + E) single projection pass.
- **Citations:** Little 1961 (pool sizing); the transform-mean argument is stated inline (docs/design/flow-transformations.html).
- **Invariants:** Analytic and DES read capacity through the one shared definition (they can never drift); timeoutMs = 0 means byte-identical pre-retry behavior; a flat generator (no cycles / all ×1 / disabled) reduces to plain exponential arrivals exactly.
- **Tested:** `content/sda/src/sim.e2e.test.ts`, `content/sda/src/queueing.e2e.test.ts`, `content/sda/src/transform.e2e.test.ts`, `content/sda/src/generator.e2e.test.ts`

### Load sweep (origin scaling to surface the queueing knee)

`content/sda/src/sweep.ts`

- **Problem:** The doc and chart must show how end-to-end latency responds as traffic rises — the knee where latency stops being linear and runs away — using exactly the figures the capacity table reports.
- **Approach:** Detect traffic origins (the ONE shared OriginNode definition envelope reuses), scale them by fixed factors (0.5..1.5), re-run the forward evaluation at each point, and read the busiest flow's real (M/M/c queueing-aware) end-to-end latency.
- **Complexity:** O(|factors|) forward evaluations (default 5), each O(cells) via the engine solve.
- **Citations:** None (a parameter sweep; the queueing math is content/sda/src/queueing.ts).
- **Invariants:** Pure and deterministic (no clock, no randomness); a design with no origin returns an EMPTY series honestly, never fake points; every surface reuses this one computation (no drift).
- **Tested:** `content/sda/src/sweep.test.ts`

### System roll-up (union-find flow decomposition + cumulative-fold inversion)

`content/sda/src/system.ts`

- **Problem:** The end-to-end picture — per-flow throughput, latency, availability, cost — must be recovered from a solved graph whose cells carry CUMULATIVE values, and each node's OWN contribution is not stored anywhere.
- **Approach:** Decompose into request flows by union-find with path compression over wires plus directed BFS reachability per origin; recover own contributions by inverting the network's folds — own(n) = value(n) - sum of predecessors' values for sums, the quotient for the availability product; diagnose cyclic flows honestly instead of mis-summing them.
- **Complexity:** Union-find near-linear (path compression); reachability O(V + E) per origin; contribution inversion O(V + E).
- **Citations:** Union-find (Tarjan 1975); the inversions are exact algebraic inverses of the cell network's sum/product aggregations.
- **Invariants:** Inversion round-trips the engine's folds exactly (anchored by the sensitivity-matrix test); one shared computation for every surface — the human and the AI read the same numbers.
- **Tested:** `content/sda/src/system.e2e.test.ts`, `content/sda/src/sensitivity-matrix.test.ts`

### Tier-1 analytic time-sweep (quasi-static M/M/c response + per-node peak over the auto-derived span)

`content/sda/src/time-sweep.ts`

- **Problem:** A multi-cycle span is far too long to simulate arrival-by-arrival (a 90-day quarter at ~1000 rps is ~1500× the 5M-event DES cap — doc: load-stages §10.1), so the ambient transient answer needs a CHEAP core.
- **Approach:** Partition the auto-derived observation span (slowest period × spanRepeats) into windows sized to resolve the fastest cycle; at each window's instantaneous rate λ(t) = Σ_origins level·Π cycles(t), override each origin's reconciled assumedRps to that scalar and evaluate the STEADY-STATE response with the existing analytic M/M/c twin (queueing.ts nodeQueues) — one evaluation per window (the EvaluateBatch seam is declared but not yet activated, so this is the documented sequential loop; GPU batching is a later optimization). Each window also folds a SELF-ORIGIN ρ (an isolated generator serving its own λ(t)); peakLoadByNode then projects each node's worst window, so the per-node surfaces judge the declared PEAK, not just the steady baseline (R4).
- **Complexity:** O(windows × evaluate) — a diurnal design at 96 pts/day over 2 days is ~192 windows, sub-second.
- **Citations:** Quasi-static (adiabatic) approximation — a slowly-varying arrival rate ⇒ the instantaneous steady state; Erlang-C / M/M/c (via queueing.ts); Datadog rollup windowing (≤~300 intervals, load-stages §16.3 A).
- **Invariants:** Basis is 'analytic (quasi-static)' — the STEADY response per window, honest that it does NOT chain backlog window-to-window (that is Tier-2's measured transient, R2). Silent (undefined) for a design with no shaped generator (the no-filler rule). Deterministic.
- **Tested:** `content/sda/src/time-sweep.test.ts`

### Two-tier transient evaluation (propose cheap, prove exact — over time)

`content/sda/src/two-tier.ts`

- **Problem:** A multi-cycle season is far too long to simulate arrival-by-arrival, yet the mean-load steady answer hides the daily peak: the ambient transient question needs a cheap whole-season scan AND an exact proof at the one instant that matters — without a play button, and without blurring which basis produced which number.
- **Approach:** TIER 1 — the analytic quasi-static sweep (time-sweep.ts) scans the ρ-envelope over the auto-derived span and returns the worst window (basis analytic). TIER 2 — a targeted transient DES (engine/sim/transient.ts) zooms ONLY that worst window over a cap-fit neighbourhood, playing each origin's real λ(t), and reads the survival verdict — does it drain, how fast, where the backlog piled, what the tail cost (basis measured).
- **Complexity:** Tier 1 O(windows × evaluate); Tier 2 one bounded DES over the worst-window neighbourhood.
- **Citations:** "propose/prove" (an analytic screen, then simulate the survivor); Welch's warm-up for the transient.
- **Invariants:** The two labelled bases are never blurred; silent (undefined) with no shaped generator; the DES truncates LOUDLY under the event cap (a PARTIAL window, never scaled); deterministic for the seed.
- **Tested:** `content/sda/src/two-tier.e2e.test.ts`

### Monte Carlo over the assumption register (seeded sampling, type-7 quantiles, Pearson tornado)

`content/sda/src/uncertainty.ts`

- **Problem:** Every soft input is a declared range, not a point; conclusions must become reproducible DISTRIBUTIONS — percentiles, histograms, per-SLO confidence, sensitivity — without inventing any distribution the user did not declare.
- **Approach:** Seeded mulberry32 draws per scenario — uniform ranges by affine stretch, triangular by inverse-CDF; N scenarios evaluated through the injected EvaluateBatch capability; roll-ups use the type-7 (linear-interpolation) quantile estimator, fixed-bin histograms, SLO pass-fraction confidence, and a tornado from Pearson correlation on the SAME sample (no extra runs, noise floor ~1/sqrt(N)).
- **Complexity:** O(N) draws + injected evaluations (~1 ms each on the native path); O(N log N) per quantile sort; O(N) per tornado column.
- **Citations:** Metropolis & Ulam 1949 (Monte Carlo); Hyndman & Fan 1996 type 7 (NumPy default quantile); Pearson correlation; inverse-CDF sampling (Devroye 1986).
- **Invariants:** Same (design, n, seed) => byte-identical output on any platform; inputs without a declared range stay FIXED across scenarios (refused, never guessed); silent when nothing is ranged — results are the point answer bit-for-bit.
- **Tested:** `content/sda/src/uncertainty.test.ts` (quantiles vs closed form; tornado laws)

## app/presenter

### Hanan-grid A* orthogonal edge router (route, separate, justify)

`app/presenter/src/edge-routing.ts`

- **Problem:** Draw right-angle wires that avoid every node/group box, share doors and corridors legibly, and carry no needless bends — the draw.io / libavoid capability, without shipping LGPL code in an MIT project.
- **Approach:** Per edge, a Hanan-grid A*: candidate turning lines one clearance outside every obstacle plus the edge's own stubs; states are (grid point, heading) with a per-90-degree bend penalty and a total-ordered priority queue. Then two whole-design passes: separateEdges staggers shared doors and nudges corridor tracks; justifyBends re-tries every non-canonical bend against final geometry and keeps it only if an obstacle or shared corridor forces it (the R6 law, audited).
- **Complexity:** Per edge O(G log G) for G = O(n^2) Hanan grid vertices (x 4 headings) over n obstacles; separation/justification are near-linear in routed segments.
- **Citations:** Hart, Nilsson & Raphael 1968 (A*); Hanan 1966 (the Hanan grid); libavoid / draw.io orthogonal routing as the reference capability (re-implemented, no code reuse).
- **Invariants:** Deterministic (fixed neighbor order, total-ordered queue, no randomness); every shipped segment clears obstacle interiors at clearance; an edge's own endpoints/groups are never its obstacles; every shipped bend is justified (obstacle- or corridor-forced) per auditNeedlessBends.
- **Tested:** `app/presenter/src/edge-routing.test.ts`, `app/presenter/src/layout-benchmark.test.ts` (the benchmark gate audits needless bends on every committed example)

### GPU-proposer survivor selection (top-k by fp32 rank, CPU-proven survivors)

`app/presenter/src/layout-gpu/index.ts`

- **Problem:** A cheap fp32 ranking may misorder candidates near the top; the seam must let the proxy prune large batches without ever letting fp32 decide the applied layout or perturb small runs.
- **Approach:** Three-layer discipline behind the search's BatchScorer seam: rank the batch with the deviceless fp32 twin, keep the top DEFAULT_SURVIVORS (256, deterministic ties by index), score ONLY survivors with the exact routed CPU objective; pruned candidates get an infeasible sentinel so they can never enter the beam; batches at or under the cap bypass pruning entirely (byte-identical to the CPU-only scorer).
- **Complexity:** O(count) proxy scores + O(count log count) top-k sort above the cap; below it, exactly the CPU scorer's cost.
- **Citations:** None (selection discipline; the numeric core is ./proxy).
- **Invariants:** fp32-never-final (asserted by fp32IsNeverFinal); GPU-on vs GPU-off layouts are byte-identical on every committed example (under-cap bypass); winner is always CPU-proven twice (batch + final result()).
- **Tested:** `app/presenter/src/layout-gpu/proxy.test.ts` (ranking + never-final), `app/presenter/src/layout-gpu/device.test.ts`

### fp32 straight-line proxy objective (deviceless twin of the layout WGSL kernel)

`app/presenter/src/layout-gpu/proxy.ts`

- **Problem:** Routing a candidate costs ~2ms, so ranking THOUSANDS of beam candidates on real routes is unaffordable — yet any cheap proxy must be bit-reproducible on GPU and CPU alike so CI can prove the kernel without a device.
- **Approach:** Score four objective terms (crossings, length, alignment, symmetry) on straight center-to-center segments in strict fp32 — every op through Math.fround, single rounding, the exact WGSL f32 discipline — with each term's divergence from the routed truth documented; alignment uses the O(n^2) pairwise guideline question instead of greedy clustering (GPU-friendly).
- **Complexity:** Crossings O(e^2), alignment O(n^2), length O(e), symmetry O(sum fan-out) per candidate.
- **Citations:** WGSL f32 single-rounding semantics (W3C); same fround discipline as engine/solver-contract/src/gpu/fp32.ts; term definitions from the exact objective (app/presenter/src/layout-objective.ts).
- **Invariants:** Bit-identical to the WGSL kernel on the same input (device differential); a PROXY by contract — it only ranks/prunes, the CPU re-routes and re-scores every survivor exactly, so fp32 never decides the applied layout.
- **Tested:** `app/presenter/src/layout-gpu/proxy.test.ts`, `app/presenter/src/layout-gpu/device.test.ts` (device arm)

### Per-design WGSL layout-proxy kernel (batch candidate scoring on device)

`app/presenter/src/layout-gpu/webgpu.ts`

- **Problem:** Large offline candidate batches (the 50+-node growth axis, the perf benchmark) should rank on a real GPU — one candidate per invocation — while computing bit-for-bit what the deviceless twin computes.
- **Approach:** Generate a per-design WGSL compute shader (workgroup size 64) with node/edge/fan-out dimensions and term weights baked as consts, replaying the proxy's four fp32 term loops in the twin's exact op order; upload packed centers, dispatch ceil(count/64), map scores back; balanced error scopes, best-effort abort, destroy-on-exit; reached only via dynamic import (bundle-separation invariant).
- **Complexity:** Kernel O(e^2 + n^2) per invocation (crossings + pairwise alignment); dispatch ceil(count/64) workgroups.
- **Citations:** W3C WebGPU / WGSL specifications; mirrors the gpu-module discipline of engine/solver-contract/src/gpu/webgpu.ts (separate kernel, shared discipline).
- **Invariants:** Bit-for-bit agreement with the deviceless twin (device differential); never on the product per-slice path (sync beam uses the twin); accelerates proposals only — the CPU-exact re-score still decides every applied layout.
- **Tested:** `app/presenter/src/layout-gpu/device.test.ts`, `app/presenter/src/layout-gpu/bundle-separation.test.ts`

### Shared layout geometry kit (mulberry32, FNV-1a hash, longest-path columns, segment/track geometry)

`app/presenter/src/layout-model.ts`

- **Problem:** Every layout stage — objective, router, search, ports — must measure the SAME geometry and derive the SAME structure, or their scores and routes drift apart; the search also needs a platform-independent seed from the design itself.
- **Approach:** One dependency-free toolbox: mulberry32 seeded PRNG (the same generator content's uncertainty uses) + FNV-1a 32-bit content hash for design seeding; longest-path depth columns (the Sugiyama layering, cycle-guarded) and lane/flow decomposition by explicit-stack DFS; orientation-test segment crossing, polyline length/corners, box hits; and the R4 separation geometry (collinear overlap length, parallel track gap) from the connector-routing literature.
- **Complexity:** segmentsProperlyCross O(1); polylinesCross O(|a|*|b|); longestPathDepth O(V*E) worst case; hashes and PRNG O(1) per step.
- **Citations:** mulberry32 (Tommy Ettinger); FNV-1a (Fowler-Noll-Vo); Sugiyama et al. 1981 (layering); Wybrow, Marriott & Stuckey, GD 2009 (libavoid orthogonal routing — the separation measures); Hashimoto & Stevens 1971 (VLSI left-edge channel routing).
- **Invariants:** Pure and deterministic; platform-independent (no Date/Math.random — hash + seed give the same stream everywhere); the one anchor formula shared by router, renderer and layout family (no drift).
- **Tested:** `app/presenter/src/layout-model.test.ts`

### Weighted multi-term layout objective (14 soft terms over routed geometry)

`app/presenter/src/layout-objective.ts`

- **Problem:** Rank candidate placements by a single reviewable aesthetic score — crossings, length, alignment, symmetry, semantic tiers, and the R4 wire-separation/traceability terms — without a straight-line lie.
- **Approach:** Hard constraints reject outright; each soft term is normalized to [0,1] and the aggregate is 1 - sum((w_k/W) * p_k) over ACTIVE terms only (subject-less terms score null, honestly excluded); every geometry term is measured on the REAL routed polylines (the router is the arbiter); alignment guidelines come from greedy gap-threshold clustering of sorted anchor values.
- **Complexity:** Crossings O(s^2) pairwise over routed segments; alignment clustering O(n log n); the score is dominated by routing the candidate first.
- **Citations:** Aesthetic-criteria tradition of graph drawing (Purchase 1997; Sugiyama et al. 1981); separation/traceability terms after Wybrow, Marriott & Stuckey, GD 2009 (libavoid).
- **Invariants:** Deterministic; weights are the only place preference lives (LAYOUT_WEIGHTS); a hard violation can never be outscored; N/A terms renormalize rather than counting as zero.
- **Tested:** `app/presenter/src/layout-objective.test.ts`, `app/presenter/src/layout-benchmark.test.ts`

### Seeded beam search over node placements (the ideal-layout search)

`app/presenter/src/layout-optimize.ts`

- **Problem:** Find a near-optimal aesthetic placement — row orders, tie-breaks, jog removal — that the deterministic passes cannot decide, within an interactive budget and byte-reproducibly.
- **Approach:** Beam search (default width 6, ~6 mutation moves per candidate) seeded by Tidy, the semantic pass, symmetrize/compact/snap generators; candidates scored by the exact objective on REAL routed wires through an injectable BatchScorer (the GPU fp32 proposer ranks, the CPU always re-proves the winner); an exact-geometry memo plus box-infeasibility fast-reject skip provably result-neutral work; resumable slice scheduler for off-critical-path polish.
- **Complexity:** O(iterations * beam * moves) candidate evaluations, each dominated by routing (Hanan-grid A* per wire); iterations default min(120, max(20, 4n)); wall-clock capped by budgetMs with best-so-far semantics.
- **Citations:** Beam search folklore (Lowerre 1976, HARPY); memoization + dominance pruning standard.
- **Invariants:** Pure function of (seed, design-hash) via mulberry32 — same seed => byte-identical layout when the safety cap does not fire; pinned nodes never move; best-so-far floored at Tidy (any budget returns >= Tidy); cached and uncached pipelines are byte-identical (differential- tested); fp32 never decides the applied layout.
- **Tested:** `app/presenter/src/layout-optimize.test.ts`, `app/presenter/src/layout-benchmark.test.ts`

### Port sliding by weighted bounded isotonic regression (PAVA)

`app/presenter/src/layout-ports.ts`

- **Problem:** A node is one rigid body, so after row alignment two wires leaving different ports can never both be straight by moving the box — ports must slide along their side to sit opposite their peers while keeping manifest order, a readable gap and the pad band.
- **Approach:** Per node side: nearest-achievable-peer targets (with the elect guard so a shared fan port chases only its nearest peer), then projection onto the ordered-with-min-gap band by weighted isotonic regression — Pool-Adjacent-Violators on gap-shifted values plus the bound clamp; nodes sweep in reading order so left-to-right wires meet final anchors; the result ships only if anchor meets never regress vs. plain fractions.
- **Complexity:** O(p) PAVA per side (p ports on the side); O(N * p + wires) for the sweep + acceptance.
- **Citations:** Ayer et al. 1955 (PAVA); Barlow, Bartholomew, Bremner & Brunk 1972 (isotonic regression); Best & Chakravarti 1990 (linear-time PAVA); ELK/yFiles port-position optimization as the reference capability.
- **Invariants:** Manifest port order preserved; neighbors at least MIN_PORT_GAP apart; offsets inside the PORT_EDGE_PAD band; a side that cannot hold its ports assigns nothing (fraction fallback); anchor-level never-worse law vs. fractions; deterministic sweep (x, then y, then id).
- **Tested:** `app/presenter/src/layout-ports.test.ts`

### Deterministic layout refinements (column compaction, Reingold-Tilford centering, anchor snap)

`app/presenter/src/layout-refine.ts`

- **Problem:** Close the aggregate-score gap to generic compaction engines (dagre/ELK): Tidy's fixed 340px columns waste wire length/area and fan-outs are not straddled symmetrically.
- **Approach:** Three pure candidate GENERATORS the beam scores and floors at Tidy: compactColumns (per-rank X tightening, pitch = widest node + routing gutter, X-only so lanes/groups hold); symmetrizeFanouts (Reingold-Tilford downstream-centering — a parent centers on the mean of its children's per-wire anchor pulls, run per lane so H4 holds); snapToAnchors (re-seat rows exactly on the dominant wire's port-anchor line where separation allows).
- **Complexity:** O(V + E) per generator pass (rank scans + per-wire pulls); no search of its own.
- **Citations:** Reingold & Tilford, "Tidier Drawings of Trees", IEEE TSE 7(2), 1981 (the centering discipline, applied lane-aware to DAG fan-outs).
- **Invariants:** Pure and deterministic; compaction only tightens, never expands, and never moves a pinned column; Y-bands (and thus group boxes) are preserved by compaction; generators only PROPOSE — feasibility and acceptance are the objective's job.
- **Tested:** `app/presenter/src/layout-refine.test.ts`

### Damped iterative barycenter row smoothing in port-anchor space (the semantic pass)

`app/presenter/src/layout-semantic.ts`

- **Problem:** Tidy centers each column independently, so chains zig-zag and connected port anchors sit a few px off collinear — alignment a stochastic search would spend its whole budget rediscovering.
- **Approach:** One deterministic pass: keep Tidy's longest-path columns, partition into lanes, then run 16 iterations of damped barycenter smoothing where each node's row value is its DOMINANT connected-port anchor Y and each wire pulls its two endpoint anchors collinear; finish with the shared snapToAnchors generator because damped smoothing converges only asymptotically.
- **Complexity:** O(SMOOTH_ITERS * E) per lane (16 fixed iterations over the wires), plus the O(V + E) snap pass.
- **Citations:** Sugiyama, Tagawa & Toda 1981 (barycenter ordering); damped iterative relaxation folklore (Gauss-Seidel style smoothing).
- **Invariants:** Deterministic, no randomness, no GPU; single-port nodes reduce bit-for-bit to center smoothing; lanes (group membership) are never crossed; output only SEEDS the search — the objective accepts or rejects.
- **Tested:** `app/presenter/src/layout-semantic.test.ts`

### Tidy layered auto-layout (Sugiyama recipe)

`app/presenter/src/layout.ts`

- **Problem:** Give any design an instant, readable left-to-right layout — the floor every ideal-layout stage seeds from and may never ship worse than — with zero dependencies and zero randomness.
- **Approach:** The Sugiyama pipeline specialized for presentation: columns by longest-path depth from the sources; rows within a column ordered by the barycenter of upstream neighbors (crossing reduction) then vertically centered per lane; groups become stacked horizontal lanes sharing one column grid; measured node sizes drive spacing.
- **Complexity:** O(V * E) worst-case for longest-path layering (cycle-guarded relaxation); O(V log V) per-column barycenter sort.
- **Citations:** Sugiyama, Tagawa & Toda, "Methods for Visual Understanding of Hierarchical System Structures", IEEE SMC 11(2), 1981.
- **Invariants:** Pure view geometry, deterministic; every shell tidies identically (one shared function); tall measured nodes never overlap within a column.
- **Tested:** `app/presenter/src/presenter.test.ts`, `app/presenter/src/layout-semantic.test.ts`, `app/presenter/src/layout-benchmark.test.ts` (as the floor of every search run)

### Max-pool sparkline downsampling (a series to unicode) + the two-tier composition

`app/presenter/src/two-tier-view.ts`

- **Problem:** The ambient two-tier evaluation (doc: load-stages §10) must render as ONE compact block both shells show identically: the Tier-1 ρ-envelope across the season, the worst-window callout, the cost integral and the %-in-violation (basis analytic), plus — when Tier 2 has run — the survival verdict (basis measured), with the backlog peak (the fact a verdict hinges on) never disappearing in a compact strip.
- **Approach:** Max-pooling any series into <= 32 buckets (max, not mean, so downsampling preserves every peak), rendered as an 8-level unicode block ramp; the composition reads ONLY the values content's two-tier produced (two labelled bases), never re-deriving. Pure string, so the identical chart renders in a web span and a VS Code tree item.
- **Complexity:** O(series length) per sparkline.
- **Citations:** Max-pooling as peak-preserving decimation; unicode block sparklines after Holman's `spark`.
- **Invariants:** The global maximum always survives bucketing; all-zero series render a flat baseline; the two bases are never blurred; Tier-2 rows appear only when Tier 2 has run (the resting handshake's confirm).
- **Tested:** `app/presenter/src/two-tier-view.test.ts`

## app/web

### AABB insert-overlap predicate (the "Tidy?" offer)

`app/web/src/overlap.ts`

- **Problem:** After a picker-driven insert, the shell must decide — instantly and without false positives on deliberately abutting nodes — whether the new node landed on top of an existing one.
- **Approach:** Strict axis-aligned bounding-box intersection (interior area on BOTH axes; touching edges are a zero-width seam, not a collision) scanned over all placed boxes.
- **Complexity:** O(n) over placed nodes per insert; O(1) per pair.
- **Citations:** AABB intersection folklore (separating-axis degenerate case).
- **Invariants:** Pure geometry (no React/DOM), shared verbatim by both shells; a node never collides with itself; absent id answers false honestly.
- **Tested:** `app/web/src/overlap.test.ts`
