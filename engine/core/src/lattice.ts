// @algorithm Totally-ordered token lattice with meet (categorical dimension compiler)
// @problem Qualitative guarantees need an algebra before they can be computed: an ordered vocabulary
//   of opaque tokens and a combining rule that says what survives when hops of different strength
//   compose.
// @approach Compile an ordered token list (strongest first = TOP) into a rank-lookup lattice whose
//   MEET returns the larger-rank (weaker) token; boolean monotone flags are the degenerate
//   two-element case, so one mechanism serves consistency, ordering and delivery alike; declarations
//   are validated (no duplicates, unknown token must be a member).
// @complexity Compile O(dimensions * tokens); rank and meet O(1) via the precomputed map.
// @citations Semilattice basics (Birkhoff, "Lattice Theory"); the total order makes meet = max-rank.
// @invariants Meet is commutative, idempotent, monotone (never strengthens); index 0 is TOP and the
//   meet identity; tokens are opaque strings — the engine names no guarantee vocabulary.
// @where-tested engine/core/src/lattice.test.ts, engine/solve/src/guarantee/propagate.test.ts

// A CATEGORICAL dimension: a tiny totally-ordered lattice of opaque TOKENS whose combining rule along a
// path is "the weaker hop wins" (the meet). This is the mathematical structure that makes qualitative
// guarantees — consistency, ordering, delivery — COMPUTABLE with certainty.
//
// The engine knows only the SHAPE: an ordered token list (strongest first) and the meet operation. What a
// token MEANS ('strong', 'eventual', 'none', 'may-duplicate'…) is entirely CONTENT — the same
// domain-agnosticism as every registry key. The engine grep for any such word must stay zero: tokens are
// opaque `DimensionToken` strings that content declares in the registry's categorical section.
//
// Boolean monotone flags (delivery: may-duplicate / may-lose) are the DEGENERATE two-element case: an ordered
// pair [clean, flagged] where meet picks the FLAGGED token the moment any hop declares it — i.e. "once a hop
// can duplicate, the path can". Modelling them as an ordered pair (rather than a separate OR primitive) keeps
// ONE mechanism for all three dimensions; the meet IS the monotone OR.

/** A dimension id (e.g. content's 'consistency', 'ordering'). Opaque to the engine; declared in content. */
export type DimensionId = string & { readonly __brand: 'DimensionId' };
export const DimensionId = (s: string): DimensionId => s as DimensionId;

/** A single token within a dimension's lattice (e.g. 'strong', 'eventual'). Opaque to the engine. */
export type DimensionToken = string & { readonly __brand: 'DimensionToken' };
export const DimensionToken = (s: string): DimensionToken => s as DimensionToken;

/**
 * One categorical dimension: its ordered tokens (index 0 = STRONGEST = the lattice TOP, last = weakest =
 * BOTTOM) and, optionally, a distinguished `unknown` token — the declared-unknown value a hop contributes
 * when its guarantee is honestly not known. A meet that
 * ever touches the unknown token yields `unknown` for the whole path — no fake certainty. The unknown token,
 * when present, MUST be one of `tokens` (validated), and by convention sits at the WEAK end so a real hop can
 * never be masked by it. Everything is opaque strings — meaning is content.
 */
export interface Dimension {
  readonly id: DimensionId;
  /** Strongest → weakest. Non-empty; every token distinct. index 0 = TOP. */
  readonly tokens: readonly DimensionToken[];
  /** The distinguished declared-unknown token (⊆ tokens), or undefined if the dimension has none. */
  readonly unknown?: DimensionToken;
}

/**
 * A compiled lattice for one dimension: rank lookup + the two operations the propagator needs. `rank(t)` is a
 * token's position (0 = strongest); `meet(a,b)` returns the WEAKER of two tokens (larger rank); `top()` is the
 * strongest token (the identity of meet — meeting with TOP is a no-op, so a source that declares nothing starts
 * at TOP and only real hops can weaken it). Pure and total; an unknown token is not special here — the caller
 * detects an unknown contribution by identity before/after the meet (see engine/solve propagation).
 */
export interface Lattice {
  readonly id: DimensionId;
  readonly tokens: readonly DimensionToken[];
  readonly unknown?: DimensionToken;
  /** Position of a token (0 = strongest). Returns undefined for a token not in this dimension. */
  rank(token: DimensionToken): number | undefined;
  /** The weaker (larger-rank) of two tokens. Both MUST belong to this lattice (checked by construction). */
  meet(a: DimensionToken, b: DimensionToken): DimensionToken;
  /** The strongest token — the identity of `meet` (a fresh path with no contribution starts here). */
  top(): DimensionToken;
}

