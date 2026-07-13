import { type Band, type Result, err, ok } from '@sda/engine-core';
import { allManifests, classDeclProblems, keys, receivesWork, scenarioProblems, type AssumptionScenario, type GuaranteeSlo, type Instance, type LagSlo, type Manifest, type ManifestBand, type RequestClassDecl, type SystemPromise, type Wire } from '@sda/content';

/**
 * The project Document — the serializable single source of truth. It holds the placed
 * component INSTANCES, their wiring, and any project-embedded custom component DEFINITIONS, so a saved
 * project is self-contained. `schema` versions the format for migration; the file IS the backup.
 */
/**
 * A visual GROUP / boundary (a VPC, an availability zone, a logical tier, a C4 boundary). Purely
 * organizational: it frames member nodes and carries a label, and is persisted/exported — but it is
 * NOT a component and never enters the computed graph (the engine stays domain-agnostic). `members`
 * are node ids; a node belongs to at most one group.
 */
export interface Group {
  readonly id: string;
  readonly label: string;
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly members: readonly string[];
}

export interface ProjectDoc {
  readonly schema: 11;
  readonly id: string;
  readonly name: string;
  readonly instances: readonly Instance[];
  readonly wires: readonly Wire[];
  /** Canvas positions per node id (presentation; persisted so a reopened project keeps its layout). */
  readonly layout: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  /** Friendly display names per node id (presentation; the id stays the stable unique identifier). */
  readonly labels: Readonly<Record<string, string>>;
  /** One-line descriptions per node id (presentation; what this component is FOR in this design). */
  readonly descriptions: Readonly<Record<string, string>>;
  /** Visual grouping boundaries (presentation; never part of the computed graph). */
  readonly groups: readonly Group[];
  /** Project-scoped custom component definitions (override/extend the shared catalogue). */
  readonly components: readonly Manifest[];
  /** Per-FLOW qualitative guarantee requirements, keyed by the flow's
   *  (source, terminal) node ids + the dimension. A guarantee is a property of a PATH, not a node, so it cannot ride
   *  on `Instance.bands` (which are numeric, node-keyed) — it is a separate additive container. Absent ⇒ the whole
   *  guarantee-requirement feature is silent (the no-filler rule). Plain strings, so the round-trip needs no Map handling. */
  readonly guaranteeSlos: readonly GuaranteeSlo[];
  /** Per-FLOW numeric propagation-lag requirements, keyed by the flow's
   *  (source, terminal) node ids. Lag is a property of a PATH — the async-inclusive journey time — so like the
   *  guarantee SLO it is a separate additive container, NOT an `Instance.bands` entry (which cuts at async). Absent
   *  ⇒ the whole lag-SLO feature is silent (no-filler). Plain data (two ids + a number) ⇒ no Map handling. This is
   *  the schema-4 addition; a schema ≤3 export simply has none and loads with an empty list (client-persistence). */
  readonly lagSlos: readonly LagSlo[];
  // SCHEMA-5 ADDITION: per-instance uncertainty RANGES ride INSIDE each Instance
  // (`Instance.ranges`, keyed by config key) — like `config`/`transforms`, not a top-level container — so there is
  // no new ProjectDoc field. A soft input declares it is a range, not a point, and a Monte-Carlo run draws from it.
  // A schema ≤4 export simply has no `ranges` on any instance and loads unchanged (additive, client-persistence).
  /** SCHEMA-6 ADDITION: the declared REQUEST CLASSES — named multi-commodity flows over a
   *  shared, possibly cyclic topology, each with its own acyclic wire membership and per-node origins. A separate
   *  additive top-level container (like `guaranteeSlos`/`lagSlos`), NOT a per-instance field: a class is a property
   *  of the whole design's traffic, not of one node. Plain arrays/tuples (a wire ref is `{from:[id,port], to:[id,
   *  port]}`) ⇒ the round-trip needs no Map handling. ABSENT ⇒ the single implicit river: the design evaluates
   *  bit-for-bit as today (the additive default, zero migration). A schema ≤5 export simply has none and loads with
   *  an empty list. Content lowers these to the engine's `RequestClass[]` (`compileClasses`) where it builds the graph. */
  readonly requestClasses: readonly RequestClassDecl[];
  /** SCHEMA-7 ADDITION: the declared NAMED WORLDS (scenarios) — each a name plus a set
   *  of overrides on the fact-assumption inputs (a point in the assumption space). A separate additive top-level
   *  container (like `requestClasses`/`lagSlos`), NOT a per-instance field: a world holds beliefs across every node,
   *  not one node's data. Plain arrays ⇒ the round-trip needs no Map handling. ABSENT ⇒ no named worlds: the base
   *  layer IS the design, evaluated once — today, bit-for-bit (the additive default, zero migration). A schema ≤6
   *  export simply has none and loads with an empty list. Content lowers each world to the contract's `Scenario`
   *  (`toContractScenario`) for the ambient all-world `EvaluateBatch`. Overrides are restricted to role=fact-assumption
   *  keys — validated on load (`scenarioProblems`) with a guided error naming the key's actual role otherwise. */
  readonly scenarios: readonly AssumptionScenario[];
  // SCHEMA-8 ADDITION: the `generate` port function (level + optional 24 h curve) rides in
  // the very containers the transform family already serializes (a manifest port's `transform`, an Instance's
  // `transforms`) — a NEW UNION MEMBER, no new field, so the bump is additive like every one before it. A schema
  // ≤7 export has no generator anywhere; its node-level `assumedRps` is SUGAR the load migration compiles to a
  // generator on the node's primary out port (the legacy demand-key chain's fourth link — see
  // `migrateOriginToGenerator`), and a schema-8 file with no generators round-trips byte-identically.
  // SCHEMA-11 CHANGE: the `generate` transform's optional `curve` payload became `cycles`
  // (a list of periodic stages/cycles) plus a `disable` flag — a TYPE SWAP inside the same union member, no new
  // container. Because NO shipped export ever carried a generator `curve` (schema ≤10 files hold at most flat
  // sugar-migrated generators), there is ZERO data migration: those flat generators map to empty `cycles` = a
  // flat generator = today, bit-for-bit. So the bump is a pure guard/version bump, not a data migration.
  /** SCHEMA-9 ADDITION (owner ruling: cost is for THE WHOLE SYSTEM): the declared SYSTEM-scoped promises — each a
   *  band on a whole-design quantity (v1: `cost`, the monthly bill of every component, off-path branches included).
   *  A separate additive top-level container (the `lagSlos` discipline), NOT an `Instance.bands` entry: a system
   *  quantity belongs to no node, so a node band (a BRANCH's accumulated value) cannot carry it. Keyed by registry
   *  key — ONE promise per key, replace-in-place. Plain data `{ key, band }` (a cost band is minTargetMax; a future
   *  percentile band would ride the existing Map tagging) ⇒ lossless round-trip. ABSENT ⇒ empty (no-filler): a
   *  schema ≤8 export (every committed one) has none and loads with an empty list — zero migration. Judged by
   *  content `systemPromiseVerdicts` against the SAME whole-graph total the search's `Objective.total` sums. */
  readonly systemPromises: readonly SystemPromise[];
  // SCHEMA-10 WAS the FLOW-scoped promises container (`flowPromises`, tail: an end-to-end availability
  // floor keyed by source→terminal). It has been CONSOLIDATED AWAY (owner ruling): an end-to-end availability
  // promise is judged against `value(terminal, availability)` — the terminal's CUMULATIVE cell, the serial product
  // over the whole path (registry: availability aggregates `series:'product'`, `onAsyncEdge:'carry'`), which a NODE
  // band on the terminal captures EXACTLY (the source never entered the judged number). So the redundant container
  // is gone; an end-to-end availability promise is simply an `availability` band on the terminal node (`setSLO`).
  // A schema-10 export still LOADS: `migrateFlowPromisesToNodeBands` folds each old availability flow promise onto
  // its terminal node's `bands` (the identical judged quantity), preserving the promise as data — see deserialize.
}

