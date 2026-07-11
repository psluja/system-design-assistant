import { describe, it, expect } from 'vitest';
import { Studio, serialize, deserialize } from '@sda/core';
import { registry, allManifests, keys } from '@sda/content';
import { swapTypeText } from './compare-host';

// Pure coverage for the compare-host's set_type swap. `swapTypeText` is the vscode-free core of the
// `sda.compareOptions` apply path (the command wraps it in a WorkspaceEdit with a confirmation preview). The
// compare RUN itself (runCompare) needs native minizinc + clingo and is exercised end-to-end by @sda/mcp's
// compare-options.test.ts + the in-VS-Code integration suite; here we lock the document-edit semantics, which
// must match @sda/core `setType` exactly (keep id/wires/SLOs, drop capacity config) on every shell.

/** A minimal on-disk design (via the real serializer) with a compute node that carries capacity config + an SLO. */
function seed(): string {
  const s = new Studio(registry, allManifests);
  s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
  s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.faas' });
  s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['svc', 'in'] });
  s.dispatch({ kind: 'setConfig', node: 'svc', key: 'concurrency', value: 42 });
  s.dispatch({ kind: 'setSLO', node: 'svc', key: keys.throughput, band: { shape: 'minTargetMax', min: 3000 } });
  return serialize(s.project());
}

describe('swapTypeText (set_type swap as a document edit)', () => {
  it('swaps the type, KEEPS id + wires + SLO bands, and DROPS capacity config', () => {
    const before = seed();
    const r = swapTypeText(before, 'svc', 'compute.fargate');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.from).toBe('compute.faas'); // reports the old type for the preview label

    const doc = deserialize(r.text);
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    const svc = doc.value.instances.find((i) => i.id === 'svc');
    expect(svc?.type).toBe('compute.fargate'); // new type
    expect(svc?.config).toBeUndefined(); // capacity config reset — the new service has its own knobs
    // the SLO band survives the swap (a requirement lives on the node, not the type)
    expect(svc?.bands?.some((b) => b.key === keys.throughput)).toBe(true);
    // the wire is untouched (id preserved, so references hold)
    expect(doc.value.wires.some((w) => w.from[0] === 'client' && w.to[0] === 'svc')).toBe(true);
  });

  it('fails honestly for an unknown node', () => {
    const r = swapTypeText(seed(), 'ghost', 'compute.fargate');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('ghost');
  });

  it('fails honestly for an unknown component type (validated by the command core)', () => {
    const r = swapTypeText(seed(), 'svc', 'not.a.real.type');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('not.a.real.type');
  });

  it('fails honestly on a non-JSON document', () => {
    const r = swapTypeText('this is not json', 'svc', 'compute.fargate');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('valid JSON');
  });
});
