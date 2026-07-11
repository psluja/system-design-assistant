// MOVED to @sda/presenter (the shared view-model layer) so both shells offer the SAME "what fits" suggestions.
// This stub re-exports the presenter's suggester so every existing `./suggest` import in app/web AND the
// `@web/suggest` alias consumer (the vscode webview) keeps compiling unchanged, including the suggest.test.ts here.
// Prefer importing from '@sda/presenter' directly.
export { buildCandidates, suggestFor, matchingPort, type Suggestion } from '@sda/presenter';
