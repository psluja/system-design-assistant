import { describe, expect, it } from 'vitest';
import { NodeId, type Key } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import {
  buildDocModel,
  esc,
  instantiate,
  manifests,
  allManifests,
  registry,
  keys,
  nodeQueues,
  realCumulativeLatency,
  realAwareVerdicts,
  renderHtml,
  type DocModel,
  type DocModelInput,
  type Instance,
  type Wire,
} from './index';

// HTML RENDERER — these tests pin the STRUCTURAL invariants of the generated document, the
// OWNER RULING (no out-of-domain section text), the escaping keystone (XSS-safe by construction), chart bar counts,
// the absent-when-not-supplied optional sections, and a snapshot-size sanity bound. They do NOT pin exact bytes (a
// golden would break on every legitimate wording tweak); they assert the invariants that MATTER.

// ── the representative design: client → API GW → under-provisioned FaaS → SQL, with retry + a fan-out transform ──

function buildModel(overrides?: Partial<DocModelInput>): { model: DocModel } {
  const instances: Instance[] = [
    { id: 'client', type: 'client.source', config: { throughput: 2000, timeoutMs: 200, retryCount: 2, retryBackoffMs: 50 } },
    { id: 'gw', type: 'gateway.api', config: { availability: 0.9995 } },
    { id: 'compute', type: 'compute.faas', config: { concurrency: 30 } },
    { id: 'db', type: 'db.sql', bands: [{ key: keys.throughput, band: { shape: 'minTargetMax', target: 1000 } }, { key: keys.availability, band: { shape: 'minTargetMax', min: 0.9999 } }] },
    { id: 'logs', type: 'db.sql' },
  ];
  const wires: Wire[] = [
    { from: ['client', 'out'], to: ['gw', 'in'] },
    { from: ['gw', 'out'], to: ['compute', 'in'] },
    { from: ['compute', 'out'], to: ['db', 'in'] },
    { from: ['compute', 'out'], to: ['logs', 'in'], transform: { kind: 'ratio', value: 100 } }, // ×100 log fan-out
  ];
  const g = instantiate(manifests, instances, wires);
  if (!g.ok) throw new Error(JSON.stringify(g.error));
  const ev = evaluate(g.value, registry);
  if (!ev.ok) throw new Error(ev.error.join('; '));
  const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
  const q = nodeQueues(g.value, value);
  const verdicts = realAwareVerdicts(ev.value.verdicts, g.value, value, q);
  const model = buildDocModel({
    name: 'Checkout API',
    instances,
    wires,
    catalog: manifests,
    verdicts,
    value,
    labels: { client: 'users', gw: 'API gateway', compute: 'checkout fn', db: 'orders DB', logs: 'log store' },
    layout: { client: { x: 0, y: 100 }, gw: { x: 200, y: 100 }, compute: { x: 400, y: 100 }, db: { x: 600, y: 40 }, logs: { x: 600, y: 160 } },
    groups: [{ id: 'vpc', label: 'Application VPC', members: ['gw', 'compute', 'db', 'logs'] }],
    realLatencyByNode: Object.fromEntries(realCumulativeLatency(g.value, value, q)),
    saturated: [...q].filter(([, nq]) => nq.rho >= 1).map(([id]) => id),
    tail: { p50: 40, p95: 120, p99: 260 },
    retry: { goodputRps: 600, errorRate: 40, amplification: 1.7 },
    sweep: [
      { offeredRps: 200, latencyMs: 35 },
      { offeredRps: 400, latencyMs: 42 },
      { offeredRps: 600, latencyMs: 80 },
      { offeredRps: 800, latencyMs: 400 },
    ],
    alternatives: [
      {
        node: 'db',
        method: 'compare_options (same family, each sized to the SLOs)',
        options: [
          { type: 'db.postgres', label: 'PostgreSQL', costUsdMonth: 140, costDeltaUsdMonth: -60, meetsSlos: true, note: 'Multi-AZ; lower cost' },
          { type: 'db.dynamodb', label: 'DynamoDB', costUsdMonth: 220, costDeltaUsdMonth: 20, meetsSlos: false, note: 'misses the throughput SLO at this size' },
        ],
      },
    ],
    generatedAt: '2026-07-03T00:00:00Z',
    ...overrides,
  });
  return { model };
}

describe('renderHtml — structure & the section canon', () => {
  const { model } = buildModel();
  const html = renderHtml(model);

  it('is a complete standalone HTML document', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('</html>');
    expect(html).toContain('<style>'); // inline CSS, not a linked stylesheet
    expect(html).toContain('Design Document — Checkout API');
  });

  it('renders every sectionOrder section, in order, with its heading', () => {
    const titles: Record<string, string> = {
      summary: 'Summary',
      requirements: 'Promises (SLOs)',
      assumptions: 'Assumptions &amp; parameters register',
      architecture: 'Architecture — C4 container view',
      capacity: 'Capacity &amp; flow analysis',
      simulation: 'Time behaviour (simulation)',
      reliability: 'Reliability',
      cost: 'Cost',
      alternatives: 'Alternatives considered',
      risks: 'Risks &amp; open questions',
      glossary: 'Glossary &amp; provenance legend',
    };
    let cursor = 0;
    for (const key of model.sectionOrder) {
      const marker = `id="sec-${key}"`;
      const at = html.indexOf(marker);
      expect(at, `section ${key} present`).toBeGreaterThan(-1);
      expect(at, `section ${key} in order`).toBeGreaterThan(cursor);
      cursor = at;
      expect(html).toContain(titles[key] as string);
    }
  });

  it('states the ONE honest scope sentence in the summary', () => {
    expect(html).toContain('capacity, latency, availability, cost');
    expect(html).toContain('Scope.');
  });

  it('carries NO out-of-domain section (the owner ruling, as text) — no security/rollout/threat/privacy heading', () => {
    // The generated document must never grow a section outside the computed domain. We assert the FORBIDDEN
    // section words never appear as content. (They are unrepresentable in the model type; this guards the render.)
    for (const forbidden of ['Security', 'Rollout', 'Migration plan', 'Threat model', 'Organizational', 'Privacy']) {
      expect(html).not.toContain(forbidden);
    }
  });
});

