import { describe, expect, it } from 'vitest';
import type { Cycle } from '@sda/engine-core';
import { Studio } from '@sda/core';
import { registry, allManifests, LOAD_STAGES_PRESETS } from '@sda/content';
import { buildTools, type AnyTool } from './tools';
import { buildDocTools } from './document';

// ONE TRUTH — the spine (peaks-integration §3–§4, under the owner redesign). A node calm at the steady mean but
// SATURATED at its declared worst window must read RED on the canvas AND in MCP `evaluate` AND in the generated
// deliverable — no surface may report steady-green while another shows the tier broken (web-is-a-dumb-renderer /
// one-truth). Setup: src generate(on-off-burst = ×5 burst) at level 5 → svc (1 server · 100 ms ⇒ 10 req/s cap).
// Steady svc ρ = 5/10 = 0.5 (ok); worst-window ρ = 25/10 = 2.5 (saturated). Before this spine, `evaluate` and
// `generate_doc` read svc GREEN (they judge the steady graph); now they fold in the sweep's worst-window ρ and read
// the SAME saturation the canvas does — with NO 'peak' vocabulary (a violation is a violation, owner ruling).

function shapedChain(cycles?: readonly Cycle[]): Studio {
  const s = new Studio(registry, allManifests);
  s.dispatch({ kind: 'addComponent', id: 'src', type: 'compute.service', x: 0, y: 0 });
  s.dispatch({ kind: 'setConfig', node: 'src', key: 'concurrency', value: 100000 });
  s.dispatch({ kind: 'setTransform', node: 'src', port: 'out', transform: { kind: 'generate', level: 5, ...(cycles ? { cycles } : {}) } });
  s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.service', x: 0, y: 0 });
  s.dispatch({ kind: 'setConfig', node: 'svc', key: 'concurrency', value: 1 });
  s.dispatch({ kind: 'setConfig', node: 'svc', key: 'perRequestDuration', value: 100 });
  s.dispatch({ kind: 'connect', from: ['src', 'out'], to: ['svc', 'in'] });
  return s;
}

const tool = (s: Studio, name: string): AnyTool => [...buildTools(s), ...buildDocTools(s)].find((t) => t.name === name) as AnyTool;
const runJson = (t: AnyTool): Record<string, unknown> => JSON.parse((t.run({}) as { ok: boolean; text: string }).text) as Record<string, unknown>;
const runText = (t: AnyTool): string => (t.run({}) as { ok: boolean; text: string }).text;

interface EvalVerdict { scope: string; key: string; status: string; value: number | null; unit: string; fix?: string }

describe('peaks — one truth across evaluate + generate_doc (a node steady-ok but worst-window-saturated)', () => {
  const shaped = shapedChain(LOAD_STAGES_PRESETS['on-off-burst']);

  it('MCP evaluate folds in the worst-window ρ: feasible=false with an svc saturation violation (∞ latency), no peak vocabulary', () => {
    const j = runJson(tool(shaped, 'evaluate'));
    expect(j.feasible).toBe(false);
    const verdicts = j.verdicts as EvalVerdict[];
    const sat = verdicts.find((v) => v.scope === 'svc' && v.status === 'violation');
    expect(sat).toBeDefined();
    expect(String(sat!.key)).toBe('latency');
    expect(sat!.value).toBeNull(); // Infinity serialises to null in JSON — the unbounded-latency saturation
    // A violation is a violation: the row carries NO 'peak' basis / vocabulary and no clock instant.
    expect(JSON.stringify(sat).toLowerCase()).not.toContain('peak');
    expect(JSON.stringify(sat)).not.toContain('@');
  });

  it('the generated design doc marks svc as saturated — the deliverable never launders the worst window into green', () => {
    const md = runText(tool(shaped, 'generate_doc'));
    expect(md).toContain('svc');
    expect(md.toLowerCase()).toMatch(/saturat|unbounded|ρ ≥ 1|over capacity|∞/);
    // The doc, like evaluate, adds no 'peak' vocabulary of its own for this saturation.
    expect(md.toLowerCase()).not.toContain('at peak (');
  });

  it('SACRED PIN: the flat baseline (no cycles) reads feasible-green — the spine only bites when a shape declares the worst window', () => {
    const flat = shapedChain(); // no cycles ⇒ no sweep ⇒ svc judged at steady ρ 0.5
    const j = runJson(tool(flat, 'evaluate'));
    expect(j.feasible).toBe(true);
    const verdicts = j.verdicts as EvalVerdict[];
    expect(verdicts.some((v) => v.scope === 'svc' && v.status === 'violation')).toBe(false);
  });
});
