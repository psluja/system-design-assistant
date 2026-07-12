/**
 * A unit tag, e.g. "req/s", "ms", "USD/month". Conversion within a dimension is a content/impl
 * concern; engine/core only carries the tag.
 */
export type Unit = string & { readonly __brand: 'Unit' };
export const Unit = (s: string): Unit => s as Unit;

/** A scalar quantity with a unit. */
export interface Quantity {
  readonly value: number;
  readonly unit: Unit;
}

/** How a key's band is shaped. Declared per key in the registry. */
export type BandShape = 'point' | 'minTargetMax' | 'percentiles';

/** An SLO band — the acceptable envelope for a key. */
export type Band =
  | { readonly shape: 'point'; readonly target: number }
  | { readonly shape: 'minTargetMax'; readonly min?: number; readonly target?: number; readonly max?: number }
  | { readonly shape: 'percentiles'; readonly targets: ReadonlyMap<string, number> }; // e.g. p50, p99

/** The value of an input cell: a fixed quantity (config/limit) or an SLO band. */
export type InputValue =
  | { readonly kind: 'fixed'; readonly quantity: Quantity }
  | { readonly kind: 'band'; readonly band: Band };
