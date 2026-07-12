/**
 * Branded identifiers. They are plain strings at runtime but cannot be mixed up at compile time —
 * a `PortId` will not type-check where a `NodeId` is expected.
 */
export type NodeId = string & { readonly __brand: 'NodeId' };
export type PortId = string & { readonly __brand: 'PortId' };
export type EdgeId = string & { readonly __brand: 'EdgeId' };

/** A registry key id. The engine knows keys exist; their meaning is content. */
export type Key = string & { readonly __brand: 'Key' };

/** A request-class id. A CLASS is a named flow (a commodity): its own origins
 *  and its own acyclic wire membership over a shared, possibly cyclic, topology. Opaque to the engine —
 *  "order" / "report" is content's name for it; the engine only indexes flow cells and walks per-class edge
 *  subsets by it. Absent everywhere ⇒ ONE implicit class over every wire (today's single river, bit-for-bit). */
export type ClassId = string & { readonly __brand: 'ClassId' };

/** A protocol id a port speaks. Opaque to the engine; compatibility between protocols is content data. */
export type ProtocolId = string & { readonly __brand: 'ProtocolId' };

export const NodeId = (s: string): NodeId => s as NodeId;
export const PortId = (s: string): PortId => s as PortId;
export const EdgeId = (s: string): EdgeId => s as EdgeId;
export const Key = (s: string): Key => s as Key;
export const ProtocolId = (s: string): ProtocolId => s as ProtocolId;
export const ClassId = (s: string): ClassId => s as ClassId;
