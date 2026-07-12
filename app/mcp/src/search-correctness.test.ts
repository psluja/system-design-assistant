import { describe, expect, it } from 'vitest';
import { NodeId, type Graph } from '@sda/engine-core';
import { createEngine, type Change } from '@sda/engine-solve';
import {
  instantiate,
  commonManifests,
  registry,
  keys,
  provisioningTunables,
  type Instance,
  type ManifestBand,
  type Wire,
} from '@sda/content';
import { nativeSolveMzn } from './mzn-native';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// TIER 2 — BACKWARD-SEARCH CORRECTNESS (the exact MIP path, native MiniZinc/COIN-BC).
//
// "Run the design backwards" is only credible if the answer it returns is TRUE, not merely plausible. A
// FAANG-grade tool that synthesizes provisioning must prove three things about its optimizer, and this
// suite proves each against the REAL forward engine (a differential check — the optimizer is judged by
// the same evaluate() a user sees), not against a re-statement of its own model:
//
//   1. FEASIBILITY  — what repair RETURNS actually WORKS. Apply the changes, re-instantiate, re-evaluate:
//                     the design that had a hard SLO violation now has NONE. The search achieves legality,
//                     it does not just claim to.
//   2. OPTIMALITY   — on a tiny one-knob design the continuous optimum equals the smallest feasible value
//                     a brute-force scan over the forward engine finds. The MIP is not just feasible, it is
//                     MINIMAL (no cheaper legal sizing exists).
// 3. NO-CHEATING — the invariants that keep a min-cost search honest:
//                     a SOURCE's offered load is a requirement, never a knob (the solver cannot "save money"
//                     by serving less traffic), and a throughput CAPACITY is raise-only (it cannot throttle
//                     an intermediate to fake a cheaper, starved design).
//
// These need the native MIP solver, so they are plain example tests (not fast-check): the integrator runs
// them with process.env.MINIZINC pointing at a MiniZinc install (the browser's WASM bundle has no MIP).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

const engine = createEngine(registry, { solveMzn: nativeSolveMzn });

/** Compile content → engine Graph, or fail loudly (the designs below are all structurally valid). */
function build(instances: readonly Instance[], wires: readonly Wire[]): Graph {
  const g = instantiate(commonManifests, instances, wires);
  if (!g.ok) throw new Error(`graph build failed: ${JSON.stringify(g.error)}`);
  return g.value;
}

/** The hard-violated SLOs of a design, as "node.key" strings — the forward engine's own honest verdict. */
function violations(graph: Graph): string[] {
  const r = engine.evaluate(graph);
  if (!r.ok) throw new Error(`evaluate failed: ${r.error.join('; ')}`);
  return r.value.verdicts.filter((v) => v.status === 'violation').map((v) => `${String(v.scope)}.${String(v.key)}`);
}

/** Fold a backward-search result back into the instances' config (what a user would apply on the canvas). */
function applyChanges(instances: readonly Instance[], changes: readonly Change[]): Instance[] {
  return instances.map((inst): Instance => {
    const mine = changes.filter((c) => String(c.node) === inst.id);
    if (mine.length === 0) return inst;
    const config: Record<string, number> = { ...inst.config };
    for (const c of mine) config[String(c.key)] = c.to;
    return { ...inst, config };
  });
}

const sloThroughputMin = (min: number): ManifestBand => ({ key: keys.throughput, band: { shape: 'minTargetMax', min } });

