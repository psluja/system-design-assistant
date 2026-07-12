import { describe, expect, it } from 'vitest';
import { ClassId, NodeId, type Result } from '@sda/engine-core';
import { commonManifests, registry, keys } from '@sda/content';
import { Studio } from './store';
import { deserialize, emptyProject, serialize } from './document';

const must = (r: Result<string, string>): void => {
  if (!r.ok) throw new Error(r.error);
};

describe('command core (Studio) — the MCP-first foundation', () => {
  it('drives a verified design entirely through commands', () => {
    const s = new Studio(registry, commonManifests);
    // a classic stack assembled command-by-command (exactly what an MCP agent would issue)
    must(s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' }));
    must(s.dispatch({ kind: 'addComponent', id: 'nginx', type: 'proxy.nginx' }));
    must(s.dispatch({ kind: 'addComponent', id: 'app', type: 'compute.service' }));
    must(s.dispatch({ kind: 'addComponent', id: 'pg', type: 'db.postgres' }));
    must(s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['nginx', 'in'] }));
    must(s.dispatch({ kind: 'connect', from: ['nginx', 'out'], to: ['app', 'in'] }));
    must(s.dispatch({ kind: 'connect', from: ['app', 'db'], to: ['pg', 'in'] }));
    must(s.dispatch({ kind: 'setSLO', node: 'pg', key: keys.throughput, band: { shape: 'minTargetMax', min: 5000 } }));

    const v = s.verdicts().find((x) => x.scope === NodeId('pg') && x.key === keys.throughput);
    expect(v?.status).toBe('violation'); // Postgres connection-bound at 2,000 rps < 5,000 SLO
    expect(v?.cause.some((l) => l.scope === NodeId('pg'))).toBe(true);
  });

  it('validates commands and never corrupts the document', () => {
    const s = new Studio(registry, commonManifests);
    expect(s.dispatch({ kind: 'addComponent', id: 'x', type: 'does.not.exist' }).ok).toBe(false);
    expect(s.dispatch({ kind: 'connect', from: ['x', 'out'], to: ['y', 'in'] }).ok).toBe(false);
    expect(s.project().instances).toHaveLength(0);
    expect(s.project().wires).toHaveLength(0);
  });

  it('supports undo/redo from the command log', () => {
    const s = new Studio(registry, commonManifests);
    s.dispatch({ kind: 'addComponent', id: 'a', type: 'cache.redis' });
    expect(s.project().instances).toHaveLength(1);
    expect(s.undo()).toBe(true);
    expect(s.project().instances).toHaveLength(0);
    expect(s.redo()).toBe(true);
    expect(s.project().instances).toHaveLength(1);
    expect(s.undo()).toBe(true);
    expect(s.undo()).toBe(false); // nothing left to undo
  });

  it('imports a document UNDOABLY (replaceDoc) so an import never wipes unsaved work', () => {
    const s = new Studio(registry, commonManifests);
    s.dispatch({ kind: 'addComponent', id: 'before', type: 'cache.redis' });
    const prior = s.project();
    expect(prior.instances.map((i) => i.id)).toEqual(['before']);

    // import a different design over the top — undoably
    const imported = emptyProject('p2', 'Imported');
    s.replaceDoc(imported);
    expect(s.project().id).toBe('p2');
    expect(s.project().instances).toHaveLength(0);
    expect(s.canUndo()).toBe(true);

    // Undo restores the exact pre-import design (the safety guarantee)
    expect(s.undo()).toBe(true);
    expect(s.project()).toBe(prior);
    expect(s.project().instances.map((i) => i.id)).toEqual(['before']);

    // Redo brings the imported document back
    expect(s.redo()).toBe(true);
    expect(s.project()).toBe(imported);
    expect(s.project().name).toBe('Imported');
  });

  it('serializes and reloads a project (the export/backup format)', () => {
    const s = new Studio(registry, commonManifests);
    s.dispatch({ kind: 'addComponent', id: 'a', type: 'cache.redis' });
    s.dispatch({ kind: 'rename', name: 'My Project' });
    const back = deserialize(serialize(s.project()));
    if (!back.ok) throw new Error(back.error);
    expect(back.value.name).toBe('My Project');
    expect(back.value.instances[0]?.type).toBe('cache.redis');
    expect(deserialize('{ not json').ok).toBe(false);
    expect(deserialize('{"schema":2}').ok).toBe(false); // honest rejection of unknown schema
  });

  it('dispatchBatch applies several knob changes as ONE undoable unit — a single Undo restores the WHOLE prior design', () => {
    const s = new Studio(registry, commonManifests);
    s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.service' });
    s.dispatch({ kind: 'addComponent', id: 'db', type: 'db.postgres' });
    const before = serialize(s.project());
    must(s.dispatchBatch([
      { kind: 'setConfig', node: 'svc', key: keys.concurrency, value: 125 },
      { kind: 'setConfig', node: 'db', key: keys.concurrency, value: 313 },
    ]));
    const conc = (id: string): unknown => s.project().instances.find((i) => i.id === id)?.config?.[String(keys.concurrency)];
    expect(conc('svc')).toBe(125);
    expect(conc('db')).toBe(313);
    // ONE undo restores BOTH knobs to `before` — proof the batch was a SINGLE history entry; two entries would
    // revert only db's concurrency and leave svc at 125 (a hybrid), so serialize would NOT equal `before`.
    expect(s.undo()).toBe(true);
    expect(serialize(s.project())).toBe(before);
    expect(conc('svc')).not.toBe(125); // svc reverted too (not left at the optimizer value)
  });

  it('setTransform sets a per-port flow transform, is UNDOABLE, survives a document round-trip, and clears', () => {
    const s = new Studio(registry, commonManifests);
    s.dispatch({ kind: 'addComponent', id: 'gen', type: 'compute.service' });
    const tf = (id: string): unknown => s.project().instances.find((i) => i.id === id)?.transforms;

    must(s.dispatch({ kind: 'setTransform', node: 'gen', port: 'db', transform: { kind: 'ratio', value: 100 } }));
    expect(tf('gen')).toEqual({ db: { kind: 'ratio', value: 100 } });

    // survives the export/backup round-trip (additive, like labels — schema stays 3)
    const back = deserialize(serialize(s.project()));
    if (!back.ok) throw new Error(back.error);
    expect(back.value.instances[0]?.transforms).toEqual({ db: { kind: 'ratio', value: 100 } });

    // undoable like setConfig
    expect(s.undo()).toBe(true);
    expect(tf('gen')).toBeUndefined();
    expect(s.redo()).toBe(true);
    expect(tf('gen')).toEqual({ db: { kind: 'ratio', value: 100 } });

    // null clears the override back to identity
    must(s.dispatch({ kind: 'setTransform', node: 'gen', port: 'db', transform: null }));
    expect(tf('gen')).toEqual({});

    // an unknown node is refused (never corrupts the document)
    expect(s.dispatch({ kind: 'setTransform', node: 'ghost', port: 'db', transform: { kind: 'ratio', value: 2 } }).ok).toBe(false);
  });

  it('setWireTransform sets a per-WIRE routing split, is UNDOABLE, survives a round-trip, clears, and refuses an unknown wire', () => {
    const s = new Studio(registry, commonManifests);
    s.dispatch({ kind: 'addComponent', id: 'gw', type: 'compute.service' });
    s.dispatch({ kind: 'addComponent', id: 'catalog', type: 'compute.service' });
    s.dispatch({ kind: 'addComponent', id: 'checkout', type: 'compute.service' });
    must(s.dispatch({ kind: 'connect', from: ['gw', 'out'], to: ['catalog', 'in'] }));
    must(s.dispatch({ kind: 'connect', from: ['gw', 'out'], to: ['checkout', 'in'] }));
    const wireTf = (toNode: string): unknown => s.project().wires.find((w) => w.to[0] === toNode)?.transform;

    // ONE out port, TWO wires with DIFFERENT shares — the routing split a per-port transform cannot express.
    must(s.dispatch({ kind: 'setWireTransform', from: ['gw', 'out'], to: ['catalog', 'in'], transform: { kind: 'prob', value: 0.7 } }));
    must(s.dispatch({ kind: 'setWireTransform', from: ['gw', 'out'], to: ['checkout', 'in'], transform: { kind: 'prob', value: 0.3 } }));
    expect(wireTf('catalog')).toEqual({ kind: 'prob', value: 0.7 });
    expect(wireTf('checkout')).toEqual({ kind: 'prob', value: 0.3 });

    // survives the export/backup round-trip (additive on the Wire — schema stays 3)
    const back = deserialize(serialize(s.project()));
    if (!back.ok) throw new Error(back.error);
    expect(back.value.wires.find((w) => w.to[0] === 'catalog')?.transform).toEqual({ kind: 'prob', value: 0.7 });

    // undoable, and redo replays
    expect(s.undo()).toBe(true);
    expect(wireTf('checkout')).toBeUndefined();
    expect(s.redo()).toBe(true);
    expect(wireTf('checkout')).toEqual({ kind: 'prob', value: 0.3 });

    // null clears the override AND drops the field (no `"transform": null` artifact — serializes like a fresh wire)
    must(s.dispatch({ kind: 'setWireTransform', from: ['gw', 'out'], to: ['catalog', 'in'], transform: null }));
    expect(wireTf('catalog')).toBeUndefined();
    expect(serialize(s.project())).not.toContain('"transform": null');

    // an unknown wire is refused (never corrupts the document)
    expect(s.dispatch({ kind: 'setWireTransform', from: ['gw', 'out'], to: ['ghost', 'in'], transform: { kind: 'ratio', value: 2 } }).ok).toBe(false);
  });

  it('round-trips a percentile (p99) SLO band LOSSLESSLY — its targets Map survives (no crash on reload)', () => {
    const s = new Studio(registry, commonManifests);
    s.dispatch({ kind: 'addComponent', id: 'db', type: 'db.postgres' });
    must(s.dispatch({ kind: 'setSLO', node: 'db', key: keys.latency, band: { shape: 'percentiles', targets: new Map([['p99', 300]]) } }));
    const back = deserialize(serialize(s.project()));
    if (!back.ok) throw new Error(back.error);
    const band = back.value.instances[0]?.bands?.[0]?.band;
    expect(band?.shape).toBe('percentiles');
    // JSON.stringify(Map) is "{}" — a naive round-trip would drop every entry and leave a plain object, so the UI
    // crashes reading `band.targets.get('p99')`. The tagged round-trip must keep it a real, populated Map.
    if (band?.shape === 'percentiles') {
      expect(band.targets).toBeInstanceOf(Map);
      expect(band.targets.get('p99')).toBe(300);
    }
  });

  it('sets and round-trips a per-FLOW guarantee requirement (serialize → deserialize, additive, lossless)', () => {
    const s = new Studio(registry, commonManifests);
    must(s.dispatch({ kind: 'addComponent', id: 'producer', type: 'client.web' }));
    must(s.dispatch({ kind: 'addComponent', id: 'q', type: 'queue.sqs' }));
    must(s.dispatch({ kind: 'addComponent', id: 'worker', type: 'compute.serverless' }));
    // declare "Ordering ≥ per-key" on the producer→worker flow (keyed by the flow's endpoints, not a node)
    must(s.dispatch({ kind: 'setGuaranteeSlo', slo: { source: 'producer', terminal: 'worker', dimension: 'ordering', atLeast: 'per-key' } }));
    expect(s.project().guaranteeSlos).toHaveLength(1);
    // setting again on the same (source,terminal,dimension) REPLACES (one requirement per flow per dimension)
    must(s.dispatch({ kind: 'setGuaranteeSlo', slo: { source: 'producer', terminal: 'worker', dimension: 'ordering', atLeast: 'total' } }));
    expect(s.project().guaranteeSlos).toHaveLength(1);
    expect(s.project().guaranteeSlos[0]?.atLeast).toBe('total');

    // ROUND-TRIP: plain strings ⇒ no Map handling; the requirement survives serialize → deserialize verbatim
    const back = deserialize(serialize(s.project()));
    if (!back.ok) throw new Error(back.error);
    expect(back.value.guaranteeSlos).toEqual([{ source: 'producer', terminal: 'worker', dimension: 'ordering', atLeast: 'total' }]);

    // renaming a node rewrites the requirement's flow key (never dangles avoidably)
    must(s.dispatch({ kind: 'renameNode', id: 'worker', to: 'consumer' }));
    expect(s.project().guaranteeSlos[0]?.terminal).toBe('consumer');

    // clearing by (source, terminal, dimension) removes it; clearing a missing one is an honest error
    must(s.dispatch({ kind: 'clearGuaranteeSlo', source: 'producer', terminal: 'consumer', dimension: 'ordering' }));
    expect(s.project().guaranteeSlos).toHaveLength(0);
    expect(s.dispatch({ kind: 'clearGuaranteeSlo', source: 'producer', terminal: 'consumer', dimension: 'ordering' }).ok).toBe(false);
  });

  it('a legacy document with no guaranteeSlos field loads as an empty list (additive, backward-compatible)', () => {
    // a minimal hand-written / older-schema document has no guaranteeSlos — it must load, not fail.
    const legacy = JSON.stringify({ schema: 3, id: 'p', name: 'Legacy', instances: [], wires: [] });
    const back = deserialize(legacy);
    if (!back.ok) throw new Error(back.error);
    expect(back.value.guaranteeSlos).toEqual([]);
  });

  it('sets and round-trips a per-FLOW LAG requirement (serialize → deserialize, additive, lossless)', () => {
    const s = new Studio(registry, commonManifests);
    must(s.dispatch({ kind: 'addComponent', id: 'capture', type: 'compute.service' }));
    must(s.dispatch({ kind: 'addComponent', id: 'aurora', type: 'db.postgres' }));
    // declare "lag ≤ 500 ms" on the capture→aurora flow (keyed by the flow's endpoints, a number — not a node band)
    must(s.dispatch({ kind: 'setLagSlo', slo: { source: 'capture', terminal: 'aurora', maxMs: 500 } }));
    expect(s.project().lagSlos).toHaveLength(1);
    // setting again on the same (source, terminal) REPLACES (one lag deadline per flow)
    must(s.dispatch({ kind: 'setLagSlo', slo: { source: 'capture', terminal: 'aurora', maxMs: 250 } }));
    expect(s.project().lagSlos).toHaveLength(1);
    expect(s.project().lagSlos[0]?.maxMs).toBe(250);

    // ROUND-TRIP: plain data ⇒ no Map handling; the requirement survives serialize → deserialize verbatim, schema 5
    const back = deserialize(serialize(s.project()));
    if (!back.ok) throw new Error(back.error);
    expect(back.value.schema).toBe(11);
    expect(back.value.lagSlos).toEqual([{ source: 'capture', terminal: 'aurora', maxMs: 250 }]);

    // renaming a node rewrites the requirement's flow key (never dangles avoidably)
    must(s.dispatch({ kind: 'renameNode', id: 'aurora', to: 'dest' }));
    expect(s.project().lagSlos[0]?.terminal).toBe('dest');

    // clearing by (source, terminal) removes it; clearing a missing one is an honest error
    must(s.dispatch({ kind: 'clearLagSlo', source: 'capture', terminal: 'dest' }));
    expect(s.project().lagSlos).toHaveLength(0);
    expect(s.dispatch({ kind: 'clearLagSlo', source: 'capture', terminal: 'dest' }).ok).toBe(false);
  });

  it('a schema-3 export (no lagSlos field) migrates to the current schema with an empty lag list (old exports load)', () => {
    // every committed example is schema 3 and carries guaranteeSlos but no lagSlos — it must load, not fail, and
    // gain an empty lag collection (the additive migration the client-persistence convention requires).
    const v3 = JSON.stringify({
      schema: 3, id: 'p', name: 'v3', instances: [], wires: [],
      guaranteeSlos: [{ source: 'a', terminal: 'b', dimension: 'ordering', atLeast: 'per-key' }],
    });
    const back = deserialize(v3);
    if (!back.ok) throw new Error(back.error);
    expect(back.value.schema).toBe(11);
    expect(back.value.lagSlos).toEqual([]);
    expect(back.value.guaranteeSlos).toHaveLength(1); // the older collection is preserved unchanged
  });

  it('a schema-4 export (no instance ranges) migrates to the current schema, and schema-5 uncertainty RANGES round-trip lossless', () => {
    // SCHEMA 5: per-instance uncertainty ranges ride INSIDE the Instance, so a
    // schema-4 export (no `ranges` on any instance) must load unchanged and gain the current schema — additive, the
    // client-persistence law. A schema-4 doc with a real instance + wiring but no ranges is the pre-uncertainty world.
    const v4 = JSON.stringify({
      schema: 4, id: 'p', name: 'v4', instances: [{ id: 'a', type: 'compute.service', config: { unitCost: 0.2 } }], wires: [],
      layout: {}, labels: {}, descriptions: {}, groups: [], components: [], guaranteeSlos: [], lagSlos: [],
    });
    const up = deserialize(v4);
    if (!up.ok) throw new Error(up.error);
    expect(up.value.schema).toBe(11);
    expect(up.value.instances[0]?.ranges).toBeUndefined(); // no range declared ⇒ the feature is silent (no-filler)

    // A schema-5 doc that DOES carry ranges (one uniform, one triangular) survives serialize → deserialize verbatim.
    const s = new Studio(registry, commonManifests);
    must(s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.service' }));
    must(s.dispatch({ kind: 'setRange', node: 'svc', key: 'unitCost', range: { lo: 0.1, hi: 0.3 } }));
    must(s.dispatch({ kind: 'setRange', node: 'svc', key: 'perRequestDuration', range: { lo: 40, mode: 60, hi: 120 } }));
    expect(s.project().schema).toBe(11);
    const back = deserialize(serialize(s.project()));
    if (!back.ok) throw new Error(back.error);
    expect(back.value.schema).toBe(11);
    expect(back.value.instances[0]?.ranges).toEqual({ unitCost: { lo: 0.1, hi: 0.3 }, perRequestDuration: { lo: 40, mode: 60, hi: 120 } });

    // clearing the LAST range DROPS the `ranges` field entirely (no `"ranges": {}` artifact) — byte-clean like a
    // node that never had one; clearing a missing range is an honest error.
    must(s.dispatch({ kind: 'clearRange', node: 'svc', key: 'unitCost' }));
    must(s.dispatch({ kind: 'clearRange', node: 'svc', key: 'perRequestDuration' }));
    expect(s.project().instances[0]?.ranges).toBeUndefined();
    expect(s.dispatch({ kind: 'clearRange', node: 'svc', key: 'unitCost' }).ok).toBe(false);

    // an UNSOUND range (lo>hi) is an honest build error naming the key — never a silent bad draw (instantiate).
    must(s.dispatch({ kind: 'setRange', node: 'svc', key: 'unitCost', range: { lo: 0.5, hi: 0.1 } }));
    const g = s.graph();
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error.some((e) => e.kind === 'invalid-range' && e.key === 'unitCost')).toBe(true);
  });

  it('a schema-5 export (no requestClasses field) migrates to the current schema with an empty class list (old exports load)', () => {
    // SCHEMA 6: the top-level REQUEST CLASSES container is additive, exactly like
    // lagSlos before it. A schema-5 export (every committed one) has no `requestClasses` field, so it must load,
    // not fail, and gain an empty class list — the single implicit river, bit-for-bit today (client-persistence law).
    const v5 = JSON.stringify({
      schema: 5, id: 'p', name: 'v5', instances: [{ id: 'a', type: 'compute.service' }], wires: [],
      layout: {}, labels: {}, descriptions: {}, groups: [], components: [], guaranteeSlos: [], lagSlos: [],
    });
    const back = deserialize(v5);
    if (!back.ok) throw new Error(back.error);
    expect(back.value.schema).toBe(11);
    expect(back.value.requestClasses).toEqual([]);
  });

  it('a schema-6 export (no scenarios field) migrates to the current schema with an empty world list (old exports load)', () => {
    // SCHEMA 7: the top-level NAMED WORLDS container is additive, exactly like
    // requestClasses before it. A schema-6 export (every committed one) has no `scenarios` field, so it must load,
    // not fail, and gain an empty world list — no named worlds, the base layer bit-for-bit (client-persistence law).
    const v6 = JSON.stringify({
      schema: 6, id: 'p', name: 'v6', instances: [{ id: 'a', type: 'compute.service' }], wires: [],
      layout: {}, labels: {}, descriptions: {}, groups: [], components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [],
    });
    const back = deserialize(v6);
    if (!back.ok) throw new Error(back.error);
    expect(back.value.schema).toBe(11);
    expect(back.value.scenarios).toEqual([]);
  });

  it('a schema-8 export (no systemPromises field) migrates to the current schema with an empty promise list (old exports load)', () => {
    // SCHEMA 9 (owner ruling: cost is for THE WHOLE SYSTEM): the top-level SYSTEM PROMISES container is additive,
    // exactly like scenarios before it. A schema-8 export (every committed one) has no `systemPromises` field, so it
    // must load, not fail, and gain an empty promise list — bit-for-bit today (client-persistence law).
    const v8 = JSON.stringify({
      schema: 8, id: 'p', name: 'v8', instances: [{ id: 'a', type: 'compute.service' }], wires: [],
      layout: {}, labels: {}, descriptions: {}, groups: [], components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [], scenarios: [],
    });
    const back = deserialize(v8);
    if (!back.ok) throw new Error(back.error);
    expect(back.value.schema).toBe(11);
    expect(back.value.systemPromises).toEqual([]);
  });

  it('a schema-9 export migrates to the current schema; its systemPromises ride through unchanged (old exports load)', () => {
    // A schema-9 export (every committed one) has no `flowPromises` field, so there is nothing to fold; it loads,
    // gains the current schema, and its older containers ride through unchanged (client-persistence law).
    const v9 = JSON.stringify({
      schema: 9, id: 'p', name: 'v9', instances: [{ id: 'a', type: 'compute.service' }], wires: [],
      layout: {}, labels: {}, descriptions: {}, groups: [], components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [], scenarios: [],
      systemPromises: [{ key: 'cost', band: { shape: 'minTargetMax', max: 3000 } }],
    });
    const back = deserialize(v9);
    if (!back.ok) throw new Error(back.error);
    expect(back.value.schema).toBe(11);
    expect(back.value.systemPromises).toHaveLength(1); // the schema-9 container is preserved unchanged
  });

  it('CONSOLIDATION: a schema-10 flowPromises file FOLDS each availability promise onto its terminal node band on load', () => {
    // The retired `flowPromises` container (an end-to-end availability floor keyed by source→terminal) was judged
    // against `value(terminal, availability)` — the terminal's cumulative cell, the serial product over the whole
    // path — which a NODE availability band on the terminal captures EXACTLY (the source never entered the number).
    // So an old schema-10 export still LOADS: `migrateFlowPromisesToNodeBands` folds the promise onto the terminal.
    const v10 = JSON.stringify({
      schema: 10, id: 'p', name: 'v10', instances: [{ id: 'client', type: 'client.web' }, { id: 'pg', type: 'db.postgres' }],
      wires: [{ from: ['client', 'out'], to: ['pg', 'in'] }],
      layout: {}, labels: {}, descriptions: {}, groups: [], components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [], scenarios: [], systemPromises: [],
      flowPromises: [{ source: 'client', terminal: 'pg', key: 'availability', band: { shape: 'minTargetMax', min: 0.9995 } }],
    });
    const back = deserialize(v10);
    if (!back.ok) throw new Error(back.error);
    expect(back.value.schema).toBe(11);
    // The promise now lives as a band on the TERMINAL node (`pg`) — the identical judged quantity, its one true home.
    const pg = back.value.instances.find((i) => i.id === 'pg');
    expect(pg?.bands).toEqual([{ key: 'availability', band: { shape: 'minTargetMax', min: 0.9995 } }]);
    // The source node gains nothing (the promise was never about the source cell).
    expect(back.value.instances.find((i) => i.id === 'client')?.bands ?? []).toEqual([]);
    // The retired container is gone from the loaded document (no `flowPromises` field).
    expect((back.value as { flowPromises?: unknown }).flowPromises).toBeUndefined();
  });

  it('CONSOLIDATION: an EXISTING terminal availability band wins over a folded flow promise; a dangling terminal is dropped', () => {
    const v10 = JSON.stringify({
      schema: 10, id: 'p', name: 'v10', instances: [{ id: 'client', type: 'client.web' }, { id: 'pg', type: 'db.postgres', bands: [{ key: 'availability', band: { shape: 'minTargetMax', min: 0.99 } }] }],
      wires: [{ from: ['client', 'out'], to: ['pg', 'in'] }],
      layout: {}, labels: {}, descriptions: {}, groups: [], components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [], scenarios: [], systemPromises: [],
      flowPromises: [
        { source: 'client', terminal: 'pg', key: 'availability', band: { shape: 'minTargetMax', min: 0.9995 } },
        { source: 'client', terminal: 'gone', key: 'availability', band: { shape: 'minTargetMax', min: 0.999 } }, // dangling terminal — un-judgeable, dropped
      ],
    });
    const back = deserialize(v10);
    if (!back.ok) throw new Error(back.error);
    // The terminal's own band is NOT overwritten (no silent clobber); the dangling promise attaches to no node.
    expect(back.value.instances.find((i) => i.id === 'pg')?.bands).toEqual([{ key: 'availability', band: { shape: 'minTargetMax', min: 0.99 } }]);
    expect(back.value.instances.some((i) => i.id === 'gone')).toBe(false);
  });

  it('sets, replaces, round-trips and clears a SYSTEM promise (whole-system cost); the v1 vocabulary is guarded; renameNode never touches it', () => {
    const s = new Studio(registry, commonManifests);
    must(s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.service' }));

    // declare "the whole system costs ≤ 3,000 USD/month" — a top-level container entry, NEVER a node band
    must(s.dispatch({ kind: 'setSystemPromise', promise: { key: String(keys.cost), band: { shape: 'minTargetMax', max: 3000 } } }));
    expect(s.project().systemPromises).toEqual([{ key: 'cost', band: { shape: 'minTargetMax', max: 3000 } }]);
    expect(s.project().instances[0]?.bands).toBeUndefined(); // no silent node band — the promise is system-scoped data

    // setting again on the same key REPLACES (one system promise per key — the setSLO discipline)
    must(s.dispatch({ kind: 'setSystemPromise', promise: { key: String(keys.cost), band: { shape: 'minTargetMax', max: 2000 } } }));
    expect(s.project().systemPromises).toHaveLength(1);
    expect(s.project().systemPromises[0]?.band).toEqual({ shape: 'minTargetMax', max: 2000 });

    // the v1 vocabulary boundary: a flow/node quantity is refused with a guided error naming the covered set
    const bad = s.dispatch({ kind: 'setSystemPromise', promise: { key: 'latency', band: { shape: 'minTargetMax', max: 200 } } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('cost');

    // renameNode rewrites node-keyed containers — a system promise references NO node, so it rides unchanged
    must(s.dispatch({ kind: 'renameNode', id: 'svc', to: 'service' }));
    expect(s.project().systemPromises[0]?.key).toBe('cost');

    // ROUND-TRIP: plain data ⇒ no Map handling; the promise survives serialize → deserialize verbatim, schema 9
    const back = deserialize(serialize(s.project()));
    if (!back.ok) throw new Error(back.error);
    expect(back.value.schema).toBe(11);
    expect(back.value.systemPromises).toEqual([{ key: 'cost', band: { shape: 'minTargetMax', max: 2000 } }]);

    // clearing removes it; clearing a missing one is an honest error
    must(s.dispatch({ kind: 'clearSystemPromise', key: 'cost' }));
    expect(s.project().systemPromises).toHaveLength(0);
    expect(s.dispatch({ kind: 'clearSystemPromise', key: 'cost' }).ok).toBe(false);
  });

  it('declares NAMED WORLDS (scenarios), enforces the fact-assumption role boundary, and round-trips them', () => {
    const s = new Studio(registry, commonManifests);
    must(s.dispatch({ kind: 'addComponent', id: 'gen', type: 'compute.service' }));
    must(s.dispatch({ kind: 'setConfig', node: 'gen', key: 'assumedRps', value: 500 }));

    // declare a "pessimistic" world overriding assumedRps (a fact-assumption) — replace-in-place by id
    must(s.dispatch({ kind: 'declareScenario', decl: { id: 'pessimistic', overrides: [{ node: 'gen', key: 'assumedRps', value: 900 }] } }));
    must(s.dispatch({ kind: 'declareScenario', decl: { id: 'optimistic', overrides: [] } }));
    expect(s.project().scenarios.map((x) => x.id)).toEqual(['pessimistic', 'optimistic']);

    // the ROLE BOUNDARY: an override on a non-fact-assumption key is refused with a guided message naming the role
    const badDeclare = s.dispatch({ kind: 'declareScenario', decl: { id: 'bad', overrides: [{ node: 'gen', key: 'concurrency', value: 10 }] } });
    expect(badDeclare.ok).toBe(false);
    if (!badDeclare.ok) expect(badDeclare.error).toContain('resource limit');
    const badSet = s.dispatch({ kind: 'setScenarioOverride', scenario: 'optimistic', node: 'gen', key: 'cost', value: 1 });
    expect(badSet.ok).toBe(false);
    if (!badSet.ok) expect(badSet.error).toContain('computed');

    // set/clear one override; rename sets the friendly name
    must(s.dispatch({ kind: 'setScenarioOverride', scenario: 'optimistic', node: 'gen', key: 'assumedRps', value: 150 }));
    must(s.dispatch({ kind: 'renameScenario', id: 'optimistic', name: 'Quiet launch' }));
    expect(s.project().scenarios.find((x) => x.id === 'optimistic')?.name).toBe('Quiet launch');
    expect(s.project().scenarios.find((x) => x.id === 'optimistic')?.overrides).toEqual([{ node: 'gen', key: 'assumedRps', value: 150 }]);

    // ROUND-TRIP: plain arrays ⇒ no Map handling; the worlds survive serialize → deserialize verbatim, schema 7
    const back = deserialize(serialize(s.project()));
    if (!back.ok) throw new Error(back.error);
    expect(back.value.schema).toBe(11);
    expect(back.value.scenarios).toEqual(s.project().scenarios);

    // renameNode rewrites a world's override endpoints (never dangles an override avoidably)
    must(s.dispatch({ kind: 'renameNode', id: 'gen', to: 'source' }));
    expect(s.project().scenarios.find((x) => x.id === 'pessimistic')?.overrides[0]?.node).toBe('source');

    // clear + remove; clearing a missing override / removing a missing world are honest errors
    must(s.dispatch({ kind: 'clearScenarioOverride', scenario: 'optimistic', node: 'source', key: 'assumedRps' }));
    expect(s.project().scenarios.find((x) => x.id === 'optimistic')?.overrides).toEqual([]);
    expect(s.dispatch({ kind: 'clearScenarioOverride', scenario: 'optimistic', node: 'source', key: 'assumedRps' }).ok).toBe(false);
    must(s.dispatch({ kind: 'removeScenario', id: 'pessimistic' }));
    expect(s.project().scenarios.map((x) => x.id)).toEqual(['optimistic']);
    expect(s.dispatch({ kind: 'removeScenario', id: 'pessimistic' }).ok).toBe(false);
  });

  it('rejects a loaded document whose scenario overrides a non-fact-assumption key (guided, on load)', () => {
    const bad = JSON.stringify({
      schema: 7, id: 'p', name: 'bad', instances: [{ id: 'a', type: 'compute.service' }], wires: [],
      scenarios: [{ id: 'w', overrides: [{ node: 'a', key: 'replicas', value: 3 }] }],
    });
    const r = deserialize(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('scenarios:');
  });

  // ── assumption model R2 — the derived-trio lifecycle + the active-world lens ──
  const trioDesign = (): Studio => {
    const s = new Studio(registry, commonManifests);
    must(s.dispatch({ kind: 'addComponent', id: 'users', type: 'client.web' })); // a source client: throughput = demand
    must(s.dispatch({ kind: 'setConfig', node: 'users', key: 'throughput', value: 2000 }));
    return s;
  };

  it("a source client's throughput is overridable demand (design-aware); a service throughput is refused", () => {
    const s = trioDesign();
    must(s.dispatch({ kind: 'declareScenario', decl: { id: 'real', overrides: [{ node: 'users', key: 'throughput', value: 3000 }] } }));
    must(s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.service' }));
    const bad = s.dispatch({ kind: 'setScenarioOverride', scenario: 'real', node: 'svc', key: 'throughput', value: 10 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('not an origin');
  });

  it('a manual edit FREEZES a derived value (derived → architect); CLEAR UN-freezes it (architect → derived)', () => {
    const s = trioDesign();
    // a DERIVED override, exactly as the trio would create it
    must(s.dispatch({ kind: 'declareScenario', decl: { id: 'real', overrides: [{ node: 'users', key: 'throughput', value: 1200, provenance: 'derived' }] } }));
    // manual edit over the live-derived value freezes it
    must(s.dispatch({ kind: 'setScenarioOverride', scenario: 'real', node: 'users', key: 'throughput', value: 5000 }));
    expect(s.project().scenarios[0]!.overrides[0]).toMatchObject({ value: 5000, provenance: 'architect' });
    // the provenance field is additive WITHIN schema 7 (optional): it round-trips through serialize/deserialize with
    // no migration, and the schema stays 7 (the decision — an optional-additive field does not bump the schema).
    const back = deserialize(serialize(s.project()));
    if (!back.ok) throw new Error(back.error);
    expect(back.value.schema).toBe(11);
    expect(back.value.scenarios[0]!.overrides[0]).toMatchObject({ value: 5000, provenance: 'architect' });

    // clear un-freezes (does NOT remove) — back to derived, ready to re-track the envelope
    must(s.dispatch({ kind: 'clearScenarioOverride', scenario: 'real', node: 'users', key: 'throughput' }));
    expect(s.project().scenarios[0]!.overrides[0]).toMatchObject({ provenance: 'derived' });
  });

  it('clearing a hand-authored (custom) override REMOVES it — a custom scenario falls back to base', () => {
    const s = trioDesign();
    must(s.dispatch({ kind: 'declareScenario', decl: { id: 'custom', overrides: [] } }));
    must(s.dispatch({ kind: 'setScenarioOverride', scenario: 'custom', node: 'users', key: 'throughput', value: 1500 }));
    expect(s.project().scenarios[0]!.overrides[0]!.provenance).toBeUndefined(); // hand-authored
    must(s.dispatch({ kind: 'clearScenarioOverride', scenario: 'custom', node: 'users', key: 'throughput' }));
    expect(s.project().scenarios[0]!.overrides).toEqual([]); // removed, not un-frozen
  });

  it('the active-world lens is Studio UI state — out of the doc, self-healing, emits on the same stream', () => {
    const s = trioDesign();
    must(s.dispatch({ kind: 'declareScenario', decl: { id: 'real', overrides: [] } }));
    let emits = 0;
    s.onChange(() => emits++);
    expect(s.activeScenario()).toBeUndefined();
    s.setActiveScenario('real');
    expect(s.activeScenario()).toBe('real');
    expect(emits).toBe(1);
    s.setActiveScenario('real'); // idempotent — no needless emit
    expect(emits).toBe(1);
    s.setActiveScenario('ghost'); // a non-existent world falls back to the base lens (never dangling)
    expect(s.activeScenario()).toBeUndefined();
    expect(serialize(s.project())).not.toContain('activeScenario'); // never serialized
    // removing the active world self-heals the lens to base
    s.setActiveScenario('real');
    must(s.dispatch({ kind: 'removeScenario', id: 'real' }));
    expect(s.activeScenario()).toBeUndefined();
  });

  it('reconcileDerivedScenarios re-tracks derived values, preserves frozen ones, is idempotent + non-undoable', () => {
    const s = trioDesign();
    must(s.dispatch({ kind: 'declareScenario', decl: { id: 'real', name: 'Real', overrides: [
      { node: 'users', key: 'throughput', value: 1000, provenance: 'derived' },
    ] } }));
    // the ambient loop hands a freshly-derived trio (the envelope moved ⇒ a new derived value 3600)
    const fresh = [{ id: 'real', name: 'Real', overrides: [{ node: 'users', key: 'throughput', value: 3600, provenance: 'derived' as const }] }];
    expect(s.reconcileDerivedScenarios(fresh)).toBe(true);
    expect(s.project().scenarios[0]!.overrides[0]!.value).toBe(3600); // re-tracked
    expect(s.reconcileDerivedScenarios(fresh)).toBe(false); // idempotent ⇒ no change, no emit
    // NON-UNDOABLE: one undo reverts the declareScenario (the reconcile pushed no frame of its own)
    expect(s.undo()).toBe(true);
    expect(s.project().scenarios).toEqual([]);
  });

  it('declares request classes over an each-to-each mesh, round-trips them, and evaluates each class over its own wires', () => {
    // The owner's each-to-each case: A↔B is a CYCLIC drawing that one river refuses,
    // but two acyclic classes — "order" (A→B) and "report" (B→A) — compute honestly over the shared nodes.
    const s = new Studio(registry, commonManifests);
    must(s.dispatch({ kind: 'addComponent', id: 'A', type: 'compute.service' }));
    must(s.dispatch({ kind: 'addComponent', id: 'B', type: 'compute.service' }));
    must(s.dispatch({ kind: 'connect', from: ['A', 'out'], to: ['B', 'in'] }));
    must(s.dispatch({ kind: 'connect', from: ['B', 'out'], to: ['A', 'in'] }));

    // declare the "order" class over A→B (A originates 800 req/s); build "report" incrementally to prove the
    // membership/origin edit commands, then round-trip the whole document.
    must(s.dispatch({ kind: 'declareClass', decl: { id: 'order', wires: [{ from: ['A', 'out'], to: ['B', 'in'] }], origins: [{ node: 'A', rps: 800 }] } }));
    must(s.dispatch({ kind: 'declareClass', decl: { id: 'report', wires: [], origins: [] } }));
    must(s.dispatch({ kind: 'setClassMembership', class: 'report', from: ['B', 'out'], to: ['A', 'in'], member: true }));
    must(s.dispatch({ kind: 'setClassOrigin', class: 'report', node: 'B', rps: 500 }));
    expect(s.project().requestClasses.map((c) => c.id)).toEqual(['order', 'report']);

    // declaring a class whose wire is not drawn is refused with a guided message (membership is structural)
    expect(s.dispatch({ kind: 'declareClass', decl: { id: 'ghost', wires: [{ from: ['A', 'out'], to: ['Z', 'in'] }], origins: [] } }).ok).toBe(false);

    // ROUND-TRIP: plain arrays/tuples ⇒ no Map handling; the classes survive serialize → deserialize verbatim.
    const back = deserialize(serialize(s.project()));
    if (!back.ok) throw new Error(back.error);
    expect(back.value.schema).toBe(11);
    expect(back.value.requestClasses).toEqual(s.project().requestClasses);

    // EVALUATE per class over the cyclic mesh — each class flows along its own acyclic wires (headroom regime).
    const e = s.evaluate();
    if (!e.ok) throw new Error(e.error.join('; '));
    expect(e.value.classes.map(String)).toEqual(['order', 'report']);
    const tput = keys.throughput;
    expect(e.value.value(NodeId('B'), tput, ClassId('order'))).toBe(800); // A originates order → B serves 800
    expect(e.value.value(NodeId('A'), tput, ClassId('report'))).toBe(500); // B originates report → A serves 500

    // renameNode rewrites BOTH the class origins and the wire-membership refs (never dangles the commodity)
    must(s.dispatch({ kind: 'renameNode', id: 'A', to: 'Orders' }));
    const order = s.project().requestClasses.find((c) => c.id === 'order');
    expect(order?.origins[0]?.node).toBe('Orders');
    expect(order?.wires[0]?.from[0]).toBe('Orders');
    const report = s.project().requestClasses.find((c) => c.id === 'report');
    expect(report?.wires[0]?.to[0]).toBe('Orders'); // B→A rewritten to B→Orders

    // disconnecting a wire prunes it from every class's membership (a class names EXISTING wires only)
    must(s.dispatch({ kind: 'disconnect', from: ['B', 'out'], to: ['Orders', 'in'] }));
    expect(s.project().requestClasses.find((c) => c.id === 'report')?.wires).toEqual([]);

    must(s.dispatch({ kind: 'removeClass', id: 'order' }));
    expect(s.project().requestClasses.map((c) => c.id)).toEqual(['report']);
  });

  it('groups nodes as a visual boundary without touching the computed graph', () => {
    const s = new Studio(registry, commonManifests);
    s.dispatch({ kind: 'addComponent', id: 'app', type: 'compute.service', x: 100, y: 100 });
    s.dispatch({ kind: 'addComponent', id: 'pg', type: 'db.postgres', x: 300, y: 100 });
    must(s.dispatch({ kind: 'addGroup', id: 'tier', label: 'Backend', x: 60, y: 60, w: 460, h: 200 }));
    must(s.dispatch({ kind: 'assignGroup', node: 'app', group: 'tier' }));
    must(s.dispatch({ kind: 'assignGroup', node: 'pg', group: 'tier' }));
    expect(s.project().groups[0]?.members).toEqual(['app', 'pg']);

    // moving the group carries its members along (absolute layout shifts by the same delta)
    s.dispatch({ kind: 'moveGroup', id: 'tier', x: 160, y: 60 });
    expect(s.project().layout['app']).toEqual({ x: 200, y: 100 });

    // a node belongs to at most one group; reassigning removes it from the old one
    s.dispatch({ kind: 'addGroup', id: 'edge', label: 'Edge', x: 0, y: 400, w: 300, h: 200 });
    s.dispatch({ kind: 'assignGroup', node: 'app', group: 'edge' });
    expect(s.project().groups.find((g) => g.id === 'tier')?.members).toEqual(['pg']);
    expect(s.project().groups.find((g) => g.id === 'edge')?.members).toEqual(['app']);

    // groups are presentation only — they never appear in the engine graph
    const g = s.graph();
    if (!g.ok) throw new Error('graph build failed');
    expect([...g.value.nodes.keys()].map(String).sort()).toEqual(['app', 'pg']);

    // removing a node ungroups it; removing a group keeps its members
    s.dispatch({ kind: 'removeNode', id: 'app' });
    expect(s.project().groups.find((g) => g.id === 'edge')?.members).toEqual([]);
    s.dispatch({ kind: 'removeGroup', id: 'tier' });
    expect(s.project().groups.map((g) => g.id)).toEqual(['edge']);
    expect(s.project().instances.map((i) => i.id)).toEqual(['pg']);

    // groups survive the export/reload round-trip
    const back = deserialize(serialize(s.project()));
    if (!back.ok) throw new Error(back.error);
    expect(back.value.groups[0]?.label).toBe('Edge');
  });

  it('migrates a schema-1 export: legacy port `protocol` folds into the accepts/speaks lists', () => {
    // a saved v1 project with a custom component in the OLD port shape (protocol + optional extras)
    const v1 = JSON.stringify({
      schema: 1,
      id: 'p1',
      name: 'old',
      instances: [],
      wires: [],
      layout: {},
      labels: {},
      descriptions: {},
      groups: [],
      components: [
        {
          type: 'custom.legacy',
          ports: [
            { name: 'in', dir: 'in', protocol: 'sns', accepts: ['aws-api', 'https'] },
            { name: 'out', dir: 'out', protocol: 'sns' },
          ],
        },
      ],
    });
    const r = deserialize(v1);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.schema).toBe(11);
    const ports = r.value.components[0]?.ports ?? [];
    // the FULL migration chain ran: v1 folds `protocol` first into the list; v2 renames the retired
    // `aws-api` id to `https` (deduplicated against the https already present)
    expect(ports[0]).toEqual({ name: 'in', dir: 'in', accepts: ['sns', 'https'] });
    expect(ports[1]).toEqual({ name: 'out', dir: 'out', speaks: ['sns'] });
  });

  it('defines, uses, and protects project-scoped custom components', () => {
    const s = new Studio(registry, commonManifests);
    must(s.dispatch({
      kind: 'defineComponent',
      manifest: {
        type: 'custom.edge',
        ports: [{ name: 'in', dir: 'in', accepts: ['http'] }],
        config: [{ key: keys.throughput, value: 7777, unit: 'req/s' }],
      },
    }));
    expect(s.componentTypes()).toContain('custom.edge');
    expect(s.dispatch({ kind: 'defineComponent', manifest: { type: '', ports: [] } as never }).ok).toBe(false);

    // the custom type is placeable and flows through the engine like any catalogue component
    must(s.dispatch({ kind: 'addComponent', id: 'e', type: 'custom.edge' }));
    expect(s.graph().ok).toBe(true);

    // can't delete a definition while an instance still uses it
    expect(s.dispatch({ kind: 'removeComponentDef', type: 'custom.edge' }).ok).toBe(false);
    must(s.dispatch({ kind: 'removeNode', id: 'e' }));
    must(s.dispatch({ kind: 'removeComponentDef', type: 'custom.edge' }));
    expect(s.componentTypes()).not.toContain('custom.edge');
  });

  it('renames a node and rewrites every reference', () => {
    const s = new Studio(registry, commonManifests);
    s.dispatch({ kind: 'addComponent', id: 'app', type: 'compute.service', x: 1, y: 2 });
    s.dispatch({ kind: 'addComponent', id: 'pg', type: 'db.postgres' });
    s.dispatch({ kind: 'connect', from: ['app', 'db'], to: ['pg', 'in'] });
    s.dispatch({ kind: 'addGroup', id: 'g', label: 'Tier', x: 0, y: 0, w: 10, h: 10 });
    s.dispatch({ kind: 'assignGroup', node: 'app', group: 'g' });

    must(s.dispatch({ kind: 'renameNode', id: 'app', to: 'checkout api' }));
    const d = s.project();
    expect(d.instances.map((i) => i.id).sort()).toEqual(['checkout api', 'pg']);
    expect(d.wires[0]?.from).toEqual(['checkout api', 'db']); // wire endpoints rewritten
    expect(d.layout['checkout api']).toEqual({ x: 1, y: 2 }); // layout key moved
    expect(d.layout['app']).toBeUndefined();
    expect(d.groups[0]?.members).toEqual(['checkout api']); // group membership rewritten
    expect(s.graph().ok).toBe(true); // still compiles

    expect(s.dispatch({ kind: 'renameNode', id: 'pg', to: 'checkout api' }).ok).toBe(false); // collision
    expect(s.dispatch({ kind: 'renameNode', id: 'pg', to: '  ' }).ok).toBe(false); // empty
  });

  it('sets a friendly label without changing the stable id', () => {
    const s = new Studio(registry, commonManifests);
    s.dispatch({ kind: 'addComponent', id: 'cache1', type: 'cache.redis' });
    must(s.dispatch({ kind: 'setLabel', id: 'cache1', label: 'Session cache' }));
    expect(s.project().labels['cache1']).toBe('Session cache');
    expect(s.project().instances[0]?.id).toBe('cache1'); // id unchanged
    must(s.dispatch({ kind: 'setLabel', id: 'cache1', label: '   ' })); // empty clears the override
    expect(s.project().labels['cache1']).toBeUndefined();
    // removing the node drops its label too
    s.dispatch({ kind: 'setLabel', id: 'cache1', label: 'X' });
    s.dispatch({ kind: 'removeNode', id: 'cache1' });
    expect(s.project().labels['cache1']).toBeUndefined();
  });

  it('sets and clears an SLO requirement on a node', () => {
    const s = new Studio(registry, commonManifests);
    s.dispatch({ kind: 'addComponent', id: 'pg', type: 'db.postgres' });
    must(s.dispatch({ kind: 'setSLO', node: 'pg', key: keys.latency, band: { shape: 'minTargetMax', max: 30 } }));
    expect(s.project().instances[0]?.bands?.some((b) => b.key === keys.latency)).toBe(true);
    must(s.dispatch({ kind: 'clearSLO', node: 'pg', key: keys.latency }));
    expect(s.project().instances[0]?.bands?.some((b) => b.key === keys.latency)).toBe(false);
  });

  it('emits change events to subscribers', () => {
    const s = new Studio(registry, commonManifests);
    let n = 0;
    const off = s.onChange(() => { n += 1; });
    s.dispatch({ kind: 'addComponent', id: 'a', type: 'cache.redis' });
    s.undo();
    off();
    s.dispatch({ kind: 'addComponent', id: 'b', type: 'cache.redis' });
    expect(n).toBe(2); // dispatch + undo fired; nothing after unsubscribe
  });
});
