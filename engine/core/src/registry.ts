import type { Key } from './ids';
import type { BandShape, Unit } from './value';

/**
 * How a property composes over the topology — a monoid, parameterized by edge semantics (doc-2 §5).
 * The engine applies this generically; it never hardcodes any specific key's algebra.
 */
export interface Aggregation {
  /** How the value composes DOWN a path / how a node's local value meets its incoming one. */
  readonly series: 'sum' | 'min' | 'max' | 'product';
  /** How MULTIPLE incoming edges combine at a FAN-IN. Defaults to `series`. Set apart only when the across-
   *  inputs operator differs from the down-path one — e.g. throughput: offered loads SUM at a fan-in, while
   *  the served rate down the path is min(capacity, offered). */
  readonly fanIn?: 'sum' | 'min' | 'max' | 'product';
  readonly onAsyncEdge: 'carry' | 'cut';
  /** When true the property is NODE-LOCAL: its value is the node's OWN relation/config alone and does NOT
   *  flow across edges — no fan-in, no carry, no downstream demand. A node with no local definition has NO
   *  value for it (e.g. an object store has no "required tasks" to inherit from an upstream fleet). Any read
   *  of it — `self`, `inflow`, or a plain ref — yields the node's own local value. `series`/`fanIn` are then
   *  inert. Use for intrinsically per-node quantities (sizing/required-units), never for flow quantities. */
  readonly local?: boolean;
  /** When true this is a FLOW quantity that PORT TRANSFORMS act on (doc: flow-transformations). At each
   *  edge contribution the source out-port's transfer function is applied to the upstream's served value,
   *  and each target in-port's transfer function to the per-port sum, BEFORE the fan-in aggregation. For a
   *  non-flow key (the default) transforms are inert — the aggregation is exactly as before. Content sets
   *  this on the single throughput/rate key; the engine stays agnostic about which key that is. */
  readonly flow?: boolean;
}

/** The engine knows the SHAPE of a key, never the specific keys (those are content; doc-4 §2). */
export interface KeyDef {
  readonly key: Key;
  readonly unit: Unit;
  readonly band: BandShape;
  readonly aggregate: Aggregation;
  readonly kind: 'input' | 'derived';
}

/** The governed vocabulary: a closed set of key definitions, looked up by key (doc-2 §2). */
export interface Registry {
  get(key: Key): KeyDef | undefined;
  has(key: Key): boolean;
  readonly keys: readonly Key[];
}

export function registryOf(defs: readonly KeyDef[]): Registry {
  const map = new Map<Key, KeyDef>(defs.map((d) => [d.key, d]));
  return {
    get: (k) => map.get(k),
    has: (k) => map.has(k),
    keys: [...map.keys()],
  };
}