export const emptyProject = (id: string, name: string): ProjectDoc => ({
  schema: 11,
  id,
  name,
  instances: [],
  wires: [],
  layout: {},
  labels: {},
  descriptions: {},
  groups: [],
  components: [],
  guaranteeSlos: [],
  lagSlos: [],
  requestClasses: [],
  scenarios: [],
  systemPromises: [],
});

// Maps do NOT survive JSON: `JSON.stringify(new Map([['p99', 300]]))` is `"{}"` — every entry is silently lost.
// A percentile (p99) SLO band carries its `targets` as a Map, so a naive round-trip drops the SLO and the reopened
// project crashes reading `band.targets.get(...)`. We tag Maps on the way out and revive them on the way in, so the
// format is truly LOSSLESS (and stays stable/diffable). Tagged form: `{ "__map": [[k, v], …] }`.
const MAP_TAG = '__map';
const mapReplacer = (_key: string, value: unknown): unknown =>
  value instanceof Map ? { [MAP_TAG]: [...(value as Map<unknown, unknown>).entries()] } : value;
const mapReviver = (_key: string, value: unknown): unknown =>
  value !== null && typeof value === 'object' && Array.isArray((value as Record<string, unknown>)[MAP_TAG])
    ? new Map((value as Record<string, [unknown, unknown][]>)[MAP_TAG])
    : value;

