import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

// BUNDLE-SEPARATION LINT for the layout GPU proposer (doc: ideal-layout §3.3; TASK-88 R3), mirroring the web
// shell's own lint (app/web/src/bundle-separation.test.ts) and the TASK-81 discipline. The WebGPU driver
// (layout-gpu/webgpu.ts) must be reached ONLY via dynamic import(), so it never lands in a shell's entry bundle
// static graph — the presenter is imported by both shells, so a static edge to the driver would pin it everywhere.
// The designated reacher is layout-gpu/index.ts (its `probeLayoutGpu` dynamically imports the driver); the presenter
// index reaches the whole subtree only via `loadLayoutGpu()`'s dynamic import. There is no dependency-cruiser here —
// the convention is to assert architecture invariants as tests.

const presenterSrc = dirname(dirname(fileURLToPath(import.meta.url))); // app/presenter/src

function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allSourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) out.push(full);
  }
  return out;
}

/** A STATIC import of `spec` — `import … from 'spec'` / `export … from 'spec'`, but NOT `import('spec')`. */
function staticallyImports(text: string, spec: string): boolean {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const staticRe = new RegExp(`(?:^|\\n)\\s*(?:import|export)\\s[^;\\n]*?\\sfrom\\s+['"]${escaped}['"]`);
  return staticRe.test(text);
}

// The driver, as its neighbours would spell it: './webgpu' from inside layout-gpu, or the full './layout-gpu/webgpu'
// from the presenter root.
const DRIVER_SPECS = ['./webgpu', './layout-gpu/webgpu'];

describe('bundle separation — the layout WebGPU driver is reached only via dynamic import()', () => {
  const files = allSourceFiles(presenterSrc).map((f) => ({ rel: relative(presenterSrc, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8') }));

  it('no runtime presenter module STATICALLY imports the WebGPU driver', () => {
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      for (const spec of DRIVER_SPECS) {
        if (staticallyImports(text, spec)) offenders.push(`${rel} statically imports ${spec}`);
      }
    }
    expect(offenders, `the layout WebGPU driver must be reached only via dynamic import():\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the driver IS reachable — layout-gpu/index dynamically imports it (still lazy, still present)', () => {
    const index = files.find((f) => f.rel === 'layout-gpu/index.ts');
    expect(index, 'layout-gpu/index.ts must exist as the driver reacher').toBeDefined();
    expect(index!.text.includes(`import('./webgpu')`), 'layout-gpu/index.ts should dynamically import ./webgpu').toBe(true);
  });

  it('the presenter index reaches the gpu subtree only via a dynamic import (loadLayoutGpu)', () => {
    const index = files.find((f) => f.rel === 'index.ts');
    expect(index).toBeDefined();
    // A type-only re-export is erased; the only runtime edge is the dynamic import inside loadLayoutGpu.
    expect(staticallyImports(index!.text.replace(/export type \{[^}]*\} from '\.\/layout-gpu\/index';/g, ''), './layout-gpu/index')).toBe(false);
    expect(index!.text.includes(`import('./layout-gpu/index')`)).toBe(true);
  });
});
