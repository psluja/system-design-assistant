// First-run onboarding + responsive-layout persistence — the PURE logic behind, extracted so the
// decisions are unit-testable without a DOM (the app.tsx wiring only reads/writes localStorage and renders).

/** localStorage keys owned by this feature (namespaced under `sda.` like the rest of the app's flags). */
export const ONBOARDED_KEY = 'sda.onboarded';
export const INSP_OPEN_KEY = 'sda.inspOpen';

/** The seed design's identity — the four instance ids `makeStudio()` builds. "Untouched seed" = exactly these
 *  four nodes and nothing else, so a user who has started editing (added/removed a node) is never re-onboarded. */
export const SEED_IDS: readonly string[] = ['client', 'nginx', 'app', 'pg'];

/** The minimal view of the document the onboarding decision needs — the instance ids present on the canvas. */
export interface DocState {
  readonly instanceIds: readonly string[];
}

/** True when the canvas holds ONLY the untouched seed (same four ids, no more, no fewer) — or is empty. Any
 *  add/remove makes it false, so onboarding does not reappear over a design the user has begun shaping. */
export function isUntouchedSeedOrEmpty(doc: DocState): boolean {
  const ids = doc.instanceIds;
  if (ids.length === 0) return true;
  if (ids.length !== SEED_IDS.length) return false;
  const seed = new Set(SEED_IDS);
  return ids.every((id) => seed.has(id));
}

/** Show the "Start here" card ONLY on a genuine first run: the `sda.onboarded` flag is absent AND the canvas is
 *  still the untouched seed (or empty). Once dismissed (X or a real edit sets the flag) it never shows again. */
export function shouldShowOnboarding(onboardedFlag: string | null, doc: DocState): boolean {
  if (onboardedFlag !== null) return false; // already dismissed on this profile
  return isUntouchedSeedOrEmpty(doc);
}

/** The Inspector's initial open state on load. Honour a persisted choice first (the user's explicit last state,
 *  even at a narrow width — never fight them). With NO stored preference, auto-collapse ONCE on a narrow viewport
 *  (<1100px) so a fresh 1366px-or-narrower laptop opens with the canvas usable; otherwise default open. */
export function initialInspectorOpen(stored: string | null, viewportWidth: number): boolean {
  if (stored === '1') return true;
  if (stored === '0') return false;
  return viewportWidth >= 1100;
}
