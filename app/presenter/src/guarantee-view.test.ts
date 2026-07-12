import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { NodeId, type Key } from '@sda/engine-core';
import {
  registry,
  allManifests,
  categorical,
  flowGuarantees,
  guaranteeVerdicts,
  type GuaranteeSlo,
} from '@sda/content';
import { flowGuaranteeLines, guaranteeStrip, guaranteeSummarySections, requirementOptions, tokenLabel, type GuaranteeViewInput } from './index';

// The GUARANTEE VIEW-MODEL tests, pinned on the ANTI-DRIFT invariant: every token,
// root cause and verdict the presenter emits MUST equal the engine's own `guaranteeVerdicts` / `flowGuarantees`
// over a FULL engine evaluation — the presenter formats, it never re-derives. We build a real design
// (client → svc → SQS standard → worker), declare an ordering requirement the fan-out queue violates, and assert
// the summary line, the canvas strip and the requirement options all agree with the engine, byte-for-byte on the
// load-bearing fields.

/** A real design: client → svc → SQS standard → worker, with a throughput origin so the flow is driven. The SQS
 *  standard out port declares ordering:none, so a checkout→worker "ordering ≥ per-key" requirement is VIOLATED at
 *  the queue — the canonical fan-out ordering story the strip must paint red from the queue onward. */
function build(): { input: GuaranteeViewInput; slo: GuaranteeSlo } {
  const s = new Studio(registry, allManifests);
  s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.source' });
  s.dispatch({ kind: 'setConfig', node: 'client', key: 'throughput', value: 200 });
  s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.service' });
  s.dispatch({ kind: 'addComponent', id: 'q', type: 'queue.sqs' });
  s.dispatch({ kind: 'addComponent', id: 'worker', type: 'compute.faas' });
  s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['svc', 'in'] });
  s.dispatch({ kind: 'connect', from: ['svc', 'out'], to: ['q', 'in'], semantics: 'async' });
  s.dispatch({ kind: 'connect', from: ['q', 'out'], to: ['worker', 'in'], semantics: 'async' });
  const slo: GuaranteeSlo = { source: 'client', terminal: 'worker', dimension: 'ordering', atLeast: 'per-key' };
  s.dispatch({ kind: 'setGuaranteeSlo', slo });

  const ev = s.evaluate();
  if (!ev.ok) throw new Error(`build failed: ${ev.error.join('; ')}`);
  const gr = s.graph();
  if (!gr.ok) throw new Error('graph build failed');
  const doc = s.project();
  const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
  const input: GuaranteeViewInput = {
    graph: gr.value,
    instances: doc.instances,
    wires: doc.wires,
    value,
    catalog: s.mergedCatalog(),
    slos: doc.guaranteeSlos,
  };
  return { input, slo };
}

describe('flowGuaranteeLines — the per-flow summary line, pinned to the engine', () => {
  const { input } = build();
  const lines = flowGuaranteeLines(input);

  it('emits a line for the client → worker flow with an ordering cell', () => {
    const line = lines.find((l) => l.source === 'client' && l.terminal === 'worker');
    expect(line).toBeDefined();
    const cell = line!.cells.find((c) => c.dimension === 'ordering');
    expect(cell).toBeDefined();
  });

  it('the ordering cell matches the engine verdict EXACTLY (anti-drift: token, root cause, status)', () => {
    // The engine's own answer for this requirement — the presenter must not diverge from it.
    const engine = guaranteeVerdicts(input.graph, input.catalog, input.instances, input.wires, input.value, input.slos)
      .find((v) => v.dimension === 'ordering' && v.source === 'client' && v.terminal === 'worker');
    expect(engine).toBeDefined();
    expect(engine!.status).toBe('violation');
    expect(engine!.computed).toBe('none');
    expect(engine!.rootCauseNode).toBe('q');

    const cell = flowGuaranteeLines(input).find((l) => l.terminal === 'worker')!.cells.find((c) => c.dimension === 'ordering')!;
    expect(cell.token).toBe(engine!.computed);
    expect(cell.rootCauseNode).toBe(engine!.rootCauseNode);
    expect(cell.required).toBe(engine!.required);
    expect(cell.status).toBe(engine!.status);
    expect(cell.tone).toBe('bad');
    // the legible line names the computed token AND the root-cause node in parentheses + a ✗ mark
    expect(cell.text).toContain('none');
    expect(cell.text).toContain('(q)');
    expect(cell.text).toContain('✗');
  });

  it('carries a cell for EVERY degraded dimension the engine flowGuarantees reports (no drift, no drop)', () => {
    const line = flowGuaranteeLines(input).find((l) => l.terminal === 'worker')!;
    const summary = flowGuarantees(input.graph, input.instances, input.wires, input.value).find((f) => f.terminal === 'worker');
    // Every dimension the engine degrades on this flow must appear as a cell (the presenter drops none).
    for (const d of summary?.dimensions ?? []) {
      expect(line.cells.some((c) => c.dimension === d.dimension), `dimension ${d.dimension} present`).toBe(true);
    }
  });
});

