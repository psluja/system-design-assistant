import type { Graph } from '@sda/engine-core';
import { keys, provisioningTunables, type Instance } from '@sda/content';
import { keyInfo, fmt } from '@sda/presenter';

// The IMPROVE lens (doc-11 §3d) — the ONE backward-solve surface, extracted from app.tsx (TASK-89). Pure
// presentation over App-owned state: the goal picker, the honest "changing / subject to" preview, and the
// solver's LEGIBLE result (verdict + shortfalls + before→after sizing). The solve itself (runImprove) stays in
// App — it is also driven by the command palette, the footer CTA and the Problems "Fix all", so the panel only
// renders and reports clicks. All domain math (tunables, SLO shapes) comes from @sda/content — the web adds none.

/** The backward-solve goal the user picks. 'feasible' = repair (the minimal change so every SLO holds — what the
 *  old "Auto-fix" did); 'cheapest'/'fastest' = optimize cost↓ / throughput↑ subject to every SLO. latency /
 *  availability / durability are not knobs the search tunes — they are SLO CONSTRAINTS. */
export type ImproveGoal = 'feasible' | 'cheapest' | 'fastest';
export const GOAL_LABEL: Record<ImproveGoal, string> = {
  feasible: 'Make it meet its SLOs',
  cheapest: 'Cheapest under SLOs',
  fastest: 'Fastest (max throughput)',
};
export interface ImproveChange {
  readonly node: string;
  readonly key: string;
  readonly from: number;
  readonly to: number;
}
export interface ImproveResult {
  readonly goal: ImproveGoal;
  readonly status: 'solved' | 'noop' | 'infeasible' | 'error';
  readonly message: string;
  readonly changes: readonly ImproveChange[];
  readonly objective?: { readonly label: string; readonly key: string; readonly before: number | undefined; readonly after: number | undefined };
  readonly shortfalls?: ReadonlyArray<{ readonly node: string; readonly key: string; readonly bound: string; readonly amount: number }>;
  /** WHICH engine sized this result — present and `reference-mip` when the in-process solver declined a budget-coupled
   *  trade-off and the exact reference MIP was escalated to (docs: honest escalation). The panel shows the basis. */
  readonly basis?: string;
}

/** The Improve panel body (`lens === 'optimize'` in the System drawer). Renders the goal, what the solver may
 *  change, what it is subject to, and the result of the LAST run whose goal matches the picked one. */
export function ImprovePanel({ graph, instances, goal, onGoal, improve, solving, nameOf, onRun, onApply }: {
  graph: Graph | null;
  instances: readonly Instance[];
  goal: ImproveGoal;
  onGoal: (g: ImproveGoal) => void;
  improve: ImproveResult | null;
  /** True while the backward solve is in flight (App's `busy === 'opt'`). */
  solving: boolean;
  nameOf: (id: string) => string;
  onRun: () => void;
  onApply: () => void;
}): JSX.Element {
  const tunables = graph ? provisioningTunables(graph) : [];
  const slos = instances.flatMap((i) => (i.bands ?? []).map((b) => ({ node: i.id, key: String(b.key), band: b.band })));
  const objFmt = (k: string, v: number | undefined): string => (v === undefined ? '—' : k === String(keys.cost) ? `$${fmt(v)}/mo` : k === String(keys.throughput) ? `${fmt(v)} rps` : fmt(v));
  const sloText = (s: { key: string; band: { shape: string; min?: number; max?: number; target?: number } }): string =>
    `${keyInfo(s.key).label} ${s.band.shape === 'minTargetMax' ? (s.band.min !== undefined ? `≥ ${s.band.min}` : s.band.max !== undefined ? `≤ ${s.band.max}` : '') : ''}`.trim();
  const r = improve && improve.goal === goal ? improve : null;
  const good = r?.status === 'solved' || r?.status === 'noop';
  return (
    <div className="modepanel">
      <div className="ih"><span className="ic" style={{ fontSize: 15 }}>◇</span><div><b>Improve · solve backwards</b><span>size the knobs to a goal, under every SLO</span></div></div>
      <div className="sec">
        <div className="field">
          <label data-tip="What to solve FOR. 'Make it meet its SLOs' applies the minimal sizing change to clear every violation; the others minimise cost / maximise throughput subject to every SLO. Latency / availability are component config or need a structural fix — not knobs the solver tunes.">Goal</label>
          <select value={goal} onChange={(e) => onGoal(e.target.value as ImproveGoal)}>
            {(['feasible', 'cheapest', 'fastest'] as ImproveGoal[]).map((gk) => <option key={gk} value={gk}>{GOAL_LABEL[gk]}</option>)}
          </select>
        </div>
        <div className="syshdr" data-tip="The provisioning knobs the solver may change (concurrency / replicas / units). Latency / availability come from each component's config, not from sizing.">Changing</div>
        <p className="muted" style={{ margin: '2px 0' }}>{tunables.length === 0 ? 'no tunable knobs in this design' : tunables.map((t) => `${nameOf(String(t.node))}·${String(t.key)}`).join(', ')}</p>
        <div className="syshdr" data-tip="The SLOs the solution must satisfy — your promises (set in System).">Subject to</div>
        <p className="muted" style={{ margin: '2px 0' }}>{slos.length === 0 ? 'no SLOs set — add a promise in System first, otherwise “cheapest” just shrinks the design' : slos.map((s) => `${sloText(s)} @ ${nameOf(s.node)}`).join(' · ')}</p>
        <button className="btn primary" style={{ marginTop: 8 }} disabled={solving} onClick={onRun}>{solving ? 'Solving…' : '◇ Improve'}</button>
      </div>
      {r && (
        <>
          <div className="sec"><h6>Result</h6>
            <p style={{ color: good ? 'var(--ok)' : 'var(--bad)', margin: '2px 0' }}>{good ? '✓ ' : '✗ '}{r.message}</p>
            {r.basis && <p className="muted" style={{ margin: '2px 0', fontSize: 12 }} title="The in-process solver declined a budget-coupled trade-off; the exact reference MIP sized this (a longer solve).">basis: {r.basis}</p>}
            {r.objective && <div className="vr"><span className="k">{r.objective.label}</span><span className="v">{objFmt(r.objective.key, r.objective.before)} → {objFmt(r.objective.key, r.objective.after)}</span></div>}
          </div>
          {r.status === 'infeasible' && r.shortfalls && r.shortfalls.length > 0 && (
            <div className="sec"><h6>Shortfall</h6>
              {r.shortfalls.map((s) => <div className="vr" key={s.node + s.key}><span className="k">{nameOf(s.node)} · {keyInfo(s.key).label}</span><span className="v bad">short by {fmt(s.amount)}</span></div>)}
            </div>
          )}
          {r.changes.length > 0 && (
            <div className="sec"><h6>Sizing · before → after</h6>
              {r.changes.map((c) => <div className="vr" key={c.node + c.key}><span className="k">{nameOf(c.node)} · {c.key}</span><span className="v">{fmt(c.from)} → {Math.ceil(c.to)}</span></div>)}
              <button className="btn" style={{ marginTop: 10 }} onClick={onApply}>Apply</button>
            </div>
          )}
        </>
      )}
      {!r && !solving && <div className="sec"><p className="muted">Pick a goal and solve. The engine sizes the knobs and shows the before→after — nothing changes until you Apply.</p></div>}
    </div>
  );
}
