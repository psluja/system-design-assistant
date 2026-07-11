import { describe, it, expect } from 'vitest';
import { serialize, deserialize, type ProjectDoc } from '@sda/core';
import { keys, type GuaranteeSlo } from '@sda/content';
import { PROMISES_TITLE } from '@sda/presenter';
import { findNodeIdRange, EchoGuard, formatStatus, statusTooltip, formatNumber, summaryRowLabel, toneIcon, toneDecor, providerOf, kindOf, kindIcon, sectionIcon, escapeRegExp, idPairPattern, isDimensionlessUnit, systemRootItems, systemSectionChildren } from './pure';
import type { SummarySection } from './protocol';
import { setConfigValue, applyChanges, changeRanges, setSloText, setTransformText, setWireTransformText, setGuaranteeSloText, clearGuaranteeSloText, setRangeText } from './document-edits';
import { portRowsFor, wireRowsFor, formatTransform, validateTransformValue } from './port-transforms';
import { rangeRowsFor, rangeMapFor, configKnobsFor } from './ranges';

// These cover the pure host logic that has no `vscode` dependency (vitest cannot load the `vscode` module,
// so all interesting decisions live in pure.ts and are tested here directly).

describe('findNodeIdRange', () => {
  // A realistic pretty-printed project (the format serialize() emits: 2-space indent, `"id": "…"`).
  const pretty = [
    '{',
    '  "schema": 3,',
    '  "instances": [',
    '    { "id": "client", "type": "client.web" },',
    '    { "id": "pg", "type": "db.postgres" }',
    '  ]',
    '}',
  ].join('\n');

  it('finds the id VALUE span on the right line', () => {
    const r = findNodeIdRange(pretty, 'pg');
    expect(r).not.toBeNull();
    expect(r!.line).toBe(4); // zero-based: line 5 in an editor
    // The underlined span is exactly the id text between the quotes.
    const line = pretty.split('\n')[r!.line]!;
    expect(line.slice(r!.startCol, r!.endCol)).toBe('pg');
  });

  it('locates the first node on an earlier line', () => {
    const r = findNodeIdRange(pretty, 'client');
    expect(r).not.toBeNull();
    expect(r!.line).toBe(3);
    const line = pretty.split('\n')[r!.line]!;
    expect(line.slice(r!.startCol, r!.endCol)).toBe('client');
  });

  it('tolerates the minified `"id":"x"` spacing', () => {
    const min = '{"instances":[{"id":"gw","type":"proxy.nginx"}]}';
    const r = findNodeIdRange(min, 'gw');
    expect(r).not.toBeNull();
    expect(r!.line).toBe(0);
    expect(min.slice(r!.startCol, r!.endCol)).toBe('gw');
  });

  it('returns null for a whole-design problem (empty node)', () => {
    expect(findNodeIdRange(pretty, '')).toBeNull();
  });

  it('returns null when the node id is absent from the text', () => {
    expect(findNodeIdRange(pretty, 'ghost')).toBeNull();
  });

  it('does not match a longer id that merely contains the query', () => {
    // Searching for "pg" must not match "pg-primary" — the quoted-value regex requires the full token.
    const doc = '{"instances":[{"id":"pg-primary","type":"db.postgres"}]}';
    expect(findNodeIdRange(doc, 'pg')).toBeNull();
    const exact = findNodeIdRange(doc, 'pg-primary');
    expect(exact).not.toBeNull();
    expect(doc.slice(exact!.startCol, exact!.endCol)).toBe('pg-primary');
  });
});

describe('EchoGuard EOL insensitivity (the CRLF freeze)', () => {
  it('treats the CRLF-normalized echo of an LF apply as an ECHO (kills the ping-pong loop)', () => {
    // The exact production sequence with a CRLF-authored file: we apply LF text, the TextDocument
    // normalizes it to CRLF, and the change event hands the CRLF form back. Pre-fix this compared
    // unequal -> docExternal -> webview reload -> docChanged(LF) -> forever.
    const g = new EchoGuard();
    g.remember('{\n  "a": 1\n}');
    expect(g.isEcho('{\r\n  "a": 1\r\n}')).toBe(true);
  });
  it('remembering CRLF recognises the LF echo too (the reverse direction)', () => {
    const g = new EchoGuard();
    g.remember('{\r\n  "a": 1\r\n}');
    expect(g.isEcho('{\n  "a": 1\n}')).toBe(true);
  });
  it('a REAL content change is never mistaken for an echo, whatever the EOLs', () => {
    const g = new EchoGuard();
    g.remember('{\n  "a": 1\n}');
    expect(g.isEcho('{\r\n  "a": 2\r\n}')).toBe(false);
  });
});

describe('EchoGuard', () => {
  it('recognises exactly the last remembered text as an echo', () => {
    const g = new EchoGuard();
    expect(g.isEcho('anything')).toBe(false); // nothing remembered yet
    g.remember('A');
    expect(g.isEcho('A')).toBe(true);
    expect(g.isEcho('B')).toBe(false);
  });

  it('tracks only the MOST RECENT remembered text', () => {
    const g = new EchoGuard();
    g.remember('A');
    g.remember('B');
    expect(g.isEcho('A')).toBe(false); // superseded
    expect(g.isEcho('B')).toBe(true);
  });

  it('does not consume the guard — the same echo is recognised repeatedly until superseded', () => {
    // isEcho must be a pure predicate (VS Code can fire onDidChangeTextDocument more than once for one apply);
    // reading it must not clear the remembered text, or a duplicate change event would slip through as external.
    const g = new EchoGuard();
    g.remember('X');
    expect(g.isEcho('X')).toBe(true);
    expect(g.isEcho('X')).toBe(true);
  });

  it('models the docChanged ⇄ docExternal ping-pong break', () => {
    // The real sequence: the canvas sends text T (host remembers it), the resulting onDidChangeTextDocument brings
    // T back → recognised as our echo and dropped. A genuinely EXTERNAL edit (native undo → T2) is NOT the echo.
    const g = new EchoGuard();
    const T = '{"v":1}';
    g.remember(T); // host applied the webview's docChanged
    expect(g.isEcho(T)).toBe(true); // the change event for our own edit — dropped, no docExternal
    const T2 = '{"v":2}';
    expect(g.isEcho(T2)).toBe(false); // an external change (undo/git/manual) — pushed to the webview
  });
});

describe('formatStatus', () => {
  it('renders all metrics with separators and a violation count', () => {
    const s = formatStatus({ throughputRps: 2000, latencyMs: 71, costUsdMonth: 285, violations: 2 });
    expect(s).toBe('$(pulse) 2,000 rps · 71 ms · $285/mo · $(error) 2');
  });

  it('shows the check codicon when there are no violations', () => {
    const s = formatStatus({ throughputRps: 1000, latencyMs: 10, costUsdMonth: 50, violations: 0 });
    expect(s).toBe('$(pulse) 1,000 rps · 10 ms · $50/mo · $(check)');
  });

  it('OMITS missing metrics rather than faking a zero (never lie)', () => {
    // No latency, no cost computed → only throughput + the clean marker appear.
    const s = formatStatus({ throughputRps: 500, violations: 0 });
    expect(s).toBe('$(pulse) 500 rps · $(check)');
  });

  it('degrades to just the violation marker when no metrics are known', () => {
    expect(formatStatus({ violations: 3 })).toBe('$(pulse) $(error) 3');
  });

  it('rounds fractional metrics to whole units', () => {
    const s = formatStatus({ throughputRps: 1999.7, latencyMs: 70.4, costUsdMonth: 284.6, violations: 0 });
    expect(s).toBe('$(pulse) 2,000 rps · 70 ms · $285/mo · $(check)');
  });
});

