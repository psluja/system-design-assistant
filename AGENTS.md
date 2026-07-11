# Agent guide

A concise orientation for AI agents (and humans) working in this repository. Read this first, then
follow the same rules a human contributor does — see [CONTRIBUTING](.github/CONTRIBUTING.md).

## What this is

System Design Assistant (SDA) is a **fully client-side** tool that _computes_ a system architecture,
not just draws it: drag building blocks onto a canvas, connect them, and a real engine evaluates
capacity, queueing-aware latency, tail percentiles, availability, delivery guarantees and cost — and,
run backwards, sizes the design to meet every SLO. There is no backend.

## Setup and commands

```bash
pnpm install
pnpm dev                # web app on http://localhost:5173
pnpm build              # production web build
pnpm -r typecheck       # strict TypeScript across every package
pnpm test               # the full Vitest suite
```

Node 20, pnpm workspaces. The solvers ship as prebuilt WebAssembly — you never compile Rust/C++ here.

## Repository map

```
engine/      domain-agnostic core: typed-property graph, relation language, fixpoint solver,
             cell network, MiniZinc / DataScript / clingo adapters, discrete-event simulator
content/     ALL system-design meaning, as DATA: property registry, component manifests,
             protocol vocabulary, projectors
app/
  core/      the Studio command core (undo/redo, persistence, custom components)
  presenter/ shared view-models — both shells render these verbatim
  web/       the browser shell (React + React Flow canvas)
  vscode/    the VS Code shell (custom editor + native views)
  mcp/       MCP tools (design, evaluate, simulate, optimize, synthesize) for AI agents
  bridge/    a local MCP↔WebSocket relay so an AI can drive the LIVE canvas
```

## Hard invariants (do not violate)

- **The tool must not lie.** Every number is sourced or marked `unknown`; uncertainty is a value,
  never a guess. Where solvers overlap, they are differential-tested against each other.
- **The engine is domain-agnostic.** It computes over a typed-property graph and knows nothing about
  clouds. `grep` the engine for `aws` / `lambda` / `dynamodb` ⇒ zero. All cloud meaning is content
  (data), and a guard test keeps it that way.
- **No required backend.** Fully client-side; every solver is consumed as prebuilt WASM or pure TS.
  Optional local adapters (engine-as-MCP, the bridge) are plain Node, never a required server.
- **Closed framework, open content.** Only content extends the tool (components + registry keys, as
  data). The engine is closed for modification — if something isn't expressible, evolve the
  meta-model, never add a per-case branch.
- **TypeScript everywhere**, strict. Make illegal states unrepresentable in types, not just at runtime.

## Conventions

- **English only** in code, comments and docs.
- Every change lands **with tests** (property / differential / golden as appropriate).
- Components are pure JSON data (`config / bands / relations / ports`); they reference a shared
  vocabulary by id, never each other.
- The engine and projectors are pure and deterministic.
