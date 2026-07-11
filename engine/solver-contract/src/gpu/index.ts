// THE GPU BACKEND — the adapter entry (TASK-81). The SECOND implementation of the EvaluateBatch capability, a
// sibling to src/native/ (the CPU reference) behind the SAME contract seam. It compiles the design's cell network
// (./compile), runs it on a real WebGPU device when one is present (./webgpu, fp32), and otherwise falls back to
// the CPU reference SILENTLY (AC#4). It also REPORTS which backend ran, so the caller's resting handshake can tag
// fp32 GPU results 'preview' and fp64 CPU results 'confirmed' — fp32 is never presented as verdict-grade truth
// (AC#3, AC#6). Reached only through the dedicated dynamically-importable entry @sda/solver-contract/gpu, never a
// static runtime import (bundle separation — the WebGPU driver stays out of every entry bundle's static graph).

import type { Registry } from '@sda/engine-core';
import type { Evaluation } from '../capability';
import type { EvaluateBatch, EvaluateBatchRequest } from '../capability/evaluate-batch';
import { makeNativeAdapter } from '../native';
import { compileProgram, type DeclineReason } from './compile';
import { evaluationsFromCells, runProgramFp32 } from './fp32';
import { gpuDevice, runProgramOnGpu } from './webgpu';

export { compileProgram, OP, type CompiledProgram, type CompileResult, type DeclineReason } from './compile';
export { runProgramFp32, evaluationsFromCells } from './fp32';
export { gpuDevice, resetGpuProbe, generateWgsl } from './webgpu';

/** Which backend actually computed a batch, and — when the GPU was NOT used — the honest reason. `gpu` results are
 *  fp32 (preview-grade); `cpu` results are fp64 (verdict-grade). The handshake reads `backend` to tag the surface. */
export interface GpuBatchOutcome {
  readonly evaluations: readonly Evaluation[];
  readonly backend: 'gpu' | 'cpu';
  /** Absent for a clean GPU run; otherwise why the CPU reference ran instead: a compile decline, no device, or a
   *  device error / device loss (all map to the silent CPU fallback — never a wrong fp32 answer). */
  readonly reason?: DeclineReason | { readonly kind: 'no-device' } | { readonly kind: 'device-error'; readonly message: string };
}

/** The GPU batch adapter: the plain contract capability, an honest availability probe, and a rich `run` that
 *  reports the backend for the handshake. Built once per registry (the CPU reference is bound at construction, as
 *  every adapter binds its registry). */
export interface GpuBatch {
  /** Honest availability probe (AC#4): true iff a real WebGPU device is obtainable here. Cheap after the first
   *  call (the device is cached), so the ambient loop probes once rather than per run. */
  available(): Promise<boolean>;
  /** Compute a batch, preferring the GPU (fp32) unless `prefer:'cpu'` forces the fp64 reference (the confirmation
   *  pass of the resting handshake). Reports which backend ran. Falls back to CPU silently on decline/no-device/
   *  device-error; honors the request's AbortSignal (best-effort, per the contract). */
  run(req: EvaluateBatchRequest, prefer?: 'gpu' | 'cpu'): Promise<GpuBatchOutcome>;
  /** The plain EvaluateBatch capability (drops the backend report) — for the composition root / conformance. */
  readonly evaluateBatch: EvaluateBatch;
}

export interface GpuBatchDeps {
  readonly registry: Registry;
}

/**
 * Build the GPU batch adapter. The CPU reference is the native adapter's own `evaluateBatch` (fp64, the always-
 * available fallback and the confirmation backend), so the two implementations share ONE reference — there is no
 * second CPU code path to drift. The GPU path compiles the design once, probes for a device, runs the WGSL kernel,
 * and rebuilds the contract's Evaluations from the fp32 cell arrays (verdicts judged by the engine's own bands).
 */
export function makeGpuBatch(deps: GpuBatchDeps): GpuBatch {
  const cpuBatch = makeNativeAdapter({ registry: deps.registry }).evaluateBatch!;

  const run = async (req: EvaluateBatchRequest, prefer: 'gpu' | 'cpu' = 'gpu'): Promise<GpuBatchOutcome> => {
    if (prefer === 'cpu') return { evaluations: await cpuBatch(req), backend: 'cpu' };

    const compiled = compileProgram(req.graph, deps.registry);
    if (!compiled.ok) return { evaluations: await cpuBatch(req), backend: 'cpu', reason: compiled.decline };

    const device = await gpuDevice();
    if (device === null) return { evaluations: await cpuBatch(req), backend: 'cpu', reason: { kind: 'no-device' } };

    try {
      const cells = await runProgramOnGpu(device, compiled.program, req.scenarios, req.signal);
      if (cells === null) return { evaluations: [], backend: 'gpu' }; // aborted mid-run ⇒ discard (best-effort)
      return { evaluations: evaluationsFromCells(req.graph, deps.registry, compiled.program, cells), backend: 'gpu' };
    } catch (e) {
      // Device error / device loss ⇒ honest silent fallback to the fp64 reference (never a wrong fp32 answer).
      return { evaluations: await cpuBatch(req), backend: 'cpu', reason: { kind: 'device-error', message: e instanceof Error ? e.message : String(e) } };
    }
  };

  return {
    available: async () => (await gpuDevice()) !== null,
    run,
    evaluateBatch: async (req) => (await run(req)).evaluations,
  };
}

/**
 * A DEVICELESS fp32 EvaluateBatch — the kernel's numeric path (the compiled bytecode run through the Float32Array
 * executor) exposed as the contract capability, with NO WebGPU. It computes exactly what the GPU kernel computes
 * (same bytecode, same single-rounding-per-op f32 semantics) but on the CPU, so it lets a test exercise the
 * kernel's arithmetic — and the whole content Monte-Carlo pipeline over it — without a device. On a build/decline
 * it falls back to the fp64 reference (the honest thing when the design cannot be compiled). NOT a product path:
 * the shells use fp64 CPU when no GPU is present (fp32 is never presented as verdict-grade).
 */
export function makeFp32Batch(deps: GpuBatchDeps): EvaluateBatch {
  const cpuBatch = makeNativeAdapter({ registry: deps.registry }).evaluateBatch!;
  return async (req) => {
    const compiled = compileProgram(req.graph, deps.registry);
    if (!compiled.ok) return cpuBatch(req);
    const cells = runProgramFp32(compiled.program, req.scenarios);
    return evaluationsFromCells(req.graph, deps.registry, compiled.program, cells);
  };
}