/** Serialize the document to a stable, diffable JSON string (the export/backup format). Maps (percentile SLO
 *  targets) are tagged so the round-trip is lossless — see `mapReplacer`. */
export function serialize(doc: ProjectDoc): string {
  return JSON.stringify(doc, mapReplacer, 2);
}

/** Parse and validate a document; honest error rather than a corrupt load. */
export function deserialize(json: string): Result<ProjectDoc, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json, mapReviver);
  } catch (e) {
    return err(`not valid JSON: ${String(e)}`);
  }
  // `flowPromises` is a RETIRED schema-10 container (consolidated into a terminal availability node band) — it is no
  // longer on `ProjectDoc`, so it is typed HERE as a legacy read the migration folds forward (see migrateFlowPromisesToNodeBands).
  const d = parsed as Omit<Partial<ProjectDoc>, 'schema'> & { schema?: number; flowPromises?: readonly LegacyFlowPromise[] };
  if (d === null || typeof d !== 'object') return err('document is not an object');
  if (d.schema !== 1 && d.schema !== 2 && d.schema !== 3 && d.schema !== 4 && d.schema !== 5 && d.schema !== 6 && d.schema !== 7 && d.schema !== 8 && d.schema !== 9 && d.schema !== 10 && d.schema !== 11) return err(`unsupported schema version ${String(d.schema)} (expected 1..11)`);
  if (typeof d.id !== 'string' || typeof d.name !== 'string') return err('missing id/name');
  if (!Array.isArray(d.instances) || !Array.isArray(d.wires)) {
    return err('missing instances/wires arrays');
  }
  const layout = d.layout !== undefined && d.layout !== null && typeof d.layout === 'object' ? d.layout : {};
  const labels = d.labels !== undefined && d.labels !== null && typeof d.labels === 'object' ? d.labels : {}; // additive
  const descriptions = d.descriptions !== undefined && d.descriptions !== null && typeof d.descriptions === 'object' ? d.descriptions : {}; // additive
  const groups = Array.isArray(d.groups) ? d.groups : []; // additive field; older schema-1 docs simply have none
  // migrations run as a CHAIN, oldest first — each is lossless and idempotent:
  //   1 → 2: a custom component's port carried `protocol` + optional extras; fold it into the flat lists
  //          (`accepts` for in/bi, `speaks` for out/bi, protocol FIRST = the natural protocol).
  //   2 → 3: protocol ids renamed to their OFFICIAL names (pg→postgresql, mongo→mongodb, redis→resp,
  //          ws→websocket, aws-api→https) and the invented `sql` expanded to the real SQL family.
  // `components` is ADDITIVE like layout/labels: a minimal hand-written document (a human's — or an AI
  // agent's — most likely authoring shape) is a legal document; absent containers mean empty, never invalid.
  let components = (Array.isArray(d.components) ? d.components : []) as Manifest[];
  if (d.schema === 1) components = components.map(migratePortsV1);
  if (d.schema <= 2) components = components.map(migrateProtocolIdsV2);
  // KEY-RENAME MIGRATION (originRps → assumedRps AND demandRps → assumedRps) — the universal traffic-origin registry
  // key was renamed TWICE by owner-ordered bad-design fixes: first `originRps` → `demandRps`, then `demandRps` →
  // `assumedRps` (it is a fact-ASSUMPTION about the world's traffic, not a "demand" nor an abstract "origin"). BOTH
  // legacy names map forward to `assumedRps`. Unlike the protocol migrations above it is NOT gated to one schema
  // version: a legacy key can ride on ANY export — on an instance's `config` or uncertainty `ranges`, and on a
  // scenario override's `key` — so `migrateDemandKey` maps every occurrence forward for every schema, BEFORE the
  // class/scenario validators and the evaluation read them. A historical backup therefore loads, evaluates
  // IDENTICALLY (the same value under the new key) and re-serialises under `assumedRps`. Additive + idempotent, and
  // kept FOREVER (client-persistence — "the export file is the real backup"): every export ever written keeps
  // opening. This function is the ONE code surface (besides its test) permitted to name the legacy keys — the rename
  // guard asserts they appear nowhere else.
  const { instances: renamed, scenarios: demandKeyScenarios } = migrateDemandKey(d.instances as Instance[], (Array.isArray(d.scenarios) ? d.scenarios : []) as AssumptionScenario[]);
  const componentsForPorts = components; // project-embedded custom manifests win over the shared catalog below
  // THE CHAIN'S FIFTH LINK: a PURE SOURCE's `throughput`-as-workload convenience preset (client.*'s
  // historical demand knob) folds onto the universal `assumedRps` origin knob — see `migrateClientThroughputToAssumedRps`
  // below for the full rationale. Runs AFTER the legacy-key rename (so a demand value already flowed onto
  // `assumedRps`/`throughput` under its final name) and BEFORE the generator fold (so a client's demand stays a
  // plain, directly-editable config knob — never swept into a generator transform; see that migration's own
  // `receivesWork` gate for why a dedicated source is excluded from it).
  const { instances: unifiedDemand, scenarios } = migrateClientThroughputToAssumedRps(renamed, demandKeyScenarios, componentsForPorts);
  // THE CHAIN'S FOURTH LINK: a SOURCE node's `assumedRps` config is SUGAR for a generator —
  // compile it to `generate(level)` on the node's primary out port, so every historical export re-serialises in
  // the canonical schema-8 form while evaluating IDENTICALLY (the generator physics is a superset of the origin
  // fold — property-pinned in @sda/content generator.e2e.test.ts). Runs AFTER the key rename so all legacy names
  // (`originRps` / `demandRps` / `assumedRps`) flow through one migration. Lossless, idempotent, kept forever.
  const instances = migrateOriginToGenerator(unifiedDemand, d.wires as Wire[], componentsForPorts);
  // Guarantee requirements are ADDITIVE like groups/components: an older document (or a minimal hand-written one)
  // simply has none. Plain strings ⇒ no Map revival needed. Kept as data even if a (source, terminal) later dangles
  // (the verdict layer reports that honestly as `unknown`), never dropped on load.
  const guaranteeSlos = (Array.isArray(d.guaranteeSlos) ? d.guaranteeSlos : []) as GuaranteeSlo[];
  // Lag requirements (schema 4) are ADDITIVE the same way: a schema ≤3 export (every committed one, and every
  // hand-written doc) has no `lagSlos` field, so it loads with an empty list — old exports open unchanged. Plain
  // data ⇒ no Map revival; a dangling (source, terminal) is reported honestly as `unknown`, never dropped on load.
  const lagSlos = (Array.isArray(d.lagSlos) ? d.lagSlos : []) as LagSlo[];
  // Schema 5 adds per-instance uncertainty RANGES INSIDE each Instance
  // (`Instance.ranges`), so there is no new top-level field to migrate — a schema ≤4 export simply has no `ranges`
  // on any instance and rides through `d.instances` unchanged (additive, exactly like a new optional config knob).
  // Schema 6 adds the top-level REQUEST CLASSES container — ADDITIVE like guaranteeSlos/
  // lagSlos: a schema ≤5 export (every committed one) has no `requestClasses` and loads with an empty list, so it
  // means the single implicit river, bit-for-bit. Unlike a lag/guarantee endpoint (a soft `unknown` when it
  // dangles), a class's membership is STRUCTURAL — it defines the commodity — so a class naming a wire or node the
  // design does not contain is a CORRUPTION we reject honestly on load (naming the fix), never load-and-lie.
  const requestClasses = (Array.isArray(d.requestClasses) ? d.requestClasses : []) as RequestClassDecl[];
  if (requestClasses.length > 0) {
    const problems = classDeclProblems(instances, d.wires as Wire[], requestClasses);
    if (problems.length > 0) return err(`request classes: ${problems.join('; ')}`);
  }
  // Schema 7 adds the top-level NAMED WORLDS container — ADDITIVE like requestClasses/
  // lagSlos: a schema ≤6 export (every committed one) has no `scenarios` field and loads with an empty list, so it
  // means "no named worlds", bit-for-bit. Like a request class (and unlike a soft lag endpoint), a corrupt scenario
  // is rejected on load, but the corruption checked is the ROLE boundary: an override on a non-fact-assumption key
  // would silently do nothing (the tool must not lie), so `scenarioProblems` refuses it with a guided message. A
  // STALE node/key override is NOT a load error — it is a soft lens, reported-and-skipped at evaluate time (§4.2).
  // (`scenarios` was migrated + defaulted above alongside `instances`, so the legacy demand key is already forward.)
  if (scenarios.length > 0) {
    // The role boundary is a single mechanical check on the key's registry role (isFactAssumption) — 
    // retired the earlier node-context special case (a source client's demand is `assumedRps` directly, already
    // migrated forward above, so it needs no exception here). See `isScenarioOverridable`.
    const problems = scenarioProblems(scenarios, instances, d.wires as Wire[]);
    if (problems.length > 0) return err(`scenarios: ${problems.join('; ')}`);
  }
  // Schema 9 (owner ruling: cost is for THE WHOLE SYSTEM) adds the top-level SYSTEM PROMISES container — ADDITIVE
  // like lagSlos/scenarios: a schema ≤8 export (every committed one, and every hand-written doc) has no
  // `systemPromises` field and loads with an empty list, bit-for-bit. A promise on a key this version does not
  // judge is NOT a load error — it is kept as data and reported honestly as `unknown` at verdict time (the
  // lag-SLO dangling-endpoint discipline), never dropped on load.
  const systemPromises = (Array.isArray(d.systemPromises) ? d.systemPromises : []) as SystemPromise[];
  // Schema 10 WAS the top-level FLOW PROMISES container (`flowPromises`, tail). It has been CONSOLIDATED
  // AWAY: an end-to-end availability promise is a NODE band on the terminal (`value(terminal, availability)` is the
  // serial product over the whole path — the identical judged quantity, the source never entered it). A schema-10
  // export still loads losslessly: `migrateFlowPromisesToNodeBands` FOLDS each old `availability` flow promise onto
  // its terminal node's `bands` (unless the terminal already declares one — the existing band wins), so the promise
  // survives as the SAME quantity in its one true home. A promise whose terminal the design no longer contains is
  // dropped honestly (it could never be judged anyway — the lag-SLO dangling discipline). A schema ≤9 export has no
  // `flowPromises` field and is untouched. This migration is kept FOREVER (client-persistence — the export is the
  // backup): every historical schema-10 file keeps opening and evaluates identically.
  const withFolded = migrateFlowPromisesToNodeBands(instances, Array.isArray(d.flowPromises) ? d.flowPromises : []);
  return ok({ schema: 11, id: d.id, name: d.name, instances: withFolded, wires: d.wires, layout, labels, descriptions, groups, components, guaranteeSlos, lagSlos, requestClasses, scenarios, systemPromises });
}

