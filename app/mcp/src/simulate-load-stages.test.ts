import { describe, expect, it } from 'vitest';
import type { Cycle } from '@sda/engine-core';
import { Studio } from '@sda/core';
import { registry, allManifests, LOAD_STAGES_PRESETS, TRANSIENT_BASIS } from '@sda/content';
import { buildSimTools } from './simulate';
import type { AnyTool } from './tools';

// THE LOAD-STAGES TRANSIENT over MCP (doc: load-stages §10) — the old global `stress_probe` TOOL is DELETED (the
// net-negative ledger, §2); the two-tier transient now rides the EXISTING `simulate` output under `loadStages`.
// These pin: `stress_probe` is gone; a FLAT design gets no `loadStages` (no-filler); a design whose generator
// declares periodic cycles gets the Tier-1 envelope + worst window + honest bill + the Tier-2 survival verdict,
// both bases labelled and whole-ms/whole-second honest; and it is deterministic.

/** A small burst-shaped chain: src generate(on-off-burst) → svc (1 server · 100 ms ⇒ 10 req/s cap) → db. The
 *  10-minute burst period keeps the auto-derived span short, so the Tier-2 DES runs fast in a unit test. */
function chain(cycles?: readonly Cycle[]): Studio {
  const s = new Studio(registry, allManifests);
  s.dispatch({ kind: 'addComponent', id: 'src', type: 'compute.service', x: 0, y: 0 });
  s.dispatch({ kind: 'setConfig', node: 'src', key: 'concurrency', value: 100000 });
  s.dispatch({ kind: 'setTransform', node: 'src', port: 'out', transform: { kind: 'generate', level: 5, ...(cycles ? { cycles } : {}) } });
  s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.service', x: 0, y: 0 });
  s.dispatch({ kind: 'setConfig', node: 'svc', key: 'concurrency', value: 1 });
  s.dispatch({ kind: 'setConfig', node: 'svc', key: 'perRequestDuration', value: 100 });
  s.dispatch({ kind: 'setConfig', node: 'svc', key: 'latency', value: 100 });
  s.dispatch({ kind: 'addComponent', id: 'db', type: 'compute.service', x: 0, y: 0 });
  s.dispatch({ kind: 'setConfig', node: 'db', key: 'concurrency', value: 100000 });
  s.dispatch({ kind: 'setConfig', node: 'db', key: 'perRequestDuration', value: 2 });
  s.dispatch({ kind: 'setConfig', node: 'db', key: 'latency', value: 2 });
  s.dispatch({ kind: 'connect', from: ['src', 'out'], to: ['svc', 'in'] });
  s.dispatch({ kind: 'connect', from: ['svc', 'out'], to: ['db', 'in'] });
  return s;
}

const simTool = (s: Studio): AnyTool => buildSimTools(s, registry).find((t) => t.name === 'simulate') as AnyTool;
const runSim = (s: Studio): Record<string, unknown> => JSON.parse((simTool(s).run({}) as { ok: boolean; text: string }).text) as Record<string, unknown>;

interface LoadStages {
  basis: { tier1: string; tier2?: string };
  spanS: number;
  windowS: number;
  rhoEnvelope: number[];
  peakRho: number;
  worstWindow: { atS: number; rho: number; node: string };
  costMeanUsdMonth: number;
  pctWindowsViolating: number;
  transient?: { verdict: { survives: boolean; note: string; basis: string; peakBacklog: unknown }; budget: { truncated: boolean } };
}

describe('simulate — the load-stages two-tier transient rides the tool output', () => {
  it('the standalone stress_probe TOOL is deleted (the net-negative ledger, doc §2)', () => {
    const tools = buildSimTools(chain(), registry);
    expect(tools.some((t) => t.name === 'stress_probe')).toBe(false);
    expect(tools.some((t) => t.name === 'simulate')).toBe(true);
  });

  it('a FLAT design (no cycles) gets NO loadStages section (no-filler)', () => {
    const j = runSim(chain());
    expect(j.loadStages).toBeUndefined();
    expect(j.tailLatencyMs).toBeDefined(); // the ordinary tail is unchanged
  });

  it('a design with declared cycles returns the Tier-1 envelope + worst window + the Tier-2 verdict, both bases labelled', () => {
    const j = runSim(chain(LOAD_STAGES_PRESETS['on-off-burst']));
    const ls = j.loadStages as LoadStages;
    expect(ls).toBeDefined();
    // Tier 1 — analytic quasi-static.
    expect(ls.basis.tier1).toBe('analytic (quasi-static)');
    expect(ls.spanS).toBe(600 * 2); // the burst period (10 min) × spanRepeats (2)
    expect(ls.rhoEnvelope.length).toBeGreaterThan(1);
    expect(ls.peakRho).toBeGreaterThan(0);
    expect(ls.worstWindow.node).toBe('svc'); // the 1-server bottleneck is where ρ peaks
    expect(ls.costMeanUsdMonth).toBeGreaterThanOrEqual(0);
    // Tier 2 — measured transient, proven at the worst window.
    expect(ls.transient).toBeDefined();
    expect(ls.basis.tier2).toBe(TRANSIENT_BASIS);
    expect(ls.transient!.verdict.basis).toBe(TRANSIENT_BASIS);
    expect(typeof ls.transient!.verdict.survives).toBe('boolean');
    expect(ls.transient!.verdict.note.length).toBeGreaterThan(0);
  });

  it('is deterministic: the same cyclic design reproduces the loadStages transient verdict', () => {
    const a = runSim(chain(LOAD_STAGES_PRESETS['on-off-burst'])).loadStages as LoadStages;
    const b = runSim(chain(LOAD_STAGES_PRESETS['on-off-burst'])).loadStages as LoadStages;
    expect(JSON.stringify(a.transient?.verdict)).toBe(JSON.stringify(b.transient?.verdict));
  });
});
