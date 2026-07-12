import { describe, expect, it } from 'vitest';
import type { Cycle } from '@sda/engine-core';
import { Studio } from '@sda/core';
import { evaluate } from '@sda/engine-solve';
import { registry, allManifests, twoTierEvaluation, LOAD_STAGES_PRESETS, type EvaluateGraph } from '@sda/content';
import { twoTierSection } from '@sda/presenter';

// WEB SMOKE — the ambient Load-stages block's whole pipeline, exactly as app.tsx runs it (web-is-a-dumb-renderer:
// the shell computes NOTHING itself). The System panel's two-tier read-out = studio.graph() → the two-tier-worker's
// twoTierEvaluation (replayed inline here, same seed) → the shared presenter twoTierSection → `.vr` rows. This pins
// that a shaped design produces the block (the ρ-envelope strip, the worst-window callout, the survival verdict,
// both bases labelled) and that a FLAT design produces nothing (no-filler — the block never renders).

const evalDI: EvaluateGraph = (g) => { const r = evaluate(g, registry); return r.ok ? r.value : undefined; };

function buildStudio(cycles?: readonly Cycle[]): Studio {
  const s = new Studio(registry, allManifests);
  s.dispatch({ kind: 'addComponent', id: 'src', type: 'compute.service', x: 0, y: 0 });
  s.dispatch({ kind: 'setConfig', node: 'src', key: 'concurrency', value: 100000 });
  s.dispatch({ kind: 'setTransform', node: 'src', port: 'out', transform: { kind: 'generate', level: 5, ...(cycles ? { cycles } : {}) } });
  s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.service', x: 0, y: 0 });
  s.dispatch({ kind: 'setConfig', node: 'svc', key: 'concurrency', value: 1 });
  s.dispatch({ kind: 'setConfig', node: 'svc', key: 'perRequestDuration', value: 100 }); // 1 server · 100 ms ⇒ cap 10 req/s
  s.dispatch({ kind: 'setConfig', node: 'svc', key: 'latency', value: 100 });
  s.dispatch({ kind: 'addComponent', id: 'db', type: 'compute.service', x: 0, y: 0 });
  s.dispatch({ kind: 'setConfig', node: 'db', key: 'concurrency', value: 1000 });
  s.dispatch({ kind: 'setConfig', node: 'db', key: 'perRequestDuration', value: 2 });
  s.dispatch({ kind: 'setConfig', node: 'db', key: 'latency', value: 2 });
  s.dispatch({ kind: 'connect', from: ['src', 'out'], to: ['svc', 'in'] });
  s.dispatch({ kind: 'connect', from: ['svc', 'out'], to: ['db', 'in'] });
  return s;
}

const labelOf = (id: string): string => (id === 'svc' ? 'Order service' : id);

describe('web smoke — the ambient Load-stages block renders the two-tier read-out', () => {
  it('a shaped design produces the block: the ρ-envelope strip, the worst-window callout, the survival verdict, both bases', () => {
    const g = buildStudio(LOAD_STAGES_PRESETS['on-off-burst']).graph();
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const result = twoTierEvaluation({ graph: g.value, evaluate: evalDI, maxEvents: 200_000 });
    expect(result).toBeDefined();
    if (result === undefined) return;
    const section = twoTierSection(result, labelOf);
    const labels = section.rows.map((r) => r.label);
    expect(labels).toContain('Load envelope · ρ(t)');
    expect(labels).toContain('Worst window');
    expect(labels).toContain('Cost · mean over span');
    expect(labels).toContain('Over capacity');
    // Tier 2 ran ⇒ the survival verdict rows + the "measured" basis are present.
    expect(labels).toContain('Worst window · verdict');
    expect(section.rows.find((r) => r.label === 'Basis')?.value).toContain('measured (transient)');
    // The worst-window callout names the bottleneck by its canvas label.
    expect(section.rows.find((r) => r.label === 'Worst window')?.value).toContain('Order service');
  });

  it('a FLAT design produces no two-tier result (no-filler — the block never renders)', () => {
    const g = buildStudio().graph();
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(twoTierEvaluation({ graph: g.value, evaluate: evalDI, maxEvents: 200_000 })).toBeUndefined();
  });
});
