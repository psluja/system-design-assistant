import { useEffect, useMemo, useRef, useState } from 'react';

// A VS Code-style command palette (Ctrl/Cmd+K): a searchable list of ACTIONS. It does not own any logic —
// each command delegates to a handler app.tsx already has, so the palette can never disagree with a button.
// Keyboard-first: ↑/↓ move, Enter runs, Esc closes; a fuzzy (subsequence) filter ranks contiguous matches first.

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly hint?: string; // a keyboard shortcut or context note, shown right-aligned
  readonly keywords?: string; // extra search terms not in the label
  readonly disabled?: boolean;
  readonly run: () => void;
}

/** Subsequence match with a score: every query char must appear in order; contiguous runs and early matches
 *  score higher. Returns null when it does not match. Case-insensitive. */
function score(query: string, text: string): number | null {
  if (query === '') return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let s = 0;
  let streak = 0;
  let prev = -2; // -2 (not -1) so the first char at ti=0 is NOT counted as a contiguous streak
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      streak = prev === ti - 1 ? streak + 1 : 0;
      s += 1 + streak * 2 + (ti === 0 ? 3 : 0);
      prev = ti;
      qi++;
    }
  }
  return qi === q.length ? s : null;
}

export function CommandPalette({ open, commands, onClose }: { open: boolean; commands: readonly Command[]; onClose: () => void }): JSX.Element | null {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open) { setQ(''); setActive(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);

  const results = useMemo(() => {
    const scored = commands
      .map((c) => ({ c, s: score(q, `${c.label} ${c.keywords ?? ''}`) }))
      .filter((r): r is { c: Command; s: number } => r.s !== null)
      .sort((a, b) => b.s - a.s);
    return scored.map((r) => r.c);
  }, [q, commands]);

  useEffect(() => { setActive((a) => Math.min(a, Math.max(0, results.length - 1))); }, [results.length]);
  useEffect(() => { listRef.current?.querySelector('.cmd-row.active')?.scrollIntoView({ block: 'nearest' }); }, [active, results]);

  if (!open) return null;

  const run = (c: Command | undefined): void => { if (c && !c.disabled) { onClose(); c.run(); } };

  return (
    <div className="cmd-backdrop" onMouseDown={onClose}>
      <div className="cmd-box" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmd-input"
          placeholder="Type a command…  (↑↓ to move · Enter to run · Esc to close)"
          value={q}
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); run(results[active]); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
        />
        <div className="cmd-list" ref={listRef}>
          {results.length === 0 ? (
            <div className="cmd-empty">No matching command</div>
          ) : (
            results.map((c, i) => (
              <div
                key={c.id}
                className={'cmd-row' + (i === active ? ' active' : '') + (c.disabled ? ' disabled' : '')}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); run(c); }}
              >
                <span className="cmd-grp">{c.group}</span>
                <span className="cmd-label">{c.label}</span>
                {c.hint && <span className="cmd-hint">{c.hint}</span>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