// ─── SCHEMA-10 FLOW-PROMISE CONSOLIDATION (flowPromises → a terminal availability node band) ──────────────────────
// The retired `flowPromises` container held ONE quantity: an end-to-end availability floor keyed by (source,
// terminal). It was judged against `value(terminal, availability)` — the terminal's CUMULATIVE availability cell,
// the serial product of every dependency on the path (registry: availability aggregates `series:'product'`,
// `onAsyncEdge:'carry'`). That cell IS what a NODE `availability` band on the terminal is judged against, and the
// promise's `source` never entered the number — so a flow availability promise and a terminal node band are the
// SAME judged quantity. On load we therefore fold each old availability flow promise onto its terminal's `bands`.
// NARROW + honest: only `availability` promises with a real terminal are folded (the only key the container ever
// carried); the terminal's EXISTING band wins (no silent overwrite); a promise whose terminal the design no longer
// contains is dropped (it was un-judgeable anyway). Idempotent (a schema ≥11 file has no `flowPromises` to fold).
type LegacyFlowPromise = { readonly source?: unknown; readonly terminal?: unknown; readonly key?: unknown; readonly band?: unknown };
function migrateFlowPromisesToNodeBands(instances: readonly Instance[], flowPromises: readonly LegacyFlowPromise[]): Instance[] {
  if (flowPromises.length === 0) return instances as Instance[];
  const AVAIL = String(keys.availability);
  // Collect the availability band to fold per terminal id (first promise per terminal wins — one band per key).
  const foldByTerminal = new Map<string, Band>();
  for (const p of flowPromises) {
    if (typeof p.terminal !== 'string' || String(p.key) !== AVAIL) continue;
    if (p.band === null || typeof p.band !== 'object') continue;
    if (!foldByTerminal.has(p.terminal)) foldByTerminal.set(p.terminal, p.band as Band);
  }
  if (foldByTerminal.size === 0) return instances as Instance[];
  return instances.map((inst) => {
    const band = foldByTerminal.get(inst.id);
    if (band === undefined) return inst;
    if ((inst.bands ?? []).some((b) => String(b.key) === AVAIL)) return inst; // the terminal's own band wins
    const folded: ManifestBand = { key: keys.availability, band };
    return { ...inst, bands: [...(inst.bands ?? []), folded] };
  });
}

