/**
 * Exhaustiveness guard for a `switch` over a discriminated union. In the `default:` branch, `assertNever(x)`
 * makes the COMPILER error if a new variant is ever added but left unhandled (x would no longer narrow to
 * `never`). Value-returning switches get this for free via their return type; void-returning ones (which
 * silently skip an unhandled case) need it explicitly. At runtime it throws — a genuinely impossible state.
 */
export function assertNever(x: never): never {
  throw new Error(`unexpected variant: ${JSON.stringify(x)}`);
}
