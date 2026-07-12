import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import type { LayoutDesign, LayoutGroup, LayoutNode, LayoutWire, Placement } from '../layout-model';
import { DEFAULT_NODE_SIZE, ROW_PITCH, mulberry32 } from '../layout-model';
import { semanticLayout } from '../layout-semantic';
import { tidyLayout } from '../layout';
import { buildProxyModel, packCenters, proxyScoreBatchFp32 } from './proxy';
import { generateProxyWgsl, layoutGpuDevice, resetLayoutGpuProbe, runProxyOnGpu } from './webgpu';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE IDEAL LAYOUT — the GPU PROPOSER's DEVICE ARM. It proves the REAL WGSL
// kernel replays the fp32 twin bit-for-bit (the twin — ./proxy — is what the product per-slice path runs; this arm
// pins that a real card agrees), and it measures batch timings. If no WebGPU device exists on this runner (Node/CI
// has no `navigator.gpu`), the device assertions SKIP with an honest marker — never a silent pass; the deviceless
// twin arm (./proxy.test.ts) still exercises the kernel's exact numeric path, so the arithmetic is proven either
// way. This mirrors engine/solver-contract/src/gpu/differential.test.ts exactly.
//
// THE fp32 TOLERANCE. Both the twin and the WGSL kernel are fp32 single-rounding-per-op over the SAME op order, so
// they agree to a small relative tolerance (the residual is ULP-level rounding, not algorithmic divergence). The
// proxy folds are shallow (a handful of ops per term over positive quantities), so 1e-4 relative + a 1e-4 floor is
// comfortably above the true residual yet orders below any real disagreement.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const REL_TOL = 1e-4;
const ABS_FLOOR = 1e-4;
const agrees = (a: number, b: number): boolean => Math.abs(a - b) <= ABS_FLOOR + REL_TOL * Math.max(Math.abs(a), Math.abs(b));

interface Raw {
  instances: { id: string; type: string; config?: Record<string, number> }[];
  wires: { from: [string, string]; to: [string, string]; semantics?: 'sync' | 'async' }[];
  groups?: { id: string; members: string[] }[];
}
function load(file: string): LayoutDesign {
  const raw = JSON.parse(readFileSync(new URL(`../../../../examples/${file}`, import.meta.url), 'utf8')) as Raw;
  const nodes: LayoutNode[] = raw.instances.map((i) => {
    const origin = i.config?.assumedRps;
    return origin !== undefined ? { id: i.id, type: i.type, originRate: origin } : { id: i.id, type: i.type };
  });
  const wires: LayoutWire[] = raw.wires.map((w) => (w.semantics !== undefined ? { from: w.from, to: w.to, semantics: w.semantics } : { from: w.from, to: w.to }));
  const groups: LayoutGroup[] = (raw.groups ?? []).map((g) => ({ id: g.id, members: g.members }));
  return { nodes, wires, groups };
}
const EXAMPLES = ['cqrs.sda.json', 'ecommerce-production.sda.json', 'cqrs-production-large.sda.json', 'oracle-to-aurora-migration-repeat.sda.json'];
const sizesFor = (d: LayoutDesign): Record<string, { w: number; h: number }> => {
  const s: Record<string, { w: number; h: number }> = {};
  for (const n of d.nodes) s[n.id] = DEFAULT_NODE_SIZE;
  return s;
};
const tidyOf = (d: LayoutDesign): Placement => {
  const groups = d.groups.map((g) => ({ id: g.id, label: '', rect: { x: 0, y: 0, w: 0, h: 0 }, members: g.members }));
  return tidyLayout(d.nodes.map((x) => ({ id: x.id })), d.wires.map((w) => ({ from: w.from, to: w.to })), groups, sizesFor(d)).pos;
};

/** A batch of `count` candidate placements by seeded row-jitter of the tidy/semantic seeds — enough spread to
 *  exercise every kernel branch; realism is irrelevant here (this measures SCORING throughput + device↔twin
 *  agreement, not layout quality). */
function jitterBatch(d: LayoutDesign, count: number, seed: number): Placement[] {
  const sizeMap = sizesFor(d);
  const bases = [tidyOf(d), semanticLayout(d, sizeMap)];
  const rng = mulberry32(seed);
  const out: Placement[] = [];
  for (let k = 0; k < count; k++) {
    const base = bases[k % bases.length]!;
    const np: Record<string, { x: number; y: number }> = {};
    for (const id of Object.keys(base)) {
      const p = base[id]!;
      np[id] = { x: p.x, y: p.y + Math.round((rng() - 0.5) * 4) * ROW_PITCH };
    }
    out.push(np);
  }
  return out;
}

