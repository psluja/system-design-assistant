// MOVED to @sda/presenter (the shared view-model layer) so every shell labels a metric/knob/family identically.
// This stub re-exports the presenter's copy so every existing `./meta` import in app/web AND the `@web/meta`
// alias consumer (the vscode webview) keeps compiling unchanged. Prefer importing from '@sda/presenter' directly.
export { keyInfo, KEY_INFO, KIND_DESC, type KeyInfo } from '@sda/presenter';