/** Migrate one schema-1 manifest: fold each port's legacy `protocol` into the accepts/speaks lists. */
function migratePortsV1(m: Manifest): Manifest {
  type V1Port = { name: string; dir: 'in' | 'out' | 'bi'; protocol?: string; accepts?: readonly string[]; speaks?: readonly string[] };
  const fold = (own: string | undefined, list: readonly string[] | undefined): readonly string[] | undefined =>
    own === undefined ? list : [own, ...(list ?? []).filter((x) => x !== own)];
  const ports = (m.ports as readonly V1Port[]).map((p) => {
    const isIn = p.dir === 'in' || p.dir === 'bi';
    const isOut = p.dir === 'out' || p.dir === 'bi';
    const accepts = isIn ? fold(p.protocol, p.accepts) : p.accepts;
    const speaks = isOut ? fold(p.protocol, p.speaks) : p.speaks;
    return { name: p.name, dir: p.dir, ...(accepts ? { accepts } : {}), ...(speaks ? { speaks } : {}) };
  });
  return { ...m, ports };
}

/** Migrate one schema-≤2 manifest: rename legacy protocol ids to the official vocabulary (deduplicated). */
function migrateProtocolIdsV2(m: Manifest): Manifest {
  const RENAME: Readonly<Record<string, readonly string[]>> = {
    pg: ['postgresql'],
    mongo: ['mongodb'],
    redis: ['resp'],
    ws: ['websocket'],
    'aws-api': ['https'],
    sql: ['postgresql', 'mysql', 'tds', 'oracle-tns', 'odbc'], // "SQL" was a language, not a protocol — expand to the real family
  };
  const fix = (list: readonly string[]): readonly string[] => [...new Set(list.flatMap((id) => RENAME[id] ?? [id]))];
  const ports = m.ports.map((p) => ({ name: p.name, dir: p.dir, ...(p.accepts ? { accepts: fix(p.accepts) } : {}), ...(p.speaks ? { speaks: fix(p.speaks) } : {}) }));
  return { ...m, ports };
}

