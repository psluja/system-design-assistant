import type { Graph } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { registry, timeSweep, tier2Job, runTier2, LOAD_STAGES_DEFAULTS, type EvaluateGraph, type TwoTierResult } from '@sda/content';

// THE AMBIENT TWO-TIER EVALUATION runs OFF the workbench renderer thread — exactly like the
// ambient DES (sim-worker.ts) and Monte-Carlo (uncertainty-worker.ts). The Tier-1 analytic sweep is cheap but the
// Tier-2 DES over the worst-window neighbourhood is millions of events, so a synchronous run would freeze the whole
// editor. The graph is pure data (Maps + branded strings + plain relation ASTs), so it structured-clones across the
// boundary — the SAME graph the uncertainty worker already receives. THE RESTING HANDSHAKE: this worker posts TWICE
// — first the coarse Tier-1 preview (the live ρ-envelope + worst-window locate), then the Tier-2-confirmed result.
// Mirrors app/web/src/two-tier-worker.ts so both shells feed the presenter identical rows.

export interface TwoTierWorkerRequest {
  readonly graph: Graph;
}
export type TwoTierWorkerResponse =
  | { readonly ok: true; readonly phase: 'preview' | 'final'; readonly result: TwoTierResult }
  | { readonly ok: false };

const evalDI: EvaluateGraph = (g) => {
  const r = evaluate(g, registry);
  return r.ok ? r.value : undefined;
};

self.onmessage = (e: MessageEvent<TwoTierWorkerRequest>) => {
  try {
    const tier1 = timeSweep({
      graph: e.data.graph,
      evaluate: evalDI,
      pointsPerCycle: LOAD_STAGES_DEFAULTS.livePointsPerCycle,
      maxWindows: LOAD_STAGES_DEFAULTS.liveWindowTarget,
    });
    if (tier1 === undefined) { self.postMessage({ ok: false } satisfies TwoTierWorkerResponse); return; } // no shaped generator
    self.postMessage({ ok: true, phase: 'preview', result: { tier1 } } satisfies TwoTierWorkerResponse);

    // The AMBIENT budget sizes a narrower, responsive Tier-2 neighbourhood (§16.3 live/rest split).
    const job = tier2Job(e.data.graph, tier1, LOAD_STAGES_DEFAULTS.liveTier2Events);
    const result: TwoTierResult = job !== undefined ? { tier1, tier2: runTier2(job) } : { tier1 };
    self.postMessage({ ok: true, phase: 'final', result } satisfies TwoTierWorkerResponse);
  } catch {
    self.postMessage({ ok: false } satisfies TwoTierWorkerResponse);
  }
};
