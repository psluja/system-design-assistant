import { describe, it, expect } from 'vitest';
import { Studio, serialize, deserialize } from '@sda/core';
import { registry, allManifests, keys } from '@sda/content';
import { setScenarioOverrideText, clearScenarioOverrideText, setConfigValue } from './document-edits';
import { worldOverridesFor, knobOverridable } from './scenario-lens';
import { activeLensFeedSection, readActiveLensFeed, stripActiveLensFeed, ACTIVE_LENS_FEED_TITLE } from './lens-feed';
import { newDesignName } from './pure';
import type { SummarySection } from './protocol';

// THE CONSISTENCY RELIGION — the VS Code pin (owner: "spójność to religia — to co widzę jest tym, co jest faktycznie").
// The native Inspector must ROUTE a fact-assumption edit INTO the world the canvas is showing (the active lens), NOT
// the shared base — one form with the web shell. These cover the pure seams the host command composes: the lens
// side-channel (lens-feed), the world-aware document edit (setScenarioOverrideText, via the exact @sda/core reducer),
// the overridability gate + the world-value read the Inspector shows, and the un-freeze/remove clear.

// a source client's declared demand is the UNIFIED `assumedRps` knob (its historical `throughput`-as-
// workload preset is gone) — the ONLY key a world/scenario can actually move on it. `SVC_CAP` stays `throughput`
// for the UNRELATED "a computed capacity is never overridable" check on the downstream service.
const DEMAND = String(keys.assumedRps);
const SVC_CAP = String(keys.throughput);

/** A minimal real design: a SOURCE client (its assumedRps IS overridable demand) → service → db, with a `real`
 *  world that overrides the client's demand (provenance `derived` — the live-tracking auto-value). */
function fixtureText(): string {
  const s = new Studio(registry, allManifests);
  s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
  s.dispatch({ kind: 'addComponent', id: 'svc', type: 'compute.service' });
  s.dispatch({ kind: 'addComponent', id: 'db', type: 'db.postgres' });
  s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['svc', 'in'] });
  s.dispatch({ kind: 'connect', from: ['svc', 'db'], to: ['db', 'in'] });
  s.dispatch({ kind: 'setConfig', node: 'client', key: DEMAND, value: 1000 }); // a base demand to prove it stays untouched
  s.dispatch({ kind: 'declareScenario', decl: { id: 'real', name: 'Real', overrides: [{ node: 'client', key: DEMAND, value: 3000, provenance: 'derived' }] } });
  return serialize(s.project());
}

describe('the lens side-channel (lens-feed) — the frozen-protocol transport of the active world', () => {
  it('round-trips the active world id through the summary feed, and strips it from what renders', () => {
    const rows: SummarySection[] = [{ title: 'Design', rows: [{ label: 'nodes', value: '3' }] }, activeLensFeedSection('real')];
    expect(readActiveLensFeed(rows)).toBe('real');
    const rendered = stripActiveLensFeed(rows);
    expect(rendered.some((s) => s.title === ACTIVE_LENS_FEED_TITLE)).toBe(false);
    expect(rendered).toHaveLength(1); // the reserved control section never reaches the System tree
  });

  it('reads undefined (the base lens) when no reserved section rides the feed', () => {
    expect(readActiveLensFeed([{ title: 'Design', rows: [] }])).toBeUndefined();
    expect(stripActiveLensFeed([{ title: 'Design', rows: [] }])).toHaveLength(1); // nothing to strip
  });
});

describe('the religion pin — a fact-assumption edit lands in the ACTIVE WORLD, base untouched', () => {
  it('setScenarioOverrideText writes the value into THAT world only; the base config is unchanged', () => {
    const text = fixtureText();
    const edit = setScenarioOverrideText(text, 'real', 'client', DEMAND, 4200);
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    const doc = deserialize(edit.text);
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    const world = doc.value.scenarios.find((s) => s.id === 'real')!;
    expect(world.overrides.find((o) => o.node === 'client' && o.key === DEMAND)?.value).toBe(4200); // landed in the world
    expect(doc.value.instances.find((i) => i.id === 'client')?.config?.[DEMAND]).toBe(1000); // BASE untouched — the religion
  });

  it('a manual edit over a live-derived value FREEZES it (derived → architect) — parity with the command core', () => {
    const edit = setScenarioOverrideText(fixtureText(), 'real', 'client', DEMAND, 4200);
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    const world = deserialize(edit.text as string);
    if (!world.ok) return;
    const ov = world.value.scenarios.find((s) => s.id === 'real')!.overrides.find((o) => o.node === 'client' && o.key === DEMAND);
    expect(ov?.provenance).toBe('architect');
  });

  it('refuses a NON-overridable key (a resource limit / computed) with the guided role message', () => {
    // A service's throughput is a COMPUTED capacity, not overridable demand — the reducer refuses it, host-side too.
    const edit = setScenarioOverrideText(fixtureText(), 'real', 'svc', SVC_CAP, 9000);
    expect(edit.ok).toBe(false);
  });

  it("refuses the RETIRED throughput spelling even on the source client (: assumedRps is the only demand key)", () => {
    const edit = setScenarioOverrideText(fixtureText(), 'real', 'client', SVC_CAP, 9000);
    expect(edit.ok).toBe(false);
  });
});

