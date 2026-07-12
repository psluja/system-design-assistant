// MOVED to @sda/presenter (the shared view-model layer) so both shells format numbers identically. This stub
// re-exports the presenter's formatters so every existing `./format` import in app/web AND the `@web/format`
// alias consumer (the vscode webview) keeps compiling unchanged. Prefer importing from '@sda/presenter' directly.
export { fmt, formatMs, formatMsDigits, plural, opnd, rate, prettyExpr } from '@sda/presenter';
