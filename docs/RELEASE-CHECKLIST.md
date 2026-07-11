# Release Checklist

The pre-publication gate for System Design Assistant. Part A records the mechanical items **verified
now**, each with evidence. Part B is the checklist to walk before tagging a public release. Part C
lists the open flags.

> Convention: run gates with `CI=true` (the workspace declines an interactive `node_modules` purge
> without a TTY). The whole suite must be green (baseline ≈ 2,428 tests); doc-only changes must at
> minimum keep the catalog-freshness test green.

---

## A. Verified now (mechanical items)

### A1. Export round-trip / schema back-compat — ✅ PASS

The current export schema is **version 10**; `deserialize` accepts every version 1..10 and migrates
forward, so no old export is orphaned.

- `app/core/src/document.ts` — `readonly schema: 10` (current), and the guard
  `if (d.schema !== 1 && … && d.schema !== 10) return err('unsupported schema version …')` accepts the
  full 1..10 range and returns a normalized schema-10 document.
- Migration tests (each proving an **older** export still loads):
  - `app/core/src/core.test.ts` — schema-1, -3, -4, -5, -6, -8, -9 exports migrate to the current
    schema; schema-5 uncertainty ranges round-trip lossless; the legacy port `protocol` folds into
    the accepts/speaks lists.
  - `app/core/src/document.migration.test.ts` — the demand-key rename chain (all four links), with an
    **evaluation-equivalence** assertion: a migrated file evaluates _bit-identically_ to the canonical
    form.
  - `app/core/src/demand-key-rename.guard.test.ts` — the legacy keys appear only in the migration map.
- Live confirmation: a schema-10 export (`examples/cqrs-production-large.sda.json`) imported and
  evaluated in the running web app during this pass; a schema-7 project autosaved in IndexedDB loaded
  and migrated on open.

### A2. No-egress ("no required backend / no egress") — ✅ PASS

The shipped app (engine + content + web/vscode/presenter/core/mcp) makes **no network call to any
non-local host**.

- Static scan (excluding tests):
  - `fetch(` — exactly **2** occurrences, both in `app/vscode/webview/main.tsx` (lines 109, 181), each
    loading a **local** worker chunk via `new URL(workerAssetUrl, import.meta.url)` and booting it from
    a blob (Workers are same-origin inside a `vscode-webview://` page — the comments say so). Not
    external.
  - `XMLHttpRequest` / `EventSource` / `navigator.sendBeacon` / `axios` — **zero**.
  - `WebSocket` — only the opt-in local AI bridge: `app/bridge/src/bridge.ts` (`WebSocketServer`) and
    `app/web/src/bridge.ts` (`ws://localhost:7777/agent`, connected only when the user clicks
    **Link AI**). Localhost only.
  - External `https://` literals in `content/` are AWS-documentation **citation strings** (number
    provenance) — data, never fetched.
- WASM is consumed prebuilt/local: `app/web/public/minizinc/` is committed (recipe in
  `tools/minizinc-wasm/`); `app/web/public/clingo/` is vendor-scripted from the lockfile-pinned
  `clingo-wasm` package (`app/web/scripts/vendor-solvers.mjs`).
- Live confirmation: over a full session (load + import + ideal-layout + simulate + spike-probe) the
  browser issued **194 requests, all to `localhost`** — a filter for any non-`localhost`/`127.0.0.1`
  host returned **nothing**, and there were zero non-static (XHR/fetch/WebSocket) calls.

### A3. LICENSE presence + OSS hygiene — ✅ PASS

