import type { Studio } from '@sda/core';
import type { Manifest } from '@sda/content';
import { buildCandidates, suggestFor, matchingPort } from './suggest';

// The QUICK-ADD PICKER contract, shared by every shell (TASK-63 "canvas smoothness"). The n8n-grade creation
// flow — drop a connection on empty canvas / press N / click a ghost CTA — always goes through THESE two
// functions, so the web popover and the VS Code QuickPick offer the identical, LEGALITY-FILTERED options and
// wire the pick identically. Shells own only presentation and the drop coordinates.

/** One offerable component in the picker. */
export interface PickerOption {
  readonly type: string; // the manifest type id (what the user picks)
  readonly kind: string; // the family prefix ('compute', 'db', …) — for grouping/icons
}

const kindOf = (type: string): string => (type.includes('.') ? type.slice(0, type.indexOf('.')) : type);

/**
 * The options a picker may offer. With a PORT CONTEXT (a wire dropped from `node.port`), only the component
 * types that LEGALLY attach to that port (the engine's whatFits — the same predicate the canvas drag-check
 * uses, so the picker can never offer a connection the drop would then refuse). Without context (empty-canvas
 * CTA / the N key), the whole catalog, sorted for scanability. Unknown node/port ⇒ empty list — honest.
 */
export function pickerOptions(
  studio: Studio,
  catalog: Readonly<Record<string, Manifest>>,
  context?: { readonly node: string; readonly port: string },
): PickerOption[] {
  if (context === undefined) {
    return Object.keys(catalog).sort().map((type) => ({ type, kind: kindOf(type) }));
  }
  const suggestions = suggestFor(studio, catalog, buildCandidates(catalog), context.node);
  const forPort = suggestions.find((s) => s.port === context.port);
  return (forPort?.options ?? []).map((type) => ({ type, kind: kindOf(type) }));
}

/** The first free id with the kind prefix (`db1`, `db2`, …) — the same minting rule the web shell has always used. */
export function mintId(studio: Studio, kind: string): string {
  const used = new Set(studio.project().instances.map((i) => i.id));
  let n = 1;
  while (used.has(`${kind}${n}`)) n += 1;
  return `${kind}${n}`;
}

/**
 * Place a picked component at (x, y) and — when a port context is given — wire it to that port with the SAME
 * full accept/speak-set rule the suggester used (`matchingPort`), in the right direction (an OUT context feeds
 * the new node's in-port; an IN context is fed by the new node's out-port). Returns the new node id, or the
 * dispatch error verbatim (the tool must not lie about why an add was refused).
 */
export function addPickedComponent(
  studio: Studio,
  catalog: Readonly<Record<string, Manifest>>,
  type: string,
  pos: { readonly x: number; readonly y: number },
  context?: { readonly node: string; readonly port: string },
): { readonly ok: true; readonly id: string } | { readonly ok: false; readonly error: string } {
  const id = mintId(studio, kindOf(type));
  // ONE atomic batch (add + wire): a Studio batch emits a SINGLE change event, so a document-backed shell
  // posts ONE docChanged. Two separate dispatches raced in the VS Code shell — two rapid whole-document
  // applies could land out of order and the wireless snapshot won, so the fresh connection "flashed" on the
  // canvas and vanished when the stale text came back as docExternal. Atomicity also gives one-undo-per-add.
  const cmds: Parameters<Studio['dispatchBatch']>[0][number][] = [{ kind: 'addComponent', id, type, x: pos.x, y: pos.y }];
  if (context !== undefined) {
    const fromType = studio.project().instances.find((i) => i.id === context.node)?.type ?? '';
    const fromPortDef = catalog[fromType]?.ports.find((p) => p.name === context.port);
    if (fromPortDef !== undefined) {
      const target = matchingPort(catalog, type, fromPortDef);
      const outward = fromPortDef.dir === 'out' || fromPortDef.dir === 'bi';
      if (target !== undefined) {
        cmds.push(
          outward
            ? { kind: 'connect', from: [context.node, context.port], to: [id, target] }
            : { kind: 'connect', from: [id, target], to: [context.node, context.port] },
        );
      }
    }
  }
  const result = studio.dispatchBatch(cmds);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, id };
}
