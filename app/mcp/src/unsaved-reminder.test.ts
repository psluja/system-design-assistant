import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { Studio, serialize } from '@sda/core';
import { registry, allManifests } from '@sda/content';
import { buildTools, type AnyTool, type ToolResult } from './tools';
import { buildFileTools, createFileSession, withUnsavedReminder, withinRoots, type FileSystemPort } from './file-io';
import { buildSimTools } from './simulate';

// THE UNSAVED-CANVAS REMINDER (the owner's live Copilot transcript: the agent edited the design, never saved, and
// the open canvas never moved — the human asked "why did nothing change?"). The server tracks the design-vs-file
// drift in SERVER MEMORY (one FileSession shared by the file tools and the wrapper; never persisted): every result
// that leaves the design drifted from the last-saved file carries ONE stateful ⚠ line; save_design/import_design
// reset it; evaluate/simulate (the read-only verdict surfaces an agent quotes to the human) carry it only while
// dirty; every other read stays clean. Driven over the in-memory fs, exactly like file-io.test.ts.

const ROOT = resolve('sda-unsaved-test-fixture');
const at = (name: string): string => resolve(ROOT, name);
const REMINDER = '⚠ unsaved — the open canvas still shows the last saved state; save_design writes to';

/** An in-memory FileSystemPort keyed by resolved absolute paths — the same keys `resolveInRoots` produces. */
function memFs(seed: Record<string, string> = {}): FileSystemPort {
  const store: Record<string, string> = { ...seed };
  return {
    exists: (abs) => abs in store,
    read: (abs) => {
      if (!(abs in store)) throw new Error(`ENOENT: ${abs}`);
      return store[abs] as string;
    },
    write: (abs, text) => {
      store[abs] = text;
    },
    listSdaFiles: (roots) => Object.keys(store).filter((p) => p.endsWith('.sda.json') && roots.some((r) => withinRoots([r], p))),
  };
}

/** A valid .sda.json document (client → postgres) to import. */
function sampleDoc(): string {
  const s = new Studio(registry, allManifests);
  s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
  s.dispatch({ kind: 'addComponent', id: 'pg', type: 'db.postgres' });
  s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['pg', 'in'] });
  return serialize(s.project());
}

/** The wrapped surface exactly as the stdio server composes it: ONE session shared by file tools + wrapper. */
function harness(seed: Record<string, string> = {}) {
  const studio = new Studio(registry, allManifests);
  const session = createFileSession(studio);
  const raw: AnyTool[] = [...buildTools(studio), ...buildFileTools(studio, memFs(seed), [ROOT], session), ...buildSimTools(studio, registry)];
  const tools = withUnsavedReminder(studio, session, raw);
  const call = async (name: string, a: Record<string, unknown> = {}): Promise<ToolResult> => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return await Promise.resolve(t.run(a));
  };
  return { studio, session, call };
}

describe('the unsaved-canvas reminder — dirty lifecycle', () => {
  it('a real mutate result carries the ⚠ line (path-aware form once a file is known; name-a-path form before)', async () => {
    const { call } = harness({ [at('design.sda.json')]: sampleDoc() });
    // No file known yet — the line still fires on a mutation, guiding to name a path.
    const add = await call('add_component', { id: 'cache', type: 'cache.redis' });
    expect(add.ok, add.text).toBe(true);
    expect(add.text).toContain(REMINDER);
    expect(add.text, 'without a tracked file the line asks for a {path}').toContain('{path:');
    // After an import, the SAME line names the tracked file instead.
    await call('import_design', { path: 'design.sda.json' });
    const mut = await call('set_config', { node: 'client', key: 'throughput', value: 500 });
    expect(mut.ok, mut.text).toBe(true);
    expect(mut.text).toContain(`${REMINDER} design.sda.json`);
  });

  it('save_design clears the flag; import_design resets it; their own results are never flagged', async () => {
    const { call } = harness({ [at('design.sda.json')]: sampleDoc() });
    await call('import_design', { path: 'design.sda.json' });
    // clean after import: the verdict reads carry no line
    expect((await call('evaluate')).text).not.toContain(REMINDER);
    // mutate ⇒ dirty ⇒ evaluate carries the line
    await call('set_config', { node: 'client', key: 'throughput', value: 750 });
    expect((await call('evaluate')).text).toContain(REMINDER);
    // save ⇒ clean again — and the save result itself is not flagged
    const save = await call('save_design');
    expect(save.ok, save.text).toBe(true);
    expect(save.text).not.toContain(REMINDER);
    expect((await call('evaluate')).text).not.toContain(REMINDER);
    // mutate ⇒ dirty; a fresh import resets (the file and the session agree again)
    await call('set_config', { node: 'client', key: 'throughput', value: 900 });
    const imp = await call('import_design', { path: 'design.sda.json' });
    expect(imp.text).not.toContain(REMINDER);
    expect((await call('evaluate')).text).not.toContain(REMINDER);
  });

  it('read-only tools stay clean even while dirty — only evaluate/simulate remind', async () => {
    const { call } = harness({ [at('design.sda.json')]: sampleDoc() });
    await call('import_design', { path: 'design.sda.json' });
    await call('set_config', { node: 'client', key: 'throughput', value: 100 });
    for (const read of ['list_components', 'get_project', 'list_protocols', 'list_classes']) {
      expect((await call(read)).text, `${read} is a plain read — no reminder even while dirty`).not.toContain(REMINDER);
    }
    expect((await call('evaluate')).text, 'evaluate is a verdict surface — reminded while dirty').toContain(REMINDER);
    expect((await call('simulate')).text, 'simulate is a verdict surface — reminded while dirty').toContain(REMINDER);
  });

  it('a failed mutation appends nothing (atomic dispatch — the document did not move)', async () => {
    const { call } = harness({ [at('design.sda.json')]: sampleDoc() });
    await call('import_design', { path: 'design.sda.json' });
    const bad = await call('add_component', { id: 'x', type: 'no.such.type' });
    expect(bad.ok).toBe(false);
    expect(bad.text).not.toContain(REMINDER);
    expect((await call('evaluate')).text, 'still clean — nothing changed').not.toContain(REMINDER);
  });

  it('undo back to the saved document honestly reads clean again (reference identity, not a sticky flag)', async () => {
    const { call } = harness({ [at('design.sda.json')]: sampleDoc() });
    await call('import_design', { path: 'design.sda.json' });
    const mut = await call('set_config', { node: 'client', key: 'throughput', value: 1234 });
    expect(mut.text).toContain(REMINDER);
    const undo = await call('undo');
    expect(undo.ok).toBe(true);
    expect(undo.text, 'the design is back to exactly what the file holds — no false alarm').not.toContain(REMINDER);
    expect((await call('evaluate')).text).not.toContain(REMINDER);
  });
});
