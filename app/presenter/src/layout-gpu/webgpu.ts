import type { ProxyModel } from './proxy';
import { PROXY_ALIGN_EPS, PROXY_WEIGHTS } from './proxy';

// @algorithm Per-design WGSL layout-proxy kernel (batch candidate scoring on device)
// @problem Large offline candidate batches (the 50+-node growth axis, the perf benchmark) should
//   rank on a real GPU — one candidate per invocation — while computing bit-for-bit what the
//   deviceless twin computes.
// @approach Generate a per-design WGSL compute shader (workgroup size 64) with node/edge/fan-out
//   dimensions and term weights baked as consts, replaying the proxy's four fp32 term loops in the
//   twin's exact op order; upload packed centers, dispatch ceil(count/64), map scores back;
//   balanced error scopes, best-effort abort, destroy-on-exit; reached only via dynamic import
//   (bundle-separation invariant).
// @complexity Kernel O(e^2 + n^2) per invocation (crossings + pairwise alignment); dispatch
//   ceil(count/64) workgroups.
// @citations W3C WebGPU / WGSL specifications; mirrors the gpu-module discipline of
//   engine/solver-contract/src/gpu/webgpu.ts (separate kernel, shared discipline).
// @invariants Bit-for-bit agreement with the deviceless twin (device differential); never on the
//   product per-slice path (sync beam uses the twin); accelerates proposals only — the CPU-exact
//   re-score still decides every applied layout.
// @where-tested app/presenter/src/layout-gpu/device.test.ts,
//   app/presenter/src/layout-gpu/bundle-separation.test.ts

// THE IDEAL LAYOUT — the GPU PROPOSER's WebGPU driver (doc: ideal-layout §3.3). A per-design WGSL
// compute shader that replays the fp32 straight-line proxy (./proxy) ONE candidate per invocation, so a real card
// ranks thousands of placements in one dispatch. It computes bit-for-bit what the deviceless twin computes (same
// f32 op order — WGSL rounds every op once, exactly as the twin's Math.fround does); the device differential pins
// this. This module MIRRORS the gpu-module discipline proven by (engine/solver-contract/src/gpu/webgpu.ts):
// the minimal WebGPU surface declared locally (no ambient types), an honest cached device probe, balanced error
// scopes, best-effort abort, and destroy-on-exit. It is a SEPARATE kernel from the solver's cell-network kernel —
// different arithmetic (geometry, not capacity), authored here with the layout code, sharing only the discipline.
//
// Reached ONLY through a dynamic import (./index dynamically imports this; the presenter never statically pulls it),
// so the WebGPU driver stays out of every entry bundle's static graph — the bundle-separation invariant. The per-
// slice product path uses the deviceless twin (sync, device-identical); this driver is the proven-equivalent
// accelerator for LARGE offline batches (the perf benchmark) and the device arm of the differential.

// ── Minimal WebGPU surface (the subset this driver uses; prefixed `Gpu*` to avoid colliding with any global) ─────
interface Gpu {
  requestAdapter(): Promise<GpuAdapter | null>;
}
interface GpuAdapter {
  requestDevice(): Promise<GpuDevice>;
}
interface GpuDevice {
  readonly queue: GpuQueue;
  readonly lost: Promise<unknown>;
  createBuffer(desc: { size: number; usage: number; mappedAtCreation?: boolean }): GpuBuffer;
  createShaderModule(desc: { code: string }): GpuShaderModule;
  createComputePipeline(desc: { layout: 'auto'; compute: { module: GpuShaderModule; entryPoint: string } }): GpuComputePipeline;
  createBindGroup(desc: { layout: GpuBindGroupLayout; entries: readonly { binding: number; resource: { buffer: GpuBuffer } }[] }): GpuBindGroup;
  createCommandEncoder(): GpuCommandEncoder;
  pushErrorScope(filter: 'validation' | 'out-of-memory' | 'internal'): void;
  popErrorScope(): Promise<{ readonly message: string } | null>;
  destroy(): void;
}
interface GpuQueue {
  writeBuffer(buffer: GpuBuffer, offset: number, data: ArrayBufferView | ArrayBuffer): void;
  submit(buffers: readonly GpuCommandBuffer[]): void;
}
interface GpuBuffer {
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}
interface GpuShaderModule {
  readonly _brand?: 'shader';
}
interface GpuBindGroupLayout {
  readonly _brand?: 'bgl';
}
interface GpuBindGroup {
  readonly _brand?: 'bg';
}
interface GpuCommandBuffer {
  readonly _brand?: 'cmd';
}
interface GpuComputePipeline {
  getBindGroupLayout(index: number): GpuBindGroupLayout;
}
interface GpuComputePass {
  setPipeline(p: GpuComputePipeline): void;
  setBindGroup(index: number, group: GpuBindGroup): void;
  dispatchWorkgroups(x: number): void;
  end(): void;
}
interface GpuCommandEncoder {
  beginComputePass(): GpuComputePass;
  copyBufferToBuffer(src: GpuBuffer, srcOffset: number, dst: GpuBuffer, dstOffset: number, size: number): void;
  finish(): GpuCommandBuffer;
}

