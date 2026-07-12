import { isTriangularRange, rangeProblem, type Range } from '@sda/content';
import { fmt } from './format';

// RANGE TEXT I/O — the ONE shared home for turning an uncertainty RANGE into
// display text, and turning a user's INPUT back into a validated range. Both shells consume these so a range typed
// in the VS Code InputBox and one entered in the web Inspector are parsed, validated and displayed IDENTICALLY
// (the anti-drift guarantee, exactly like the shared `fmt`). Pure — no React, no vscode, no shell state; the sanity
// check is the SAME `rangeProblem` the engine's `instantiate` uses, so the UI can never accept a range the build
// would reject. The web (three fields) and the extension (one "lo-hi" string) are two ENTRY POINTS onto one model.

/** The outcome of interpreting range input: CLEAR the range (blank input), a well-formed RANGE, or an honest ERROR
 *  whose message names how to fix it (never a silent clamp — the tool must not lie). One shape for both entry points. */
export type RangeParse =
  | { readonly kind: 'clear' }
  | { readonly kind: 'range'; readonly range: Range }
  | { readonly kind: 'error'; readonly message: string };

/** The accepted-forms sentence every range error ends with — declared ONCE so the extension InputBox and the web
 *  field name the SAME grammar. Uniform is two bounds; triangular adds a most-likely mode between them. */
export const RANGE_INPUT_FORMS =
  'uniform "lo-hi" (e.g. 1500-3000) or triangular "lo-mode-hi" (e.g. 100-130-180); leave blank to clear';

/** Compact DISPLAY of a range for the collapsed knob indicator + the native tree row: `±(lo–hi)` uniform,
 *  `±(lo–mode–hi)` triangular. Numbers use the shared `fmt` (thousands-grouped), so `130 ±(100–180)` reads
 *  identically in both shells. The en-dash separates bounds (a display glyph, distinct from the input hyphen). */
export function formatRange(range: Range): string {
  return isTriangularRange(range)
    ? `±(${fmt(range.lo)}–${fmt(range.mode)}–${fmt(range.hi)})`
    : `±(${fmt(range.lo)}–${fmt(range.hi)})`;
}

/** The EDITABLE seed text for a range — `lo-hi` / `lo-mode-hi` with raw (ungrouped) numbers, so it round-trips
 *  through `parseRangeInput` exactly (the VS Code InputBox pre-fills with this when re-editing an existing range). */
export function formatRangeInput(range: Range): string {
  return isTriangularRange(range) ? `${range.lo}-${range.mode}-${range.hi}` : `${range.lo}-${range.hi}`;
}

/** Split on a dash separator (hyphen / en-dash / em-dash) with optional surrounding whitespace, then read each
 *  token as a number tolerating thousands commas (the doc writes "1,500–3,000"). Returns the finite numbers, or
 *  null when any token is empty or not a finite number — the caller turns that into a guided error. */
function readBounds(trimmed: string): readonly number[] | null {
  const parts = trimmed.split(/\s*[-–—]\s*/).map((p) => p.trim());
  const nums: number[] = [];
  for (const p of parts) {
    if (p === '') return null;
    const n = Number(p.replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  return nums;
}

/** Build the range for a validated bound list (2 ⇒ uniform, 3 ⇒ triangular). The caller guarantees the length. */
function rangeOf(nums: readonly number[]): Range {
  return nums.length === 3 ? { lo: nums[0]!, mode: nums[1]!, hi: nums[2]! } : { lo: nums[0]!, hi: nums[1]! };
}

/** Parse a SINGLE-STRING range input (the VS Code InputBox grammar): blank ⇒ clear, `lo-hi` ⇒ uniform,
 *  `lo-mode-hi` ⇒ triangular, anything else ⇒ a guided error naming the accepted forms. An otherwise well-formed
 *  but UNSOUND range (lo>hi, or a triangular mode outside [lo,hi]) fails with `rangeProblem`'s exact reason — the
 *  same sanity check `instantiate` applies, so the InputBox can never accept a range the build would reject. */
export function parseRangeInput(text: string): RangeParse {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'clear' };
  const nums = readBounds(trimmed);
  if (nums === null || (nums.length !== 2 && nums.length !== 3)) {
    return { kind: 'error', message: `"${trimmed}" is not a range — enter ${RANGE_INPUT_FORMS}` };
  }
  const range = rangeOf(nums);
  const problem = rangeProblem(range);
  if (problem !== null) return { kind: 'error', message: problem };
  return { kind: 'range', range };
}

/** Build a range from the web Inspector's DISCRETE fields — lo, hi (both required) and an optional mode (its
 *  presence switches the range to triangular). All blank ⇒ clear (the affordance emptied). A partial or non-numeric
 *  entry, or an unsound range, ⇒ a guided error (the SAME `rangeProblem` reason the extension surfaces). The two
 *  entry points (three fields here, one string in the extension) resolve to ONE validated model. */
export function rangeFromFields(lo: string, hi: string, mode: string): RangeParse {
  const loT = lo.trim();
  const hiT = hi.trim();
  const modeT = mode.trim();
  if (loT === '' && hiT === '' && modeT === '') return { kind: 'clear' };
  if (loT === '' || hiT === '') {
    return { kind: 'error', message: `enter both a low and a high bound — ${RANGE_INPUT_FORMS}` };
  }
  const loN = Number(loT.replace(/,/g, ''));
  const hiN = Number(hiT.replace(/,/g, ''));
  const hasMode = modeT !== '';
  const modeN = hasMode ? Number(modeT.replace(/,/g, '')) : undefined;
  if (!Number.isFinite(loN) || !Number.isFinite(hiN) || (hasMode && !Number.isFinite(modeN!))) {
    return { kind: 'error', message: `the bounds must be numbers — ${RANGE_INPUT_FORMS}` };
  }
  const range: Range = hasMode ? { lo: loN, mode: modeN!, hi: hiN } : { lo: loN, hi: hiN };
  const problem = rangeProblem(range);
  if (problem !== null) return { kind: 'error', message: problem };
  return { kind: 'range', range };
}
