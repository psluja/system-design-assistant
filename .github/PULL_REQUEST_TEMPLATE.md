<!--
Thanks for contributing! Please fill in the summary and tick the checklist below.
See .github/CONTRIBUTING.md for the full quality bar.
-->

## Summary

<!-- What does this change do, and why? -->

## Linked task / issue

<!-- e.g. Closes #123, or TASK-NN -->

## Checklist

- [ ] Tests added or updated (a bug fix includes a test that failed before the fix).
- [ ] `pnpm -r typecheck` is green.
- [ ] The affected package test suites pass locally (full suite needs native MiniZinc — see
      CONTRIBUTING).
- [ ] Invariants respected:
  - [ ] The **engine stays domain-agnostic** — no domain strings (`aws`, `lambda`, `latency`, …)
        added to engine code; new system/infra meaning went into **content** as data.
  - [ ] **No invented numbers** — any modeled value is sourced or left `unknown`/`did-not-converge`.
  - [ ] Components remain **pure data** (no code, no component-to-component references).
- [ ] **AI assistance disclosed** if substantial (a `Co-Authored-By` trailer and/or a note here).

## Notes for the reviewer

<!-- Anything you want a reviewer to look at first, trade-offs you made, follow-ups, etc. -->