const USAGE_STORAGE = 0x0080;
const USAGE_UNIFORM = 0x0040;
const USAGE_COPY_DST = 0x0008;
const USAGE_COPY_SRC = 0x0004;
const USAGE_MAP_READ = 0x0001;
const MAP_MODE_READ = 0x0001;
const WORKGROUP_SIZE = 64;

/** Device-probe cache (independent of the solver kernel's): `undefined` = not probed; `null` = no device here
 *  (silent twin fallback); a device = WebGPU available. Cached so the caller probes once, not per batch. */
let cachedDevice: GpuDevice | null | undefined;

/** Honest availability probe: is a real WebGPU device obtainable here? `navigator.gpu` exists in Chrome/Edge and
 *  the Chromium webview (NOT in Node/CI, and NOT in the VS Code host process). Any failure reads as "no device" —
 *  the caller then ranks with the deviceless fp32 twin (device-identical). */
export async function layoutGpuDevice(): Promise<GpuDevice | null> {
  if (cachedDevice !== undefined) return cachedDevice;
  try {
    const nav = (globalThis as { navigator?: { gpu?: Gpu } }).navigator;
    const gpu = nav?.gpu;
    if (gpu === undefined) {
      cachedDevice = null;
      return null;
    }
    const adapter = await gpu.requestAdapter();
    if (adapter === null) {
      cachedDevice = null;
      return null;
    }
    const device = await adapter.requestDevice();
    void device.lost.then(() => {
      if (cachedDevice === device) cachedDevice = undefined; // device loss ⇒ re-probe (falls back to twin meanwhile)
    });
    cachedDevice = device;
    return device;
  } catch {
    cachedDevice = null;
    return null;
  }
}

/** Reset the probe cache (device loss / tests). */
export function resetLayoutGpuProbe(): void {
  cachedDevice = undefined;
}

const pad4 = (bytes: number): number => Math.max(4, (bytes + 3) & ~3);
const f = Math.fround;

/**
 * Generate the per-design WGSL compute shader. The design's fixed dimensions (node/edge/fan-out counts) and the
 * ratified proxy weights + ε are baked as `const`s so the loop bounds and the aggregate fold are compile-time; only
 * the candidate count varies at run time (a uniform), so one shader serves any batch size. Each invocation owns one
 * candidate `k`, reads its centre slice `centers[k*2N ..]`, and folds the four proxy terms in the SAME order the
 * twin does (crossings → length → alignment → symmetry) — so the two agree to fp32 tolerance.
 */
