import type { ClassId, EdgeId, Key, NodeId } from './ids';
import type { Quantity } from './value';

/**
 * A verdict status — separates a hard-floor breach (`violation`) from a soft-target miss (`warning`)
 * from honest ignorance (`unknown` / `did-not-converge`). Never a bare boolean.
 */
export type Status = 'ok' | 'warning' | 'violation' | 'unknown' | 'did-not-converge';

/** One link in the chain of upstream cells/constraints that drove a verdict. */
export interface CauseLink {
  readonly scope: NodeId | EdgeId;
  readonly key: Key;
  readonly note: string;
}
export type CauseChain = readonly CauseLink[];

/** A ranked, actionable fix derived from a tunable. Lower `rank` = offered first. */
export interface Remediation {
  readonly action: string;
  readonly rank: number;
}

/** The engine's honest, explanatory output for one checked property. */
export interface Verdict {
  readonly key: Key;
  readonly scope: NodeId | EdgeId;
  readonly computed: Quantity;
  readonly status: Status;
  readonly cause: CauseChain;
  readonly remediations: readonly Remediation[];
  /** With request classes declared, the class this verdict is FOR — a per-class
   *  perspective on a shared node (its latency/availability under THAT class's path). Absent ⇒ the single implicit
   *  river, or a class-blind quantity (a node's total served throughput, a node-local ceiling) — today, bit-for-bit. */
  readonly class?: ClassId;
}
