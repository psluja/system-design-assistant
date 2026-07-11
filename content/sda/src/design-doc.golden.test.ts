import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { NodeId, type Key } from '@sda/engine-core';
import { evaluate } from '@sda/engine-solve';
import { generateDesignDoc, instantiate, manifests, registry, keys, nodeQueues, realCumulativeLatency, responseLatency, realAwareVerdicts, type Instance, type Wire } from './index';

// GOLDEN COMPAT (doc: design-doc-v2 R1) — the Markdown renderer refit must NOT change the pre-v2 document for the
// sections it already had. This pins the LEGACY generateDesignDoc output (no `catalog` passed) byte-for-byte
// against a fixture captured BEFORE the refactor. A change here means the refit altered the existing document —
// the one thing R1 forbids. (New v2 sections only appear when `catalog` is supplied; see the doc-model tests.)
describe('design-doc Markdown golden (byte-compat with pre-v2)', () => {
  const instances: Instance[] = [
    { id: 'client', type: 'client.source' },
    { id: 'gw', type: 'gateway.api', config: { availability: 0.9995 } },
    { id: 'compute', type: 'compute.faas', config: { concurrency: 30 } },
    { id: 'db', type: 'db.sql', bands: [{ key: keys.throughput, band: { shape: 'minTargetMax', target: 1000 } }, { key: keys.availability, band: { shape: 'minTargetMax', min: 0.9999 } }] },
  ];
  const wires: Wire[] = [
    { from: ['client', 'out'], to: ['gw', 'in'] },
    { from: ['gw', 'out'], to: ['compute', 'in'] },
    { from: ['compute', 'out'], to: ['db', 'in'] },
  ];

  it('reproduces the captured golden exactly (no catalog ⇒ pre-v2 output)', () => {
    const built = instantiate(manifests, instances, wires);
    if (!built.ok) throw new Error('graph build failed');
    const r = evaluate(built.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    const value = (id: string, k: Key): number | undefined => r.value.value(NodeId(id), k);
    const q = nodeQueues(built.value, value);
    const verdicts = realAwareVerdicts(r.value.verdicts, built.value, value, q);
    const md = generateDesignDoc({
      name: 'Checkout API',
      instances,
      wires,
      descriptions: { compute: 'runs the checkout command' },
      verdicts,
      value,
      realLatencyByNode: Object.fromEntries(realCumulativeLatency(built.value, value, q)),
      responseLatencyByNode: Object.fromEntries(responseLatency(built.value, value, q)),
      saturated: [...q].filter(([, nq]) => nq.rho >= 1).map(([id]) => id),
      tail: { p50: 40, p95: 120, p99: 260 },
    });
    const golden = readFileSync(new URL('./__golden__/design-doc.checkout.md', import.meta.url), 'utf8');
    expect(md).toBe(golden);
  });

  it('appends the v2 sections (assumptions register + risks) ONLY when a catalog is passed', () => {
    const built = instantiate(manifests, instances, wires);
    if (!built.ok) throw new Error('graph build failed');
    const r = evaluate(built.value, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    const value = (id: string, k: Key): number | undefined => r.value.value(NodeId(id), k);
    const golden = readFileSync(new URL('./__golden__/design-doc.checkout.md', import.meta.url), 'utf8');

    const withCatalog = generateDesignDoc({ name: 'Checkout API', instances, wires, verdicts: r.value.verdicts, value, catalog: manifests });
    // The whole pre-v2 body is preserved (the golden's sections are still there verbatim, up to the new tail).
    expect(withCatalog).toContain('## 1. Context & background');
    expect(withCatalog).toContain('## Completeness (doc-7 gating sections)');
    // The two NEW v2 sections are appended.
    expect(withCatalog).toContain('## Assumptions & parameters register');
    expect(withCatalog).toContain('## Risks & open questions');
    // A doc WITHOUT catalog has neither (byte-compat) — the golden itself carries neither.
    expect(golden).not.toContain('## Assumptions & parameters register');
    expect(golden).not.toContain('## Risks & open questions');
  });
});