describe('guaranteeSummarySections — the System-panel feed both shells render', () => {
  const { input } = build();

  it('emits one "Guarantees · <flow>" section with a toned, root-cause-named row (the VS Code System tree line)', () => {
    const sections = guaranteeSummarySections(input);
    const gsec = sections.find((s) => s.title === 'Guarantees · client → worker');
    expect(gsec).toBeDefined();
    const ordering = gsec!.rows.find((r) => r.label === 'ordering');
    expect(ordering).toBeDefined();
    expect(ordering!.value).toContain('none'); // the computed token
    expect(ordering!.value).toContain('(q)'); // the root cause (the SQS queue node id) named in the line
    expect(ordering!.value).toContain('✗'); // the violation mark
    expect(ordering!.tone).toBe('bad');
    expect(ordering!.rootCauseNode).toBe('q'); // the clickable root cause the shell reveals
  });

  it('is empty when no requirement is declared and nothing degrades (no-filler)', () => {
    const s = new Studio(registry, allManifests);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.source' });
    s.dispatch({ kind: 'setConfig', node: 'client', key: 'throughput', value: 100 });
    s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.service' });
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['svc', 'in'] });
    const ev = s.evaluate();
    if (!ev.ok) throw new Error('build failed');
    const gr = s.graph();
    if (!gr.ok) throw new Error('graph failed');
    const doc = s.project();
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const empty: GuaranteeViewInput = { graph: gr.value, instances: doc.instances, wires: doc.wires, value, catalog: s.mergedCatalog(), slos: doc.guaranteeSlos };
    expect(guaranteeSummarySections(empty)).toEqual([]);
  });
});

describe('guaranteeStrip — the per-edge canvas strip, pinned to the engine', () => {
  const { input, slo } = build();
  const strip = guaranteeStrip(input, slo);

  it('produces a strip whose computed token + root cause equal the engine verdict', () => {
    expect(strip).not.toBeNull();
    const engine = guaranteeVerdicts(input.graph, input.catalog, input.instances, input.wires, input.value, [slo])[0]!;
    expect(strip!.computed).toBe(engine.computed); // 'none'
    expect(strip!.status).toBe(engine.status); // 'violation'
    expect(strip!.rootCauseNode).toBe(engine.rootCauseNode); // 'q'
  });

  it('paints teal BEFORE the degrading queue and red FROM it onward (the promise breaks at the hop)', () => {
    // wires: [client→svc (w0), svc→q (w1), q→worker (w2)]. Ordering stays per-key/top until the SQS out port drops
    // it to none. The out-port claim rides the q→worker edge (w2), so w0/w1 hold (teal) and w2 breaks (red).
    const byWire = new Map(strip!.segments.map((s) => [s.wire, s]));
    expect(byWire.get(0)?.tone).toBe('ok');
    expect(byWire.get(1)?.tone).toBe('ok');
    expect(byWire.get(2)?.tone).toBe('bad');
    // the red segment's hover names the transition to `none`
    expect(byWire.get(2)?.hover).toContain('none');
  });

  it('returns null for a requirement whose flow does not exist (nothing honest to paint)', () => {
    const ghost = guaranteeStrip(input, { source: 'ghost', terminal: 'worker', dimension: 'ordering', atLeast: 'per-key' });
    expect(ghost).toBeNull();
  });

  it('returns null for an unknown dimension (never a wrong strip)', () => {
    const bogus = guaranteeStrip(input, { source: 'client', terminal: 'worker', dimension: 'nonsense', atLeast: 'x' });
    expect(bogus).toBeNull();
  });
});