// ─── LEGACY DEMAND-KEY MIGRATION (originRps → assumedRps AND demandRps → assumedRps) ─────────────────────────────
// The universal traffic-origin registry key was renamed TWICE by owner-ordered bad-design fixes: first `originRps` →
// `demandRps`, then `demandRps` → `assumedRps` (the value is a fact-ASSUMPTION about the world's traffic, not a
// "demand" nor an abstract "origin"). BOTH legacy names map forward to the current key. Old exports carry a legacy
// key where a value keyed by a registry key can appear: an instance's `config`, an instance's uncertainty `ranges`,
// and a scenario override's `key`. These literals are the SINGLE code surface (besides the migration test) that may
// name a legacy key — the rename guard test asserts they appear nowhere else, so the old names cannot creep back.
const LEGACY_DEMAND_KEYS: readonly string[] = ['originRps', 'demandRps'];
const DEMAND_KEY = 'assumedRps';
const isLegacyDemandKey = (key: string): boolean => LEGACY_DEMAND_KEYS.includes(key);

/** Move any legacy-keyed entry in a key→value record (`config` / `ranges`) onto the current key, order-preserving, or
 *  return the SAME reference when there is nothing to migrate. Idempotent: a value already under the current key WINS,
 *  and if several legacy names are present the FIRST in document order wins — so a file can never carry the quantity
 *  under two names after this. */
