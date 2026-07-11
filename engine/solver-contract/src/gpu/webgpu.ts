// @algorithm Per-design WGSL compute-kernel generation (batch scenario evaluation on device)
// @problem Thousands of Monte-Carlo scenarios must evaluate on a real GPU in one dispatch while
//   computing exactly what the deviceless fp32 executor computes — no silent numeric drift.
// @approach Generate a per-design WGSL compute shader (workgroup size 64, one invocation per
//   scenario) that replays the compiled stack-machine bytecode with design dimensions baked as
//   consts; upload base cells + override table, dispatch ceil(n/64) workgroups, map the settled
//   cell arrays back; balanced error scopes, best-effort abort, destroy-on-exit.
// @complexity Kernel O(sweeps * instructions) per invocation; transfer O(scenarios * cells).
// @citations W3C WebGPU / WGSL specifications; bytecode-replay kernel design shared with
//   engine/solver-contract/src/gpu/fp32.ts (the twin).
// @invariants Bit-for-bit agreement with the fp32 twin (differential-tested on real devices);
//   reached only via dynamic import so no entry bundle statically pulls the driver
//   (bundle-separation invariant); a lost/absent device degrades to CPU, never to wrong numbers.
// @where-tested engine/solver-contract/src/gpu/differential.test.ts (device arm)

// THE GPU BACKEND — WebGPU driver. Generates a per-design WGSL compute shader that replays the compiled
// stack-machine bytecode (./compile) once PER SCENARIO in fp32, uploads the batch, dispatches, and reads the
// settled cell arrays back. It computes bit-for-bit what the deviceless fp32 executor (./fp32) computes (same
// bytecode, same single-rounding-per-op f32 semantics) — the differential pins that the real device agrees.
//
// NO NEW DEPS: WebGPU has no ambient types in this repo's TS lib, so this module declares the MINIMAL surface it
// uses locally (prefixed `Gpu*` to avoid colliding with any global) and reaches `navigator.gpu` through it. The
// numeric GPUBufferUsage / GPUMapMode flags are inlined as documented constants (the browser globals aren't needed
// to PARSE this file — the module is only ever imported when a device is present, i.e. in a real Chromium shell).

import type { CompiledProgram } from './compile';

// ── Minimal WebGPU surface (the subset this driver uses) ──────────────────────────────────────────────────────
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
interface GpuComputePipeline {
  getBindGroupLayout(index: number): GpuBindGroupLayout;
}
interface GpuBindGroup {
  readonly _brand?: 'bg';
}
interface GpuCommandBuffer {
  readonly _brand?: 'cmd';
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

// GPUBufferUsage / GPUMapMode numeric flags (the WebGPU spec constants — inlined so this file needs no globals).
const USAGE_STORAGE = 0x0080;
const USAGE_UNIFORM = 0x0040;
const USAGE_COPY_DST = 0x0008;
const USAGE_COPY_SRC = 0x0004;
const USAGE_MAP_READ = 0x0001;
const MAP_MODE_READ = 0x0001;
const WORKGROUP_SIZE = 64;

/** A cached device probe: `undefined` = not yet probed; `null` = no device on this machine (silent CPU fallback);
 *  a device = WebGPU is available. Cached so the ambient loop probes once, not per run. */
let cachedDevice: GpuDevice | null | undefined;

/** Honest availability probe (AC#4): is a real WebGPU device obtainable here? `navigator.gpu` exists in
 *  Chrome/Edge and the VS Code (Chromium) webview — including inside a dedicated worker. Returns the device (once,
 *  cached) or null. Any failure (no `navigator.gpu`, adapter/device refused, an exception) reads as "no device" —
 *  the caller then runs the CPU reference silently. */
export async function gpuDevice(): Promise<GpuDevice | null> {
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
    // A device loss ⇒ drop the cache so a later run re-probes (and falls back to CPU until a device returns).
    void device.lost.then(() => {
      if (cachedDevice === device) cachedDevice = undefined;
    });
    cachedDevice = device;
    return device;
  } catch {
    cachedDevice = null;
    return null;
  }
}

/** Reset the probe cache (device loss / tests). */
export function resetGpuProbe(): void {
  cachedDevice = undefined;
}

/** Round a byte length up to a multiple of 4 (WebGPU buffer sizes must be 4-aligned) and never zero (a zero-sized
 *  storage buffer is invalid — a 4-byte pad stands in for an empty override table). */
const pad4 = (bytes: number): number => Math.max(4, (bytes + 3) & ~3);

