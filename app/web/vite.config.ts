import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so a static build also works opened relatively. COOP/COEP keep cross-origin isolation
// available for WASM solvers (MiniZinc/clingo) on the cold path, harmless for the local app.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  preview: {
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  worker: { format: 'es' },
});
