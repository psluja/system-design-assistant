import { runUncertainty, registry, type AssumptionScenario, type Instance, type Wire, type UncertaintyResult } from '@sda/content';
import type { Graph } from '@sda/engine-core';
import type { EvaluateBatch } from '@sda/solver-contract';

// THE AMBIENT UNCERTAINTY WORKER (TASK-81). Monte-Carlo uncertainty recomputes OFF the page thread on every design
// change — the runSimulate pattern (sim-worker.ts): a persistent worker, LATEST-WINS supersession, idle = zero
// work. Each run picks a backend by `mode`: `gpu` prefers the WebGPU fp32 kernel (a live PREVIEW cloud) and falls
// back to the CPU reference silently where there is no device; `cpu` forces the fp64 reference (the resting
// handshake's CONFIRMATION pass). The worker REPORTS which backend actually ran so the shell tags preview vs
// confirmed honestly (fp32 is never presented as verdict-grade). The GPU module is LAZILY imported (bundle
// separation: the WebGPU driver never lands in the entry bundle's static graph; it loads on the first ambient run).

export interface UncWorkerRequest {
  readonly epoch: number; // the shell's run token — only the LATEST epoch's result is applied
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

// The GPU batch adapter, built lazily on the first run (the dynamic import() keeps @sda/solver-contract/gpu — and
// its WebGPU driver — out of every eager bundle; TS still types it fully). Reused across runs so the WebGPU device
// is created once, not per run. `ReturnType<typeof loadBackend>` names its type without a static import of the module.
function loadBackend() {
  return import('@sda/solver-contract/gpu').then((m) => m.makeGpuBatch({ registry }));
}
let backendP: ReturnType<typeof loadBackend> | null = null;

// Best-effort cancellation: a newer run aborts the in-flight one, so the stale GPU queue / CPU loop is abandoned
// rather than finishing wasted work (the contract's Cancellable semantics; latest-wins).
let currentAbort: AbortController | null = null;

self.onmessage = async (e: MessageEvent<UncWorkerRequest>): Promise<void> => {
  const msg = e.data;
  if (currentAbort) currentAbort.abort();
  const abort = new AbortController();
  currentAbort = abort;
  const started = performance.now();
  try {
    if (backendP === null) backendP = loadBackend();
    const backend = await backendP;
    let used: 'gpu' | 'cpu' = 'cpu';
    const evaluateBatch: EvaluateBatch = async (req) => {
      const outcome = await backend.run(req, msg.mode);
      used = outcome.backend;
      return outcome.evaluations;
    };
    const result = await runUncertainty({ graph: msg.graph, instances: msg.instances, wires: msg.wires, n: msg.n, seed: msg.seed, signal: abort.signal, ...(msg.scenario ? { scenario: msg.scenario } : {}) }, evaluateBatch);
    if (abort.signal.aborted) return; // superseded while running ⇒ drop the stale answer (only the latest wins)
    self.postMessage({ ok: true, epoch: msg.epoch, mode: msg.mode, backend: used, elapsedMs: performance.now() - started, result } satisfies UncWorkerResponse);
  } catch (e) {
    if (!abort.signal.aborted) self.postMessage({ ok: false, epoch: msg.epoch, message: e instanceof Error ? e.message : String(e) } satisfies UncWorkerResponse);
  }
};
