import ds from 'datascript';
import type { DimensionToken, Lattice } from '@sda/engine-core';
import type { Contribution } from './propagate';

// @algorithm Relational meet via max-rank aggregation (DataScript differential reference)
// @problem The forward meet fold (propagate.ts) needs an INDEPENDENT implementation to agree with —
//   the two-engines-agree rigor that guards "the tool must not lie" for categorical guarantees.
// @approach Exploit that meet is a commutative idempotent monoid: the end-to-end token is order-free
//   and equals the WEAKEST (max-rank) contributed token, which a relational engine computes
//   naturally — load each contribution's rank as a datom, take the Datalog max per dimension (plus
//   the touched-unknown flag).
// @complexity One aggregate query over O(contributions) datoms per dimension.
// @citations Semilattice-as-monoid folklore; Datalog aggregation (DataScript).
// @invariants Agrees with the forward fold on the final token and unknown flag for every input (the
//   differential test's contract); order-independence is the mathematical basis, so no path order is
//   consulted.
// @where-tested engine/solve/src/guarantee/propagate.test.ts (the differential)

// An INDEPENDENT, relational implementation of the categorical MEET along a path — the DIFFERENTIAL reference
// for `propagateDimension`. It reuses the DataScript
// (Datalog, pure JS) seam that content/engine already trust for legality, so the guarantee arithmetic gets the
// SAME two-engines-agree rigor as protocol legality and the numeric JS↔MiniZinc contract.
//
// The mathematical basis: the meet is a COMMUTATIVE, IDEMPOTENT monoid, so the end-to-end token is order-free —
// it is exactly the WEAKEST (max-rank) token contributed on the path. That set-based fact is what a relational
// engine computes naturally: load each contribution's rank as a datom, query the MAX rank per dimension. The
// forward fold (propagate.ts) additionally recovers the ORDER-dependent root cause, which this reference does
// not need to reproduce — the differential pins the FINAL token (and the unknown flag), the certain part.

type Datom = Record<string, unknown>;

/**
 * The end-to-end token for one lattice along a contribution list, computed via DataScript by taking the MAX rank
 * (= weakest token) among the contributions that name this dimension. Empty ⇒ the lattice TOP (no hop weakened
 * it). Also returns whether any contribution was the dimension's declared-unknown token, mirroring the forward
 * pass's `touchedUnknown` so the differential covers the honesty flag too, not only the token.
 */
export function meetDatalog(lattice: Lattice, contributions: readonly Contribution[]): { readonly token: DimensionToken; readonly touchedUnknown: boolean } {
  const tx: Datom[] = [];
  let id = 0;
  let touchedUnknown = false;
  const unknownToken = lattice.unknown;
  for (const c of contributions) {
    const token = c.guarantees[lattice.id];
    if (token === undefined) continue;
    const rank = lattice.rank(token);
    if (rank === undefined) continue; // a token outside the lattice cannot be ranked — validation rejects it upstream
    if (unknownToken !== undefined && token === unknownToken) touchedUnknown = true;
    tx.push({ ':db/id': --id, ':contrib/rank': rank });
  }
  const db = ds.db_with(ds.empty_db(), tx);
  // MAX rank across all contributions = the weakest token = the meet. Aggregate query; empty result ⇒ no rows.
  const rows = ds.q('[:find (max ?r) :where [?c ":contrib/rank" ?r]]', db) as Array<[number]>;
  const worstRank = rows.length > 0 ? (rows[0] as [number])[0] : 0; // 0 = TOP when nothing contributed
  return { token: lattice.tokens[worstRank] as DimensionToken, touchedUnknown };
}