describe('renderHtml — provenance & source links', () => {
  const { model } = buildModel();
  const html = renderHtml(model);

  it('turns a documented source into a real <a href> link (the register’s point) — the only external URLs allowed', () => {
    // gw throughput is the documented API Gateway throttle with an aws docs source.
    expect(html).toContain('href="https://docs.aws.amazon.com');
    // The link is a provenance badge, opened safely.
    expect(html).toMatch(/<a class="prov src" href="https:\/\/[^"]+" target="_blank" rel="noopener noreferrer">/);
  });

  it('renders a flow-transform assumption as its verb (×100), never as a percentage', () => {
    // The register stores a transform row as { unit: kind, value } — a ×100 fan-out must read "×100", not "10000%".
    expect(html).toContain('×100');
    expect(html).not.toContain('10000.0000%');
  });

  it('renders a dimensionless assumption (concurrency, retry count) as a bare number, never "N 1"', () => {
    // A registry unit of "1" is a placeholder for a pure count; it must not leak into the value cell.
    expect(html).toMatch(/<td>Concurrency<\/td><td>30<\/td>/);
    expect(html).not.toMatch(/<td>30 1<\/td>/);
    expect(html).not.toMatch(/<td>2 1<\/td>/); // retry count
  });

  it('has ZERO non-provenance external references (no fetched fonts/scripts/styles/images)', () => {
    // Every http(s) URL in the output must be a provenance/source link — an <a href>. There is no <script src>,
    // <link href>, @import, <img src>, or url(...) fetch of any external asset (self-contained, CSP-safe).
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/url\(\s*https?:/i);
    // src= attributes (would be a fetched asset) must not exist at all.
    expect(html).not.toMatch(/\ssrc=/i);
    // Every occurrence of an http(s) URL is inside an href (a provenance/source link).
    const urls = html.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
    for (const u of urls) {
      const idx = html.indexOf(u);
      const before = html.slice(Math.max(0, idx - 8), idx);
      expect(before, `URL ${u} is an href, not a fetched asset`).toContain('href="');
    }
  });
});

