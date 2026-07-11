import { describe, it, expect } from 'vitest';
import { serialize, type ProjectDoc } from '@sda/core';
import { keys } from '@sda/content';
import { buildDesignDocText } from './design-doc-host';

// HOST-SIDE design-doc generation (design-doc-v2 R3). This module is PURE of `vscode` — it compiles the document
// TEXT through @sda/content exactly as the web + MCP surfaces do — so we test it directly under vitest (the same way
// pure.ts is tested). The e2e in test/suite/index.cjs proves the FILE is written next to a real design; here we prove
// the BUILDER: both formats render, the scope sentence is present, and a design that doesn't build returns null.

const checkout = (): ProjectDoc => ({
  schema: 11,
  id: 'p1',
  name: 'Checkout',
  instances: [
    { id: 'client', type: 'client.web', config: { throughput: 1000 } },
    { id: 'app', type: 'compute.service' },
    { id: 'pg', type: 'db.postgres', bands: [{ key: keys.throughput, band: { shape: 'minTargetMax', min: 5000 } }] },
  ],
  wires: [
    { from: ['client', 'out'], to: ['app', 'in'] },
    { from: ['app', 'out'], to: ['pg', 'in'] },
  ],
  layout: { client: { x: 0, y: 0 }, app: { x: 200, y: 0 }, pg: { x: 400, y: 0 } },
  labels: {},
  descriptions: {},
  groups: [],
  components: [], guaranteeSlos: [], lagSlos: [], requestClasses: [], scenarios: [], systemPromises: [],
});

const SCOPE = 'capacity, latency, availability, cost'; // the ONE honest scope sentence, verbatim on every surface

describe('buildDesignDocText — host-side deliverable from document text', () => {
  it('renders the HTML report: a standalone document with the C4 SVG, register and scope sentence', () => {
    const g = buildDesignDocText(serialize(checkout()), 'html');
    expect(g).not.toBeNull();
    if (g === null) return;
    expect(g.format).toBe('html');
    expect(g.text).toContain('<!DOCTYPE html>');
    expect(g.text).toContain('class="c4"'); // the rendered C4 diagram
    expect(g.text).toContain('Assumptions'); // the assumptions register
    expect(g.text).toContain(SCOPE);
    // The §5 load→latency sweep is included for HTML when a traffic origin exists (a client.web here) — its axis label.
    expect(g.text).toContain('offered load (req/s)');
  });

  it('renders Markdown (Mermaid C4, no HTML shell) — the diffable form', () => {
    const g = buildDesignDocText(serialize(checkout()), 'markdown');
    expect(g).not.toBeNull();
    if (g === null) return;
    expect(g.format).toBe('markdown');
    expect(g.text).toContain('# Design Document');
    expect(g.text).toContain('```mermaid');
    expect(g.text).not.toContain('<!DOCTYPE html>');
  });

  it('returns null on unparseable text (an honest "did not build", never an empty document)', () => {
    expect(buildDesignDocText('{ not json', 'html')).toBeNull();
    expect(buildDesignDocText('{ not json', 'markdown')).toBeNull();
  });

  it('is deterministic in its structure (the timestamp aside): the two renders share the same sections', () => {
    // A second build differs only by the minted `generatedAt`; the section headings are identical.
    const a = buildDesignDocText(serialize(checkout()), 'html');
    const b = buildDesignDocText(serialize(checkout()), 'html');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (a === null || b === null) return;
    // Strip any ISO timestamp so the comparison is of the model-derived content, not the surface clock.
    const strip = (s: string): string => s.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'TS');
    expect(strip(a.text)).toBe(strip(b.text));
  });
});
