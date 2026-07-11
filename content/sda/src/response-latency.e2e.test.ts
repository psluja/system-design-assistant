import { describe, expect, it } from 'vitest';
import { buildGraph, EdgeId, NodeId, PortId, Unit, type Edge, type Node, type Port } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { instantiate, allManifests, registry, keys, nodeQueues, responseLatency, latencyBreakdown, type Instance, type Wire, type NodeQueue, type LatencyParts } from './index';

// responseLatency (doc-15): a node's REAL request→response latency = its own sojourn + the composition of its
// SYNCHRONOUS downstream responses (sequential=sum / parallel=max / fastest=min, per the node's knob). We drive
// it with a STUBBED per-node sojourn map so the composition / direction / async-cut / ∞ logic is exact and
// independent of the queueing arithmetic (queueing.e2e covers that), then one real-design smoke on live queues.
describe('responseLatency — composition, direction, async-cut, ∞', () => {
  const P = (n: string, d: 'in' | 'out'): PortId => PortId(`${n}.${d}`);
  const compCell = (v: number) => ({ kind: 'input', key: keys.latencyComposition, value: { kind: 'fixed', quantity: { value: v, unit: Unit('1') } } }) as const;

  const respOf = (sojourn: Record<string, number>, wires: readonly (readonly [string, string])[], composition: Record<string, number> = {}, asyncW: ReadonlySet<string> = new Set()) => {
    const names = Object.keys(sojourn);
    const nodes: Node[] = names.map((nm) => ({ id: NodeId(nm), ports: [P(nm, 'in'), P(nm, 'out')], cells: composition[nm] !== undefined ? [compCell(composition[nm] as number)] : [] }));
    const ports: Port[] = names.flatMap((nm) => [
      { id: P(nm, 'in'), node: NodeId(nm), dir: 'in' as const },
      { id: P(nm, 'out'), node: NodeId(nm), dir: 'out' as const },
    ]);
    const edges: Edge[] = wires.map(([a, b], i) => ({ id: EdgeId(`e${i}`), from: P(a, 'out'), to: P(b, 'in'), semantics: asyncW.has(`${a}->${b}`) ? ('async' as const) : ('sync' as const) }));
    const g = buildGraph({ nodes, ports, edges });
    if (!g.ok) throw new Error('graph: ' + g.error.join('; '));
    const queues = new Map<string, NodeQueue>();
    for (const [id, s] of Object.entries(sojourn)) queues.set(id, { rho: 0.5, serviceMs: s, sojournMs: s, servers: 1, offered: 0, capacity: 0 });
    const r = responseLatency(g.value, () => undefined, queues);
    return (nm: string): number | undefined => r.get(nm);
  };

  it('a leaf = its own sojourn; a chain sums downstream (the caller waits for the whole chain)', () => {
    const r = respOf({ A: 10, B: 20, C: 40 }, [['A', 'B'], ['B', 'C']]);
    expect(r('C')).toBe(40); // leaf
    expect(r('B')).toBe(60); // 20 + 40
    expect(r('A')).toBe(70); // 10 + 20 + 40
  });

  it('a fan-out node differs by composition: sequential vs parallel vs fastest', () => {
    expect(respOf({ A: 10, B: 20, C: 40 }, [['A', 'B'], ['A', 'C']], { A: 0 })('A')).toBe(10 + (20 + 40)); // sequential = sum ⇒ 70
    expect(respOf({ A: 10, B: 20, C: 40 }, [['A', 'B'], ['A', 'C']], { A: 1 })('A')).toBe(10 + Math.max(20, 40)); // parallel = max ⇒ 50
    expect(respOf({ A: 10, B: 20, C: 40 }, [['A', 'B'], ['A', 'C']], { A: 2 })('A')).toBe(10 + Math.min(20, 40)); // fastest = min ⇒ 30
  });

  it('an async downstream is excluded (the caller does not wait on a decoupled hop)', () => {
    const r = respOf({ A: 10, B: 20, C: 40 }, [['A', 'B'], ['A', 'C']], {}, new Set(['A->B']));
    expect(r('A')).toBe(10 + 40); // B (async) is cut
  });

  it('a saturated (∞) sync dependency propagates ∞ up every caller', () => {
    const r = respOf({ A: 10, B: 20, C: Infinity }, [['A', 'B'], ['B', 'C']]);
    expect(r('C')).toBe(Infinity);
    expect(r('A')).toBe(Infinity);
  });
});

