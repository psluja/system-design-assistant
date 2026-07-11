import { defineConfig } from 'vitest/config';

// Vitest config for the EXTENSION HOST unit tests (src/*.test.ts). The webview's own vite.config.ts sets
// `root: webview`, which would scope test discovery to the webview folder and miss the host tests; this config
// takes precedence for `vitest run` and points discovery at src/. The host tests are pure (pure.ts) — no
// `vscode` module, no DOM — so the default node environment is exactly right.
export default defineConfig({
  test: {
    root: __dirname,
    include: ['src/**/*.test.ts', 'webview/**/*.test.ts'],
    environment: 'node',
  },
});
