# syntax=docker/dockerfile:1
#
# Reproducible build of the MiniZinc -> WebAssembly bundle WITH the HiGHS MIP backend
# (plus Gecode, Chuffed and COIN-BC). The output is vendored into app/web/public/minizinc/ and powers
# @sda/web's EXACT in-browser backward-search (optimize / repair), which needs a MIP/LP solver.
#
# Why this exists: the published `minizinc` npm WASM ships only Gecode + Chuffed (no MIP solver), but
# SDA's "run the design backwards" minimizes over continuous variables -> needs HiGHS/COIN-BC. MiniZinc's
# own build supports HiGHS, so we build it and commit the prebuilt artifact alongside this recipe, so an
# open-source repo carries no mystery binary: the 17 MB wasm is fully reproducible from here.
#
# Verified solvers in the result (browser `MiniZinc.solvers()`):
#   org.minizinc.mip.highs, org.minizinc.mip.coin-bc, org.minizinc.gecode_presolver, org.minizinc.chuffed
# Component versions (built 2026-06-29): MiniZinc 2.9.7, HiGHS 1.14.0, Gecode 6.3.0, Chuffed 0.14.0.
#
# Build + vendor:   tools/minizinc-wasm/build.sh        (requires Docker; ~20-40 min)
# Runtime note:     the page must be cross-origin isolated (COOP/COEP) for the solver's worker threads.

# emscripten/emsdk pinned by digest (the image used to produce the committed artifact).
FROM emscripten/emsdk@sha256:d0be652409a4d3362b8a36c3279dd1123ff1c9327e603d86d9361aa84f1d2e4c

# Exact upstream commits that produced the committed artifact. Override --build-arg to update.
ARG LIBMINIZINC_SHA=d028bc222040f6aa138697c57dcd00c1e6fd4be1
ARG MINIZINC_JS_SHA=bec028d65d611aff5163574b3f0c60edc7319351

RUN apt-get update -qq && apt-get install -y -qq git curl unzip ca-certificates && rm -rf /var/lib/apt/lists/*

# --- libminizinc -> wasm, with the vendor solvers (gecode + chuffed + coin-bc + HiGHS) ---
WORKDIR /build
RUN mkdir libminizinc && cd libminizinc \
 && git init -q && git remote add origin https://github.com/MiniZinc/libminizinc.git \
 && git fetch --depth 1 -q origin "${LIBMINIZINC_SHA}" && git checkout -q FETCH_HEAD
WORKDIR /build/libminizinc
RUN MZNARCH=wasm ./download_vendor
RUN emcmake cmake -S . -B build \
      -DCMAKE_FIND_ROOT_PATH="/" \
      -DCMAKE_BUILD_TYPE=Release \
      -DGecode_ROOT="/build/libminizinc/vendor/gecode" \
      -DOsiCBC_ROOT="/build/libminizinc/vendor/cbc" \
      -DCMAKE_PREFIX_PATH="/build/libminizinc/vendor/highs/lib/cmake/highs;/build/libminizinc/vendor/chuffed/lib/cmake/chuffed" \
      -DCMAKE_INSTALL_PREFIX="/build/libminizinc/minizinc" \
 && cmake --build build --config Release --target install -j2

# --- package the wasm + worker + data via minizinc-js ---
WORKDIR /build
RUN mkdir minizinc-js && cd minizinc-js \
 && git init -q && git remote add origin https://github.com/MiniZinc/minizinc-js.git \
 && git fetch --depth 1 -q origin "${MINIZINC_JS_SHA}" && git checkout -q FETCH_HEAD
WORKDIR /build/minizinc-js
RUN npm install --no-audit --no-fund
RUN MZN_WASM_DIR=/build/libminizinc/minizinc npm run build \
 && mkdir -p /out \
 && cp dist/minizinc.mjs dist/minizinc-worker.js dist/minizinc.wasm dist/minizinc.data /out/

# Artifacts are at /out — extracted by build.sh via `docker create` + `docker cp`.
