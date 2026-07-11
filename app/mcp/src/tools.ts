import { DimensionId, DimensionToken, Key, cyclesProblem, NodeId, type Band, type Cycle, type Stage } from '@sda/engine-core';
import { portsConnect, evaluate } from '@sda/engine-solve';
import { Studio, deserialize, serialize, type Command } from '@sda/core';
import { systemSummary, nodeQueues, realAwareVerdicts, timeSweep, peakLoadByNode, LOAD_STAGES_DEFAULTS, registry, flowGuarantees, guaranteeVerdicts, lagVerdicts, systemPromiseVerdicts, isSystemPromiseKey, SYSTEM_PROMISE_KEYS, rangeProblem, categorical, claimsFor, hasTrafficOrigin, cyclicFlowDiagnosis, roles, keys, protocolCompat, protocols, protocolIds, LOAD_STAGES_PRESETS, type EvaluateGraph, type GuaranteeSlo, type LagSlo, type LoadStagePreset, type Manifest, type Range, type RequestClassDecl, type WireRef } from '@sda/content';
import { didYouMean, EDITS, EDITS_HISTORY, fail, json, obj, ok, READS, REPLACES_SESSION, str } from './tool-kit';

/** The closed set of RESHAPING flow-transform functions (doc: flow-transformations §3). The sixth family member,
 *  `generate` (doc: load-stages §4), ORIGINATES flow instead of reshaping it and takes a level (+ optional cycles),
 *  so the tools validate it on its own branch; `TRANSFORM_FN_ENUM` is the full family the schema advertises. */
const TRANSFORM_FNS = ['ratio', 'batch', 'cap', 'window', 'prob'] as const;
const TRANSFORM_FN_ENUM = [...TRANSFORM_FNS, 'generate'] as const;

/** The six shipped generator PRESETS an agent can name on `set_transform fn:generate` (doc: load-stages §11, §16.3)
 *  — a one-call on-ramp to a real load shape, the same set the web dropdown and the VS Code picker offer. */
const GENERATOR_PRESET_ENUM = ['flat', 'spike', 'ramp-up', 'diurnal', 'on-off-burst', 'quarterly-report'] as const;

// The vocabulary the key-validating tools check against (F5, derived from the ROLE axis so it can never drift from
// the registry). An SLO targets a COMPUTED result or a DES-answered PROMISE — never an input knob; set_config sets a
// KNOWN key (any registry key, or a config knob a custom component declares). A typo (`latncy`) is refused with the
// closest match instead of being silently stored as a phantom the unchanged evaluate can't explain (the audit's F5/F6).
const SLO_KEYS = Object.entries(roles).filter(([, r]) => r.role === 'computed' || r.role === 'promise-target').map(([k]) => k);
const REGISTRY_KEYS = Object.keys(roles);

/** null when the wire is protocol-LEGAL, else the honest refusal — the SAME emit∩accept rule the canvas
 *  enforces on a drag (suggest/isValidConnection), so the AI cannot wire what a human cannot (one truth).
 *  Unknown types/ports return null: existence is validated elsewhere; this never double-reports. */
function illegalWire(catalog: Readonly<Record<string, Manifest>>, fromType: string, fromPort: string, toType: string, toPort: string): string | null {
  const f = catalog[fromType]?.ports.find((p) => p.name === fromPort);
  const t = catalog[toType]?.ports.find((p) => p.name === toPort);
  if (!f || !t) return null;
  const emits = f.speaks ?? [];
  const accepts = t.accepts ?? [];
  if (portsConnect(emits, accepts, protocolCompat)) return null;
  return `illegal wire: "${fromType}".${fromPort} speaks [${emits.join(', ')}] but "${toType}".${toPort} accepts [${accepts.join(', ')}] — no shared protocol. Pick a port that speaks what the target accepts (e.g. a generic "out" reaches aws-api/https backends; a "db" port is a SQL connection).`;
}

/** What a tool run returns: success flag + the text shown to the agent. */
export interface ToolResult {
  readonly ok: boolean;
  readonly text: string;
}
/** MCP tool annotations (spec rev 2025-03-26, `ToolAnnotations` in @modelcontextprotocol/sdk): the behavioral
 *  hints (read-only / destructive / idempotent / open-world) a client reads to decide how to gate a tool —
 *  auto-approve pure reads, confirm mutations, warn on destructive ones. Some strict clients treat a tool with
 *  NO annotations by the spec's aggressive defaults (destructive, open-world) and gate or even disable it, so
 *  EVERY SDA tool must declare them (schema-hygiene.test.ts lints it). Modeled as a union so an illegal state is
 *  unrepresentable: destructive/idempotent are meaningful ONLY on a non-read-only tool (per spec), and
 *  `openWorldHint` is the literal `false` — no SDA tool ever reaches beyond the session/workspace (no egress). */
export type ToolAnnotations =
  | { readonly readOnlyHint: true; readonly openWorldHint: false }
  | { readonly readOnlyHint: false; readonly destructiveHint: boolean; readonly idempotentHint: boolean; readonly openWorldHint: false };
/** A synchronous tool: a name, a JSON-Schema for its arguments, MCP behavior annotations, and a pure runner over the core. */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: ToolAnnotations;
  run(args: Record<string, unknown>): ToolResult;
}
/** An asynchronous tool (e.g. the backward-search modes that await the bound backward-search solver). */
export interface AsyncToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: ToolAnnotations;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}
/** Either tool shape, as the server consumes them uniformly (it awaits every run). */
export type AnyTool = ToolDef | AsyncToolDef;

/** Closest valid type ids to a mistyped one — so an `unknown type` error self-corrects instead of forcing
 *  the agent into a list_components round-trip. Scores by shared family (prefix before `.`) and token overlap. */
