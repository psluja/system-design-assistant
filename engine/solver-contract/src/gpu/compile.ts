// @algorithm Cell-network to stack-machine bytecode compiler (the GPU payload)
// @problem Monte-Carlo batch evaluation needs the SAME cell values the CPU forward pass produces,
//   executable thousands of times per second on a GPU — without interpreting arbitrary domain code.
// @approach Compile each derived cell's closed arithmetic Expr into flat RPN bytecode (14 opcodes,
//   1:1 with Expr node kinds) with a deduplicated constant pool and stack high-water tracking; the
//   Kleene sweep count is taken honestly from a CPU base solve; structural limits (cells,
//   instructions, stack) or non-convergence DECLINE to CPU rather than mis-encode.
// @complexity Compilation linear in cells * expr size; caps MAX_CELLS 2^16, MAX_INSTR 2^18,
//   MAX_STACK 256.
// @citations Stack-machine / RPN code generation (classic compiler construction, e.g. Aho et al.).
// @invariants One instruction set shared by the WGSL kernel and the JS fp32 executor (they compute
//   the same thing by construction); the closed op set covers EVERY design's forward numerics —
//   declines are structural, never arithmetic; payload is domain-agnostic cell data.
// @where-tested engine/solver-contract/src/gpu/compile.test.ts,
//   engine/solver-contract/src/gpu/differential.test.ts

// THE GPU BACKEND — compile step (TASK-81). The WebGPU EvaluateBatch backend is the SECOND implementation of
// the EvaluateBatch capability behind the same contract seam (native/ is the CPU reference). It does NOT
// interpret an arbitrary domain: it compiles the ENGINE's own cell-network — a flat, dependency-ordered list of
// cells where each derived cell is a small closed arithmetic Expr (num / ref / neg / + − × ÷ / min / max /
// compare→1|0; engine/solve relation/ast.ts) — into a tiny STACK-MACHINE bytecode. The identical bytecode then
// runs two ways: on the GPU (a WGSL kernel, one invocation per scenario, fp32) and in a Float32Array-backed JS
// executor (fp32 emulation, deviceless — see ./fp32). Because the whole numeric surface the forward pass uses is
// this closed op set, the kernel expresses EVERY design's numerics; it declines (falls back to CPU) only for the
// few STRUCTURAL reasons enumerated in {@link DeclineReason}, never for an arithmetic construct it cannot encode.
//
// WHY compile the cell network rather than a per-metric fold: the caller (Monte-Carlo uncertainty, content
// runUncertainty) reads metrics through `Evaluation.value(node, key)` — cost is a content roll-up over per-node
// cost cells, flow latency/availability are terminal cell reads. So the honest, general thing is to reproduce the
// SAME cell VALUES the CPU forward pass produces; every metric then falls out of the existing content projectors
// unchanged. This is domain-agnostic by construction (the payload is cell-network data — the engine invariant).

import type { Graph, Key, NodeId, Registry } from '@sda/engine-core';
import { buildNetwork, solve, type Cell, type CellId, type Expr, type Network } from '@sda/engine-solve';

/** The stack-machine opcodes. Each maps 1:1 to an `Expr` node kind (or the two housekeeping ops PUSH/STORE), so
 *  the WGSL kernel and the JS executor share ONE instruction set — the guarantee they compute the same thing. */
export const OP = {
  PUSH_CONST: 0, // stack.push(consts[arg])
  PUSH_CELL: 1, //  stack.push(cell[arg])
  NEG: 2, //        a = pop; push(-a)
  ADD: 3, //        b = pop; a = pop; push(a + b)
  SUB: 4, //        push(a - b)
  MUL: 5, //        push(a * b)
  DIV: 6, //        push(a / b)
  MIN: 7, //        push(min(a, b))
  MAX: 8, //        push(max(a, b))
  LT: 9, //         push(a <  b ? 1 : 0)
  LE: 10, //        push(a <= b ? 1 : 0)
  GT: 11, //        push(a >  b ? 1 : 0)
  GE: 12, //        push(a >= b ? 1 : 0)
  EQ: 13, //        push(a == b ? 1 : 0)
  STORE_CELL: 14, // cell[arg] = pop  (writes one derived cell's settled value for this sweep)
} as const;

