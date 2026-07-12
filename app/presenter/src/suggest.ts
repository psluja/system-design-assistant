import type { Studio } from '@sda/core';
import { whatFits, portsConnect, type Candidate } from '@sda/engine-solve';
import { protocolCompat, type Manifest } from '@sda/content';
import { ProtocolId, PortId, type Direction } from '@sda/engine-core';

// The "propose the next logical element" feature, powered by the engine's relational legality layer
// (DataScript whatFits), NOT the canvas library. For each OPEN port of the selected node we ask the
// engine which catalogue components would legally attach there (protocol-compatible), then offer to
// add + auto-wire one. Verify, don't guess: a suggestion is only shown if the protocols actually fit.
// Both the "what fits" filter and the port picker go through the ONE engine predicate, so they agree.
//
// PURE — depends only on @sda/core Studio + @sda/content + @sda/engine-{core,solve}; no React, no shell state.
// Lives in the presenter so the web Inspector's "Suggested next" and the VS Code suggester QuickPick offer the
// SAME set of components for the same open port — one legality answer, never two divergent suggesters. Moved
// from app/web/src/suggest.ts (which is now a re-export stub).

/** Flatten every catalogue port into a suggester candidate (component + direction + protocol lists).
 *  The `accepts` set is what lets the suggester offer a Lambda when wiring from an SQS/SNS out-port. */
export function buildCandidates(catalog: Readonly<Record<string, Manifest>>): Candidate[] {
  const out: Candidate[] = [];
  for (const m of Object.values(catalog)) {
    for (const p of m.ports) out.push({ component: m.type, dir: p.dir, ...(p.accepts ? { accepts: p.accepts.map(ProtocolId) } : {}), ...(p.speaks ? { speaks: p.speaks.map(ProtocolId) } : {}) });
  }
  return out;
}

/** A suggestion for one open port of the selected node: which components legally attach there. Carries the
 *  open port's protocol lists (speaks/accepts) so the port picker can wire using the SAME full-set rule;
 *  `protocol` is the port's NATURAL protocol (first of its list) for the UI chip. */
export interface Suggestion {
  readonly port: string;
  readonly dir: Direction;
  readonly protocol: string;
  readonly speaks?: readonly string[];
  readonly accepts?: readonly string[];
  readonly options: readonly string[];
}

/** Engine-backed suggestions for the open ports of `nodeId`. Empty when the design has build errors. */
export function suggestFor(
  studio: Studio,
  catalog: Readonly<Record<string, Manifest>>,
  candidates: readonly Candidate[],
  nodeId: string,
): Suggestion[] {
  const g = studio.graph();
  if (!g.ok) return [];
  const doc = studio.project();
  const inst = doc.instances.find((i) => i.id === nodeId);
  const man = inst ? catalog[inst.type] : undefined;
  if (!inst || !man) return [];

  const wired = new Set<string>();
  for (const w of doc.wires) {
    wired.add(`${w.from[0]}.${w.from[1]}`);
    wired.add(`${w.to[0]}.${w.to[1]}`);
  }

  const out: Suggestion[] = [];
  for (const p of man.ports) {
    const pid = `${nodeId}.${p.name}`;
    if (wired.has(pid)) continue; // only propose for currently-open ports
    const fits = whatFits(g.value, PortId(pid), [...candidates], protocolCompat);
    const options = [...new Set(fits.map((c) => c.component))].filter((t) => t !== inst.type);
    const natural = (p.dir === 'out' ? p.speaks?.[0] : p.accepts?.[0]) ?? p.accepts?.[0] ?? p.speaks?.[0] ?? '';
    if (options.length > 0) out.push({ port: p.name, dir: p.dir, protocol: natural, ...(p.speaks ? { speaks: p.speaks } : {}), ...(p.accepts ? { accepts: p.accepts } : {}), options });
  }
  return out;
}

/** The port on `type` that should receive a wire to/from the selected node's open port `from`. An OUT/bi open
 *  port feeds an IN/bi on the new node; an IN/bi open port is fed by an OUT/bi — matched with the SAME full
 *  emit/accept-set rule the suggester used (`portsConnect`), so the picked port is one that actually fits. */
export function matchingPort(catalog: Readonly<Record<string, Manifest>>, type: string, from: { dir: Direction; speaks?: readonly string[]; accepts?: readonly string[] }): string | undefined {
  const man = catalog[type];
  if (!man) return undefined;
  if (from.dir === 'out' || from.dir === 'bi') {
    const hit = man.ports.find((p) => (p.dir === 'in' || p.dir === 'bi') && portsConnect(from.speaks ?? [], p.accepts ?? [], protocolCompat));
    if (hit) return hit.name;
  }
  const back = man.ports.find((p) => (p.dir === 'out' || p.dir === 'bi') && portsConnect(p.speaks ?? [], from.accepts ?? [], protocolCompat));
  return back?.name;
}
