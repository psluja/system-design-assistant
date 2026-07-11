import { describe, it, expect } from 'vitest';
import { serialize, type ProjectDoc } from '@sda/core';
import { allManifests, keys } from '@sda/content';
import {
  wordAt, classifyHover, manifestHoverMarkdown, registryKeyHoverMarkdown,
  nodeRollups, rollupTitle, findInstanceIdAnchors,
} from './text-insights-pure';

// The pure text-insight logic (vscode-free, so vitest can load it). The vscode-facing providers in
// text-insights.ts are thin glue over exactly these functions; the interesting behaviour is covered here.

describe('wordAt', () => {
  it('returns the whole quoted string the cursor sits inside (multi-segment id, not just a word)', () => {
    const line = '    { "id": "pg", "type": "db.postgres" }';
    const col = line.indexOf('db.postgres') + 3; // somewhere inside the type value
    const span = wordAt(line, col);
    expect(span?.text).toBe('db.postgres');
    expect(line.slice(span!.startCol, span!.endCol)).toBe('db.postgres');
  });

  it('resolves the key token, not an adjacent string', () => {
    const line = '      "concurrency": 500,';
    const col = line.indexOf('concurrency') + 2;
    expect(wordAt(line, col)?.text).toBe('concurrency');
  });

  it('returns undefined when the cursor is not inside any quoted string', () => {
    const line = '      "concurrency": 500,';
    const col = line.indexOf('500'); // on the number, outside every quote
    expect(wordAt(line, col)).toBeUndefined();
  });
});

describe('classifyHover', () => {
  const deps = {
    manifests: allManifests,
    isProtocol: (id: string) => id === 'postgresql' || id === 'http' || id === 'https',
    isRegistryKey: (key: string) => key === 'concurrency' || key === 'throughput',
  };

  it('classifies a known manifest type value', () => {
    const line = '    { "id": "pg", "type": "db.postgres" }';
    const span = wordAt(line, line.indexOf('db.postgres') + 1)!;
    expect(classifyHover(line, span, deps)).toEqual({ kind: 'type', id: 'db.postgres' });
  });

  it('does NOT classify a hand-typed unknown type (honest silence)', () => {
    const line = '    { "id": "x", "type": "totally.unknown" }';
    const span = wordAt(line, line.indexOf('totally.unknown') + 1)!;
    expect(classifyHover(line, span, deps)).toBeUndefined();
  });

  it('classifies a protocol id inside an accepts array', () => {
    const line = '      { "name": "in", "dir": "in", "accepts": ["postgresql"] }';
    const span = wordAt(line, line.indexOf('postgresql') + 1)!;
    expect(classifyHover(line, span, deps)).toEqual({ kind: 'protocol', id: 'postgresql' });
  });

  it('classifies a protocol id inside a multi-element speaks array', () => {
    const line = '      "speaks": ["http", "https"]';
    const span = wordAt(line, line.indexOf('https') + 1)!;
    expect(classifyHover(line, span, deps)).toEqual({ kind: 'protocol', id: 'https' });
  });

  it('classifies a registry config key whose value is a number', () => {
    const line = '      "concurrency": 500,';
    const span = wordAt(line, line.indexOf('concurrency') + 1)!;
    expect(classifyHover(line, span, deps)).toEqual({ kind: 'configKey', key: 'concurrency' });
  });

  it('does not classify a non-registry key as a config key', () => {
    const line = '      "name": 3,';
    const span = wordAt(line, line.indexOf('name') + 1)!;
    expect(classifyHover(line, span, deps)).toBeUndefined();
  });
});

