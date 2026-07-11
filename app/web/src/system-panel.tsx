import type { ReactFlowInstance } from '@xyflow/react';
import type { Studio, ProjectDoc } from '@sda/core';
import type { Key, Verdict } from '@sda/engine-core';
import {
  keys, costPromise, hasScenarios,
  type CostBreakdown, type EnvelopeResult, type WorldsResult, type NodeQueue, type RequestFlow,
  type SystemPromiseVerdict, type GuaranteeSlo, type GuaranteeVerdict,
  type LagVerdict, type NodePeak, type TwoTierResult, type UncertaintyResult,
} from '@sda/content';
import {
  fmt, formatMs, plural, responseRows, lagRows, requirementOptions, systemVerdict,
  uncertaintySection, envelopeSection, worldsMatrix, twoTierSection, worstCaseRho, PROMISES_TITLE,
  type FlowGuaranteeLine, type SimTail, type SummaryRow, type UncertaintyState,
} from '@sda/presenter';

// The SYSTEM lens (doc-11 "real by default"), extracted from app.tsx — the whole-design blocks of the
// System drawer. LAYOUT (owner-approved rebuild, 2026-07-11): a full-width VERDICT line on top, then a tidy
// TWO-COLUMN body — each column is its OWN vertical stack, so cards pack tight with no ragged wrap-gaps (the earlier
// flex-wrap dashboard scattered short cards with big holes, "blocks on a carpet"). The columns collapse to one on a
// narrow drawer. Left column = the MEASURED results (load limits, response time, cost); right column = WHAT YOU ASKED
// FOR (promises + where the load sits). Pure rendering over App-computed values (engine/content/presenter view-models)
// — the web adds no domain math; every edit goes back through Studio commands or the App callbacks. (Unification into
// the VS Code webview.)

// Hidden for the FIRST RELEASE (owner, 2026-07-11): advanced / niche System-panel bits — the qualitative guarantee
// controls and the 1-yr / 3-yr commitment pricing. The logic stays; only the display is gated. Set to false to restore.
const HIDE_ADVANCED = true;

/** The "add a guarantee requirement" control for one flow (doc: guarantee-propagation §4). A single dimension
 *  `<select>` offering only the dimensions not YET required on this flow; choosing one declares a requirement at that
 *  dimension's STRONGEST token (a sensible default the architect can weaken in the row that appears). The token
 *  vocabulary is the SHARED presenter `requirementOptions()`, so the web and the VS Code QuickPick offer identical
 *  choices. Renders nothing when every dimension is already required (no filler). */
function GuaranteeAdd({ flow, declared, studio }: { flow: { source: string; terminal: string }; declared: readonly GuaranteeSlo[]; studio: Studio }): JSX.Element | null {
  const options = requirementOptions().filter((o) => !declared.some((s) => s.dimension === o.dimension));
  if (options.length === 0) return null;
  return (
    <div className="field">
      <label data-tip="Declare a qualitative guarantee this flow must keep — consistency (read freshness), ordering, or delivery. The engine computes the end-to-end verdict and, on a violation, the cheapest component swap that restores it.">+ Guarantee</label>
      <div className="slo-input">
        <select value="" data-tip="Pick a guarantee dimension to require on this flow."
          onChange={(e) => {
            const opt = options.find((o) => o.dimension === e.target.value);
            const strongest = opt?.tokens[0]?.token;
            if (opt && strongest) studio.dispatch({ kind: 'setGuaranteeSlo', slo: { source: flow.source, terminal: flow.terminal, dimension: opt.dimension, atLeast: strongest } });
          }}>
          <option value="" disabled>add a promise…</option>
          {options.map((o) => <option key={o.dimension} value={o.dimension} title={o.detail}>{o.label}</option>)}
        </select>
      </div>
    </div>
  );
}

/** The last DES run as the System panel reads it: the presenter `SimTail` (percentiles + per-node tails) plus the
 *  retry-outcome figures the tail block renders (the shape App's sim-worker response carries). */
export type SimSnapshot = SimTail & {
  readonly goodput: number;
  readonly errorRate: number;
  readonly amplification: number;
  readonly retryPolicy: boolean;
};

