import { describe, expect, it } from 'vitest';
import run from 'clingo-wasm';
import { answerSets, enumerateSelections, type RunAsp, type Selection, type SelectionProblem } from './clingo';

// The engine never imports clingo-wasm; a provider composes the prebuilt-WASM runner with `answerSets`.
// In node that runner is clingo-wasm's `run`; in the browser it's the vendored web/worker build.
const runAsp: RunAsp = async (program, models) => answerSets(await run(program, models));

describe('ASP adapter (clingo enumeration)', () => {
  it('runs a program and enumerates all its answer sets', async () => {
    // the power set of {a,b,c} = 8 answer sets
    const sets = await runAsp('{a;b;c}.', 0);
    expect(sets).toHaveLength(8);
    expect(sets.some((s) => s.length === 0)).toBe(true); // the empty set
    expect(sets.some((s) => [...s].sort().join(',') === 'a,b,c')).toBe(true); // the full set
  });

  it('returns [] for an unsatisfiable program', async () => {
    expect(await runAsp('a. :- a.', 0)).toEqual([]);
  });

  // ingress → compute → store, with protocol-style compatibility between adjacent tiers.
  const problem: SelectionProblem = {
    slots: [
      { id: 'ingress', candidates: ['gw', 'lb'] },
      { id: 'compute', candidates: ['faas', 'vm'] },
      { id: 'store', candidates: ['sql', 'kv'] },
    ],
    adjacencies: [
      ['ingress', 'compute'],
      ['compute', 'store'],
    ],
    compatible: [
      ['gw', 'faas'],
      ['gw', 'vm'],
      ['lb', 'vm'],
      ['faas', 'sql'],
      ['faas', 'kv'],
      ['vm', 'sql'],
    ],
  };

  const keyOf = (s: Selection): string => `${s.ingress}-${s.compute}-${s.store}`;

  it('synthesizes exactly the valid component chains', async () => {
    const sels = await enumerateSelections(problem, runAsp);
    // gw→{faas,vm}, faas→{sql,kv}, vm→{sql}; lb→{vm}, vm→{sql}
    expect(sels.map(keyOf).sort()).toEqual(['gw-faas-kv', 'gw-faas-sql', 'gw-vm-sql', 'lb-vm-sql']);
  });

  it('honours a result limit (top-K synthesis)', async () => {
    const sels = await enumerateSelections(problem, runAsp, { limit: 2 });
    expect(sels).toHaveLength(2);
  });

  it('returns nothing when no chain is compatible', async () => {
    const sels = await enumerateSelections({ ...problem, compatible: [] }, runAsp);
    expect(sels).toEqual([]);
  });

  it('placement rule: `conflicts` excludes a forbidden combination', async () => {
    const sels = await enumerateSelections({ ...problem, conflicts: [['faas', 'kv']] }, runAsp);
    expect(sels.map(keyOf).sort()).toEqual(['gw-faas-sql', 'gw-vm-sql', 'lb-vm-sql']); // no gw-faas-kv
  });

  it('placement rule: `requires` forces co-presence', async () => {
    // choosing kv anywhere requires vm chosen too; gw-faas-kv has kv but no vm ⇒ dropped
    const sels = await enumerateSelections({ ...problem, requires: [['kv', 'vm']] }, runAsp);
    expect(sels.map(keyOf).sort()).toEqual(['gw-faas-sql', 'gw-vm-sql', 'lb-vm-sql']);
  });
});