describe('manifestHoverMarkdown', () => {
  it('renders the type id, a config-defaults table and the ports from the REAL manifest', () => {
    const md = manifestHoverMarkdown('db.postgres', allManifests)!;
    expect(md).toContain('`db.postgres`');
    expect(md).toContain('| Key | Default | Unit |');
    // db.postgres declares concurrency = 100 (max_connections) — a real, sourced default, not invented.
    expect(md).toContain('| concurrency | 100 | 1 |');
    // its in-port accepts the postgresql wire protocol
    expect(md).toContain('accepts `postgresql`');
  });

  it('returns undefined for an unknown type (never fabricates)', () => {
    expect(manifestHoverMarkdown('nope.nope', allManifests)).toBeUndefined();
  });
});

describe('registryKeyHoverMarkdown', () => {
  it('shows the label and unit for a real registry key', () => {
    const md = registryKeyHoverMarkdown('concurrency')!;
    expect(md).toContain('`concurrency`');
    expect(md).toContain('Unit: `1`');
  });

  it('returns undefined for a key that is not registered', () => {
    expect(registryKeyHoverMarkdown('made-up-key')).toBeUndefined();
  });
});

describe('findInstanceIdAnchors', () => {
  const pretty = [
    '{',
    '  "instances": [',
    '    { "id": "client", "type": "client.web" },',
    '    { "id": "pg", "type": "db.postgres" }',
    '  ]',
    '}',
  ].join('\n');

  it('finds every id line with its node and zero-based line number', () => {
    const anchors = findInstanceIdAnchors(pretty);
    expect(anchors).toEqual([
      { node: 'client', line: 2 },
      { node: 'pg', line: 3 },
    ]);
  });
});

describe('rollupTitle', () => {
  it('reads ✓ ok for a clean node', () => {
    expect(rollupTitle({ node: 'a', violations: 0, warnings: 0, worstKey: undefined })).toBe('✓ ok');
  });
  it('names the count and worst key for violations', () => {
    expect(rollupTitle({ node: 'a', violations: 2, warnings: 0, worstKey: 'throughput' })).toBe('✖ 2 violations · throughput');
    expect(rollupTitle({ node: 'a', violations: 1, warnings: 0, worstKey: 'overflow' })).toBe('✖ 1 violation · overflow');
  });
  it('shows warnings when there is no violation', () => {
    expect(rollupTitle({ node: 'a', violations: 0, warnings: 1, worstKey: 'latency' })).toBe('⚠ 1 warning · latency');
  });
});

describe('nodeRollups', () => {
  // A saturated two-tier design (client 10,000 rps → postgres capacity ~2000) — postgres MUST roll up a violation,
  // and the roll-up must come from the SAME queueing-aware path every other surface uses.
  const saturated = (): ProjectDoc => ({
    schema: 11,
    id: 'it',
    name: 'integration',
    instances: [
      { id: 'client', type: 'client.web', config: { [String(keys.throughput)]: 10000 } },
      { id: 'pg', type: 'db.postgres' },
    ],
    wires: [{ from: ['client', 'out'], to: ['pg', 'in'] }],
    layout: {}, labels: {}, descriptions: {}, groups: [], components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [], scenarios: [], systemPromises: [],
  });

  it('rolls up a violation on the saturated tier and ok on the source', () => {
    const rollups = nodeRollups(serialize(saturated()));
    expect(rollups).not.toBeNull();
    const pg = rollups!.get('pg')!;
    expect(pg.violations).toBeGreaterThan(0);
    expect(pg.worstKey).toBeTruthy();
    // The client (a pure source) carries no breach.
    expect(rollups!.get('client')!.violations).toBe(0);
  });

  it('seeds a lens for every instance, even a clean one', () => {
    const clean: ProjectDoc = { ...saturated(), instances: [{ id: 'lonely', type: 'client.web' }], wires: [] };
    const rollups = nodeRollups(serialize(clean))!;
    expect(rollups.has('lonely')).toBe(true);
    expect(rollupTitle(rollups.get('lonely')!)).toBe('✓ ok');
  });

  it('returns null for text that does not parse (no fabricated states)', () => {
    expect(nodeRollups('{ not json')).toBeNull();
  });
});
