# MiniZinc + HiGHS → WebAssembly (vendored solver bundle)

This directory reproducibly builds the **MiniZinc WebAssembly bundle with the HiGHS MIP backend** that
ships in `app/web/public/minizinc/`. It is the solver behind SDA's **exact, in-browser backward search**
(`Auto-fix` / optimize / repair).

## Why a custom build?

The engine projects "run the design backwards" to a MiniZinc model that **minimizes over continuous
variables** — that needs a MIP/LP solver. The official [`minizinc`](https://www.npmjs.com/package/minizinc)
npm WASM bundles only **Gecode + Chuffed**:

- **Chuffed** is integer-only — it can't take the float models.
- **Gecode** handles floats for *satisfy*, but its float branch-and-bound **optimality proof does not
  terminate** on these objectives (see `engine/solve/src/minizinc/search.ts`).

MiniZinc's own build *can* include HiGHS and COIN-BC, so we build it ourselves. Rather than commit a
17 MB binary with no provenance, this folder carries the exact recipe — anyone can reproduce the blob.

## What it produces

Four files vendored into `app/web/public/minizinc/` (served verbatim; `mzn.ts` lazy-imports the `.mjs`
and the library auto-resolves its sibling worker + wasm + data):

| file | purpose |
|---|---|
| `minizinc.mjs` | browser API (`Model`, `solve`, `solvers`) |
| `minizinc-worker.js` | the solver web worker |
| `minizinc.wasm` | MiniZinc + solvers compiled to wasm (~17 MB) |
| `minizinc.data` | bundled stdlib + solver configs |

Verified solvers in the result (`await MiniZinc.solvers()` in the browser):
`org.minizinc.mip.highs`, `org.minizinc.mip.coin-bc`, `org.minizinc.gecode_presolver`,
`org.minizinc.chuffed`. SDA selects `highs` for search.

## Reproduce

Requires **Docker**. End users never need this — the artifact is committed. To regenerate/update:

```bash
./tools/minizinc-wasm/build.sh
```

It builds `Dockerfile` (emscripten/emsdk → libminizinc with `download_vendor MZNARCH=wasm` → HiGHS
enabled → packaged via minizinc-js) and copies the four files into `app/web/public/minizinc/`. Build
time is ~20-40 min (`-j2`, matching upstream CI to avoid OOM).

## Provenance (the committed artifact)

- emscripten/emsdk image: `sha256:d0be652409a4d3362b8a36c3279dd1123ff1c9327e603d86d9361aa84f1d2e4c`
- libminizinc: `d028bc222040f6aa138697c57dcd00c1e6fd4be1` (MiniZinc 2.9.7)
- minizinc-js: `bec028d65d611aff5163574b3f0c60edc7319351` (v4.4.6)
- solver versions: HiGHS 1.14.0, Gecode 6.3.0, Chuffed 0.14.0, COIN-BC (OsiCBC)
- built: 2026-06-29

All three refs are pinned in the `Dockerfile` (`--build-arg LIBMINIZINC_SHA=… MINIZINC_JS_SHA=…` to
change them).

## Runtime requirement: cross-origin isolation

The solver runs in a worker that uses `SharedArrayBuffer`, so the page **must be cross-origin isolated**
— served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`vite dev` and `vite preview` already set these (`app/web/vite.config.ts`). Any production host for the
app must send them too, or `Auto-fix` will report that the solver needs cross-origin isolation. The rest
of the app (design, forward evaluation, legality, suggester, DES) works without it.