describe('backward-search correctness (native COIN-BC) — verified, not a diagram', () => {
  // 1. FEASIBILITY ──────────────────────────────────────────────────────────────────────────────────────
  // client(5000) → app → postgres, with a hard SLO: postgres must serve ≥ 5000 req/s. Postgres capacity is
  // Little's law = concurrency / 50ms = 100/0.05 = 2000 < 5000, so it BOTH overflows AND misses the floor.
  // repair must return a change set that, once applied, makes EVERY verdict legal — not just the one we named.
  it('FEASIBILITY — applying repair() yields a design the forward engine reports as legal (no violation)', async () => {
    const instances: Instance[] = [
      { id: 'client', type: 'client.web', config: { throughput: 5000 } },
      { id: 'app', type: 'compute.service' },
      { id: 'pg', type: 'db.postgres', bands: [sloThroughputMin(5000)] },
    ];
    const wires: Wire[] = [
      { from: ['client', 'out'], to: ['app', 'in'] },
      { from: ['app', 'db'], to: ['pg', 'in'] },
    ];

    const before = build(instances, wires);
    // The test is only meaningful if there is a real violation to fix.
    expect(violations(before)).toContain('pg.throughput');

    const r = await engine.repair(before, provisioningTunables(before));
    if (!r.ok) throw new Error(r.error.join('; '));
    expect(r.value.length).toBeGreaterThan(0);

    const fixed = build(applyChanges(instances, r.value), wires);
    expect(violations(fixed)).toEqual([]); // the search ACHIEVED legality
  });

  // 2. OPTIMALITY ───────────────────────────────────────────────────────────────────────────────────────
  // One integer knob: client(5000) → app(compute.service), capacity = concurrency / 20ms = concurrency·50.
  // Meeting "serve ≥ 5000 req/s" (and clearing overflow) needs concurrency ≥ 100. We brute-force the smallest
  // feasible integer concurrency over the REAL forward engine, then assert the MIP's continuous optimum equals
  // it — the optimizer is minimal, not merely feasible.
  it('OPTIMALITY — optimize() lands on the smallest feasible knob a brute-force forward scan finds', async () => {
    const wires: Wire[] = [{ from: ['client', 'out'], to: ['app', 'in'] }];
    const design = (concurrency: number): Instance[] => [
      { id: 'client', type: 'client.web', config: { throughput: 5000 } },
      { id: 'app', type: 'compute.service', config: { concurrency }, bands: [sloThroughputMin(5000)] },
    ];

    // Brute force: the smallest INTEGER concurrency for which the forward engine reports no violation.
    let smallestFeasible = -1;
    for (let c = 1; c <= 200; c++) {
      if (violations(build(design(c), wires)).length === 0) {
        smallestFeasible = c;
        break;
      }
    }
    expect(smallestFeasible).toBe(100); // 100·50 = 5000, exactly the floor; 99 overflows

    // The MIP, minimizing the concurrency knob subject to the same bands, must match (within rounding).
    const graph = build(design(500), wires); // start over-provisioned; optimize should shrink it
    const r = await engine.optimize(graph, provisioningTunables(graph), { node: NodeId('app'), key: keys.concurrency, direction: 'min' });
    if (!r.ok) throw new Error(r.error.join('; '));
    const knob = r.value.assignments.find((a) => String(a.node) === 'app' && String(a.key) === 'concurrency');
    expect(knob).toBeDefined();
    expect(knob!.value).toBeCloseTo(smallestFeasible, 4);
  });

  // 3a. NO-CHEATING (optimize) ──────────────────────────────────────────────────────────────────────────
  // A source's throughput is the OFFERED LOAD — a requirement, not a dial. If it were tunable, a min-cost
  // search would "win" by setting it to ~0 (serve no traffic). Assert it is never a tunable and that optimize
  // leaves it exactly where it was.
  it('NO-CHEATING — optimize() never makes a source node offered-load a knob, nor lowers it', async () => {
    const instances: Instance[] = [
      { id: 'client', type: 'client.web', config: { throughput: 5000 } },
      { id: 'fn', type: 'compute.serverless' },
    ];
    const wires: Wire[] = [{ from: ['client', 'out'], to: ['fn', 'in'] }];
    const graph = build(instances, wires);

    // The shared knob set must EXCLUDE the source's throughput (offered load is fixed).
    const tunables = provisioningTunables(graph);
    expect(tunables.some((t) => String(t.node) === 'client' && String(t.key) === 'throughput')).toBe(false);

    const r = await engine.optimize(graph, tunables, { node: NodeId('fn'), key: keys.cost, direction: 'min' });
    if (!r.ok) throw new Error(r.error.join('; '));
    // No assignment touches the client, and the source load reads back unchanged.
    expect(r.value.assignments.some((a) => String(a.node) === 'client')).toBe(false);
    expect(r.value.value(NodeId('client'), keys.throughput)).toBe(5000);
  });

  // 3b. NO-CHEATING (repair) ────────────────────────────────────────────────────────────────────────────
  // A throughput CAPACITY (here nginx, 50k req/s) is a raise-only dial: the search may upsize it to meet an
  // SLO but must never throttle it (which would starve downstream and fake a cheaper design). client offers
  // 60k > nginx's 50k → overflow. repair must RAISE nginx to 60k; its tunable floor is its current value, so
  // lowering is structurally impossible.
  it('NO-CHEATING — a throughput capacity is raise-only: repair() upsizes it and can never lower it', async () => {
    const instances: Instance[] = [
      { id: 'client', type: 'client.web', config: { throughput: 60000 } },
      { id: 'nginx', type: 'proxy.nginx' }, // default capacity 50000 req/s
    ];
    const wires: Wire[] = [{ from: ['client', 'out'], to: ['nginx', 'in'] }];
    const graph = build(instances, wires);
    expect(violations(graph)).toContain('nginx.overflow'); // 60k offered, 50k capacity ⇒ overload

    const tunables = provisioningTunables(graph);
    const cap = tunables.find((t) => String(t.node) === 'nginx' && String(t.key) === 'throughput');
    expect(cap).toBeDefined();
    expect(cap!.min).toBe(50000); // raise-only: the floor IS the current value (cannot be throttled)

    const r = await engine.repair(graph, tunables);
    if (!r.ok) throw new Error(r.error.join('; '));
    const change = r.value.find((c) => String(c.node) === 'nginx' && String(c.key) === 'throughput');
    expect(change).toBeDefined();
    expect(change!.from).toBe(50000);
    expect(change!.to).toBeCloseTo(60000, 2); // raised exactly to clear the overflow
    expect(change!.to).toBeGreaterThan(change!.from); // a RAISE, never a throttle
    // Sanity: every throughput change the search ever returns is non-decreasing.
    for (const c of r.value) if (String(c.key) === 'throughput') expect(c.to).toBeGreaterThanOrEqual(c.from);
  });

  // 3c. NO-CHEATING (universal traffic origin) ───────────────────────────────────────────────────────────
  // ANY node can ORIGINATE traffic (assumedRps) — a client-less DB-to-DB migration is a valid design. That
  // originated workload is a REQUIREMENT, exactly like a client's offered load: the min-cost search must never
  // lower it to "meet" an SLO/cost by migrating less traffic. Here a service originates 5000 req/s into a
  // Postgres that must serve ≥ 5000; repair must fix the DB (raise its capacity) and leave assumedRps untouched.
  it('NO-CHEATING — assumedRps is FROZEN: repair() fixes capacity but never lowers declared origin traffic', async () => {
    const instances: Instance[] = [
      { id: 'svc', type: 'compute.service', config: { assumedRps: 5000 } }, // a migration source — no client
      { id: 'pg', type: 'db.postgres', bands: [sloThroughputMin(5000)] }, // must serve the 5000 it is offered
    ];
    const wires: Wire[] = [{ from: ['svc', 'db'], to: ['pg', 'in'] }];
    const graph = build(instances, wires);
    expect(violations(graph)).toContain('pg.throughput'); // pg default capacity 2000 < 5000 ⇒ a real miss

    // assumedRps is NEVER a tunable — the solver cannot reduce the migration workload.
    const tunables = provisioningTunables(graph);
    expect(tunables.some((t) => String(t.key) === 'assumedRps')).toBe(false);

    const r = await engine.repair(graph, tunables);
    if (!r.ok) throw new Error(r.error.join('; '));
    // The search touches the DB's capacity, never the service's origin; and the migration still moves 5000.
    expect(r.value.some((c) => String(c.key) === 'assumedRps')).toBe(false);
    const fixed = build(applyChanges(instances, r.value), wires);
    expect(violations(fixed)).toEqual([]); // legality achieved by SIZING, not by throttling the origin
    const ev = engine.evaluate(fixed);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    expect(ev.value.value(NodeId('svc'), keys.assumedRps)).toBe(5000); // declared origin survives verbatim
  });
});
