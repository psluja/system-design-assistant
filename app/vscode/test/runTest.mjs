// Integration-test launcher: downloads a stable VS Code build and runs the suite inside it with this
// extension loaded (the standard @vscode/test-electron flow). Run AFTER `pnpm build` (both bundles).
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runTests } from '@vscode/test-electron';

const here = dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = resolve(here, '..');
const extensionTestsPath = resolve(here, 'suite', 'index.cjs');

// Open a real WORKSPACE FOLDER so VS Code's file watcher is active over it — the live-reload round-trip
// needs the .sda.json to live inside a watched folder, otherwise an external write (what save_design does) is
// never detected and the custom editor cannot reload it. The suite writes the reload file into this folder.
const workspace = mkdtempSync(join(tmpdir(), 'sda-e2e-ws-'));

try {
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, '--disable-workspace-trust', '--disable-extensions'],
  });
} catch (err) {
  console.error('Integration tests FAILED:', err);
  process.exit(1);
}
