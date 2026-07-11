// Ambient declaration for Vite's `?raw` import suffix (a module imported with `?raw` resolves to its file
// contents as a string). The web build already gets this from `vite/client`, but the VS Code webview's tsconfig
// compiles these same `app/web/src` files WITHOUT `vite/client` in its `types`, so it needs the declaration too.
// Kept identical in shape to vite/client's own so the two never conflict where both apply. WHY here (not in a
// per-shell config): a shared source file (app.tsx) uses `?raw`, so its type must travel with the source.
declare module '*?raw' {
  const content: string;
  export default content;
}
