import { simulate, StationId, type QueueingNetwork } from '@sda/engine-sim';
import type { NodeResponseView, PairLagView } from '@sda/presenter';

// The DES runs OFF the page thread. A synchronous simulate() at a high request rate (millions of events —
// tens of seconds of CPU at 10k rps) froze the whole tab; the same bug froze the entire VS Code window in the
// sibling shell, where this fix landed first. The network is pure data (distributions are tagged unions, never
// closures), so it structured-clones across the worker boundary; everything derived from SimResult (percentiles,
// per-station utilization/drops) is computed HERE because the result object carries methods (not cloneable) —
// only plain data travels back.

export interface SimWorkerRequest {
  readonly net: QueueingNetwork;
  // FLOW-SCOPED LAG pairs to measure — the declared (source, terminal) station
  // pairs whose async-inclusive journey the ONE run also samples. The main thread reads them off the project's
  // lagSlos; absent/empty ⇒ the run is bit-for-bit the pre-lag simulation (the feature is opt-in).
  readonly lagPairs?: readonly { readonly source: string; readonly terminal: string }[];
}
export type SimWorkerResponse =
  | {
      readonly ok: true;
      readonly mean: number;
      readonly p50: number;
      readonly p95: number;
      readonly p99: number;
      readonly rate: number;
      // RETRY OUTCOME — the useful work vs failures a retry policy produces, measured by
      // the DES. With no policy anywhere these degenerate to the pre-retry world (goodput = rate, errorRate 0,
      // amplification 1); `retryPolicy` says whether a caller declared one, so the surface knows to show the rows.
      readonly goodput: number;
      readonly errorRate: number;
      readonly amplification: number;
      readonly retryPolicy: boolean;
      readonly stations: ReadonlyArray<{ readonly id: string; readonly util: number; readonly drop: number }>;
      // LATENCY SEMANTICS v2 (doc §4). Every node's OWN response tail (mean + p50/p95/p99, in ms) from this one
      // run — a node's view is a SUFFIX of the same journeys, so all N perspectives fall out of one simulation.
      // Percentiles come back as plain arrays here because SimResult carries them behind methods (not cloneable);
      // NaN ⇒ the node had no recorded response (never reached / dropped) ⇒ honest `unknown` upstream.
      readonly nodeResponse: readonly NodeResponseView[];
      // The async-INCLUSIVE lag distribution (ms) for every DECLARED pair (doc §3) — empty when none was declared.
      readonly pairLag: readonly PairLagView[];
    }
  | { readonly ok: false };

// A caller declared a LIVE retry policy iff some arrival carries an attemptPolicy with a real deadline
// (timeoutMs > 0). The projector attaches it only for a real policy, so its mere presence is the signal —
// an inert timeoutMs=0 is never attached (see content/sim.ts attemptPolicyOf).
const hasRetryPolicy = (net: QueueingNetwork): boolean => net.arrivals.some((a) => a.attemptPolicy !== undefined && a.attemptPolicy.timeoutMs > 0);

// s → ms, NaN-preserving (a node/pair with no recorded sample stays NaN → honest `unknown`, never a fabricated 0).
const toMs = (s: number): number => s * 1000;

self.onmessage = (e: MessageEvent<SimWorkerRequest>) => {
  try {
    const lagPairs = (e.data.lagPairs ?? []).map((p) => ({ source: StationId(p.source), terminal: StationId(p.terminal) }));
    const r = simulate(e.data.net, { seed: 7, warmupCompletions: 10000, measureCompletions: 50000, ...(lagPairs.length > 0 ? { lagPairs } : {}) });
    const res: SimWorkerResponse = {
      ok: true,
      mean: r.meanSojourn * 1000,
      p50: r.sojournPercentile(0.5) * 1000,
      p95: r.sojournPercentile(0.95) * 1000,
      p99: r.sojournPercentile(0.99) * 1000,
      rate: r.departureRate,
      goodput: r.goodputRps,
      errorRate: r.errorRate,
      amplification: r.amplification,
      retryPolicy: hasRetryPolicy(e.data.net),
      stations: r.stations
        .map((s) => ({ id: String(s.id), util: s.utilization, drop: s.dropped / r.measuredTime }))
        .sort((a, b) => b.util - a.util),
      // Per-node response tail (doc §4) and declared lag distributions (doc §3), scaled to ms — the plain-data
      // twin of the scalar `responseLatency` / `lagLowerBoundMs`, carried back for the presenter to judge & show.
      nodeResponse: r.nodeResponse.map((n) => ({ id: String(n.id), mean: toMs(n.mean), p50: toMs(n.p50), p95: toMs(n.p95), p99: toMs(n.p99), samples: n.samples })),
      pairLag: r.pairLag.map((p) => ({ source: String(p.source), terminal: String(p.terminal), mean: toMs(p.mean), p50: toMs(p.p50), p95: toMs(p.p95), p99: toMs(p.p99), samples: p.samples })),
    };
    self.postMessage(res);
  } catch {
    self.postMessage({ ok: false } satisfies SimWorkerResponse);
  }
};
