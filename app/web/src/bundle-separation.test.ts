import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

// BUNDLE-SEPARATION LINT (docs/design/solver-contract.html §6, migration step 6). The prize of is
// dropping the ~17.8 MB MiniZinc WASM from the RUNTIME bundle once the domain solver ships. That stays possible
// only if no runtime entry STATICALLY imports a WASM-solver loader — every such import must be dynamic, so the
// heavy chunk is fetched on first solve and can be excluded later. This test walks the web source and fails if
// any module (other than the designated composition root) reaches a solver loader with a static import.
//
// There is no dependency-cruiser in this repo; the codebase's convention is to assert architecture invariants
// as tests. This is that test for the browser shell.

const here = dirname(fileURLToPath(import.meta.url));

// The modules that pull in (or transitively load) a WASM solver. Reaching any of them statically would pin the
// solver into the entry bundle's graph — exactly what phase 3 must be able to drop.
const SOLVER_LOADERS = ['./mzn', './clingo', '@sda/solver-contract/incumbent'];

// The ONE module allowed to reach the loaders — and even it does so only via dynamic import(). This is the
// composition root, the single binding site (docs §5).
const ALLOWED = 'composition.ts';

function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allSourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) out.push(full);
  }
  return out;
}

/** A STATIC import of `spec` — `import … from 'spec'` or `export … from 'spec'`, but NOT `import('spec')`. */
function staticallyImports(text: string, spec: string): boolean {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `from 'spec'` not preceded by an `import(` call — the dynamic form is `import('spec')`, which has no `from`.
  const staticRe = new RegExp(`(?:^|\\n)\\s*(?:import|export)\\s[^;\\n]*?\\sfrom\\s+['"]${escaped}['"]`);
  return staticRe.test(text);
}

describe('bundle separation — the WASM solvers stay behind dynamic imports', () => {
  const files = allSourceFiles(here).map((f) => ({ rel: relative(here, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8') }));

  it('no runtime module statically imports a WASM-solver loader (only dynamic import() is allowed)', () => {
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      if (rel === ALLOWED) continue; // the composition root is the designated boundary
      for (const loader of SOLVER_LOADERS) {
        if (staticallyImports(text, loader)) offenders.push(`${rel} statically imports ${loader}`);
      }
    }
    expect(offenders, `WASM-solver loaders must be reached only via dynamic import():\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the composition root itself reaches the loaders only via dynamic import()', () => {
    const root = files.find((f) => f.rel === ALLOWED);
    expect(root, 'composition.ts must exist as the single binding site').toBeDefined();
    if (!root) return;
    for (const loader of SOLVER_LOADERS) {
      expect(staticallyImports(root.text, loader), `composition.ts must NOT statically import ${loader}`).toBe(false);
    }
    // It DOES reference them dynamically — proving the loaders are still reachable, just lazily.
    for (const loader of SOLVER_LOADERS) {
      expect(root.text.includes(`import('${loader}')`), `composition.ts should dynamically import ${loader}`).toBe(true);
    }
  });
});

// the WebGPU EvaluateBatch backend (@sda/solver-contract/gpu — WGSL driver + the cell-network compiler)
// must also stay behind dynamic import(). Its designated reacher is the AMBIENT UNCERTAINTY WORKER
// (uncertainty-worker.ts), a lazily-spawned separate bundle — so the WebGPU driver never lands in the entry
// bundle's static graph, and it loads only on the first ambient run. This extends the bundle-separation discipline
// to the gpu module, as the task requires.
const LAZY_MODULES = ['@sda/solver-contract/gpu'];

describe('bundle separation — the WebGPU batch backend is lazily imported (never in the entry bundle)', () => {
  const files = allSourceFiles(here).map((f) => ({ rel: relative(here, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8') }));

  it('no module statically imports the gpu backend (it is reached only via dynamic import())', () => {
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      for (const m of LAZY_MODULES) {
        if (staticallyImports(text, m)) offenders.push(`${rel} statically imports ${m}`);
      }
    }
    expect(offenders, `the WebGPU backend must be reached only via dynamic import():\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the gpu backend IS dynamically imported by the ambient uncertainty worker (still reachable, just lazily)', () => {
    for (const m of LAZY_MODULES) {
      const reachers = files.filter((f) => f.text.includes(`import('${m}')`));
      expect(reachers.length, `${m} must be dynamically imported by at least one module (the uncertainty worker)`).toBeGreaterThan(0);
    }
  });
});
