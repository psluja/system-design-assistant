import type { GuaranteeVerdict } from '@sda/content';
import { keyInfo, fmt, formatMs, type ProblemRow } from '@sda/presenter';

// The PROBLEMS lens (an IDE-style Error List), extracted from app.tsx (TASK-89). One table over the ONE verdict
// list: the presenter's `problemRows` (violations → warnings → unverified, plus build errors) followed by the
// qualitative GUARANTEE violations (doc: guarantee-propagation §4) — both computed upstream, never re-derived
// here. A row click selects the (root-cause) node; "Fix all" hands off to Improve's 'feasible' backward solve.

/** The Problems lens body (`lens === 'problems'` in the System drawer). */
export function ProblemsPanel({ problems, problemCnt, guaranteeProblems, nameOf, onSelect, onFixAll }: {
  problems: readonly ProblemRow[];
  /** The countable (violation) subset driving the "Fix all" button — the presenter's `problemCount`. */
  problemCnt: number;
  guaranteeProblems: ReadonlyArray<{ readonly verdict: GuaranteeVerdict; readonly fix: string | undefined }>;
  nameOf: (id: string) => string;
  onSelect: (id: string) => void;
  onFixAll: () => void;
}): JSX.Element {
  return (
    <div className="syscols">
      <div className="sec" style={{ gridColumn: '1 / -1' }}>
        <div className="problems-hdr">
          <h6 data-tip="Every verdict that is not green, in one list — computed by the engine, never re-derived here. Violations first, then warnings, then checks the scalar pass cannot verify. Click a row to select the node on the canvas.">Problems</h6>
          {problemCnt > 0 && (
            <button
              className="btn p-fix-btn"
              title="Run the solver backwards: the minimal knob change that clears EVERY violation at once (SLOs are solved together, not one at a time) — shows the before→after in Improve; nothing changes until you Apply."
              onClick={onFixAll}
            >⚡ Fix all ({problemCnt})</button>
          )}
        </div>
        {problems.length === 0 && guaranteeProblems.length === 0 ? (
          <p className="muted">No problems — every check is green. ✓</p>
        ) : (
          <table className="problems">
            <thead>
              <tr><th></th><th>Node</th><th>Check</th><th>Value</th><th>Recommendation</th></tr>
            </thead>
            <tbody>
              {problems.map((r, i) => (
                <tr key={i} className={'sev-' + r.severity} title="Click to select the node (its knobs open in the Inspector)" onClick={() => { if (r.node) { onSelect(r.node); } }}>
                  <td className="p-ic">{r.severity === 'violation' ? '✖' : r.severity === 'warning' ? '⚠' : '?'}</td>
                  <td className="p-node">{r.node ? nameOf(r.node) : '(design)'}</td>
                  <td className="p-key">{r.key === 'build' ? 'build error' : keyInfo(r.key).label}</td>
                  <td className="p-val">{Number.isNaN(r.value) ? '—' : r.unit === 'ms' ? formatMs(r.value) : `${fmt(r.value)}${r.unit ? ` ${r.unit}` : ''}`}</td>
                  <td className="p-fix">{r.fix ?? '—'}</td>
                </tr>
              ))}
              {/* GUARANTEE violations (doc: guarantee-propagation §4) — a broken qualitative promise, listed
                  here alongside the numeric breaches. The node is the root cause (click → select it); the
                  Check is the dimension; the Value is the computed vs required token; the fix is the computed swap. */}
              {guaranteeProblems.map((g, i) => (
                <tr key={`g${i}`} className="sev-violation" title="Click to select the root-cause node (its knobs open in the Inspector)" onClick={() => { if (g.verdict.rootCauseNode) onSelect(g.verdict.rootCauseNode); }}>
                  <td className="p-ic">✖</td>
                  <td className="p-node">{g.verdict.rootCauseNode ? nameOf(g.verdict.rootCauseNode) : `${g.verdict.source} → ${g.verdict.terminal}`}</td>
                  <td className="p-key">{g.verdict.dimension}</td>
                  <td className="p-val">{g.verdict.computed} (needs ≥ {g.verdict.required})</td>
                  <td className="p-fix">{g.fix ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
