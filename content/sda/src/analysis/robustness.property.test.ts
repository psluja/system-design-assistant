import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { NodeId, type Key } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { instantiate, keys, registry, allCatalogs, type Instance, type Manifest, type Wire } from '../index';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// TIER 4 — ROBUSTNESS / FUZZ. The credibility claim of a "verified, not a diagram" tool is not just that
// it is RIGHT on good designs, but that it is HONEST on bad ones: the engine must NEVER crash and NEVER
// hand back a silent NaN. For ANY input — including adversarial ones a confused architect can draw on a
// canvas (cycles, self-loops, orphan nodes, zero/negative/astronomically-huge knobs) — it must return a
// clean Result: either ok with finite/±Infinity/undefined values, or an honest error / did-not-converge.
//
// The generator below DELIBERATELY DEVIATES from the valid generator in `arbitrary.ts`: it wires later
// nodes back to earlier ones (CYCLES) and to themselves (SELF-LOOPS), leaves receivers with NO inbound
// edge (DISCONNECTED), repeats wires (DUPLICATE-ish parallel edges), reuses the same type for several
// nodes, and floods configs with pathological numbers (0, negatives, 1e12, 1e308, MAX_VALUE) chosen to
// drive relations toward 0/0, ∞−∞ and ∞/∞ — the only ways a finite arithmetic can manufacture a NaN.
// It still uses REAL component types and REAL port names with unique node ids, so most designs build and
// the laws actually exercise the solver, not just the validator's reject path.
//
// Each `it` states one law in plain English. NaN is the cardinal sin (a guess masquerading as a number);
// ±Infinity is a legal aggregation IDENTITY ("no inbound constraint"), not garbage. Seeded for replay.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

const SEED = 20260629;

/** Every shipped manifest, merged into one catalog — the widest possible vocabulary to fuzz over. */
const ALL: Record<string, Manifest> = {};
for (const catalog of allCatalogs) for (const [type, manifest] of Object.entries(catalog)) ALL[type] = manifest;
const ALL_TYPES: readonly string[] = Object.keys(ALL);

/** Real port names of a type in a direction (`bi` counts both ways) — keeps generated wires structural. */
const portsOf = (type: string, dir: 'in' | 'out'): string[] =>
  (ALL[type]?.ports ?? []).filter((p) => p.dir === dir || p.dir === 'bi').map((p) => p.name);

/** Every registry key — we probe NaN at EVERY (node, key), not just the headline outcomes. */
const ALL_KEYS: readonly Key[] = Object.values(keys);

// Config knobs an adversary can poison. We override them with REAL keys so they actually feed relations
// (Little's law, sizing, overflow, queue backlog); a key a manifest doesn't declare is simply ignored.
const CONFIG_KEYS: readonly string[] = [
  keys.throughput, keys.concurrency, keys.perRequestDuration, keys.latency, keys.cost,
  keys.replicas, keys.maxUnits, keys.drainRate, keys.retention, keys.maxBacklog,
  keys.availability, keys.durability, keys.arrivalRate, keys.queueMode,
].map(String);

// Pathological numeric values. We never pass a literal NaN (the type forbids it, and the prompt's rule is
// "NaN-ish via huge"): instead we supply 0 and tiny/huge magnitudes so the relations themselves can brew a
// NaN (e.g. perRequestDuration=0 ⇒ concurrency/0 ⇒ ∞; then ∞/∞ in requiredUnits ⇒ NaN). 1e308·1e308 ⇒ ∞.
const EXTREME_VALUES: readonly number[] = [0, -1, -1e9, 1, 1e-12, 1e6, 1e12, 1e308, Number.MAX_VALUE];

interface Adversarial {
  readonly instances: Instance[];
  readonly wires: Wire[];
}

// A node: a (mod-indexed) real type plus 0–4 poisoned config overrides. Mod-indexing at assembly means
// every raw fast-check value maps to a legal choice, so shrinking stays clean (no discarded runs).
const arbNode = fc.record({
  type: fc.nat(),
  cfg: fc.array(fc.record({ k: fc.nat(), v: fc.nat() }), { maxLength: 4 }),
});

// An edge with NO ordering constraint: `from`/`to` are any node index (mod N), so from > to ⇒ a back-edge
// (cycle), from === to ⇒ a self-loop, and any node never named as a `to` is left DISCONNECTED. Repeats are
// allowed (duplicate-ish parallel edges). Ports are mod-indexed into the real out/in port lists.
const arbEdge = fc.record({
  from: fc.nat(),
  to: fc.nat(),
  fromPort: fc.nat(),
  toPort: fc.nat(),
  async: fc.boolean(),
});

