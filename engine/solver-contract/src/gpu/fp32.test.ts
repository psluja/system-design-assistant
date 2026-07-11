import { describe, expect, it } from 'vitest';
import { Key, NodeId } from '@sda/engine-core';
import { makeNativeAdapter } from '../native';
import type { Scenario } from '../capability';
import { generateCorpus, generateNumeric, generatedRegistry, rngOf, type NumericInstance, THROUGHPUT, COST, LATENCY } from '../harness/generator';
import { compileProgram, runProgramFp32, evaluationsFromCells } from './index';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE CPU-vs-GPU DIFFERENTIAL — deviceless arm (TASK-81 AC#2). This suite drives the fp32 JS executor (./fp32),
// a FAITHFUL emulation of the WGSL kernel: the SAME compiled bytecode, run over Float32Array scratch that rounds
// every intermediate to fp32 on each store — the single-rounding-per-op semantics a WGSL `f32` kernel has (the
// Math.fround folds the deviceless test must still exercise). The real-device arm (./differential.test.ts) runs
// the identical corpus through WebGPU and SKIPS honestly where no device exists — so the kernel's numeric path is
// proven either way. The fp64 reference is the native adapter's own `evaluateBatch` (the CPU implementation).
//
// THE fp32 ERROR MODEL (the declared tolerance, and WHY). fp32 has a 24-bit mantissa: machine epsilon
// ε = 2^-24 ≈ 6.0e-8. The forward pass is a fold of the closed op set {+,−,×,÷,min,max} over positive
// quantities. A chain of D dependent rounding operations accumulates a relative error bounded by
// (1+ε)^D − 1 ≈ D·ε for D·ε ≪ 1. The deepest generated design (the `depth` axis) is ~100 tiers, so the summed
// latency / cost folds reach D ≈ 100–200 ⇒ a worst-case relative error ≈ 1.2e-5. Division and min/max add no
// systematic drift (min/max is exact; ÷ rounds once). Catastrophic cancellation is not a factor: the cell network
// is sums/mins/products of NON-NEGATIVE flows and costs (subtraction appears only as `neg`, never as a difference
// of near-equal large numbers). We therefore DECLARE a relative tolerance of 1e-3 with a small absolute floor —
// ~80× the derived worst case, absorbing the extra fp32 residual of the Gauss-Seidel iteration and any min-tie
// straddle at a boundary, yet still two orders tighter than a REAL algorithmic divergence (which is O(1), not
// O(ε)). The BOUNDARY axis (a floor placed EXACTLY on the achievable capacity edge) is included precisely because
// that is where a value sits one ULP from a bound — the metric VALUE still agrees within tolerance; the verdict
// BOOLEAN (which can flip across the ULP) is the reason anything verdict-grade is CPU-confirmed, never fp32-final.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const REL_TOL = 1e-3;
const ABS_FLOOR = 1e-3;
const KEYS = [THROUGHPUT, COST, LATENCY] as const;

const cpu = makeNativeAdapter({ registry: generatedRegistry }).evaluateBatch!;

/** Agreement under the declared fp32 error model: both non-finite with the same sign (a shared ±Inf/NaN identity)
 *  counts as equal; otherwise `|a−b| ≤ ABS_FLOOR + REL_TOL·max(|a|,|b|)`. */
function agrees(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Object.is(a, b) || (a === Infinity && b === Infinity) || (a === -Infinity && b === -Infinity);
  return Math.abs(a - b) <= ABS_FLOOR + REL_TOL * Math.max(Math.abs(a), Math.abs(b));
}

/** N scenarios that draw every tunable tier capacity across its full [0, tierMax] range (seeded) — the Monte-Carlo
 *  sample analog, so the served throughput swings below and above the bottleneck and cost/latency move with it. */
function scenariosFor(inst: NumericInstance, n: number, seed: number): Scenario[] {
  const rng = rngOf(seed);
  const out: Scenario[] = [];
  for (let i = 0; i < n; i++) {
    const overrides: Record<string, number> = {};
    for (const t of inst.tunables) overrides[`${String(t.node)}|${String(t.key)}`] = t.min + rng.next() * (t.max - t.min);
    out.push({ overrides });
  }
  return out;
}

/** Compare the fp32 executor to the fp64 reference across a corpus, asserting per-(node,key) agreement. The
 *  failure message carries the seed + axis + a repro command (harness convention: every failure reproduces). */
async function assertAgrees(instances: readonly NumericInstance[], scenariosPerInstance: number): Promise<number> {
  let comparisons = 0;
  for (const inst of instances) {
    const scenarios = scenariosFor(inst, scenariosPerInstance, inst.seed ^ 0x9e3779b9);
    const compiled = compileProgram(inst.graph, generatedRegistry);
    expect(compiled.ok, `expected a compilable design at seed ${inst.seed} (${inst.axis}/${inst.topology})`).toBe(true);
    if (!compiled.ok) continue;

    const req = { graph: inst.graph, scenarios };
    const refEvals = await cpu(req);
    const fp32Evals = evaluationsFromCells(inst.graph, generatedRegistry, compiled.program, runProgramFp32(compiled.program, scenarios));
    expect(fp32Evals.length).toBe(refEvals.length);

    for (let s = 0; s < refEvals.length; s++) {
      const ref = refEvals[s]!;
      const got = fp32Evals[s]!;
      for (const node of inst.graph.nodes.keys()) {
        for (const key of KEYS) {
          const a = ref.value(node, key);
          const b = got.value(node, key);
          if (a === undefined && b === undefined) continue;
          const repro = `Repro: pnpm --filter @sda/solver-contract test -- gpu/fp32 (seed ${inst.seed}, axis ${inst.axis}, ${inst.topology}, scenario ${s})`;
          expect(a !== undefined && b !== undefined, `one backend has no value @ ${String(node)}.${String(key)} cpu=${a} fp32=${b}. ${repro}`).toBe(true);
          if (a !== undefined && b !== undefined) {
            expect(agrees(a, b), `fp32 ≠ fp64 @ ${String(node)}.${String(key)}: cpu=${a} fp32=${b} (Δrel=${Math.abs(a - b) / (Math.max(Math.abs(a), Math.abs(b)) || 1)}). ${repro}`).toBe(true);
            comparisons++;
          }
        }
      }
    }
  }
  return comparisons;
}

describe('gpu fp32 kernel ≈ fp64 reference — the deviceless differential (Math.fround folds)', () => {
  it('agrees within the declared fp32 tolerance across the seeded corpus (all axes, incl. boundary)', async () => {
    // The full hardening corpus: baseline × every topology × {sat,unsat}, PLUS the phase-3 axes
    // (boundary/magnitude/depth/multiband/transforms/zero-traffic/latency + objective-tie). Numeric only.
    const corpus = generateCorpus({ axes: true, perCell: 1, perAxis: 1 }).filter((i): i is NumericInstance => i.kind === 'numeric');
    const comparisons = await assertAgrees(corpus, 12);
    expect(comparisons).toBeGreaterThan(500); // the suite actually compared thousands of values (not vacuous)
  });

  it('the BOUNDARY axis (floors on the exact capacity edge) agrees to tolerance under many scenarios', async () => {
    // A dedicated, denser boundary pass — the ULP-straddle corner the error model calls out. Values sit ON a
    // bound; the metric VALUE still agrees (the verdict boolean is what CPU-confirmation exists for).
    const boundary = [
      generateNumeric(0xb0, 'optimize', 'chain', 'sat', 'boundary'),
      generateNumeric(0xb1, 'optimize', 'fan-in', 'sat', 'boundary'),
      generateNumeric(0xb2, 'optimize', 'fan-out', 'unsat', 'boundary'),
      generateNumeric(0xb3, 'optimize', 'chain', 'unsat', 'boundary'),
    ];
    await assertAgrees(boundary, 40);
  });
});

describe('gpu fp32 kernel — deterministic (byte-reproducible; the executor owns no randomness)', () => {
  it('the same program + scenarios yield identical cell arrays every run', () => {
    const inst = generateNumeric(42, 'optimize', 'chain', 'sat', 'depth'); // a deep chain: the worst fold depth
    const compiled = compileProgram(inst.graph, generatedRegistry);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const scenarios = scenariosFor(inst, 8, 123);
    const a = runProgramFp32(compiled.program, scenarios);
    const b = runProgramFp32(compiled.program, scenarios);
    expect(a.map((c) => [...c])).toEqual(b.map((c) => [...c]));
  });

  it('value(node,key) reads the settled out slot — a source emits its (possibly overridden) demand', () => {
    const inst = generateNumeric(5, 'optimize', 'chain', 'sat');
    const compiled = compileProgram(inst.graph, generatedRegistry);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const scenario: Scenario = { overrides: { 'src|throughput': 1234 } };
    const [ev] = evaluationsFromCells(inst.graph, generatedRegistry, compiled.program, runProgramFp32(compiled.program, [scenario]));
    expect(ev!.value(NodeId('src'), Key('throughput'))).toBeCloseTo(1234, 3);
  });
});
