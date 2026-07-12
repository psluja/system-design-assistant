// MOVED to @sda/presenter (the shared view-model layer) so every shell tidies a diagram identically. This stub
// re-exports the presenter's tidyLayout so every existing `./layout` import in app/web AND the `@web/layout`
// alias consumer (the vscode webview) keeps compiling unchanged. Prefer importing from '@sda/presenter' directly.
export { tidyLayout, type Pos, type Rect, type Size } from '@sda/presenter';
