import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { NodeId, type Cycle, type Key } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import {
  allManifests,
  applyScenarioToGraph,
  derivedMean,
  derivedPeak,
  instantiate,
  keys,
  LOAD_STAGES_PRESETS,
  originNodes,
  provisioningTunables,
  registry,
  toQueueingNetwork,
  type Instance,
  type Wire,
} from './index';

// GENERATE AT PORTS — content lowering (doc: load-stages §4, R1). `generate(level, cycles?)` is the primitive
// traffic-origin declaration; a node-level `assumedRps` is sugar for one. These tests pin the R1 contract:
//  (1) THE MIGRATED-DECLARATION IDENTITY (property-pinned, sacred): a design declaring `assumedRps: V` on a
//      source evaluates KEY-FOR-KEY identically to the same design declaring generate(V) on the primary out
//      port — the generator physics is a superset of the withOrigin physics, so the deserialize migration can
//      never change a number.
//  (2) The reconciled level cell: worlds/MC/envelope keep addressing `node|assumedRps` (scenario-overridable,
//      MC-rangeable, sweep/envelope-scalable) — the level is a fact-assumption through the same one address.
//  (3) Relay + generate (the mixed case the port family newly allows): served = min(capacity, inflow + level),
//      overflow = max(0, inflow + level − capacity) — the universal form, at a MID-CHAIN node.
//  (4) The DES projection: the generator's level rides the node's arrival source (the DES rate is the derived
//      MEAN, the baseline-anchored SHAPE riding as a profile); a FLAT/absent cycle threads NOTHING (byte-identity).
//  (5) SEARCH HONESTY: the generated workload is frozen — no tunable can throttle it (no-cheating extended).

// A daily cycle with a clear evening peak (×2.6): the baseline-anchored k6 shape (starts at ×1, ramps down, up).
const EVENING_PEAK: Cycle[] = [{ periodS: 86_400, stages: [{ durationS: 28_800, multiplier: 0.5 }, { durationS: 28_800, multiplier: 2.6 }] }];
// A cycle whose every multiplier is ×1 — a flat generator, byte-identical to no cycles (the silent default).
const FLAT_CYCLE: Cycle[] = [{ periodS: 86_400, stages: [{ durationS: 43_200, multiplier: 1 }] }];

/** The client-less migration design of origin.e2e.test.ts, with the origin declared either way. */
function migrationDesign(origin: { readonly sugar: number } | { readonly generate: number; readonly cycles?: Cycle[] }): {
  instances: Instance[];
  wires: Wire[];
} {
  const svc: Instance =
    'sugar' in origin
      ? { id: 'svc', type: 'compute.service', config: { assumedRps: origin.sugar } }
      : { id: 'svc', type: 'compute.service', transforms: { out: { kind: 'generate', level: origin.generate, ...(origin.cycles !== undefined ? { cycles: origin.cycles } : {}) } } };
  return {
    instances: [
      svc,
      { id: 'pg', type: 'db.postgres', bands: [{ key: keys.throughput, band: { shape: 'minTargetMax', target: 500 } }] },
      { id: 'aurora', type: 'db.aurora', bands: [{ key: keys.throughput, band: { shape: 'minTargetMax', target: 500 } }] },
    ],
    wires: [
      { from: ['svc', 'db'], to: ['pg', 'in'] },
      { from: ['svc', 'out'], to: ['aurora', 'in'] },
    ],
  };
}

/** Every (node, key) value of a design, for exact cross-form comparison. */
function allValues(instances: Instance[], wires: Wire[]): ReadonlyMap<string, number | undefined> {
  const g = instantiate(allManifests, instances, wires);
  if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
  const r = evaluate(g.value, registry);
  if (!r.ok) throw new Error(r.error.join('; '));
  const out = new Map<string, number | undefined>();
  for (const inst of instances) {
    for (const key of Object.values(keys)) out.set(`${inst.id}|${String(key)}`, r.value.value(NodeId(inst.id), key as Key));
  }
  return out;
}

