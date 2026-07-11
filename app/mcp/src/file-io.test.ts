import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { Studio, serialize } from '@sda/core';
import { registry, allManifests } from '@sda/content';
import { buildFileTools, resolveInRoots, withinRoots, workspaceRoots, type FileSystemPort } from './file-io';
import type { ToolResult } from './tools';

// TASK-84 §1: file-based IO. import_design/save_design read/write real .sda.json files, confined to the workspace,
// with default-path memory (save writes back the imported file so the open canvas live-reloads). Driven against an
// IN-MEMORY filesystem (the same pure path logic runs in production over node fs), so the contract is proven with
// no disk: default-path memory, workspace confinement (writes refused outside), and self-correcting candidate lists.

const ROOT = resolve('sda-ws-test-fixture');
const at = (name: string): string => resolve(ROOT, name);

/** An in-memory FileSystemPort keyed by resolved absolute paths — the same keys `resolveInRoots` produces. */
function memFs(seed: Record<string, string> = {}): FileSystemPort & { store: Record<string, string> } {
  const store: Record<string, string> = { ...seed };
  return {
    store,
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

/** A valid .sda.json document (client → postgres), optionally with an uncertainty range declared. */
function sampleDoc(withRange = false): string {
  const s = new Studio(registry, allManifests);
  s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
  s.dispatch({ kind: 'addComponent', id: 'pg', type: 'db.postgres' });
  s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['pg', 'in'] });
  if (withRange) s.dispatch({ kind: 'setRange', node: 'client', key: 'throughput', range: { lo: 100, hi: 200 } });
  return serialize(s.project());
}

function harness(seed: Record<string, string> = {}) {
  const studio = new Studio(registry, allManifests);
  const fs = memFs(seed);
  const tools = buildFileTools(studio, fs, [ROOT]);
  const call = (name: string, a: Record<string, unknown> = {}): ToolResult => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.run(a) as ToolResult;
  };
  return { studio, fs, call };
}

describe('path resolution + confinement (pure)', () => {
  it('confines a relative path to a root and resolves an existing match', () => {
    const r = resolveInRoots([ROOT], 'design.sda.json', (p) => p === at('design.sda.json'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.abs).toBe(at('design.sda.json'));
  });
  it('refuses a path that escapes the workspace', () => {
    const r = resolveInRoots([ROOT], resolve(ROOT, '..', 'evil.sda.json'), () => false);
    expect(r.ok).toBe(false);
  });
  it('withinRoots is true for a descendant and false for a sibling', () => {
    expect(withinRoots([ROOT], at('a/b.sda.json'))).toBe(true);
    expect(withinRoots([ROOT], resolve(ROOT, '..', 'other.sda.json'))).toBe(false);
  });
  it('workspaceRoots reads SDA_WORKSPACE, else falls back to cwd', () => {
    expect(workspaceRoots({ SDA_WORKSPACE: '' }, '/proj')).toEqual([resolve('/proj')]);
  });
});

describe('import_design', () => {
  it('loads the file into the studio and remembers it as the save default', () => {
    const { studio, fs, call } = harness({ [at('design.sda.json')]: sampleDoc() });
    const r = call('import_design', { path: 'design.sda.json' });
    expect(r.ok, r.text).toBe(true);
    expect(studio.project().instances.map((i) => i.id).sort()).toEqual(['client', 'pg']);
    expect(r.text).toContain('save_design');
    // save with NO path writes BACK to the imported file (default-path memory).
    const rm = studio.dispatch({ kind: 'addComponent', id: 'cache', type: 'cache.redis' });
    expect(rm.ok).toBe(true);
    const s = call('save_design', {});
    expect(s.ok, s.text).toBe(true);
    expect(fs.store[at('design.sda.json')]).toContain('cache'); // the edited design was written back to the same file
  });

  it('an unknown path lists the workspace .sda.json candidates (self-correcting)', () => {
    const { call } = harness({ [at('oracle.sda.json')]: sampleDoc(), [at('sub/other.sda.json')]: sampleDoc() });
    const r = call('import_design', { path: 'missing.sda.json' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('oracle.sda.json');
    expect(r.text).toContain('other.sda.json');
  });

  it('refuses a path outside the workspace', () => {
    const { call } = harness({ [at('ok.sda.json')]: sampleDoc() });
    const r = call('import_design', { path: resolve(ROOT, '..', 'escape.sda.json') });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('outside the workspace');
  });

  it('reports an invalid document honestly (never a corrupt load)', () => {
    const { call } = harness({ [at('bad.sda.json')]: '{ not valid json' });
    const r = call('import_design', { path: 'bad.sda.json' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('not a valid .sda.json');
  });
});

describe('save_design', () => {
  it('with NO path and nothing imported yet, guides the agent to pass one', () => {
    const { call } = harness({ [at('a.sda.json')]: sampleDoc() });
    const r = call('save_design', {});
    expect(r.ok).toBe(false);
    expect(r.text).toContain('nothing has been imported');
    expect(r.text).toContain('a.sda.json'); // lists a candidate to help pick the open file
  });

  it('writes to an explicit workspace path and refuses one outside', () => {
    const { fs, call } = harness();
    const ok = call('save_design', { path: 'fresh.sda.json' });
    expect(ok.ok, ok.text).toBe(true);
    expect(fs.store[at('fresh.sda.json')]).toBeDefined();
    const bad = call('save_design', { path: resolve(ROOT, '..', 'escape.sda.json') });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('outside the workspace');
  });

  it('states the live-reload effect, and the Uncertainty block when the design carries ranges', () => {
    const { call } = harness({ [at('unc.sda.json')]: sampleDoc(true) });
    expect(call('import_design', { path: 'unc.sda.json' }).ok).toBe(true);
    const r = call('save_design', {});
    expect(r.ok, r.text).toBe(true);
    expect(r.text).toContain('LIVE-RELOADS');
    expect(r.text).toContain('Uncertainty'); // the human is told what they now see
  });
});
