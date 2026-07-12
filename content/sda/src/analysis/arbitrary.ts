import fc from 'fast-check';
import { manifests, commonManifests, type Instance, type Manifest, type Wire } from '../index';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// RANDOM DESIGN GENERATOR (test-only). The substrate for the engine's "laws hold for EVERY architecture"
// property tests — see `laws.property.test.ts`. It yields random, VALID designs over the real seed catalog:
// one load SOURCE, then receivers each wired from a random earlier node's real OUT port into a real IN port,
// with random sync/async edges and a random offered load. Every design it produces instantiates + evaluates
// cleanly (a connected DAG with only real ports), so the properties exercise the engine on the *shape* of
// real designs rather than a handful of hand-picked ones. Not exported from the package — it is test scaffolding.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const CATALOG: Record<string, Manifest> = { ...manifests, ...commonManifests };
const portsOf = (type: string, dir: 'in' | 'out'): string[] => (CATALOG[type]?.ports ?? []).filter((p) => p.dir === dir || p.dir === 'bi').map((p) => p.name);

// A SOURCE offers load (has an out port, no in port); a RECEIVER has an in port (it can receive work).
const SOURCE_TYPES = Object.keys(CATALOG).filter((t) => portsOf(t, 'out').length > 0 && portsOf(t, 'in').length === 0);
const RECEIVER_TYPES = Object.keys(CATALOG).filter((t) => portsOf(t, 'in').length > 0);

export interface Design {
  readonly instances: Instance[];
  readonly wires: Wire[];
}

// One receiver's random choices (mod-indexed at assembly so any value is valid ⇒ fast-check shrinks cleanly).
const arbReceiver = fc.record({
  type: fc.constantFrom(...RECEIVER_TYPES),
  parent: fc.nat(), // which earlier out-capable node to attach to
  fromPort: fc.nat(), // which of the parent's out ports
  toPort: fc.nat(), // which of this node's in ports
  async: fc.boolean(),
});

/** A random valid design: a connected DAG of 2–7 real components carrying a random offered load. */
export const arbDesign: fc.Arbitrary<Design> = fc
  .tuple(fc.constantFrom(...SOURCE_TYPES), fc.integer({ min: 1, max: 100_000 }), fc.array(arbReceiver, { minLength: 1, maxLength: 6 }))
  .map(([srcType, load, receivers]): Design => {
    const instances: Instance[] = [{ id: 'n0', type: srcType, config: { throughput: load } }];
    const wires: Wire[] = [];
    const outCapable = [0]; // node indices that have an out port (eligible parents); the source starts it
    receivers.forEach((rec, k) => {
      const i = k + 1;
      instances.push({ id: `n${i}`, type: rec.type });
      const pIdx = outCapable[rec.parent % outCapable.length]!;
      const outs = portsOf(instances[pIdx]!.type, 'out');
      const ins = portsOf(rec.type, 'in');
      wires.push({ from: [`n${pIdx}`, outs[rec.fromPort % outs.length]!], to: [`n${i}`, ins[rec.toPort % ins.length]!], ...(rec.async ? { semantics: 'async' as const } : {}) });
      if (portsOf(rec.type, 'out').length > 0) outCapable.push(i);
    });
    return { instances, wires };
  });
