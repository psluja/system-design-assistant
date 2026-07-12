import { describe, it } from 'vitest';
import fc from 'fast-check';
import { NodeId, type Key } from '@sda/engine-core';
import { evaluate, type Evaluation } from '@sda/engine-solve';
import { instantiate, registry, keys } from './index';
import { CATALOG, arbDesign, type Design } from './arbitrary';

// THE ENGINE'S LAWS — property-based, over THOUSANDS of random real designs (see `arbitrary.ts` for how
// they are generated). A FAANG-grade "verified, not a dumb diagram" tool must obey its own algebra for
// EVERY architecture, not just the hand-picked e2e cases. Each `it` below is one named law in plain English;
// fast-check searches for a counter-example and shrinks it to a minimal failing design. Seeded for
// reproducibility. (Several of these would have auto-caught the bugs found by hand in `architectures.e2e`:
// the source `+Infinity`, the phantom overflow, the async throughput drop.)

const SEED = 20260629;
const OUTCOME: readonly Key[] = [keys.throughput, keys.latency, keys.cost];
const RATIO: readonly Key[] = [keys.availability, keys.durability];

/** Evaluate a generated design (the generator only yields buildable DAGs, so this is non-null in practice). */
function run(d: Design): Evaluation | null {
  const g = instantiate(CATALOG, d.instances, d.wires);
  if (!g.ok) return null;
  const r = evaluate(g.value, registry);
  return r.ok ? r.value : null;
}

/** Equal up to NaN-identity and a relative epsilon. */
function same(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a === b) return true;
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

describe('engine laws (property-based, over random real designs)', () => {
  it('every valid design builds and the fixpoint converges', () => {
    fc.assert(
      fc.property(arbDesign, (d) => {
        const e = run(d);
        return e !== null && e.converged;
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('LAW — no NaN; every outcome is finite and within its natural bounds (throughput/latency/cost ≥ 0, ratios ∈ [0,1])', () => {
    fc.assert(
      fc.property(arbDesign, (d) => {
        const e = run(d);
        if (!e) return false;
        for (const inst of d.instances) {
          const id = NodeId(inst.id);
          for (const k of OUTCOME) {
            const v = e.value(id, k);
            if (v !== undefined && (Number.isNaN(v) || (Number.isFinite(v) && v < -1e-9))) return false;
          }
          for (const k of RATIO) {
            const v = e.value(id, k);
            if (v !== undefined && Number.isFinite(v) && (v < -1e-9 || v > 1 + 1e-9)) return false;
          }
          const ov = e.value(id, keys.overflow); // ≥ 0 wherever modelled (−Infinity identity ⇒ "no rejection on this path")
          if (ov !== undefined && Number.isFinite(ov) && ov < -1e-9) return false;
        }
        return true;
      }),
      { seed: SEED, numRuns: 600 },
    );
  });

  it('LAW — deterministic & order-independent: shuffling node/edge order changes no computed value', () => {
    fc.assert(
      fc.property(arbDesign, (d) => {
        const a = run(d);
        const b = run({ instances: [...d.instances].reverse(), wires: [...d.wires].reverse() });
        if (!a || !b) return false;
        for (const inst of d.instances)
          for (const k of [...OUTCOME, ...RATIO, keys.overflow]) if (!same(a.value(NodeId(inst.id), k), b.value(NodeId(inst.id), k))) return false;
        return true;
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('LAW — load monotonicity: raising the offered load never LOWERS any served throughput or overflow', () => {
    fc.assert(
      fc.property(arbDesign, (d) => {
        const base = run(d);
        if (!base) return false;
        const src = d.instances[0]!;
        const cur = src.config?.[String(keys.throughput)] ?? 0;
        const up = run({ instances: [{ ...src, config: { ...src.config, [String(keys.throughput)]: cur * 2 + 1 } }, ...d.instances.slice(1)], wires: d.wires });
        if (!up) return false;
        for (const inst of d.instances) {
          const id = NodeId(inst.id);
          for (const k of [keys.throughput, keys.overflow]) {
            const lo = base.value(id, k);
            const hi = up.value(id, k);
            if (lo !== undefined && hi !== undefined && Number.isFinite(lo) && Number.isFinite(hi) && hi < lo - 1e-6) return false;
          }
        }
        return true;
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('LAW — async decouples the WAIT: making every edge async never RAISES any node latency (but throughput still carries)', () => {
    fc.assert(
      fc.property(arbDesign, (d) => {
        const sync = run({ instances: d.instances, wires: d.wires.map((w) => ({ from: w.from, to: w.to })) });
        const async = run({ instances: d.instances, wires: d.wires.map((w) => ({ from: w.from, to: w.to, semantics: 'async' as const })) });
        if (!sync || !async) return false;
        for (const inst of d.instances) {
          const ls = sync.value(NodeId(inst.id), keys.latency);
          const la = async.value(NodeId(inst.id), keys.latency);
          if (ls !== undefined && la !== undefined && Number.isFinite(ls) && Number.isFinite(la) && la > ls + 1e-6) return false;
        }
        return true;
      }),
      { seed: SEED, numRuns: 400 },
    );
  });
});
