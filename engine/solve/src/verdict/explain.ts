// @algorithm Binding-branch root-cause walk (cause chains + ranked remediations)
// @problem A violated band must come with WHY: which node's contribution actually binds the computed
//   value, through which aggregation hops — and what change would move it.
// @approach Greedy descent from the violated (node, key) along the BINDING branch of each
//   aggregation — the bottleneck for min/product, the dominant contributor for sum/max — re-reading
//   already-solved cell values (no new solve) until an origin's own local contribution binds;
//   emits the hop chain plus remediations ranked by leverage.
// @complexity O(depth * branching) cell reads, depth-bounded (64) and cycle-guarded by a seen set.
// @citations None (structural attribution over the solved network; kin to critical-path tracing).
// @invariants Pure and deterministic — only re-reads solved values; the walk terminates (bound +
//   cycle guard); every link names the aggregation role that made it binding.
// @where-tested engine/solve/src/verdict/explain.test.ts

import type { CauseChain, CauseLink, Key, NodeId, Registry, Remediation } from '@sda/engine-core';
import { evalExpr, type Env } from '../relation';
import type { CellId } from '../fixpoint';
import type { CellMeta, Network } from '../network';

/** Which direction a breached band wants the value moved. */
export type Goal = 'raise' | 'lower';

export interface Explanation {
  readonly cause: CauseChain;
  readonly remediations: readonly Remediation[];
}

type Series = CellMeta['series'];

const seriesWord = (s: Series): string =>
  s === 'min' ? 'minimum' : s === 'max' ? 'maximum' : s === 'sum' ? 'contributor' : 'factor';

const leverWord = (s: Series): string =>
  s === 'min' ? 'the binding bottleneck' : s === 'max' ? 'the dominant maximum' : s === 'sum' ? 'the dominant contributor' : 'the weakest factor';

const localWord = (k: CellMeta['localKind']): string =>
  k === 'relation' ? 'computed' : k === 'config' ? 'configured' : 'inbound';

/** A candidate branch of an aggregation: the node's own local, or one upstream contributor. */
type Branch = { readonly kind: 'local'; readonly value: number } | { readonly kind: 'upstream'; readonly node: NodeId; readonly value: number };

/** Pick the branch that BINDS the aggregate (the bottleneck for min/product, the dominant for sum/max). */
function bindingBranch(series: Series, candidates: readonly Branch[]): Branch | null {
  const finite = candidates.filter((c) => Number.isFinite(c.value));
  if (finite.length === 0) return null;
  const prefersSmaller = series === 'min' || series === 'product';
  return finite.reduce((best, c) => ((prefersSmaller ? c.value < best.value : c.value > best.value) ? c : best));
}

/**
 * Attribute a checked value to its binding cause by walking the solved cell network from the
 * violated (node,key) along the binding branch of each aggregation until it reaches an origin (a node
 * whose own local contribution binds). Produces a cause-chain and a ranked remediation aimed at that
 * origin. Pure and deterministic; no solver — it re-reads the already-solved values.
 */
export function explain(
  network: Network,
  registry: Registry,
  values: ReadonlyMap<string, number>,
  node: NodeId,
  key: Key,
  goal: Goal,
): Explanation {
  const env: Env<CellId> = (id) => values.get(id) ?? NaN;
  const unit = registry.get(key)?.unit ?? '';
  // Round to 6 significant figures so a fixpoint value never leaks float noise into a human note/remedy
  // (e.g. 0.9993001099950001 → 0.9993); integers pass through unchanged.
  const fmt = (v: number): string => `${Number.isFinite(v) && !Number.isInteger(v) ? Number(v.toPrecision(6)) : v}${unit ? ` ${unit}` : ''}`;

  const links: CauseLink[] = [];
  const seen = new Set<string>();
  let curNode = node;
  let originValue: number | null = null;
  let originNode = node;
  let originSeries: Series = 'min';

  for (let depth = 0; depth < 64; depth++) {
    const id = `${curNode}|${key}`;
    if (seen.has(id)) break; // cycle guard (cyclic flow): stop, report what we have
    seen.add(id);

    const meta = network.metaOf(curNode, key);
    if (meta === undefined) break;

    const candidates: Branch[] = [];
    if (meta.local !== null) candidates.push({ kind: 'local', value: evalExpr(meta.local, env) });
    for (const m of meta.contributors) candidates.push({ kind: 'upstream', node: m, value: values.get(network.out(m, key)) ?? NaN });

    const branch = bindingBranch(meta.series, candidates);
    if (branch === null) break;

    if (branch.kind === 'local') {
      links.push({
        scope: curNode,
        key,
        note: `${localWord(meta.localKind)} ${fmt(branch.value)} is the binding ${seriesWord(meta.series)} (origin)`,
      });
      originValue = branch.value;
      originNode = curNode;
      originSeries = meta.series;
      break;
    }

    links.push({
      scope: curNode,
      key,
      note: `${fmt(branch.value)} flows from upstream; the binding ${seriesWord(meta.series)} is further up`,
    });
    curNode = branch.node;
  }

  if (originValue === null) return { cause: links, remediations: [] };

  const verb = goal === 'raise' ? 'Increase' : 'Reduce';
  const remediations: Remediation[] = [
    {
      action: `${verb} ${key} at ${originNode} (currently ${fmt(originValue)}) — ${leverWord(originSeries)}`,
      rank: 1,
    },
  ];
  return { cause: links, remediations };
}