describe('the overridability gate + the world-value read the Inspector shows', () => {
  it('knobOverridable is true for a source client assumedRps, false for a computed/limit knob', () => {
    const text = fixtureText();
    expect(knobOverridable(text, 'client', DEMAND)).toBe(true); // a source client's demand — a world belief
    expect(knobOverridable(text, 'client', SVC_CAP)).toBe(false); // the retired spelling — always computed now
    expect(knobOverridable(text, 'svc', SVC_CAP)).toBe(false); // a computed capacity — never a world coordinate
  });

  it('worldOverridesFor reads the active world’s override for the node (its value + provenance)', () => {
    const overrides = worldOverridesFor(fixtureText(), 'real', 'client');
    expect(overrides.get(DEMAND)?.value).toBe(3000);
    expect(overrides.get(DEMAND)?.provenance).toBe('derived');
    expect(worldOverridesFor(fixtureText(), 'real', 'svc').size).toBe(0); // no override on svc
  });
});

describe('the clear — un-freeze vs remove (assumption-model §5.3)', () => {
  it('clearing a DERIVED override REMOVES it (falls back to base)', () => {
    const edit = clearScenarioOverrideText(fixtureText(), 'real', 'client', DEMAND);
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    const doc = deserialize(edit.text);
    if (!doc.ok) return;
    expect(doc.value.scenarios.find((s) => s.id === 'real')!.overrides).toHaveLength(0);
  });

  it('clearing a FROZEN (architect) override UN-FREEZES it back to derived tracking (kept, provenance derived)', () => {
    const frozen = setScenarioOverrideText(fixtureText(), 'real', 'client', DEMAND, 4200); // derived → architect
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    const cleared = clearScenarioOverrideText(frozen.text, 'real', 'client', DEMAND);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    const doc = deserialize(cleared.text);
    if (!doc.ok) return;
    const ov = doc.value.scenarios.find((s) => s.id === 'real')!.overrides.find((o) => o.node === 'client' && o.key === DEMAND);
    expect(ov?.provenance).toBe('derived'); // un-frozen — re-tracks the envelope
  });
});

describe('the base edit still exists (a limit knob edits the shared base, unchanged behaviour)', () => {
  it('setConfigValue writes the shared base config', () => {
    const edit = setConfigValue(fixtureText(), 'client', DEMAND, 2222);
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    const doc = deserialize(edit.text);
    if (!doc.ok) return;
    expect(doc.value.instances.find((i) => i.id === 'client')?.config?.[DEMAND]).toBe(2222);
  });

  it('setConfigValue on a LEGACY-spelled document (config.throughput) still lands the value, migrated to assumedRps', () => {
    // A pre-unification client node (no assumedRps at all, still on the legacy `throughput` preset): setConfigValue
    // deserializes first (migrating throughput → assumedRps), then writes the NEW value onto the now-canonical key.
    const s = new Studio(registry, allManifests);
    s.dispatch({ kind: 'addComponent', id: 'client', type: 'client.web' });
    s.dispatch({ kind: 'setConfig', node: 'client', key: SVC_CAP, value: 500 }); // the legacy spelling, in-memory
    const legacyText = serialize(s.project());
    const edit = setConfigValue(legacyText, 'client', DEMAND, 2222);
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    const doc = deserialize(edit.text);
    if (!doc.ok) return;
    const cfg = doc.value.instances.find((i) => i.id === 'client')?.config;
    expect(cfg?.[DEMAND]).toBe(2222);
    expect(SVC_CAP in (cfg ?? {})).toBe(false);
  });
});

describe('newDesignName — the New-Design flow names the project from its file', () => {
  it('strips the .sda.json / .json suffix and the path, on both separators', () => {
    expect(newDesignName('C:/work/checkout-path.sda.json')).toBe('checkout-path');
    expect(newDesignName('C:\\work\\my-design.sda.json')).toBe('my-design');
    expect(newDesignName('/tmp/plain.json')).toBe('plain');
    expect(newDesignName('.sda.json')).toBe('design'); // degenerate → a safe fallback
  });
});