describe('generate(level) ≡ assumedRps sugar — the migrated-declaration identity (sacred, property-pinned)', () => {
  it('every (node, key) value is IDENTICAL between the two declaration forms, across levels', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20000 }), (level) => {
        const sugar = migrationDesign({ sugar: level });
        const generated = migrationDesign({ generate: level });
        expect(allValues(generated.instances, generated.wires)).toStrictEqual(allValues(sugar.instances, sugar.wires));
      }),
      { numRuns: 25 },
    );
  });

  it('CYCLES change nothing scalar (the shape is pure — the scalar pass never reads a cycle; level = the baseline)', () => {
    const bare = migrationDesign({ generate: 500 });
    const flat = migrationDesign({ generate: 500, cycles: FLAT_CYCLE });
    const peaky = migrationDesign({ generate: 500, cycles: EVENING_PEAK });
    expect(allValues(flat.instances, flat.wires)).toStrictEqual(allValues(bare.instances, bare.wires));
    // The scalar pass never reads the cycles (load-stages §7): the peaky day evaluates the same BASELINE numbers.
    expect(allValues(peaky.instances, peaky.wires)).toStrictEqual(allValues(bare.instances, bare.wires));
  });
});

describe('the reconciled level cell — one address for worlds / MC / sweep (doc: load-stages §6)', () => {
  const d = migrationDesign({ generate: 500, cycles: EVENING_PEAK });
  const built = instantiate(allManifests, d.instances, d.wires);
  if (!built.ok) throw new Error(JSON.stringify(built.error));
  const graph = built.value;

  it('the generator level materialises as the node|assumedRps input cell (the generators\' total)', () => {
    const svc = graph.nodes.get(NodeId('svc'));
    const cell = svc?.cells.find((c) => c.kind === 'input' && String(c.key) === String(keys.assumedRps));
    expect(cell && cell.kind === 'input' && cell.value.kind === 'fixed' ? cell.value.quantity.value : undefined).toBe(500);
  });

  it('a scenario override on node|assumedRps MOVES the generator physics (scenario-overridable level)', () => {
    const overridden = applyScenarioToGraph(graph, { id: 'peak-world', overrides: [{ node: 'svc', key: String(keys.assumedRps), value: 900 }] });
    const r = evaluate(overridden, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    expect(r.value.value(NodeId('svc'), keys.throughput)).toBe(900); // the level rode the cell, not a frozen literal
    expect(r.value.value(NodeId('pg'), keys.throughput)).toBe(900);
  });

  it('the sweep/envelope origin detection sees a generator node as a traffic origin on assumedRps', () => {
    const origins = originNodes(d.instances, allManifests);
    expect(origins).toEqual([{ id: 'svc', key: keys.assumedRps, baseValue: 500 }]);
  });
});

describe('relay + generate — the mixed case the port family newly allows (doc: load-stages §4 superset law)', () => {
  // client → svc(generates 200 on its second port) → … : svc RELAYS 400 from upstream AND originates 200.
  const instances: Instance[] = [
    { id: 'client', type: 'client.source', config: { throughput: 400 } },
    { id: 'svc', type: 'compute.service', transforms: { out: { kind: 'generate', level: 200 } } },
    { id: 'aurora', type: 'db.aurora' },
  ];
  const wires: Wire[] = [
    { from: ['client', 'out'], to: ['svc', 'in'] },
    { from: ['svc', 'out'], to: ['aurora', 'in'] },
  ];
  const built = instantiate(allManifests, instances, wires);
  if (!built.ok) throw new Error(JSON.stringify(built.error));
  const graph = built.value;

  it('served = min(capacity, inflow + level): the origin finally rides OUT of a relay', () => {
    const r = evaluate(graph, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    // compute.service capacity is ample here, so svc emits relayed 400 + generated 200 = 600 downstream.
    expect(r.value.value(NodeId('svc'), keys.throughput)).toBe(600);
    expect(r.value.value(NodeId('aurora'), keys.throughput)).toBe(600);
    // The universal overflow keeps its one form: nothing over capacity here ⇒ 0.
    expect(r.value.value(NodeId('svc'), keys.overflow) ?? 0).toBeCloseTo(0, 9);
  });

  it('the DES injects the generated 200 req/s AT svc while the client still injects its 400', () => {
    const qn = toQueueingNetwork(graph);
    const rates = new Map(qn.arrivals.map((a) => [String(a.at), a.interarrival.kind === 'exponential' ? a.interarrival.rate : NaN]));
    expect(rates.get('client')).toBe(400);
    expect(rates.get('svc')).toBe(200);
  });
});

describe('the DES projection threads the cycles (doc: load-stages §9) — and stays silent for a flat generator', () => {
  it('a shaped generator yields an ArrivalSource whose rate is the derived MEAN and a baseline-anchored profile', () => {
    const d = migrationDesign({ generate: 500, cycles: EVENING_PEAK });
    const built = instantiate(allManifests, d.instances, d.wires);
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const qn = toQueueingNetwork(built.value);
    const svc = qn.arrivals.find((a) => String(a.at) === 'svc');
    expect(svc?.interarrival.kind).toBe('exponential');
    // THE ×m̄ BASELINE COMPENSATION (§9): the DES rate is the DERIVED MEAN (level × mean shape), not the level —
    // so effective λ(t) = level × shape(t) once the sampler divides by the profile's own mean.
    expect(svc?.interarrival.kind === 'exponential' ? svc.interarrival.rate : NaN).toBeCloseTo(derivedMean(500, EVENING_PEAK), 6);
    expect(svc?.rateProfile).toBeDefined();
    expect(svc?.rateProfile?.periodS).toBe(86_400);
    // The profile starts at the ×1 BASELINE (scaled by the level): points[0] = { t: 0, m: level × 1 }.
    expect(svc?.rateProfile?.points[0]).toEqual({ t: 0, m: 500 });
    expect(svc?.rateProfile?.points.length).toBe(3); // the ×1 start + the two stage vertices (Σ durationS < periodS)
  });

  it('a FLAT cycle (and no cycles) threads NO profile — the sacred byte-identity holds by construction', () => {
    for (const origin of [{ generate: 500 }, { generate: 500, cycles: FLAT_CYCLE }] as const) {
      const d = migrationDesign(origin);
      const built = instantiate(allManifests, d.instances, d.wires);
      if (!built.ok) throw new Error(JSON.stringify(built.error));
      const svc = toQueueingNetwork(built.value).arrivals.find((a) => String(a.at) === 'svc');
      expect(svc?.rateProfile).toBeUndefined();
      expect(svc?.interarrival.kind === 'exponential' ? svc.interarrival.rate : NaN).toBe(500); // rate = the level, exactly today
    }
  });
});

describe('a generator on a CLIENT beats the throughput-as-workload preset (the peak-at-source fix)', () => {
  // `client.web`'s `throughput: 5000` (common.ts) is a WORKLOAD PRESET, not a served capacity. A `generate`
  // transform on its out port is the AUTHORITATIVE originated rate — it must OVERRIDE the preset, or peaks above
  // 5000 are silently capped at the source (the owner's "nie czuję peaków" bug). `compute.service` here is the
  // downstream sink with ample capacity (500 / (20/1000) = 25 000 req/s) so the client's emission is what limits.
  const svcHi: Instance = { id: 'svc', type: 'compute.service' };

  function clientGen(level: number, cycles?: Cycle[]): { instances: Instance[]; wires: Wire[] } {
    return {
      instances: [
        { id: 'cli', type: 'client.web', transforms: { out: { kind: 'generate', level, ...(cycles !== undefined ? { cycles } : {}) } } },
        svcHi,
      ],
      wires: [{ from: ['cli', 'out'], to: ['svc', 'in'] }],
    };
  }

  it('generate(10000) on client.web ⇒ the client EMITS 10000 (NOT clamped at the 5000 preset); downstream sees 10000', () => {
    const d = clientGen(10000);
    const g = instantiate(allManifests, d.instances, d.wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const r = evaluate(g.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    expect(r.value.value(NodeId('cli'), keys.throughput)).toBe(10000); // the generator level, NOT the 5000 preset
    expect(r.value.value(NodeId('svc'), keys.throughput)).toBe(10000); // svc capacity 25 000 ≥ 10 000 ⇒ offered in full
  });

  it('a SPIKE peak ABOVE the preset is felt at the source (the assumedRps peak rides through unclamped)', () => {
    // The peak-aware sweep scales a generator origin on its `assumedRps` (originNodes) to the DERIVED PEAK. With
    // level 2000 and the shipped spike (×3), the peak is 6000 — ABOVE the 5000 preset. Simulate that peak world:
    // the client must EMIT 6000, or the peak is invisible at the source (the clamped-at-5000 symptom).
    const d = clientGen(2000, [...LOAD_STAGES_PRESETS.spike]);
    const g = instantiate(allManifests, d.instances, d.wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    expect(originNodes(d.instances, allManifests)).toEqual([{ id: 'cli', key: keys.assumedRps, baseValue: 2000 }]);
    const peak = derivedPeak(2000, [...LOAD_STAGES_PRESETS.spike]);
    expect(peak).toBe(6000); // 2000 × ×3 spike
    const atPeak = applyScenarioToGraph(g.value, { id: 'peak', overrides: [{ node: 'cli', key: String(keys.assumedRps), value: peak }] });
    const r = evaluate(atPeak, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    expect(r.value.value(NodeId('cli'), keys.throughput)).toBe(6000); // NOT clamped at 5000 — the peak reaches the source
    expect(r.value.value(NodeId('svc'), keys.throughput)).toBe(6000);
  });

  it('SACRED byte-identity: a client with NO generator emits its throughput preset UNCHANGED (no origin fold)', () => {
    // No generator, no assumedRps ⇒ foldOrigin is false: the throughput CONFIG flows exactly as today. Pin BOTH
    // the emitted value AND that the cell stays a raw INPUT preset (not rewritten into a derived origin relation).
    const bare: Instance[] = [{ id: 'cli', type: 'client.web' }, svcHi];
    const wires: Wire[] = [{ from: ['cli', 'out'], to: ['svc', 'in'] }];
    const g = instantiate(allManifests, bare, wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const r = evaluate(g.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    expect(r.value.value(NodeId('cli'), keys.throughput)).toBe(5000); // the default preset (common.ts), unchanged
    const thrCell = g.value.nodes.get(NodeId('cli'))?.cells.find((c) => String(c.key) === String(keys.throughput));
    expect(thrCell?.kind).toBe('input'); // still the raw preset input — no fold rewrote it into a relation
  });
});

describe('search honesty — the generated workload is FROZEN (no-cheating, extended to generators)', () => {
  it('no tunable targets the generator level or the generator node\'s derived throughput', () => {
    const d = migrationDesign({ generate: 500, cycles: EVENING_PEAK });
    const built = instantiate(allManifests, d.instances, d.wires);
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const tunables = provisioningTunables(built.value);
    expect(tunables.some((t) => String(t.key) === String(keys.assumedRps))).toBe(false);
    // The generator node's throughput is a DERIVED origin relation (min(capacity, …)), never a fixed input —
    // so the search cannot hand the solver a knob that would throttle the generated workload.
    expect(tunables.some((t) => String(t.node) === 'svc' && String(t.key) === String(keys.throughput))).toBe(false);
  });
});
