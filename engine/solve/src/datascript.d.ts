// Minimal ambient typings for the `datascript` npm package (ClojureScript-compiled).
// The JS build exposes snake_case functions and takes queries as EDN strings with
// quoted ":attr" keywords. See the datalog-datascript skill for the full gotchas.
declare module 'datascript' {
  const ds: {
    empty_db(schema?: unknown): unknown;
    db_with(db: unknown, tx: ReadonlyArray<unknown>): unknown;
    q(query: string, ...inputs: unknown[]): unknown;
  };
  export default ds;
}