/** Why the GPU backend DECLINED to compile a design — an honest, enumerable reason the caller reports and then
 *  falls back to the CPU reference for. Note there is NO "unsupported arithmetic" reason: the Expr op set is fully
 *  expressible, so every decline is STRUCTURAL (a build error, a non-convergent base fixpoint, or a size cap). */
export type DeclineReason =
  | { readonly kind: 'build-error'; readonly errors: readonly string[] } // the graph does not build a cell network
  | { readonly kind: 'did-not-converge' } // the CPU base fixpoint did not settle ⇒ no honest sweep count exists
  | { readonly kind: 'unbound-ref'; readonly cell: CellId } // a cell references an id absent from the system (defensive)
  | { readonly kind: 'too-large'; readonly what: 'cells' | 'instructions' | 'stack'; readonly value: number; readonly cap: number };

/** A compiled, GPU-ready program: the flat cell array shape, the bytecode, and the maps to read a value back. It
 *  is pure DATA (typed arrays + a couple of lookup maps), so it structured-clones across a worker boundary and is
 *  identical on CPU and GPU. The heavy lifting (topology, Expr walk) happens ONCE per design at compile time. */
export interface CompiledProgram {
  readonly nCells: number;
  /** index → CellId, so the executor can rebuild a `values` map (for verdicts) keyed the way the engine expects. */
  readonly cellIds: readonly CellId[];
  /** Base cell values: an input cell's fixed number, a derived cell's ⊥ (0) — exactly the fixpoint solver's init. */
  readonly baseCells: Float32Array;
  /** The bytecode: 2 i32 per op — `code[2i]` = opcode, `code[2i+1]` = the operand (const index / cell index / 0). */
  readonly code: Int32Array;
  readonly nInstr: number;
  /** The constant pool the PUSH_CONST ops index into (fp32). */
  readonly consts: Float32Array;
  /** Kleene sweeps to run: the CPU base fixpoint's own iteration count, so the GPU runs AT LEAST as many Gauss-
   *  Seidel passes as the reference needed (a DAG settles in 1–2; a cyclic SCC iterates). */
  readonly sweeps: number;
  /** The stack high-water mark, so the kernel/executor size their scratch stack exactly. */
  readonly stackCap: number;
  /** `"node|key"` → cell index of a FIXED config input a scenario may override (the Monte-Carlo sample coordinate). */
  readonly overrideSlotOf: ReadonlyMap<string, number>;
  /** `"node|key"` → cell index of `out(node, key)`, so `value(node, key)` reads the settled output slot. */
  readonly outIndexOf: ReadonlyMap<string, number>;
}

/** The union `compileProgram` returns: a compiled program, or an honest decline the caller falls back to CPU for. */
export type CompileResult = { readonly ok: true; readonly program: CompiledProgram } | { readonly ok: false; readonly decline: DeclineReason };

// Size caps — a large-but-finite envelope. Real designs are far below these; a pathological one declines to CPU
// rather than compiling a multi-megabyte shader. The stack cap bounds the WGSL function-local scratch array.
const MAX_CELLS = 1 << 16; // 65,536 cells
const MAX_INSTR = 1 << 18; // 262,144 instructions
const MAX_STACK = 256; // Expr trees are shallow; 256 is generous headroom before an honest decline

/**
 * Compile a design graph into a GPU-ready stack-machine program, or DECLINE honestly. Steps:
 *   1. project the graph into the engine's cell network (`buildNetwork`) — a build error declines;
 *   2. solve the BASE fixpoint once on the CPU to (a) learn the honest sweep count and (b) refuse a design whose
 *      fixpoint does not settle (no fp32 sweep count could be trusted for it);
 *   3. lay the cells out in the network's canonical dependency order and compile each derived cell's Expr to RPN
 *      bytecode (a STORE_CELL terminates each cell), tracking the constant pool and the stack high-water mark;
 *   4. build the override- and output-slot maps so scenarios can be applied and metrics read back.
 * PURE and deterministic — the same graph compiles to byte-identical arrays on any platform.
 */