describe('statusTooltip', () => {
  it('explains each segment and marks unknowns honestly', () => {
    const t = statusTooltip({ throughputRps: 2000, violations: 1 });
    expect(t).toContain('Throughput: 2,000 req/s');
    expect(t).toContain('Latency: unknown');
    expect(t).toContain('Cost: unknown');
    expect(t).toContain('1 violation');
  });

  it('uses the clean-design tooltip at zero violations', () => {
    const t = statusTooltip({ throughputRps: 10, latencyMs: 5, costUsdMonth: 1, violations: 0 });
    expect(t).toContain('No violations');
  });
});

describe('formatNumber', () => {
  it('groups thousands', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(1000)).toBe('1,000');
    expect(formatNumber(1234567)).toBe('1,234,567');
  });
  it('keeps a negative sign', () => {
    expect(formatNumber(-1500)).toBe('-1,500');
  });
});

describe('summaryRowLabel', () => {
  it('joins label and value with a colon', () => {
    expect(summaryRowLabel({ label: 'Throughput', value: '2,000 req/s' })).toBe('Throughput: 2,000 req/s');
  });
  it('degrades to just the label when the value is empty (a placeholder / note row)', () => {
    expect(summaryRowLabel({ label: 'Open a design', value: '' })).toBe('Open a design');
  });
});

describe('toneIcon', () => {
  it('maps bad→error and warn→warning', () => {
    expect(toneIcon('bad')).toBe('error');
    expect(toneIcon('warn')).toBe('warning');
  });
  it('renders NO icon for an ok or absent tone (stay quiet unless something is wrong)', () => {
    expect(toneIcon('ok')).toBeUndefined();
    expect(toneIcon(undefined)).toBeUndefined();
  });
});

describe('toneDecor', () => {
  it('maps each tone to the Testing-palette icon + chart color', () => {
    expect(toneDecor('bad')).toEqual({ icon: 'error', color: 'charts.red' });
    expect(toneDecor('warn')).toEqual({ icon: 'warning', color: 'charts.yellow' });
    // Unlike toneIcon, ok DOES decorate here — a passing check is meaningful signal (green tick).
    expect(toneDecor('ok')).toEqual({ icon: 'pass', color: 'charts.green' });
  });
  it('returns undefined for an absent tone (a plain value/note row)', () => {
    expect(toneDecor(undefined)).toBeUndefined();
  });
});

describe('providerOf', () => {
  it('recognises AWS technologies by the id family segment', () => {
    expect(providerOf('db.aurora')).toBe('aws');
    expect(providerOf('queue.sqs')).toBe('aws');
    expect(providerOf('queue.sqs.fifo')).toBe('aws'); // dotted tech → family is the first segment
    expect(providerOf('compute.lambda')).toBe('aws');
    expect(providerOf('cdn.cloudfront')).toBe('aws');
  });
  it('recognises well-known OSS technologies', () => {
    expect(providerOf('db.postgres')).toBe('oss');
    expect(providerOf('cache.redis')).toBe('oss');
    expect(providerOf('stream.kafka')).toBe('oss');
    expect(providerOf('proxy.nginx')).toBe('oss');
  });
  it('returns undefined rather than guessing for an unrecognised id (honest silence)', () => {
    expect(providerOf('client.web')).toBeUndefined();
    expect(providerOf('compute.service')).toBeUndefined();
    expect(providerOf('nodot')).toBeUndefined();
  });
  it('is case-insensitive', () => {
    expect(providerOf('DB.Postgres')).toBe('oss');
  });
});

describe('kindOf / kindIcon', () => {
  it('kindOf takes the segment before the first dot', () => {
    expect(kindOf('queue.sqs.fifo')).toBe('queue');
    expect(kindOf('db.postgres')).toBe('db');
    expect(kindOf('nodot')).toBe('nodot');
  });
  it('kindIcon maps known kinds and falls back to package', () => {
    expect(kindIcon('db')).toBe('database');
    expect(kindIcon('cache')).toBe('zap');
    expect(kindIcon('totally-unknown')).toBe('package');
  });
});

describe('sectionIcon', () => {
  it('maps each System-summary section title to its Testing-view glyph', () => {
    expect(sectionIcon('Design')).toBe('symbol-structure');
    expect(sectionIcon('System · client → pg')).toBe('arrow-right');
    expect(sectionIcon('Flow 2 · a → b')).toBe('arrow-right');
    expect(sectionIcon('Response time · end-to-end')).toBe('watch');
    expect(sectionIcon('Response time · per component')).toBe('watch');
    expect(sectionIcon('Load per component')).toBe('pulse');
    expect(sectionIcon('Load stages · transient')).toBe('pulse'); // the ambient two-tier read-out (doc: load-stages §10)
    expect(sectionIcon('Cost')).toBe('credit-card');
    // The whole-system Promises section shares the node Inspector's Promises glyph — one form (indistinguishable).
    expect(sectionIcon(PROMISES_TITLE)).toBe('target');
    // assumption model (doc: assumption-model §3, §7) — the envelope ('Load limits') + worlds sections get their glyphs
    expect(sectionIcon('Load limits')).toBe('dashboard');
    expect(sectionIcon('Worlds · lens: Real')).toBe('versions');
    // THE VERDICT — the ✓/✗-prefixed headline the webview prepends gets a pass/error glyph.
    expect(sectionIcon('✓ Design holds — every promise met, no tier overloaded')).toBe('pass');
    expect(sectionIcon('✗ 1 promise not met — open Problems')).toBe('error');
  });
  it('falls back to a neutral glyph for an unrecognised title', () => {
    expect(sectionIcon('Something new')).toBe('list-flat');
  });
});

