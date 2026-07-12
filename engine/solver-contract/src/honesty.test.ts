import { describe, expect, it } from 'vitest';
import { didNotConverge, infeasible, solved, type Cancellable, type SearchResult } from './honesty';

describe('honesty vocabulary (the search triad)', () => {
  it('solved carries its value and reads as the `solved` kind', () => {
    const r: SearchResult<number> = solved(42);
    expect(r.kind).toBe('solved');
    if (r.kind === 'solved') expect(r.value).toBe(42);
  });

  it('infeasible and did-not-converge are distinct kinds, never conflated', () => {
    expect(infeasible.kind).toBe('infeasible');
    expect(didNotConverge.kind).toBe('did-not-converge');
    expect(infeasible.kind).not.toBe(didNotConverge.kind);
  });

  it('the honesty kinds are the ONLY three a search may return (exhaustive)', () => {
    const kinds: SearchResult<number>['kind'][] = [solved(1).kind, infeasible.kind, didNotConverge.kind];
    expect(new Set(kinds)).toEqual(new Set(['solved', 'infeasible', 'did-not-converge']));
  });

  it('Cancellable carries an optional AbortSignal', () => {
    const c = new AbortController();
    const req: Cancellable = { signal: c.signal };
    expect(req.signal?.aborted).toBe(false);
    c.abort();
    expect(req.signal?.aborted).toBe(true);
  });
});