/** Generate the per-design WGSL compute shader. The design's fixed dimensions (cell count, instruction count,
 *  sweep count, stack cap, override count) are baked as `const`s so the scratch stack and the loop bounds are
 *  compile-time; only the scenario count varies at run time (a uniform), so one shader serves any batch size. Each
 *  invocation owns scenario `sc`, works its cell array as the slice `out[sc*NCELLS ..]`, and runs the bytecode. */
export function generateWgsl(program: CompiledProgram): string {
  const { nCells, nInstr, sweeps, stackCap } = program;
  const nOverride = countOverrides(program);
  return `
const NCELLS: u32 = ${nCells}u;
const NINSTR: u32 = ${nInstr}u;
const SWEEPS: u32 = ${sweeps}u;
const STACKCAP: u32 = ${Math.max(1, stackCap)}u;
const NOVERRIDE: u32 = ${nOverride}u;

@group(0) @binding(0) var<storage, read> code: array<i32>;
@group(0) @binding(1) var<storage, read> consts: array<f32>;
@group(0) @binding(2) var<storage, read> baseCells: array<f32>;
@group(0) @binding(3) var<storage, read> ovSlots: array<i32>;
@group(0) @binding(4) var<storage, read> ovVals: array<f32>;
@group(0) @binding(5) var<storage, read_write> outCells: array<f32>;
struct Params { n: u32 };
@group(0) @binding(6) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let sc: u32 = gid.x;
  if (sc >= params.n) { return; }
  let base: u32 = sc * NCELLS;
  for (var c: u32 = 0u; c < NCELLS; c = c + 1u) { outCells[base + c] = baseCells[c]; }
  for (var o: u32 = 0u; o < NOVERRIDE; o = o + 1u) { outCells[base + u32(ovSlots[o])] = ovVals[sc * NOVERRIDE + o]; }
  var stack: array<f32, STACKCAP>;
  for (var s: u32 = 0u; s < SWEEPS; s = s + 1u) {
    var sp: u32 = 0u;
    for (var i: u32 = 0u; i < NINSTR; i = i + 1u) {
      let op: i32 = code[2u * i];
      let arg: i32 = code[2u * i + 1u];
      switch (op) {
        case 0: { stack[sp] = consts[arg]; sp = sp + 1u; }
        case 1: { stack[sp] = outCells[base + u32(arg)]; sp = sp + 1u; }
        case 2: { stack[sp - 1u] = -stack[sp - 1u]; }
        case 3: { sp = sp - 1u; stack[sp - 1u] = stack[sp - 1u] + stack[sp]; }
        case 4: { sp = sp - 1u; stack[sp - 1u] = stack[sp - 1u] - stack[sp]; }
        case 5: { sp = sp - 1u; stack[sp - 1u] = stack[sp - 1u] * stack[sp]; }
        case 6: { sp = sp - 1u; stack[sp - 1u] = stack[sp - 1u] / stack[sp]; }
        case 7: { sp = sp - 1u; stack[sp - 1u] = min(stack[sp - 1u], stack[sp]); }
        case 8: { sp = sp - 1u; stack[sp - 1u] = max(stack[sp - 1u], stack[sp]); }
        case 9: { sp = sp - 1u; stack[sp - 1u] = select(0.0, 1.0, stack[sp - 1u] < stack[sp]); }
        case 10: { sp = sp - 1u; stack[sp - 1u] = select(0.0, 1.0, stack[sp - 1u] <= stack[sp]); }
        case 11: { sp = sp - 1u; stack[sp - 1u] = select(0.0, 1.0, stack[sp - 1u] > stack[sp]); }
        case 12: { sp = sp - 1u; stack[sp - 1u] = select(0.0, 1.0, stack[sp - 1u] >= stack[sp]); }
        case 13: { sp = sp - 1u; stack[sp - 1u] = select(0.0, 1.0, stack[sp - 1u] == stack[sp]); }
        case 14: { sp = sp - 1u; outCells[base + u32(arg)] = stack[sp]; }
        default: {}
      }
    }
  }
}
`;
}

/** The number of distinct override slots the shader's override table carries — the union of the batch's sample
 *  coordinates. Built by {@link overrideTable}; recomputed here for the shader constant so the two never drift. */
function countOverrides(program: CompiledProgram): number {
  return program.overrideSlotOf.size;
}

/** Build the dense override table for the batch: `slots[j]` = the cell index of the j-th ranged input; `vals` is
 *  row-major `[scenario][j]` — a scenario's drawn value for that input, or the base value where a scenario omits
 *  it (a no-op substitution). The slot ORDER is the program's `overrideSlotOf` iteration order, identical to the
 *  fp32 executor's, so the two backends apply overrides the same way. */
