// @feature Reliability advisor (nines tiers + DR ladder)
// @story Per flow: the computed end-to-end availability, the AWS-documented nines tier it meets, the
//   sourced remedy for a target, and a DR-tier recommendation derived from RPO/RTO — quoted, never
//   opinion.
// @surfaces mcp (reliability, app/mcp/src/reliability.ts), design doc (reliability section via
//   content/sda/src/design-doc.ts)
// @algorithms content/sda/src/system.ts (the series-product availability it interprets)
// @docs none (primary AWS sources are cited inline below)
// @e2e none (unit: content/sda/src/reliability.test.ts, app/mcp/src/reliability.test.ts)
// @status shipped

// AWS reliability REFERENCE — every figure is quoted from primary AWS documentation (the tool must not lie:
// reliability advice is sourced, never opinion). The engine computes availability as a series PRODUCT over hard
// dependencies (registry: availability `series: product`); this module turns that computed number, plus a
// target / RTO / RPO, into the AWS-DOCUMENTED reading and remedy.
//
// SOURCES (all primary AWS):
//  [AV]   Well-Architected Reliability Pillar — "Availability" (nines table, series/parallel math):
//         https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/availability.html
//  [DR]   REL13-BP02 — "Use defined recovery strategies to meet the recovery objectives":
//         https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_planning_for_recovery_disaster_recovery.html
//  [DRWP] DR whitepaper — "Disaster recovery options in the cloud":
//         https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html
//  [DP]   REL11-BP04 — "Rely on the data plane and not the control plane during recovery":
//         https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_withstand_component_failures_avoid_control_plane.html

export const RELIABILITY_SOURCES = {
  availability: 'https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/availability.html',
  drStrategies: 'https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_planning_for_recovery_disaster_recovery.html',
  drWhitepaper: 'https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html',
  dataPlaneFailover: 'https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_withstand_component_failures_avoid_control_plane.html',
} as const;

/** One row of the Reliability Pillar "Availability" table [AV] — AWS's own ROUNDED max-downtime figures. */
export interface AvailabilityTier {
  readonly availability: number;
  readonly maxDowntimePerYear: string;
  readonly applicationCategories: string;
}
// Verbatim from [AV] (column headers: Availability · Maximum Unavailability per year · Application Categories).
export const AVAILABILITY_TIERS: readonly AvailabilityTier[] = [
  { availability: 0.99, maxDowntimePerYear: '3 days 15 hours', applicationCategories: 'Batch processing, data extraction, transfer, and load jobs' },
  { availability: 0.999, maxDowntimePerYear: '8 hours 45 minutes', applicationCategories: 'Internal tools (knowledge management, project tracking)' },
  { availability: 0.9995, maxDowntimePerYear: '4 hours 22 minutes', applicationCategories: 'Online commerce, point of sale' },
  { availability: 0.9999, maxDowntimePerYear: '52 minutes', applicationCategories: 'Video delivery, broadcast workloads' },
  { availability: 0.99999, maxDowntimePerYear: '5 minutes', applicationCategories: 'ATM transactions, telecommunications workloads' },
];

/** A disaster-recovery strategy [DR]/[DRWP]. The four are listed in INCREASING cost/complexity and DECREASING
 *  RTO/RPO. `maxRpoSeconds`/`maxRtoSeconds` encode the UPPER bound of AWS's stated range, for the selection ladder. */
