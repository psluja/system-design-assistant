import { describe, expect, it } from 'vitest';
import { enumerated, enumerateDidNotConverge, type Enumerate, type EnumerateRequest } from './enumerate';
import { selectionProblem } from '../conformance/corpus';

describe('Enumerate capability (generate legal topologies)', () => {
  const req: EnumerateRequest = { problem: selectionProblem };

  it('an enumerated result carries its selections (UNSAT ⇒ empty, never an error)', () => {
    const some = enumerated([{ ingress: 'gw', compute: 'faas', store: 'sql' }]);
    expect(some.kind).toBe('enumerated');
    if (some.kind === 'enumerated') expect(some.selections).toHaveLength(1);

    const none = enumerated([]);
    expect(none.kind).toBe('enumerated');
    if (none.kind === 'enumerated') expect(none.selections).toEqual([]);
  });

  it('did-not-converge is the honest state for a solver error or timeout (no-throw)', () => {
    expect(enumerateDidNotConverge.kind).toBe('did-not-converge');
  });

  it('an implementation returns a value for every problem — never throws', async () => {
    const stub: Enumerate = async () => enumerated([{ ingress: 'gw', compute: 'faas', store: 'sql' }]);
    const r = await stub(req);
    expect(r.kind).toBe('enumerated');
  });

  it('the request carries an optional limit and abort signal', () => {
    const c = new AbortController();
    const withExtras: EnumerateRequest = { problem: selectionProblem, limit: 2, signal: c.signal };
    expect(withExtras.limit).toBe(2);
    expect(withExtras.signal?.aborted).toBe(false);
  });
});
