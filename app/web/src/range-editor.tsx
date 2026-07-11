import { useEffect, useRef, useState } from 'react';
import { rangeFromFields, formatRange } from '@sda/presenter';
import type { Range } from '@sda/content';

// The uncertainty ± RANGE editor popover (doc: uncertainty-monte-carlo §4 "Inspector · a ± affordance, collapsed by
// default"). It declares that a soft config input is a RANGE, not a point, so the Monte-Carlo run can draw from it —
// the base forward pass keeps the point value, so a ranged design evaluates bit-identically until sampled. Three
// discrete fields (lo / hi + an OPTIONAL most-likely mode whose presence switches the shape to triangular), validated
// LIVE by the SHARED presenter `rangeFromFields` — the SAME grammar + `rangeProblem` sanity the VS Code InputBox uses,
// so a range entered here and one typed in the extension are interpreted IDENTICALLY (one meaning, two entry points).
// An unsound range surfaces its exact reason inline and disables Apply — never a silent clamp (the tool must not lie).
//
// Pure UI: the parent owns the studio dispatch (setRange for a real range, clearRange for null). Reuses the .tf-*
// popover language (see theme.css) so it reads like the transform editor — a small, anchored card.

/** What the popover edits: one config knob on one node, addressed by (node, key) — the SAME key `setRange`/`clearRange`
 *  and the on-disk `instance.ranges` are keyed by. */
export interface RangeTarget {
  readonly node: string;
  readonly key: string;
}

export interface RangeEditorProps {
  readonly target: RangeTarget;
  /** The knob's human label (from the shared keyInfo) — shown in the header so the architect knows what they range. */
  readonly label: string;
  /** The knob's unit ('' when dimensionless) — shown beside the point value for context. */
  readonly unit: string;
  /** The current POINT config value, shown as context — a range is the soft admission around this point. */
  readonly point: number;
  /** The range already declared on this knob, or null when it is a plain point value (the collapsed default). */
  readonly current: Range | null;
  readonly x: number;
  readonly y: number;
  /** Commit the range (or null to CLEAR it) for this target, via the shell's studio.dispatch. The parent picks the
   *  command: setRange for a real range, clearRange for null. */
  readonly onApply: (target: RangeTarget, range: Range | null) => void;
  readonly onClose: () => void;
}

export function RangeEditor({ target, label, unit, point, current, x, y, onApply, onClose }: RangeEditorProps): JSX.Element {
  // Seed the fields from the current range so re-editing pre-fills exactly (raw numbers, no grouping — they re-parse).
  const [lo, setLo] = useState<string>(current ? String(current.lo) : '');
  const [hi, setHi] = useState<string>(current ? String(current.hi) : '');
  const [mode, setMode] = useState<string>(current && 'mode' in current ? String(current.mode) : '');
  const loRef = useRef<HTMLInputElement>(null);

  // Focus the low bound on open, so the flow is type → tab → type → Apply.
  useEffect(() => { loRef.current?.focus(); }, []);
  // Esc closes without committing (the standard popover contract, matching the transform editor).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // The SHARED validator: 'clear' (all blank), a well-formed 'range', or an 'error' whose message names the fix. This
  // is the exact function the VS Code InputBox validates with, so the two shells accept/reject identically.
  const parse = rangeFromFields(lo, hi, mode);
  const err = parse.kind === 'error' ? parse.message : null;
  const preview = parse.kind === 'range' ? formatRange(parse.range) : null;
  const unitTxt = unit === '' || unit === '1' ? '' : ` ${unit}`;

  const apply = (): void => {
    if (parse.kind === 'error') return; // never commit an unsound / malformed range
    onApply(target, parse.kind === 'clear' ? null : parse.range);
    onClose();
  };

  return (
    <>
      {/* a transparent backdrop so a click elsewhere dismisses the popover (matches the transform/menu dismissal). */}
      <div className="tf-backdrop" onMouseDown={onClose} />
      <div className="ai-pop tf-pop" style={{ left: x, top: y, right: 'auto' }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="ai-pop-h">Uncertainty range · {label}</div>
        <p>Declare this soft input as a ± RANGE, not a point (currently {point}{unitTxt}). A Monte-Carlo run samples it; the base evaluation keeps the point value.</p>
        <div className="range-fields">
          <label>lo
            <input ref={loRef} type="number" inputMode="decimal" step="any" value={lo} placeholder="min"
              onChange={(e) => setLo(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && parse.kind !== 'error') { e.preventDefault(); apply(); } }}
              aria-label="range low bound" />
          </label>
          <label>mode
            <input type="number" inputMode="decimal" step="any" value={mode} placeholder="optional"
              onChange={(e) => setMode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && parse.kind !== 'error') { e.preventDefault(); apply(); } }}
              aria-label="range most-likely mode" />
          </label>
          <label>hi
            <input type="number" inputMode="decimal" step="any" value={hi} placeholder="max"
              onChange={(e) => setHi(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && parse.kind !== 'error') { e.preventDefault(); apply(); } }}
              aria-label="range high bound" />
          </label>
        </div>
        <p className="tf-help">Uniform = a low and a high. Add a most-likely "mode" (inside [lo, hi]) for a triangular shape. Leave all three blank and Apply to clear the range.</p>
        {preview !== null && <p className="tf-preview">{preview}</p>}
        {err !== null && <p className="tf-err">{err}</p>}
        <div className="tf-actions">
          {current !== null && (
            <button type="button" className="btn ghost" title="Clear this knob's uncertainty range" onClick={() => { onApply(target, null); onClose(); }}>
              Clear range
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={apply} disabled={parse.kind === 'error'}>Apply</button>
        </div>
      </div>
    </>
  );
}