/** A categorical vocabulary: a closed set of dimensions, looked up by id. Mirrors {@link Registry} in shape. */
export interface Categorical {
  get(id: DimensionId): Lattice | undefined;
  has(id: DimensionId): boolean;
  readonly dimensions: readonly DimensionId[];
}

/** Ill-formed categorical declarations — caught once, at construction, so a malformed lattice is unrepresentable. */
export type LatticeError =
  | { readonly kind: 'empty-dimension'; readonly dimension: DimensionId }
  | { readonly kind: 'duplicate-token'; readonly dimension: DimensionId; readonly token: DimensionToken }
  | { readonly kind: 'duplicate-dimension'; readonly dimension: DimensionId }
  | { readonly kind: 'unknown-token-absent'; readonly dimension: DimensionId; readonly token: DimensionToken };

/** Compile ONE dimension's declaration into a {@link Lattice}, collecting all well-formedness errors. */
function compileDimension(d: Dimension, errors: LatticeError[]): Lattice | undefined {
  if (d.tokens.length === 0) {
    errors.push({ kind: 'empty-dimension', dimension: d.id });
    return undefined;
  }
  const rankOf = new Map<DimensionToken, number>();
  let dup = false;
  d.tokens.forEach((t, i) => {
    if (rankOf.has(t)) {
      errors.push({ kind: 'duplicate-token', dimension: d.id, token: t });
      dup = true;
    } else rankOf.set(t, i);
  });
  if (d.unknown !== undefined && !rankOf.has(d.unknown)) {
    errors.push({ kind: 'unknown-token-absent', dimension: d.id, token: d.unknown });
    return undefined;
  }
  if (dup) return undefined;
  const rank = (t: DimensionToken): number | undefined => rankOf.get(t);
  return {
    id: d.id,
    tokens: d.tokens,
    ...(d.unknown !== undefined ? { unknown: d.unknown } : {}),
    rank,
    // meet = the WEAKER token = the larger rank (the lattice orders strongest→weakest by index). Both tokens
    // are assumed to belong to this lattice — the propagator validates a graph's tokens before it meets them,
    // so an out-of-lattice token cannot reach here. If one somehow did, `?? -1` keeps meet total (that token
    // would be treated as stronger-than-all), never a throw — but the differential/validation makes it moot.
    meet: (a, b) => ((rankOf.get(a) ?? -1) >= (rankOf.get(b) ?? -1) ? a : b),
    top: () => d.tokens[0] as DimensionToken,
  };
}

/**
 * Build a validated categorical vocabulary from ordered dimension declarations. Returns ALL well-formedness
 * errors (not just the first) so content sees every problem at once — the same discipline as {@link buildGraph}.
 * An empty declaration list is legal (a design that uses no categorical dimensions — today's behaviour, so the
 * whole feature stays silent under the no-filler rule).
 */
export function categoricalOf(dimensions: readonly Dimension[]): { readonly ok: true; readonly value: Categorical } | { readonly ok: false; readonly error: readonly LatticeError[] } {
  const errors: LatticeError[] = [];
  const map = new Map<DimensionId, Lattice>();
  for (const d of dimensions) {
    if (map.has(d.id)) {
      errors.push({ kind: 'duplicate-dimension', dimension: d.id });
      continue;
    }
    const lat = compileDimension(d, errors);
    if (lat !== undefined) map.set(d.id, lat);
  }
  if (errors.length > 0) return { ok: false, error: errors };
  return {
    ok: true,
    value: {
      get: (id) => map.get(id),
      has: (id) => map.has(id),
      dimensions: [...map.keys()],
    },
  };
}

/**
 * A per-port / per-edge guarantee CONTRIBUTION: the token this hop declares for each dimension it touches. A
 * dimension absent from the record means "this hop makes no claim" — it is treated as the dimension's TOP (a
 * no-op meet), so a pass-through hop never weakens a guarantee. Opaque strings keyed by dimension id; the
 * engine only meets them. Attached to a {@link Port} or {@link Edge} as `guarantees?` and validated in buildGraph.
 *
 * NB: `Key` is intentionally NOT reused here — a categorical dimension is a DIFFERENT vocabulary from the numeric
 * registry keys (different lattices, no `aggregate`), kept apart so the two can never be confused at a boundary.
 */
export type Guarantees = Readonly<Record<DimensionId, DimensionToken>>;