// REGRESSION (night-test find): `latencyComposition` set as INSTANCE config must survive instantiate() even
// though no manifest declares it — instantiate used to materialise only manifest-declared config keys, silently
// dropping the knob, which made the inspector select and MCP set_config a NO-OP (the tool reported success but
// nothing changed). The knob must actually flip the composition on a real, instantiated design.
describe('latencyComposition via instance config (through instantiate) actually changes the composition', () => {
  const design = (composition?: number) => {
    const instances: Instance[] = [
      { id: 'client', type: 'client.web', config: { throughput: 500 } },
      { id: 'app', type: 'compute.service', config: { concurrency: 500, perRequestDuration: 10, ...(composition !== undefined ? { latencyComposition: composition } : {}) } },
      { id: 'pg', type: 'db.postgres', config: { concurrency: 100, perRequestDuration: 20 } },
      { id: 'red', type: 'cache.redis' }, // ~0.5 ms
    ];
    const wires: Wire[] = [
      { from: ['client', 'out'], to: ['app', 'in'] },
      { from: ['app', 'db'], to: ['pg', 'in'] },
      { from: ['app', 'cache'], to: ['red', 'in'] },
    ];
    const g = instantiate(allManifests, instances, wires);
    if (!g.ok) throw new Error('build: ' + JSON.stringify(g.error));
    const r = evaluate(g.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    const value = (id: string, k: typeof keys.latency) => r.value.value(NodeId(id), k);
    return responseLatency(g.value, value);
  };
  it('sequential (default) sums both branches; parallel takes the slower; their difference = the faster branch', () => {
    const seq = design(); // default 0 = sum
    const par = design(1); // parallel = max
    const seqApp = seq.get('app') as number;
    const parApp = par.get('app') as number;
    expect(parApp).toBeLessThan(seqApp); // the knob DID change the number (the old bug made these equal)
    const fasterBranch = Math.min(par.get('pg') as number, par.get('red') as number);
    expect(seqApp - parApp).toBeCloseTo(fasterBranch, 4); // sum − max = min for two branches
  });
});

// Real design on live queues: response latency must COMPOSE up a sync chain (each tier's response includes its
// downstream) and a leaf store's response must equal its own sojourn.
describe('responseLatency on a real design (live queueing)', () => {
  it('composes up client → gateway → service → db; the db leaf = its own sojourn', () => {
    const instances: Instance[] = [
      { id: 'client', type: 'client.web', config: { throughput: 1000 } }, // ρ=0.5 at pg — unsaturated, so responses stay finite
      { id: 'gw', type: 'gateway.api' },
      { id: 'app', type: 'compute.service', config: { concurrency: 500, perRequestDuration: 20 } },
      { id: 'pg', type: 'db.postgres' },
    ];
    const wires: Wire[] = [
      { from: ['client', 'out'], to: ['gw', 'in'] },
      { from: ['gw', 'out'], to: ['app', 'in'] },
      { from: ['app', 'db'], to: ['pg', 'in'] },
    ];
    const g = instantiate(allManifests, instances, wires);
    if (!g.ok) throw new Error('build: ' + JSON.stringify(g.error));
    const r = evaluate(g.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    const value = (id: string, k: typeof keys.latency) => r.value.value(NodeId(id), k);
    const queues = nodeQueues(g.value, value);
    const resp = responseLatency(g.value, value, queues);

    // a leaf store's response = its own sojourn (nothing downstream to wait for)
    expect(resp.get('pg')).toBeCloseTo(queues.get('pg')?.sojournMs ?? -1, 6);
    // each tier's response strictly includes everything it synchronously calls
    expect(resp.get('app') as number).toBeGreaterThan(resp.get('pg') as number);
    expect(resp.get('gw') as number).toBeGreaterThan(resp.get('app') as number);
    expect(resp.get('client') as number).toBeGreaterThanOrEqual(resp.get('gw') as number);
  });
});

// latencyBreakdown (doc-15): splits a node's response into base (declared service) + queue (its OWN congestion —
// the cascade culprit) + downstream (inherited from sync calls). The contract is base + queue + downstream =
// response, with the two ∞ cases distinguished. Driven with a stubbed {service, sojourn} per node (service <
// sojourn ⇒ a real queue segment) so the decomposition is exact, plus one live-queueing smoke for the default path.
describe('latencyBreakdown — base + queue + downstream = response (and the two ∞ cases)', () => {
  const P = (n: string, d: 'in' | 'out'): PortId => PortId(`${n}.${d}`);
  const breakdown = (cfg: Record<string, { service: number; sojourn: number }>, wires: readonly (readonly [string, string])[]): Map<string, LatencyParts> => {
    const names = Object.keys(cfg);
    const nodes: Node[] = names.map((nm) => ({ id: NodeId(nm), ports: [P(nm, 'in'), P(nm, 'out')], cells: [] }));
    const ports: Port[] = names.flatMap((nm) => [
      { id: P(nm, 'in'), node: NodeId(nm), dir: 'in' as const },
      { id: P(nm, 'out'), node: NodeId(nm), dir: 'out' as const },
    ]);
    const edges: Edge[] = wires.map(([a, b], i) => ({ id: EdgeId(`e${i}`), from: P(a, 'out'), to: P(b, 'in'), semantics: 'sync' as const }));
    const g = buildGraph({ nodes, ports, edges });
    if (!g.ok) throw new Error('graph: ' + g.error.join('; '));
    const queues = new Map<string, NodeQueue>();
    for (const [id, c] of Object.entries(cfg)) queues.set(id, { rho: 0.5, serviceMs: c.service, sojournMs: c.sojourn, servers: 1, offered: 0, capacity: 0 });
    return latencyBreakdown(g.value, () => undefined, queues);
  };

  it('splits base (service) + queue (own congestion) + downstream (inherited), summing to response on every node', () => {
    // A → B → C. B queues (service 20, sojourn 50 ⇒ +30). responseLatency: C=40, B=90, A=100.
    const b = breakdown({ A: { service: 10, sojourn: 10 }, B: { service: 20, sojourn: 50 }, C: { service: 40, sojourn: 40 } }, [['A', 'B'], ['B', 'C']]);
    for (const p of b.values()) expect(p.base + p.queue + p.downstream).toBe(p.response); // the contract, every node
    expect(b.get('C')).toEqual({ base: 40, queue: 0, downstream: 0, response: 40 }); // leaf: entirely its own service
    expect(b.get('B')).toEqual({ base: 20, queue: 30, downstream: 40, response: 90 }); // +30 own congestion, +40 inherited
    expect(b.get('A')).toEqual({ base: 10, queue: 0, downstream: 90, response: 100 }); // fast itself; the 90 is all inherited
  });

  it('∞ case A — a saturated tier: queue = ∞, downstream = 0 (the ∞ is its OWN fault)', () => {
    const b = breakdown({ A: { service: 10, sojourn: 10 }, C: { service: 40, sojourn: Infinity } }, [['A', 'C']]);
    expect(b.get('C')).toEqual({ base: 40, queue: Infinity, downstream: 0, response: Infinity });
  });

  it('∞ case B — waiting on a saturated dependency: queue finite, downstream = ∞ (the ∞ is INHERITED)', () => {
    const p = breakdown({ B: { service: 20, sojourn: 50 }, C: { service: 40, sojourn: Infinity } }, [['B', 'C']]).get('B') as LatencyParts;
    expect(p).toEqual({ base: 20, queue: 30, downstream: Infinity, response: Infinity });
  });

  it('computes its own queues when none are passed (live-queueing default path; sum invariant holds)', () => {
    const instances: Instance[] = [
      { id: 'client', type: 'client.web', config: { throughput: 1000 } },
      { id: 'gw', type: 'gateway.api' },
      { id: 'app', type: 'compute.service', config: { concurrency: 500, perRequestDuration: 20 } },
      { id: 'pg', type: 'db.postgres' },
    ];
    const wires: Wire[] = [
      { from: ['client', 'out'], to: ['gw', 'in'] },
      { from: ['gw', 'out'], to: ['app', 'in'] },
      { from: ['app', 'db'], to: ['pg', 'in'] },
    ];
    const g = instantiate(allManifests, instances, wires);
    if (!g.ok) throw new Error('build: ' + JSON.stringify(g.error));
    const r = evaluate(g.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    const b = latencyBreakdown(g.value, (id, k) => r.value.value(NodeId(id), k)); // no queues arg ⇒ internal nodeQueues path
    expect(b.size).toBe(4);
    for (const p of b.values()) expect(p.base + p.queue + p.downstream).toBeCloseTo(p.response, 6);
  });
});
