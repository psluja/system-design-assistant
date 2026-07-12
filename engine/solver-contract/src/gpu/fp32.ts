// @algorithm Deviceless fp32 stack-machine executor (the GPU kernel's numeric twin)
// @problem The WGSL kernel's arithmetic must be provable in CI with no GPU: a JS run that computes
//   BIT-FOR-BIT what the device computes, so the differential can pin the device against it.
// @approach Interpret the compiled bytecode over Float32Array-backed scratch — every store rounds to
//   fp32, the same single-rounding-per-op semantics WGSL f32 has; per scenario: copy base cells,
//   overlay overrides, run the compiled sweep count of Gauss-Seidel passes (Kleene from bottom,
//   reads see earlier updates within a sweep, matching engine solve()); the shared Evaluation
//   builder judges verdicts through the engine's own evaluateBands.
// @complexity O(scenarios * sweeps * instructions) time; scratch memory O(cells + stack cap).
// @citations IEEE 754 single-precision rounding semantics; WGSL f32 rounds once per op (W3C WGSL
//   spec) — the fact that makes fround emulation exact.
// @invariants Bit-identical to the WebGPU driver on the same bytecode (differential-pinned);
//   fp32 results are preview-grade by policy — anything verdict-grade is CPU-confirmed.
// @where-tested engine/solver-contract/src/gpu/fp32.test.ts,
//   engine/solver-contract/src/gpu/differential.test.ts

// THE GPU BACKEND — fp32 executor + Evaluation builder. This module runs the compiled stack-machine
// bytecode (./compile) in PURE JS over Float32Array-backed scratch, which rounds every intermediate to fp32 on
// each store — the exact same single-rounding-per-op semantics a WGSL `f32` kernel has. So this is a faithful,
// DEVICELESS emulation of the GPU kernel's numeric path: the differential's fp32 unit test drives THIS to prove
// the kernel's arithmetic (Math.fround folds) without a GPU, and the real WebGPU driver (./webgpu) must match it.
//
// It also holds the SHARED Evaluation builder that turns per-scenario cell arrays (from either backend — fp32 JS
// or real GPU) into the contract's `Evaluation[]`: `value(node, key)` reads the settled `out(node, key)` slot, and
// verdicts come from the engine's OWN `evaluateBands` over the computed values (so a GPU-preview verdict is judged
// exactly as a CPU one would be — just on fp32 values, which is why anything verdict-grade is CPU-confirmed later).

import type { Graph, Key, NodeId, Registry, Verdict } from '@sda/engine-core';
import { buildNetwork, evaluateBands } from '@sda/engine-solve';
import type { Evaluation, Scenario } from '../capability';
import type { CompiledProgram } from './compile';
import { OP } from './compile';

/**
 * Run the compiled program over a batch of scenarios in fp32, returning ONE full cell array per scenario. The
 * scratch `cell` and `stack` are Float32Array, so each op's result is rounded to fp32 exactly as the WGSL kernel
 * rounds it — this IS the kernel's numeric path, emulated deviceless. For each scenario: copy the base cells,
 * substitute the scenario's overrides onto their config slots, run `sweeps` Gauss-Seidel passes over the bytecode
 * (Kleene iteration from ⊥ — reads within a sweep see earlier cells' updates, matching engine/solve `solve`), then
 * snapshot the settled cell array.
 */