/** An ADVERSARIAL design over the real catalog: 2–8 real-typed nodes, up to 12 chaotic real-port edges. */
const arbAdversarial: fc.Arbitrary<Adversarial> = fc
  .tuple(fc.array(arbNode, { minLength: 2, maxLength: 8 }), fc.array(arbEdge, { maxLength: 12 }))
  .map(([nodes, edges]): Adversarial => {
    const n = nodes.length;
    const instances: Instance[] = nodes.map((node, i) => {
      const type = ALL_TYPES[node.type % ALL_TYPES.length]!;
      const config: Record<string, number> = {};
      for (const pick of node.cfg) config[CONFIG_KEYS[pick.k % CONFIG_KEYS.length]!] = EXTREME_VALUES[pick.v % EXTREME_VALUES.length]!;
      // Unique ids (n0..n{N-1}) ⇒ no duplicate-node error; the adversity lives in topology + configs.
      return Object.keys(config).length > 0 ? { id: `n${i}`, type, config } : { id: `n${i}`, type };
    });

    const wires: Wire[] = [];
    for (const e of edges) {
      const fromIdx = e.from % n;
      const toIdx = e.to % n; // may equal fromIdx (self-loop) or be < fromIdx (back-edge ⇒ cycle)
      const outs = portsOf(instances[fromIdx]!.type, 'out');
      const ins = portsOf(instances[toIdx]!.type, 'in');
      if (outs.length === 0 || ins.length === 0) continue; // no real port to attach ⇒ leave the target disconnected
      wires.push({
        from: [`n${fromIdx}`, outs[e.fromPort % outs.length]!],
        to: [`n${toIdx}`, ins[e.toPort % ins.length]!],
        ...(e.async ? { semantics: 'async' as const } : {}),
      });
    }
    return { instances, wires };
  });

describe('engine robustness (property-based fuzz over adversarial designs)', () => {
  it('LAW 1 — instantiate NEVER throws on any adversarial design; it always returns a Result', () => {
    fc.assert(
      fc.property(arbAdversarial, (d) => {
        let built;
        try {
          built = instantiate(ALL, d.instances, d.wires);
        } catch {
          return false; // a thrown exception (not an `{ ok: false }`) is a hard law violation
        }
        return typeof built.ok === 'boolean'; // a real, discriminable Result came back
      }),
      { seed: SEED, numRuns: 600 },
    );
  });

  it('LAW 2 — when the graph builds, evaluate NEVER throws and always returns a Result', () => {
    fc.assert(
      fc.property(arbAdversarial, (d) => {
        const g = instantiate(ALL, d.instances, d.wires);
        if (!g.ok) return true; // a structural reject IS a valid Result — nothing to evaluate
        let r;
        try {
          r = evaluate(g.value, registry);
        } catch {
          return false; // the engine must absorb cycles/extremes as a Result, never an exception
        }
        return typeof r.ok === 'boolean';
      }),
      { seed: SEED, numRuns: 600 },
    );
  });

  it('LAW 3 — no NaN ever leaks as a CONVERGED value; a NaN is tolerated ONLY as an honest did-not-converge', () => {
    fc.assert(
      fc.property(arbAdversarial, (d) => {
        const g = instantiate(ALL, d.instances, d.wires);
        if (!g.ok) return true;
        const r = evaluate(g.value, registry);
        if (!r.ok) return true; // an honest build error is acceptable
        const e = r.value;
        for (const inst of d.instances) {
          const id = NodeId(inst.id);
          for (const key of ALL_KEYS) {
            const v = e.value(id, key);
            if (v === undefined) continue; // absent is fine
            // ±Infinity is a legitimate identity (e.g. "no inbound constraint"). NaN is the only forbidden
            // value — and even then only when the engine claims it CONVERGED. If the system can't settle it
            // must say so (converged === false), never present garbage as a settled answer.
            if (Number.isNaN(v) && e.converged) return false;
          }
        }
        return true;
      }),
      { seed: SEED, numRuns: 600 },
    );
  });
});

// Receiver types that carry the universal overflow relation (i.e. they receive work AND declare a
// capacity). Each, placed ALONE with default config and NO inbound edge, exercises the empty-inflow path.
const OVERFLOW_RECEIVERS: readonly string[] = ALL_TYPES.filter((t) => {
  const m = ALL[t]!;
  const receives = m.ports.some((p) => p.dir === 'in' || p.dir === 'bi');
  const hasOverflow = (m.relations ?? []).some((r) => r.key === keys.overflow);
  return receives && hasOverflow;
});

describe('engine robustness — the disconnected-receiver edge case', () => {
  // LAW 4. A receiver with NO inflow is the canonical orphan. Its OFFERED LOAD is the fan-in of an empty
  // inbound set — and since offered loads aggregate as `sum` (fanIn), that is 0, not +Infinity. So the node
  // is offered ZERO traffic: it must not crash, must converge, and must report overflow = max(0, 0 −
  // capacity) = 0 (it rejects nothing), with no value anywhere collapsing to NaN. (Before the fan-in fix this
  // wrongly produced +Infinity from the `min`-identity.)
  it('a purely disconnected receiver converges with ZERO offered load ⇒ zero overflow (never NaN)', () => {
    expect(OVERFLOW_RECEIVERS.length).toBeGreaterThan(0);
    for (const type of OVERFLOW_RECEIVERS) {
      const g = instantiate(ALL, [{ id: 'lonely', type }], []);
      expect(g.ok, `${type}: a lone default node must build`).toBe(true);
      if (!g.ok) continue;

      const r = evaluate(g.value, registry);
      expect(r.ok, `${type}: a lone default node must evaluate`).toBe(true);
      if (!r.ok) continue;

      const e = r.value;
      expect(e.converged, `${type}: a lone default node must settle (no NaN)`).toBe(true);

      const id = NodeId('lonely');
      // Offered load = sum of an empty fan-in = 0 ⇒ overflow = max(0, 0 − capacity) = 0.
      expect(e.value(id, keys.overflow), `${type}: empty inflow ⇒ 0 offered ⇒ 0 overflow`).toBe(0);

      // And nothing — across the whole registry — is NaN.
      for (const key of ALL_KEYS) {
        const v = e.value(id, key);
        expect(Number.isNaN(v ?? 0), `${type}.${String(key)} must never be NaN`).toBe(false);
      }
    }
  });
});
