import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, allManifests } from '@sda/content';
import { rangeFromFields, formatRange } from '@sda/presenter';

// THE WEB INSPECTOR ± RANGE LOOP (doc: uncertainty-monte-carlo §4). The web computes NOTHING beyond the shared
// presenter (web-is-a-dumb-renderer), so the meaningful "interaction" is exactly: the RangeEditor's three discrete
// fields → the shared `rangeFromFields` validator → a setRange / clearRange studio dispatch → the collapsed ±(lo–hi)
// indicator via `formatRange`. This test drives that EXACT path — the SAME functions app.tsx + range-editor.tsx call —
// over a real Studio, no DOM needed, deterministic and fast. It proves the web entry point reaches the same validated
// model the VS Code InputBox does (the anti-drift guarantee), and — the honesty-critical part — that an UNSOUND range
// is BLOCKED before any dispatch (never a silent clamp). The dispatch reducer semantics themselves are pinned in
// @sda/core's core.test.ts and the grammar in @sda/presenter's range-input.test.ts; here we prove the web wiring.

function build(): Studio {
  const s = new Studio(registry, allManifests);
  const r = s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.service' });
  if (!r.ok) throw new Error(r.error);
  return s;
}

/** The range on a knob as the web reads it back for the collapsed indicator (`instance.ranges[key]`). */
const rangeOf = (s: Studio, node: string, key: string) => s.project().instances.find((i) => i.id === node)?.ranges?.[key];

/**
 * The web RangeEditor's `onApply` decision, extracted VERBATIM from app.tsx so the test exercises the real branch:
 *   • a well-formed range ⇒ setRange (upsert by config key);
 *   • all-blank ⇒ clearRange, but ONLY when a range already exists (else a no-op — never a phantom "cleared" claim);
 *   • an unsound / malformed entry ⇒ blocked (no dispatch) — the affordance surfaces the reason instead.
 * Returns what the loop did, so the assertions read the web's behaviour, not just the reducer's.
 */
function applyRange(s: Studio, node: string, key: string, lo: string, hi: string, mode: string): 'set' | 'clear' | 'noop' | 'error' {
  const parse = rangeFromFields(lo, hi, mode);
  if (parse.kind === 'error') return 'error';
  const current = rangeOf(s, node, key);
  if (parse.kind === 'clear') {
    if (current === undefined) return 'noop';
    const r = s.dispatch({ kind: 'clearRange', node, key });
    if (!r.ok) throw new Error(r.error);
    return 'clear';
  }
  const r = s.dispatch({ kind: 'setRange', node, key, range: parse.range });
  if (!r.ok) throw new Error(r.error);
  return 'set';
}

describe('web Inspector ± range affordance — fields → rangeFromFields → dispatch → collapsed indicator', () => {
  it('typing lo + hi declares a UNIFORM range; the collapsed indicator reads ±(lo–hi)', () => {
    const s = build();
    expect(applyRange(s, 'svc', 'perRequestDuration', '15', '30', '')).toBe('set');
    expect(rangeOf(s, 'svc', 'perRequestDuration')).toEqual({ lo: 15, hi: 30 });
    expect(formatRange(rangeOf(s, 'svc', 'perRequestDuration')!)).toBe('±(15–30)');
  });

  it('adding a most-likely mode declares a TRIANGULAR range; the indicator reads ±(lo–mode–hi)', () => {
    const s = build();
    expect(applyRange(s, 'svc', 'concurrency', '400', '700', '500')).toBe('set');
    expect(rangeOf(s, 'svc', 'concurrency')).toEqual({ lo: 400, mode: 500, hi: 700 });
    expect(formatRange(rangeOf(s, 'svc', 'concurrency')!)).toBe('±(400–500–700)');
  });

  it('emptying all three fields on a ranged knob CLEARS it (the indicator collapses back to ±)', () => {
    const s = build();
    applyRange(s, 'svc', 'concurrency', '400', '700', '');
    expect(rangeOf(s, 'svc', 'concurrency')).toBeDefined();
    expect(applyRange(s, 'svc', 'concurrency', '', '', '')).toBe('clear');
    expect(rangeOf(s, 'svc', 'concurrency')).toBeUndefined();
  });

  it('emptying the fields on an UN-ranged knob is a no-op (no phantom "cleared" — the tool must not lie)', () => {
    const s = build();
    expect(applyRange(s, 'svc', 'concurrency', '', '', '')).toBe('noop');
    expect(rangeOf(s, 'svc', 'concurrency')).toBeUndefined();
  });

  it('an UNSOUND range (lo > hi) is BLOCKED before dispatch — never a silent clamp, never a written range', () => {
    const s = build();
    expect(applyRange(s, 'svc', 'concurrency', '700', '400', '')).toBe('error');
    expect(rangeOf(s, 'svc', 'concurrency')).toBeUndefined(); // nothing was committed
    // and the shared validator names the fix (the SAME message the VS Code InputBox shows)
    const parse = rangeFromFields('700', '400', '');
    expect(parse.kind).toBe('error');
    if (parse.kind === 'error') expect(parse.message).toMatch(/must bracket/);
  });

  it('a declared range leaves the BASE evaluation intact — the point config value is untouched (invisible until sampled)', () => {
    const s = build();
    const before = s.project().instances.find((i) => i.id === 'svc')?.config?.['concurrency'];
    applyRange(s, 'svc', 'concurrency', '400', '700', '');
    const after = s.project().instances.find((i) => i.id === 'svc')?.config?.['concurrency'];
    expect(after).toBe(before); // the range is additive metadata; the forward pass still reads the point value
    expect(s.evaluate().ok).toBe(true); // a ranged design still builds + evaluates (the base pass ignores the range)
  });
});
