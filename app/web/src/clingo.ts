import { answerSets, type ClingoResult, type RunAsp } from '@sda/engine-solve/asp';

// In-browser clingo (ASP) for topology ENUMERATION / synthesis — the one solver that GENERATES
// candidate designs rather than checking one. Vendored under public/clingo as the prebuilt web + worker
// build. Loaded as a CLASSIC <script> (NOT an ESM import): clingo's UMD bundle reads its own <script src> to
// set webpack's publicPath, so its sibling WORKER resolves next to it. The wasm, however, is fetched from
// inside a BLOB worker where that publicPath does not apply — so we hand it the explicit url via init()
// (without it the worker fetches the SPA fallback HTML and WebAssembly.instantiate fails on the magic word).
// Mirrors solveMzn in mzn.ts: the engine never bundles a solver — the app injects it. Lazy: the wasm loads
// on the first enumeration only.

interface ClingoWeb {
  run(program: string, models: number): Promise<ClingoResult>;
  init(wasmUrl: string): Promise<void>;
}

let readyP: Promise<ClingoWeb> | undefined;
function loadClingo(): Promise<ClingoWeb> {
  readyP ??= new Promise<ClingoWeb>((resolve, reject) => {
    const base = new URL('clingo/', document.baseURI); // resolve relative to the page ⇒ base-path agnostic
    const s = document.createElement('script');
    s.src = new URL('clingo.web.js', base).href;
    s.async = true;
    s.onload = (): void => {
      const g = (window as unknown as { clingo?: ClingoWeb & { default?: unknown } }).clingo;
      if (g === undefined || typeof g.run !== 'function' || typeof g.init !== 'function') {
        reject(new Error(`clingo.web.js loaded but window.clingo.{run,init} is missing (keys: ${Object.keys(g ?? {}).join(',')})`));
        return;
      }
      // Point the worker at the SIBLING wasm explicitly; idempotent, runs once (this promise is memoised).
      g.init(new URL('clingo.wasm', base).href).then(() => resolve(g)).catch(reject);
    };
    s.onerror = (): void => reject(new Error(`failed to load ${s.src}`));
    document.head.appendChild(s);
  });
  return readyP;
}

/** The injected browser ASP runner — mirror of node's `answerSets(await run(...))`, composed with the same
 *  result parser so every surface shares one format. The wasm loads lazily on the first enumeration. */
export const runAsp: RunAsp = async (program, models) => answerSets(await (await loadClingo()).run(program, models));
