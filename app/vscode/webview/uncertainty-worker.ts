import { runUncertainty, registry, type AssumptionScenario, type Instance, type Wire, type UncertaintyResult } from '@sda/content';
import type { Graph } from '@sda/engine-core';
import type { EvaluateBatch } from '@sda/solver-contract';
import { makeGpuBatch } from '@sda/solver-contract/gpu';

// THE AMBIENT UNCERTAINTY WORKER — VS Code webview. Twin of app/web/src/uncertainty-worker.ts: Monte
// Carlo recomputes OFF the workbench renderer thread on every design change (the runSimulate pattern), LATEST-WINS,
// idle = zero work. Each run picks a backend by `mode`: `gpu` prefers the WebGPU fp32 kernel (a live PREVIEW cloud,
// available in the Chromium webview), falling back to the CPU reference silently where there is no device; `cpu`
// forces the fp64 reference (the resting handshake's CONFIRMATION pass). Reports which backend actually ran so the
// surface tags preview vs confirmed honestly (fp32 is never verdict-grade). Unlike the web worker, the GPU module
// is STATICALLY imported here: the VS Code webview boots this as a self-contained blob IIFE (cross-origin workers
// can't fetch split chunks — see main.tsx spawnSimWorker), so it must bundle to one file.

export interface UncWorkerRequest {
  readonly epoch: number; // the host's run token — only the LATEST epoch's result is applied
  readonly mode: 'gpu' | 'cpu';
  readonly graph: Graph;
  readonly instances: readonly Instance[];
  readonly wires: readonly Wire[];
  readonly n: number;
  readonly seed: number;
  /** The ACTIVE world (assumption-model doc §6) to center the sample on; absent ⇒ the base design (today's behaviour). */
  readonly scenario?: AssumptionScenario;
}
export type UncWorkerResponse =
  | { readonly ok: true; readonly epoch: number; readonly mode: 'gpu' | 'cpu'; readonly backend: 'gpu' | 'cpu'; readonly elapsedMs: number; readonly result: UncertaintyResult }
  | { readonly ok: false; readonly epoch: number; readonly message: string };

// One backend for the worker's lifetime, so the WebGPU device is created once and reused across runs.
const backend = makeGpuBatch({ registry });
// Best-effort cancellation: a newer run aborts the in-flight one (the contract's Cancellable semantics; latest-wins).
let currentAbort: AbortController | null = null;

self.onmessage = async (e: MessageEvent<UncWorkerRequest>): Promise<void> => {
  const msg = e.data;
  if (currentAbort) currentAbort.abort();
  const abort = new AbortController();
  currentAbort = abort;
  const started = performance.now();
  let used: 'gpu' | 'cpu' = 'cpu';
  const evaluateBatch: EvaluateBatch = async (req) => {
    const outcome = await backend.run(req, msg.mode);
    used = outcome.backend;
    return outcome.evaluations;
  };
  try {
    const result = await runUncertainty({ graph: msg.graph, instances: msg.instances, wires: msg.wires, n: msg.n, seed: msg.seed, signal: abort.signal, ...(msg.scenario ? { scenario: msg.scenario } : {}) }, evaluateBatch);
    if (abort.signal.aborted) return; // superseded while running ⇒ drop the stale answer (only the latest wins)
    self.postMessage({ ok: true, epoch: msg.epoch, mode: msg.mode, backend: used, elapsedMs: performance.now() - started, result } satisfies UncWorkerResponse);
  } catch (e) {
    if (!abort.signal.aborted) self.postMessage({ ok: false, epoch: msg.epoch, message: e instanceof Error ? e.message : String(e) } satisfies UncWorkerResponse);
  }
};