function suggestTypes(bad: string, all: readonly string[]): string[] {
  const fam = bad.split('.')[0] ?? bad;
  const toks = bad.toLowerCase().split(/[.\-_/]/).filter(Boolean);
  const score = (t: string): number => {
    const tl = t.toLowerCase();
    return (t.startsWith(fam + '.') ? 2 : 0) + toks.reduce((s, tk) => s + (tl.includes(tk) ? 1 : 0), 0);
  };
  return all.map((t) => [t, score(t)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);
}

/** The MCP toolset over a Studio — the command surface (doc-9 §2) made callable by any agent. */
export function buildTools(studio: Studio): ToolDef[] {
  const fromR = (r: { ok: true; value: string } | { ok: false; error: string }) => (r.ok ? ok(r.value) : fail(r.error));

  // Resolve a request-class wire reference from an AI-ergonomic tuple against the DRAWN wires (a class names
  // EXISTING wires). Forms: [fromNode, toNode] (ports resolved to the drawn wire) · [fromNode, fromPort, toNode,
  // toPort] (explicit, for a node pair joined by several wires). Guided errors name the next action (draw it, or
  // disambiguate) — the MCP contract that no error leaves the agent guessing.
  const resolveWireRef = (w: unknown): { ok: true; ref: WireRef } | { ok: false; error: string } => {
    if (!Array.isArray(w) || w.length < 2) return { ok: false, error: 'a class wire is [fromNode, toNode] (or [fromNode, fromPort, toNode, toPort])' };
    const fromNode = str(w[0]);
    const [fromPort, toNode, toPort] = w.length >= 4 ? [str(w[1]), str(w[2]), str(w[3])] : [undefined, str(w[1]), undefined];
    const cands = studio.project().wires.filter(
      (x) => x.from[0] === fromNode && x.to[0] === toNode && (fromPort === undefined || x.from[1] === fromPort) && (toPort === undefined || x.to[1] === toPort),
    );
    if (cands.length === 1) { const x = cands[0] as { from: readonly [string, string]; to: readonly [string, string] }; return { ok: true, ref: { from: x.from, to: x.to } }; }
    if (cands.length === 0) return { ok: false, error: `no wire ${fromNode} → ${toNode} — draw it first (connect); a class names EXISTING wires` };
    const x = cands[0] as { from: readonly [string, string]; to: readonly [string, string] };
    return { ok: false, error: `several wires ${fromNode} → ${toNode} — name the ports: ["${fromNode}","${x.from[1]}","${toNode}","${x.to[1]}"]` };
  };

  // ONE result shape for build + evaluate: {feasible, violations, system, verdicts}. A design that fails to
  // BUILD returns its structural errors here — never ok + empty (a silent false green the AI would trust).
  const evaluateResult = (): ToolResult => {
    const proj = studio.project();
    // TASK-86 F7: a CYCLIC single-river flow has no finite steady state — the throughput feeds back into itself, so
    // evaluate would report a DEGENERATE fixpoint. Diagnose it FIRST and GUIDE to request classes (which carve the
    // mesh into per-class acyclic slices), naming the exact loop, instead of a meaningless number. Only for the
    // single implicit river — with request classes declared, build.ts already enforces per-class acyclicity.
    if (proj.requestClasses.length === 0) {
      const cyc = cyclicFlowDiagnosis(proj.wires);
      if (cyc !== undefined) return fail(cyc.message);
    }
    const ev = studio.evaluate();
    if (!ev.ok) return fail('design has build errors: ' + ev.error.join('; '));

    // UNDER REQUEST CLASSES (doc: request-classes §4.2), the queueing-aware correction, the system roll-up, the tail
    // sim and the backward search are per-class-pending — running them CLASS-BLIND would LIE: a class-blind latency
    // is absent ⇒ a false ∞ saturation violation; a class-blind cost sums nothing ⇒ a false $0. So under classes we
    // present the HONEST per-class SCALAR picture the forward engine computes — each class's served throughput along
    // its OWN wires and the per-class SLO verdicts — and say plainly what is pending, never a misleading single-river
    // number. The implicit-class (no classes) path below is byte-for-byte unchanged.
    if (proj.requestClasses.length > 0) {
      const verdicts = ev.value.verdicts.map((v) => ({
        scope: v.scope,
        key: v.key,
        ...(v.class !== undefined ? { class: String(v.class) } : {}),
        status: v.status,
        value: v.computed.value,
        unit: v.computed.unit,
      }));
      const perClassThroughput = ev.value.classes.map((c) => ({
        class: String(c),
        // each node's SERVED throughput for THIS class (out(node, throughput, class)); omit nodes the class never reaches.
        throughput: Object.fromEntries(
          proj.instances.map((i) => [i.id, ev.value.value(NodeId(i.id), keys.throughput, c)] as const).filter(([, x]) => x !== undefined),
        ),
      }));
      return json({
        feasible: verdicts.every((v) => v.status !== 'violation'),
        violations: verdicts.filter((v) => v.status === 'violation').length,
        classes: ev.value.classes.map(String),
        perClassThroughput,
        verdicts,
        note: 'Request classes declared — per-class SCALAR verdicts and each class’s served throughput along its own wires (the forward engine, judged per class). Queueing-aware latency, the system cost/latency roll-up, tail simulation and backward search are per-class-pending; they decline honestly rather than report a single-river number (doc: request-classes §4.2, §5–6).',
      });
    }

    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    // F2 (audit): an empty / no-origin design must NOT read as a false green an agent reports as done — mirror the
    // canvas guard (which shows "no traffic origin" instead of a silent blank) and NAME the enabling move. Pure
    // output text; the numeric verdicts still ride along (a durability floor can pass/fail with no flow), but the
    // note is unmissable so the agent knows there is nothing to compute yet and what to do next.
    const originNote =
      proj.instances.length === 0
        ? 'empty design — no components yet. Build one in one call with apply_design, or add_component + connect, then evaluate.'
        : !hasTrafficOrigin(proj.instances, proj.wires, value)
          ? 'no traffic origin — throughput/latency/cost are vacuous (nothing drives the design). Make a node originate load (set_transform {node, port, fn:"generate", value} on an out port — a cron/emitter/migration source, the taught origination path; set_config {node, key:"assumedRps", value} is the legacy equivalent) or add a client.* node; or call envelope to see how far the current design can be pushed before an SLO breaks.'
          : undefined;
    // Apply the SAME queueing-aware (M/M/c) correction the canvas and generate_doc use — the engine's IDEAL
    // (Σ service-time) verdicts alone would let `evaluate` read feasible/ok while the doc + canvas read a real
    // latency / saturation violation on the identical design. One truth on the primary agent path (must not lie).
    const g = studio.graph();
    const queues = g.ok ? nodeQueues(g.value, value) : undefined;
    // WORST-CASE LOAD (owner ruling: a peak is just traffic in a given environment). When a generator declares
    // periodic cycles, run the ambient Tier-1 sweep (the SAME coarse live budget the canvas worker uses, so the AI
    // reads the same worst-window ρ the human sees) and fold each node's worst-window ρ into the verdict list — so a
    // node calm at the mean but saturated at its declared peak reads a real saturation violation here (feasible turns
    // false), matching the canvas and the generated doc (one truth for the AI). Silent for a flat design ⇒ the list
    // is byte-identical. No 'peak' vocabulary: the node is judged against its worst load, a violation is a violation.
    const evalDI: EvaluateGraph = (gr) => { const r = evaluate(gr, registry); return r.ok ? r.value : undefined; };
    const sweep = g.ok ? timeSweep({ graph: g.value, evaluate: evalDI, pointsPerCycle: LOAD_STAGES_DEFAULTS.livePointsPerCycle, maxWindows: LOAD_STAGES_DEFAULTS.liveWindowTarget }) : undefined;
    const peak = sweep !== undefined ? peakLoadByNode(sweep) : undefined;
    const verdicts = g.ok ? realAwareVerdicts(ev.value.verdicts, g.value, value, queues, peak) : ev.value.verdicts;
    // LATENCY IS MEASURED-OR-NOTHING (owner ruling: single-truth latency). The scalar `evaluate` pass does NOT time
    // requests, so it emits NO latency readout — no analytic per-node response latency, and the system roll-up below
    // is stripped of its per-flow `latencyMs`. A short note points at `simulate` for the measured p50/p95/p99; the
    // per-node ANALYTIC response latency (`responseLatency`) is still COMPUTED elsewhere, just shown on no surface.
    // Per-flow qualitative GUARANTEES (doc: guarantee-propagation §4) — the SAME propagation the canvas/design-doc
    // will render (R3), so the AI sees the human's tokens + root causes. Only DEGRADED/unknown dimensions appear
    // (the no-filler rule); a design that declares no guarantees yields [] and the field is omitted.
    const guarantees = g.ok ? flowGuarantees(g.value, proj.instances, proj.wires, value) : [];
    // JUDGED guarantee requirements (§4): each declared per-flow requirement gets a computed ok/violation/unknown
    // verdict WITH the root-cause hop and a computed same-family swap remediation (e.g. sqs → fifo + ceiling + $).
    // Rides on evaluate like the numeric verdicts — one truth for the human and the AI. Omitted when none declared.
    const guaranteeReqs = g.ok && proj.guaranteeSlos.length > 0
      ? guaranteeVerdicts(g.value, studio.mergedCatalog(), proj.instances, proj.wires, value, proj.guaranteeSlos)
      : [];
    // JUDGED lag requirements (doc: latency-semantics-v2 §3) — the SCALAR pass (no sim on the `evaluate` path): each
    // declared per-flow lag deadline gets a lower-bound-or-`unknown` verdict. The scalar can PROVE a violation (even
    // the queue-free lower bound breaches) but never `ok` — the async queue wait is a time-domain quantity only the
    // DES sees — so those read `unknown` here and point at `simulate`. Omitted when none declared (no-filler).
    const lagReqs = g.ok && proj.lagSlos.length > 0 ? lagVerdicts(g.value, value, proj.lagSlos, queues) : [];
    // JUDGED system promises (owner ruling: cost is for THE WHOLE SYSTEM) — each declared whole-design promise is
    // judged against the whole-graph total (Σ every node's own cost — the exact sum the search's total objective
    // and system-band constraint read), scope-labelled 'system'. Omitted when none declared (no-filler).
    const systemReqs = proj.systemPromises.length > 0 ? systemPromiseVerdicts(proj.instances, proj.wires, value, proj.systemPromises) : [];
    // The whole-design roll-up with its per-flow analytic `latencyMs` STRIPPED (measured-or-nothing) — throughput,
    // availability and cost stay; latency is a measured question `simulate` answers, never a scalar readout here.
    const sys = systemSummary(proj.instances, proj.wires, value);
    const system = {
      ...sys,
      flows: sys.flows.map((f) => ({ source: f.source, terminal: f.terminal, throughputRps: f.throughputRps, availability: f.availability, costUsdMonth: f.costUsdMonth })),
    };
    return json(
      {
          // The honest "nothing to compute yet" note leads the object when the design has no origin (F2) — an agent
          // scanning the result sees WHY the numbers are empty and the next move, never a bare green board.
          ...(originNote !== undefined ? { note: originNote } : {}),
          // A guarantee, lag or SYSTEM-promise VIOLATION counts against feasibility exactly like a numeric one — a
          // broken qualitative promise, a provably-missed deadline or a blown whole-system budget is a real defect,
          // so `feasible` reflects all four.
          feasible:
            verdicts.every((v) => v.status !== 'violation') &&
            guaranteeReqs.every((v) => v.status !== 'violation') &&
            lagReqs.every((v) => v.status !== 'violation') &&
            systemReqs.every((v) => v.status !== 'violation'),
          violations:
            verdicts.filter((v) => v.status === 'violation').length +
            guaranteeReqs.filter((v) => v.status === 'violation').length +
            lagReqs.filter((v) => v.status === 'violation').length +
            systemReqs.filter((v) => v.status === 'violation').length,
          system,
          // Latency is measured-or-nothing (owner ruling): the scalar pass does not time requests, so it reports no
          // latency number — an honest pointer to the measured path instead of a fabricated or analytic value.
          latency: 'run simulate for measured p50/p95/p99 (the scalar pass does not time requests)',
          guarantees: guarantees.length > 0 ? guarantees : undefined,
          guaranteeVerdicts: guaranteeReqs.length > 0
            ? guaranteeReqs.map((v) => ({
                scope: `${v.source} → ${v.terminal}`,
                dimension: v.dimension,
                required: v.required,
                computed: v.computed,
                status: v.status,
                rootCause: v.rootCauseNode,
                fix: v.remediation?.action ?? v.noRemediationReason,
              }))
            : undefined,
          // SYSTEM-scoped promise verdicts (owner ruling): the whole-design promise (v1: the monthly bill of every
          // component, off-path branches included) judged against the one whole-graph total — scope 'system'.
          systemPromiseVerdicts: systemReqs.length > 0
            ? systemReqs.map((v) => ({
                scope: v.scope,
                key: v.key,
                status: v.status,
                ...(v.computed !== undefined ? { computed: v.computed } : {}),
                ...(v.unit !== undefined ? { unit: v.unit } : {}),
                note: v.note,
              }))
            : undefined,
          // Per-flow LAG verdicts (doc: latency-semantics-v2 §3) — the async-inclusive propagation deadline judged by
          // the SCALAR lower bound here (an `unknown` means the queue wait is invisible to the scalar: run `simulate`).
          lagVerdicts: lagReqs.length > 0
            ? lagReqs.map((v) => ({
                scope: `${v.source} → ${v.terminal}`,
                maxMs: v.maxMs,
                status: v.status,
                basis: v.basis,
                ...(Number.isFinite(v.lowerBoundMs) ? { lowerBoundMs: Math.round(v.lowerBoundMs) } : Number.isNaN(v.lowerBoundMs) ? {} : { lowerBoundMs: '∞' }),
                note: v.note,
              }))
            : undefined,
          verdicts: verdicts.map((v) => ({ scope: v.scope, key: v.key, status: v.status, value: v.computed.value, unit: v.computed.unit, fix: v.remediations[0]?.action })),
      },
    );
  };

  return [
    {
      name: 'list_components',
      description:
        'Every component type available to place, WITH its ports (in/out + the protocols each speaks) — enough to wire correctly without probing. For one type in full detail (config knobs, defaults, SLO bands) call describe_component. e.g. {}',
      inputSchema: obj({}),
      annotations: READS,
      run: () => {
        const cat = studio.mergedCatalog();
        const line = (t: string): string => {
          const ports = cat[t]?.ports ?? [];
          const show = (dir: 'in' | 'out'): string => ports
            .filter((p) => p.dir === dir || p.dir === 'bi')
            .map((p) => `${p.name}(${(p.dir === 'in' || (p.dir === 'bi' && dir === 'in') ? p.accepts : p.speaks)?.join('|') ?? ''})`)
            .join(' ');
          return `${t}  in: ${show('in') || '-'}  out: ${show('out') || '-'}`;
        };
        return ok(studio.componentTypes().sort().map(line).join('\n'));
      },
    },
    {
      name: 'describe_component',
      description:
        'The FULL card of one component type: ports (direction + accepted/spoken protocols, first = natural), every config knob with its DEFAULT value and unit (the exact keys set_config takes), and built-in bands. The knobs it lists are live modeling levers — for what each DOES to the result (e.g. a connection pool drives the DES p99 tail, deploymentMode picks the Multi-AZ SLA, queueMode makes it buffer) see CAPABILITIES in the instructions. Call before wiring a multi-port node or before set_config; with list_components and list_protocols this makes the toolset self-sufficient - no source/repo reading is ever needed. e.g. {type:"db.postgres"}',
      inputSchema: obj({ type: { type: 'string' } }, ['type']),
      annotations: READS,
      run: (a) => {
        const t = str(a.type);
        const cat = studio.mergedCatalog();
        const m = cat[t];
        if (m === undefined) {
          const sug = suggestTypes(t, studio.componentTypes());
          return fail(`unknown type "${t}"${sug.length ? ` - did you mean ${sug.join(', ')}?` : ''} (list_components for all)`);
        }
        // A port's DECLARED guarantee contribution (doc: guarantee-propagation) with its provenance — so the AI sees
        // the same sourced tokens the human's Inspector shows (a writer = consistency:strong, SQS = ordering:none…).
        const portGuarantees = (p: Manifest['ports'][number]): string => {
          const claims = claimsFor(p.guarantees);
          if (claims === undefined || claims.length === 0) return '';
          const toks = claims.map((c) => `${String(c.dimension)}:${String(c.token)}${c.source ? ' (documented)' : c.est ? ' (est.)' : ''}`).join(', ');
          return `  guarantees: ${toks}`;
        };
        const ports = m.ports
          .map((p) => `  ${p.name} [${p.dir}] ${(p.dir === 'in' ? p.accepts : p.speaks)?.join(', ') ?? ''}${p.transform ? `  transform: ${p.transform.kind === 'generate' ? `generate(${p.transform.level} req/s${p.transform.cycles !== undefined ? ', cycles' : ''})` : `${p.transform.kind}(${p.transform.value})`}` : ''}${portGuarantees(p) ? `\n  ${portGuarantees(p).trim()}` : ''}`)
          .join('\n');
        const config = (m.config ?? []).map((c) => `  ${c.key} = ${c.value} ${c.unit}`).join('\n');
        const bands = (m.bands ?? []).map((b) => `  ${b.key}`).join('\n');
        return ok(`${t}\nPORTS (protocol lists: first = natural; wire legality = set overlap)\n${ports || '  (none)'}\nCONFIG (set_config keys, with defaults)\n${config || '  (none)'}${bands ? `\nBUILT-IN BANDS\n${bands}` : ''}`);
      },
    },
    {
      name: 'list_protocols',
      description:
        'The OFFICIAL protocol vocabulary - every id a port may accept/speak, with its kind (sync wire / async wire / event channel) and full name+spec. Ports reference protocols BY THESE IDS ONLY (never invented names); call this before define_component, and whenever a wire is refused for protocol reasons. e.g. {}',
      inputSchema: obj({}),
      annotations: READS,
      run: () =>
        ok(
          protocols.map((p) => `${p.id}  [${p.kind}]  ${p.note}`).join('\n') +
            '\n\ncompat (an out protocol accepted by a different in): ' +
            protocolCompat.map((c) => `${c.out} -> ${c.in}`).join(', '),
        ),
    },
    {
      name: 'add_component',
      description: 'Add one component instance to the design (it appears as a node on the human\'s canvas). Prefer apply_design to build a whole design at once; use this for a single incremental add. Valid types come from list_components (details: describe_component). e.g. {id:"cache", type:"cache.redis"}',
      inputSchema: obj({ id: { type: 'string' }, type: { type: 'string' } }, ['id', 'type']),
      annotations: EDITS,
      run: (a) => {
        const t = str(a.type);
        if (!studio.componentTypes().includes(t)) {
          const sug = suggestTypes(t, studio.componentTypes());
          return fail(`unknown type "${t}"${sug.length ? ` - did you mean ${sug.join(', ')}?` : ''} (list_components for all)`);
        }
        return fromR(studio.dispatch({ kind: 'addComponent', id: str(a.id), type: t }));
      },
    },
    {
      name: 'remove_node',
      description: 'Remove a node and every wire attached to it (the node disappears from the human\'s canvas). The inverse of add_component; for a request class / named world use remove_class / remove_scenario. e.g. {id:"cache"}',
      inputSchema: obj({ id: { type: 'string' } }, ['id']),
      annotations: EDITS,
      run: (a) => fromR(studio.dispatch({ kind: 'removeNode', id: str(a.id) })),
    },
    {
      name: 'rename_node',
      description: "Change a node's unique id, rewriting every wire/group/label/SLO reference to it (config and SLOs are preserved). e.g. {id:\"db1\", to:\"orders_db\"}",
      inputSchema: obj({ id: { type: 'string' }, to: { type: 'string' } }, ['id', 'to']),
      annotations: EDITS,
      run: (a) => fromR(studio.dispatch({ kind: 'renameNode', id: str(a.id), to: str(a.to) })),
    },
    {
      name: 'set_label',
      description: "Set a node's friendly display name — what the human reads on the node (the id stays the stable identifier). Empty label clears it. e.g. {id:\"db1\", label:\"Orders DB\"}",
      inputSchema: obj({ id: { type: 'string' }, label: { type: 'string' } }, ['id', 'label']),
      annotations: EDITS,
      run: (a) => fromR(studio.dispatch({ kind: 'setLabel', id: str(a.id), label: str(a.label) })),
    },
    {
      name: 'set_description',
      description: "Set a node's one-line description (what it is FOR — shown on the node, separate from id and label). Empty clears it. e.g. {id:\"db1\", description:\"system of record for orders\"}",
      inputSchema: obj({ id: { type: 'string' }, description: { type: 'string' } }, ['id', 'description']),
      annotations: EDITS,
      run: (a) => fromR(studio.dispatch({ kind: 'setDescription', id: str(a.id), description: str(a.description) })),
    },
    {
      name: 'connect',
      description: 'Draw one wire fromNode.fromPort → toNode.toPort (the edge appears on the human\'s canvas). Protocol legality is enforced exactly as a human drag is — an incompatible pair is refused naming the fix. Prefer apply_design for a whole design; use this for a single incremental edge. e.g. {fromNode:"app", fromPort:"db", toNode:"orders_db", toPort:"in"}',
      inputSchema: obj({ fromNode: { type: 'string' }, fromPort: { type: 'string' }, toNode: { type: 'string' }, toPort: { type: 'string' } }, ['fromNode', 'fromPort', 'toNode', 'toPort']),
      annotations: EDITS,
      run: (a) => {
        // enforce the canvas's protocol-legality on the AI path too — a human drag would be refused; so is this
        const proj = studio.project();
        for (const [role, nid] of [['fromNode', str(a.fromNode)], ['toNode', str(a.toNode)]] as const) {
          if (!proj.instances.some((i) => i.id === nid)) {
            return fail(`${role} "${nid}" is not a node in this design - the nodes are [${proj.instances.map((i) => i.id).join(', ') || 'none'}]; add one first (add_component) or use get_project to see the current design`);
          }
        }
        const ft = proj.instances.find((i) => i.id === str(a.fromNode))?.type ?? '';
        const tt = proj.instances.find((i) => i.id === str(a.toNode))?.type ?? '';
        // F6 (audit / doc-10 swallow bug): a named port that does NOT exist made a phantom wire (illegalWire reads
        // "legal" for an unknown port, so throughput silently read 0). Refuse it here, naming the node's REAL ports —
        // the same lookup set_transform uses — so a typo self-corrects instead of poisoning the design.
        const catalog = studio.mergedCatalog();
        for (const [role, id, type, port] of [
          ['fromNode', str(a.fromNode), ft, str(a.fromPort)],
          ['toNode', str(a.toNode), tt, str(a.toPort)],
        ] as const) {
          const ports = (catalog[type]?.ports ?? []).map((p) => p.name);
          if (!ports.includes(port)) {
            return fail(`${role} "${id}" (${type}) has no port "${port}" — its ports are [${ports.join(', ') || 'none'}] (describe_component ${type} for its ports)`);
          }
        }
        const bad = illegalWire(catalog, ft, str(a.fromPort), tt, str(a.toPort));
        if (bad) return fail(`connect ${str(a.fromNode)} → ${str(a.toNode)}: ${bad}`);
        return fromR(studio.dispatch({ kind: 'connect', from: [str(a.fromNode), str(a.fromPort)], to: [str(a.toNode), str(a.toPort)] }));
      },
    },
    {
      name: 'set_config',
      description: 'Set a numeric config value on a node. `key` must be a real knob — a manifest config knob of the node (describe_component lists them) or a universal one (assumedRps, timeoutMs, deploymentMode, concurrency, cpuCores, cpuTimePerRequestMs…). Many knobs are live MODELING LEVERS whose effect is easy to miss — see CAPABILITIES in the instructions: `connectionPool`/`connectionHeldMs` drive a pooling proxy\'s p99 tail (simulate), `cpuCores`/`cpuTimePerRequestMs` make a node CPU-bound (an M/M/cores station — a framework/proxy that saturates on CPU before its DB), `deploymentMode` picks the Multi-AZ/region SLA (and ≈2× cost), `queueMode` makes a node act as a buffering queue, `timeoutMs`/`retryCount` model retry storms. A typo is refused with the closest match rather than stored as a phantom the unchanged evaluate cannot explain. Prefer optimize/repair to SIZE knobs; use this for a value you have deliberately chosen. e.g. {node:"db", key:"concurrency", value:200}',
      inputSchema: obj({ node: { type: 'string' }, key: { type: 'string' }, value: { type: 'number' } }, ['node', 'key', 'value']),
      annotations: EDITS,
      run: (a) => {
        const node = str(a.node);
        const key = str(a.key);
        // GUIDED errors (the MCP contract). Validate the node, then the KEY: F5 closes the silent-accept bug where
        // set_config{key:'latncy'} stored a phantom that changed nothing. A key is valid if it is a real registry key
        // OR a config knob this node's manifest/instance declares (a custom component may add its own). A typo is
        // refused with the closest matches, mirroring set_range's guard.
        const proj = studio.project();
        const inst = proj.instances.find((i) => i.id === node);
        if (inst === undefined) return fail(`node "${node}" is not in this design — the nodes are [${proj.instances.map((i) => i.id).join(', ') || 'none'}]; add one first (add_component)`);
        const manifestKeys = (studio.mergedCatalog()[inst.type]?.config ?? []).map((c) => String(c.key));
        const known = new Set([...REGISTRY_KEYS, ...manifestKeys, ...Object.keys(inst.config ?? {})]);
        if (!known.has(key)) {
          const near = didYouMean(key, [...known]);
          return fail(`node "${node}" (${inst.type}) has no config knob "${key}"${near.length ? ` — did you mean ${near.join(', ')}?` : ''} (describe_component ${inst.type} lists its knobs; universal knobs like assumedRps/timeoutMs/deploymentMode work on any node)`);
        }
        return fromR(studio.dispatch({ kind: 'setConfig', node, key, value: Number(a.value) }));
      },
    },
    {
      name: 'set_transform',
      description:
        "Set a per-port FLOW TRANSFORM on a node's port — the traffic transfer function of the flow model. A node relays 1:1 by default; a transform declares real amplification/reduction. On an OUT port it shapes what the port EMITS (\"1 request → 100 log lines\" ⇒ fn:'ratio', value:100 on the logging out-port); on an IN port it shapes what the port INTAKES (\"aggregate 100:1 from any sender\" ⇒ fn:'batch', value:100 on the aggregator's in-port). Closed set: ratio(k)=k·x · batch(n)=x/n · cap(r)=min(x,r) throttle · window(ms)=min(x,1000/ms) · prob(p)=p·x (p≤1) · generate(level)=the port ORIGINATES `value` req/s of its own (a cron/emitter/migration source — the traffic consumes the node's own capacity then exits this OUT port; the universal way to declare offered load, superseding assumedRps). generate may carry optional `cycles` — periodic k6/Gatling STAGES that shape the load over time (each cycle = {periodS, stages:[{durationS, multiplier}]}, the multiplier relative to the baseline level, ramping linearly; several cycles MULTIPLY). e.g. a spike: [{periodS:2592000, stages:[{durationS:30,multiplier:1},{durationS:5,multiplier:3},{durationS:120,multiplier:3},{durationS:5,multiplier:1}]}]. Or name a `preset` to pre-fill a common shape in one call: flat · spike (the one-node replacement for the old global stress probe) · ramp-up · diurnal · on-off-burst · quarterly-report. The level is the BASELINE (×1); the simulator plays the shape. OMIT fn to CLEAR back to 1:1. The transformed rate flows through evaluate/simulate — downstream verdicts see the real load. e.g. {node:\"logger\", port:\"out\", fn:\"ratio\", value:100} or {node:\"cron\", port:\"out\", fn:\"generate\", value:200}",
      inputSchema: obj(
        {
          node: { type: 'string' },
          port: { type: 'string' },
          fn: { type: 'string', enum: [...TRANSFORM_FN_ENUM] },
          value: { type: 'number' },
          preset: {
            type: 'string',
            enum: [...GENERATOR_PRESET_ENUM],
            description: "generate only: pre-fill `cycles` from a named, industry-sourced load shape instead of hand-writing them — flat (steady) · spike (a one-shot ×3 stress burst; the one-node replacement for the removed global stress probe) · ramp-up (k6 ramping arrival rate) · diurnal (a looped day with a rush hour) · on-off-burst (a cron/batch pulse) · quarterly-report (a seasonal spike). `value` is still the baseline level (×1) the shape scales. Explicit `cycles`, if also given, WIN over the preset.",
          },
          cycles: {
            type: 'array',
            description: "generate only: periodic load shapes. Each cycle = {periodS (seconds), stages:[{durationS (seconds), multiplier (≥0, relative to the baseline level)}]}. Stages ramp LINEARLY to their multiplier; ×1 = the baseline. Σ durationS ≤ periodS. Several cycles multiply. e.g. a diurnal shape or a one-shot launch spike (periodS ≥ the observed span). Prefer `preset` for the common shapes.",
            items: {
              type: 'object',
              properties: {
                periodS: { type: 'number' },
                stages: { type: 'array', items: { type: 'object', properties: { durationS: { type: 'number' }, multiplier: { type: 'number' } }, required: ['durationS', 'multiplier'] } },
              },
              required: ['periodS', 'stages'],
            },
          },
        },
        ['node', 'port'],
      ),
      annotations: EDITS,
      run: (a) => {
        const node = str(a.node);
        const proj = studio.project();
        const inst = proj.instances.find((i) => i.id === node);
        if (inst === undefined) return fail(`node "${node}" is not in this design — the nodes are [${proj.instances.map((i) => i.id).join(', ') || 'none'}]; add one first (add_component)`);
        const manifestPorts = studio.mergedCatalog()[inst.type]?.ports ?? [];
        const ports = manifestPorts.map((p) => p.name);
        const port = str(a.port);
        if (!ports.includes(port)) return fail(`node "${node}" (${inst.type}) has no port "${port}" — its ports are [${ports.join(', ') || 'none'}] (describe_component ${inst.type} for details)`);
        // absent fn ⇒ CLEAR the override (back to identity 1:1).
        if (a.fn === undefined || a.fn === null || a.fn === '') {
          return fromR(studio.dispatch({ kind: 'setTransform', node, port, transform: null }));
        }
        const fn = str(a.fn);
        if (!TRANSFORM_FN_ENUM.includes(fn as (typeof TRANSFORM_FN_ENUM)[number])) return fail(`unknown transform "${fn}" — the closed set is [${TRANSFORM_FN_ENUM.join(', ')}] (ratio/batch/cap/window/prob/generate); omit fn to clear`);
        if (fn === 'generate') {
          // THE GENERATOR (doc: load-stages §4): the port ORIGINATES `value` req/s (the BASELINE). Guided rules:
          // out/bi ports only (an in-port cannot originate), level ≥ 0, and well-formed optional cycles.
          const dir = manifestPorts.find((p) => p.name === port)?.dir;
          if (dir === 'in') {
            const outs = manifestPorts.filter((p) => p.dir !== 'in').map((p) => p.name);
            return fail(`generate needs an OUT port — "${port}" is an in port on "${node}" (${inst.type}); its out ports are [${outs.join(', ') || 'none'}]`);
          }
          const level = Number(a.value);
          if (!Number.isFinite(level) || level < 0) return fail(`generate needs a level ≥ 0 in \`value\` (req/s the port originates — the baseline; got ${String(a.value)})`);
          let cycles: Cycle[] | undefined;
          if (a.cycles !== undefined && a.cycles !== null) {
            // Explicit cycles WIN over a preset (a preset is only a pre-fill), so an agent can name a preset then
            // override its shape in the same call.
            if (!Array.isArray(a.cycles)) return fail('`cycles` must be an array of {periodS, stages:[{durationS, multiplier}]} cycles');
            cycles = (a.cycles as { periodS?: unknown; stages?: unknown }[]).map((c) => ({
              periodS: Number(c?.periodS),
              stages: (Array.isArray(c?.stages) ? (c.stages as { durationS?: unknown; multiplier?: unknown }[]) : []).map((st): Stage => ({ durationS: Number(st?.durationS), multiplier: Number(st?.multiplier) })),
            }));
            const problem = cyclesProblem(cycles);
            if (problem !== null) return fail(`cycles: ${problem} — each cycle is {periodS > 0, stages:[{durationS > 0, multiplier ≥ 0}]}, Σ durationS ≤ periodS, at least one multiplier > 0`);
          } else if (a.preset !== undefined && a.preset !== null && a.preset !== '') {
            // A PRESET names a shipped shape (doc: load-stages §11) — the one-call on-ramp. `flat` clears the shape
            // (a steady baseline); the others pre-fill their cycles, fully editable by a follow-up explicit `cycles`.
            const preset = str(a.preset);
            if (!GENERATOR_PRESET_ENUM.includes(preset as (typeof GENERATOR_PRESET_ENUM)[number])) return fail(`unknown preset "${preset}" — the shipped shapes are [${GENERATOR_PRESET_ENUM.join(', ')}] (or give explicit \`cycles\`)`);
            const presetCycles = LOAD_STAGES_PRESETS[preset as LoadStagePreset];
            cycles = presetCycles.length > 0 ? presetCycles.map((c) => ({ periodS: c.periodS, stages: c.stages.map((st): Stage => ({ durationS: st.durationS, multiplier: st.multiplier })) })) : undefined;
          }
          return fromR(studio.dispatch({ kind: 'setTransform', node, port, transform: { kind: 'generate', level, ...(cycles !== undefined ? { cycles } : {}) } }));
        }
        const value = Number(a.value);
        if (!Number.isFinite(value) || value <= 0) return fail(`transform "${fn}" needs a positive value (got ${String(a.value)}) — e.g. ratio 100, batch 100, cap 250, window 10 (ms), prob 0.01`);
        if (fn === 'prob' && value > 1) return fail(`prob is a probability — value must be ≤ 1 (got ${value})`);
        return fromR(studio.dispatch({ kind: 'setTransform', node, port, transform: { kind: fn as (typeof TRANSFORM_FNS)[number], value } }));
      },
    },
    {
      name: 'set_wire_transform',
      description:
        "Set a per-WIRE FLOW TRANSFORM on ONE edge — a ROUTING SPLIT a per-port transform cannot express. A single out port that feeds SEVERAL wires broadcasts the FULL rate to each by default (correct for pub/sub, wrong for request routing). Use this to split: a gateway out-port feeding catalog AND checkout ⇒ prob 0.7 on the catalog wire, prob 0.3 on the checkout wire (each edge carries its true share; no false overload). Addresses the wire by its endpoints (fromNode.fromPort → toNode.toPort). It OVERRIDES the source port's transform for THIS wire only. Closed set: ratio(k)=k·x · batch(n)=x/n · cap(r)=min(x,r) · window(ms)=min(x,1000/ms) · prob(p)=p·x (p≤1). OMIT fn to CLEAR the wire back to the port default. The split flows through evaluate/simulate. e.g. {fromNode:\"gw\", fromPort:\"out\", toNode:\"checkout\", toPort:\"in\", fn:\"prob\", value:0.3}",
      inputSchema: obj(
        {
          fromNode: { type: 'string' },
          fromPort: { type: 'string' },
          toNode: { type: 'string' },
          toPort: { type: 'string' },
          fn: { type: 'string', enum: [...TRANSFORM_FNS] },
          value: { type: 'number' },
        },
        ['fromNode', 'fromPort', 'toNode', 'toPort'],
      ),
      annotations: EDITS,
      run: (a) => {
        const from = [str(a.fromNode), str(a.fromPort)] as const;
        const to = [str(a.toNode), str(a.toPort)] as const;
        // Existence is a WIRE fact — validate here so the error names real wires (the guided-error contract) rather
        // than surfacing as a bare "no such wire" from the reducer.
        const proj = studio.project();
        const exists = proj.wires.some((w) => w.from[0] === from[0] && w.from[1] === from[1] && w.to[0] === to[0] && w.to[1] === to[1]);
        if (!exists) {
          const list = proj.wires.map((w) => `${w.from[0]}.${w.from[1]}→${w.to[0]}.${w.to[1]}`).join(', ') || 'none';
          return fail(`no wire ${from[0]}.${from[1]} → ${to[0]}.${to[1]} in this design — the wires are [${list}]; connect first (connect) or use get_project to see the design`);
        }
        // absent fn ⇒ CLEAR the wire override (back to the source port's transform / identity).
        if (a.fn === undefined || a.fn === null || a.fn === '') {
          return fromR(studio.dispatch({ kind: 'setWireTransform', from, to, transform: null }));
        }
        const fn = str(a.fn);
        if (fn === 'generate') return fail('a generator is a PORT function — set it with set_transform on the source OUT port (a wire cannot originate traffic; doc: load-curves §3)');
        if (!TRANSFORM_FNS.includes(fn as (typeof TRANSFORM_FNS)[number])) return fail(`unknown transform "${fn}" — the closed set is [${TRANSFORM_FNS.join(', ')}] (ratio/batch/cap/window/prob); omit fn to clear`);
        const value = Number(a.value);
        if (!Number.isFinite(value) || value <= 0) return fail(`transform "${fn}" needs a positive value (got ${String(a.value)}) — e.g. a 70/30 split is prob 0.7 and prob 0.3`);
        if (fn === 'prob' && value > 1) return fail(`prob is a probability — value must be ≤ 1 (got ${value})`);
        return fromR(studio.dispatch({ kind: 'setWireTransform', from, to, transform: { kind: fn as (typeof TRANSFORM_FNS)[number], value } }));
      },
    },
    {
      name: 'set_type',
      description: "Change a node's component type in place (keeps id, wires and SLOs; resets capacity config to the new type's defaults — re-size with repair/optimize). Use this to apply a compare_options choice, e.g. switch a node from compute.faas to compute.fargate. e.g. {id:\"svc\", type:\"compute.fargate\"}",
      inputSchema: obj({ id: { type: 'string' }, type: { type: 'string' } }, ['id', 'type']),
      annotations: EDITS,
      run: (a) => fromR(studio.dispatch({ kind: 'setType', id: str(a.id), type: str(a.type) })),
    },
    {
      name: 'set_slo',
      description:
        'Set an SLO band on node.key. For a SCALAR target use min/target/max (checks the mean/computed value). For a TAIL/percentile SLO (e.g. p99 latency ≤ 300) pass `percentiles`: {"p99":300,"p95":200} — a tail SLO is verified against the SIMULATED tail, NOT the scalar mean; the forward `evaluate` honestly reports it as `unknown` (a scalar pass cannot see the tail) rather than a false green. Pass scope:"system" for a WHOLE-SYSTEM promise (system-scoped keys: cost) — it needs NO node (the quantity is global: the sum of every node\'s own cost, off-path branches included), is judged as a scope:"system" verdict, and constrains repair/optimize as a whole-design ceiling. An END-TO-END availability promise is just an `availability` band on the flow\'s TERMINAL node — availability is judged at a node against its CUMULATIVE (the serial product of every dependency on the path down to it), so a band on the terminal IS the end-to-end path promise (e.g. {node:"db", key:"availability", min:0.999}). A cost band ON a node bounds that node\'s BRANCH cost (its accumulated path). e.g. {node:"db", key:"latency", max:300} or {key:"cost", max:30000, scope:"system"}',
      inputSchema: obj({ key: { type: 'string' }, node: { type: 'string', description: 'The target node. Not needed (ignored) with scope:"system" — a whole-system promise has no node.' }, min: { type: 'number' }, target: { type: 'number' }, max: { type: 'number' }, percentiles: { type: 'object' }, scope: { type: 'string', enum: ['node', 'system'], description: '"system" = a whole-design promise (keys: cost — the full monthly bill). Default "node" = a band on `node` (cost there = its branch cost; availability there = the cumulative down to that node, i.e. the end-to-end path availability when the node is a flow terminal).' } }, ['key']),
      annotations: EDITS,
      run: (a) => {
        // GUIDED errors (F5): validate the node, then the METRIC. An SLO targets a COMPUTED result or a DES-answered
        // PROMISE — never an input knob — so a typo (`latncy`) is refused with the closest match + the SLO vocabulary,
        // instead of storing a dead SLO that leaves the unchanged evaluate inexplicable (the audit's silent-accept).
        const key = str(a.key);
        const proj = studio.project();
        // SCOPE "system" (owner ruling: cost is for THE WHOLE SYSTEM): the promise is GLOBAL — never ask for (or
        // accept) a node/flow. Judged against the whole-graph total; enforced by repair/optimize as the sum band.
        if (a.scope === 'system') {
          if (!isSystemPromiseKey(key)) {
            // A node quantity refuses the system scope WITH THE REASON + the fix — self-correcting (F5).
            return fail(`"${key}" is not a system-scoped quantity — the whole-system promises are [${SYSTEM_PROMISE_KEYS.join(', ')}]. ${key} is judged per node: set it on a node (set_slo {node, key:"${key}", …}) — an end-to-end availability promise is an availability band on the flow's terminal node`);
          }
          if (a.percentiles !== undefined && a.percentiles !== null) {
            return fail(`a system ${key} promise is a scalar floor/ceiling (min/target/max) — percentiles are a tail quantity, judged per node against the simulated tail (set_slo {node, key:"tailLatency", percentiles})`);
          }
          if (a.min === undefined && a.target === undefined && a.max === undefined) {
            return fail(`a system ${key} promise needs a bound — pass max (a ceiling, e.g. {key:"cost", max:30000, scope:"system"}) and/or min/target`);
          }
          const band: Band = {
            shape: 'minTargetMax',
            ...(a.min !== undefined ? { min: Number(a.min) } : {}),
            ...(a.target !== undefined ? { target: Number(a.target) } : {}),
            ...(a.max !== undefined ? { max: Number(a.max) } : {}),
          };
          return fromR(studio.dispatch({ kind: 'setSystemPromise', promise: { key, band } }));
        }
        const node = str(a.node);
        if (node === '') return fail(`set_slo needs a target node for a node-scoped promise — pass {node, key, …}; only a whole-system promise (scope:"system", keys: [${SYSTEM_PROMISE_KEYS.join(', ')}]) needs none`);
        if (!proj.instances.some((i) => i.id === node)) return fail(`node "${node}" is not in this design — the nodes are [${proj.instances.map((i) => i.id).join(', ') || 'none'}]; add one first (add_component)`);
        if (!SLO_KEYS.includes(key)) {
          const near = didYouMean(key, SLO_KEYS);
          return fail(`"${key}" is not an SLO-able metric${near.length ? ` — did you mean ${near.join(', ')}?` : ''}. A requirement targets a computed result or a tail promise: [${SLO_KEYS.join(', ')}]`);
        }
        // A percentile SLO (e.g. {p99: 300}) becomes a `percentiles` band — the tail, never the scalar mean.
        const pcts = a.percentiles;
        if (pcts !== null && typeof pcts === 'object') {
          const targets = new Map<string, number>();
          for (const [name, val] of Object.entries(pcts as Record<string, unknown>)) {
            const n = Number(val);
            if (/^p\d+$/.test(name) && Number.isFinite(n)) targets.set(name, n);
          }
          if (targets.size > 0) {
            return fromR(studio.dispatch({ kind: 'setSLO', node, key: Key(key), band: { shape: 'percentiles', targets } }));
          }
        }
        const band: Band = {
          shape: 'minTargetMax',
          ...(a.min !== undefined ? { min: Number(a.min) } : {}),
          ...(a.target !== undefined ? { target: Number(a.target) } : {}),
          ...(a.max !== undefined ? { max: Number(a.max) } : {}),
        };
        return fromR(studio.dispatch({ kind: 'setSLO', node, key: Key(key), band }));
      },
    },
    {
      name: 'set_guarantee_slo',
      description:
        "Require a qualitative GUARANTEE on a request FLOW (doc: guarantee-propagation) — the invisible production bugs (stale reads, lost order, duplicates) as a checked promise. A guarantee is a property of a PATH, so it is keyed by the flow's source and terminal NODE ids (not a single node). Dimensions & their tokens (strongest→weakest): consistency {strong, eventual}; ordering {total, per-key, none}; delivery {clean, may-duplicate}. `atLeast` = the WEAKEST acceptable token — e.g. {source:'client', terminal:'worker', dimension:'ordering', atLeast:'per-key'} demands the flow keeps at least per-key order; evaluate then verdicts it ok/violation/unknown, names the root-cause hop, and computes the cheapest same-family swap that restores it (e.g. sqs→fifo). Set again on the same (source,terminal,dimension) to change it; remove with clear_guarantee_slo.",
      inputSchema: obj({ source: { type: 'string' }, terminal: { type: 'string' }, dimension: { type: 'string' }, atLeast: { type: 'string' } }, ['source', 'terminal', 'dimension', 'atLeast']),
      annotations: EDITS,
      run: (a) => {
        const source = str(a.source);
        const terminal = str(a.terminal);
        const dimension = str(a.dimension);
        const atLeast = str(a.atLeast);
        // GUIDED errors (the MCP contract: every error names the next action). Validate the dimension + token
        // against the categorical vocabulary, and the endpoints against the current design's nodes/flows.
        const lattice = categorical.get(DimensionId(dimension));
        if (lattice === undefined) {
          return fail(`unknown guarantee dimension "${dimension}" — the dimensions are [${categorical.dimensions.map(String).join(', ')}]`);
        }
        if (lattice.rank(DimensionToken(atLeast)) === undefined) {
          return fail(`"${atLeast}" is not a token of "${dimension}" — its tokens (strongest→weakest) are [${lattice.tokens.map(String).join(', ')}]`);
        }
        const nodes = studio.project().instances.map((i) => i.id);
        for (const [role, id] of [['source', source], ['terminal', terminal]] as const) {
          if (!nodes.includes(id)) {
            return fail(`${role} "${id}" is not a node in this design — the nodes are [${nodes.join(', ') || 'none'}]; a guarantee requirement is keyed by a flow's source and terminal node ids (add_component / connect first, or get_project to see the design)`);
          }
        }
        const slo: GuaranteeSlo = { source, terminal, dimension, atLeast };
        return fromR(studio.dispatch({ kind: 'setGuaranteeSlo', slo }));
      },
    },
    {
      name: 'clear_guarantee_slo',
      description: "Remove a guarantee promise previously set with set_guarantee_slo, by its flow (source, terminal) and dimension. e.g. {source:\"client\", terminal:\"worker\", dimension:\"ordering\"}",
      inputSchema: obj({ source: { type: 'string' }, terminal: { type: 'string' }, dimension: { type: 'string' } }, ['source', 'terminal', 'dimension']),
      annotations: EDITS,
      run: (a) => {
        const source = str(a.source);
        const terminal = str(a.terminal);
        const dimension = str(a.dimension);
        const existing = studio.project().guaranteeSlos;
        if (!existing.some((s) => s.source === source && s.terminal === terminal && s.dimension === dimension)) {
          const list = existing.map((s) => `${s.source}→${s.terminal}:${s.dimension}`).join(', ') || 'none';
          return fail(`no guarantee requirement ${dimension} on ${source} → ${terminal} — the declared requirements are [${list}]`);
        }
        return fromR(studio.dispatch({ kind: 'clearGuaranteeSlo', source, terminal, dimension }));
      },
    },
    {
      name: 'set_lag_slo',
      description:
        "Require a PROPAGATION-LAG deadline on a data FLOW (doc: latency-semantics-v2 §3) — \"a change captured at the source reaches the destination within X ms\", the CDC / replication question. UNLIKE a node latency SLO (set_slo key:'latency', which cuts at async boundaries — what a CALLER waits for), a lag SLO INCLUDES the async queue waits along the path (retention, drain) — the whole point of a replication deadline. It is a property of a PATH, so it is keyed by the flow's source and terminal NODE ids (not a single node): {source:'srcdb', terminal:'aurora', maxMs:2000}. The verdict is honest in two passes — evaluate proves a violation only if even the queue-FREE lower bound already exceeds maxMs (else `unknown`, because the scalar cannot see the queue wait); run `simulate` for the true async-inclusive mean lag (a real ok/violation). Set again on the same (source,terminal) to change it; remove with clear_lag_slo. e.g. {source:\"srcdb\", terminal:\"aurora\", maxMs:2000}",
      inputSchema: obj({ source: { type: 'string' }, terminal: { type: 'string' }, maxMs: { type: 'number' } }, ['source', 'terminal', 'maxMs']),
      annotations: EDITS,
      run: (a) => {
        const source = str(a.source);
        const terminal = str(a.terminal);
        const maxMs = Number(a.maxMs);
        // GUIDED errors (the MCP contract: every error names the next action). Validate maxMs, then the endpoints
        // against the current design's nodes (a lag requirement is keyed by a flow's source and terminal node ids).
        if (!Number.isFinite(maxMs) || maxMs <= 0) return fail(`maxMs must be a positive number of milliseconds (got ${String(a.maxMs)}) — e.g. {source, terminal, maxMs: 2000} for a 2 s replication deadline`);
        const nodes = studio.project().instances.map((i) => i.id);
        for (const [role, id] of [['source', source], ['terminal', terminal]] as const) {
          if (!nodes.includes(id)) {
            return fail(`${role} "${id}" is not a node in this design — the nodes are [${nodes.join(', ') || 'none'}]; a lag requirement is keyed by a flow's source and terminal node ids (add_component / connect first, or get_project to see the design)`);
          }
        }
        const slo: LagSlo = { source, terminal, maxMs };
        return fromR(studio.dispatch({ kind: 'setLagSlo', slo }));
      },
    },
    {
      name: 'clear_lag_slo',
      description: 'Remove a lag promise previously set with set_lag_slo, by its flow (source, terminal). e.g. {source:"srcdb", terminal:"aurora"}',
      inputSchema: obj({ source: { type: 'string' }, terminal: { type: 'string' } }, ['source', 'terminal']),
      annotations: EDITS,
      run: (a) => {
        const source = str(a.source);
        const terminal = str(a.terminal);
        const existing = studio.project().lagSlos;
        if (!existing.some((s) => s.source === source && s.terminal === terminal)) {
          const list = existing.map((s) => `${s.source}→${s.terminal}:≤${s.maxMs}ms`).join(', ') || 'none';
          return fail(`no lag requirement on ${source} → ${terminal} — the declared lag requirements are [${list}]`);
        }
        return fromR(studio.dispatch({ kind: 'clearLagSlo', source, terminal }));
      },
    },
    {
      name: 'set_range',
      description:
        "Declare an UNCERTAINTY RANGE on a config value (doc: uncertainty-monte-carlo) — the honest admission that a soft input is not a point, so the `uncertainty` tool can turn conclusions into distributions. Two shapes: UNIFORM {node, key, lo, hi} (every value in [lo,hi] equally likely — a traffic figure \"1,500–3,000\") or TRIANGULAR {node, key, lo, mode, hi} (a most-likely `mode` with linear falloff — a cache-hit ratio ~0.8, credibly 0.6–0.9). `key` must be a CONFIG knob of the node (describe_component to see them); the range brackets its point value (lo ≤ hi, mode in [lo,hi]). The base design still uses the point value — a range only matters to the `uncertainty` tool. Set again on the same key to change it; remove with clear_range. e.g. {node:\"client\", key:\"throughput\", lo:1500, hi:3000}",
      inputSchema: obj({ node: { type: 'string' }, key: { type: 'string' }, lo: { type: 'number' }, hi: { type: 'number' }, mode: { type: 'number' } }, ['node', 'key', 'lo', 'hi']),
      annotations: EDITS,
      run: (a) => {
        const node = str(a.node);
        const key = str(a.key);
        // GUIDED errors (the MCP contract: every error names the next action). Validate the node, then that the key
        // is a real CONFIG knob (a range on a non-config key would never be sampled — an honest dead end), then the
        // bounds themselves via the SAME `rangeProblem` sanity check instantiate uses.
        const proj = studio.project();
        const inst = proj.instances.find((i) => i.id === node);
        if (inst === undefined) return fail(`node "${node}" is not in this design — the nodes are [${proj.instances.map((i) => i.id).join(', ') || 'none'}]; add one first (add_component)`);
        // A range must sit on a config VALUE the node actually has — a manifest knob OR an instance override (a
        // universal key like assumedRps is set via set_config, not declared by the manifest). Exactly that set
        // becomes a fixed input cell the Monte-Carlo run can sample; a range on anything else would be silently
        // unsampled, so it is an honest dead end (guide the agent to a real knob or to set_config first).
        const manifestKeys = (studio.mergedCatalog()[inst.type]?.config ?? []).map((c) => String(c.key));
        const knobs = [...new Set([...manifestKeys, ...Object.keys(inst.config ?? {})])];
        if (!knobs.includes(key)) return fail(`node "${node}" (${inst.type}) has no config value "${key}" to range — its config values are [${knobs.join(', ') || 'none'}] (a universal knob like assumedRps must be set with set_config first; describe_component ${inst.type} for the manifest defaults)`);
        const lo = Number(a.lo);
        const hi = Number(a.hi);
        const hasMode = a.mode !== undefined && a.mode !== null;
        const range: Range = hasMode ? { lo, mode: Number(a.mode), hi } : { lo, hi };
        const problem = rangeProblem(range);
        if (problem !== null) return fail(`range on ${node}.${key} is unsound: ${problem} — a range must bracket the value (uniform {lo,hi} or triangular {lo,mode,hi})`);
        return fromR(studio.dispatch({ kind: 'setRange', node, key, range }));
      },
    },
    {
      name: 'clear_range',
      description: 'Remove an uncertainty range previously set with set_range, by its node and config key. e.g. {node:"client", key:"throughput"}',
      inputSchema: obj({ node: { type: 'string' }, key: { type: 'string' } }, ['node', 'key']),
      annotations: EDITS,
      run: (a) => {
        const node = str(a.node);
        const key = str(a.key);
        const inst = studio.project().instances.find((i) => i.id === node);
        if (inst === undefined) return fail(`node "${node}" is not in this design`);
        if (inst.ranges?.[key] === undefined) {
          const list = Object.keys(inst.ranges ?? {}).map((k) => `${node}.${k}`).join(', ') || 'none';
          return fail(`no range on ${node}.${key} — the ranged inputs on this node are [${list}]`);
        }
        return fromR(studio.dispatch({ kind: 'clearRange', node, key }));
      },
    },
    {
      name: 'define_component',
      description: 'Define (or replace) a project-scoped custom component from a JSON manifest: { type, ports[], config?, relations?, bands? }. Components are pure data; ports reference protocols by id (list_protocols). e.g. {json:"{\\"type\\":\\"custom.oracle\\",\\"ports\\":[{\\"name\\":\\"db\\",\\"dir\\":\\"in\\",\\"accepts\\":[\\"oracle-tns\\"]}]}"}',
      inputSchema: obj({ json: { type: 'string' } }, ['json']),
      annotations: EDITS,
      run: (a) => {
        let m: unknown;
        try {
          m = JSON.parse(str(a.json));
        } catch (e) {
          return fail(`invalid JSON: ${String(e)}`);
        }
        // Protocols are an OFFICIAL vocabulary, referenced by id - an invented name would silently never
        // connect to anything. Validate up front and point the agent at the fix (the MCP contract: every
        // error names the next action).
        const ports = (m as { ports?: ReadonlyArray<{ name?: unknown; accepts?: unknown; speaks?: unknown }> }).ports ?? [];
        for (const p of ports) {
          for (const list of [p.accepts, p.speaks]) {
            if (!Array.isArray(list)) continue;
            for (const proto of list) {
              if (!protocolIds.has(String(proto))) {
                const near = [...protocolIds].filter((k) => k.includes(String(proto).slice(0, 3)) || String(proto).includes(k)).slice(0, 4);
                return fail(`port "${String(p.name)}" references unknown protocol "${String(proto)}" - protocols are an official vocabulary, never invented; call list_protocols for the full list${near.length > 0 ? `; closest ids: [${near.join(', ')}]` : ''}`);
              }
            }
          }
        }
        return fromR(studio.dispatch({ kind: 'defineComponent', manifest: m as Manifest }));
      },
    },
    {
      name: 'add_group',
      description: 'Add a visual group/boundary the human sees framing its member nodes (a tier, VPC, availability zone); it also becomes a C4 boundary in generate_doc. Put nodes in it with group_node. e.g. {id:"vpc", label:"Production VPC"}',
      inputSchema: obj({ id: { type: 'string' }, label: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }, ['id', 'label']),
      annotations: EDITS,
      run: (a) =>
        fromR(studio.dispatch({ kind: 'addGroup', id: str(a.id), label: str(a.label), x: Number(a.x ?? 40), y: Number(a.y ?? 40), w: Number(a.w ?? 360), h: Number(a.h ?? 240) })),
    },
    {
      name: 'group_node',
      description: 'Place a node into a group (created with add_group), or omit `group` to ungroup it. A node belongs to at most one group. e.g. {node:"orders_db", group:"vpc"}',
      inputSchema: obj({ node: { type: 'string' }, group: { type: 'string' } }, ['node']),
      annotations: EDITS,
      run: (a) => fromR(studio.dispatch({ kind: 'assignGroup', node: str(a.node), group: a.group !== undefined && a.group !== null && a.group !== '' ? str(a.group) : null })),
    },
    {
      name: 'evaluate',
      description:
        'Evaluate the CURRENT single design — the everyday verdict. Returns {feasible, violations, system, verdicts}: `system` is the end-to-end roll-up per independent flow (throughput · latency · availability · cost at the terminal) + the TRUE total monthly cost — the SAME numbers on the human\'s canvas — and `verdicts` is the per-node band check. PEAK-AWARE: when a generator declares periodic cycles (set_transform fn:"generate" with a preset/cycles), each node is judged against its WORST window — a node calm at the mean but saturated at its declared peak reads a REAL saturation violation here (feasible turns false), the SAME worst-window ρ simulate\'s loadStages and the design doc report. A flat design is byte-identical. Boundary: for the tail (and the loadStages transient) run simulate; to push past the current demand and see what breaks first run envelope; to compare declared what-if worlds run evaluate_scenarios. NOTE: a percentile (p99) SLO reads `unknown` here — run simulate for the tail. e.g. {}',
      inputSchema: obj({}),
      annotations: READS,
      run: () => evaluateResult(),
    },
    {
      name: 'get_project',
      description:
        'Read the WHOLE design back as canonical .sda.json TEXT (the inspect-everything view: nodes, wires, config, SLOs, groups, classes, worlds, ranges). Also the save path for a client with NO file access — write this string VERBATIM to a *.sda.json file (never hand-assemble the JSON). If you can write files, prefer save_design (it writes the file AND live-reloads the human\'s canvas). Inverse: import_project. e.g. {}',
      inputSchema: obj({}),
      annotations: READS,
      run: () => ok(serialize(studio.project())),
    },
    {
      name: 'import_project',
      description: 'Load a WHOLE design from canonical .sda.json TEXT you already hold (the inverse of get_project), replacing the current design. Use this when the design arrives as inline JSON. To load a FILE from the workspace (and track it for save-back / canvas live-reload) use import_design instead. e.g. {json:"{\\"schema\\":3,...}"}',
      inputSchema: obj({ json: { type: 'string' } }, ['json']),
      annotations: REPLACES_SESSION,
      run: (a) => {
        const r = deserialize(str(a.json));
        if (!r.ok) return fail(r.error);
        studio.load(r.value);
        return ok(`loaded "${r.value.name}"`);
      },
    },
    {
      name: 'apply_design',
      description:
        'Build a WHOLE design in ONE call (replacing the canvas by default) — no add/connect/set_config/evaluate round-trips. `instances`: [{id,type,config?,label?,description?}]. `wires`: PORTS ARE OPTIONAL — write [fromId,toId] and the engine uses each node\'s only data port; name a port ONLY when a node has several (e.g. a service with separate db/cache outputs): [fromId,fromPort,toId] or [fromId,fromPort,toId,toPort]. For an async edge append a truthy item or pass {from,to,async:true}. `slos` (optional): [{node,key,cmp:"<="|">=",value}]. Returns the SAME {feasible, violations, system, verdicts} as evaluate (so you see the whole picture immediately). VALIDATION IS ATOMIC AND COLLECTS EVERYTHING: if any type/port/wire is wrong, NOTHING is applied (the canvas is untouched) and the error lists EVERY problem at once with its exact fix — correct them all and retry in ONE call (an ambiguous port is a genuine architectural choice you must name; it is never guessed). Pass replace:false to add to the current design instead of clearing it. e.g. {instances:[{id:"client",type:"client.web",config:{throughput:5000}},{id:"app",type:"compute.service"},{id:"db",type:"db.postgres"}], wires:[["client","app"],["app","db","db","in"]], slos:[{node:"db",key:"latency",cmp:"<=",value:300}]}',
      inputSchema: obj({ instances: { type: 'array', items: { type: 'object' } }, wires: { type: 'array', items: { anyOf: [{ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'boolean' }] } }, { type: 'object' }] } }, slos: { type: 'array', items: { type: 'object' } }, replace: { type: 'boolean' } }, ['instances']),
      annotations: EDITS,
      run: (a) => {
        const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
        const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
        const catalog = studio.mergedCatalog();
        const known = new Set(studio.componentTypes());
        const typeOf = new Map<string, string>();
        const declaredIds = new Set<string>();
        // F1 (the "Copilot wandered" root): COLLECT EVERY problem, never abort on the first. Validate types/ports over
        // the whole payload into `problems`; if any remain we apply NOTHING (atomic — the canvas is untouched, a single
        // undo) and return them ALL with their fixes, so one corrected retry lands the whole design instead of a
        // one-ambiguity-at-a-time death march that strands the agent on step one.
        const problems: string[] = [];
        const cmds: Command[] = [];
        if (a.replace !== false) for (const i of studio.project().instances) cmds.push({ kind: 'removeNode', id: i.id });
        const insts = arr(a.instances).map(rec);
        for (let k = 0; k < insts.length; k++) {
          const o = insts[k] as Record<string, unknown>;
          const id = str(o.id);
          const type = str(o.type);
          declaredIds.add(id);
          if (!known.has(type)) {
            const sug = suggestTypes(type, [...known]);
            problems.push(`add "${id}": unknown type "${type}"${sug.length ? ` — did you mean ${sug.join(', ')}?` : ''} (list_components for all)`);
            continue; // a node with a bad type can be neither placed nor wired — its type is the one fix
          }
          cmds.push({ kind: 'addComponent', id, type, x: 80 + (k % 4) * 240, y: 80 + Math.floor(k / 4) * 150 });
          typeOf.set(id, type);
          for (const [ck, cv] of Object.entries(rec(o.config))) { const n = Number(cv); if (!Number.isNaN(n)) cmds.push({ kind: 'setConfig', node: id, key: ck, value: n }); }
          if (o.label !== undefined) cmds.push({ kind: 'setLabel', id, label: str(o.label) });
          if (o.description !== undefined) cmds.push({ kind: 'setDescription', id, description: str(o.description) });
        }
        // Resolve a wire port. An explicit port is VALIDATED against the node's actual ports (a wire to a
        // non-existent port is rejected here, not silently turned into a broken graph). An omitted port resolves
        // to the node's SOLE port in that direction; a real choice (several) must be named, and the error lists
        // them so the agent fixes it in place instead of guessing.
        const resolvePort = (id: string, dir: 'in' | 'out', given: string): { ok: true; port: string } | { ok: false; error: string } => {
          // GUIDED errors (the MCP contract: every error names the NEXT ACTION, never leaves the agent guessing).
          if (!typeOf.has(id)) {
            // A declared-but-unknown-type node: point back at the type problem rather than mislabel it "unknown node".
            if (declaredIds.has(id)) return { ok: false, error: `wire endpoint "${id}" has an unknown component type — fix its type in \`instances\` (see the type problem above)` };
            // The most common malformed call in the wild: node+port FUSED into one string ("OracleSource,db").
            const comma = id.indexOf(',');
            if (comma > 0 && typeOf.has(id.slice(0, comma))) {
              const node = id.slice(0, comma);
              const port = id.slice(comma + 1);
              return { ok: false, error: `"${id}" fuses node and port into one string - pass them as SEPARATE tuple elements: ["${node}","${port}",<to>] (wire forms: [from,to] | [from,fromPort,to] | [from,fromPort,to,toPort])` };
            }
            return { ok: false, error: `unknown node "${id}" in wires - the nodes in this design are [${[...typeOf.keys()].join(', ') || 'none yet'}]; every wire endpoint must be an instance id declared in \`instances\`` };
          }
          const ps = (catalog[typeOf.get(id) ?? '']?.ports ?? []).filter((p) => p.dir === dir || p.dir === 'bi').map((p) => p.name);
          if (given) {
            if (ps.includes(given)) return { ok: true, port: given };
            return { ok: false, error: `node "${id}" has no ${dir} port "${given}" — its ${dir} ports are [${ps.join(', ') || 'none'}]` };
          }
          if (ps.length === 1) return { ok: true, port: ps[0] as string };
          if (ps.length === 0) return { ok: false, error: `node "${id}" has no ${dir} port to wire` };
          return { ok: false, error: `wire ${dir === 'out' ? 'from' : 'into'} "${id}" is ambiguous — it has ${dir} ports [${ps.join(', ')}]; name which (e.g. ${dir === 'out' ? `["${id}","${ps[0]}",<to>]` : `[<from>,"${id}","${ps[0]}"]`})` };
        };
        for (const w of arr(a.wires)) {
          // [from,to] · [from,fromPort,to] · [from,fromPort,to,toPort,async?] · {from,to,fromPort?,toPort?,async?}
          let fromId: string, toId: string, fromPort: string, toPort: string, async: boolean;
          if (Array.isArray(w)) {
            if (w.length <= 2) { fromId = str(w[0]); fromPort = ''; toId = str(w[1]); toPort = ''; async = false; }
            else if (w.length === 3) { fromId = str(w[0]); fromPort = str(w[1]); toId = str(w[2]); toPort = ''; async = false; }
            else { fromId = str(w[0]); fromPort = str(w[1]); toId = str(w[2]); toPort = str(w[3]); async = Boolean(w[4]); }
          } else {
            const o = rec(w); fromId = str(o.from); fromPort = str(o.fromPort); toId = str(o.to); toPort = str(o.toPort); async = Boolean(o.async);
          }
          const fp = resolvePort(fromId, 'out', fromPort);
          const tp = resolvePort(toId, 'in', toPort);
          if (!fp.ok) problems.push(fp.error);
          if (!tp.ok) problems.push(tp.error);
          if (fp.ok && tp.ok) {
            const bad = illegalWire(catalog, typeOf.get(fromId) ?? '', fp.port, typeOf.get(toId) ?? '', tp.port);
            if (bad) problems.push(`wire ${fromId} → ${toId}: ${bad}`);
            else cmds.push({ kind: 'connect', from: [fromId, fp.port], to: [toId, tp.port], ...(async ? { semantics: 'async' as const } : {}) });
          }
        }
        for (const sx of arr(a.slos)) {
          const o = rec(sx);
          const band: Band = { shape: 'minTargetMax', ...(o.cmp === '>=' ? { min: Number(o.value) } : { max: Number(o.value) }) };
          cmds.push({ kind: 'setSLO', node: str(o.node), key: Key(str(o.key)), band });
        }
        // ALL problems, or none: nothing is applied while ANY remains (F1 — never a half-built canvas, never the
        // first error only). The agent fixes every line and retries in a single call.
        if (problems.length > 0) {
          return fail(`apply_design applied NOTHING (atomic) — fix ${problems.length === 1 ? 'this problem' : `all ${problems.length} problems`} and retry in ONE call:\n${problems.map((p) => `- ${p}`).join('\n')}`);
        }
        const r = studio.dispatchBatch(cmds);
        if (!r.ok) return fail(r.error);
        return evaluateResult(); // same {feasible, violations, system, verdicts} as evaluate — and surfaces any build error
      },
    },
    // ── REQUEST CLASSES (doc: request-classes §7.1) — declare the named multi-commodity flows over a shared,
    //    possibly cyclic topology. The each-to-each mesh answer: split traffic into acyclic classes that share the
    //    physical nodes. Membership names EXISTING wires (ports OPTIONAL — resolved to the drawn wire, self-correcting).
    {
      name: 'declare_class',
      description:
        "Declare (or REPLACE by id) a REQUEST CLASS — a named traffic flow with its own ORIGINS (where it injects load) and its own WIRE membership (the edges it traverses), over a shared topology. This is the answer to an each-to-each mesh (A calls B for orders; B calls A for reports): the drawing is cyclic but each class is acyclic, so it computes honestly instead of being refused. `origins`: [{node, rps}]. `wires`: pairs [fromNode, toNode] (ports OPTIONAL — the drawn wire is resolved; name ports only if several wires share a node pair). A wire may belong to MANY classes. No classes declared ⇒ the single implicit river (today, bit-for-bit). A class naming a wire/node the design lacks, or a cyclic class, is refused with a guided message. e.g. {id:\"orders\", origins:[{node:\"A\", rps:800}], wires:[[\"A\",\"B\"]]}",
      inputSchema: obj(
        {
          id: { type: 'string' },
          origins: { type: 'array', items: { type: 'object', properties: { node: { type: 'string' }, rps: { type: 'number' } }, required: ['node', 'rps'] } },
          wires: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        },
        ['id'],
      ),
      annotations: EDITS,
      run: (a) => {
        const origins = (Array.isArray(a.origins) ? a.origins : []).map((o) => { const r = o as Record<string, unknown>; return { node: str(r.node), rps: Number(r.rps) }; });
        const refs: WireRef[] = [];
        for (const w of Array.isArray(a.wires) ? a.wires : []) {
          const rr = resolveWireRef(w);
          if (!rr.ok) return fail(rr.error);
          refs.push(rr.ref);
        }
        const decl: RequestClassDecl = { id: str(a.id), wires: refs, origins };
        return fromR(studio.dispatch({ kind: 'declareClass', decl }));
      },
    },
    {
      name: 'set_class_membership',
      description: "Add or remove ONE wire from a request class's membership. `class`, the wire as [fromNode, toNode] (ports optional), and `member` (true to add, false to remove). Membership is a SET — a shared wire can belong to several classes. e.g. {class:\"orders\", wire:[\"A\",\"B\"], member:true}",
      inputSchema: obj({ class: { type: 'string' }, wire: { type: 'array', items: { type: 'string' } }, member: { type: 'boolean' } }, ['class', 'wire', 'member']),
      annotations: EDITS,
      run: (a) => {
        const rr = resolveWireRef(a.wire);
        if (!rr.ok) return fail(rr.error);
        return fromR(studio.dispatch({ kind: 'setClassMembership', class: str(a.class), from: rr.ref.from, to: rr.ref.to, member: a.member !== false }));
      },
    },
    {
      name: 'set_class_origin',
      description: 'Set the rate a request class injects at a node (its per-class assumedRps), or omit `rps` to clear that origin. The classes at a node together make up the node total. e.g. {class:"orders", node:"A", rps:800}',
      inputSchema: obj({ class: { type: 'string' }, node: { type: 'string' }, rps: { type: 'number' } }, ['class', 'node']),
      annotations: EDITS,
      run: (a) => fromR(studio.dispatch({ kind: 'setClassOrigin', class: str(a.class), node: str(a.node), rps: a.rps === undefined || a.rps === null ? null : Number(a.rps) })),
    },
    {
      name: 'remove_class',
      description: 'Remove a declared request class by id. With none left, the design reverts to the single implicit river (today). e.g. {id:"orders"}',
      inputSchema: obj({ id: { type: 'string' } }, ['id']),
      annotations: EDITS,
      run: (a) => fromR(studio.dispatch({ kind: 'removeClass', id: str(a.id) })),
    },
    {
      name: 'list_classes',
      description: 'List the declared request classes — each id, its per-node origins, and its wire membership. Empty ⇒ the single implicit river (every wire, every node origin). e.g. {}',
      inputSchema: obj({}),
      annotations: READS,
      run: () =>
        json(
          studio.project().requestClasses.map((c) => ({
            id: c.id,
            ...(c.name !== undefined ? { name: c.name } : {}),
            origins: c.origins.map((o) => ({ node: o.node, rps: o.rps })),
            wires: c.wires.map((r) => `${r.from[0]} → ${r.to[0]}`),
          })),
        ),
    },
    { name: 'undo', description: 'Undo the last change (reverts the previous tool that mutated the design; the human sees the canvas step back). e.g. {}', inputSchema: obj({}), annotations: EDITS_HISTORY, run: () => ({ ok: studio.undo(), text: 'undone' }) },
    { name: 'redo', description: 'Redo the last change you undid — re-applies it, and the human sees the canvas step forward. e.g. {}', inputSchema: obj({}), annotations: EDITS_HISTORY, run: () => ({ ok: studio.redo(), text: 'redone' }) },
  ];
}