- `LICENSE` — MIT, © 2026 Piotr Słuja and contributors.
- `THIRD_PARTY_NOTICES.md` — present; enumerates bundled solvers/libraries and their licenses.
- Root `package.json` — `"license": "MIT"`.
- `.github/` — `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `ISSUE_TEMPLATE/`,
  `PULL_REQUEST_TEMPLATE.md`, `dependabot.yml`, `workflows/ci.yml` all present.

### A4. package.json metadata sanity — ⚠️ PARTIAL (see F1)

- Present: `name`, `version` (0.0.0), `private: true`, `description`, `license: MIT`, `type: module`,
  scripts (`dev`, `build`, `preview`, `test`, `typecheck`, `catalogs`).
- **Missing** on the root manifest: `repository`, `author`, `keywords`, `homepage`, `bugs`. No git
  remote is configured. These should be filled in before publication (see F1).
- Sub-packages (`@sda/*`, `sda-vscode`) are correctly `private: true` with `license: MIT`.

### A5. Catalogs / docs freshness — ✅ PASS

`docs/FEATURES.md` (20 features) and `docs/ALGORITHMS.md` (51 algorithms) are generated from the
`@feature` / `@algorithm` headers in code and asserted fresh.

- `CI=true node node_modules/vitest/vitest.mjs run scripts/generate-catalogs.test.ts` →
  **207 tests passed**. Regenerate with `pnpm catalogs`.

### A6. Dependency license audit — ✅ PASS (no GPL/AGPL/LGPL runtime deps)

| Dependency | License | Scope |
|---|---|---|
| react, react-dom, @xyflow/react | MIT | runtime (web, vscode) |
| ws | MIT | runtime (bridge only, localhost relay) |
| @modelcontextprotocol/sdk | MIT | runtime (mcp, bridge) |
| clingo-wasm | Apache-2.0 | runtime (engine/solve) |
| datascript | **EPL-1.0** | runtime (engine/solve) |
| MiniZinc (+ Gecode MIT, HiGHS MIT) | **MPL-2.0** | vendored WASM binary (not an npm dep) |
| clingo | MIT | vendored WASM binary |
| dagre | MIT | **dev-only** — the layout benchmark's comparison engine |
| elkjs | **EPL-2.0** | **dev-only** — the layout benchmark's comparison engine |

- **No GPL / AGPL / LGPL** anywhere in the runtime graph. ✅
- The two weak-copyleft runtime/vendored components — DataScript (EPL-1.0, file-level) and MiniZinc
  (MPL-2.0, file-level) — are used unmodified and are documented in `THIRD_PARTY_NOTICES.md`.
- `minizinc` is **not** an npm dependency; it is a vendored binary with its recipe in
  `tools/minizinc-wasm/`.

---

## B. Before tagging a public release

- [ ] Fill in root `package.json` metadata: `repository`, `author`, `keywords`, `homepage`, `bugs`
      (F1); add the git remote.
- [ ] Bump versions off `0.0.0` and tag; confirm the VS Code extension version
      (`app/vscode/package.json`, currently 0.0.43) and its packaged `.vsix` name.
- [ ] Replace the `<this-repo>` placeholder in the README quickstart with the real clone URL.
- [ ] Run the full gate green: `CI=true pnpm -r typecheck` and `CI=true pnpm test`
      (baseline ≈ 2,428 tests).
- [ ] `pnpm build` (web) and `pnpm --filter sda-vscode run package` (vsix) both succeed clean.
- [ ] `pnpm catalogs` produces no diff (catalogs fresh); design docs under `docs/design/` current.
- [ ] Re-run the no-egress scan (A2) on the built `app/web/dist` and `app/vscode/dist/webview`
      bundles, not just source.
- [ ] Confirm `THIRD_PARTY_NOTICES.md` still matches the installed dependency set (regenerate the
      dependency list; verify no new copyleft entered the runtime graph).
- [ ] Screenshots in `docs/assets/` regenerated from the current app (never mocked).
- [ ] Decide on and remove the committed dev logs at repo root (`night-harvest*.log`) if not intended
      for publication.

---

## C. Open flags

- **F1 — Root `package.json` metadata incomplete.** Missing `repository`, `author`, `keywords`,
  `homepage`, `bugs`; no git remote configured. Expected pre-publication; fill in before tagging.
- **F2 — RESOLVED (initial flag was wrong).** `dagre` (MIT) and `elkjs` (EPL-2.0) are NOT unused: the
  layout benchmark (`app/presenter/src/layout-benchmark.test.ts`, dynamic imports under
  `RUN_LAYOUT_BENCH=1`) lays out every example with dagre, ELK and SDA-ideal through the same router
  and objective — the measured evidence that the ideal layout beats the industry. They are legitimate
  test-only devDeps (never bundled, correctly absent from the runtime notices). KEEP.
- **F3 — Root dev logs committed to the working tree.** `night-harvest.log` and `night-harvest2.log`
  (~4.9 MB) sit at repo root. `*.log` is gitignored, so they are not tracked — confirm they are not
  force-added before publication.
