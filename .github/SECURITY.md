# Security Policy

## Supported versions

This project is **pre-release** (pre-1.0). There are no released, separately maintained versions yet.
Only the `main` branch is supported: fixes land on `main`, and that is the code we ask you to report
against.

| Version | Supported          |
| ------- | ------------------ |
| `main`  | :white_check_mark: |
| other   | :x:                |

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

- Once this repository is public on GitHub, use **GitHub Private Vulnerability Reporting** (the
  repository's *Security* tab → *Report a vulnerability*). This keeps the report private until a fix
  is available.
- Until then, contact the maintainer privately at **[maintainer contact — set on publication]**.

Please include enough detail to reproduce: what the issue is, the affected component (web app, VS Code
extension, the MCP/bridge local servers, or the export/file format), and a minimal reproduction where
possible.

## Threat model and scope

System Design Assistant is a **fully client-side** application. It runs in the browser (or inside the
VS Code extension host) and has **no required backend server**; state is stored locally and every
solver is consumed as prebuilt WebAssembly. This shapes what is and is not in scope.

The interesting surface, roughly in priority order:

- **The design file format** (`.sda.json` / the versioned export). It is parsed and evaluated by the
  engine. Malformed or hostile input must be handled safely — it must never lead to code execution or
  a crash that loses a user's work. The format is the artifact users truly own, so its integrity
  matters.
- **The optional local servers** — the MCP server (`@sda/mcp`) and the AI bridge (`@sda/bridge`).
  These are **optional, local, no-egress** processes a user starts deliberately (for example to let an
  external AI drive the live canvas). They are pure relays over the command core with no domain logic
  and no outbound network calls, but they do bind local ports, so their trust boundary is in scope.
- **Supply chain.** The project depends on prebuilt WASM solvers and npm packages. Dependency and
  build-chain integrity (lockfile, Dependabot, CI) is part of the security posture.

Explicitly **out of scope** because they do not exist in this architecture: server-side
authentication/authorization, multi-tenant data isolation, and any cloud-hosted backend. There is no
server to attack; the app the user runs is the app they built.

## Response expectations

This is a pre-1.0, best-effort project. We will acknowledge a valid report and work a fix as quickly
as we reasonably can, but we cannot commit to fixed SLAs before 1.0. We will credit reporters who wish
to be credited once a fix is public. Thank you for reporting responsibly.
