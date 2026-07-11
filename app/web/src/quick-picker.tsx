import { useEffect, useMemo, useRef, useState } from 'react';
import type { PickerOption } from '@sda/presenter';
import { KIND_LABEL } from './facets';
import { iconFor } from './icons';

// The in-canvas QUICK-ADD picker (TASK-63 "canvas smoothness") — an n8n-grade creation flow. A small popover
// anchored at a screen point: a search box + a scrollable, kind-grouped list of the LEGALITY-FILTERED options the
// shared `pickerOptions` produced (a wire dropped on empty canvas offers only what attaches to the source port;
// the N key / ghost CTA offer the whole catalog). It owns NO logic beyond filtering the given list and reporting
// the pick — the candidates and the wiring live in @sda/presenter, so the web popover and the VS Code QuickPick
// can never diverge. Visual language mirrors the command palette (cmd-*), with dedicated qp-* styling.

/**
 * Substring filter over the option type ids, keeping the shared list's ORDER (already sorted / legality-ranked).
 * Case-insensitive; an empty query returns every option. Pure — extracted so it is unit-tested without a DOM.
 */
export function filterOptions(options: readonly PickerOption[], query: string): PickerOption[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...options];
  return options.filter((o) => o.type.toLowerCase().includes(q));
}

/** The filtered options grouped by kind, preserving the first-seen order of both kinds and options within a kind
 *  (so the visual groups follow the shared list's ranking). Pure — the render just maps over this. */
export function groupOptions(options: readonly PickerOption[]): { kind: string; options: PickerOption[] }[] {
  const groups: { kind: string; options: PickerOption[] }[] = [];
  const byKind = new Map<string, PickerOption[]>();
  for (const o of options) {
    let bucket = byKind.get(o.kind);
    if (bucket === undefined) {
      bucket = [];
      byKind.set(o.kind, bucket);
      groups.push({ kind: o.kind, options: bucket });
    }
    bucket.push(o);
  }
  return groups;
}

export interface QuickPickerState {
  readonly x: number; // screen coords of the anchor (the drop point / CTA / viewport centre / near the port "+")
  readonly y: number;
  readonly options: readonly PickerOption[];
  readonly context?: { readonly node: string; readonly port: string }; // present only for a drop-to-pick / port "+"
  // An EXPLICIT flow-space placement for the new node, overriding "place at the anchor". The port "+" (TASK-71)
  // places to the RIGHT of the source (out port) / LEFT (in port) at the tidy column pitch — NOT under the popover,
  // which is anchored near the port for the human. Absent ⇒ place where the anchor maps (drop-to-pick / N / CTA).
  readonly place?: { readonly x: number; readonly y: number };
}

export function QuickPicker({
  state,
  onPick,
  onClose,
}: {
  state: QuickPickerState | null;
  onPick: (type: string) => void;
  onClose: () => void;
}): JSX.Element | null {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const open = state !== null;
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, state?.x, state?.y]);

  // The flat, filtered list (list order = keyboard order); the render groups a copy of it for display.
  const results = useMemo(() => filterOptions(state?.options ?? [], q), [state?.options, q]);
  const groups = useMemo(() => groupOptions(results), [results]);

  useEffect(() => { setActive((a) => Math.min(a, Math.max(0, results.length - 1))); }, [results.length]);
  useEffect(() => { listRef.current?.querySelector('.qp-row.active')?.scrollIntoView({ block: 'nearest' }); }, [active, results]);

  if (state === null) return null;

  const pick = (o: PickerOption | undefined): void => { if (o) { onClose(); onPick(o.type); } };

  // Anchor the popover at the drop point, clamped into the viewport so it is never half off-screen.
  const W = 320;
  const left = Math.min(state.x, (typeof window !== 'undefined' ? window.innerWidth : 1280) - W - 12);
  const top = Math.min(state.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 360);

  return (
    <div className="qp-backdrop" onMouseDown={onClose}>
      <div className="qp-box" style={{ left: Math.max(12, left), top: Math.max(12, top) }} onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="qp-input"
          placeholder={state.context ? 'Attach a component…' : 'Add a component…'}
          value={q}
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); pick(results[active]); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
        />
        <div className="qp-list" ref={listRef}>
          {results.length === 0 ? (
            // Honest empty-state: a port with no legal fit says so plainly rather than a silent no-op (the tool
            // must not lie). A no-context picker only reaches this when a query matches nothing.
            <div className="qp-empty">{state.context ? 'Nothing attaches to this port.' : 'No matching component.'}</div>
          ) : (
            groups.map((g) => (
              <div className="qp-group" key={g.kind}>
                <div className="qp-grp">{KIND_LABEL[g.kind] ?? g.kind}</div>
                {g.options.map((o) => {
                  const idx = results.indexOf(o);
                  return (
                    <div
                      key={o.type}
                      className={'qp-row' + (idx === active ? ' active' : '')}
                      onMouseEnter={() => setActive(idx)}
                      onMouseDown={(e) => { e.preventDefault(); pick(o); }}
                    >
                      <span className="qp-ic">{iconFor(o.kind)}</span>
                      <span className="qp-label">{o.type}</span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
