import type { Registry } from '@sda/engine-core';
import type { SolverBindings } from '@sda/solver-contract';
import type { Studio } from '@sda/core';
import {
  computeEnvelope,
  deriveDefaultScenarios,
  evaluateWorlds,
  mergeDerivedTrio,
  resetScenario,
  type AssumptionScenario,
  type EnvelopeResult,
  type ScenarioOverride,
  type WorldsResult,
} from '@sda/content';
import type { Command } from '@sda/core';
import type { AsyncToolDef, ToolResult } from './tools';
import { EDITS, fail, json, obj, ok, READS, round, str } from './tool-kit';

// THE ASSUMPTION MODEL over MCP — the minimal surface so the owner can DRIVE the whole
// model before any UI exists: the ENVELOPE (the default answer, no demand needed) plus NAMED WORLDS (declare a
// scenario, set/clear its fact-assumption overrides, list them, and evaluate all worlds in one batch). The scenario
// EDIT tools ride the synchronous command core (the role boundary is enforced there with a guided error); the
// ENVELOPE and EVALUATE tools await the bound solver (optimize / evaluateBatch), so the whole module lives with the
// other solver-bound tools and receives the composition root's `SolverBindings`.

// The backward-search / batch model is built CLASS-BLIND; under declared request classes the per-class origin
// injection is not modelled here, so a class-blind envelope or world evaluation would LIE. We decline honestly —
// never a quiet single-river answer — exactly as the backward-search tools do.
const MULTI_CLASS_DECLINE =
  'not available under declared request classes — the envelope/worlds are computed class-blind, so they would misreport per-class origins. Remove the request classes to use them on the single-river design, or evaluate per class.';

/** Render the envelope as guided text (doc §3): per-origin edges, the joint edge, and the queueing knee. */
function formatEnvelope(env: EnvelopeResult): string {
  if (env.perOrigin.length === 0) return env.note ?? 'no envelope — the design has no traffic origin';
  const lines: string[] = ['Capacity envelope — the max sustained load before an SLO breaks (no declared demand needed):'];
  for (const o of env.perOrigin) {
    if (o.maxRps === undefined) {
      lines.push(`- ${o.node} (${o.key}): ${o.note ?? 'edge unknown'}`);
      continue;
    }
    const brk = o.firstBreak ? `first break: ${o.firstBreak.node}.${o.firstBreak.key}` : 'no binding SLO';
    const band = o.minRps !== undefined ? `holds ${o.minRps}–${o.maxRps} req/s` : `holds to ${o.maxRps} req/s`;
    lines.push(`- ${o.node} (${o.key}): ${band} [basis: ${o.basis}] — ${brk}${o.note ? ` (${o.note})` : ''}`);
  }
  if (env.joint) {
    const j = env.joint;
    lines.push(
      j.maxTotalRps === undefined
        ? `Joint (all origins at the current ratio): edge unknown`
        : `Joint (all origins at the current ratio): holds to ${j.maxTotalRps} req/s total [basis: ${j.basis}]${j.firstBreak ? ` — first break: ${j.firstBreak.node}.${j.firstBreak.key}` : ''}`,
    );
  }
  if (env.knee) lines.push(`Knee (queueing): real latency starts to run away at ~${env.knee.atRps} req/s (utilisation ρ reaches ${env.knee.utilization} at ${env.knee.node})`);
  lines.push('Absolute cost / utilization / confidence need a declared demand — declare a scenario (a named world) for those.');
  return lines.join('\n');
}

/** Render a freshly-derived trio as guided text (doc §5): each world and its derived overrides, badged so the AI
 *  sees which values are live placeholders awaiting a measurement. */
function formatDerived(trio: readonly AssumptionScenario[]): string {
  const lines: string[] = ["Derived the pessimistic / real / optimistic trio from THIS design's capacity (badged `derived`, live-tracking until you edit them):"];
  for (const s of trio) {
    const ov = s.overrides.map((o) => `${o.node}.${o.key}=${round(o.value)}${o.provenance ? ` [${o.provenance}]` : ''}`).join(', ');
    lines.push(`- ${s.name ?? s.id}: ${ov || '(no overrides)'}`);
  }
  lines.push('Evaluate them with evaluate_scenarios; set_scenario_value freezes a value you edit; clear_scenario_value returns it to derived tracking.');
  return lines.join('\n');
}

