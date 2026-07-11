import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveEditorRegistry, ActiveEditorState } from './active-editor';
import type { H2W } from './protocol';

// `sda.idealLayout` — the HOST side of the protocol's one deliberate `cmd` evolution (owner ruling: a visible
// command must RUN the sparkle, never lecture). The command's whole job is a ONE-WORD forward to the ACTIVE
// canvas over the geometry channel Tidy rides; the pipeline itself runs in the webview on MEASURED sizes
// (webview/ideal-layout.ts — proven by its own suite + host-commands.test.ts). These tests run commands.ts
// against a mocked `vscode` module (the real one exists only inside the editor — every other host test is pure,
// but the forward IS the behaviour here, so we mock the two touchpoints: registerCommand + showWarningMessage)
// and assert both honest behaviours:
//   • an active canvas → post exactly `{ type:'cmd', cmd:'idealLayout' }` — the command runs the sparkle;
//   • no active canvas → the "open a design first" warning and NOTHING posted. That path is programmatic-only
//     (palette / editor-title / keybinding entries are hidden by `when: activeCustomEditorId == sda.designEditor`
//     — no dead affordance is offered), but the last resort must still be honest.

const vs = vi.hoisted(() => ({
  registered: new Map<string, (...args: unknown[]) => unknown>(),
  warnings: [] as string[],
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => {
      vs.registered.set(id, fn);
      return { dispose: (): void => void vs.registered.delete(id) };
    },
  },
  window: {
    showWarningMessage: (message: string) => {
      vs.warnings.push(message);
      return Promise.resolve(undefined);
    },
    showInformationMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
  },
}));

import { registerCommands } from './commands';

/** A registry stub whose `current` the test flips between an active canvas and none (the only surface used). */
const activeState: { current: ActiveEditorState | undefined } = { current: undefined };
const registry = {
  get current() {
    return activeState.current;
  },
} as unknown as ActiveEditorRegistry;

registerCommands(registry); // registers into the mocked `vscode.commands` table once for the whole file

describe("sda.idealLayout (host) — the one-word 'run the sparkle' forward", () => {
  beforeEach(() => {
    vs.warnings.length = 0;
    activeState.current = undefined;
  });

  it("posts exactly { type:'cmd', cmd:'idealLayout' } to the ACTIVE canvas", () => {
    const posted: H2W[] = [];
    activeState.current = {
      webview: { postMessage: (m: H2W) => { posted.push(m); return Promise.resolve(true); } },
    } as unknown as ActiveEditorState;

    void vs.registered.get('sda.idealLayout')!();

    expect(posted).toEqual([{ type: 'cmd', cmd: 'idealLayout' }]);
    expect(vs.warnings, 'no lecture rides along a successful run').toEqual([]);
  });

  it('with NO active canvas warns honestly ("open a design first") and posts nothing', () => {
    void vs.registered.get('sda.idealLayout')!();

    expect(vs.warnings).toHaveLength(1);
    expect(vs.warnings[0]).toMatch(/open a \.sda\.json design first/);
    expect(vs.warnings[0]).toMatch(/lay out/); // names the action it could not perform
  });
});