// The System tree's SHAPE — the ONE-FORM invariant (owner ruling): "Add promise…" is the LAST CHILD of the Promises
// section (mirroring the node Inspector's Promises group), NEVER a floating top-level sibling. The presenter always
// emits the Promises section (even empty), so its home is always present.
describe('systemRootItems / systemSectionChildren — the System tree shape', () => {
  const promises = (rows: SummarySection['rows']): SummarySection => ({ title: PROMISES_TITLE, rows });
  const summary: readonly SummarySection[] = [
    { title: 'Design', rows: [{ label: 'Components', value: '2' }] },
    promises([{ label: 'cost ≤ $500/mo · whole system', value: 'now $420/mo ✓', tone: 'ok' }]),
    { title: 'Cost', rows: [{ label: 'Total · on-demand', value: '$420/mo' }] },
  ];

  it('root items are ONE parent per section and NOTHING else — no floating "Add promise…" at the root', () => {
    const roots = systemRootItems(summary);
    expect(roots.every((i) => i.kind === 'section')).toBe(true);
    expect(roots).toHaveLength(3);
    expect(roots.some((i) => i.kind === 'addRequirement')).toBe(false); // the bug being fixed: no top-level Add
  });

  it('the Promises section\'s children are its rows PLUS "Add promise…" as the LAST child', () => {
    const section = systemRootItems(summary).find((i) => i.kind === 'section' && i.section.title === PROMISES_TITLE)!;
    const children = systemSectionChildren((section as { section: SummarySection }).section);
    const add = children.at(-1)!;
    expect(add.kind).toBe('addRequirement');           // the Add row is the LAST child, INSIDE the section
    expect(children.filter((c) => c.kind === 'row')).toHaveLength(1); // the declared cost promise row precedes it
  });

  it('a NON-Promises section gets NO "Add promise…" child (the Add lives only in Promises)', () => {
    const cost = summary.find((s) => s.title === 'Cost')!;
    expect(systemSectionChildren(cost).some((c) => c.kind === 'addRequirement')).toBe(false);
  });

  it('an EMPTY Promises section (none declared) still hosts "Add promise…" — the always-present home', () => {
    const children = systemSectionChildren(promises([]));
    expect(children).toHaveLength(1);
    expect(children[0]!.kind).toBe('addRequirement');
  });

  it('an absent/empty summary yields no roots (the viewsWelcome empty-state shows instead)', () => {
    expect(systemRootItems(undefined)).toEqual([]);
    expect(systemRootItems([])).toEqual([]);
  });
});

describe('escapeRegExp', () => {
  it('makes regex metacharacters inert so a literal matches only itself', () => {
    const escaped = escapeRegExp('a.b+c');
    // The dot/plus must be literal: the pattern matches the exact string, not 'axbxc' etc.
    expect(new RegExp(`^${escaped}$`).test('a.b+c')).toBe(true);
    expect(new RegExp(`^${escaped}$`).test('axbbc')).toBe(false);
  });
});

describe('idPairPattern', () => {
  it('matches the id member in both pretty and minified spacing', () => {
    const re = new RegExp(idPairPattern('pg'));
    expect(re.test('{ "id": "pg" }')).toBe(true);
    expect(re.test('{"id":"pg"}')).toBe(true);
  });
  it('does not match a different id or a superstring', () => {
    const re = new RegExp(idPairPattern('pg'));
    expect(re.test('{"id":"pg-primary"}')).toBe(false); // the closing quote is required after the exact token
    expect(re.test('{"id":"app"}')).toBe(false);
  });
  it('escapes a metacharacter in the node id (a regex-safe locator)', () => {
    // A hypothetical dotted id must be matched literally, never as "any char".
    const re = new RegExp(idPairPattern('db.pg'));
    expect(re.test('{"id":"db.pg"}')).toBe(true);
    expect(re.test('{"id":"dbxpg"}')).toBe(false);
  });
});

describe('isDimensionlessUnit', () => {
  it('treats the empty string and the canonical "1" as dimensionless', () => {
    expect(isDimensionlessUnit('')).toBe(true);
    expect(isDimensionlessUnit('1')).toBe(true);
  });
  it('treats any real unit as dimensional', () => {
    expect(isDimensionlessUnit('ms')).toBe(false);
    expect(isDimensionlessUnit('req/s')).toBe(false);
    expect(isDimensionlessUnit('%')).toBe(false);
  });
});