/** The System lens body (`lens === 'system'` in the System drawer). */
export function SystemPanel({
  studio, doc, flows, valueOf, verds, sim, simRefreshing,
  queues, saturated, totalCost, sysPromises, costBreak,
  envW, deriveNote, onDeriveTrio, onResetWorld, active,
  unc, lagV, twoTier, peakByNode,
  guaranteeLines, gVerdicts, labelOf, typeOf, onSelect, rfi, onOpenProblems,
}: {
  studio: Studio;
  doc: ProjectDoc;
  flows: readonly RequestFlow[];
  valueOf: (id: string, k: Key) => number | undefined;
  verds: readonly Verdict[];
  sim: SimSnapshot | null;
  /** True while a fresh DES run is in flight (App's `busy === 'sim'`). */
  simRefreshing: boolean;
  queues: ReadonlyMap<string, NodeQueue>;
  /** Saturated (ρ≥1) node id → dropped rps. */
  saturated: ReadonlyMap<string, number>;
  totalCost: number;
  sysPromises: readonly SystemPromiseVerdict[];
  costBreak: CostBreakdown | null;
  envW: { readonly env: EnvelopeResult | null; readonly worlds: WorldsResult | null; readonly computing: boolean };
  deriveNote: string | null;
  onDeriveTrio: () => void;
  onResetWorld: (id: string) => void;
  active: string | undefined;
  unc: { readonly result: UncertaintyResult | null; readonly state: UncertaintyState; readonly backend?: 'gpu' | 'cpu'; readonly elapsedMs?: number } | null;
  lagV: readonly LagVerdict[];
  /** The ambient two-tier transient (doc: load-stages §10) — null when no generator declares cycles (no-filler). */
  twoTier: TwoTierResult | null;
  /** PEAK-AWARE per-node load (doc: load-stages R4): each node's worst-window ρ + instant from the Tier-1 sweep, so
   *  the load rows read the declared PEAK beside the steady ρ. Null with no shaped generator. */
  peakByNode: ReadonlyMap<string, NodePeak> | null;
  guaranteeLines: readonly FlowGuaranteeLine[];
  gVerdicts: readonly GuaranteeVerdict[];
  labelOf: (id: string, type: string) => string;
  typeOf: (id: string) => string;
  /** Select a node on the canvas (null clears — App's setSel; the guarantee root-cause link passes the
   *  verdict's `rootCauseNode`, typed nullable, exactly as the inline handler did). */
  onSelect: (id: string | null) => void;
  rfi: ReactFlowInstance | null;
  onOpenProblems: () => void;
}): JSX.Element {
  // ── LEFT COLUMN · the measured results ──────────────────────────────────────────────────────────────────────
  // LOAD LIMITS (the ambient envelope): how far each entry point can be pushed before an SLO breaks, WHAT breaks
  // first, where the latency knee sits — computed with NO declared demand. A demand-less design still gets an answer.
  const loadLimits = (() => {
    const section = envelopeSection({ result: envW.env, computing: envW.computing && envW.env === null }, (id) => labelOf(id, typeOf(id)));
    if (section === null) return null;
    return (
      <div className="sec"><div className="syshdr" data-tip="How far each entry point can be pushed before a promise breaks, WHAT breaks first, and where the latency knee sits — computed with NO declared demand (the default answer). An exact monthly bill / utilisation needs a chosen load (a demand scenario).">{section.title}</div>
        {section.rows.map((r, i) => <div className="vr" key={`env-${i}`}><span className="k">{r.label}</span><span className={'v ' + (r.tone ?? '')}>{r.value}</span></div>)}
      </div>
    );
  })();

  // RESPONSE TIME · END-TO-END — the p50/p95/p99 a client actually feels, from the discrete-event simulation.
  const responseTime = (
    <div className="sec"><div className="syshdr" data-tip="The end-to-end response time a client feels (p50 typical / p95 / p99 tail), measured by the discrete-event simulation over time — the distribution the instant analytic mean can't show. Runs automatically in the background on every change.">Response time · end-to-end{simRefreshing ? ' · refreshing…' : ''}</div>
      {sim ? (
        <>
          <div className="vr"><span className="k">p50 · typical</span><span className="v">{formatMs(sim.p50)}</span></div>
          <div className="vr"><span className="k">p95</span><span className="v">{formatMs(sim.p95)}</span></div>
          <div className="vr"><span className="k">p99 · tail</span><span className="v">{formatMs(sim.p99)}</span></div>
          {/* RETRY OUTCOME (doc: retry-feedback §3) — ONLY with a retry story (a declared policy, or measured retry
              traffic/failures). Past saturation retries LOWER goodput; the tool must show that honestly. */}
          {(sim.retryPolicy || sim.amplification > 1 || sim.errorRate > 0) && (
            <>
              <div className="vr" data-tip="Requests that actually SUCCEED per second (retries and failures excluded) — the useful work delivered. Past saturation, retries LOWER this below capacity."><span className="k">Goodput (succeeded)</span><span className="v">{fmt(sim.goodput)} req/s</span></div>
              <div className="vr" data-tip="Requests that FAIL per second after every retry is spent — the honest error rate under load."><span className="k">Failed after retries</span><span className="v" style={sim.errorRate > 0 ? { color: 'var(--bad)' } : undefined}>{fmt(sim.errorRate)} req/s</span></div>
              <div className="vr" data-tip="Attempts ÷ arrivals — how much the retries multiply the offered work. ×1 = no retry traffic; higher means a retry storm hitting an already-busy tier."><span className="k">Retry amplification</span><span className="v" style={sim.amplification > 1.2 ? { color: 'var(--warn)' } : undefined}>×{fmt(sim.amplification)}</span></div>
            </>
          )}
        </>
      ) : (
        <p className="muted" style={{ margin: '4px 0' }}>{simRefreshing ? 'measuring…' : 'set a client throughput to simulate the response time'}</p>
      )}
    </div>
  );

  // AMBIENT UNCERTAINTY — the Monte-Carlo distribution, present only when a range is declared AND a run
  // exists (no-filler). fp32 GPU preview while editing, a CPU-CONFIRMED (verdict-grade) pass at rest.
  const uncertainty = unc && (() => {
    const section = uncertaintySection({ result: unc.result, state: unc.state, ...(unc.backend ? { backend: unc.backend } : {}), ...(unc.elapsedMs !== undefined ? { elapsedMs: unc.elapsedMs } : {}) }, (id) => labelOf(id, typeOf(id)));
    if (section === null) return null;
    return (
      <div className="sec"><div className="syshdr" data-tip="Assumption uncertainty (Monte Carlo): every declared ± range is sampled thousands of times, so each conclusion is a DISTRIBUTION, not a false-precision point. Recomputes continuously in the background — a fast fp32 GPU PREVIEW while you edit, then a CPU-CONFIRMED (verdict-grade) pass when the design rests. fp32 is never shown as final truth.">{section.title}</div>
        {section.rows.map((r, i) => <div className="vr" key={`unc-${i}`}><span className="k">{r.label}</span><span className={'v ' + (r.tone ?? '')}>{r.value}</span></div>)}
      </div>
    );
  })();

  // PROPAGATION LAG · flow-scoped — declared CDC/replication deadlines, present ONLY when declared (no-filler).
  const propagationLag = lagV.length > 0 && (
    <div className="sec"><div className="syshdr" data-tip="Declared flow-scoped propagation deadlines (a change captured at the source reaches the destination within X ms) — async queue waits INCLUDED. The simulation measures the true mean; without a run the scalar can only prove a violation or read unknown.">Propagation lag · flow-scoped</div>
      {lagRows(lagV, labelOf, typeOf).map((r, i) => <div className="vr" key={`lag-${i}`}><span className="k">{r.label}</span><span className={'v ' + (r.tone ?? '')}>{r.value}</span></div>)}
    </div>
  );

  // LOAD STAGES · TRANSIENT — the AMBIENT two-tier read-out, present only when a generator declares cycles (no-filler).
  const loadStages = twoTier !== null && (
    <div className="sec"><div className="syshdr" data-tip="Traffic that changes over time: whenever a generator declares periodic cycles, the design is evaluated over its whole auto-derived season in two tiers — a cheap analytic sweep of the ρ-envelope + worst window + honest mean bill (Tier-1), then a targeted discrete-event simulation that PROVES the true backlog and drain at the worst window (Tier-2). Live and ambient; two labelled bases.">Load stages · transient</div>
      {twoTierSection(twoTier, (id) => labelOf(id, typeOf(id))).rows.map((r, i) => (
        <div className="vr" key={`twotier-r-${i}`}><span className="k">{r.label}</span><span className={'v ' + (r.tone ?? '')}>{r.value}</span></div>
      ))}
    </div>
  );

  // RESPONSE TIME · PER COMPONENT — each promise-bearing node's OWN response tail, from the same DES run (no-filler:
  // absent before a run / with no latency SLO). Shares the presenter row-builder with the VS Code System tree.
  const perComponent = (() => {
    const rows: SummaryRow[] = responseRows(sim, doc.instances, verds, labelOf, typeOf);
    if (rows.length === 0) return null;
    return (
      <div className="sec"><div className="syshdr" data-tip="Each promise-bearing node's OWN request→response tail (p50/p95/p99) measured by the simulation — the compact p50→p99 range the canvas bar shows, expanded. A node's response cuts at async boundaries: it is what a caller of that node actually waits for.">Response time · per component{simRefreshing ? ' · refreshing…' : ''}</div>
        {rows.map((r, i) => <div className="vr" key={`resp-${i}`}><span className="k">{r.label}</span><span className={'v ' + (r.tone ?? '')}>{r.value}</span></div>)}
      </div>
    );
  })();

  // COST · BREAKDOWN — the bill depth (compute/storage + internet egress + total). Present only with real cost.
  const costBreakdown = costBreak && costBreak.totalUsdMonth > 0.005 && (
    <div className="sec"><div className="syshdr" data-tip="The bill depth: compute/storage + the most-missed internet egress line (set each tier's payload), and the grand total.">Cost · breakdown</div>
      <div className="vr"><span className="k">Compute / storage</span><span className="v">${fmt(costBreak.computeUsdMonth)}/mo</span></div>
      <div className="vr"><span className="k">Data transfer (egress)</span><span className="v">${fmt(costBreak.egressUsdMonth)}/mo</span></div>
      <div className="vr"><span className="k">Total · on-demand</span><span className="v">${fmt(costBreak.totalUsdMonth)}/mo</span></div>
      <div className="vr" hidden={HIDE_ADVANCED}><span className="k">1-yr commit</span><span className="v">${fmt(costBreak.committed1yrUsdMonth)}/mo <span style={{ color: 'var(--ok)' }}>−${fmt(costBreak.totalUsdMonth - costBreak.committed1yrUsdMonth)}</span></span></div>
      <div className="vr" hidden={HIDE_ADVANCED}><span className="k">3-yr commit</span><span className="v">${fmt(costBreak.committed3yrUsdMonth)}/mo <span style={{ color: 'var(--ok)' }}>−${fmt(costBreak.totalUsdMonth - costBreak.committed3yrUsdMonth)}</span></span></div>
    </div>
  );

  // ── RIGHT COLUMN · what you asked for ───────────────────────────────────────────────────────────────────────
  // WHOLE-SYSTEM COST PROMISE (owner ruling: cost is for THE WHOLE SYSTEM — a global quantity judged against the
  // full monthly bill, every component incl. off-path branches like a cache; declaring it never asks for a flow).
  const systemPromise = (
    <div className="sec">
      <div className="syshdr" data-tip="Promises about the WHOLE system — global quantities. Cost is judged against the full monthly bill (every component, off-path branches like a cache included) and never asks for a flow. Each flow's own promises (throughput, latency, availability) are in its flow section below.">{PROMISES_TITLE} <span className="tagmode">system</span></div>
      {(() => {
        const band = doc.systemPromises.find((p) => p.key === String(keys.cost))?.band;
        const cur = band?.shape === 'minTargetMax' ? band.max : undefined;
        const verdict = sysPromises.find((v) => v.key === String(keys.cost));
        const now = verdict?.computed ?? (totalCost > 0 ? totalCost : undefined);
        const meets = cur === undefined || verdict === undefined ? undefined : verdict.status !== 'violation';
        return (
          <div className="field">
            <label data-tip="The whole system's monthly cost ceiling — a SYSTEM-scoped promise (scope: system): the sum of every component's own cost, off-path branches included. Stored on the design itself, not on any node; repair/optimize hold it as a hard ceiling (a binding budget escalates to the exact reference MIP, labeled).">Cost <span style={{ color: 'var(--ink3)' }}>≤</span></label>
            <div className="slo-input">
              <div className="slo-row">
                <input type="text" inputMode="decimal" placeholder="—"
                  key={`system:cost:${cur ?? ''}`}
                  defaultValue={cur ?? ''}
                  data-tip="Whole-system cost promise ≤ (USD/month), judged against the full bill. Leave blank to clear."
                  onBlur={(e) => {
                    const raw = e.target.value.trim();
                    if (raw === '') { if (cur !== undefined) studio.dispatch({ kind: 'clearSystemPromise', key: String(keys.cost) }); return; }
                    const n = Number(raw);
                    if (!Number.isNaN(n)) studio.dispatch({ kind: 'setSystemPromise', promise: costPromise(n) });
                  }} />
                <span className="unit-suffix">USD/mo</span>
              </div>
              {now !== undefined && (
                <span className={'slo-now' + (meets === undefined ? '' : meets ? ' ok' : ' bad')}>now ${fmt(now)}/mo · system{meets === undefined ? '' : meets ? ' ✓' : ' ✗'}</span>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );

  // PER-FLOW: WHERE THE LOAD SITS (per-component utilisation — the bottleneck read-out) + any legacy branch-cost
  // band. Per-node promises (throughput / latency / p99 / availability) moved to the Inspector (owner ruling
  // 2026-07-11: promise on the FEW nodes you care about); only whole-system Cost stays a System-panel promise.
  const flowSections = flows.map((fl, i) => {
    const tType = typeOf(fl.terminal);
    const tInst = doc.instances.find((x) => x.id === fl.terminal);
    return (
      <div className="sec" key={`flow${i}`}>
        <h6 data-tip="An independent request flow (a connected sub-graph). Its END-TO-END figures are read at the terminal (deepest) node. The promises below are stored as SLO bands on that terminal — the same mechanism as a per-node SLO, auto-targeted so you don’t have to find the right node.">
          {flows.length > 1 ? `Flow ${i + 1} · ` : 'Flow · '}{labelOf(fl.source, typeOf(fl.source))} → {labelOf(fl.terminal, tType)}
        </h6>
        {/* Per-node PROMISES (throughput / latency / p99 / availability) now live in the Inspector — select the FEW
            nodes you care about and set them there; the engine computes the rest (owner ruling 2026-07-11). Only the
            whole-system Cost promise stays in the System panel (above). The flow section keeps WHERE THE LOAD SITS +
            any legacy branch-cost band. */}
        {/* BRANCH COST (owner ruling, no silent migration): an EXISTING cost band on this flow's terminal node STAYS
            as data and stays editable — honestly labelled "Branch cost" (a node's cumulative cost sums only the paths
            INTO it; off-path tiers are invisible). The whole-bill promise is the SYSTEM-scoped Cost above. */}
        {(() => {
          const b = tInst?.bands?.find((x) => x.key === keys.cost)?.band;
          if (b?.shape !== 'minTargetMax' || b.max === undefined) return null;
          const branchNow = valueOf(fl.terminal, keys.cost);
          const meets = branchNow === undefined ? undefined : branchNow <= b.max;
          return (
            <div className="field">
              <label data-tip="A cost band declared on this flow's TERMINAL node — the cost of this BRANCH (the paths into the terminal), NOT the whole system's bill (off-path tiers are outside it). The whole-system promise is the Cost row in the system Promises section above. Leave blank to clear this branch band.">Branch cost <span style={{ color: 'var(--ink3)' }}>≤</span></label>
              <div className="slo-input">
                <div className="slo-row">
                  <input type="text" inputMode="decimal" placeholder="—"
                    key={`${fl.terminal}:branch-cost:${b.max}`}
                    defaultValue={b.max}
                    data-tip={`Branch cost band ≤ (USD/month) on “${labelOf(fl.terminal, tType)}” — judged against the branch's accumulated cost. Leave blank to clear.`}
                    onBlur={(e) => {
                      const raw = e.target.value.trim();
                      if (raw === '') { studio.dispatch({ kind: 'clearSLO', node: fl.terminal, key: keys.cost }); return; }
                      const n = Number(raw);
                      if (!Number.isNaN(n)) studio.dispatch({ kind: 'setSLO', node: fl.terminal, key: keys.cost, band: { shape: 'minTargetMax' as const, max: n } });
                    }} />
                  <span className="unit-suffix">USD/mo</span>
                </div>
                {branchNow !== undefined && (
                  <span className={'slo-now' + (meets === undefined ? '' : meets ? ' ok' : ' bad')}>now ${fmt(branchNow)}/mo · branch{meets === undefined ? '' : meets ? ' ✓' : ' ✗'}</span>
                )}
              </div>
            </div>
          );
        })()}
        {/* WHERE THE LOAD SITS — each component's utilisation (offered ÷ capacity). The single most useful "what to
            fix next" read-out: the reddest tier is the bottleneck. Above ~70% the queue grows; at/over 100% it
            overloads and drops traffic. Instant (no simulation); with a shaped generator, the declared-peak load. */}
        <div className="syshdr" data-tip="Per-component load = utilisation (offered ÷ capacity). Above ~70% the queue grows; at or over 100% the component overloads — it drops load and queues without bound. Instant, no simulation. With a shaped generator each row reads the WORST-WINDOW load (the declared peak).">Load per component</div>
        <p className="muted" style={{ margin: '0 2px 6px' }}>Share of each component's capacity in use — the reddest is the bottleneck; over 100% it overloads and drops traffic.</p>
        {fl.ids.map((id) => {
          const q = queues.get(id);
          if (q === undefined) return null;
          const drop = saturated.get(id);
          // WORST-CASE LOAD (owner ruling: a peak is just traffic in a given environment): the ρ shown is the worst
          // load the declared environment produces — worst-window ρ when a generator is shaped, else steady ρ.
          const rho = worstCaseRho(q.rho, peakByNode?.get(id) ?? undefined) ?? q.rho;
          const pct = rho * 100;
          const tone = drop !== undefined || rho >= 1 ? 'bad' : rho >= 0.7 ? 'warn' : '';
          return (
            <div className="vr" key={`rho${id}`}>
              <span className="k">{labelOf(id, typeOf(id))}</span>
              <span className={'v ' + tone}>{drop !== undefined ? `⚠ saturated · drops ${fmt(drop)}/s` : `${pct >= 1000 ? '≥1000' : pct.toFixed(0)}%`}</span>
            </div>
          );
        })}
        {/* GUARANTEE line + requirements (doc: guarantee-propagation §4) — hidden for the first release (owner, 2026-07-11). */}
        {(() => {
          if (HIDE_ADVANCED) return null; // qualitative guarantees hidden for the first release (owner, 2026-07-11)
          const line = guaranteeLines.find((l) => l.source === fl.source && l.terminal === fl.terminal);
          const flowSlos = doc.guaranteeSlos.filter((s) => s.source === fl.source && s.terminal === fl.terminal);
          const flowVerdicts = gVerdicts.filter((v) => v.source === fl.source && v.terminal === fl.terminal);
          if (line === undefined && flowSlos.length === 0) {
            return <GuaranteeAdd flow={fl} declared={flowSlos} studio={studio} />;
          }
          return (
            <>
              <div className="syshdr" data-tip="Qualitative guarantees this flow makes about its data — read freshness (consistency), message order (ordering), duplication (delivery) — as computed verdicts. A guarantee only ever DEGRADES along a path, so the named node is the provable root cause. Click it to select.">Guarantees</div>
              {line?.cells.map((c) => (
                <div className="vr" key={`g-${c.dimension}`}>
                  <span className="k" data-tip={c.required !== null ? `Required ≥ ${c.required}. Computed end-to-end: ${c.token}.` : `Computed end-to-end: ${c.token} (no promise declared).`}>{c.dimension}</span>
                  <span className={'v ' + (c.tone ?? '')}>
                    {c.token}
                    {c.rootCauseNode !== null && (
                      <> (<a role="button" tabIndex={0} className="g-cause" style={{ cursor: 'pointer', textDecoration: 'underline' }}
                        onClick={() => { onSelect(c.rootCauseNode); rfi?.fitView({ nodes: [{ id: c.rootCauseNode as string }], duration: 300, padding: 0.4 }); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') onSelect(c.rootCauseNode); }}
                      >{c.rootCauseNode}</a>)</>
                    )}
                    {c.status === 'ok' ? ' ✓' : c.status === 'violation' ? ' ✗' : c.status === 'unknown' ? ' ?' : ''}
                  </span>
                </div>
              ))}
              {flowSlos.map((s) => {
                const v = flowVerdicts.find((x) => x.dimension === s.dimension);
                const dim = requirementOptions().find((o) => o.dimension === s.dimension);
                return (
                  <div className="field" key={`gslo-${s.dimension}`}>
                    <label data-tip={`Guarantee promise: ${s.dimension} at least ${s.atLeast}.`}>{s.dimension} <span style={{ color: 'var(--ink3)' }}>≥</span></label>
                    <div className="slo-input">
                      <div className="slo-row">
                        <select value={s.atLeast} data-tip="The minimum floor this flow must keep for this dimension."
                          onChange={(e) => studio.dispatch({ kind: 'setGuaranteeSlo', slo: { source: fl.source, terminal: fl.terminal, dimension: s.dimension, atLeast: e.target.value } })}>
                          {dim?.tokens.map((t) => <option key={t.token} value={t.token} title={t.label}>{t.token}</option>)}
                        </select>
                        <button className="slo-clear" title="Remove this guarantee promise" onClick={() => studio.dispatch({ kind: 'clearGuaranteeSlo', source: fl.source, terminal: fl.terminal, dimension: s.dimension })}>×</button>
                      </div>
                      {v && <span className={'slo-now' + (v.status === 'ok' ? ' ok' : v.status === 'violation' ? ' bad' : '')} data-tip={v.remediation?.action ?? v.noRemediationReason ?? ''}>now {v.computed}{v.status === 'ok' ? ' ✓' : v.status === 'violation' ? ' ✗' : ' ?'}</span>}
                    </div>
                    {v?.status === 'violation' && (v.remediation || v.noRemediationReason) && (
                      <p className="muted" style={{ margin: '2px 0 6px', fontSize: 12 }}>{v.remediation?.action ?? v.noRemediationReason}</p>
                    )}
                  </div>
                );
              })}
              <GuaranteeAdd flow={fl} declared={flowSlos} studio={studio} />
            </>
          );
        })()}
      </div>
    );
  });

  // DEMAND SCENARIOS (doc §7): the low / expected / high worlds + the ACTIVE-world selector. "Suggest 3" fills them
  // from the load limits (badged derived). The active world colours the whole canvas (tagged in the header).
  const demandScenarios = doc.requestClasses.length === 0 && (() => {
    const section = worldsMatrix({ result: envW.worlds, computing: envW.computing && hasScenarios(doc.scenarios) && envW.worlds === null, ...(active !== undefined ? { active } : {}) }, (id) => labelOf(id, typeOf(id)));
    return (
      <div className="sec"><div className="syshdr" data-tip="Named worlds (doc: assumption-model §7): low / expected / high demand (+ any custom), each evaluated for cost, peak load and verdicts in one batch. Pick one as the ACTIVE lens — the canvas reflects that world (tagged); editing a demand/service-time knob writes into the active world.">Demand scenarios</div>
        <div className="world-lens">
          <button className={'wlens-btn' + (active === undefined ? ' on' : '')} onClick={() => studio.setActiveScenario(undefined)} title="The base design, as authored (no world)">base</button>
          {doc.scenarios.map((s) => (
            <span key={s.id} className="wlens-world">
              <button className={'wlens-btn' + (active === s.id ? ' on' : '')} onClick={() => studio.setActiveScenario(active === s.id ? undefined : s.id)} title={`View the "${s.name ?? s.id}" world — a demand/service-time edit writes into it`}>{s.name ?? s.id}</button>
              {/* RESET this world (doc §5.3 — "reset means reset"): wipe ALL its overrides (incl. frozen). */}
              <button className="wlens-reset" onClick={() => onResetWorld(s.id)} title={`Reset the "${s.name ?? s.id}" world — wipe its overrides (incl. any frozen edits): a derived-trio world back to freshly-derived, a custom world to base`}>↻</button>
            </span>
          ))}
          <button className="wlens-btn" style={{ marginLeft: 'auto' }} onClick={onDeriveTrio} title="Fill the low / expected / high worlds with values derived from THIS design's load limits (badged 'derived', live-tracking until you edit them)">✨ Suggest 3 (low / expected / high)</button>
        </div>
        {deriveNote && <p className="muted" style={{ margin: '4px 0', color: 'var(--warn, #8a5a00)' }}>{deriveNote}</p>}
        {section ? section.rows.map((r, i) => <div className="vr" key={`world-${i}`}><span className="k">{r.label}</span><span className={'v ' + (r.tone ?? '')}>{r.value}</span></div>)
          : <p className="muted" style={{ margin: '4px 0' }}>No scenarios yet — <b>Suggest 3</b> fills low / expected / high, or add your own.</p>}
      </div>
    );
  })();

  // THE VERDICT — the one-line answer, full width on top: does the design hold (and if not, how many problems to
  // fix, clickable → Problems) + the three headline numbers a reviewer wants at a glance. Computed by the SHARED
  // presenter `systemVerdict` (the SAME one the VS Code System tree renders), so the two surfaces can never disagree.
  const cap = envW.env ? (envW.env.joint?.maxTotalRps ?? envW.env.perOrigin.reduce<number | undefined>((m, o) => (o.maxRps !== undefined && (m === undefined || o.maxRps > m) ? o.maxRps : m), undefined)) : undefined;
  const verdict = systemVerdict({
    violations: verds.filter((v) => v.status === 'violation').length + sysPromises.filter((v) => v.status === 'violation').length,
    saturated: saturated.size,
    capacityRps: cap,
    p99Ms: sim?.p99,
    costUsdMonth: totalCost,
  });
  const isProblem = verdict.status === 'problem';

  return (
    <div className="sysroot">
      <div className="sec verdict-sec">
        <div className={'verdict-pill ' + (isProblem ? 'bad' : 'ok')} style={{ width: '100%', justifyContent: 'flex-start', cursor: isProblem ? 'pointer' : 'default' }}
          onClick={isProblem ? onOpenProblems : undefined}
          title={isProblem ? 'Open the Problems list' : 'Every declared promise is met and no tier is overloaded.'}>
          <span className="dot" />
          {verdict.headline}
        </div>
        {verdict.numbers && <p className="muted verdict-nums">{verdict.numbers}</p>}
      </div>
      <div className="syscols">
        {/* LEFT · the measured results — how the design performs and what it costs */}
        <div className="syscol">
          {loadLimits}
          {responseTime}
          {uncertainty}
          {propagationLag}
          {loadStages}
          {perComponent}
          {costBreakdown}
        </div>
        {/* RIGHT · what you asked for — the promises + where the load sits */}
        <div className="syscol">
          {systemPromise}
          {flowSections}
          {demandScenarios}
          {/* A compact orientation footer (replaces the old spec-counts card): the design's shape at a glance, and
              the ONE actionable count — open problems — clickable. Never a card, just a quiet line. */}
          <p className="muted syscount">
            {doc.instances.length} components · {doc.wires.length} connections · {plural(flows.length, 'flow')} ·{' '}
            {plural(doc.instances.reduce((n, i) => n + (i.bands?.length ?? 0), 0) + doc.systemPromises.length, 'SLO')}
            {' · '}
            <span className="syscount-risks" role="button" tabIndex={0} onClick={onOpenProblems} onKeyDown={(e) => { if (e.key === 'Enter') onOpenProblems(); }} title="Open the Problems list">
              {plural(verds.filter((v) => v.status === 'violation').length, 'risk')} → Problems
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}
