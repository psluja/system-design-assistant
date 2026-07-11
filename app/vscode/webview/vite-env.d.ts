/** Vite's `?worker&url` import: resolves to the URL of the EMITTED worker chunk (a string). Declared here
 *  because the webview tsconfig does not pull in `vite/client` types (it also compiles the aliased app/web
 *  sources, which carry their own ambient decls). */
declare module '*?worker&url' {
  const url: string;
  export default url;
}