/** Render the world-comparison matrix as guided text (doc §7.2): the base world plus every declared world. */
function formatWorlds(res: WorldsResult): string {
  if (res.worlds.length === 0) return 'no worlds evaluated';
  const lines: string[] = ['World comparison (base + declared worlds), one EvaluateBatch:'];
  for (const w of res.worlds) {
    const verdict = w.feasible ? 'ok' : `${w.violations} violation${w.violations === 1 ? '' : 's'}`;
    const rho = w.peakRho === undefined ? '—' : round(w.peakRho);
    const stale = w.staleOverrides.length > 0 ? ` · stale overrides skipped: [${w.staleOverrides.join(', ')}]` : '';
    lines.push(`- ${w.id}${w.name ? ` (${w.name})` : ''}: cost $${round(w.costUsdMonth)}/mo · peak ρ ${rho} · ${verdict}${stale}`);
    for (const v of w.verdicts.filter((x) => x.status === 'violation')) lines.push(`    ✗ ${v.scope}.${v.key} = ${v.value ?? '—'} ${v.unit}`);
  }
  return lines.join('\n');
}

export function buildAssumptionTools(studio: Studio, registry: Registry, solvers: SolverBindings): AsyncToolDef[] {
  const multiClass = (): boolean => studio.project().requestClasses.length > 0;
  const fromR = (r: { ok: true; value: string } | { ok: false; error: string }): ToolResult => (r.ok ? ok(r.value) : fail(r.error));

  return [
    {
      name: 'envelope',
      description:
        'THE DEFAULT ANSWER — no declared demand needed. Computes the CAPACITY ENVELOPE: the maximum sustained load each traffic origin can carry with EVERY SLO still green, WHAT breaks first as load grows (the breaking order), and the queueing KNEE (where real latency starts to run away). Per-origin max is the native solver INVERSION (free the demand, maximise it s.t. the SLOs); the breaking order + knee come from a load sweep. Answers RELATIVE questions (how far can this be pushed, what gives first) with no assumption; absolute cost / utilization / confidence need a declared demand (a scenario). Reports honest states (no origin ⇒ no envelope; violated at zero load ⇒ 0). Boundary: evaluate judges the CURRENT demand; envelope finds how far it can be PUSHED and what breaks first. e.g. {}',
      inputSchema: obj({}),
      annotations: READS,
      run: async (): Promise<ToolResult> => {
        if (multiClass()) return fail(MULTI_CLASS_DECLINE);
        const optimize = solvers.optimize;
        if (optimize === undefined) return fail('this server has no backward-search solver bound — envelope is unavailable');
        const proj = studio.project();
        const env = await computeEnvelope({ instances: proj.instances, wires: proj.wires, registry, catalog: studio.mergedCatalog() }, optimize);
        return ok(formatEnvelope(env));
      },
    },
    {
      name: 'derive_scenarios',
      description:
        "AUTHOR THE TRIO FOR YOU — create the pessimistic / real / optimistic worlds with values ALREADY filled in, derived from THIS design's own capacity envelope (offered demand ≈ 110% / 60% / 30% of each origin's maximum — pessimistic deliberately past the edge) and any declared ranges (picked at their unfavourable / mode / favourable ends where polarity is known). No invented numbers: every derived value is badged `derived` and live-tracks the envelope until you edit it. Re-running PRESERVES any value you have already edited (frozen). Honest empty-with-reason when there is no traffic origin or declared range to derive from. e.g. {}",
      inputSchema: obj({}),
      annotations: EDITS,
      run: async (): Promise<ToolResult> => {
        if (multiClass()) return fail(MULTI_CLASS_DECLINE);
        const optimize = solvers.optimize;
        if (optimize === undefined) return fail('this server has no backward-search solver bound — derive_scenarios is unavailable');
        const proj = studio.project();
        const catalog = studio.mergedCatalog();
        const envelope = await computeEnvelope({ instances: proj.instances, wires: proj.wires, registry, catalog }, optimize);
        const derived = deriveDefaultScenarios({ instances: proj.instances, wires: proj.wires, catalog, envelope });
        if (derived.scenarios.length === 0) return ok(`No trio derived — ${derived.reason ?? 'nothing to derive from (no origin, no declared range)'}`);
        // Merge over any existing worlds so a re-derive keeps the architect's frozen edits, then commit the trio as
        // ONE undoable batch (declareScenario replaces each by id; custom worlds are untouched).
        const trio = mergeDerivedTrio(proj.scenarios, derived.scenarios);
        const cmds: Command[] = trio.map((s) => ({ kind: 'declareScenario', decl: s }));
        const r = studio.dispatchBatch(cmds);
        if (!r.ok) return fail(r.error);
        return ok(formatDerived(trio));
      },
    },
    {
      name: 'declare_scenario',
      description:
        'Declare (or REPLACE by id) a NAMED WORLD (scenario) — a point in the assumption space: a name plus overrides on the FACT-ASSUMPTION inputs (offered load, a service time, a payload size). Typically a trio: pessimistic / real / optimistic. `overrides` (optional): [{node, key, value}] — a scenario may override ONLY fact-assumption keys (a limit/SLO override is refused, naming the role and the right surface). No scenarios ⇒ the base layer IS the design (today, bit-for-bit). Set/clear individual values later with set_scenario_value / clear_scenario_value. e.g. {id:"peak", name:"Black Friday", overrides:[{node:"client", key:"throughput", value:12000}]}',
      inputSchema: obj(
        {
          id: { type: 'string' },
          name: { type: 'string' },
          overrides: { type: 'array', items: { type: 'object', properties: { node: { type: 'string' }, key: { type: 'string' }, value: { type: 'number' } }, required: ['node', 'key', 'value'] } },
        },
        ['id'],
      ),
      annotations: EDITS,
      run: async (a): Promise<ToolResult> => {
        const overrides: ScenarioOverride[] = (Array.isArray(a.overrides) ? a.overrides : []).map((o) => {
          const r = o as Record<string, unknown>;
          return { node: str(r.node), key: str(r.key), value: Number(r.value) };
        });
        const name = a.name !== undefined && a.name !== null && str(a.name) !== '' ? str(a.name) : undefined;
        return fromR(studio.dispatch({ kind: 'declareScenario', decl: { id: str(a.id), ...(name !== undefined ? { name } : {}), overrides } }));
      },
    },
    {
      name: 'set_scenario_value',
      description:
        "Set one FACT-ASSUMPTION override in a named world: {scenario, node, key, value}. Only a fact-assumption key is overridable — a resource limit is refused (change it with set_config / the Improve search), a computed result is an output (not settable), an SLO is a promise (set_slo). The error names the key's actual role and the right surface. Replaces the value if the (node,key) is already overridden in that world. e.g. {scenario:\"peak\", node:\"client\", key:\"throughput\", value:12000}",
      inputSchema: obj({ scenario: { type: 'string' }, node: { type: 'string' }, key: { type: 'string' }, value: { type: 'number' } }, ['scenario', 'node', 'key', 'value']),
      annotations: EDITS,
      run: async (a): Promise<ToolResult> => fromR(studio.dispatch({ kind: 'setScenarioOverride', scenario: str(a.scenario), node: str(a.node), key: str(a.key), value: Number(a.value) })),
    },
    {
      name: 'clear_scenario_value',
      description: 'Remove one override from a named world, by {scenario, node, key} — the value falls back to the base layer for that world. e.g. {scenario:"peak", node:"client", key:"throughput"}',
      inputSchema: obj({ scenario: { type: 'string' }, node: { type: 'string' }, key: { type: 'string' } }, ['scenario', 'node', 'key']),
      annotations: EDITS,
      run: async (a): Promise<ToolResult> => fromR(studio.dispatch({ kind: 'clearScenarioOverride', scenario: str(a.scenario), node: str(a.node), key: str(a.key) })),
    },
    {
      name: 'remove_scenario',
      description: 'Remove a declared named world by id. With none left, the design reverts to the base layer (no named worlds). e.g. {id:"peak"}',
      inputSchema: obj({ id: { type: 'string' } }, ['id']),
      annotations: EDITS,
      run: async (a): Promise<ToolResult> => fromR(studio.dispatch({ kind: 'removeScenario', id: str(a.id) })),
    },
    {
      name: 'reset_scenario',
      description:
        'RESET a named world — the NON-preserving twin of derive_scenarios: {id}. A DERIVED-TRIO world (pessimistic / real / optimistic) is WIPED back to its freshly-derived values — any value you froze by editing is DROPPED, and it re-tracks THIS design\'s capacity envelope from scratch. A CUSTOM world simply has its overrides CLEARED (it falls back to the base design). Use derive_scenarios to re-derive while KEEPING your frozen edits; use reset_scenario for a clean slate. Honest: under request classes / with no solver a trio id has no fresh derivation, so it clears to base. e.g. {id:"real"}',
      inputSchema: obj({ id: { type: 'string' } }, ['id']),
      annotations: EDITS,
      run: async (a): Promise<ToolResult> => {
        const id = str(a.id);
        const proj = studio.project();
        if (!proj.scenarios.some((s) => s.id === id)) return fail(`no named world "${id}" — list_scenarios to see the declared worlds`);
        // A trio reset needs a fresh derivation (the envelope); a custom clear does not. Derive only where it is
        // genuinely available — a request-classes / no-solver design still clears a custom world (or a trio to base).
        let fresh: readonly AssumptionScenario[] = [];
        const optimize = solvers.optimize;
        if (!multiClass() && optimize !== undefined) {
          const catalog = studio.mergedCatalog();
          const envelope = await computeEnvelope({ instances: proj.instances, wires: proj.wires, registry, catalog }, optimize);
          fresh = deriveDefaultScenarios({ instances: proj.instances, wires: proj.wires, catalog, envelope }).scenarios;
        }
        const reset = resetScenario(proj.scenarios, fresh, id);
        if (reset === undefined) return fail(`could not reset "${id}"`);
        const r = studio.dispatch({ kind: 'declareScenario', decl: reset });
        if (!r.ok) return fail(r.error);
        return ok(
          fresh.some((f) => f.id === id)
            ? `Reset "${id}" to its freshly-derived values — dropped any frozen edits; it re-tracks the capacity envelope. evaluate_scenarios to compare the worlds.`
            : `Cleared "${id}"'s overrides — it now falls back to the base design. evaluate_scenarios to compare the worlds.`,
        );
      },
    },
    {
      name: 'list_scenarios',
      description: 'List the declared named worlds — each id, its friendly name, and its fact-assumption overrides. Empty ⇒ no named worlds (the base layer is the design). e.g. {}',
      inputSchema: obj({}),
      annotations: READS,
      run: async (): Promise<ToolResult> =>
        json(
          studio.project().scenarios.map((s) => ({
            id: s.id,
            ...(s.name !== undefined ? { name: s.name } : {}),
            overrides: s.overrides.map((o) => ({ node: o.node, key: o.key, value: o.value })),
          })),
        ),
    },
    {
      name: 'evaluate_scenarios',
      description:
        'Evaluate the BASE world AND every declared world in ONE EvaluateBatch — the metrics×worlds matrix: per world its absolute monthly cost, peak utilisation ρ, and per-node queueing-aware verdicts (feasible / the violations). Declare worlds first with declare_scenario; with none it reports just the base world. Stale overrides (a node/key the design no longer carries) are reported and skipped — a scenario is a soft lens. Boundary: evaluate judges ONE design; evaluate_scenarios compares the declared what-if worlds side by side. e.g. {}',
      inputSchema: obj({}),
      annotations: READS,
      run: async (): Promise<ToolResult> => {
        if (multiClass()) return fail(MULTI_CLASS_DECLINE);
        const evaluateBatch = solvers.evaluateBatch;
        if (evaluateBatch === undefined) return fail('this server has no batch-evaluation backend bound — evaluate_scenarios is unavailable');
        const g = studio.graph();
        if (!g.ok) return fail('design has build errors — resolve those first (evaluate to see them)');
        const proj = studio.project();
        const res = await evaluateWorlds({ graph: g.value, instances: proj.instances, wires: proj.wires, scenarios: proj.scenarios, systemPromises: proj.systemPromises }, evaluateBatch);
        return ok(formatWorlds(res));
      },
    },
  ];
}