export function compileProgram(graph: Graph, registry: Registry): CompileResult {
  const built = buildNetwork(graph, registry);
  if (!built.ok) return { ok: false, decline: { kind: 'build-error', errors: built.error } };
  const network: Network = built.value;
  const system = network.system;

  // The CPU base solve: the reference values AND the honest sweep count (a DAG settles in 1–2 sweeps; a cyclic
  // SCC iterates to its least fixpoint). A non-converged base declines — the GPU must never guess a sweep count.
  const base = solve(system);
  if (!base.converged) return { ok: false, decline: { kind: 'did-not-converge' } };

  const cellIds = [...system.keys()];
  const nCells = cellIds.length;
  if (nCells > MAX_CELLS) return { ok: false, decline: { kind: 'too-large', what: 'cells', value: nCells, cap: MAX_CELLS } };
  const cellIndex = new Map<CellId, number>();
  for (let i = 0; i < nCells; i++) cellIndex.set(cellIds[i]!, i);

  // Base cell values: an input cell's fixed number; a derived cell's ⊥ (0) — the solver's exact Kleene init.
  const baseCells = new Float32Array(nCells);
  for (let i = 0; i < nCells; i++) {
    const cell = system.get(cellIds[i]!)!;
    baseCells[i] = cell.kind === 'input' ? cell.value : 0;
  }

  // Compile each derived cell's Expr to RPN, appended in the canonical dependency order (so one sweep settles a
  // DAG). A single flat constant pool is deduplicated (SameValueZero, so ±Inf / NaN identities pool cleanly).
  const code: number[] = [];
  const consts: number[] = [];
  const constIndex = new Map<number, number>();
  let stackCap = 0;
  let unbound: CellId | null = null;

  const constSlot = (v: number): number => {
    const existing = constIndex.get(v);
    if (existing !== undefined) return existing;
    const idx = consts.length;
    consts.push(v);
    constIndex.set(v, idx);
    return idx;
  };

  // Emit an Expr as RPN, tracking the running/peak stack depth. `depth` is the stack size BEFORE this expr; the
  // returned value is the depth AFTER (always `depth + 1` — every expr yields exactly one value). Recursion depth
  // is bounded by the (shallow) Expr tree, not the design size, so no call-stack risk on wide/deep graphs.
  const emit = (e: Expr<CellId>, depth: number): number => {
    switch (e.kind) {
      case 'num': {
        code.push(OP.PUSH_CONST, constSlot(e.value));
        return bump(depth);
      }
      case 'ref': {
        const idx = cellIndex.get(e.key);
        if (idx === undefined) {
          unbound = e.key; // defensive: buildNetwork resolves every ref, so this is unreachable for a built graph
          code.push(OP.PUSH_CONST, constSlot(0));
          return bump(depth);
        }
        code.push(OP.PUSH_CELL, idx);
        return bump(depth);
      }
      case 'neg': {
        const after = emit(e.arg, depth); // pushes one
        code.push(OP.NEG, 0); // unary: depth unchanged
        return after;
      }
      case 'binary': {
        emit(e.left, depth);
        emit(e.right, depth + 1); // right sits above left
        code.push(BINARY_OP[e.op], 0); // pops two, pushes one ⇒ net depth = depth + 1
        return depth + 1;
      }
      case 'call': {
        // n-ary min/max ⇒ a left fold of the binary op: arg0, arg1, OP, arg2, OP, … (evalExpr uses Math.min(...);
        // the fold is associative for min/max, so it is the same value). `call` always has ≥1 arg (aggregateExpr).
        const op = e.fn === 'min' ? OP.MIN : OP.MAX;
        emit(e.args[0]!, depth);
        for (let i = 1; i < e.args.length; i++) {
          emit(e.args[i]!, depth + 1);
          code.push(op, 0);
        }
        return depth + 1;
      }
      case 'compare': {
        emit(e.left, depth);
        emit(e.right, depth + 1);
        code.push(COMPARE_OP[e.op], 0); // pops two, pushes 1|0
        return depth + 1;
      }
    }
  };
  const bump = (depth: number): number => {
    const after = depth + 1;
    if (after > stackCap) stackCap = after;
    return after;
  };

  for (const id of cellIds) {
    const cell = system.get(id)!;
    if (cell.kind !== 'derived') continue;
    emit(cell.expr, 0);
    code.push(OP.STORE_CELL, cellIndex.get(id)!); // pops the settled value into this cell's slot
  }

  if (unbound !== null) return { ok: false, decline: { kind: 'unbound-ref', cell: unbound } };
  const nInstr = code.length / 2;
  if (nInstr > MAX_INSTR) return { ok: false, decline: { kind: 'too-large', what: 'instructions', value: nInstr, cap: MAX_INSTR } };
  if (stackCap > MAX_STACK) return { ok: false, decline: { kind: 'too-large', what: 'stack', value: stackCap, cap: MAX_STACK } };

  // Override slots: every FIXED config input is a cfg cell a scenario may substitute (the sample coordinate). The
  // native adapter's `applyOverrides` addresses them the SAME way — `"node|key"` — so the two backends draw from
  // one addressing scheme. Output slots: `out(node, key)` for every (node, key) whose output cell exists, so
  // `value(node, key)` reads the settled slot. Both are resolved via the network accessor (no id-format assumption).
  const overrideSlotOf = new Map<string, number>();
  const keysByNode = new Map<NodeId, Set<Key>>();
  for (const node of graph.nodes.values()) {
    const ks = new Set<Key>();
    keysByNode.set(node.id, ks);
    for (const c of node.cells) {
      ks.add(c.key);
      if (c.kind === 'input' && c.value.kind === 'fixed') {
        const idx = cellIndex.get(cfgId(node.id, c.key));
        if (idx !== undefined) overrideSlotOf.set(`${String(node.id)}|${String(c.key)}`, idx);
      }
    }
  }
  // Every key in play anywhere can appear at any node's out cell (a summed/min-aggregated key flows through), so
  // the output map is over (node, all keys in play) — checking which actually resolved to a real out cell.
  const allKeys = new Set<Key>();
  for (const ks of keysByNode.values()) for (const k of ks) allKeys.add(k);
  const outIndexOf = new Map<string, number>();
  for (const node of graph.nodes.values()) {
    for (const k of allKeys) {
      const idx = cellIndex.get(network.out(node.id, k));
      if (idx !== undefined) outIndexOf.set(`${String(node.id)}|${String(k)}`, idx);
    }
  }

  return {
    ok: true,
    program: {
      nCells,
      cellIds,
      baseCells,
      code: Int32Array.from(code),
      nInstr,
      consts: Float32Array.from(consts),
      sweeps: Math.max(1, base.iterations),
      stackCap: Math.max(1, stackCap),
      overrideSlotOf,
      outIndexOf,
    },
  };
}

/** The cfg cell id for a (node, key) — MUST mirror engine/solve network/build.ts `cfgId`. Used only to find a
 *  fixed input's override slot; every OTHER slot is resolved through the network accessor, not a format guess. */
const cfgId = (n: NodeId, k: Key): CellId => `cfg:${String(n)}:${String(k)}`;

const BINARY_OP: Record<'+' | '-' | '*' | '/', number> = { '+': OP.ADD, '-': OP.SUB, '*': OP.MUL, '/': OP.DIV };
const COMPARE_OP: Record<'<=' | '<' | '>=' | '>' | '==', number> = { '<=': OP.LE, '<': OP.LT, '>=': OP.GE, '>': OP.GT, '==': OP.EQ };

/** The `Cell` type is re-exported so sibling modules type the system map without reaching into engine-solve twice. */
export type { Cell, CellId, Network };