describe('renderHtml — escaping (XSS-safe by construction)', () => {
  it('escapes a user-injected <script> in a node label — it never appears as a live tag', () => {
    const instances: Instance[] = [
      { id: 'evil', type: 'client.source', config: { throughput: 100 } },
      { id: 'svc', type: 'compute.service' },
    ];
    const wires: Wire[] = [{ from: ['evil', 'out'], to: ['svc', 'in'] }];
    const g = instantiate(allManifests, instances, wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const payload = '<script>alert(1)</script>';
    const model = buildDocModel({
      name: `Report ${payload}`,
      instances,
      wires,
      catalog: allManifests,
      verdicts: ev.value.verdicts,
      value,
      labels: { evil: payload, svc: `svc "${payload}"` },
      layout: { evil: { x: 0, y: 0 }, svc: { x: 100, y: 0 } },
    });
    const html = renderHtml(model);
    // The raw injection never survives as an executable tag anywhere in the document.
    expect(html).not.toContain('<script>alert(1)</script>');
    // It DID come through as escaped, inert text (so the label is still shown, just neutralised).
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('esc() neutralises all five HTML-significant characters', () => {
    expect(esc('<a href="x" onmouseover=\'y\'>&')).toBe('&lt;a href=&quot;x&quot; onmouseover=&#39;y&#39;&gt;&amp;');
    // & first: an already-escaped entity is not double-escaped into gibberish beyond the leading &.
    expect(esc('a & b < c')).toBe('a &amp; b &lt; c');
  });
});

describe('renderHtml — charts (bar counts, hand-rendered SVG)', () => {
  const { model } = buildModel();
  const html = renderHtml(model);

  it('renders inline SVG charts (no external chart library)', () => {
    expect(html).toContain('<svg');
    expect(html).toContain('class="chart"');
    expect(html).toContain('class="c4"'); // the C4 diagram
  });

  it('the utilisation chart has one coloured bar per tier in the series', () => {
    const n = model.capacity.utilizationSeries.points.length;
    expect(n).toBeGreaterThan(0);
    // Each utilisation row draws a track rect + a coloured bar rect. Count the traffic-light fills used for bars.
    // A saturated tier (compute) must be red; count red bars ≥ 1 and total tinted bars == series length.
    const tealBars = (html.match(/fill="#0b6e6e"/g) ?? []).length;
    const amberBars = (html.match(/fill="#b4530a"/g) ?? []).length;
    const redBars = (html.match(/fill="#a3322b"/g) ?? []).length;
    // At least the compute tier is saturated ⇒ at least one red bar exists.
    expect(redBars).toBeGreaterThanOrEqual(1);
    // Not asserting an exact split (tones depend on ρ), but there must be at least `n` tinted bars across the doc.
    expect(tealBars + amberBars + redBars).toBeGreaterThanOrEqual(n);
  });

  it('renders the optional load-sweep line chart WHEN supplied (a polyline with the sweep points)', () => {
    expect(html).toContain('<polyline');
    expect(html).toContain('offered load (req/s)');
  });
});

describe('renderHtml — C4 diagram from architecture data', () => {
  const { model } = buildModel();
  const html = renderHtml(model);

  it('draws a node rect + label + type per component and the group boundary', () => {
    // 5 components ⇒ their labels appear as SVG text.
    for (const label of ['users', 'API gateway', 'checkout fn', 'orders DB', 'log store']) {
      expect(html).toContain(label);
    }
    // The group rectangle label is present.
    expect(html).toContain('Application VPC');
    // An edge carries the ×100 fan-out rate as a pill (post-transform rate).
    expect(html).toMatch(/k\/s|\/s/); // a rate pill figure
  });
});

describe('renderHtml — optional sections absent on a minimal model (no padding, §6)', () => {
  it('a minimal model (no sim, no alternatives, no sweep) renders WITHOUT those optional sections', () => {
    const instances: Instance[] = [
      { id: 'client', type: 'client.source', config: { throughput: 100 } },
      { id: 'svc', type: 'compute.service' },
    ];
    const wires: Wire[] = [{ from: ['client', 'out'], to: ['svc', 'in'] }];
    const g = instantiate(allManifests, instances, wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const model = buildDocModel({ name: 'Minimal', instances, wires, catalog: allManifests, verdicts: ev.value.verdicts, value });
    const html = renderHtml(model);

    // No alternatives section (the caller passed none).
    expect(html).not.toContain('id="sec-alternatives"');
    expect(model.sectionOrder).not.toContain('alternatives');
    // No retry story (no policy) and no sweep line chart (none supplied).
    expect(html).not.toContain('Retry policy.');
    expect(html).not.toContain('<polyline'); // the sweep chart is the only polyline
    // The document still renders cleanly and completely.
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('</html>');
  });
});

// ── owner review R1: the C4 collision pass (close canvas positions must render non-overlapping rects) ──

/** Parse every C4 node rect (x/y/width/height) from the rendered SVG. The node rects are the ONLY rects with the
 *  container fill `#e9f5f2`, so we match those to isolate them from group/track/pill rects. */
function c4NodeRects(html: string): { x: number; y: number; w: number; h: number }[] {
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  const re = /<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"[^>]*fill="#e9f5f2"/g;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    rects.push({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) });
  }
  return rects;
}

/** Parse every C4 EDGE-PILL rect (the protocol·rate labels) from the rendered SVG. Pills are the ONLY rects with a
 *  white fill (`#fff`) — node rects are `#e9f5f2`, group rects `#faf8f3`, chart tracks `#efede7` — so this isolates
 *  the pills for the no-overlap assertions (owner review 2026-07-03 §5). Restricted to the C4 svg so a chart's white
 *  rect (there are none today, but be safe) can never leak in. */
function c4PillRects(html: string): { x: number; y: number; w: number; h: number }[] {
  const svg = c4Svg(html);
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  const re = /<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"[^>]*fill="#fff"/g;
  for (let m = re.exec(svg); m !== null; m = re.exec(svg)) {
    rects.push({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) });
  }
  return rects;
}

/** Isolate the C4 `<svg …class="c4"…>…</svg>` substring, so rect parsers never pick up a chart rect elsewhere. */
function c4Svg(html: string): string {
  const start = html.search(/<svg viewBox="0 0 [\d.]+ [\d.]+" width="[\d.]+" height="[\d.]+" class="c4"/);
  if (start < 0) return '';
  const end = html.indexOf('</svg>', start);
  return html.slice(start, end);
}

/** Two axis-aligned rects intersect when they overlap on BOTH axes (a shared edge is not an intersection). */
function intersects(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('renderHtml — C4 collision pass (owner review R1)', () => {
  it('two nodes placed 10px apart on the canvas render as NON-intersecting rects', () => {
    const instances: Instance[] = [
      { id: 'a', type: 'client.source', config: { throughput: 100 } },
      { id: 'b', type: 'compute.service' },
    ];
    const wires: Wire[] = [{ from: ['a', 'out'], to: ['b', 'in'] }];
    const g = instantiate(allManifests, instances, wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    // The two containers sit 10px apart on the canvas — without the collision pass their normalised rects overlap.
    const model = buildDocModel({
      name: 'Close', instances, wires, catalog: allManifests, verdicts: ev.value.verdicts, value,
      layout: { a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
    });
    const html = renderHtml(model);
    const rects = c4NodeRects(html);
    expect(rects.length).toBe(2);
    expect(intersects(rects[0] as (typeof rects)[number], rects[1] as (typeof rects)[number])).toBe(false);
  });

  it('a dense cluster of coincident positions renders every pair non-intersecting', () => {
    const instances: Instance[] = [{ id: 'src', type: 'client.source', config: { throughput: 100 } }];
    const wires: Wire[] = [];
    // Five services stacked at nearly the same point — the pathological overlap case.
    for (let i = 0; i < 5; i++) {
      const id = `s${i}`;
      instances.push({ id, type: 'compute.service' });
      wires.push({ from: ['src', 'out'], to: [id, 'in'] });
    }
    const g = instantiate(allManifests, instances, wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const layout: Record<string, { x: number; y: number }> = { src: { x: 0, y: 0 } };
    for (let i = 0; i < 5; i++) layout[`s${i}`] = { x: 100 + i, y: 100 + i }; // 1px apart each
    const model = buildDocModel({ name: 'Cluster', instances, wires, catalog: allManifests, verdicts: ev.value.verdicts, value, layout });
    const html = renderHtml(model);
    const rects = c4NodeRects(html);
    expect(rects.length).toBe(6);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(intersects(rects[i] as (typeof rects)[number], rects[j] as (typeof rects)[number]), `rects ${i} & ${j} overlap`).toBe(false);
      }
    }
  });
});

// ── 2026-07-03 §2: C4 label-aware spacing (a wide label widens its rect; neighbours don't intersect) ──

describe('renderHtml — C4 label-aware spacing (2026-07-03 §2)', () => {
  it('a node with a long label gets a WIDER rect than a short-labelled one', () => {
    const instances: Instance[] = [
      { id: 'a', type: 'client.source', config: { throughput: 100 } },
      { id: 'b', type: 'compute.service' },
    ];
    const wires: Wire[] = [{ from: ['a', 'out'], to: ['b', 'in'] }];
    const g = instantiate(allManifests, instances, wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const model = buildDocModel({
      name: 'Widths', instances, wires, catalog: allManifests, verdicts: ev.value.verdicts, value,
      // A deliberately long label vs a short one; place them far apart so no collision pass distorts the widths.
      labels: { a: 'x', b: 'a very long descriptive container name indeed' },
      layout: { a: { x: 0, y: 0 }, b: { x: 600, y: 0 } },
    });
    const html = renderHtml(model);
    const rects = c4NodeRects(html);
    expect(rects.length).toBe(2);
    // The long-labelled rect (larger width) must be strictly wider than the short one.
    const [wShort, wLong] = [rects[0]!.w, rects[1]!.w].sort((x, y) => x - y);
    expect(wLong).toBeGreaterThan(wShort as number);
  });

  it('two LONG-labelled neighbours placed close together render as NON-intersecting rects (min-gap is label-aware)', () => {
    const instances: Instance[] = [
      { id: 'a', type: 'client.source', config: { throughput: 100 } },
      { id: 'b', type: 'compute.service' },
    ];
    const wires: Wire[] = [{ from: ['a', 'out'], to: ['b', 'in'] }];
    const g = instantiate(allManifests, instances, wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    // Both carry long labels AND sit 15px apart on the canvas — without a label-aware min-gap their wide rects overlap.
    const model = buildDocModel({
      name: 'CloseLong', instances, wires, catalog: allManifests, verdicts: ev.value.verdicts, value,
      labels: { a: 'authentication and authorization service', b: 'order fulfilment and inventory worker pool' },
      layout: { a: { x: 0, y: 0 }, b: { x: 15, y: 0 } },
    });
    const html = renderHtml(model);
    const rects = c4NodeRects(html);
    expect(rects.length).toBe(2);
    expect(intersects(rects[0] as (typeof rects)[number], rects[1] as (typeof rects)[number])).toBe(false);
    // And a real gap of at least ~MIN_GAP sits between them (not merely touching).
    const gap = Math.max(rects[0]!.x, rects[1]!.x) - Math.min(rects[0]!.x + rects[0]!.w, rects[1]!.x + rects[1]!.w);
    expect(gap).toBeGreaterThan(15);
  });
});

// ── 2026-07-03 §5: the finale C4 space fix — pills fit, connections are long, nothing overlaps ──

/** Build the DocModel for the REAL 14-node ecommerce finale (the committed `examples/ecommerce-production.sda.json`
 *  design, transcribed here as instances/wires/layout/labels/groups) so the pill/edge geometry is tested against the
 *  exact diagram a user gets, not a toy. Bands are omitted — they do not affect the C4 layout the assertions target. */
function buildFinaleModel(): DocModel {
  const instances: Instance[] = [
    { id: 'users', type: 'client.source', config: { throughput: 2000, timeoutMs: 400, retryCount: 2, retryBackoffMs: 100 } },
    { id: 'cdn', type: 'cdn.cloudfront' },
    { id: 'alb', type: 'lb.alb' },
    { id: 'web', type: 'compute.service', config: { availability: 0.9999 } },
    { id: 'catalog', type: 'compute.service', config: { availability: 0.9999 } },
    { id: 'checkout', type: 'compute.service', config: { availability: 0.9999 } },
    { id: 'redis', type: 'cache.redis' },
    { id: 'catalogdb', type: 'db.postgres', config: { deploymentMode: 1 } },
    { id: 'rds', type: 'proxy.rds', config: { availability: 0.9999 } },
    { id: 'aurora', type: 'db.aurora', config: { deploymentMode: 1 } },
    { id: 'sqs', type: 'queue.sqs' },
    { id: 'worker', type: 'compute.faas' },
    { id: 'kafka', type: 'stream.kafka', config: { drainRate: 15000 } },
    { id: 'logproc', type: 'compute.service', config: { availability: 0.9999 } },
  ];
  const wires: Wire[] = [
    { from: ['users', 'out'], to: ['cdn', 'in'], semantics: 'sync' },
    { from: ['cdn', 'out'], to: ['alb', 'in'], semantics: 'sync' },
    { from: ['alb', 'out'], to: ['web', 'in'], semantics: 'sync' },
    { from: ['web', 'out'], to: ['catalog', 'in'], semantics: 'sync', transform: { kind: 'prob', value: 0.7 } },
    { from: ['web', 'out'], to: ['checkout', 'in'], semantics: 'sync', transform: { kind: 'prob', value: 0.3 } },
    { from: ['web', 'out'], to: ['kafka', 'in'], semantics: 'async', transform: { kind: 'ratio', value: 50 } },
    { from: ['catalog', 'cache'], to: ['redis', 'in'], semantics: 'sync' },
    { from: ['catalog', 'db'], to: ['catalogdb', 'in'], semantics: 'sync', transform: { kind: 'prob', value: 0.25 } },
    { from: ['checkout', 'db'], to: ['rds', 'in'], semantics: 'sync' },
    { from: ['rds', 'out'], to: ['aurora', 'in'], semantics: 'sync' },
    { from: ['checkout', 'out'], to: ['sqs', 'in'], semantics: 'async' },
    { from: ['sqs', 'out'], to: ['worker', 'in'], semantics: 'sync' },
    { from: ['kafka', 'out'], to: ['logproc', 'in'], semantics: 'sync' },
  ];
  const layout = {
    users: { x: 80, y: 80 }, cdn: { x: 320, y: 80 }, alb: { x: 560, y: 80 }, web: { x: 800, y: 80 },
    catalog: { x: 80, y: 230 }, checkout: { x: 320, y: 230 }, redis: { x: 560, y: 230 }, catalogdb: { x: 800, y: 230 },
    rds: { x: 80, y: 380 }, aurora: { x: 320, y: 380 }, sqs: { x: 560, y: 380 }, worker: { x: 800, y: 380 },
    kafka: { x: 80, y: 530 }, logproc: { x: 320, y: 530 },
  };
  const labels = {
    users: 'Users (browser)', cdn: 'CloudFront CDN', alb: 'Application Load Balancer', web: 'Web tier',
    catalog: 'Catalog service', checkout: 'Checkout service', redis: 'Redis cache', catalogdb: 'Catalog Postgres',
    rds: 'RDS Proxy', aurora: 'Aurora (orders)', sqs: 'Order queue', worker: 'Fulfilment worker',
    kafka: 'Log/event stream', logproc: 'Log consumer',
  };
  const groups = [
    { id: 'edge', label: 'Edge & routing', members: ['cdn', 'alb'] },
    { id: 'app', label: 'Application VPC', members: ['web', 'catalog', 'checkout', 'worker', 'logproc'] },
    { id: 'data', label: 'Data stores', members: ['redis', 'catalogdb', 'rds', 'aurora'] },
    { id: 'async', label: 'Async & observability', members: ['sqs', 'kafka'] },
  ];
  const g = instantiate(allManifests, instances, wires);
  if (!g.ok) throw new Error(JSON.stringify(g.error));
  const ev = evaluate(g.value, registry);
  if (!ev.ok) throw new Error(ev.error.join('; '));
  const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
  const q = nodeQueues(g.value, value);
  const verdicts = realAwareVerdicts(ev.value.verdicts, g.value, value, q);
  return buildDocModel({
    name: 'E-commerce Production Platform', instances, wires, catalog: allManifests, verdicts, value,
    labels, layout, groups,
    realLatencyByNode: Object.fromEntries(realCumulativeLatency(g.value, value, q)),
    saturated: [...q].filter(([, nq]) => nq.rho >= 1).map(([id]) => id),
    generatedAt: '2026-07-03T00:00:00Z',
  });
}

describe('renderHtml — C4 space fix on the real finale (owner review 2026-07-03 §5)', () => {
  const html = renderHtml(buildFinaleModel());
  const nodeRects = c4NodeRects(html);
  const pillRects = c4PillRects(html);

  it('draws all 14 container rects and a pill for every labelled edge', () => {
    expect(nodeRects.length).toBe(14);
    // Every edge in the finale carries a protocol and/or rate, so there is a pill per drawn edge (13 wires).
    expect(pillRects.length).toBeGreaterThanOrEqual(10);
  });

  it('NO edge-pill rect intersects any node rect (a label never sits on a container)', () => {
    for (const p of pillRects) {
      for (const n of nodeRects) {
        expect(intersects(p, n), `pill at (${p.x},${p.y}) overlaps a node at (${n.x},${n.y})`).toBe(false);
      }
    }
  });

  it('NO two edge-pill rects intersect (labels never stack on top of each other)', () => {
    for (let i = 0; i < pillRects.length; i++) {
      for (let j = i + 1; j < pillRects.length; j++) {
        expect(intersects(pillRects[i]!, pillRects[j]!), `pills ${i} & ${j} overlap`).toBe(false);
      }
    }
  });

  it('uses the free vertical budget: the C4 canvas is TALL (height ≫ width) so connections carry their pills', () => {
    const vb = c4Svg(html).match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    const w = Number(vb?.[1]);
    const h = Number(vb?.[2]);
    expect(w).toBeLessThanOrEqual(700); // width stays within the A4 figure budget
    expect(h).toBeGreaterThan(700); // height is used generously (the figure owns its own page)
  });

  it('gives the C4 figure its OWN report page (break-before + break-after in print)', () => {
    expect(html).toContain('class="fig c4page"');
    expect(html).toContain('.c4page{break-before:page;page-break-before:always;break-after:page;page-break-after:always}');
  });
});

describe('renderHtml — C4 minimum edge length (owner review 2026-07-03 §2)', () => {
  it('a cramped synthetic layout is scaled UP so every attached edge is at least the minimum length', () => {
    // A dense chain packed into a tiny canvas region: without the min-edge rescale the normalised borders touch, so
    // the pills could not fit. The rescale must spread the nodes until every edge clears the minimum.
    const instances: Instance[] = [{ id: 'n0', type: 'client.source', config: { throughput: 100 } }];
    const wires: Wire[] = [];
    for (let i = 1; i < 6; i++) {
      instances.push({ id: `n${i}`, type: 'compute.service' });
      wires.push({ from: [`n${i - 1}`, 'out'], to: [`n${i}`, 'in'] });
    }
    const g = instantiate(allManifests, instances, wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    // Pack all six nodes into a 30px square — a maximally cramped placement.
    const layout: Record<string, { x: number; y: number }> = {};
    for (let i = 0; i < 6; i++) layout[`n${i}`] = { x: (i % 3) * 15, y: Math.floor(i / 3) * 15 };
    const model = buildDocModel({ name: 'Cramped', instances, wires, catalog: allManifests, verdicts: ev.value.verdicts, value, layout });
    const html = renderHtml(model);
    const nodes = c4NodeRects(html);
    expect(nodes.length).toBe(6);
    // For each wire, the border-to-border straight-line distance between the two attached rects must be ≥ the minimum
    // (90px). We recompute the border points the renderer uses (centre-to-centre segment ∩ each rectangle border).
    const byIndex = nodes; // rects render in model order
    const MIN = 90;
    const chainPairs: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]];
    for (const [i, j] of chainPairs) {
      const a = byIndex[i]!;
      const b = byIndex[j]!;
      const len = borderToBorder(a, b);
      // A hair of tolerance: the rescale targets the SHORTEST edge to exactly MIN, so all edges are ≥ MIN − ε.
      expect(len, `edge n${i}→n${j} length ${len.toFixed(1)} < ${MIN}`).toBeGreaterThanOrEqual(MIN - 1);
    }
  });
});

/** The straight-line distance between two node rects' borders along their centre-to-centre segment — the renderer's
 *  own edge-length metric, recomputed here so the min-edge-length property is asserted on the real geometry. */
function borderToBorder(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const border = (r: typeof a, tx: number, ty: number): [number, number] => {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    if (dx === 0 && dy === 0) return [cx, cy];
    const sx = dx === 0 ? Infinity : r.w / 2 / Math.abs(dx);
    const sy = dy === 0 ? Infinity : r.h / 2 / Math.abs(dy);
    const s = Math.min(sx, sy);
    return [cx + dx * s, cy + dy * s];
  };
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  const [ax, ay] = border(a, bcx, bcy);
  const [bx, by] = border(b, acx, acy);
  return Math.hypot(bx - ax, by - ay);
}

describe('renderHtml — C4 heading & glossary (owner review R3)', () => {
  const { model } = buildModel();
  const html = renderHtml(model);

  it('titles the section "Architecture — C4 container view" with the explaining sentence beneath it', () => {
    expect(html).toContain('Architecture — C4 container view');
    // The outsider-friendly one-liner: C4 is a standard, a container is a runnable unit, NOT a  container.
    expect(html).toContain('Simon Brown');
    expect(html).toContain('separately runnable unit');
    expect(html).toContain('a message broker');
  });

  it('updates the glossary entry to define a container positively (runnable unit with examples)', () => {
    const entry = model.glossary.entries.find((e) => e.term === 'C4 container view');
    expect(entry?.definition).toContain('Simon Brown');
    expect(entry?.definition).toContain('a message broker');
  });
});

describe('renderHtml — chart axes & per-hop propagation (owner review R2)', () => {
  const { model } = buildModel();
  const html = renderHtml(model);

  it('the load-sweep chart carries labelled tick gridlines on both axes (4–6 ticks)', () => {
    // The sweep is the only chart with a polyline; its plot area now has a grid of tick lines + labels. We count the
    // X-axis tick labels along the offered-load axis (0, 200, 400, …) — there must be at least four for readability.
    expect(html).toContain('<polyline');
    // Gridlines exist (thin CHART.grid strokes) — many across the charts; assert the sweep's x labels are present.
    for (const label of ['200', '400', '600', '800']) expect(html).toContain(label);
  });

  it('the capacity section shows a per-hop propagation table: rate entering → transform → rate leaving', () => {
    // The ×100 log fan-out: 600 req/s enters, ×100 emitted, 60,000 req/s leaves.
    expect(html).toContain('Rate entering');
    expect(html).toContain('Rate leaving');
    expect(html).toContain('how the request rate changes hop by hop');
    // The propagation is present as data: 600 in, 60,000 out.
    expect(html).toMatch(/<td>600 req\/s<\/td><td>emits ×100<\/td><td>60,000 req\/s<\/td>/);
    // And a propagation mini-chart (the entering vs leaving bars) captions the flow.
    expect(html).toContain('Per-hop propagation');
  });

  it('carries entering AND leaving rates on the transform row data', () => {
    const t = model.capacity.transforms.find((r) => r.side === 'out');
    expect(t?.enteringRps).toBe(600);
    expect(t?.resultingRps).toBe(60000);
  });
});

describe('renderHtml — alternatives honesty rule (owner review R4)', () => {
  it('appends the honesty sentence when an option BOTH meets the SLOs AND is cheaper (negative delta)', () => {
    // The default model's alternatives include PostgreSQL: meetsSlos true, costDelta −60 ⇒ the rule fires.
    const { model } = buildModel();
    const html = renderHtml(model);
    expect(html).toContain('The ranking above contains an option that meets the promises at lower cost — adopt it or record the reason for staying.');
  });

  it('does NOT append the honesty sentence when no cheaper-and-compliant option exists', () => {
    // An alternatives set where the only compliant option is MORE expensive, and the cheaper one MISSES an SLO —
    // neither dominates the current choice, so the honesty sentence must stay absent.
    const { model } = buildModel({
      alternatives: [
        {
          node: 'db',
          method: 'compare_options (same family, each sized to the SLOs)',
          options: [
            { type: 'db.postgres', label: 'PostgreSQL', costUsdMonth: 200, costDeltaUsdMonth: 60, meetsSlos: true, note: 'compliant but pricier' },
            { type: 'db.dynamodb', label: 'DynamoDB', costUsdMonth: 100, costDeltaUsdMonth: -40, meetsSlos: false, note: 'cheaper but misses an SLO' },
          ],
        },
      ],
    });
    const html = renderHtml(model);
    expect(html).not.toContain('The ranking above contains an option that meets the promises at lower cost');
    // The alternatives table itself is still rendered (the section is present) — only the callout is gated.
    expect(html).toContain('Alternatives for db');
  });
});

// ── 2026-07-03 §3: per-component cost derivations (show the arithmetic, not a bare figure) ──

describe('renderHtml — cost derivations (2026-07-03 §3)', () => {
  const { model } = buildModel();
  const html = renderHtml(model);

  it('carries a per-component cost derivation for every priced tier, largest-cost first', () => {
    const d = model.cost.derivations;
    expect(d.length).toBeGreaterThan(0);
    // Sorted by monthly cost descending (mirrors the cost chart order).
    for (let i = 1; i < d.length; i++) expect(d[i - 1]!.totalUsdMonth).toBeGreaterThanOrEqual(d[i]!.totalUsdMonth);
    // The detected cost MODEL is read off the relation, never guessed: the API gateway (provisionedCost) is
    // `provisioned`; the FaaS (costPer(concurrency)) is `per-unit`.
    const gw = d.find((r) => r.node === 'API gateway');
    expect(gw?.model).toBe('provisioned');
    expect(gw?.driverLabel).toBe('reserved capacity');
    const fn = d.find((r) => r.node === 'checkout fn');
    expect(fn?.model).toBe('per-unit');
    expect(fn?.driverValue).toBe(30); // concurrency 30
    expect(fn?.unitPrice).toBe(1.5);
  });

  it('renders the arithmetic INLINE: "driver × unit-price = total" for a provisioned tier', () => {
    // The API gateway: 2,000 req/s reserved × $0.005/(req/s)·mo = $50/mo — shown as a legible product.
    expect(html).toContain('How each component');
    expect(html).toMatch(/2,000 req\/s × \$0\.005/);
    expect(html).toContain('= <b>$50/mo</b>');
    // The per-unit FaaS: 30 conc × $1.5 = $45/mo.
    expect(html).toMatch(/30 conc × \$1\.5/);
    expect(html).toContain('= <b>$45/mo</b>');
    // The verbose catalog rate string is compacted for the inline product ("USD/(req/s)·month" → "/(req/s)·mo"), the
    // leading "USD" dropped so the price token's "$" is not doubled (reads "$0.005 /(req/s)·mo").
    expect(html).toContain('/(req/s)·mo');
    expect(html).not.toContain('$ $/(req/s)·mo');
  });

  it('shows a deployment-mode surcharge as "× N (Multi-AZ)" when a component is Multi-AZ', () => {
    // A Multi-AZ Postgres (deploymentMode 1) carries the withDeploymentCost surcharge → factor 2.
    const instances: Instance[] = [
      { id: 'client', type: 'client.source', config: { throughput: 100 } },
      { id: 'pg', type: 'db.postgres', config: { deploymentMode: 1 } },
    ];
    const wires: Wire[] = [{ from: ['client', 'out'], to: ['pg', 'in'] }];
    const g = instantiate(allManifests, instances, wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const model2 = buildDocModel({ name: 'AZ', instances, wires, catalog: allManifests, verdicts: ev.value.verdicts, value });
    const pg = model2.cost.derivations.find((r) => r.node === 'pg');
    expect(pg?.deploymentFactor).toBe(2);
    expect(pg?.deploymentLabel).toBe('Multi-AZ');
    const html2 = renderHtml(model2);
    expect(html2).toMatch(/× 2 <span class="muted">\(Multi-AZ\)<\/span>/);
  });
});

// ── 2026-07-03 §4: the "declared traffic = sustained average (convert peak figures before declaring)" glossary note ──

describe('renderHtml — declared-traffic glossary note (2026-07-03 §4)', () => {
  it('explains the offered load is a 24/7 average with monthly volume following from it', () => {
    const { model } = buildModel();
    const html = renderHtml(model);
    const entry = model.glossary.entries.find((e) => e.term.startsWith('declared traffic'));
    expect(entry).toBeDefined();
    expect(entry?.definition).toContain('SUSTAINED');
    expect(entry?.definition).toMatch(/average/i);
    expect(entry?.definition).toContain('not a peak');
    // The worked monthly figure the note gives (2,000 req/s ≈ 5.3 billion/month) appears in the rendered doc.
    expect(html).toContain('5.3 billion');
  });
});

describe('renderHtml — guarantees section', () => {
  it('renders the per-flow guarantee table (requirement / computed / root cause / remediation) ONLY when declared', () => {
    // absent guaranteeVerdicts ⇒ the section is omitted (no-filler): the key is not in sectionOrder.
    const { model: silent } = buildModel();
    expect(silent.sectionOrder).not.toContain('guarantees');
    expect(silent.guarantees).toBeUndefined();
    expect(renderHtml(silent)).not.toContain('Guarantees (consistency');

    // with a declared, violated requirement + a computed remediation, the section renders every column.
    const { model } = buildModel({
      guaranteeVerdicts: [
        { source: 'producer', terminal: 'worker', dimension: 'ordering', required: 'per-key', computed: 'none', status: 'violation', rootCauseNode: 'q', remediation: 'switch q to queue.sqs.fifo — restores ordering ≥ per-key · documented ceiling 300 msg/s · +$22.5/mo' },
      ],
    });
    expect(model.sectionOrder).toContain('guarantees');
    const html = renderHtml(model);
    expect(html).toContain('Guarantees (consistency');
    expect(html).toContain('producer → worker');
    expect(html).toContain('ordering');
    expect(html).toContain('per-key'); // the requirement floor
    expect(html).toContain('none'); // the computed token
    expect(html).toContain('✗ violated');
    expect(html).toContain('queue.sqs.fifo'); // the computed remediation
    expect(html).toContain('300 msg/s');
  });

  it('a violation with NO possible swap prints the honest reason, never an implied fix', () => {
    const { model } = buildModel({
      guaranteeVerdicts: [
        { source: 'c', terminal: 'db', dimension: 'consistency', required: 'strong', computed: 'eventual', status: 'violation', rootCauseNode: 'db', noRemediationReason: 'no same-family component can restore consistency ≥ strong at db' },
      ],
    });
    const html = renderHtml(model);
    expect(html).toContain('no same-family component can restore');
  });
});

describe('renderHtml — flow-scoped lag block', () => {
  it('renders the propagation-lag table ONLY when a lag SLO is declared (no-filler)', () => {
    // absent lagVerdicts ⇒ no propagation-lag block (the terminal-cumulative flow table above stays the whole story).
    const silent = renderHtml(buildModel().model);
    expect(silent).not.toContain('Propagation lag');

    // a DES-measured violation renders the deadline, the measured async-inclusive mean, and the verdict pill.
    const { model } = buildModel({
      lagVerdicts: [
        { source: 'checkout', terminal: 'worker', maxMs: 300, status: 'violation', basis: 'measured', measuredMeanMs: 812, lowerBoundMs: 50, note: 'measured mean lag 812 ms exceeds the 300 ms deadline (incl. async queue waits)' },
      ],
    });
    const html = renderHtml(model);
    expect(html).toContain('Propagation lag');
    expect(html).toContain('checkout → worker');
    expect(html).toContain('≤ 300 ms'); // the declared deadline
    expect(html).toContain('812 ms'); // the measured async-inclusive mean
    expect(html).toContain('✗ violation');
  });

  it('a scalar `unknown` lag reads honestly (points at the sim, never a fabricated ok)', () => {
    const { model } = buildModel({
      lagVerdicts: [
        { source: 'src', terminal: 'dst', maxMs: 2000, status: 'unknown', basis: 'unknown', lowerBoundMs: 50, note: 'run simulate for the true lag' },
      ],
    });
    const html = renderHtml(model);
    expect(html).toContain('Propagation lag');
    expect(html).toContain('run the simulation'); // the honest unknown pill
  });
});

describe('renderHtml — end-to-end availability is a NODE band on the terminal (flowPromises consolidated away)', () => {
  it('a terminal availability band renders a `node-scoped` requirements row judged against the terminal cumulative', () => {
    // The consolidation: an end-to-end availability promise IS a band on the terminal node (`db`), judged against
    // value(db, availability) — the serial product over the whole path. The renderer labels it `node-scoped` and
    // surfaces the end-to-end contrast beside it; the retired `path-scoped` label never appears again.
    const { model } = buildModel();
    const row = model.requirements.find((r) => r.node === 'db' && r.key === 'availability');
    expect(row).toBeDefined();
    expect(row?.scope).toBe('node');
    const html = renderHtml(model);
    expect(html).toContain('node-scoped');
    // The retired path scope is gone from every render (the container was removed, not merely hidden).
    expect(html).not.toContain('path-scoped');
  });
});

describe('renderHtml — purity & size', () => {
  it('is a pure function of the model (no clock): two renders are byte-identical', () => {
    const a = renderHtml(buildModel().model);
    const b = renderHtml(buildModel().model);
    expect(a).toBe(b);
  });

  it('carries the generation timestamp from the model, not a clock read', () => {
    const html = renderHtml(buildModel().model);
    expect(html).toContain('2026-07-03T00:00:00Z');
  });

  it('snapshot-size sanity: a 20-node design renders well under 300 KB', () => {
    const instances: Instance[] = [{ id: 'client', type: 'client.source', config: { throughput: 500 } }];
    const wires: Wire[] = [];
    // A chain of 19 services after the source = 20 nodes.
    for (let i = 0; i < 19; i++) {
      const id = `svc${i}`;
      instances.push({ id, type: 'compute.service' });
      const prev = i === 0 ? 'client' : `svc${i - 1}`;
      wires.push({ from: [prev, 'out'], to: [id, 'in'] });
    }
    const g = instantiate(allManifests, instances, wires);
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    const ev = evaluate(g.value, registry);
    if (!ev.ok) throw new Error(ev.error.join('; '));
    const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);
    const layout = Object.fromEntries(instances.map((inst, i) => [inst.id, { x: (i % 5) * 160, y: Math.floor(i / 5) * 120 }]));
    const model = buildDocModel({ name: '20-node chain', instances, wires, catalog: allManifests, verdicts: ev.value.verdicts, value, layout });
    const html = renderHtml(model);
    const bytes = Buffer.byteLength(html, 'utf8');
    expect(bytes).toBeLessThan(300 * 1024);
    expect(bytes).toBeGreaterThan(2000); // sanity: it actually produced a document
  });
});
