import { deserialize } from '@sda/core';
import { isScenarioOverridable, type ScenarioOverride } from '@sda/content';

// Host-side reads of the ACTIVE WORLD off the DESIGN TEXT (vscode-free, pure) — the native-Inspector counterpart of
// ranges.ts / port-transforms.ts / slo-requirements.ts, which all read their data straight from the document (never
// the frozen webview feed). Given the active lens id (from lens-feed.ts) and the design text, these answer "what
// does this node's knob read in that world?" and "may a scenario override this knob?" — so the native Inspector shows
// the ACTIVE WORLD's value + provenance and routes an edit into that world, ONE FORM with the web shell.

/** The named world's overrides on `node`, keyed by config key — the world-scoped values the Inspector shows in place
 *  of the base config when a lens is on. Empty when the text is invalid, the world is undeclared, or the node has no
 *  override in it (each case ⇒ the knob reads its base value, honestly). */
export function worldOverridesFor(text: string, scenarioId: string, node: string): Map<string, ScenarioOverride> {
  const out = new Map<string, ScenarioOverride>();
  const parsed = deserialize(text);
  if (!parsed.ok) return out;
  const world = parsed.value.scenarios.find((s) => s.id === scenarioId);
  if (world === undefined) return out;
  for (const o of world.overrides) if (o.node === node) out.set(o.key, o);
  return out;
}

/** May a scenario override `(node, key)` in THIS design? — the SAME structural boundary the command core and the load
 *  validator use (a fact-assumption input, or a source client's throughput), so the native routing can never drift
 *  from what `setScenarioOverride` will accept. False on an invalid document (nothing routes into a world). */
export function knobOverridable(text: string, node: string, key: string): boolean {
  const parsed = deserialize(text);
  if (!parsed.ok) return false;
  return isScenarioOverridable(node, key, parsed.value.instances, parsed.value.wires);
}
