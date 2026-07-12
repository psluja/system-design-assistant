import { type Band, type Key, type Result, type Transform, err, ok } from '@sda/engine-core';
import { SYSTEM_PROMISE_KEYS, classDeclProblems, isSystemPromiseKey, overrideRoleProblem, scenarioProblems, type AssumptionScenario, type GuaranteeSlo, type Instance, type LagSlo, type Manifest, type ManifestBand, type Range, type RequestClassDecl, type ScenarioOverride, type SystemPromise, type Wire, type WireRef } from '@sda/content';
import type { Group, ProjectDoc } from './document';

/** A transform as an event-summary token: the five reshaping kinds read `kind(value)`; a generator reads its
 * level (+ whether cycles ride it) — `generate` carries no scalar `value`. */
const transformLabel = (t: Transform): string => (t.kind === 'generate' ? `generate(${t.level}${t.cycles !== undefined ? ' req/s, cycles' : ' req/s'})` : `${t.kind}(${t.value})`);

/**
 * The command surface — the one way to change a design. Every client (MCP, UI, WebMCP)
 * issues these; `apply` is a pure reducer returning the next document plus a change event, or an error.
 */
export type Command =
  | { readonly kind: 'addComponent'; readonly id: string; readonly type: string; readonly x?: number; readonly y?: number }
  | { readonly kind: 'removeNode'; readonly id: string }
  | { readonly kind: 'move'; readonly id: string; readonly x: number; readonly y: number }
  | { readonly kind: 'renameNode'; readonly id: string; readonly to: string }
  | { readonly kind: 'setLabel'; readonly id: string; readonly label: string }
  | { readonly kind: 'setDescription'; readonly id: string; readonly description: string }
  | { readonly kind: 'duplicateNode'; readonly id: string; readonly newId: string; readonly dx: number; readonly dy: number }
  | { readonly kind: 'setWireSemantics'; readonly from: readonly [string, string]; readonly to: readonly [string, string]; readonly semantics: 'sync' | 'async' }
  | { readonly kind: 'connect'; readonly from: readonly [string, string]; readonly to: readonly [string, string]; readonly semantics?: 'sync' | 'async' }
  | { readonly kind: 'disconnect'; readonly from: readonly [string, string]; readonly to: readonly [string, string] }
  | { readonly kind: 'setConfig'; readonly node: string; readonly key: string; readonly value: number }
  | { readonly kind: 'setRange'; readonly node: string; readonly key: string; readonly range: Range }
  | { readonly kind: 'clearRange'; readonly node: string; readonly key: string }
  | { readonly kind: 'setTransform'; readonly node: string; readonly port: string; readonly transform: Transform | null }
  | { readonly kind: 'setWireTransform'; readonly from: readonly [string, string]; readonly to: readonly [string, string]; readonly transform: Transform | null }
  | { readonly kind: 'setType'; readonly id: string; readonly type: string }
  | { readonly kind: 'setSLO'; readonly node: string; readonly key: Key; readonly band: Band }
  | { readonly kind: 'clearSLO'; readonly node: string; readonly key: Key }
  | { readonly kind: 'setGuaranteeSlo'; readonly slo: GuaranteeSlo }
  | { readonly kind: 'clearGuaranteeSlo'; readonly source: string; readonly terminal: string; readonly dimension: string }
  | { readonly kind: 'setLagSlo'; readonly slo: LagSlo }
  | { readonly kind: 'clearLagSlo'; readonly source: string; readonly terminal: string }
  // SYSTEM-scoped promises (owner ruling: cost is for THE WHOLE SYSTEM) — a band on a whole-design quantity, in the
  // top-level `doc.systemPromises` container (never a node band). Keyed by registry key: ONE promise per key,
  // replace-in-place (the setSLO discipline). No node/flow reference ⇒ renameNode never touches it.
  | { readonly kind: 'setSystemPromise'; readonly promise: SystemPromise }
  | { readonly kind: 'clearSystemPromise'; readonly key: string }
  | { readonly kind: 'rename'; readonly name: string }
  | { readonly kind: 'addGroup'; readonly id: string; readonly label: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  | { readonly kind: 'renameGroup'; readonly id: string; readonly label: string }
  | { readonly kind: 'removeGroup'; readonly id: string }
  | { readonly kind: 'moveGroup'; readonly id: string; readonly x: number; readonly y: number }
  | { readonly kind: 'resizeGroup'; readonly id: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  | { readonly kind: 'assignGroup'; readonly node: string; readonly group: string | null }
  | { readonly kind: 'defineComponent'; readonly manifest: Manifest }
  | { readonly kind: 'removeComponentDef'; readonly type: string }
  // REQUEST CLASSES — declare/edit the named multi-commodity flows over the topology.
  // `declareClass` creates OR replaces a whole class by id (the replace-in-place discipline of defineComponent/
  // setSLO); the others edit one facet. Membership + origins are validated structurally at declare/edit time (a
  // class names EXISTING wires/nodes — the commodity is structural, unlike a soft lag/guarantee endpoint).
  | { readonly kind: 'declareClass'; readonly decl: RequestClassDecl }
  | { readonly kind: 'removeClass'; readonly id: string }
  | { readonly kind: 'setClassMembership'; readonly class: string; readonly from: readonly [string, string]; readonly to: readonly [string, string]; readonly member: boolean }
  | { readonly kind: 'setClassOrigin'; readonly class: string; readonly node: string; readonly rps: number | null }
  // NAMED WORLDS — declare/edit the scenarios (points in the assumption space).
  // `declareScenario` creates OR replaces a whole world by id (the replace-in-place discipline of declareClass/
  // setSLO); `renameScenario` sets its friendly name; the override commands edit one fact-assumption value. The role
  // boundary (only fact-assumption keys are overridable) is enforced here with a guided error — a scenario can never
  // silently retune a limit or loosen a promise.
  | { readonly kind: 'declareScenario'; readonly decl: AssumptionScenario }
  | { readonly kind: 'removeScenario'; readonly id: string }
  | { readonly kind: 'renameScenario'; readonly id: string; readonly name: string }
  | { readonly kind: 'setScenarioOverride'; readonly scenario: string; readonly node: string; readonly key: string; readonly value: number }
  | { readonly kind: 'clearScenarioOverride'; readonly scenario: string; readonly node: string; readonly key: string };

export interface ChangeEvent {
  readonly summary: string;
}
export interface Applied {
  readonly doc: ProjectDoc;
  readonly event: ChangeEvent;
}

/** Same wire? A class's membership ref matches a wire by its (from, to) port endpoints — the de-facto unique wire
 *  key, so class membership survives wire reordering (and, with the rewrites below, node renames). */
const sameWireRef = (r: WireRef, from: readonly [string, string], to: readonly [string, string]): boolean =>
  r.from[0] === from[0] && r.from[1] === from[1] && r.to[0] === to[0] && r.to[1] === to[1];

/** Pure reducer: validate the command against the document + known component types, return next state. */
export function apply(doc: ProjectDoc, cmd: Command, knownTypes: ReadonlySet<string>): Result<Applied, string> {
  const has = (id: string): boolean => doc.instances.some((i) => i.id === id);
  const replaceInstance = (id: string, next: Instance): readonly Instance[] => doc.instances.map((i) => (i.id === id ? next : i));

  switch (cmd.kind) {
    case 'rename':
      return ok({ doc: { ...doc, name: cmd.name }, event: { summary: `renamed to "${cmd.name}"` } });

    case 'addComponent': {
      if (has(cmd.id)) return err(`node "${cmd.id}" already exists`);
      if (!knownTypes.has(cmd.type)) return err(`unknown component type "${cmd.type}"`);
      const inst: Instance = { id: cmd.id, type: cmd.type };
      return ok({
        doc: { ...doc, instances: [...doc.instances, inst], layout: { ...doc.layout, [cmd.id]: { x: cmd.x ?? 0, y: cmd.y ?? 0 } } },
        event: { summary: `added ${cmd.type} as "${cmd.id}"` },
      });
    }

    case 'move': {
      if (!has(cmd.id)) return err(`node "${cmd.id}" not found`);
      return ok({ doc: { ...doc, layout: { ...doc.layout, [cmd.id]: { x: cmd.x, y: cmd.y } } }, event: { summary: `moved "${cmd.id}"` } });
    }

    case 'renameNode': {
      // The id IS the component's name in the design, so renaming rewrites every reference (wires,
      // layout, group membership) — keeping the document consistent under one identifier.
      const to = cmd.to.trim();
      if (!has(cmd.id)) return err(`node "${cmd.id}" not found`);
      if (to === '') return err('name cannot be empty');
      if (to === cmd.id) return ok({ doc, event: { summary: 'name unchanged' } });
      if (has(to)) return err(`a component named "${to}" already exists`);
      const instances = doc.instances.map((i) => (i.id === cmd.id ? { ...i, id: to } : i));
      const wires = doc.wires.map((w) => ({
        ...w,
        from: (w.from[0] === cmd.id ? [to, w.from[1]] : w.from) as readonly [string, string],
        to: (w.to[0] === cmd.id ? [to, w.to[1]] : w.to) as readonly [string, string],
      }));
      const layout = Object.fromEntries(Object.entries(doc.layout).map(([k, v]) => [k === cmd.id ? to : k, v]));
      const labels = Object.fromEntries(Object.entries(doc.labels).map(([k, v]) => [k === cmd.id ? to : k, v]));
      const descriptions = Object.fromEntries(Object.entries(doc.descriptions).map(([k, v]) => [k === cmd.id ? to : k, v]));
      const groups = doc.groups.map((g) => (g.members.includes(cmd.id) ? { ...g, members: g.members.map((m) => (m === cmd.id ? to : m)) } : g));
      // Guarantee requirements are keyed by (source, terminal) node ids — rewrite them too, so a rename keeps a
      // flow requirement pointing at the same flow instead of dangling into an honest-but-avoidable `unknown`.
      const guaranteeSlos = (doc.guaranteeSlos ?? []).map((s) => ({
        ...s,
        ...(s.source === cmd.id ? { source: to } : {}),
        ...(s.terminal === cmd.id ? { terminal: to } : {}),
      }));
      // Lag requirements are keyed by (source, terminal) too — rewrite them with the
      // same rule so a rename never orphans a declared propagation deadline.
      const lagSlos = (doc.lagSlos ?? []).map((s) => ({
        ...s,
        ...(s.source === cmd.id ? { source: to } : {}),
        ...(s.terminal === cmd.id ? { terminal: to } : {}),
      }));
      // Request classes reference the node by its ORIGINS (node ids) and its wire MEMBERSHIP (wire refs carry the
      // node id on each endpoint) — rewrite both, so a rename keeps a class naming the same commodity instead of
      // dangling its membership into a build error.
      const requestClasses = (doc.requestClasses ?? []).map((c) => ({
        ...c,
        wires: c.wires.map((r) => ({
          from: (r.from[0] === cmd.id ? [to, r.from[1]] : r.from) as readonly [string, string],
          to: (r.to[0] === cmd.id ? [to, r.to[1]] : r.to) as readonly [string, string],
        })),
        origins: c.origins.map((o) => (o.node === cmd.id ? { ...o, node: to } : o)),
      }));
      // Named worlds reference the node by their override endpoints (node id) — rewrite them too, so a rename keeps a
      // world overriding the same node instead of dangling its override into an honest-but-avoidable skip (§4.2).
      const scenarios = (doc.scenarios ?? []).map((s) => ({
        ...s,
        overrides: s.overrides.map((o) => (o.node === cmd.id ? { ...o, node: to } : o)),
      }));
      return ok({ doc: { ...doc, instances, wires, layout, labels, descriptions, groups, guaranteeSlos, lagSlos, requestClasses, scenarios }, event: { summary: `renamed "${cmd.id}" → "${to}"` } });
    }

    case 'setLabel': {
      // The friendly display name (the id stays the stable unique identifier). Empty clears the override.
      if (!has(cmd.id)) return err(`node "${cmd.id}" not found`);
      const label = cmd.label.trim();
      const labels = { ...doc.labels };
      if (label === '') delete labels[cmd.id];
      else labels[cmd.id] = label;
      return ok({ doc: { ...doc, labels }, event: { summary: `named "${cmd.id}" → "${label || cmd.id}"` } });
    }

    case 'setDescription': {
      // A one-line description of what this component is FOR in the design (the id stays the identifier,
      // the label stays the display name). Empty clears it.
      if (!has(cmd.id)) return err(`node "${cmd.id}" not found`);
      const description = cmd.description.trim();
      const descriptions = { ...doc.descriptions };
      if (description === '') delete descriptions[cmd.id];
      else descriptions[cmd.id] = description;
      return ok({ doc: { ...doc, descriptions }, event: { summary: `described "${cmd.id}"` } });
    }

    case 'duplicateNode': {
      const inst = doc.instances.find((i) => i.id === cmd.id);
      if (inst === undefined) return err(`node "${cmd.id}" not found`);
      if (has(cmd.newId)) return err(`node "${cmd.newId}" already exists`);
      const copy: Instance = { ...inst, id: cmd.newId }; // copies type + config + SLO bands; wires are not copied
      const pos = doc.layout[cmd.id] ?? { x: 0, y: 0 };
      const layout = { ...doc.layout, [cmd.newId]: { x: pos.x + cmd.dx, y: pos.y + cmd.dy } };
      const labels = { ...doc.labels, [cmd.newId]: `${doc.labels[cmd.id] ?? cmd.id} copy` };
      const descriptions = doc.descriptions[cmd.id] !== undefined ? { ...doc.descriptions, [cmd.newId]: doc.descriptions[cmd.id] as string } : doc.descriptions;
      return ok({ doc: { ...doc, instances: [...doc.instances, copy], layout, labels, descriptions }, event: { summary: `duplicated "${cmd.id}"` } });
    }

    case 'setWireSemantics': {
      let found = false;
      const wires = doc.wires.map((w) => {
        if (w.from[0] === cmd.from[0] && w.from[1] === cmd.from[1] && w.to[0] === cmd.to[0] && w.to[1] === cmd.to[1]) {
          found = true;
          return { ...w, semantics: cmd.semantics };
        }
        return w;
      });
      if (!found) return err('no such wire');
      return ok({ doc: { ...doc, wires }, event: { summary: `${cmd.from[0]} → ${cmd.to[0]} is ${cmd.semantics}` } });
    }

    case 'removeNode': {
      if (!has(cmd.id)) return err(`node "${cmd.id}" not found`);
      const layout = Object.fromEntries(Object.entries(doc.layout).filter(([k]) => k !== cmd.id));
      const labels = Object.fromEntries(Object.entries(doc.labels).filter(([k]) => k !== cmd.id));
      const descriptions = Object.fromEntries(Object.entries(doc.descriptions).filter(([k]) => k !== cmd.id));
      return ok({
        doc: {
          ...doc,
          instances: doc.instances.filter((i) => i.id !== cmd.id),
          wires: doc.wires.filter((w) => w.from[0] !== cmd.id && w.to[0] !== cmd.id),
          layout,
          labels,
          descriptions,
          groups: doc.groups.map((g) => (g.members.includes(cmd.id) ? { ...g, members: g.members.filter((m) => m !== cmd.id) } : g)),
          // A removed node can no longer be a class origin or sit on a class's wire — prune both so the class does
          // not dangle into a build error (its wires go with the node; drop the membership refs too).
          requestClasses: (doc.requestClasses ?? []).map((c) => ({
            ...c,
            wires: c.wires.filter((r) => r.from[0] !== cmd.id && r.to[0] !== cmd.id),
            origins: c.origins.filter((o) => o.node !== cmd.id),
          })),
        },
        event: { summary: `removed "${cmd.id}"` },
      });
    }

    case 'connect': {
      if (!has(cmd.from[0])) return err(`node "${cmd.from[0]}" not found`);
      if (!has(cmd.to[0])) return err(`node "${cmd.to[0]}" not found`);
      const wire: Wire = { from: cmd.from, to: cmd.to, semantics: cmd.semantics ?? 'sync' };
      return ok({ doc: { ...doc, wires: [...doc.wires, wire] }, event: { summary: `connected ${cmd.from[0]} → ${cmd.to[0]}` } });
    }

    case 'disconnect': {
      const wires = doc.wires.filter(
        (w) => !(w.from[0] === cmd.from[0] && w.from[1] === cmd.from[1] && w.to[0] === cmd.to[0] && w.to[1] === cmd.to[1]),
      );
      if (wires.length === doc.wires.length) return err('no such wire');
      // A disconnected wire leaves every class that claimed it — otherwise the class's membership ref would dangle
      // to a wire the design no longer draws (a build error). Membership is a set of EXISTING wires.
      const requestClasses = (doc.requestClasses ?? []).map((c) => ({ ...c, wires: c.wires.filter((r) => !sameWireRef(r, cmd.from, cmd.to)) }));
      return ok({ doc: { ...doc, wires, requestClasses }, event: { summary: `disconnected ${cmd.from[0]} → ${cmd.to[0]}` } });
    }

    case 'setConfig': {
      const inst = doc.instances.find((i) => i.id === cmd.node);
      if (inst === undefined) return err(`node "${cmd.node}" not found`);
      const next: Instance = { ...inst, config: { ...(inst.config ?? {}), [cmd.key]: cmd.value } };
      return ok({ doc: { ...doc, instances: replaceInstance(cmd.node, next) }, event: { summary: `${cmd.node}.${cmd.key} = ${cmd.value}` } });
    }

    case 'setRange': {
      // A per-instance uncertainty RANGE on a config key — the additive, undoable
      // twin of setConfig, keyed by CONFIG KEY exactly as `config` is. Setting again on the same key REPLACES it (one
      // range per config value). Range SANITY (lo ≤ hi, mode in [lo,hi]) is validated at instantiate time — an
      // unsound range surfaces there as an honest build error — so the reducer only edits the document.
      const inst = doc.instances.find((i) => i.id === cmd.node);
      if (inst === undefined) return err(`node "${cmd.node}" not found`);
      const next: Instance = { ...inst, ranges: { ...(inst.ranges ?? {}), [cmd.key]: cmd.range } };
      return ok({ doc: { ...doc, instances: replaceInstance(cmd.node, next) }, event: { summary: `range set on ${cmd.node}.${cmd.key}` } });
    }

    case 'clearRange': {
      // Remove a range from a config key. We DROP the `ranges` field entirely when the last range goes (never a
      // `"ranges": {}` artifact) so a cleared node serializes byte-identically to one that never had a range.
      const inst = doc.instances.find((i) => i.id === cmd.node);
      if (inst === undefined) return err(`node "${cmd.node}" not found`);
      if (inst.ranges?.[cmd.key] === undefined) return err(`no range on ${cmd.node}.${cmd.key}`);
      const ranges = { ...inst.ranges };
      delete ranges[cmd.key];
      let next: Instance;
      if (Object.keys(ranges).length > 0) next = { ...inst, ranges };
      else {
        const { ranges: _drop, ...rest } = inst; // drop the field entirely — no `"ranges": {}` artifact on disk
        next = rest;
      }
      return ok({ doc: { ...doc, instances: replaceInstance(cmd.node, next) }, event: { summary: `range cleared on ${cmd.node}.${cmd.key}` } });
    }

    case 'setTransform': {
      // A per-instance PORT TRANSFORM override, by port NAME — the additive, undoable
      // twin of setConfig. `null` clears the override (the port falls back to its manifest default / identity).
      // Port EXISTENCE is validated at instantiate time (an unknown port surfaces as a build error there), so the
      // reducer only edits the document — the same shape as every other additive per-instance field.
      const inst = doc.instances.find((i) => i.id === cmd.node);
      if (inst === undefined) return err(`node "${cmd.node}" not found`);
      const transforms = { ...(inst.transforms ?? {}) };
      if (cmd.transform === null) delete transforms[cmd.port];
      else transforms[cmd.port] = cmd.transform;
      const next: Instance = { ...inst, transforms };
      return ok({
        doc: { ...doc, instances: replaceInstance(cmd.node, next) },
        event: { summary: cmd.transform === null ? `cleared transform on ${cmd.node}.${cmd.port}` : `${cmd.node}.${cmd.port} = ${transformLabel(cmd.transform)}` },
      });
    }

    case 'setWireTransform': {
      // A per-WIRE OUT-side transform override — the routing-split twin of
      // setTransform, addressed by the SAME from/to port tuple `setWireSemantics`/`disconnect` use (the stable wire
      // key). It WINS over the source out-port's transform for THIS wire, so one out port can feed several wires
      // with different shares. `null` CLEARS the override, and we DROP the `transform` field entirely (never a
      // `"transform": null` artifact) so a cleared wire serializes byte-identically to one that never had one.
      // A GENERATOR is a PORT function in R1 — refused here with the fix named, before the
      // build would refuse it structurally (generate-on-edge).
      if (cmd.transform !== null && cmd.transform.kind === 'generate') return err('a generator is a PORT function — set it on the source OUT port (setTransform), not on a wire');
      let found = false;
      const wires = doc.wires.map((w) => {
        if (w.from[0] === cmd.from[0] && w.from[1] === cmd.from[1] && w.to[0] === cmd.to[0] && w.to[1] === cmd.to[1]) {
          found = true;
          if (cmd.transform === null) {
            const { transform: _drop, ...rest } = w;
            return rest;
          }
          return { ...w, transform: cmd.transform };
        }
        return w;
      });
      if (!found) return err('no such wire');
      return ok({
        doc: { ...doc, wires },
        event: {
          summary:
            cmd.transform === null
              ? `cleared transform on ${cmd.from[0]} → ${cmd.to[0]}`
              : `${cmd.from[0]} → ${cmd.to[0]} = ${transformLabel(cmd.transform)}`,
        },
      });
    }

    case 'setType': {
      // Swap a node's component type in place: keep id (so wires/groups/labels survive) and its SLO bands,
      // but DROP capacity config — the new service has its own knobs (re-size with repair/optimize).
      const inst = doc.instances.find((i) => i.id === cmd.id);
      if (inst === undefined) return err(`node "${cmd.id}" not found`);
      if (!knownTypes.has(cmd.type)) return err(`unknown component type "${cmd.type}"`);
      const next: Instance = { id: inst.id, type: cmd.type, ...(inst.bands !== undefined ? { bands: inst.bands } : {}) };
      return ok({ doc: { ...doc, instances: replaceInstance(cmd.id, next) }, event: { summary: `${cmd.id} → ${cmd.type}` } });
    }

    case 'setSLO': {
      const inst = doc.instances.find((i) => i.id === cmd.node);
      if (inst === undefined) return err(`node "${cmd.node}" not found`);
      const band: ManifestBand = { key: cmd.key, band: cmd.band };
      const next: Instance = { ...inst, bands: [...(inst.bands ?? []).filter((b) => b.key !== cmd.key), band] };
      return ok({ doc: { ...doc, instances: replaceInstance(cmd.node, next) }, event: { summary: `SLO set on ${cmd.node}.${cmd.key}` } });
    }

    case 'clearSLO': {
      const inst = doc.instances.find((i) => i.id === cmd.node);
      if (inst === undefined) return err(`node "${cmd.node}" not found`);
      const next: Instance = { ...inst, bands: (inst.bands ?? []).filter((b) => b.key !== cmd.key) };
      return ok({ doc: { ...doc, instances: replaceInstance(cmd.node, next) }, event: { summary: `SLO cleared on ${cmd.node}.${cmd.key}` } });
    }

    case 'setGuaranteeSlo': {
      // A per-FLOW guarantee requirement. Keyed by (source, terminal, dimension):
      // ONE requirement per flow per dimension, so setting again on the same triple replaces it (the same
      // replace-in-place discipline as setSLO). Endpoint EXISTENCE is not enforced here: a flow is derived, and a
      // requirement whose (source, terminal) does not (yet) name a real flow is reported honestly as `unknown` at
      // evaluate time — never silently dropped, so an out-of-order authoring (declare then wire) is legal.
      const { source, terminal, dimension } = cmd.slo;
      const guaranteeSlos = [
        ...(doc.guaranteeSlos ?? []).filter((s) => !(s.source === source && s.terminal === terminal && s.dimension === dimension)),
        cmd.slo,
      ];
      return ok({ doc: { ...doc, guaranteeSlos }, event: { summary: `guarantee ${dimension} ≥ ${cmd.slo.atLeast} on ${source} → ${terminal}` } });
    }

    case 'clearGuaranteeSlo': {
      const before = (doc.guaranteeSlos ?? []).length;
      const guaranteeSlos = (doc.guaranteeSlos ?? []).filter(
        (s) => !(s.source === cmd.source && s.terminal === cmd.terminal && s.dimension === cmd.dimension),
      );
      if (guaranteeSlos.length === before) return err(`no guarantee requirement ${cmd.dimension} on ${cmd.source} → ${cmd.terminal}`);
      return ok({ doc: { ...doc, guaranteeSlos }, event: { summary: `cleared guarantee ${cmd.dimension} on ${cmd.source} → ${cmd.terminal}` } });
    }

    case 'setLagSlo': {
      // A per-FLOW propagation-lag requirement. Keyed by (source, terminal): ONE lag
      // deadline per flow, so setting again on the same pair replaces it (the replace-in-place discipline setSLO /
      // setGuaranteeSlo use). Endpoint EXISTENCE is not enforced here — a lag requirement whose (source, terminal)
      // does not (yet) name a real flow is reported honestly as `unknown` at evaluate time, never silently dropped,
      // so declare-then-wire authoring is legal (exactly as for the guarantee SLO).
      const { source, terminal } = cmd.slo;
      const lagSlos = [
        ...(doc.lagSlos ?? []).filter((s) => !(s.source === source && s.terminal === terminal)),
        cmd.slo,
      ];
      return ok({ doc: { ...doc, lagSlos }, event: { summary: `lag ≤ ${cmd.slo.maxMs} ms on ${source} → ${terminal}` } });
    }

    case 'clearLagSlo': {
      const before = (doc.lagSlos ?? []).length;
      const lagSlos = (doc.lagSlos ?? []).filter((s) => !(s.source === cmd.source && s.terminal === cmd.terminal));
      if (lagSlos.length === before) return err(`no lag requirement on ${cmd.source} → ${cmd.terminal}`);
      return ok({ doc: { ...doc, lagSlos }, event: { summary: `cleared lag on ${cmd.source} → ${cmd.terminal}` } });
    }

    case 'setSystemPromise': {
      // A SYSTEM-scoped promise (owner ruling): a band on a whole-design quantity, keyed by registry key — ONE per
      // key, so setting again on the same key replaces it (the setSLO discipline). The v1 vocabulary boundary is
      // enforced HERE with a guided error (the scenarioProblems pattern): a key the judge does not cover would sit
      // as a permanent `unknown`, so refusing with the covered set is the honest, self-correcting move. A flow/node
      // quantity (latency, throughput…) names its own fix — declare it on a node or a flow, where it is judged.
      const { key } = cmd.promise;
      if (!isSystemPromiseKey(key)) {
        return err(`"${key}" is not a system-scoped quantity — system promises cover [${SYSTEM_PROMISE_KEYS.join(', ')}]; a per-node/flow quantity belongs on a node (setSLO) or a flow`);
      }
      const systemPromises = [...(doc.systemPromises ?? []).filter((p) => p.key !== key), cmd.promise];
      const b = cmd.promise.band;
      const bound = b.shape === 'minTargetMax' ? (b.max !== undefined ? `≤ ${b.max}` : b.min !== undefined ? `≥ ${b.min}` : `target ${b.target ?? '—'}`) : b.shape;
      return ok({ doc: { ...doc, systemPromises }, event: { summary: `system promise set — ${key} ${bound} (whole system)` } });
    }

    case 'clearSystemPromise': {
      const before = (doc.systemPromises ?? []).length;
      const systemPromises = (doc.systemPromises ?? []).filter((p) => p.key !== cmd.key);
      if (systemPromises.length === before) return err(`no system promise on ${cmd.key}`);
      return ok({ doc: { ...doc, systemPromises }, event: { summary: `cleared the system ${cmd.key} promise` } });
    }

    case 'addGroup': {
      if (doc.groups.some((g) => g.id === cmd.id)) return err(`group "${cmd.id}" already exists`);
      const group: Group = { id: cmd.id, label: cmd.label, rect: { x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h }, members: [] };
      return ok({ doc: { ...doc, groups: [...doc.groups, group] }, event: { summary: `added group "${cmd.label}"` } });
    }

    case 'renameGroup': {
      if (!doc.groups.some((g) => g.id === cmd.id)) return err(`group "${cmd.id}" not found`);
      return ok({
        doc: { ...doc, groups: doc.groups.map((g) => (g.id === cmd.id ? { ...g, label: cmd.label } : g)) },
        event: { summary: `renamed group to "${cmd.label}"` },
      });
    }

    case 'removeGroup': {
      if (!doc.groups.some((g) => g.id === cmd.id)) return err(`group "${cmd.id}" not found`);
      // Removing a group ungroups its members; their positions and the components themselves are kept.
      return ok({ doc: { ...doc, groups: doc.groups.filter((g) => g.id !== cmd.id) }, event: { summary: `removed group "${cmd.id}"` } });
    }

    case 'moveGroup': {
      const g = doc.groups.find((x) => x.id === cmd.id);
      if (g === undefined) return err(`group "${cmd.id}" not found`);
      const dx = cmd.x - g.rect.x;
      const dy = cmd.y - g.rect.y;
      const groups = doc.groups.map((x) => (x.id === cmd.id ? { ...x, rect: { ...x.rect, x: cmd.x, y: cmd.y } } : x));
      const layout = { ...doc.layout };
      for (const m of g.members) {
        const p = layout[m];
        if (p !== undefined) layout[m] = { x: p.x + dx, y: p.y + dy }; // members travel with their group
      }
      return ok({ doc: { ...doc, groups, layout }, event: { summary: `moved group "${cmd.id}"` } });
    }

    case 'resizeGroup': {
      if (!doc.groups.some((x) => x.id === cmd.id)) return err(`group "${cmd.id}" not found`);
      const groups = doc.groups.map((x) => (x.id === cmd.id ? { ...x, rect: { x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h } } : x));
      return ok({ doc: { ...doc, groups }, event: { summary: `resized group "${cmd.id}"` } });
    }

    case 'assignGroup': {
      if (!has(cmd.node)) return err(`node "${cmd.node}" not found`);
      if (cmd.group !== null && !doc.groups.some((g) => g.id === cmd.group)) return err(`group "${cmd.group}" not found`);
      const groups = doc.groups.map((g) => {
        const without = g.members.filter((m) => m !== cmd.node); // a node belongs to at most one group
        if (g.id === cmd.group) return { ...g, members: [...without, cmd.node] };
        return without.length === g.members.length ? g : { ...g, members: without };
      });
      return ok({ doc: { ...doc, groups }, event: { summary: cmd.group !== null ? `grouped "${cmd.node}" into "${cmd.group}"` : `ungrouped "${cmd.node}"` } });
    }

    case 'defineComponent': {
      // Custom component definitions are pure DATA, project-scoped, and persist/export with the file.
      // Deep validation belongs to the engine at evaluate time; here we only check the shape is sane.
      const m = cmd.manifest as unknown as { type?: unknown; ports?: unknown };
      if (typeof m.type !== 'string' || m.type.trim() === '') return err('component needs a non-empty "type"');
      if (!Array.isArray(m.ports)) return err('component needs a "ports" array');
      const components = [...doc.components.filter((c) => c.type !== cmd.manifest.type), cmd.manifest]; // replace same-type
      return ok({ doc: { ...doc, components }, event: { summary: `defined component "${cmd.manifest.type}"` } });
    }

    case 'removeComponentDef': {
      if (!doc.components.some((c) => c.type === cmd.type)) return err(`no custom component "${cmd.type}"`);
      if (doc.instances.some((i) => i.type === cmd.type)) return err(`component "${cmd.type}" is in use — remove its instances first`);
      return ok({ doc: { ...doc, components: doc.components.filter((c) => c.type !== cmd.type) }, event: { summary: `removed component "${cmd.type}"` } });
    }

    case 'declareClass': {
      // Declare OR replace a whole request class by id (the replace-in-place discipline of defineComponent/setSLO).
      // A class's membership is STRUCTURAL — it names EXISTING wires and origin nodes — so we validate it up front
      // (classDeclProblems) and reject with a guided message rather than admit a class that would fail the build.
      // (Cyclic membership is caught at buildNetwork, naming the offending back-edge — doc: request-classes §4.2.)
      const problems = classDeclProblems(doc.instances, doc.wires, [cmd.decl]);
      if (problems.length > 0) return err(problems.join('; '));
      const requestClasses = [...doc.requestClasses.filter((c) => c.id !== cmd.decl.id), cmd.decl];
      return ok({ doc: { ...doc, requestClasses }, event: { summary: `declared request class "${cmd.decl.id}"` } });
    }

    case 'removeClass': {
      if (!doc.requestClasses.some((c) => c.id === cmd.id)) return err(`no request class "${cmd.id}"`);
      return ok({ doc: { ...doc, requestClasses: doc.requestClasses.filter((c) => c.id !== cmd.id) }, event: { summary: `removed request class "${cmd.id}"` } });
    }

    case 'setClassMembership': {
      // Toggle ONE wire's membership in a class. A wire may belong to MANY classes
      // (membership is a set, not a partition), so adding de-dups and removing prunes just this ref.
      const cls = doc.requestClasses.find((c) => c.id === cmd.class);
      if (cls === undefined) return err(`no request class "${cmd.class}"`);
      const label = `${cmd.from[0]} → ${cmd.to[0]}`;
      if (cmd.member) {
        if (!doc.wires.some((w) => w.from[0] === cmd.from[0] && w.from[1] === cmd.from[1] && w.to[0] === cmd.to[0] && w.to[1] === cmd.to[1]))
          return err(`no such wire ${cmd.from[0]}.${cmd.from[1]} → ${cmd.to[0]}.${cmd.to[1]} — draw it first`);
        if (cls.wires.some((r) => sameWireRef(r, cmd.from, cmd.to))) return ok({ doc, event: { summary: 'membership unchanged' } });
        const wires: WireRef[] = [...cls.wires, { from: cmd.from, to: cmd.to }];
        const requestClasses = doc.requestClasses.map((c) => (c.id === cmd.class ? { ...c, wires } : c));
        return ok({ doc: { ...doc, requestClasses }, event: { summary: `${label} joined class "${cmd.class}"` } });
      }
      const wires = cls.wires.filter((r) => !sameWireRef(r, cmd.from, cmd.to));
      if (wires.length === cls.wires.length) return ok({ doc, event: { summary: 'membership unchanged' } });
      const requestClasses = doc.requestClasses.map((c) => (c.id === cmd.class ? { ...c, wires } : c));
      return ok({ doc: { ...doc, requestClasses }, event: { summary: `${label} left class "${cmd.class}"` } });
    }

    case 'setClassOrigin': {
      // Set (or, with rps === null, clear) the rate a class injects at a node — its per-class assumedRps (doc:
      // request-classes §3). Replace-in-place per (class, node): one origin rate per class per node.
      const cls = doc.requestClasses.find((c) => c.id === cmd.class);
      if (cls === undefined) return err(`no request class "${cmd.class}"`);
      if (cmd.rps !== null && !has(cmd.node)) return err(`node "${cmd.node}" not found`);
      const origins = cmd.rps === null
        ? cls.origins.filter((o) => o.node !== cmd.node)
        : [...cls.origins.filter((o) => o.node !== cmd.node), { node: cmd.node, rps: cmd.rps }];
      const requestClasses = doc.requestClasses.map((c) => (c.id === cmd.class ? { ...c, origins } : c));
      return ok({
        doc: { ...doc, requestClasses },
        event: { summary: cmd.rps === null ? `cleared origin "${cmd.node}" on class "${cmd.class}"` : `class "${cmd.class}" originates ${cmd.rps} req/s at "${cmd.node}"` },
      });
    }

    case 'declareScenario': {
      // Declare OR replace a whole named world by id (the replace-in-place discipline of declareClass/setSLO). The
      // HARD rule enforced up front: every override targets a fact-assumption key (the ONLY overridable role), and
      // the id is non-empty/unique — else refuse with a guided message. A stale node/key is NOT checked here (it is
      // a soft lens, reported-and-skipped at evaluate time — doc §4.2), so declare-then-wire authoring stays legal.
      const problems = scenarioProblems([cmd.decl], doc.instances, doc.wires);
      if (problems.length > 0) return err(problems.join('; '));
      const scenarios = [...doc.scenarios.filter((s) => s.id !== cmd.decl.id), cmd.decl];
      return ok({ doc: { ...doc, scenarios }, event: { summary: `declared scenario "${cmd.decl.id}"` } });
    }

    case 'removeScenario': {
      if (!doc.scenarios.some((s) => s.id === cmd.id)) return err(`no scenario "${cmd.id}"`);
      return ok({ doc: { ...doc, scenarios: doc.scenarios.filter((s) => s.id !== cmd.id) }, event: { summary: `removed scenario "${cmd.id}"` } });
    }

    case 'renameScenario': {
      // Set the world's friendly display NAME (the id stays the stable identifier — nothing references a scenario by
      // name, so this is the reference-free edit, mirroring setLabel for a node). Empty clears the name.
      const s = doc.scenarios.find((x) => x.id === cmd.id);
      if (s === undefined) return err(`no scenario "${cmd.id}"`);
      const name = cmd.name.trim();
      const next: AssumptionScenario = name === '' ? { id: s.id, overrides: s.overrides } : { ...s, name };
      const scenarios = doc.scenarios.map((x) => (x.id === cmd.id ? next : x));
      return ok({ doc: { ...doc, scenarios }, event: { summary: `named scenario "${cmd.id}" → "${name || cmd.id}"` } });
    }

    case 'setScenarioOverride': {
      // Set (replace-in-place per node.key) one fact-assumption override in a world. The overridability boundary is
      // enforced here with the SAME guided message the load validation uses — a limit/computed/promise key is
      // refused, naming its actual role and the surface that owns it (doc §2), because such an override would
      // silently do nothing. Design-aware (a source client's throughput IS overridable demand — isScenarioOverridable).
      //
      // THE FREEZE (doc §5.3, coordinator directive): a MANUAL edit over a LIVE-derived value freezes it — provenance
      // `derived` → `architect`, so the ambient re-derive never silently overwrites the architect's number again. An
      // edit over an already-frozen or hand-authored override keeps its provenance; a brand-new override is a plain
      // hand-authored one (undefined provenance).
      const s = doc.scenarios.find((x) => x.id === cmd.scenario);
      if (s === undefined) return err(`no scenario "${cmd.scenario}"`);
      const roleProblem = overrideRoleProblem(cmd.node, cmd.key, doc.instances, doc.wires);
      if (roleProblem !== null) return err(roleProblem);
      const prev = s.overrides.find((o) => o.node === cmd.node && o.key === cmd.key);
      const provenance = prev?.provenance === 'derived' ? 'architect' : prev?.provenance; // an edit FREEZES a derived value
      const override: ScenarioOverride = { node: cmd.node, key: cmd.key, value: cmd.value, ...(provenance !== undefined ? { provenance } : {}) };
      const overrides = [...s.overrides.filter((o) => !(o.node === cmd.node && o.key === cmd.key)), override];
      const scenarios = doc.scenarios.map((x) => (x.id === cmd.scenario ? { ...x, overrides } : x));
      const froze = prev?.provenance === 'derived' ? ' (frozen — was derived)' : '';
      return ok({ doc: { ...doc, scenarios }, event: { summary: `scenario "${cmd.scenario}": ${cmd.node}.${cmd.key} = ${cmd.value}${froze}` } });
    }

    case 'clearScenarioOverride': {
      // THE UN-FREEZE (coordinator directive): clearing a FROZEN (architect) override in an auto-trio world does NOT
      // remove it — it RESETS the override to provenance `derived`, so the ambient re-derive re-tracks it from the
      // current envelope immediately (the architect's number is dropped in favour of the live derived value again).
      // Clearing a hand-authored/custom override (undefined provenance) or a live-derived one REMOVES it — the value
      // falls back to the base layer (a custom scenario has nothing to derive from). The command flips provenance
      // synchronously; the value re-tracks on the next ambient reconcile (reconcileDerivedScenarios).
      const s = doc.scenarios.find((x) => x.id === cmd.scenario);
      if (s === undefined) return err(`no scenario "${cmd.scenario}"`);
      const prev = s.overrides.find((o) => o.node === cmd.node && o.key === cmd.key);
      if (prev === undefined) return err(`no override ${cmd.node}.${cmd.key} in scenario "${cmd.scenario}"`);
      if (prev.provenance === 'architect') {
        // Un-freeze: back to derived, re-tracking. Keep the current value as a placeholder until the reconcile refills.
        const reset: ScenarioOverride = { node: prev.node, key: prev.key, value: prev.value, provenance: 'derived' };
        const overrides = s.overrides.map((o) => (o.node === cmd.node && o.key === cmd.key ? reset : o));
        const scenarios = doc.scenarios.map((x) => (x.id === cmd.scenario ? { ...x, overrides } : x));
        return ok({ doc: { ...doc, scenarios }, event: { summary: `scenario "${cmd.scenario}": ${cmd.node}.${cmd.key} back to derived (re-tracks the envelope)` } });
      }
      const overrides = s.overrides.filter((o) => !(o.node === cmd.node && o.key === cmd.key));
      const scenarios = doc.scenarios.map((x) => (x.id === cmd.scenario ? { ...x, overrides } : x));
      return ok({ doc: { ...doc, scenarios }, event: { summary: `scenario "${cmd.scenario}": cleared ${cmd.node}.${cmd.key}` } });
    }
  }
}
