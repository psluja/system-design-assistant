import { useEffect, useMemo, useRef, useState } from 'react';
import { cyclesProblem, type Cycle, type Transform } from '@sda/engine-core';
import { LOAD_STAGES_PRESETS, shapeSeries, type LoadStagePreset } from '@sda/content';

// The TRANSFORM editor popover (R2, doc: flow-transformations-r2 §4; wire level added by §5; the GENERATOR
// stages table added by load-stages R3 §11). It edits ONE transfer function and commits an undoable command. TWO
// modes, so the SAME popover serves both resolution levels:
//   • 'wire' — a click on an edge's OUT-side pill edits THAT WIRE (a routing split): commits setWireTransform. This
//     is the most natural UX (the pill lives on the wire), and lets one out port feed several wires with different
//     shares (70/30). The header says "this wire" so it is unmistakably the wire, not the shared port default.
//   • 'port' — an Inspector port row (or an IN-side pill) edits the PORT default: commits setTransform. The header
//     says "port default" so the architect knows a change here affects EVERY wire off that port (unless a wire
//     overrides it). The clear affordance is labelled with the level it clears.
// Pure UI: the parent owns the studio dispatch.
//
// Reuses the .ai-pop visual language (see theme.css) so it reads like the AI-tools popover — a small, anchored card.
// When `generate` is chosen, the card widens to host the k6-style STAGES TABLE (§11 option A): the baseline level,
// a preset dropdown that pre-fills, per-cycle {durationS, multiplier} rows, a read-only shape sparkline, and the
// `disable` toggle. No new surface — the table is a pane in THIS popover (the ledger rule).

/** The closed function set (doc §3) + a "none" entry that clears the transform. Each carries the human hint the
 *  value field shows, so the architect knows what the number MEANS (× multiplier, n batch size, a rate, ms, p). */
type Fn = 'none' | Transform['kind'];
const FUNCTIONS: ReadonlyArray<{ readonly fn: Fn; readonly label: string; readonly hint: string; readonly help: string }> = [
  { fn: 'none', label: 'None (identity)', hint: '', help: 'Pass traffic through 1:1 — the default.' },
  { fn: 'ratio', label: 'ratio — scale ×k', hint: '× multiplier', help: 'out = k × in. Log amplification (×100), event fan-out (×3), sampling (×0.1).' },
  { fn: 'batch', label: 'batch — collapse n:1', hint: 'n per batch', help: 'out = in ÷ n. Aggregators / batchers (100 requests → 1).' },
  { fn: 'cap', label: 'cap — ceiling r/s', hint: 'req/s ceiling', help: 'out = min(in, r). Rate limiters, throttles; the excess becomes overflow.' },
  { fn: 'window', label: 'window — flush every ms', hint: 'window ms', help: 'out = min(in, 1000/ms). Time-window aggregation (flush every 10 000 ms → ≤ 0.1/s).' },
  { fn: 'prob', label: 'prob — fraction p', hint: 'p (0..1)', help: 'out = p × in. Error/DLQ splits (p = 0.01), A/B routing.' },
  // The sixth family member (doc: load-stages §4): the port ORIGINATES traffic instead of reshaping it. PORT
  // level only (a wire cannot originate — the wire-mode popover filters it out). The level is the BASELINE (×1);
  // the CYCLES table below (R3 §11) shapes it over time.
  { fn: 'generate', label: 'generate — originate req/s', hint: 'req/s (baseline)', help: 'The port originates this many req/s of its own (a cron, an emitter, a migration source). It consumes this node’s capacity, then flows downstream. The level is the BASELINE rate (×1); the cycles table below shapes it over time.' },
];

/** The preset dropdown entries (doc: load-stages §11, §16.3) — each pre-fills the table from `LOAD_STAGES_PRESETS`,
 *  then every cell is editable (never a mode). Ordered as the six shipped scenarios; `spike` is the one-node
 *  migration path for the deleted global probe. Labels name the real-tool scenario each reproduces. */
const PRESETS: ReadonlyArray<{ readonly id: LoadStagePreset; readonly label: string }> = [
  { id: 'flat', label: 'flat — steady baseline (clears cycles)' },
  { id: 'spike', label: 'spike — one-shot ×3 stress burst' },
  { id: 'ramp-up', label: 'ramp-up — k6 ramping arrival rate' },
  { id: 'diurnal', label: 'diurnal — a looped day (rush hour)' },
  { id: 'on-off-burst', label: 'on-off-burst — cron/batch pulse' },
  { id: 'quarterly-report', label: 'quarterly-report — a seasonal spike' },
];

