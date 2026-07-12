import type { ClassId, Graph, Key, NodeId, Registry, Result, Verdict } from '@sda/engine-core';
import { buildNetwork, type RequestClass } from './network';
import { solve } from './fixpoint';
import { evaluateBands } from './verdict';

/** The result of a forward evaluation: solved values + honest verdicts. */
export interface Evaluation {
  /** True if the least fixpoint settled (no did-not-converge / NaN). */
  readonly converged: boolean;
  /** The computed value of a key at a node, or undefined if absent. With request classes declared (doc:
   *  request-classes §4), pass `cls` to read that class's own value `out(N,K,C)`; the flow key's UNINDEXED
   *  value is absent under classes (it lives per class), so a class-aware caller must pass `cls`. */
  value(node: NodeId, key: Key, cls?: ClassId): number | undefined;
  /** A verdict per declared band (ok / warning / violation / unknown). */
  readonly verdicts: readonly Verdict[];
  /** The declared request-class ids, in declaration order. Empty ⇒ the single implicit class (today). */
  readonly classes: readonly ClassId[];
}

/**
 * The hot-path engine entry: project the graph into a cell network, solve it to the least
 * fixpoint, and check declared bands. Pure and deterministic. Errors = build problems (e.g. an
 * unregistered key or a malformed relation).
 *
 * `classes` is the OPTIONAL multi-commodity overlay: each declared class folds the flow
 * key over its OWN wires and contends its share of a shared node's capacity (§4.1). Absent / empty ⇒ the single
 * implicit river, and every cell — and this whole function — is BYTE-FOR-BIT today (the equivalence property).
 */
export function evaluate(graph: Graph, registry: Registry, classes?: readonly RequestClass[]): Result<Evaluation, readonly string[]> {
  const net = buildNetwork(graph, registry, classes);
  if (!net.ok) return net;

  const solved = solve(net.value.system);
  const verdicts = evaluateBands(graph, registry, net.value, solved.values);

  return {
    ok: true,
    value: {
      converged: solved.converged,
      value: (node, key, cls) => solved.values.get(net.value.out(node, key, cls)),
      verdicts,
      classes: net.value.classes,
    },
  };
}