describe('document-edits', () => {
  // A minimal but realistic design that carries a PERCENTILE (p99) SLO band — its `targets` is a Map, the exact
  // shape a naive JSON round-trip drops. We build it in memory, serialize through @sda/core to the on-disk text,
  // then edit a DIFFERENT node and assert the Map survived (the whole point of round-tripping via serialize).
  const withPercentileSlo = (): ProjectDoc => ({
    schema: 11,
    id: 'p1',
    name: 'Test',
    instances: [
      { id: 'app', type: 'compute.service' },
      // A tailLatency SLO with a percentiles band → targets is a Map<string, number>.
      { id: 'pg', type: 'db.postgres', bands: [{ key: keys.tailLatency, band: { shape: 'percentiles', targets: new Map([['p99', 300]]) } }] },
    ],
    wires: [],
    layout: {},
    labels: {},
    descriptions: {},
    groups: [],
    components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [], scenarios: [], systemPromises: [],
  });

  it('setConfigValue writes the knob and keeps a percentile-SLO Map intact', () => {
    const text = serialize(withPercentileSlo());
    const r = setConfigValue(text, 'app', String(keys.concurrency), 128);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Re-parse the produced text: the edit landed AND the p99 Map on the OTHER node round-tripped losslessly.
    const parsed = deserialize(r.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const app = parsed.value.instances.find((i) => i.id === 'app');
    expect(app?.config?.[String(keys.concurrency)]).toBe(128);

    const pg = parsed.value.instances.find((i) => i.id === 'pg');
    const band = pg?.bands?.[0]?.band;
    expect(band?.shape).toBe('percentiles');
    // The Map survived — a naive JSON.stringify would have made this `{}` and lost the SLO.
    expect(band && band.shape === 'percentiles' && band.targets instanceof Map).toBe(true);
    expect(band && band.shape === 'percentiles' && band.targets.get('p99')).toBe(300);
  });

  it('setConfigValue fails honestly for an unknown node (never writes a corrupt doc)', () => {
    const text = serialize(withPercentileSlo());
    const r = setConfigValue(text, 'ghost', String(keys.concurrency), 4);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('ghost');
  });

  it('setConfigValue fails honestly on invalid JSON', () => {
    const r = setConfigValue('{ not json', 'app', String(keys.concurrency), 4);
    expect(r.ok).toBe(false);
  });

  it('applyChanges quantizes an integer (whole-unit) knob UP, never under-provisioning', () => {
    const text = serialize(withPercentileSlo());
    // concurrency is a DISCRETE (whole-unit) knob → a continuous 3.2 must ceil to 4 (rounding down would
    // under-provision below the solver optimum).
    const r = applyChanges(text, [{ node: 'app', key: String(keys.concurrency), to: 3.2 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = deserialize(r.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const app = parsed.value.instances.find((i) => i.id === 'app');
    expect(app?.config?.[String(keys.concurrency)]).toBe(4);
  });

  it('applyChanges rounds a continuous knob to 2 decimals (not a whole unit)', () => {
    const text = serialize(withPercentileSlo());
    // unitCost is NOT a discrete knob → round to 2dp rather than ceil.
    const r = applyChanges(text, [{ node: 'app', key: String(keys.unitCost), to: 12.3456 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = deserialize(r.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const app = parsed.value.instances.find((i) => i.id === 'app');
    expect(app?.config?.[String(keys.unitCost)]).toBe(12.35);
  });

  it('applyChanges applies several changes as one document, failing the whole batch on a bad node', () => {
    const text = serialize(withPercentileSlo());
    const r = applyChanges(text, [
      { node: 'app', key: String(keys.concurrency), to: 8 },
      { node: 'ghost', key: String(keys.concurrency), to: 8 },
    ]);
    // All-or-nothing: one bad node fails the whole batch (never a half-applied hybrid).
    expect(r.ok).toBe(false);
  });
});

describe('setSloText (native requirement editing)', () => {
  // A two-node design where `app` starts with NO bands and `pg` carries a percentile (p99) SLO — the exact Map
  // shape a naive JSON round-trip drops. We assert the Map survives across unrelated SLO edits, and that add /
  // upsert / remove all produce a document that deserializes cleanly.
  const base = (): ProjectDoc => ({
    schema: 11,
    id: 'p1',
    name: 'Test',
    instances: [
      { id: 'app', type: 'compute.service' },
      { id: 'pg', type: 'db.postgres', bands: [{ key: keys.tailLatency, band: { shape: 'percentiles', targets: new Map([['p99', 300]]) } }] },
    ],
    wires: [],
    layout: {},
    labels: {},
    descriptions: {},
    groups: [],
    components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [], scenarios: [], systemPromises: [],
  });

  const bandsOf = (text: string, node: string) => {
    const parsed = deserialize(text);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value.instances.find((i) => i.id === node)?.bands ?? [];
  };

  it('adds a new bands array to a node that had none', () => {
    const text = serialize(base());
    const r = setSloText(text, 'app', String(keys.throughput), { shape: 'minTargetMax', min: 5000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bands = bandsOf(r.text, 'app');
    expect(bands).toHaveLength(1);
    expect(String(bands[0]!.key)).toBe(String(keys.throughput));
    const b = bands[0]!.band;
    expect(b.shape === 'minTargetMax' && b.min).toBe(5000);
  });

  it('upserts an existing key in place rather than duplicating it', () => {
    const withSlo = setSloText(serialize(base()), 'app', String(keys.throughput), { shape: 'minTargetMax', min: 5000 });
    expect(withSlo.ok).toBe(true);
    if (!withSlo.ok) return;
    // Set the SAME key again with a new value → still ONE band, updated (never two throughput bands).
    const again = setSloText(withSlo.text, 'app', String(keys.throughput), { shape: 'minTargetMax', min: 8000 });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const bands = bandsOf(again.text, 'app');
    expect(bands).toHaveLength(1);
    const b = bands[0]!.band;
    expect(b.shape === 'minTargetMax' && b.min).toBe(8000);
  });

  it('writes a percentiles (p99 tail) band whose Map survives the round-trip', () => {
    const r = setSloText(serialize(base()), 'app', String(keys.tailLatency), { shape: 'percentiles', targets: new Map([['p99', 250]]) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bands = bandsOf(r.text, 'app');
    const b = bands[0]!.band;
    // The Map survived (a naive JSON.stringify would have made this `{}` and lost the tail SLO).
    expect(b.shape === 'percentiles' && b.targets instanceof Map).toBe(true);
    expect(b.shape === 'percentiles' && b.targets.get('p99')).toBe(250);
  });

  it('preserves a percentile SLO on ANOTHER node while editing this one', () => {
    // Add an SLO on `app` and assert pg's p99 Map is untouched (the whole point of round-tripping via serialize).
    const r = setSloText(serialize(base()), 'app', String(keys.latency), { shape: 'minTargetMax', max: 120 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pg = bandsOf(r.text, 'pg')[0]!.band;
    expect(pg.shape === 'percentiles' && pg.targets.get('p99')).toBe(300);
  });

  it('removes a band (band === null) and, if it was the last, leaves NO empty bands artifact', () => {
    // pg has exactly one band; removing it must drop the `bands` field entirely (no `"bands": []`), so the doc is
    // identical to a node that never had a band — and deserialize reads it back cleanly.
    const r = setSloText(serialize(base()), 'pg', String(keys.tailLatency), null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(bandsOf(r.text, 'pg')).toHaveLength(0);
    // No stray empty array in the emitted text.
    expect(r.text).not.toContain('"bands": []');
    // And the whole thing still round-trips.
    expect(deserialize(r.text).ok).toBe(true);
  });

  it('removes ONE band while keeping the node\'s others', () => {
    // Give pg a second band, then remove only the first — the second must remain.
    const two = setSloText(serialize(base()), 'pg', String(keys.throughput), { shape: 'minTargetMax', min: 2000 });
    expect(two.ok).toBe(true);
    if (!two.ok) return;
    const removed = setSloText(two.text, 'pg', String(keys.tailLatency), null);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const bands = bandsOf(removed.text, 'pg');
    expect(bands).toHaveLength(1);
    expect(String(bands[0]!.key)).toBe(String(keys.throughput));
  });

  it('fails honestly for an unknown node (never writes a corrupt doc)', () => {
    const r = setSloText(serialize(base()), 'ghost', String(keys.throughput), { shape: 'minTargetMax', min: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('ghost');
  });

  it('fails honestly on invalid JSON', () => {
    const r = setSloText('{ not json', 'app', String(keys.throughput), { shape: 'minTargetMax', min: 1 });
    expect(r.ok).toBe(false);
  });

  it('removing a band from a node that has none is a no-op that still round-trips', () => {
    // `app` has no bands; removing tailLatency there should not error and must not introduce a bands field on it
    // (pg's own bands are untouched — we assert on the app instance specifically, not the whole text).
    const r = setSloText(serialize(base()), 'app', String(keys.tailLatency), null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(bandsOf(r.text, 'app')).toHaveLength(0);
    const parsed = deserialize(r.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const app = parsed.value.instances.find((i) => i.id === 'app')!;
    expect('bands' in app).toBe(false); // no empty bands field introduced on app
    // pg's SLO is left intact (the no-op touched only app).
    expect(bandsOf(r.text, 'pg')).toHaveLength(1);
  });
});

describe('setGuaranteeSloText / clearGuaranteeSloText (native per-FLOW guarantee editing)', () => {
  // A design whose `pg` carries a percentile (p99) SLO — the Map a naive JSON round-trip drops — so we prove a
  // guarantee edit (a TOP-LEVEL doc.guaranteeSlos change) leaves that unrelated Map intact. The guarantee requirement
  // is a property of a PATH, so unlike a band it does NOT ride on an instance — it keys the (source, terminal, dimension) triple.
  const base = (extra?: readonly GuaranteeSlo[]): ProjectDoc => ({
    schema: 11,
    id: 'p1',
    name: 'Test',
    instances: [
      { id: 'producer', type: 'compute.service' },
      { id: 'q', type: 'queue.sqs' },
      { id: 'worker', type: 'compute.faas' },
      { id: 'pg', type: 'db.postgres', bands: [{ key: keys.tailLatency, band: { shape: 'percentiles', targets: new Map([['p99', 300]]) } }] },
    ],
    wires: [
      { from: ['producer', 'out'], to: ['q', 'in'] },
      { from: ['q', 'out'], to: ['worker', 'in'], semantics: 'async' },
    ],
    layout: {},
    labels: {},
    descriptions: {},
    groups: [],
    components: [],
    guaranteeSlos: extra ?? [], lagSlos: [], requestClasses: [], scenarios: [], systemPromises: [],
  });

  const slosOf = (text: string): readonly GuaranteeSlo[] => {
    const parsed = deserialize(text);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value.guaranteeSlos;
  };

  const ordering: GuaranteeSlo = { source: 'producer', terminal: 'worker', dimension: 'ordering', atLeast: 'per-key' };

  it('adds a new guarantee requirement to a design that had none', () => {
    const r = setGuaranteeSloText(serialize(base()), ordering);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const slos = slosOf(r.text);
    expect(slos).toHaveLength(1);
    expect(slos[0]).toEqual(ordering);
  });

  it('upserts by (source, terminal, dimension) rather than duplicating the requirement', () => {
    const first = setGuaranteeSloText(serialize(base()), ordering);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // set the SAME flow + dimension again with a STRONGER floor → still ONE requirement, updated (never two).
    const again = setGuaranteeSloText(first.text, { ...ordering, atLeast: 'total' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const slos = slosOf(again.text);
    expect(slos).toHaveLength(1);
    expect(slos[0]!.atLeast).toBe('total');
  });

  it('keeps a DIFFERENT dimension on the same flow as a separate requirement', () => {
    const first = setGuaranteeSloText(serialize(base()), ordering);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const both = setGuaranteeSloText(first.text, { source: 'producer', terminal: 'worker', dimension: 'delivery', atLeast: 'clean' });
    expect(both.ok).toBe(true);
    if (!both.ok) return;
    expect(slosOf(both.text)).toHaveLength(2); // ordering + delivery, both on producer→worker
  });

  it('preserves a percentile SLO on a node while editing the top-level guarantees (Map survives)', () => {
    const r = setGuaranteeSloText(serialize(base()), ordering);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = deserialize(r.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const pg = parsed.value.instances.find((i) => i.id === 'pg')!;
    const band = pg.bands![0]!.band;
    // The Map survived the guarantee edit (a naive JSON.stringify would have made it `{}` and lost the tail SLO).
    expect(band.shape === 'percentiles' && band.targets instanceof Map).toBe(true);
    expect(band.shape === 'percentiles' && band.targets.get('p99')).toBe(300);
  });

  it('does NOT enforce endpoint existence — a dangling requirement is kept (unknown at verdict time, never dropped)', () => {
    const r = setGuaranteeSloText(serialize(base()), { source: 'ghost', terminal: 'worker', dimension: 'ordering', atLeast: 'per-key' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(slosOf(r.text)).toHaveLength(1); // kept as data even though `ghost` is not a node — reported unknown, not swallowed
  });

  it('clears a declared requirement by its (source, terminal, dimension) triple', () => {
    const withOne = setGuaranteeSloText(serialize(base()), ordering);
    expect(withOne.ok).toBe(true);
    if (!withOne.ok) return;
    const cleared = clearGuaranteeSloText(withOne.text, 'producer', 'worker', 'ordering');
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(slosOf(cleared.text)).toHaveLength(0);
  });

  it('clearing a promise that is not declared fails honestly (never implies it cleared something)', () => {
    const r = clearGuaranteeSloText(serialize(base()), 'producer', 'worker', 'ordering');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Label-only rename (owner ruling: the band kind's ONE human word is "promise") — same failure, same honesty.
    expect(r.error).toContain('no guarantee promise');
  });

  it('fails honestly on invalid JSON rather than writing a corrupt document', () => {
    const bad = setGuaranteeSloText('{ not json', ordering);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toContain('not valid JSON');
  });
});

describe('setTransformText (native per-port transform editing)', () => {
  // A two-node design: `gen` (a compute.service, ports in/out/db) and `logs` (a db.postgres). We add/edit/clear
  // a transform on gen's ports and assert the document is byte-clean and round-trips. `pg` keeps a percentile SLO
  // so we also prove an unrelated Map survives a transform edit (the same losslessness setSloText guarantees).
  const base = (): ProjectDoc => ({
    schema: 11,
    id: 'p1',
    name: 'Test',
    instances: [
      { id: 'gen', type: 'compute.service' },
      { id: 'logs', type: 'db.postgres', bands: [{ key: keys.tailLatency, band: { shape: 'percentiles', targets: new Map([['p99', 300]]) } }] },
    ],
    wires: [],
    layout: {},
    labels: {},
    descriptions: {},
    groups: [],
    components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [], scenarios: [], systemPromises: [],
  });

  const transformsOf = (text: string, node: string) => {
    const parsed = deserialize(text);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value.instances.find((i) => i.id === node)?.transforms ?? {};
  };

  it('adds a transforms record to a node that had none', () => {
    const r = setTransformText(serialize(base()), 'gen', 'db', { kind: 'ratio', value: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(transformsOf(r.text, 'gen')).toEqual({ db: { kind: 'ratio', value: 100 } });
  });

  it('upserts an existing port in place rather than duplicating it', () => {
    const first = setTransformText(serialize(base()), 'gen', 'db', { kind: 'ratio', value: 100 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = setTransformText(first.text, 'gen', 'db', { kind: 'batch', value: 10 });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(transformsOf(again.text, 'gen')).toEqual({ db: { kind: 'batch', value: 10 } });
  });

  it('keeps other ports\' transforms when editing one', () => {
    const one = setTransformText(serialize(base()), 'gen', 'db', { kind: 'ratio', value: 100 });
    if (!one.ok) throw new Error('setup');
    const two = setTransformText(one.text, 'gen', 'out', { kind: 'prob', value: 0.01 });
    expect(two.ok).toBe(true);
    if (!two.ok) return;
    expect(transformsOf(two.text, 'gen')).toEqual({ db: { kind: 'ratio', value: 100 }, out: { kind: 'prob', value: 0.01 } });
  });

  it('clears a transform (transform === null) and, if it was the last, leaves NO empty transforms artifact', () => {
    const set = setTransformText(serialize(base()), 'gen', 'db', { kind: 'ratio', value: 100 });
    if (!set.ok) throw new Error('setup');
    const cleared = setTransformText(set.text, 'gen', 'db', null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(Object.keys(transformsOf(cleared.text, 'gen'))).toHaveLength(0);
    expect(cleared.text).not.toContain('"transforms": {}'); // no stray empty object
    expect(deserialize(cleared.text).ok).toBe(true); // still round-trips
  });

  it('preserves a percentile SLO on ANOTHER node while editing a transform', () => {
    const r = setTransformText(serialize(base()), 'gen', 'db', { kind: 'ratio', value: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const band = deserialize(r.text).ok && (() => { const p = deserialize(r.text); return p.ok ? p.value.instances.find((i) => i.id === 'logs')?.bands?.[0]?.band : undefined; })();
    expect(band && band.shape === 'percentiles' && band.targets.get('p99')).toBe(300);
  });

  it('fails honestly for an unknown node (never writes a corrupt doc)', () => {
    const r = setTransformText(serialize(base()), 'ghost', 'out', { kind: 'ratio', value: 2 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('ghost');
  });

  it('fails honestly on invalid JSON', () => {
    const r = setTransformText('{ not json', 'gen', 'out', { kind: 'ratio', value: 2 });
    expect(r.ok).toBe(false);
  });

  it('clearing a transform on a node that has none is a no-op that still round-trips', () => {
    const r = setTransformText(serialize(base()), 'gen', 'out', null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = deserialize(r.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const gen = parsed.value.instances.find((i) => i.id === 'gen')!;
    expect('transforms' in gen).toBe(false); // no empty transforms field introduced
  });
});

describe('setWireTransformText (native per-WIRE transform editing — routing splits)', () => {
  // A gateway fanning ONE out port to two services: exactly the split a per-port transform cannot express.
  const base = (): ProjectDoc => ({
    schema: 11,
    id: 'p1',
    name: 'Test',
    instances: [
      { id: 'gw', type: 'compute.service' },
      { id: 'catalog', type: 'compute.service' },
      { id: 'checkout', type: 'compute.service' },
    ],
    wires: [
      { from: ['gw', 'out'], to: ['catalog', 'in'] },
      { from: ['gw', 'out'], to: ['checkout', 'in'] },
    ],
    layout: {},
    labels: {},
    descriptions: {},
    groups: [],
    components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [], scenarios: [], systemPromises: [],
  });
  const wireTf = (text: string, toNode: string) => {
    const parsed = deserialize(text);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value.wires.find((w) => w.to[0] === toNode)?.transform;
  };

  it('sets a per-wire transform on the addressed wire only (a 70/30 split)', () => {
    const one = setWireTransformText(serialize(base()), ['gw', 'out'], ['catalog', 'in'], { kind: 'prob', value: 0.7 });
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    const two = setWireTransformText(one.text, ['gw', 'out'], ['checkout', 'in'], { kind: 'prob', value: 0.3 });
    expect(two.ok).toBe(true);
    if (!two.ok) return;
    expect(wireTf(two.text, 'catalog')).toEqual({ kind: 'prob', value: 0.7 });
    expect(wireTf(two.text, 'checkout')).toEqual({ kind: 'prob', value: 0.3 });
  });

  it('upserts the wire transform in place rather than duplicating', () => {
    const first = setWireTransformText(serialize(base()), ['gw', 'out'], ['catalog', 'in'], { kind: 'prob', value: 0.7 });
    if (!first.ok) throw new Error('setup');
    const again = setWireTransformText(first.text, ['gw', 'out'], ['catalog', 'in'], { kind: 'ratio', value: 2 });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(wireTf(again.text, 'catalog')).toEqual({ kind: 'ratio', value: 2 });
  });

  it('clears a wire transform (null) and leaves NO "transform": null artifact', () => {
    const set = setWireTransformText(serialize(base()), ['gw', 'out'], ['catalog', 'in'], { kind: 'prob', value: 0.7 });
    if (!set.ok) throw new Error('setup');
    const cleared = setWireTransformText(set.text, ['gw', 'out'], ['catalog', 'in'], null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(wireTf(cleared.text, 'catalog')).toBeUndefined();
    expect(cleared.text).not.toContain('"transform": null');
    expect(deserialize(cleared.text).ok).toBe(true);
  });

  it('fails honestly for a wire that is not in the design', () => {
    const r = setWireTransformText(serialize(base()), ['gw', 'out'], ['ghost', 'in'], { kind: 'ratio', value: 2 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('ghost');
  });

  it('fails honestly on invalid JSON', () => {
    expect(setWireTransformText('{ not json', ['gw', 'out'], ['catalog', 'in'], { kind: 'ratio', value: 2 }).ok).toBe(false);
  });
});

describe('wireRowsFor (pure wire-row reader for the setWireTransform QuickPick)', () => {
  it('lists every wire with its active OUT transform, marking a wire override vs a port default', () => {
    const doc: ProjectDoc = {
      schema: 11, id: 'p1', name: 'T',
      instances: [
        { id: 'gw', type: 'compute.service', transforms: { out: { kind: 'ratio', value: 5 } } }, // port default on `out`
        { id: 'a', type: 'compute.service' },
        { id: 'b', type: 'compute.service' },
      ],
      wires: [
        { from: ['gw', 'out'], to: ['a', 'in'], transform: { kind: 'prob', value: 0.7 } }, // WIRE override
        { from: ['gw', 'out'], to: ['b', 'in'] }, // no wire transform ⇒ the port default (ratio 5)
      ],
      layout: {}, labels: {}, descriptions: {}, groups: [], components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [], scenarios: [], systemPromises: [],
    };
    const rows = wireRowsFor(serialize(doc));
    const toA = rows.find((r) => r.to[0] === 'a')!;
    const toB = rows.find((r) => r.to[0] === 'b')!;
    expect(toA.transform).toEqual({ kind: 'prob', value: 0.7 });
    expect(toA.override).toBe(true); // the wire's OWN override
    expect(toB.transform).toEqual({ kind: 'ratio', value: 5 });
    expect(toB.override).toBe(false); // falls back to the source port default
  });
});

describe('port-transforms (pure catalog + row reader)', () => {
  const base = (): ProjectDoc => ({
    schema: 11, id: 'p1', name: 'T',
    instances: [{ id: 'gen', type: 'compute.service', transforms: { db: { kind: 'ratio', value: 100 } } }],
    wires: [], layout: {}, labels: {}, descriptions: {}, groups: [], components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [], scenarios: [], systemPromises: [],
  });

  it('portRowsFor lists every manifest port with its active transform + override flag', () => {
    const rows = portRowsFor(serialize(base()), 'gen');
    expect(rows.length).toBeGreaterThan(0);
    const db = rows.find((r) => r.port === 'db');
    expect(db?.transform).toEqual({ kind: 'ratio', value: 100 });
    expect(db?.override).toBe(true); // it's a per-instance override
    // a port with no transform reads as identity (null) and not an override
    const inPort = rows.find((r) => r.port === 'in');
    expect(inPort?.transform).toBeNull();
    expect(inPort?.override).toBe(false);
  });

  it('portRowsFor returns [] for an unknown node or unparseable text (never a fabricated row)', () => {
    expect(portRowsFor(serialize(base()), 'ghost')).toHaveLength(0);
    expect(portRowsFor('{ not json', 'gen')).toHaveLength(0);
  });

  it('portRowsFor carries DECLARED guarantee contributions with provenance (read-only, from the catalog)', () => {
    // An SQS standard queue's out port declares ordering:none + delivery:may-duplicate, both documented (AWS docs).
    const doc: ProjectDoc = {
      schema: 11, id: 'p1', name: 'T',
      instances: [{ id: 'q', type: 'queue.sqs' }],
      wires: [], layout: {}, labels: {}, descriptions: {}, groups: [], components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [], scenarios: [], systemPromises: [],
    };
    const rows = portRowsFor(serialize(doc), 'q');
    const out = rows.find((r) => r.port === 'out');
    expect(out).toBeDefined();
    const ordering = out!.guarantees.find((g) => g.dimension === 'ordering');
    expect(ordering?.token).toBe('none');
    expect(ordering?.provenance).toBe('documented'); // sourced from the AWS SQS docs
    expect(ordering?.source).toMatch(/^https:\/\//);
    // a plain relay port (no guarantee claim) reads as an empty contributions list — no filler
    const gen = portRowsFor(serialize(base()), 'gen');
    expect(gen.find((r) => r.port === 'in')?.guarantees).toEqual([]);
  });

  it('formatTransform reads the pill grammar (×100 / ÷10 / cap / window / p=)', () => {
    expect(formatTransform({ kind: 'ratio', value: 100 })).toBe('×100');
    expect(formatTransform({ kind: 'batch', value: 10 })).toBe('÷10');
    expect(formatTransform({ kind: 'cap', value: 500 })).toBe('cap 500/s');
    expect(formatTransform({ kind: 'window', value: 10000 })).toBe('window 10000ms');
    expect(formatTransform({ kind: 'prob', value: 0.01 })).toBe('p=0.01');
  });

  it('validateTransformValue mirrors engine validity (>0 all; prob ≤ 1)', () => {
    expect(validateTransformValue('ratio', 100)).toBeNull();
    expect(validateTransformValue('ratio', 0)).not.toBeNull();
    expect(validateTransformValue('prob', 0.5)).toBeNull();
    expect(validateTransformValue('prob', 2)).not.toBeNull();
  });
});

describe('changeRanges (native refactor-preview per-change spans)', () => {
  const conc = String(keys.concurrency);

  // Two nodes that BOTH carry a `concurrency` knob — the crux: a change to `b.concurrency` must resolve the value
  // inside b's object, not a's (the first `"concurrency"` in the text).
  const twoNodes = [
    '{',
    '  "schema": 3,',
    '  "id": "p1",',
    '  "name": "T",',
    '  "instances": [',
    '    { "id": "a", "type": "compute.service", "config": { "concurrency": 100 } },',
    '    { "id": "b", "type": "compute.service", "config": { "concurrency": 200 } }',
    '  ],',
    '  "wires": []',
    '}',
  ].join('\n');

  it('locates the value span of a knob and quantizes the target', () => {
    const r = changeRanges(twoNodes, [{ node: 'a', key: conc, to: 128 }]);
    expect(r).not.toBeNull();
    expect(r!).toHaveLength(1);
    const e = r![0]!;
    // The located span is exactly the current numeric value (100), and the quantized concurrency (integer) is 128.
    expect(twoNodes.slice(e.start, e.end)).toBe('100');
    expect(e.value).toBe(128);
  });

  it('resolves a key that appears on TWO nodes within the RIGHT instance block', () => {
    // The value for b.concurrency must be the SECOND `concurrency` (200), never the first (100).
    const r = changeRanges(twoNodes, [{ node: 'b', key: conc, to: 300 }]);
    expect(r).not.toBeNull();
    const e = r![0]!;
    expect(twoNodes.slice(e.start, e.end)).toBe('200');
    // Sanity: the span sits AFTER node a's block (i.e. we didn't match the first occurrence).
    expect(e.start).toBeGreaterThan(twoNodes.indexOf('"id": "b"'));
  });

  it('ceils a discrete (whole-unit) knob UP, matching applyChanges quantization', () => {
    const r = changeRanges(twoNodes, [{ node: 'a', key: conc, to: 3.2 }]);
    expect(r).not.toBeNull();
    expect(r![0]!.value).toBe(4); // concurrency is discrete → ceil (never under-provision)
  });

  it('rounds a continuous knob to 2 decimals', () => {
    const doc = '{"instances":[{"id":"a","type":"compute.service","config":{"unitCost":10}}]}';
    const r = changeRanges(doc, [{ node: 'a', key: String(keys.unitCost), to: 12.3456 }]);
    expect(r).not.toBeNull();
    expect(r![0]!.value).toBe(12.35);
  });

  it('returns null when the node is absent (caller falls back to whole-document)', () => {
    expect(changeRanges(twoNodes, [{ node: 'ghost', key: conc, to: 5 }])).toBeNull();
  });

  it('returns null when the key is missing on the target node', () => {
    // Node a has concurrency but NOT replicas → asking for a.replicas cannot locate a range.
    expect(changeRanges(twoNodes, [{ node: 'a', key: String(keys.replicas), to: 2 }])).toBeNull();
  });

  it('returns null (all-or-nothing) if ANY change in the batch cannot be located', () => {
    const r = changeRanges(twoNodes, [
      { node: 'a', key: conc, to: 10 }, // locatable
      { node: 'ghost', key: conc, to: 10 }, // not
    ]);
    expect(r).toBeNull();
  });

  it('does not match a knob in a DIFFERENT node when the target node lacks it', () => {
    // Only node b has a `replicas` knob; a change to a.replicas must be null (never borrow b's value).
    const mixed = '{"instances":[{"id":"a","type":"compute.service","config":{"concurrency":50}},{"id":"b","type":"compute.service","config":{"replicas":4}}]}';
    expect(changeRanges(mixed, [{ node: 'a', key: String(keys.replicas), to: 2 }])).toBeNull();
    const okB = changeRanges(mixed, [{ node: 'b', key: String(keys.replicas), to: 8 }]);
    expect(okB).not.toBeNull();
    expect(mixed.slice(okB![0]!.start, okB![0]!.end)).toBe('4');
  });

  it('tolerates the minified `"key":N` spacing', () => {
    const min = '{"instances":[{"id":"a","type":"compute.service","config":{"concurrency":42}}]}';
    const r = changeRanges(min, [{ node: 'a', key: conc, to: 99 }]);
    expect(r).not.toBeNull();
    expect(min.slice(r![0]!.start, r![0]!.end)).toBe('42');
  });

  it('locates a decimal value span', () => {
    const doc = '{"instances":[{"id":"a","type":"compute.service","config":{"unitCost":12.5}}]}';
    const r = changeRanges(doc, [{ node: 'a', key: String(keys.unitCost), to: 20 }]);
    expect(r).not.toBeNull();
    expect(doc.slice(r![0]!.start, r![0]!.end)).toBe('12.5');
  });
});

describe('setRangeText (native per-instance uncertainty RANGE editing, doc: uncertainty-monte-carlo §2)', () => {
  // A two-node design: `svc` (a compute.service, config knobs concurrency/perRequestDuration/unitCost/…) takes the
  // ranges; `logs` (a db.postgres) keeps a percentile SLO so we also prove an unrelated Map survives a range edit
  // (the same losslessness setTransformText guarantees). The range grammar itself lives in @sda/presenter's
  // parseRangeInput (proven in range-input.test.ts); here we prove the DOCUMENT edit it produces is byte-clean.
  const base = (): ProjectDoc => ({
    schema: 11, id: 'p1', name: 'Test',
    instances: [
      { id: 'svc', type: 'compute.service', config: { concurrency: 500, perRequestDuration: 20 } },
      { id: 'logs', type: 'db.postgres', bands: [{ key: keys.tailLatency, band: { shape: 'percentiles', targets: new Map([['p99', 300]]) } }] },
    ],
    wires: [], layout: {}, labels: {}, descriptions: {}, groups: [], components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [], scenarios: [], systemPromises: [],
  });

  const rangesOf = (text: string, node: string) => {
    const parsed = deserialize(text);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value.instances.find((i) => i.id === node)?.ranges ?? {};
  };

  it('adds a ranges record (UNIFORM "lo-hi") to a node that had none', () => {
    const r = setRangeText(serialize(base()), 'svc', 'perRequestDuration', '15-30');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(rangesOf(r.text, 'svc')).toEqual({ perRequestDuration: { lo: 15, hi: 30 } });
  });

  it('adds a TRIANGULAR "lo-mode-hi" range', () => {
    const r = setRangeText(serialize(base()), 'svc', 'perRequestDuration', '10-20-40');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(rangesOf(r.text, 'svc')).toEqual({ perRequestDuration: { lo: 10, mode: 20, hi: 40 } });
  });

  it('upserts an existing key in place rather than duplicating it', () => {
    const first = setRangeText(serialize(base()), 'svc', 'concurrency', '400-600');
    if (!first.ok) throw new Error('setup');
    const again = setRangeText(first.text, 'svc', 'concurrency', '300-500-700');
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(rangesOf(again.text, 'svc')).toEqual({ concurrency: { lo: 300, mode: 500, hi: 700 } });
  });

  it('keeps other keys\' ranges when editing one', () => {
    const one = setRangeText(serialize(base()), 'svc', 'concurrency', '400-600');
    if (!one.ok) throw new Error('setup');
    const two = setRangeText(one.text, 'svc', 'perRequestDuration', '15-30');
    expect(two.ok).toBe(true);
    if (!two.ok) return;
    expect(rangesOf(two.text, 'svc')).toEqual({ concurrency: { lo: 400, hi: 600 }, perRequestDuration: { lo: 15, hi: 30 } });
  });

  it('a BLANK input clears the range and, if it was the last, leaves NO empty ranges artifact', () => {
    const set = setRangeText(serialize(base()), 'svc', 'concurrency', '400-600');
    if (!set.ok) throw new Error('setup');
    const cleared = setRangeText(set.text, 'svc', 'concurrency', '   ');
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(Object.keys(rangesOf(cleared.text, 'svc'))).toHaveLength(0);
    expect(cleared.text).not.toContain('"ranges": {}'); // no stray empty object
    expect(deserialize(cleared.text).ok).toBe(true); // still round-trips
  });

  it('an UNSOUND range (lo>hi) fails with rangeProblem\'s reason — never a silent clamp, never a corrupt write', () => {
    const r = setRangeText(serialize(base()), 'svc', 'concurrency', '600-400');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/must bracket/);
  });

  it('a triangular mode OUTSIDE [lo,hi] is rejected honestly', () => {
    const r = setRangeText(serialize(base()), 'svc', 'concurrency', '400-900-600');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/mode 900 is outside/);
  });

  it('a MALFORMED input is a guided error naming the accepted forms', () => {
    const r = setRangeText(serialize(base()), 'svc', 'concurrency', 'abc');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/uniform "lo-hi".*triangular "lo-mode-hi"/);
  });

  it('preserves a percentile SLO on ANOTHER node while editing a range', () => {
    const r = setRangeText(serialize(base()), 'svc', 'concurrency', '400-600');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = deserialize(r.text);
    const band = parsed.ok ? parsed.value.instances.find((i) => i.id === 'logs')?.bands?.[0]?.band : undefined;
    expect(band && band.shape === 'percentiles' && band.targets.get('p99')).toBe(300);
  });

  it('fails honestly for an unknown node (never writes a corrupt doc)', () => {
    const r = setRangeText(serialize(base()), 'ghost', 'concurrency', '1-2');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('ghost');
  });

  it('fails honestly on invalid JSON', () => {
    expect(setRangeText('{ not json', 'svc', 'concurrency', '1-2').ok).toBe(false);
  });

  it('clearing a range on a key that has none is a no-op that still round-trips', () => {
    const r = setRangeText(serialize(base()), 'svc', 'concurrency', '');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = deserialize(r.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const svc = parsed.value.instances.find((i) => i.id === 'svc')!;
    expect('ranges' in svc).toBe(false); // no empty ranges field introduced
  });
});

describe('rangeRowsFor / rangeMapFor (pure range readers for the Inspector + InputBox seed)', () => {
  const base = (): ProjectDoc => ({
    schema: 11, id: 'p1', name: 'T',
    instances: [{ id: 'svc', type: 'compute.service', config: { concurrency: 500 }, ranges: { concurrency: { lo: 400, hi: 600 }, perRequestDuration: { lo: 10, mode: 20, hi: 40 } } }],
    wires: [], layout: {}, labels: {}, descriptions: {}, groups: [], components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [], scenarios: [], systemPromises: [],
  });

  it('lists a node\'s ranges sorted by key with the ±(…) display and the editable seed', () => {
    const rows = rangeRowsFor(serialize(base()), 'svc');
    expect(rows.map((r) => r.key)).toEqual(['concurrency', 'perRequestDuration']); // sorted, stable
    const conc = rows.find((r) => r.key === 'concurrency')!;
    expect(conc.display).toBe('±(400–600)');
    expect(conc.seed).toBe('400-600'); // round-trips through parseRangeInput
    const dur = rows.find((r) => r.key === 'perRequestDuration')!;
    expect(dur.display).toBe('±(10–20–40)');
    expect(dur.seed).toBe('10-20-40');
  });

  it('rangeMapFor gives an O(1) key → Range lookup for the Inspector annotation', () => {
    const map = rangeMapFor(serialize(base()), 'svc');
    expect(map.get('concurrency')).toEqual({ lo: 400, hi: 600 });
    expect(map.has('perRequestDuration')).toBe(true);
    expect(map.has('unitCost')).toBe(false); // un-ranged knob has no entry
  });

  it('returns [] / an empty map for a node with no ranges, an unknown node, or unparseable text', () => {
    const noRanges: ProjectDoc = { ...base(), instances: [{ id: 'svc', type: 'compute.service' }] };
    expect(rangeRowsFor(serialize(noRanges), 'svc')).toHaveLength(0);
    expect(rangeRowsFor(serialize(base()), 'ghost')).toHaveLength(0);
    expect(rangeRowsFor('{ not json', 'svc')).toHaveLength(0);
    expect(rangeMapFor('{ not json', 'svc').size).toBe(0);
  });
});

describe('configKnobsFor (catalog-backed knob picker for the sda.setRange palette path)', () => {
  const base = (): ProjectDoc => ({
    schema: 11, id: 'p1', name: 'T',
    instances: [{ id: 'svc', type: 'compute.service', config: { concurrency: 750 }, ranges: { perRequestDuration: { lo: 10, hi: 40 } } }],
    wires: [], layout: {}, labels: {}, descriptions: {}, groups: [], components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [], scenarios: [], systemPromises: [],
  });

  it('lists the manifest config knobs with the human label + current value + unit', () => {
    const knobs = configKnobsFor(serialize(base()), 'svc');
    const conc = knobs.find((k) => k.key === 'concurrency');
    expect(conc).toBeDefined();
    expect(conc!.label).toBe('Concurrency');
    expect(conc!.value).toBe(750); // the instance config override wins over the manifest default
  });

  it('annotates a knob that carries a declared range, and leaves un-ranged knobs with no range', () => {
    const knobs = configKnobsFor(serialize(base()), 'svc');
    expect(knobs.find((k) => k.key === 'perRequestDuration')!.range).toEqual({ lo: 10, hi: 40 });
    expect(knobs.find((k) => k.key === 'concurrency')!.range).toBeUndefined();
  });

  it('returns [] for an unknown node or unparseable text (never a fabricated knob)', () => {
    expect(configKnobsFor(serialize(base()), 'ghost')).toHaveLength(0);
    expect(configKnobsFor('{ not json', 'svc')).toHaveLength(0);
  });

  it('does NOT offer a HIDDEN knob (assumedRps) — the manifest folds it in, the picker suppresses it', () => {
    const knobs = configKnobsFor(serialize(base()), 'svc');
    expect(knobs.some((k) => k.key === 'assumedRps')).toBe(false);
    expect(knobs.some((k) => k.label === 'Assumed traffic')).toBe(false);
  });
});