export function runProgramFp32(program: CompiledProgram, scenarios: readonly Scenario[]): Float32Array[] {
  const { nCells, baseCells, code, nInstr, consts, sweeps, stackCap, overrideSlotOf } = program;
  const cell = new Float32Array(nCells);
  const stack = new Float32Array(Math.max(1, stackCap));
  const out: Float32Array[] = [];
  for (const scenario of scenarios) {
    cell.set(baseCells);
    for (const [key, value] of Object.entries(scenario.overrides)) {
      const slot = overrideSlotOf.get(key);
      if (slot !== undefined) cell[slot] = value; // Float32Array store ⇒ rounded to fp32, exactly as the kernel
    }
    for (let s = 0; s < sweeps; s++) {
      let sp = 0;
      for (let i = 0; i < nInstr; i++) {
        const op = code[2 * i]!;
        const arg = code[2 * i + 1]!;
        switch (op) {
          case OP.PUSH_CONST:
            stack[sp++] = consts[arg]!;
            break;
          case OP.PUSH_CELL:
            stack[sp++] = cell[arg]!;
            break;
          case OP.NEG:
            stack[sp - 1] = -stack[sp - 1]!;
            break;
          case OP.ADD:
            sp--;
            stack[sp - 1] = stack[sp - 1]! + stack[sp]!;
            break;
          case OP.SUB:
            sp--;
            stack[sp - 1] = stack[sp - 1]! - stack[sp]!;
            break;
          case OP.MUL:
            sp--;
            stack[sp - 1] = stack[sp - 1]! * stack[sp]!;
            break;
          case OP.DIV:
            sp--;
            stack[sp - 1] = stack[sp - 1]! / stack[sp]!;
            break;
          case OP.MIN:
            sp--;
            stack[sp - 1] = Math.min(stack[sp - 1]!, stack[sp]!);
            break;
          case OP.MAX:
            sp--;
            stack[sp - 1] = Math.max(stack[sp - 1]!, stack[sp]!);
            break;
          case OP.LT:
            sp--;
            stack[sp - 1] = stack[sp - 1]! < stack[sp]! ? 1 : 0;
            break;
          case OP.LE:
            sp--;
            stack[sp - 1] = stack[sp - 1]! <= stack[sp]! ? 1 : 0;
            break;
          case OP.GT:
            sp--;
            stack[sp - 1] = stack[sp - 1]! > stack[sp]! ? 1 : 0;
            break;
          case OP.GE:
            sp--;
            stack[sp - 1] = stack[sp - 1]! >= stack[sp]! ? 1 : 0;
            break;
          case OP.EQ:
            sp--;
            stack[sp - 1] = stack[sp - 1]! === stack[sp]! ? 1 : 0;
            break;
          case OP.STORE_CELL:
            cell[arg] = stack[--sp]!;
            break;
        }
      }
    }
    out.push(cell.slice());
  }
  return out;
}

/**
 * Turn per-scenario cell arrays (from the fp32 JS executor OR the real GPU) into the contract's `Evaluation[]`.
 * The network is rebuilt ONCE for the whole batch (cheap; scenario-invariant topology) so verdicts come from the
 * engine's own `evaluateBands` — a GPU/fp32 verdict is judged by the SAME code a CPU verdict is, over the computed
 * values. `converged` is false for a scenario whose cell array carries a NaN (±Inf is a legitimate min/max
 * identity, exactly as the fixpoint solver treats it). Returns one Evaluation per cell array, in order.
 */
export function evaluationsFromCells(graph: Graph, registry: Registry, program: CompiledProgram, cellArrays: readonly Float32Array[]): Evaluation[] {
  const built = buildNetwork(graph, registry);
  const network = built.ok ? built.value : null;
  const { cellIds, outIndexOf } = program;
  return cellArrays.map((cells): Evaluation => {
    const value = (node: NodeId, key: Key): number | undefined => {
      const slot = outIndexOf.get(`${String(node)}|${String(key)}`);
      return slot === undefined ? undefined : cells[slot]!;
    };
    let hasNaN = false;
    for (let i = 0; i < cells.length; i++) if (Number.isNaN(cells[i]!)) { hasNaN = true; break; }
    let verdicts: readonly Verdict[] = [];
    if (network !== null) {
      const values = new Map<string, number>();
      for (let i = 0; i < cellIds.length; i++) values.set(cellIds[i]!, cells[i]!);
      verdicts = evaluateBands(graph, registry, network, values);
    }
    return { converged: !hasNaN, value, verdicts };
  });
}