export function generateProxyWgsl(model: ProxyModel): string {
  const { n, e, fanoutCount } = model;
  const bound = (e * (e - 1)) / 2;
  return `
const NNODES: u32 = ${n}u;
const NEDGE: u32 = ${e}u;
const NFAN: u32 = ${fanoutCount}u;
const EPS: f32 = ${f(PROXY_ALIGN_EPS).toExponential()};
const W_CROSS: f32 = ${f(PROXY_WEIGHTS.crossings).toExponential()};
const W_LEN: f32 = ${f(PROXY_WEIGHTS.length).toExponential()};
const W_ALIGN: f32 = ${f(PROXY_WEIGHTS.alignment).toExponential()};
const W_SYM: f32 = ${f(PROXY_WEIGHTS.symmetry).toExponential()};
const XBOUND: f32 = ${f(bound).toExponential()};

@group(0) @binding(0) var<storage, read> centers: array<f32>;
@group(0) @binding(1) var<storage, read> wires: array<i32>;
@group(0) @binding(2) var<storage, read> fanout: array<i32>;
@group(0) @binding(3) var<storage, read> halfW: array<f32>;
@group(0) @binding(4) var<storage, read> halfH: array<f32>;
@group(0) @binding(5) var<storage, read_write> outScore: array<f32>;
struct Params { count: u32 };
@group(0) @binding(6) var<uniform> params: Params;

fn cx(base: u32, i: u32) -> f32 { return centers[base + 2u * i]; }
fn cy(base: u32, i: u32) -> f32 { return centers[base + 2u * i + 1u]; }

fn orient(ax: f32, ay: f32, bx: f32, by: f32, px: f32, py: f32) -> f32 {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k: u32 = gid.x;
  if (k >= params.count) { return; }
  let base: u32 = k * NNODES * 2u;

  // bounding diagonal (the length normaliser) from centres ± half-sizes
  var minX: f32 = 1e30; var minY: f32 = 1e30; var maxX: f32 = -1e30; var maxY: f32 = -1e30;
  for (var i: u32 = 0u; i < NNODES; i = i + 1u) {
    let x = cx(base, i); let y = cy(base, i); let hw = halfW[i]; let hh = halfH[i];
    minX = min(minX, x - hw); maxX = max(maxX, x + hw);
    minY = min(minY, y - hh); maxY = max(maxY, y + hh);
  }
  let bw = maxX - minX; let bh = maxY - minY;
  let diag = sqrt(bw * bw + bh * bh);

  // crossings — straight segments, proper interior crossing
  var crossing: f32 = 0.0;
  for (var i: u32 = 0u; i < NEDGE; i = i + 1u) {
    let a0 = u32(wires[2u * i]); let a1 = u32(wires[2u * i + 1u]);
    let p1x = cx(base, a0); let p1y = cy(base, a0); let p2x = cx(base, a1); let p2y = cy(base, a1);
    for (var j: u32 = i + 1u; j < NEDGE; j = j + 1u) {
      let b0 = u32(wires[2u * j]); let b1 = u32(wires[2u * j + 1u]);
      let p3x = cx(base, b0); let p3y = cy(base, b0); let p4x = cx(base, b1); let p4y = cy(base, b1);
      let d1 = orient(p3x, p3y, p4x, p4y, p1x, p1y);
      let d2 = orient(p3x, p3y, p4x, p4y, p2x, p2y);
      let d3 = orient(p1x, p1y, p2x, p2y, p3x, p3y);
      let d4 = orient(p1x, p1y, p2x, p2y, p4x, p4y);
      let ab = (d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0);
      let cd = (d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0);
      if (ab && cd) { crossing = crossing + 1.0; }
    }
  }

  // length — straight Euclidean, summed in wire order
  var total: f32 = 0.0;
  for (var i: u32 = 0u; i < NEDGE; i = i + 1u) {
    let a = u32(wires[2u * i]); let b = u32(wires[2u * i + 1u]);
    let dx = cx(base, b) - cx(base, a); let dy = cy(base, b) - cy(base, a);
    total = total + sqrt(dx * dx + dy * dy);
  }

  // alignment — pairwise guideline sharing within EPS
  var aligned: f32 = 0.0;
  for (var i: u32 = 0u; i < NNODES; i = i + 1u) {
    let xi = cx(base, i); let yi = cy(base, i);
    var shares: bool = false;
    for (var j: u32 = 0u; j < NNODES; j = j + 1u) {
      if (j == i) { continue; }
      if (abs(xi - cx(base, j)) <= EPS || abs(yi - cy(base, j)) <= EPS) { shares = true; }
    }
    if (shares) { aligned = aligned + 1.0; }
  }

  // symmetry — fan-out asymmetry about each source's centre-Y (walk the flat groups)
  var symSum: f32 = 0.0;
  var p: u32 = 0u;
  for (var g: u32 = 0u; g < NFAN; g = g + 1u) {
    let src = u32(fanout[p]); let cnt = u32(fanout[p + 1u]); p = p + 2u;
    let pyv = cy(base, src);
    var absSum: f32 = 0.0; var signedSum: f32 = 0.0;
    for (var t: u32 = 0u; t < cnt; t = t + 1u) {
      let kid = u32(fanout[p + t]);
      let off = cy(base, kid) - pyv;
      absSum = absSum + abs(off); signedSum = signedSum + off;
    }
    p = p + cnt;
    if (absSum > 0.0) { symSum = symSum + abs(signedSum) / absSum; }
  }

  // aggregate — renormalise over the ACTIVE terms, in crossings→length→alignment→symmetry order (matches the twin)
  var weighted: f32 = 0.0; var activeWeight: f32 = 0.0;
  if (XBOUND > 0.0) { weighted = weighted + W_CROSS * clamp(crossing / XBOUND, 0.0, 1.0); activeWeight = activeWeight + W_CROSS; }
  if (NEDGE >= 1u && diag > 0.0) { weighted = weighted + W_LEN * clamp(total / (f32(NEDGE) * diag), 0.0, 1.0); activeWeight = activeWeight + W_LEN; }
  if (NNODES >= 2u) { weighted = weighted + W_ALIGN * clamp(1.0 - aligned / f32(NNODES), 0.0, 1.0); activeWeight = activeWeight + W_ALIGN; }
  if (NFAN >= 1u) { weighted = weighted + W_SYM * clamp(symSum / f32(NFAN), 0.0, 1.0); activeWeight = activeWeight + W_SYM; }

  var quality: f32 = 1.0;
  if (activeWeight > 0.0) { quality = clamp(1.0 - weighted / activeWeight, 0.0, 1.0); }
  outScore[k] = quality;
}
`;
}