function overrideTable(program: CompiledProgram, scenarios: readonly { readonly overrides: Readonly<Record<string, number>> }[]): { slots: Int32Array; vals: Float32Array } {
  const entries = [...program.overrideSlotOf.entries()]; // [ "node|key", cellIndex ]
  const k = entries.length;
  const slots = new Int32Array(Math.max(1, k));
  for (let j = 0; j < k; j++) slots[j] = entries[j]![1];
  const vals = new Float32Array(Math.max(1, k) * scenarios.length);
  for (let s = 0; s < scenarios.length; s++) {
    const ov = scenarios[s]!.overrides;
    for (let j = 0; j < k; j++) {
      const [key, slot] = entries[j]!;
      const v = ov[key];
      vals[s * k + j] = v !== undefined ? v : program.baseCells[slot]!;
    }
  }
  return { slots, vals };
}

/**
 * Run the compiled program over the batch on a real WebGPU device, returning one full cell array per scenario (the
 * same shape {@link runProgramFp32} returns, so the shared Evaluation builder consumes either). THROWS on any
 * device error (validation / OOM / device loss) so the caller falls back to the CPU reference — a GPU failure is an
 * honesty state (did-not-converge), never a silent wrong answer. Best-effort cancellation: an aborted signal
 * skips readback and returns `null` (the caller discards the run), per the contract's Cancellable semantics.
 */
export async function runProgramOnGpu(
  device: GpuDevice,
  program: CompiledProgram,
  scenarios: readonly { readonly overrides: Readonly<Record<string, number>> }[],
  signal?: AbortSignal,
): Promise<Float32Array[] | null> {
  if (signal?.aborted) return null;
  const n = scenarios.length;
  const { nCells, code, consts, baseCells } = program;
  const { slots, vals } = overrideTable(program, scenarios);
  const outSize = pad4(n * nCells * 4);

  const buffers: GpuBuffer[] = [];
  const store = (data: ArrayBufferView, usage: number): GpuBuffer => {
    const buf = device.createBuffer({ size: pad4(data.byteLength), usage: usage | USAGE_COPY_DST });
    device.queue.writeBuffer(buf, 0, data);
    buffers.push(buf);
    return buf;
  };
  // Error scopes catch WebGPU's ASYNC validation/OOM errors (they never throw synchronously); a `scopes` counter
  // keeps them balanced across the success and the failure path so a reused device is never left with an open scope.
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
    const codeBuf = store(code, USAGE_STORAGE);
    const constBuf = store(consts.length > 0 ? consts : new Float32Array(1), USAGE_STORAGE);
    const baseBuf = store(baseCells, USAGE_STORAGE);
    const slotBuf = store(slots, USAGE_STORAGE);
    const valBuf = store(vals, USAGE_STORAGE);
    const outBuf = device.createBuffer({ size: outSize, usage: USAGE_STORAGE | USAGE_COPY_SRC });
    buffers.push(outBuf);
    const paramsBuf = device.createBuffer({ size: 16, usage: USAGE_UNIFORM | USAGE_COPY_DST });
    device.queue.writeBuffer(paramsBuf, 0, new Uint32Array([n, 0, 0, 0]));
    buffers.push(paramsBuf);

    const module = device.createShaderModule({ code: generateWgsl(program) });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: codeBuf } },
        { binding: 1, resource: { buffer: constBuf } },
        { binding: 2, resource: { buffer: baseBuf } },
        { binding: 3, resource: { buffer: slotBuf } },
        { binding: 4, resource: { buffer: valBuf } },
        { binding: 5, resource: { buffer: outBuf } },
        { binding: 6, resource: { buffer: paramsBuf } },
      ],
    });

    const staging = device.createBuffer({ size: outSize, usage: USAGE_COPY_DST | USAGE_MAP_READ });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(n / WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(outBuf, 0, staging, 0, outSize);
    device.queue.submit([encoder.finish()]);

    await staging.mapAsync(MAP_MODE_READ);
    if (signal?.aborted) {
      staging.unmap();
      staging.destroy();
      return null;
    }
    const flat = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();

    const out: Float32Array[] = [];
    for (let s = 0; s < n; s++) out.push(flat.slice(s * nCells, (s + 1) * nCells));

    scopes -= 2;
    const oom = await device.popErrorScope();
    const validation = await device.popErrorScope();
    if (validation !== null) throw new Error(`WebGPU validation error: ${validation.message}`);
    if (oom !== null) throw new Error(`WebGPU out-of-memory: ${oom.message}`);
    return out;
  } catch (e) {
    await drainScopes(); // keep the scope stack balanced on the failure path so a reused device stays valid
    throw e;
  } finally {
    for (const b of buffers) b.destroy();
  }
}

export type { GpuDevice };
