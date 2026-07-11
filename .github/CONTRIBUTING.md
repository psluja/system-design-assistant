# Contributing to System Design Assistant

Thank you for considering a contribution. This document explains how to set up the repo, how to run
the checks, and — most importantly — the quality bar every change is held to. That bar is not
negotiable: it is what makes the tool trustworthy. Please read it before opening a pull request.

## Table of contents

- [Development setup](#development-setup)
- [Running the checks](#running-the-checks)
  - [The native-MiniZinc caveat](#the-native-minizinc-caveat)
- [The quality bar (contribution rules)](#the-quality-bar-contribution-rules)
- [Commit conventions](#commit-conventions)
- [AI-assisted contributions](#ai-assisted-contributions)
- [Opening a pull request](#opening-a-pull-request)

## Development setup

Prerequisites:

- **Node.js >= 20**
- **pnpm 11** (the repo pins pnpm via the lockfile format; use `corepack enable` or install pnpm 11
  directly)

```sh
git clone <your-fork-url>
cd SystemDesignAssistant
pnpm install
```

Run the web app locally:

```sh
pnpm --filter @sda/web dev
```

The app is fully client-side — there is no backend to start. State lives in the browser (IndexedDB),
and the versioned export file is the real backup.

There is also a VS Code extension (`app/vscode`, package name `sda-vscode`) that provides a custom
editor for `.sda.json` files. To build it:

```sh
pnpm --filter sda-vscode run build
```

## Running the checks

Type-check every package (strict TypeScript, no emit):

```sh
pnpm -r typecheck
```

Run a package's test suite (Vitest). Not every package declares a `test` script, so the reliable
form is to invoke Vitest through the package directly:

```sh
pnpm --filter @sda/engine-core exec vitest run
pnpm --filter @sda/engine-solve exec vitest run
pnpm --filter @sda/engine-sim  exec vitest run
pnpm --filter @sda/content     exec vitest run
pnpm --filter @sda/core        exec vitest run
pnpm --filter @sda/presenter   exec vitest run
pnpm --filter @sda/mcp         exec vitest run
pnpm --filter @sda/bridge      exec vitest run
pnpm --filter @sda/web         exec vitest run
pnpm --filter sda-vscode       exec vitest run
```

Build the shippable artifacts:

```sh
pnpm --filter @sda/web build
pnpm --filter sda-vscode run build
```

> Note: `pnpm -r --if-present test` only runs the two packages that happen to declare a `test`
> script. To run the whole suite, use the explicit per-package `exec vitest run` invocations above
> (this is exactly what CI does).

### The native-MiniZinc caveat

Several test suites are **differential tests**: they run the JavaScript hot path and the native
[MiniZinc](https://www.minizinc.org/) solver on the same problem and assert they agree. That
agreement is a core invariant — a disagreement would mean the tool lies, so these tests exist
precisely to catch it. The optimize/repair/search tests likewise shell out to MiniZinc's COIN-BC
(MIP) solver, which is the proven-optimal path the in-browser WASM bundle does not carry.

These tests invoke the `minizinc` binary via `execFileSync` (honouring the `MINIZINC` environment
variable if set, otherwise `minizinc` on `PATH`). **They do not skip when the binary is absent — they
fail with `ENOENT`.** So to run the full suite locally you must have MiniZinc installed and on
`PATH` (or point `MINIZINC` at it).

The affected suites live in three packages:

- `@sda/engine-solve` — `src/minizinc/*.test.ts`, `src/facade.test.ts`
- `@sda/content` — `src/optimize.e2e.test.ts`
- `@sda/mcp` — the backward-search and synthesis tests (`search*.test.ts`, `synthesize.test.ts`,
  `compare-options.test.ts`, `ai-flow.test.ts`, and the CQRS e2e suites)

Install MiniZinc from <https://www.minizinc.org/software.html> (the bundled distribution includes
Gecode, Chuffed, and COIN-BC). CI installs the same distribution so the full suite runs there too —
see `.github/workflows/ci.yml`.

If you are contributing only to a part of the codebase that does not touch numeric solving, you can
run the MiniZinc-free packages (`@sda/engine-core`, `@sda/engine-sim`, `@sda/core`,
`@sda/presenter`, `@sda/bridge`, `@sda/web`, `sda-vscode`) without installing MiniZinc — but your PR
must still pass the full CI run.

## The quality bar (contribution rules)

This project holds itself to a small set of invariants. They are quoted from the project's own design
charter (`CLAUDE.md`) and are enforced in review. A change that breaks one of them will not be
merged, however useful it otherwise is.

1. **The engine is domain-agnostic.** The engine computes, simulates, and solves over a typed-property
   graph and knows **nothing** about system design. `grep` the engine for domain strings such as
   `aws`, `lambda`, `iam`, or `latency` and the result must stay **zero**. All cloud/system meaning is
   **content**, never engine code.

2. **Components are pure DATA.** Building blocks are JSON (`config` / `bands` / `relations` / `ports`).
   No code in a component; it references a shared vocabulary **by id** (registry keys, protocol ids)
   and **never** references another component. If something is not expressible, the meta-model evolves
   — never a per-case branch. The framework is closed for modification; only content extends it.

3. **The tool must not lie.** Never invent infrastructure numbers. Source them or mark them `unknown`.
   Uncertainty is a **value** (`unknown` / `did-not-converge`), never a guess. Where solvers overlap,
   they are differential-tested to agree — do not weaken or delete those tests to make a change pass.

4. **Every change lands with tests.** New behaviour comes with new or updated tests; a bug fix comes
   with a test that fails before the fix and passes after. Property and differential tests are part of
   the product's credibility, not optional extras.

5. **Strict TypeScript, illegal states unrepresentable.** `pnpm -r typecheck` must stay green.
   Prefer making invalid states impossible in the types over checking for them at runtime.

6. **Client-side only.** No required backend. Every solver is consumed as **prebuilt WASM** — nothing
   Rust/C++ is compiled in this repo. Persistence is browser-only; the export file is the backup.

If a change requires bending one of these rules, that is a design conversation to have in an issue
**first**, not a fait accompli in a pull request.

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org/). Look at `git log` for the house
style; the shape is:

```
type(scope): short imperative summary (TASK-NN)
```

Common types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`. The scope is the package or area
(`engine`, `web`, `vscode`, `content`, `presenter`, `oss`, …). Reference the task or issue in the
summary or body where one exists.

## AI-assisted contributions

AI-assisted work is **welcome**. This repository is itself built with AI pair-engineering and records
it openly via `Co-Authored-By` trailers on its commits. We have no interest in policing which tools you
use to think or type.

What we do require:

- **You remain fully accountable for what you submit.** You are the author of the pull request. "The
  AI wrote it" is not a defense for a bug, a licensing problem, an invented number, or a broken
  invariant.
- **Disclose substantial AI assistance in the PR.** A `Co-Authored-By` trailer and/or a line in the PR
  description is enough. We care about honesty, not ceremony — small autocompletions do not need a
  disclosure; a feature largely drafted by an agent does.
- **AI output meets the same bar as any other code.** Tests, honesty (no invented infra numbers,
  `unknown` is a value), the domain-agnostic engine, strict types — all of it applies unchanged.
- **Reviewers judge the diff, not its author.** Human-written and AI-assisted contributions are held
  to exactly the same standard and reviewed the same way.

## Opening a pull request

Before you open a PR:

- Add or update tests for your change.
- Run `pnpm -r typecheck` — it must be green.
- Run the affected package test suites (and the full suite if you can — CI will run all of it).
- Confirm the invariants above still hold (in particular: the engine has no domain strings, and no
  value is invented).
- Disclose substantial AI assistance.

The pull-request template will walk you through this checklist. Thank you for keeping the bar high.
