import { simulate, StationId, type QueueingNetwork } from '@sda/engine-sim';
import type { NodeResponseView, PairLagView } from '@sda/presenter';

// The DES runs OFF the window thread. VS Code webviews execute in the workbench renderer process, so a
// synchronous simulate() at a high request rate (millions of events — tens of seconds of CPU at 10k rps)
// froze the ENTIRE editor. The network is pure data (distributions are tagged unions, never closures), so it
// structured-clones across the worker boundary; percentiles are computed HERE because SimResult carries a
// method (not cloneable) — only plain numbers travel back.

export interface SimWorkerRequest {
  readonly net: QueueingNetwork;
  // FLOW-SCOPED LAG pairs — the declared (source, terminal) pairs the main thread
  // reads off the project's lagSlos; absent/empty ⇒ the run is bit-for-bit the pre-lag simulation (opt-in).
  readonly lagPairs?: readonly { readonly source: string; readonly terminal: string }[];
}
export type SimWorkerResponse =
  | {
      readonly ok: true;
      readonly mean: number;
      readonly p50: number;
      readonly p95: number;
      readonly p99: number;
      // RETRY OUTCOME — goodput/failures/amplification the DES measured, and whether a
      // caller declared a retry policy (so the native System tree knows to show the rows). Mirrors the web worker.
      readonly goodput: number;
      readonly errorRate: number;
      readonly amplification: number;
      readonly retryPolicy: boolean;
      // LATENCY SEMANTICS v2 (doc §4): every node's OWN response tail (ms) and every declared pair's async-inclusive
      // lag (ms), from this one run — mirrors the web worker so both shells feed the presenter identical rows.
      readonly nodeResponse: readonly NodeResponseView[];
      readonly pairLag: readonly PairLagView[];
    }
  | { readonly ok: false };

// A caller declared a LIVE retry policy iff some arrival carries an attemptPolicy with a real deadline
// (timeoutMs > 0); the projector attaches it only for a real policy (content/sim.ts attemptPolicyOf).
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
      goodput: r.goodputRps,
      errorRate: r.errorRate,
      amplification: r.amplification,
      retryPolicy: hasRetryPolicy(e.data.net),
      nodeResponse: r.nodeResponse.map((n) => ({ id: String(n.id), mean: toMs(n.mean), p50: toMs(n.p50), p95: toMs(n.p95), p99: toMs(n.p99), samples: n.samples })),
      pairLag: r.pairLag.map((p) => ({ source: String(p.source), terminal: String(p.terminal), mean: toMs(p.mean), p50: toMs(p.p50), p95: toMs(p.p95), p99: toMs(p.p99), samples: p.samples })),
    };
    self.postMessage(res);
  } catch {
    self.postMessage({ ok: false } satisfies SimWorkerResponse);
  }
};