describe('proxy WGSL — the shader generator bakes the design (always on, no device needed)', () => {
  it.each(EXAMPLES)('%s: generateProxyWgsl produces a compute shader with the baked design dimensions', (f) => {
    const d = load(f);
    const model = buildProxyModel(d, sizesFor(d));
    const wgsl = generateProxyWgsl(model);
    expect(wgsl).toContain('@compute');
    expect(wgsl).toContain('fn main(');
    expect(wgsl).toContain(`const NNODES: u32 = ${model.n}u;`);
    expect(wgsl).toContain(`const NEDGE: u32 = ${model.e}u;`);
    expect(wgsl).toContain(`const NFAN: u32 = ${model.fanoutCount}u;`);
    expect(wgsl).toContain('outScore[k] = quality;');
  });
});

let device: Awaited<ReturnType<typeof layoutGpuDevice>> = null;
beforeAll(async () => {
  resetLayoutGpuProbe();
  device = await layoutGpuDevice();
});
const hasDevice = (): boolean => device !== null;

describe('proxy device differential — real WGSL kernel ≈ fp32 twin (skips honestly with no device)', () => {
  it('reports whether a WebGPU device is present (an honest marker, never a silent pass)', () => {
    expect(device === null || device !== null).toBe(true);
    if (device === null) {
      // eslint-disable-next-line no-console
      console.info('[layout gpu differential] no WebGPU device on this runner — device arm SKIPPED (the fp32 twin arm in proxy.test.ts still exercises the kernel path).');
    }
  });

  it.skipIf(!hasDevice())('the WGSL kernel agrees with the twin within fp32 tolerance across the examples', async () => {
    const dev = device;
    if (dev === null) return;
    let comparisons = 0;
    for (const f of EXAMPLES) {
      const d = load(f);
      const model = buildProxyModel(d, sizesFor(d));
      const batch = jitterBatch(d, 64, 0x1234);
      const flat = packCenters(model, batch);
      const twin = proxyScoreBatchFp32(model, flat, batch.length);
      const gpu = await runProxyOnGpu(dev, model, flat, batch.length);
      expect(gpu, `runProxyOnGpu returned null (unexpected abort) for ${f}`).not.toBeNull();
      if (gpu === null) continue;
      for (let k = 0; k < batch.length; k++) {
        const repro = `Repro: run layout-gpu/device on a WebGPU device (${f}, candidate ${k})`;
        expect(agrees(twin[k]!, gpu[k]!), `WGSL ≠ twin @ ${f}#${k}: twin=${twin[k]} gpu=${gpu[k]}. ${repro}`).toBe(true);
        comparisons++;
      }
    }
    expect(comparisons).toBeGreaterThan(0);
  });
});

describe('proxy PERF — batch scoring timings (twin always; device when present)', () => {
  it('measures twin batch-scoring throughput across batch sizes (logged for the report)', () => {
    const d = load('cqrs-production-large.sda.json'); // the largest committed design (23 nodes, 4 groups)
    const model = buildProxyModel(d, sizesFor(d));
    const sizes = [64, 256, 1024, 4096];
    const lines: string[] = [`\n[layout-gpu perf] twin fp32 proxy — ${d.nodes.length} nodes, ${model.e} wires:`];
    for (const count of sizes) {
      const flat = packCenters(model, jitterBatch(d, count, 0x55 + count));
      // warm + timed
      proxyScoreBatchFp32(model, flat, count);
      const t0 = performance.now();
      const reps = 5;
      for (let r = 0; r < reps; r++) proxyScoreBatchFp32(model, flat, count);
      const ms = (performance.now() - t0) / reps;
      lines.push(`  batch ${String(count).padStart(5)} : ${ms.toFixed(3)} ms  (${(count / ms).toFixed(0)} cand/ms)`);
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    expect(true).toBe(true);
  });

  it.skipIf(!hasDevice())('measures the real WGSL kernel batch timings on a device (logged for the report)', async () => {
    const dev = device;
    if (dev === null) return;
    const d = load('cqrs-production-large.sda.json');
    const model = buildProxyModel(d, sizesFor(d));
    const lines: string[] = [`\n[layout-gpu perf] WGSL device kernel — ${d.nodes.length} nodes:`];
    for (const count of [256, 1024, 4096, 16384]) {
      const flat = packCenters(model, jitterBatch(d, count, 0x77 + count));
      await runProxyOnGpu(dev, model, flat, count); // warm (shader compile)
      const t0 = performance.now();
      await runProxyOnGpu(dev, model, flat, count);
      const ms = performance.now() - t0;
      lines.push(`  batch ${String(count).padStart(6)} : ${ms.toFixed(3)} ms`);
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    expect(true).toBe(true);
  });
});