export interface DrTier {
  readonly name: string;
  readonly rpo: string; // AWS's verbatim phrasing
  readonly rto: string;
  readonly maxRpoSeconds: number;
  readonly maxRtoSeconds: number;
  readonly mechanism: string;
}
export const DR_TIERS: readonly DrTier[] = [
  { name: 'Backup & Restore', rpo: 'hours', rto: '≤ 24 hours', maxRpoSeconds: 4 * 3600, maxRtoSeconds: 24 * 3600, mechanism: 'Back up data + IaC to the recovery Region; on disaster, redeploy infra, deploy code, then restore data.' },
  { name: 'Pilot Light', rpo: 'minutes', rto: 'tens of minutes', maxRpoSeconds: 5 * 60, maxRtoSeconds: 30 * 60, mechanism: 'Core infra + data always-on and replicated; app servers deployed but off, created/scaled on failover.' },
  { name: 'Warm Standby', rpo: 'seconds', rto: 'minutes', maxRpoSeconds: 60, maxRtoSeconds: 5 * 60, mechanism: 'A scaled-down but fully functional copy always running; scaled up to production load on recovery.' },
  { name: 'Multi-site Active/Active', rpo: 'near zero', rto: 'potentially zero', maxRpoSeconds: 1, maxRtoSeconds: 1, mechanism: 'Workload actively serves traffic from multiple Regions; needs cross-Region data sync + write-conflict handling.' },
];

/** The highest tier an achieved availability MEETS (its tier per [AV]); undefined below 99%. */
export function availabilityTier(achieved: number): AvailabilityTier | undefined {
  let hit: AvailabilityTier | undefined;
  for (const t of AVAILABILITY_TIERS) if (achieved >= t.availability) hit = t;
  return hit;
}

/** The cheapest DR strategy whose RTO and RPO both satisfy the requirement [DR]: "avoid implementing a strategy
 *  that is more stringent than it needs to be." Falls back to the strictest tier if the requirement beats it. */
export function recommendDrTier(requiredRpoSeconds: number, requiredRtoSeconds: number): DrTier {
  return DR_TIERS.find((t) => t.maxRpoSeconds <= requiredRpoSeconds && t.maxRtoSeconds <= requiredRtoSeconds) ?? (DR_TIERS[DR_TIERS.length - 1] as DrTier);
}

export interface ReliabilityAdvice {
  readonly achieved: number;
  readonly achievedTier: string; // e.g. "99.95% (max 4 hours 22 minutes/yr)"
  readonly target?: number;
  readonly meetsTarget?: boolean;
  readonly remedy?: string; // the AWS-documented action, with the source
  readonly source: string;
}

const pct = (a: number): string => `${(a * 100).toFixed(a >= 0.99999 ? 3 : 2)}%`;
const tierLabel = (t: AvailabilityTier | undefined): string => (t ? `${pct(t.availability)} (max ${t.maxDowntimePerYear}/yr — ${t.applicationCategories})` : 'below 99%');

/**
 * Turn a computed availability into the AWS-documented reading + remedy. The remedy is AWS's own guidance [AV]:
 * availability is raised by INDEPENDENT redundancy (another AZ) — "100% minus the product of the component
 * failure rates"; two independent three-nines components give six nines (the nines-add shortcut). For
 * region-loss resilience, a DR tier is chosen by RTO/RPO [DR].
 */
export function reliabilityAdvice(achieved: number, target?: number, weakest?: { node: string; availability: number }): ReliabilityAdvice {
  const achievedTier = tierLabel(availabilityTier(achieved));
  if (target === undefined) return { achieved, achievedTier, source: RELIABILITY_SOURCES.availability };
  const meetsTarget = achieved >= target - 1e-12;
  const targetTier = availabilityTier(target);
  const weakestPart = weakest ? ` The weakest hard dependency is "${weakest.node}" (${pct(weakest.availability)}).` : '';
  const remedy = meetsTarget
    ? undefined
    : `Achieves ${achievedTier} but the target ${tierLabel(targetTier)} is not met.${weakestPart} AWS remedy: availability is raised by INDEPENDENT redundancy — add a second independent component in another Availability Zone (effective availability = 100% − product of failure rates; two independent three-nines components → six nines). For Region-loss resilience choose a DR tier by RTO/RPO (Backup & Restore → Pilot Light → Warm Standby → Multi-site Active/Active), the cheapest whose RTO and RPO both meet the requirement.`;
  return { achieved, achievedTier, target, meetsTarget, ...(remedy !== undefined ? { remedy } : {}), source: RELIABILITY_SOURCES.availability };
}
