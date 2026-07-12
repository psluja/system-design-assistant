import type { SummarySection } from './protocol';

// THE ACTIVE-WORLD LENS SIDE-CHANNEL (consistency religion — "what I see is what is") — pure, vscode-free, shared by
// the webview (which EMITS) and the host (which CONSUMES).
//
// The problem: the active-world LENS (assumption-model §7.1) is a VIEW choice that lives ONLY in the webview's
// Studio — it is never in the document. The native Inspector, however, must ROUTE a fact-assumption edit into the
// world the canvas is currently showing (else the host writes to base while the canvas shows a world — the exact
// one-form violation this closes). So the host needs to know which world is active.
//
// protocol.ts is FROZEN — no new message, no new field. So the webview rides the active world id in the summary feed
// it ALREADY posts, as a RESERVED SummarySection (the R2b/R3 pattern this codebase uses under the frozen protocol:
// reuse an existing message shape to carry new data). The reserved title is a control sentinel — the host READS the
// id off it and STRIPS the section before the System tree renders, so it is a pure control channel and never a
// visible row. `summarySections` recomputes on every lens change (its `active` dependency), so the host learns a
// lens switch on the same cadence as any other evaluation.

/** The reserved section title — a NUL-prefixed sentinel no real System section title can collide with. */
export const ACTIVE_LENS_FEED_TITLE = '\x00sda.active-world-lens';

/** The reserved section carrying the active world id — appended to the posted summary when (and only when) a
 *  non-base world is the active lens. Consumed + stripped host-side; never rendered. */
export function activeLensFeedSection(activeId: string): SummarySection {
  return { title: ACTIVE_LENS_FEED_TITLE, rows: [{ label: 'active', value: activeId }] };
}

/** The active world id carried in `sections`, or undefined when none rides them (⇒ the base lens). */
export function readActiveLensFeed(sections: readonly SummarySection[]): string | undefined {
  const s = sections.find((x) => x.title === ACTIVE_LENS_FEED_TITLE);
  const v = s?.rows[0]?.value;
  return v !== undefined && v !== '' ? v : undefined;
}

/** `sections` with the reserved control section removed — what the System tree actually renders. Reference-equal
 *  when there is nothing to strip (the common no-worlds path), so a caller can skip a needless re-render. */
export function stripActiveLensFeed(sections: readonly SummarySection[]): readonly SummarySection[] {
  return sections.some((x) => x.title === ACTIVE_LENS_FEED_TITLE) ? sections.filter((x) => x.title !== ACTIVE_LENS_FEED_TITLE) : sections;
}