/** How many points the read-only preview samples the shape at (a smooth-enough piecewise-linear silhouette). */
const PREVIEW_POINTS = 96;

/** What the popover is editing: a PORT default (Inspector row / IN-side pill) or ONE WIRE (an OUT-side pill).
 *  The two carry the identifiers their respective commands need — a port by (node, port); a wire by its from/to
 *  port tuples (the stable wire key `setWireTransform` uses). The mode drives the header + clear label so the
 *  architect always knows WHICH level a change touches (doc: flow-transformations-r2 §5). */
export type TransformTarget =
  | { readonly mode: 'port'; readonly node: string; readonly port: string }
  | { readonly mode: 'wire'; readonly from: readonly [string, string]; readonly to: readonly [string, string] };

export interface TransformEditorProps {
  readonly target: TransformTarget;
  readonly current: Transform | null;
  readonly x: number;
  readonly y: number;
  /** Commit the transform (or null to clear) for this target, via the shell's studio.dispatch. The parent picks
   *  the command from `target.mode`: setTransform for a port, setWireTransform for a wire. */
  readonly onApply: (target: TransformTarget, transform: Transform | null) => void;
  readonly onClose: () => void;
}

// ── The editable stages table state (doc: load-stages §11). Cells are held as STRINGS so a partly-typed value never
// crashes the preview or fabricates a 0 — an empty cell parses to NaN, which `cyclesProblem` catches with the exact
// guided rule. The numeric Cycle[] is derived from this on the fly (preview) and on Apply (commit). ──

interface EditStage {
  readonly durationS: string;
  readonly multiplier: string;
}
interface EditCycle {
  readonly periodS: string;
  readonly stages: readonly EditStage[];
}

/** '' ⇒ NaN (not 0) so an empty cell is REFUSED by `cyclesProblem`, never silently treated as a zero duration. */
const numOrNaN = (s: string): number => (s.trim() === '' ? NaN : Number(s));

/** Parse the editable string table into numeric {@link Cycle}s — the single lowering both the preview and Apply
 *  read, so what the sparkline draws is what the engine evaluates (the anti-drift rule). Empty cells become NaN. */
export function parseEditCycles(cycles: readonly EditCycle[]): Cycle[] {
  return cycles.map((c) => ({
    periodS: numOrNaN(c.periodS),
    stages: c.stages.map((s) => ({ durationS: numOrNaN(s.durationS), multiplier: numOrNaN(s.multiplier) })),
  }));
}

/** Seed the editable table from committed cycles (re-editing / a preset pre-fill) — numbers to strings, verbatim. */
function toEditCycles(cycles: readonly Cycle[]): EditCycle[] {
  return cycles.map((c) => ({ periodS: String(c.periodS), stages: c.stages.map((s) => ({ durationS: String(s.durationS), multiplier: String(s.multiplier) })) }));
}

/** True when every cell is numerically renderable (finite period/durations > 0, finite multipliers ≥ 0) — the
 *  gate the preview uses so a half-typed table shows a flat baseline rather than a NaN-poisoned polyline. This is
 *  looser than `cyclesProblem` (it ignores Σ durationS ≤ periodS and the all-zero rule) because those still draw. */
function renderable(cycles: readonly Cycle[]): boolean {
  return (
    cycles.length > 0 &&
    cycles.every(
      (c) =>
        Number.isFinite(c.periodS) &&
        c.periodS > 0 &&
        c.stages.length > 0 &&
        c.stages.every((s) => Number.isFinite(s.durationS) && s.durationS > 0 && Number.isFinite(s.multiplier) && s.multiplier >= 0),
    )
  );
}

/** The λ̂ multiplier series + its peak for the read-only preview — content's ONE sampler ({@link shapeSeries}) over
 *  renderable cycles, else a flat `×1` baseline. Pure, so it is unit-tested at logic level (the flow-nodes idiom). */
export function previewShape(cycles: readonly EditCycle[]): { readonly series: readonly number[]; readonly peak: number } {
  const parsed = parseEditCycles(cycles);
  const series = renderable(parsed) ? shapeSeries(parsed, PREVIEW_POINTS) : [1, 1];
  const peak = series.reduce((mx, v) => Math.max(mx, v), 0);
  return { series, peak };
}

