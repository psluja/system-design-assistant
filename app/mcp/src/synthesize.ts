import { Key } from '@sda/engine-core';
import type { SolverBindings } from '@sda/solver-contract';
import { synthesize, provisioningTunables, quantizeKnob, keys, TARGET_UTILIZATION, specForNode, specFromSlots, ARCHETYPES, type SynthDeps, type Instance, type Wire, type SlotReq, type SloReq } from '@sda/content';
import type { Studio } from '@sda/core';
import type { AsyncToolDef, ToolResult } from './tools';
import { fail, json, obj, ok, READS, round } from './tool-kit';

// Size every synthesized/compared candidate with capacity headroom (ρ ≤ TARGET_UTILIZATION) — the SAME margin the
// backward-search (repair/optimize, the web's Improve) uses — so compare_options never ranks #1 a design sized to
// the ρ=1 knife-edge (throughput met, but the queue unbounded → ∞ latency) that the forward verdict then flags.
const HEADROOM = { key: keys.throughput, factor: TARGET_UTILIZATION } as const;

// compare_options — the in-app "run backwards / synthesize a choice" capstone (doc-4 §4): pick ONE node and
// let the engine enumerate every component TYPE that fits its wiring (clingo), SIZE each to meet its SLOs at
// the cheapest config (the in-process native solver; clingo still does the enumeration), and rank the
// survivors. The fair "Fargate vs Lambda vs ASG vs …" compare
// that forward mode cannot give — each alternative is sized to the workload, not priced at an arbitrary
// default. Candidates are DERIVED from the manifests' ports (anything that drops into the wiring), so the
// catalog stays the single source of truth and "anything can be an alternative to anything" holds. The solvers
// arrive as CONTRACT CAPABILITIES in a `SolverBindings` (docs/design/solver-contract.html §5) — the SAME record
// buildSearchTools takes, from the SAME composition root — so synthesis and search share ONE solver seam that
// switches implementations in one place, and can never drift onto two.
//
// The DOMAIN spec-builders (specForNode / specFromSlots / ARCHETYPES) live in @sda/content — this file is
// only the MCP tool glue: parse args, hand the spec + the bound capabilities to synthesize(), and format the
// ranked designs.

// ── loose parsers for the MCP tool args (the JSON-RPC layer hands us already-parsed objects) ──
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asObj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const parseFixed = (v: unknown): Instance[] =>
  asArr(v).map((x) => { const o = asObj(x); const cfg = asObj(o.config); const config: Record<string, number> = {}; for (const [k, val] of Object.entries(cfg)) config[k] = Number(val); return { id: String(o.id ?? ''), type: String(o.type ?? ''), ...(Object.keys(config).length > 0 ? { config } : {}) }; });
const parseSlots = (v: unknown): SlotReq[] => asArr(v).map((x) => { const o = asObj(x); return { id: String(o.id ?? ''), family: String(o.family ?? '') }; });
const parseWires = (v: unknown): Wire[] =>
  asArr(v).map((x) => (Array.isArray(x) ? { from: [String(x[0] ?? ''), String(x[1] ?? '')] as const, to: [String(x[2] ?? ''), String(x[3] ?? '')] as const } : ((o) => ({ from: [String(o.from ?? ''), String(o.fromPort ?? '')] as const, to: [String(o.to ?? ''), String(o.toPort ?? '')] as const }))(asObj(x))));
const parseSlos = (v: unknown): SloReq[] => asArr(v).map((x) => { const o = asObj(x); return { node: String(o.node ?? ''), key: String(o.key ?? ''), cmp: o.cmp === '>=' ? '>=' : '<=', value: Number(o.value) }; });

/** The synthesis MCP tools (`compare_options` / `synthesize` / `auto_architect`). Async — they await the bound
 *  Enumerate (clingo) + Optimize capabilities. Lives apart from the sync command tools so a shell registers them
 *  only once its cold solvers are wired. Same shape as buildSearchTools: the composition root hands in `SolverBindings`. */