describe('guaranteeStrip — a SATISFIED requirement paints all teal (no false red)', () => {
  it('a consistency-strong requirement on a strong write path holds on every edge', () => {
    const s = new Studio(registry, allManifests);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.source' });
    s.dispatch({ kind: 'setConfig', node: 'client', key: 'throughput', value: 100 });
    s.dispatch({ kind: 'addComponent', id: 'db', type: 'db.sql' }); // writer = consistency:strong
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['db', 'in'] });
    const slo: GuaranteeSlo = { source: 'client', terminal: 'db', dimension: 'consistency', atLeast: 'strong' };
    s.dispatch({ kind: 'setGuaranteeSlo', slo });
    const ev = s.evaluate();
    if (!ev.ok) throw new Error('build failed');
    const gr = s.graph();
    if (!gr.ok) throw new Error('graph failed');
    const doc = s.project();
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const input: GuaranteeViewInput = { graph: gr.value, instances: doc.instances, wires: doc.wires, value, catalog: s.mergedCatalog(), slos: doc.guaranteeSlos };
    const strip = guaranteeStrip(input, slo)!;
    expect(strip.status).toBe('ok');
    expect(strip.rootCauseNode).toBeNull();
    for (const seg of strip.segments) expect(seg.tone).toBe('ok');
  });
});

describe('flowGuaranteeLines — no-filler (silent without a requirement or degradation)', () => {
  it('a design with NO requirement and NO degradation yields no lines', () => {
    const s = new Studio(registry, allManifests);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.source' });
    s.dispatch({ kind: 'setConfig', node: 'client', key: 'throughput', value: 100 });
    s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.service' }); // no guarantee claim anywhere
    s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['svc', 'in'] });
    const ev = s.evaluate();
    if (!ev.ok) throw new Error('build failed');
    const gr = s.graph();
    if (!gr.ok) throw new Error('graph failed');
    const doc = s.project();
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const input: GuaranteeViewInput = { graph: gr.value, instances: doc.instances, wires: doc.wires, value, catalog: s.mergedCatalog(), slos: doc.guaranteeSlos };
    expect(flowGuaranteeLines(input)).toEqual([]);
  });
});

describe('requirementOptions + tokenLabel — the outsider-legible editor vocabulary', () => {
  const options = requirementOptions();

  it('offers exactly the categorical dimensions the engine can judge', () => {
    expect(options.map((o) => o.dimension).sort()).toEqual([...categorical.dimensions].map(String).sort());
  });

  it('labels tokens with an outsider-legible gloss ("strong — reads always see the latest write")', () => {
    const consistency = options.find((o) => o.dimension === 'consistency')!;
    const strong = consistency.tokens.find((t) => t.token === 'strong')!;
    expect(strong.label).toBe('strong — reads always see the latest write');
    expect(tokenLabel('per-key')).toBe('per-key — messages keep their order within a key / partition');
  });

  it('never offers the declared-unknown token as a requirement floor', () => {
    const consistency = options.find((o) => o.dimension === 'consistency')!;
    // the lattice carries a weak-end 'consistency-unknown' sentinel — the picker must not list it
    expect(consistency.tokens.some((t) => t.token === 'consistency-unknown')).toBe(false);
    // but the real tokens ARE offered
    expect(consistency.tokens.map((t) => t.token)).toEqual(['strong', 'eventual']);
  });
});
