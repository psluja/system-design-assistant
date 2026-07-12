// @algorithm ASP program generation for topology enumeration (generate-and-test)
// @problem Synthesis must ENUMERATE every valid discrete structure — which option fills each slot so
//   all adjacency compatibilities and placement rules hold — rather than check or size a given one.
// @approach Emit an Answer Set Programming program: a cardinality choice { choose(S,O) : candidate } = 1
//   per slot, integrity constraints for adjacency compatibility and requires/conflicts placement
//   rules; the injected clingo runner (prebuilt WASM or node) solves it and the answer sets are
//   parsed back into canonically ordered selections.
// @complexity Program size O(slots * options + compat facts); solving is clingo's (NP-complete in
//   general), bounded by the requested model count.
// @citations Gelfond & Lifschitz 1988 (stable model semantics); Gebser et al., clingo / Potassco
//   (the ASP system used, via clingo-wasm).
// @invariants Domain-agnostic (slots/options/compat are opaque ids supplied as data); clingo is
//   injected, never imported (bundle-clean engine); selections are canonically sorted so
//   enumeration order is deterministic for the caller.
// @where-tested engine/solve/src/asp/clingo.test.ts

// The ASP (Answer Set Programming) adapter — combinatorial ENUMERATION/synthesis of valid discrete
// structures, the one solver that GENERATES candidate topologies rather than checking/sizing a given
// one. Domain-agnostic: slots, options and compatibility are opaque
// ids/data; the SDA meaning (archetypes, protocol matching) is content. The clingo solver is INJECTED
// (a `RunAsp`), exactly like the MiniZinc `MznSolver` — the engine never imports clingo-wasm, so it stays
// bundle-clean; the app (browser worker build) or tests (node build) supply the prebuilt-WASM runner.

interface Witness {
  readonly Value: readonly string[];
}
/** The raw JSON shape clingo-wasm's `run` returns — providers hand it straight to `answerSets`. */
export interface ClingoResult {
  readonly Result: 'SATISFIABLE' | 'UNSATISFIABLE' | 'UNKNOWN' | 'OPTIMUM FOUND' | 'ERROR';
  readonly Error?: string;
  readonly Call?: ReadonlyArray<{ readonly Witnesses: ReadonlyArray<Witness> }>;
}

/** An answer set: the true atoms (as printed strings) of one solution. */
export type AnswerSet = readonly string[];

/** The injected ASP solver (mirror of `MznSolver`): run a program, return up to `models` answer sets
 *  (0 = all). The engine never imports clingo-wasm — the app/test provides this from the prebuilt WASM. */
export type RunAsp = (program: string, models: number) => Promise<AnswerSet[]>;

/** Parse clingo-wasm's raw result into answer sets. The ONE place that format lives, so every provider
 *  (browser, node, test) composes `answerSets(await clingoRun(...))` instead of duplicating it. UNSAT ⇒ []. */
export function answerSets(res: ClingoResult): AnswerSet[] {
  if (res.Result === 'ERROR') throw new Error(`clingo error: ${res.Error ?? 'unknown'}`);
  if (res.Result === 'UNSATISFIABLE') return [];
  return (res.Call ?? []).flatMap((c) => c.Witnesses).map((w) => [...w.Value]);
}

/** A discrete selection problem: one option per slot, with compatibility required across adjacencies. */
export interface SelectionProblem {
  readonly slots: ReadonlyArray<{ readonly id: string; readonly candidates: readonly string[] }>;
  /** Slot pairs `[from, to]` whose chosen options must be compatible. */
  readonly adjacencies: ReadonlyArray<readonly [string, string]>;
  /** Allowed `[fromOption, toOption]` value pairs (e.g. derived from protocol matching). */
  readonly compatible: ReadonlyArray<readonly [string, string]>;
  /** Placement rule: choosing option A anywhere requires option B chosen somewhere (`[A, B]`). */
  readonly requires?: ReadonlyArray<readonly [string, string]>;
  /** Placement rule: options A and B may not both be chosen (`[A, B]`). */
  readonly conflicts?: ReadonlyArray<readonly [string, string]>;
}

/** A solution: the option chosen for each slot. */
export type Selection = Readonly<Record<string, string>>;

const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const unq = (s: string): string => s.replace(/\\(.)/g, '$1');
const CHOOSE = /^choose\("((?:[^"\\]|\\.)*)","((?:[^"\\]|\\.)*)"\)$/;

/**
 * Enumerate every valid selection (or up to `limit`) — exactly one candidate per slot such that all
 * adjacent choices are compatible. This is the generate-and-test that ASP is built for and that the
 * relational/numeric engines cannot do: it returns MANY whole structures, not one verdict.
 */
export async function enumerateSelections(problem: SelectionProblem, run: RunAsp, opts: { readonly limit?: number } = {}): Promise<Selection[]> {
  const lines: string[] = [];
  for (const slot of problem.slots) {
    lines.push(`slot(${q(slot.id)}).`);
    for (const o of slot.candidates) lines.push(`candidate(${q(slot.id)},${q(o)}).`);
  }
  for (const [a, b] of problem.adjacencies) lines.push(`adjacent(${q(a)},${q(b)}).`);
  for (const [oa, ob] of problem.compatible) lines.push(`compat(${q(oa)},${q(ob)}).`);
  for (const [a, b] of problem.requires ?? []) lines.push(`requires(${q(a)},${q(b)}).`);
  for (const [a, b] of problem.conflicts ?? []) lines.push(`conflicts(${q(a)},${q(b)}).`);
  lines.push('{ choose(S,O) : candidate(S,O) } = 1 :- slot(S).');
  lines.push(':- adjacent(A,B), choose(A,OA), choose(B,OB), not compat(OA,OB).');
  // placement rules (cardinality / co-presence): an option is "chosen" if any slot picks it
  lines.push('chosen(O) :- choose(_,O).');
  lines.push(':- requires(A,B), chosen(A), not chosen(B).');
  lines.push(':- conflicts(A,B), chosen(A), chosen(B).');
  lines.push('#show choose/2.');

  const sets = await run(lines.join('\n'), opts.limit ?? 0);
  const selections = sets.map((atoms) => {
    const sel: Record<string, string> = {};
    for (const atom of atoms) {
      const m = CHOOSE.exec(atom);
      if (m) sel[unq(m[1] as string)] = unq(m[2] as string);
    }
    return sel;
  });
  // canonical order so the enumeration is deterministic for callers/tests
  return selections.sort((a, b) => key(a).localeCompare(key(b)));
}

function key(sel: Selection): string {
  return Object.keys(sel)
    .sort()
    .map((k) => `${k}=${sel[k]}`)
    .join('|');
}