/** Validate the whole generator (doc: load-stages §4) — the shared `cyclesProblem` over the parsed table, plus the
 *  level rule. Returns the guided reason, or null when it is well-formed and safe to commit. An EMPTY table is a
 *  legal FLAT generator (silent). Pure — the same rule the engine build, MCP and VS Code enforce (one boundary). */
export function generateProblem(level: number, cycles: readonly EditCycle[]): string | null {
  if (!Number.isFinite(level) || level < 0) return 'a generator level must be ≥ 0 (req/s the port originates)';
  if (cycles.length === 0) return null; // a flat generator — the ×1 identity
  return cyclesProblem(parseEditCycles(cycles));
}

/** Validate a value for a reshaping function, mirroring engine-core's `validTransform`: finite & > 0; prob ≤ 1.
 *  Returns an error string, or null when valid. `generate` is validated by {@link generateProblem}, not here. */
function validateValue(fn: Exclude<Transform['kind'], 'generate'>, value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return 'must be a number greater than 0';
  if (fn === 'prob' && value > 1) return 'a probability must be ≤ 1';
  return null;
}

export function TransformEditor({ target, current, x, y, onApply, onClose }: TransformEditorProps): JSX.Element {
  const [fn, setFn] = useState<Fn>(current?.kind ?? 'none');
  const [text, setText] = useState<string>(current ? String(current.kind === 'generate' ? current.level : current.value) : '');
  // The generator's authored table + off-switch, seeded from the committed transform (so re-editing pre-fills).
  const [cycles, setCycles] = useState<EditCycle[]>(current?.kind === 'generate' && current.cycles !== undefined ? toEditCycles(current.cycles) : []);
  const [disable, setDisable] = useState<boolean>(current?.kind === 'generate' && current.disable === true);
  const inputRef = useRef<HTMLInputElement>(null);
  const meta = FUNCTIONS.find((f) => f.fn === fn)!;
  // The header + prose name WHICH level this edits, so a per-wire routing split is never confused with the shared
  // port default (doc: flow-transformations-r2 §5). A wire is titled by its endpoints; a port by node.port.
  const title = target.mode === 'wire' ? `${target.from[0]} → ${target.to[0]}` : `${target.node}.${target.port}`;
  const levelLabel = target.mode === 'wire' ? 'this wire' : 'port default';
  const prose =
    target.mode === 'wire'
      ? 'Shape the traffic THIS WIRE carries — a routing split. Overrides the source port default for this edge only.'
      : 'Shape the traffic this port carries by default (every wire off it). The engine applies it to the live rate.';

  // Focus the value field when a real reshaping function is chosen (generate focuses its own level field below).
  useEffect(() => { if (fn !== 'none') inputRef.current?.focus(); }, [fn]);
  // Esc closes without committing (the standard popover contract).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const value = Number(text);
  const isGen = fn === 'generate';
  const genErr = isGen ? (text.trim() === '' ? 'enter the baseline level (req/s)' : generateProblem(value, cycles)) : null;
  const reshapeErr = fn === 'none' || isGen ? null : text.trim() === '' ? 'enter a value' : validateValue(fn as Exclude<Transform['kind'], 'generate'>, value);
  const err = isGen ? genErr : reshapeErr;
  const canApply = fn === 'none' || err === null;

  // The read-only preview (doc: load-stages §11) — recomputed on every keystroke from the SAME sampler the engine
  // plays, so the drawn silhouette is the evaluated shape. Level scales only the annotation; the polyline is the
  // baseline-anchored multiplier shape (×1 dashed). Kept to a memo so typing stays smooth.
  const preview = useMemo(() => previewShape(cycles), [cycles]);

  const apply = (): void => {
    if (!canApply) return;
    // A generator carries a LEVEL + the authored cycles + the disable off-switch; the five reshaping kinds carry
    // their scalar value. An empty table = a flat generator (no `cycles` field — the byte-identity, no filler).
    const next: Transform | null =
      fn === 'none'
        ? null
        : isGen
          ? { kind: 'generate', level: value, ...(cycles.length > 0 ? { cycles: parseEditCycles(cycles) } : {}), ...(disable ? { disable: true } : {}) }
          : ({ kind: fn, value } as Transform);
    onApply(target, next);
    onClose();
  };

  // ── Table mutators (immutable; the ProjectDoc is readonly, and React needs a new array to re-render) ──
  const setPeriod = (ci: number, v: string): void => setCycles((cs) => cs.map((c, i) => (i === ci ? { ...c, periodS: v } : c)));
  const setStage = (ci: number, si: number, patch: Partial<EditStage>): void =>
    setCycles((cs) => cs.map((c, i) => (i === ci ? { ...c, stages: c.stages.map((s, j) => (j === si ? { ...s, ...patch } : s)) } : c)));
  const addStage = (ci: number): void => setCycles((cs) => cs.map((c, i) => (i === ci ? { ...c, stages: [...c.stages, { durationS: '', multiplier: '' }] } : c)));
  const removeStage = (ci: number, si: number): void => setCycles((cs) => cs.map((c, i) => (i === ci ? { ...c, stages: c.stages.filter((_, j) => j !== si) } : c)));
  const addCycle = (): void => setCycles((cs) => [...cs, { periodS: '', stages: [{ durationS: '', multiplier: '' }] }]);
  const removeCycle = (ci: number): void => setCycles((cs) => cs.filter((_, i) => i !== ci));
  const applyPreset = (id: LoadStagePreset): void => setCycles(toEditCycles(LOAD_STAGES_PRESETS[id]));

  return (
    <>
      {/* a transparent backdrop so a click elsewhere dismisses the popover (matches the picker/menu dismissal). */}
      <div className="tf-backdrop" onMouseDown={onClose} />
      <div className={'ai-pop tf-pop' + (isGen ? ' tf-pop-gen' : '')} style={{ left: x, top: y, right: 'auto' }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="ai-pop-h">Transform · {levelLabel} · {title}</div>
        <p>{prose}</p>
        <select className="tf-select" value={fn} onChange={(e) => setFn(e.target.value as Fn)} aria-label="Transform function">
          {FUNCTIONS.filter((f) => f.fn !== 'generate' || target.mode === 'port').map((f) => (
            <option key={f.fn} value={f.fn}>{f.label}</option>
          ))}
        </select>

        {/* The five reshaping kinds: one scalar value field. */}
        {fn !== 'none' && !isGen && (
          <div className="tf-value">
            <input
              ref={inputRef}
              type="number"
              inputMode="decimal"
              step="any"
              value={text}
              placeholder={meta.hint}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && canApply) { e.preventDefault(); apply(); } }}
              aria-label={`${fn} value`}
            />
            <span className="tf-hint">{meta.hint}</span>
          </div>
        )}

        {/* THE GENERATOR (doc: load-stages §11) — level + preset + the k6 stages table + preview + disable. */}
        {isGen && (
          <div className="tf-gen">
            <div className="tf-value">
              <input
                ref={inputRef}
                type="number"
                inputMode="decimal"
                step="any"
                value={text}
                placeholder="req/s (baseline)"
                onChange={(e) => setText(e.target.value)}
                aria-label="generate level"
              />
              <span className="tf-hint">req/s baseline (×1)</span>
            </div>

            <div className="tf-gen-row">
              <label className="tf-gen-lbl" htmlFor="tf-preset">Preset</label>
              {/* value stays '' so it reads as an ACTION ("pick to pre-fill"), snapping back after each choice —
                  a preset pre-fills, then every cell is editable (never a mode; doc §11). */}
              <select
                id="tf-preset"
                className="tf-preset"
                value=""
                onChange={(e) => { const v = e.target.value as LoadStagePreset | ''; if (v !== '') applyPreset(v); }}
                aria-label="Pre-fill from a preset"
              >
                <option value="">Pre-fill from a preset…</option>
                {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </div>

            {cycles.map((c, ci) => (
              <div className="tf-cycle" key={ci}>
                <div className="tf-cycle-h">
                  <span className="tf-cycle-t">Cycle {ci + 1}</span>
                  <label className="tf-gen-lbl" htmlFor={`tf-period-${ci}`}>periodS</label>
                  <input
                    id={`tf-period-${ci}`}
                    className="tf-cell tf-cell-period"
                    type="number"
                    inputMode="decimal"
                    step="any"
                    value={c.periodS}
                    placeholder="e.g. 86400"
                    onChange={(e) => setPeriod(ci, e.target.value)}
                    aria-label={`cycle ${ci + 1} periodS`}
                  />
                  <button type="button" className="tf-x" title="Remove this cycle" aria-label={`Remove cycle ${ci + 1}`} onClick={() => removeCycle(ci)}>✕</button>
                </div>
                <div className="tf-table" role="table" aria-label={`Cycle ${ci + 1} stages`}>
                  <div className="tf-tr tf-th" role="row">
                    <span role="columnheader">#</span>
                    <span role="columnheader">durationS</span>
                    <span role="columnheader">×</span>
                    <span role="columnheader" aria-label="remove" />
                  </div>
                  {c.stages.map((s, si) => (
                    <div className="tf-tr" role="row" key={si}>
                      <span className="tf-idx" role="cell">{si + 1}</span>
                      <input
                        className="tf-cell"
                        role="cell"
                        type="number"
                        inputMode="decimal"
                        step="any"
                        value={s.durationS}
                        placeholder="seconds"
                        onChange={(e) => setStage(ci, si, { durationS: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addStage(ci); } }}
                        aria-label={`cycle ${ci + 1} stage ${si + 1} durationS`}
                      />
                      <input
                        className="tf-cell"
                        role="cell"
                        type="number"
                        inputMode="decimal"
                        step="any"
                        value={s.multiplier}
                        placeholder="×1"
                        onChange={(e) => setStage(ci, si, { multiplier: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addStage(ci); } }}
                        aria-label={`cycle ${ci + 1} stage ${si + 1} multiplier`}
                      />
                      <button type="button" className="tf-x" title="Remove this stage" aria-label={`Remove stage ${si + 1}`} onClick={() => removeStage(ci, si)}>✕</button>
                    </div>
                  ))}
                  <button type="button" className="tf-add" onClick={() => addStage(ci)}>+ add stage</button>
                </div>
              </div>
            ))}

            <button type="button" className="tf-add tf-add-cycle" onClick={addCycle}>+ add cycle (multiplies)</button>

            {/* THE READ-ONLY PREVIEW (doc §11, Fig. 5) — the baseline-anchored multiplier silhouette; ×1 dashed.
                No pointer-drag, no snapping — a table is keyboard-native; this only mirrors it. */}
            <div className="tf-preview">
              <div className="tf-preview-cap">
                live preview{cycles.length > 0 ? ` · peak ×${Number(preview.peak.toFixed(2))}${Number.isFinite(value) && value > 0 ? ` → ${Math.round(value * preview.peak)} req/s` : ''}` : ' · flat baseline'}
              </div>
              <Sparkline series={preview.series} dim={disable} />
            </div>

            <label className="tf-disable">
              <input type="checkbox" checked={disable} onChange={(e) => setDisable(e.target.checked)} />
              <span>disable — keep the cycles but evaluate flat (the baseline level only)</span>
            </label>
          </div>
        )}

        <p className="tf-help">{meta.help}</p>
        {err !== null && <p className="tf-err">{err}</p>}
        <div className="tf-actions">
          {current !== null && (
            <button type="button" className="btn ghost" title={`Clear the transform on ${levelLabel}`} onClick={() => { onApply(target, null); onClose(); }}>
              Clear {levelLabel}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={apply} disabled={!canApply}>Apply</button>
        </div>
      </div>
    </>
  );
}

/** The read-only shape sparkline (doc: load-stages §11, Fig. 5) — an SVG polyline of the `×1`-anchored multiplier
 *  series, with the baseline as a dashed reference. A pure render of {@link previewShape}'s numbers; `dim` greys it
 *  when the generator is disabled (the shape is authored but evaluated flat). No interaction — a mirror, not a canvas. */
function Sparkline({ series, dim }: { readonly series: readonly number[]; readonly dim: boolean }): JSX.Element {
  const W = 260;
  const H = 60;
  const pad = 4;
  const peak = series.reduce((mx, v) => Math.max(mx, v), 0);
  const topScale = Math.max(peak, 1) * 1.12; // headroom so the peak never touches the top edge
  const n = series.length;
  const xAt = (i: number): number => (n <= 1 ? pad : pad + (i / (n - 1)) * (W - 2 * pad));
  const yAt = (v: number): number => H - pad - (v / topScale) * (H - 2 * pad);
  const points = series.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
  const baseY = yAt(1).toFixed(1);
  return (
    <svg className={'tf-spark' + (dim ? ' dim' : '')} viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Shape preview">
      <line className="tf-spark-base" x1={pad} y1={baseY} x2={W - pad} y2={baseY} strokeDasharray="4 3" />
      <polyline className="tf-spark-line" fill="none" points={points} />
    </svg>
  );
}
