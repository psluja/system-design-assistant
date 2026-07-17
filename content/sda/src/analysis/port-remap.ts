import { portsConnect, type Compat } from '@sda/engine-solve';
import type { Instance, Manifest, ManifestPort, Wire } from '../vocabulary/manifest';

// port-remap — DIRECTION + PROTOCOL wire remapping for swappable components. Same-family
// members name their ports inconsistently (a function's egress is `out`; a service's are `db`/`cache`), so a swap or a
// compare/synthesize alternative cannot rely on identical port NAMES. This module carries a node's WIRES onto a
// candidate's real ports by matching each wired port to a compatible candidate port by DIRECTION + protocol
// (`portsConnect` — the SAME rule the legality layer uses), never by name. ONE builder shared by the synth (to OFFER a
// swap) and the command core (to APPLY it), so the two can never disagree on which port a wire lands on. Pure data in,
// a name map out — no engine knowledge of what any port means.

const isIn = (d: string): boolean => d === 'in' || d === 'bi';
const isOut = (d: string): boolean => d === 'out' || d === 'bi';

/** The specific NAMED port's protocol set on the given side of `m` (empty when the port/side is absent). The wire rides
 *  ONE named port on each end, so compatibility is judged on THOSE ports, never the peer's whole manifest. */
const speaksOf = (m: Manifest | undefined, port: string): readonly string[] => m?.ports.find((p) => p.name === port && isOut(p.dir))?.speaks ?? [];
const acceptsOf = (m: Manifest | undefined, port: string): readonly string[] => m?.ports.find((p) => p.name === port && isIn(p.dir))?.accepts ?? [];

/**
 * A REQUIREMENT on ONE of a node's wired ports: its `port` name, the `dir` it carries on the wire, and the peer
 * protocol-set(s) it must legally reach — one per wire riding this port (a port can carry several). For an `out` port
 * each peer set is the consumer IN port's `accepts`; for an `in` port it is the producer OUT port's `speaks`. An empty
 * set (a peer port that declares no protocol — legality "not checked" there) contributes NO constraint, exactly as the
 * legality layer skips it, so a candidate is matched on direction alone for that wire rather than being wrongly refused.
 */
export interface PortNeed {
  readonly port: string;
  readonly dir: 'in' | 'out';
  readonly peers: readonly (readonly string[])[];
}

/**
 * The wired-port REQUIREMENTS of `node` in a design: one {@link PortNeed} per DISTINCT (port, direction) the node
 * carries a wire on, in stable wire-declaration order, each collecting the peer set of every wire on it. A `bi` port
 * carrying both inbound and outbound wires yields two needs (one per direction). Peers read the EXACT wired port on the
 * far end from the catalog (never the peer's whole manifest), so compatibility is judged on the real wire.
 */
export function portNeedsOf(
  catalog: Readonly<Record<string, Manifest>>,
  instances: readonly Instance[],
  wires: readonly Wire[],
  node: string,
): PortNeed[] {
  const typeOf = (id: string): string | undefined => instances.find((i) => i.id === id)?.type;
  const order: string[] = [];
  const byKey = new Map<string, { port: string; dir: 'in' | 'out'; peers: string[][] }>();
  const record = (port: string, dir: 'in' | 'out', peer: readonly string[]): void => {
    const key = `${port}\x00${dir}`;
    let need = byKey.get(key);
    if (need === undefined) {
      need = { port, dir, peers: [] };
      byKey.set(key, need);
      order.push(key);
    }
    if (peer.length > 0) need.peers.push([...peer]); // an unprotocoled peer adds direction (via the recorded port) but no protocol constraint
  };
  for (const w of wires) {
    if (w.to[0] === node) record(w.to[1], 'in', speaksOf(catalog[typeOf(w.from[0]) ?? ''], w.from[1])); // node consumes: peer is the producer's OUT port
    if (w.from[0] === node) record(w.from[1], 'out', acceptsOf(catalog[typeOf(w.to[0]) ?? ''], w.to[1])); // node produces: peer is the consumer's IN port
  }
  return order.map((k) => byKey.get(k) as PortNeed);
}

/**
 * A DETERMINISTIC, injective-preferring remap of a node's wired ports onto a `candidate` manifest's ports, matched by
 * DIRECTION + protocol compatibility (`portsConnect`) against the ACTUAL peers — never by name. Returns a map
 * `originalPortName → candidatePortName`, or `null` when the candidate cannot host every wired port (it does not fit).
 *
 * Per need, in stable order (so name-identical matching is a trivial special case — a port maps to a same-named
 * compatible port): (1) the SAME-NAMED candidate port when still free + compatible (identity); else (2) the first FREE
 * compatible candidate port in declaration order (an injective assignment); else (3) the first compatible candidate
 * port even if already assigned — a SHARED port, which the legality layer allows (several wires may ride one port: an
 * out port broadcasts, an in port fans in). Ties break by declaration order; the assignment is total and reproducible.
 */
export function remapPorts(candidate: Manifest, needs: readonly PortNeed[], compat: readonly Compat[]): Record<string, string> | null {
  const map: Record<string, string> = {};
  const used = new Set<string>();
  const satisfies = (cp: ManifestPort, need: PortNeed): boolean => {
    if (need.dir === 'in' ? !isIn(cp.dir) : !isOut(cp.dir)) return false;
    return need.peers.every((peer) =>
      need.dir === 'in'
        ? portsConnect(peer, cp.accepts ?? [], compat) // candidate IN accepts what the producer speaks
        : portsConnect(cp.speaks ?? [], peer, compat), // candidate OUT speaks what the consumer accepts
    );
  };
  for (const need of needs) {
    const pick =
      candidate.ports.find((p) => p.name === need.port && !used.has(p.name) && satisfies(p, need)) ?? // (1) identity
      candidate.ports.find((p) => !used.has(p.name) && satisfies(p, need)) ?? // (2) first free compatible
      candidate.ports.find((p) => satisfies(p, need)); // (3) shared (multi-wire) fallback
    if (pick === undefined) return null;
    map[need.port] = pick.name;
    used.add(pick.name);
  }
  return map;
}