export function buildSynthTools(studio: Studio, solvers: SolverBindings): AsyncToolDef[] {
  // synthesize() consumes THREE capabilities: Enumerate (topologies, clingo) + Optimize (size each candidate —
  // native by default, MiniZinc on rollback) + Evaluate (rank the forward fallback), all from this ONE bindings
  // record — never a second solver constructed here. The COLD capabilities are always bound by a real composition;
  // if a caller binds only `evaluate`, the tools report it honestly (mirrors search.ts's `needOptimize` guard)
  // rather than returning "no topology" when the truth is "no solver".
  const needEnumerate = solvers.enumerate;
  const needOptimize = solvers.optimize;
  const deps: SynthDeps | null =
    needEnumerate === undefined || needOptimize === undefined
      ? null
      : { enumerate: needEnumerate, evaluate: solvers.evaluate, optimize: needOptimize, tunables: provisioningTunables, headroom: HEADROOM };
  const NO_SOLVER = 'this server has no clingo/MIP solver bound — synthesis is unavailable';

  return [
    {
      name: 'compare_options',
      description:
        'Run backwards: for ONE node, enumerate every component type that FITS its wiring, SIZE each to meet its SLOs at the cheapest config, and rank the survivors by cost (or a chosen key, max/min). The fair "Fargate vs Lambda vs ASG vs …" comparison. Read-only — apply a winner with set_type then repair/optimize. e.g. {node:"svc"}',
      inputSchema: obj({ node: { type: 'string' }, key: { type: 'string' }, direction: { type: 'string', enum: ['min', 'max'] } }, ['node']),
      annotations: READS,
      run: async (a): Promise<ToolResult> => {
        const node = String(a.node ?? '');
        const doc = studio.project();
        const catalog = studio.mergedCatalog();
        const current = doc.instances.find((i) => i.id === node);
        if (current === undefined) return fail(`no node "${node}" in the design`);
        const key = a.key !== undefined ? Key(String(a.key)) : keys.cost;
        const direction = a.direction === 'max' ? 'max' : 'min';

        const spec = specForNode(catalog, doc.instances, doc.wires, node, { node, key, direction });
        if (!spec.ok) return fail(spec.error);
        if ((spec.value.slots[0] as { types: readonly string[] }).types.length <= 1) {
          return ok(`No alternative component type fits ${node}'s wiring (only ${current.type}).`);
        }

        if (deps === null) return fail(NO_SOLVER);
        const designs = await synthesize(catalog, spec.value, deps);
        if (designs.length === 0) return ok(`No option for ${node} can meet its SLOs.`);

        const preds = doc.wires.filter((w) => w.to[0] === node);
        // Read availability to 6 dp, not the 2-dp `round`, so a swap's meaningful nines (0.9995 vs 0.99) survive.
        const ratio = (n: number): number => Math.round(n * 1e6) / 1e6;
        const rows = designs.map((d) => {
          const total = d.value(node, key) ?? 0;
          // For cost (a SUM-aggregated key) report this node's OWN share, not the cumulative path total.
          const value = key === keys.cost ? total - preds.reduce((s, w) => s + (d.value(w.from[0], key) ?? 0), 0) : total;
          // Trade-off metrics, read straight off the SIZED design so a cheaper-but-weaker option is visibly
          // weaker on some axis BEFORE it is applied (availability/uptime + throughput this node serves).
          const avail = d.value(node, keys.availability);
          const tput = d.value(node, keys.throughput);
          return {
            type: d.selection[node],
            [String(key)]: round(value),
            overflow: round(d.value(node, keys.overflow) ?? 0),
            ...(avail !== undefined ? { availability: ratio(avail) } : {}),
            ...(tput !== undefined ? { throughput: round(tput) } : {}),
            sizing: d.assignments.filter((x) => String(x.node) === node).map((x) => ({ key: String(x.key), value: quantizeKnob(String(x.key), x.value) })),
          };
        });
        return json(rows);
      },
    },
    {
      name: 'synthesize',
      description:
        'Run backwards FROM A SPEC — the engine designs, you state intent (no per-component reasoning). Give `fixed` anchors ([{id,type,config?}], e.g. the client with its throughput), `slots` ([{id,family}] — a node to fill, constrained to a component family like "compute"/"db"/"cache"/"queue"), a `wires` template ([[fromId,fromPort,toId,toPort], …]) over both, and `slos` ([{node,key,cmp:"<="|">=",value}]). clingo enumerates every protocol-valid topology, the engine sizes each to meet the SLOs, and the top-K VERIFIED designs come back ranked by cost (or `objective`:{key,direction,node?}). Apply one with set_type per slot + the returned sizing (or apply_design). e.g. {fixed:[{id:"client",type:"client.web",config:{throughput:5000}}], slots:[{id:"svc",family:"compute"},{id:"db",family:"db"}], wires:[["client","out","svc","in"],["svc","db","db","in"]], slos:[{node:"db",key:"latency",cmp:"<=",value:300}]}',
      inputSchema: obj(
        {
          // Required first (least-input ordering): the slots to fill and the wiring template. Then the optional
          // anchors / SLOs / objective / limit.
          slots: { type: 'array', items: { type: 'object' } },
          wires: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          fixed: { type: 'array', items: { type: 'object' } },
          slos: { type: 'array', items: { type: 'object' } },
          objective: { type: 'object' },
          limit: { type: 'number' },
        },
        ['slots', 'wires'],
      ),
      annotations: READS,
      run: async (a): Promise<ToolResult> => {
        const catalog = studio.mergedCatalog();
        const objIn = asObj(a.objective);
        const objective = {
          ...(objIn.node !== undefined ? { node: String(objIn.node) } : {}),
          key: objIn.key !== undefined ? Key(String(objIn.key)) : keys.cost,
          direction: objIn.direction === 'max' ? ('max' as const) : ('min' as const),
        };
        const spec = specFromSlots(catalog, parseFixed(a.fixed), parseSlots(a.slots), parseWires(a.wires), parseSlos(a.slos), objective);
        if (!spec.ok) return fail(spec.error);

        if (deps === null) return fail(NO_SOLVER);
        const designs = await synthesize(catalog, spec.value, deps);
        if (designs.length === 0) return ok('No topology meets the SLOs. Loosen an SLO, raise a unit ceiling, or widen a slot family.');

        const limit = Math.max(1, Math.min(20, Number(a.limit ?? 5)));
        const objNode = spec.value.objective.node;
        const rows = designs.slice(0, limit).map((d) => ({
          selection: d.selection, // slot id → chosen component type
          cost: round(d.value(objNode, keys.cost) ?? 0), // total monthly cost of the whole design
          objective: round(d.objective),
          sizing: d.assignments.map((x) => ({ node: String(x.node), key: String(x.key), value: quantizeKnob(String(x.key), x.value) })),
        }));
        return json(rows);
      },
    },
    {
      name: 'auto_architect',
      description:
        'Design a verified, cost-optimal architecture FROM THE STATED GOAL ALONE — the fullest "state the goal, the engine designs". Give `throughput` (the workload, req/s), a `shape` archetype (one of: web · cached-read — default web), optional end-to-end `slos` ([{key,cmp:"<="|">=",value}], applied to the terminal), and `objective` ({key,direction}, default cost/min). The engine instantiates the archetype, clingo enumerates every protocol-valid filling, the engine sizes each to meet the SLOs, and the top-K VERIFIED designs come back ranked. Apply one with apply_design. e.g. {throughput:5000, shape:"web", slos:[{key:"latency",cmp:"<=",value:300}]}',
      inputSchema: obj({ throughput: { type: 'number' }, shape: { type: 'string' }, slos: { type: 'array', items: { type: 'object' } }, objective: { type: 'object' }, limit: { type: 'number' } }, ['throughput']),
      annotations: READS,
      run: async (a): Promise<ToolResult> => {
        const throughput = Number(a.throughput);
        if (!Number.isFinite(throughput) || throughput <= 0) return fail('`throughput` (req/s) is required and must be > 0');
        const shapeName = a.shape !== undefined ? String(a.shape) : 'web';
        const tmpl = ARCHETYPES[shapeName];
        if (tmpl === undefined) return fail(`unknown shape "${shapeName}". Known archetypes: ${Object.keys(ARCHETYPES).join(', ')}`);
        const catalog = studio.mergedCatalog();
        const objIn = asObj(a.objective);
        const objective = {
          node: tmpl.terminal,
          key: objIn.key !== undefined ? Key(String(objIn.key)) : keys.cost,
          direction: objIn.direction === 'max' ? ('max' as const) : ('min' as const),
        };
        const slos: SloReq[] = asArr(a.slos).map((x) => { const o = asObj(x); return { node: tmpl.terminal, key: String(o.key ?? ''), cmp: o.cmp === '>=' ? ('>=' as const) : ('<=' as const), value: Number(o.value) }; });
        const fixed: Instance[] = [{ id: 'client', type: 'client.web', config: { throughput } }];
        const spec = specFromSlots(catalog, fixed, tmpl.slots, [...tmpl.wires], slos, objective);
        if (!spec.ok) return fail(spec.error);

        if (deps === null) return fail(NO_SOLVER);
        const designs = await synthesize(catalog, spec.value, deps);
        if (designs.length === 0) return ok(`No "${shapeName}" design meets the SLOs at ${throughput} req/s. Loosen an SLO or try another shape.`);

        const limit = Math.max(1, Math.min(20, Number(a.limit ?? 5)));
        const rows = designs.slice(0, limit).map((d) => ({
          shape: shapeName,
          selection: d.selection, // slot id → chosen component type (the whole design)
          cost: round(d.value(tmpl.terminal, keys.cost) ?? 0),
          objective: round(d.objective),
          sizing: d.assignments.map((x) => ({ node: String(x.node), key: String(x.key), value: quantizeKnob(String(x.key), x.value) })),
        }));
        return json(rows);
      },
    },
  ];
}
