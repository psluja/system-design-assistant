#!/usr/bin/env bash
#
# Build the MiniZinc+HiGHS WebAssembly bundle in Docker and vendor it into app/web/public/minizinc/.
#
# End users do NOT need to run this — the artifact is committed to the repo. Run it only to regenerate
# or update the solver bundle (e.g. to bump MiniZinc/HiGHS). Requires Docker. Takes ~20-40 minutes.
#
#   ./tools/minizinc-wasm/build.sh
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$here/../../app/web/public/minizinc"

echo "==> Building sda-minizinc-wasm (this compiles libminizinc to wasm with HiGHS; be patient)…"
docker build -t sda-minizinc-wasm "$here"

echo "==> Extracting artifacts…"
cid="$(docker create sda-minizinc-wasm)"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
mkdir -p "$out"
for f in minizinc.mjs minizinc-worker.js minizinc.wasm minizinc.data; do
  docker cp "$cid:/out/$f" "$out/$f"
done

echo "==> Vendored into $out:"
ls -la "$out"
echo "Done. Commit the updated files in app/web/public/minizinc/."
