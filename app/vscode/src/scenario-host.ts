import { Studio, deserialize, serialize } from '@sda/core';
import { registry, allManifests, computeEnvelope, deriveDefaultScenarios, resetScenario, type AssumptionScenario } from '@sda/content';
// Same relative reach as compare-host.ts / solver-host.ts: the composition ROOT is a pure module, but @sda/mcp's
// index runs the stdio server on import, so we reach the binder directly. `bindSolvers` gives the native in-process
// solver the reset's capacity-envelope derivation needs (the SAME binding Improve + Compare use — one seam).
import { bindSolvers } from '../../mcp/src/composition';

// RESET-A-WORLD host (assumption-model §5.3 — "reset means reset"). Entirely HOST-side, mirroring compare-host.ts: a
// throwaway Studio from the current document text, the content-shared reset semantics, and a re-serialized document
// the command applies as one native-undo WorkspaceEdit. The reset is the NON-preserving twin of derive/✨ — a
// derived-trio world is wiped to its freshly-derived values (frozen edits dropped), a custom world clears to base.
// Never throws: every failure resolves to an honest outcome the command renders.

/** The outcome of a world reset: the new document text + a guided note (trio reset vs custom clear), or an honest reason. */
export type ResetResult = { readonly ok: true; readonly text: string; readonly note: string } | { readonly ok: false; readonly error: string };

/**
 * Reset the named world `id` against the current project text. A DERIVED-TRIO world is reset to a freshly-derived trio
 * (offered demand re-sized off THIS design's capacity envelope — the same derivation ✨/derive_scenarios use, so the
 * reset value is honest, never invented); a CUSTOM world simply clears its overrides. The class-blind envelope is
 * unavailable under declared request classes (and needs the bound solver) — there a trio id has no fresh derivation,
 * so `resetScenario` clears it to base, the honest fallback. Returns the re-serialized document + a note.
 */
export async function runResetScenario(projectJson: string, id: string): Promise<ResetResult> {
  try {
    const parsed = deserialize(projectJson);
    if (!parsed.ok) return { ok: false, error: `the design failed to parse: ${parsed.error}` };
    const doc = parsed.value;
    if (!doc.scenarios.some((s) => s.id === id)) return { ok: false, error: `no named world "${id}" in the design` };

    // A fresh, isolated Studio per request (the canvas owns the live document). Derive a fresh trio to reset a trio
    // world to; a custom world needs none, so a missing solver / request-classes design is not fatal (it clears to base).
    const studio = new Studio(registry, allManifests);
    studio.load(doc);
    let fresh: readonly AssumptionScenario[] = [];
    const solvers = bindSolvers(registry);
    if (doc.requestClasses.length === 0 && solvers.optimize !== undefined) {
      const catalog = studio.mergedCatalog();
      const envelope = await computeEnvelope({ instances: doc.instances, wires: doc.wires, registry, catalog }, solvers.optimize);
      fresh = deriveDefaultScenarios({ instances: doc.instances, wires: doc.wires, catalog, envelope }).scenarios;
    }

    const reset = resetScenario(doc.scenarios, fresh, id);
    if (reset === undefined) return { ok: false, error: `could not reset "${id}"` };

    // Replace the world in place through the SAME @sda/core command the canvas dispatches (`declareScenario`), so the
    // reset is one document, one native undo, and identical to every other shell.
    const applied = studio.dispatch({ kind: 'declareScenario', decl: reset });
    if (!applied.ok) return { ok: false, error: applied.error };

    const wasTrio = fresh.some((f) => f.id === id);
    const note = wasTrio
      ? `reset "${id}" to its freshly-derived values — any frozen edits were dropped; it re-tracks the capacity envelope.`
      : `cleared "${id}"'s overrides — it falls back to the base design.`;
    return { ok: true, text: serialize(studio.project()), note };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