/**
 * Run the proxy kernel over a batch on a real WebGPU device, returning one fp32 quality per candidate (the same
 * shape {@link proxyScoreBatchFp32} returns, so the two are directly differential-comparable). THROWS on any device
 * error (validation / OOM / device loss) so the caller falls back to the deviceless twin — a GPU failure is an
 * honesty state, never a wrong rank. Best-effort cancellation: an aborted signal skips readback and returns `null`.
 */
export async function runProxyOnGpu(
  device: GpuDevice,
  model: ProxyModel,
  centersFlat: Float32Array,
  count: number,
  signal?: AbortSignal,
): Promise<Float32Array | null> {
  if (signal?.aborted) return null;
  const outSize = pad4(count * 4);

  const buffers: GpuBuffer[] = [];
  const store = (data: ArrayBufferView, usage: number): GpuBuffer => {
    const buf = device.createBuffer({ size: pad4(data.byteLength), usage: usage | USAGE_COPY_DST });
    device.queue.writeBuffer(buf, 0, data);
    buffers.push(buf);
    return buf;
  };
  let scopes = 0;
  device.pushErrorScope('validation');
  scopes++;
  device.pushErrorScope('out-of-memory');
  scopes++;
  const drainScopes = async (): Promise<void> => {
    while (scopes > 0) {
      scopes--;
      await device.popErrorScope();
    }
  };
  try {
    // Every storage binding must be non-empty (a zero-sized storage buffer is invalid) — pad the geometry tables.
    const centersBuf = store(centersFlat.length > 0 ? centersFlat : new Float32Array(1), USAGE_STORAGE);
    const wiresBuf = store(model.wires.length > 0 ? model.wires : new Int32Array(1), USAGE_STORAGE);
    const fanoutBuf = store(model.fanout.length > 0 ? model.fanout : new Int32Array(1), USAGE_STORAGE);
    const halfWBuf = store(model.halfW.length > 0 ? model.halfW : new Float32Array(1), USAGE_STORAGE);
    const halfHBuf = store(model.halfH.length > 0 ? model.halfH : new Float32Array(1), USAGE_STORAGE);
    const outBuf = device.createBuffer({ size: outSize, usage: USAGE_STORAGE | USAGE_COPY_SRC });
    buffers.push(outBuf);
    const paramsBuf = device.createBuffer({ size: 16, usage: USAGE_UNIFORM | USAGE_COPY_DST });
    device.queue.writeBuffer(paramsBuf, 0, new Uint32Array([count, 0, 0, 0]));
    buffers.push(paramsBuf);

    const module = device.createShaderModule({ code: generateProxyWgsl(model) });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: centersBuf } },
        { binding: 1, resource: { buffer: wiresBuf } },
        { binding: 2, resource: { buffer: fanoutBuf } },
        { binding: 3, resource: { buffer: halfWBuf } },
        { binding: 4, resource: { buffer: halfHBuf } },
        { binding: 5, resource: { buffer: outBuf } },
        { binding: 6, resource: { buffer: paramsBuf } },
      ],
    });

    const staging = device.createBuffer({ size: outSize, usage: USAGE_COPY_DST | USAGE_MAP_READ });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(count / WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(outBuf, 0, staging, 0, outSize);
    device.queue.submit([encoder.finish()]);

    await staging.mapAsync(MAP_MODE_READ);
    if (signal?.aborted) {
      staging.unmap();
      staging.destroy();
      return null;
    }
    const scored = new Float32Array(staging.getMappedRange().slice(0, count * 4));
    staging.unmap();
    staging.destroy();

    scopes -= 2;
    const oom = await device.popErrorScope();
    const validation = await device.popErrorScope();
    if (validation !== null) throw new Error(`WebGPU validation error: ${validation.message}`);
    if (oom !== null) throw new Error(`WebGPU out-of-memory: ${oom.message}`);
    return scored;
  } catch (e) {
    await drainScopes();
    throw e;
  } finally {
    for (const b of buffers) b.destroy();
  }
}

export type { GpuDevice as LayoutGpuDeviceHandle };
