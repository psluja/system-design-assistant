import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds the WEBVIEW bundle (the canvas UI) into dist/webview/. Single-file-ish output (one js + one css)
// because a VS Code webview loads assets via asWebviewUri — a flat, predictable set keeps the provider simple.
// `@web/*` aliases the UNMODIFIED app/web sources so the canvas modules (flow-nodes, layout, suggest, icons,
// format, meta) are reused as-is — the old shell is never edited.
export default defineConfig({
  root: resolve(__dirname, 'webview'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@web': resolve(__dirname, '../web/src') },
  },
  build: {
    outDir: resolve(__dirname, 'dist/webview'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'webview.js',
        chunkFileNames: 'chunk-[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