function renameDemandKey<T>(rec: Readonly<Record<string, T>> | undefined): Readonly<Record<string, T>> | undefined {
  if (rec === undefined || !Object.keys(rec).some(isLegacyDemandKey)) return rec;
  const out: Record<string, T> = {};
  let assigned = Object.prototype.hasOwnProperty.call(rec, DEMAND_KEY); // the current key, if already present, wins
  for (const [k, v] of Object.entries(rec)) {
    if (isLegacyDemandKey(k)) {
      if (!assigned) { out[DEMAND_KEY] = v; assigned = true; } // move the first legacy across; drop any later legacy
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Map either legacy demand key (`originRps` / `demandRps`) forward to `assumedRps` across the instances (their
 * `config` + uncertainty `ranges`) and the scenario overrides (their `key`) — the pure, total, idempotent core of the
 * key-rename migration. Returns NEW arrays only where something changed (an untouched instance/scenario is returned by
 * reference, so a file without any legacy key round-trips byte-for-byte). Request-class origins carry a bare `rps` (no
 * key string), so they need no migration. Kept FOREVER (client-persistence): every historical backup keeps loading
 * and evaluates identically.
 */
// ─── CLIENT-THROUGHPUT-AS-DEMAND MIGRATION (throughput → assumedRps, the chain's FIFTH link �) ──────────
// A PURE SOURCE's demand (a `client.*` node's "convenience preset") historically rode on `config.throughput` —
// a SECOND demand mechanism alongside the universal `assumedRps`, and the one the SCENARIO engine could not reach:
// a named world / the derived trio overrides ONLY role=`fact-assumption` inputs (assumption-model §2/§4.1), while
// `throughput`'s GLOBAL role is `computed` (a served/emitted result on every OTHER node). Folding it onto
// `assumedRps` on load puts a source's declared demand under the ONE key every demand-facing surface reads —
// scenarios, the derived trio, the Inspector's "Generated load" knob, the generator sugar chain (the FOURTH link,
// below) — so a re-saved document is in the unified form. Wherever a value is keyed by a registry key: an
// instance's `config` + uncertainty `ranges` (the `migrateDemandKey` discipline), and a SCENARIO override's `key`
// (so a saved named world that overrode a client's declared demand keeps loading AND keeps moving something —
// post-unification `throughput` is never a live fixed cell on a dedicated source, so a stale key would silently
// stop working). NARROW + honest: a node is a candidate ONLY when its manifest does NOT receive work (no `in`/`bi`
// port — mirrors `instantiate`'s `throughputIsCapacity` gate exactly, so load-time migration and the runtime
// compatibility sugar draw the SAME line); a RELAY's `throughput` is a real capacity ceiling, untouched. An
// instance ALREADY declaring `assumedRps` keeps it (the newer, more specific knob wins — the legacy value is
// simply dropped, never overwriting an explicit override). An UNKNOWN type (no manifest in the project's
// components nor the shared catalog) is left alone — there is no port to check `receivesWork` against, and
// guessing would risk silently reinterpreting a real capacity as demand. Idempotent and lossless, kept FOREVER.
function isDedicatedSource(type: string, components: readonly Manifest[]): boolean {
  const byType = new Map(components.map((c) => [c.type, c]));
  const manifest = byType.get(type) ?? allManifests[type];
  return manifest !== undefined && !receivesWork(manifest);
}

/** Move a value from `from` onto `to` in a key→value record, KEEPING `to` if already present (never silently
 *  overwritten) and dropping `from`. Returns the SAME reference when there is nothing to migrate — idempotent, so
 *  an already-canonical file re-serialises byte-for-byte (no needless churn). */
function renameOnto<T>(rec: Readonly<Record<string, T>> | undefined, from: string, to: string): Readonly<Record<string, T>> | undefined {
  if (rec === undefined || !(from in rec)) return rec;
  const out: Record<string, T> = {};
  let assigned = Object.prototype.hasOwnProperty.call(rec, to);
  for (const [k, v] of Object.entries(rec)) {
    if (k === from) {
      if (!assigned) { out[to] = v; assigned = true; }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function migrateClientThroughputToAssumedRps(
  instances: readonly Instance[],
  scenarios: readonly AssumptionScenario[],
  components: readonly Manifest[],
): { instances: Instance[]; scenarios: AssumptionScenario[] } {
  const THROUGHPUT = String(keys.throughput);
  const ORIGIN = String(keys.assumedRps);
  const migratedInstances = instances.map((inst) => {
    if (!isDedicatedSource(inst.type, components)) return inst;
    const config = renameOnto(inst.config, THROUGHPUT, ORIGIN);
    const ranges = renameOnto(inst.ranges, THROUGHPUT, ORIGIN);
    if (config === inst.config && ranges === inst.ranges) return inst;
    return { ...inst, ...(config !== undefined ? { config } : {}), ...(ranges !== undefined ? { ranges } : {}) };
  });
  // A dedicated source's scenario override survives under the SAME key rename — even one that names a node with no
  // `config.throughput` override at all (the override was riding the manifest's OWN default), so it must be caught
  // independently of the per-instance rename above.
  const dedicatedSourceIds = new Set(instances.filter((i) => isDedicatedSource(i.type, components)).map((i) => i.id));
  const migratedScenarios = scenarios.map((s) =>
    (s.overrides ?? []).some((o) => o.key === THROUGHPUT && dedicatedSourceIds.has(o.node))
      ? { ...s, overrides: s.overrides.map((o) => (o.key === THROUGHPUT && dedicatedSourceIds.has(o.node) ? { ...o, key: ORIGIN } : o)) }
      : s,
  );
  return { instances: migratedInstances, scenarios: migratedScenarios };
}

// ─── ORIGIN-TO-GENERATOR MIGRATION (assumedRps → generate, the chain's FOURTH link — doc: load-curves §3) ────────
// A node-level `assumedRps` config is SUGAR for a generator port function: on load, a SOURCE node (no inbound
// wire) declaring `assumedRps > 0` gains `generate(level)` on its PRIMARY out port (the manifest's first out/bi
// port) and drops the config key — so the document re-serialises in the canonical schema-8 form. Behaviour-
// preserving BY CONSTRUCTION: content's `instantiate` lowers a generator to the exact same cells the sugar
// produced (the reconciled `assumedRps` input + the origin-fold relation), property-pinned in @sda/content
// generator.e2e.test.ts. Deliberately NARROW, each skip an honest no-op that keeps the still-legal sugar:
//   • a MID-CHAIN `assumedRps` (a node WITH inbound wires) stays a config — its historical scalar semantics
//     (origin counted in overflow, NOT emitted) differ from a generator's (emitted), so migrating it would
//     change numbers; the sugar remains supported and the architect upgrades by setting a generator explicitly;
//   • an UNKNOWN type (no manifest in the project's components nor the shared catalog) has no port to name;
// • a DEDICATED SOURCE (no `in`/`bi` port: `client.*` or any manifest whose whole job is to
//     originate) keeps its `assumedRps` as a plain, directly-editable "Generated load" knob (the Inspector's
//     node-context-aware label, app/presenter/src/node-detail.ts) — never generator-folded. This is the SAME line
// `instantiate`'s `throughputIsCapacity` already draws; it also keeps this migration a FIXPOINT once 
//     client-throughput sugar (above) has written `assumedRps` on such a node — the value must never oscillate
//     between "a config knob" and "a generator" across repeated save/load cycles;
//   • a node whose primary out port ALREADY carries a transform keeps it (a generate there already declares the
//     origin — the config would only fight it; any other transform occupies the slot);
//   • `assumedRps: 0` (an explicit inert origin) stays as-is — dropping it would be a silent edit for nothing.
// Uncertainty `ranges` and scenario overrides KEEP addressing `assumedRps` — that key remains the reconciled
// level cell (the one address worlds/MC manipulate), so nothing else in the file moves. Idempotent and lossless.
function migrateOriginToGenerator(instances: readonly Instance[], wires: readonly Wire[], components: readonly Manifest[]): Instance[] {
  const hasInbound = new Set(wires.map((w) => w.to[0]));
  const byType = new Map(components.map((c) => [c.type, c]));
  const ORIGIN = String(keys.assumedRps);
  return instances.map((inst) => {
    const level = inst.config?.[ORIGIN];
    if (level === undefined || !(level > 0) || hasInbound.has(inst.id)) return inst;
    const manifest = byType.get(inst.type) ?? allManifests[inst.type];
    if (manifest === undefined) return inst; // unknown type — no port to name, keep the (still legal) sugar, honestly
    if (!receivesWork(manifest)) return inst; // a dedicated source — stays a plain config knob (see the doc block above)
    const port = manifest.ports.find((p) => p.dir === 'out' || p.dir === 'bi');
    if (port === undefined) return inst; // no out port — keep the (still legal) sugar, honestly
    if (inst.transforms?.[port.name] !== undefined || port.transform !== undefined) return inst; // the slot is taken
    const config = { ...inst.config };
    delete config[ORIGIN];
    const { config: _dropped, ...rest } = inst; // no `"config": {}` artifact — canonical, like clearRange's field-drop discipline
    return {
      ...rest,
      ...(Object.keys(config).length > 0 ? { config } : {}),
      transforms: { ...inst.transforms, [port.name]: { kind: 'generate', level } },
    };
  });
}

function migrateDemandKey(
  instances: readonly Instance[],
  scenarios: readonly AssumptionScenario[],
): { instances: Instance[]; scenarios: AssumptionScenario[] } {
  const migratedInstances = instances.map((i) => {
    const config = renameDemandKey(i.config);
    const ranges = renameDemandKey(i.ranges);
    if (config === i.config && ranges === i.ranges) return i;
    return { ...i, ...(config !== undefined ? { config } : {}), ...(ranges !== undefined ? { ranges } : {}) };
  });
  const migratedScenarios = scenarios.map((s) =>
    (s.overrides ?? []).some((o) => isLegacyDemandKey(o.key))
      ? { ...s, overrides: s.overrides.map((o) => (isLegacyDemandKey(o.key) ? { ...o, key: DEMAND_KEY } : o)) }
      : s,
  );
  return { instances: migratedInstances, scenarios: migratedScenarios };
}
