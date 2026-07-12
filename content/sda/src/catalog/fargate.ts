import { keys as k } from '../vocabulary/registry';
import type { Manifest } from '../vocabulary/manifest';
import { availabilityByDeployment, costPer, provisionedCost, unitCostConfig, withDeploymentCost, withOrigin, withOverflow } from './behaviors';
import { writerGuarantees } from '../vocabulary/guarantees';

// Aurora is covered by the Amazon RDS SLA: single-AZ 99.5%, Multi-AZ 99.95% (https://aws.amazon.com/rds/sla/).
// Default Multi-AZ (the writer + reader cluster); deploymentMode 0 drops to single-instance.
const AURORA_SLA_SOURCE = 'https://aws.amazon.com/rds/sla/';
const AURORA_AVAILABILITY = availabilityByDeployment(0.995, 0.9995, 0.9995, AURORA_SLA_SOURCE);

/**
 * A SECOND real case from the CDK (C:\git\Architectureasaservice2 ·
 * templates/lib/ArchitectureAsAServiceStack): the classic 3-tier web stack
 *   client → WAF → API Gateway (REST) → ALB → ECS Fargate → Aurora PostgreSQL.
 *
 * SOURCING: structural facts + sizing from the CDK — Fargate task cpu 256 (0.25 vCPU) / memory 512 MiB
 * / desiredCount 1 (a single small task, no autoscaling); Aurora Postgres 16, writer t3.medium + 1
 * reader. Per-request times / concurrency are `est.` (workload-dependent). The single Fargate task is
 * both the capacity bottleneck AND a redundancy gap (availability) — exactly what this stack should be
 * told about.
 */
export const fargateManifests: Readonly<Record<string, Manifest>> = withOverflow(withOrigin({
  'security.waf': {
    type: 'security.waf',
    ports: [
      { name: 'in', dir: 'in', accepts: ['http'] },
      { name: 'out', dir: 'out', speaks: ['http'] },
    ],
    config: [
      { key: k.throughput, value: 100000, unit: 'req/s', est: true },
      { key: k.latency, value: 2, unit: 'ms', est: true }, // est. rule evaluation overhead
      // corrected to the published AWS WAF SLA — 99.95% Monthly Uptime Percentage (verified live
      // 2026-07-12) — https://aws.amazon.com/waf/sla/.
      { key: k.availability, value: 0.9995, unit: 'ratio', source: 'https://aws.amazon.com/waf/sla/' },
      unitCostConfig(0.0001, 'USD/(req/s)·month'), // managed AWS WAF (est.): ~$10/mo at the default 100k rps ceiling
    ],
    relations: [provisionedCost],
  },

  'apigw.rest': {
    type: 'apigw.rest',
    ports: [
      { name: 'in', dir: 'in', accepts: ['http'] },
      { name: 'out', dir: 'out', speaks: ['http'] },
    ],
    config: [
      { key: k.throughput, value: 10000, unit: 'req/s', source: 'https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html' }, // default account throttle (10k rps)
      { key: k.latency, value: 10, unit: 'ms', est: true }, // est.
      { key: k.availability, value: 0.9995, unit: 'ratio', source: 'https://aws.amazon.com/api-gateway/sla/' }, // API Gateway SLA 99.95%
      unitCostConfig(0.003, 'USD/(req/s)·month'), // managed AWS API Gateway (est.): ~$30/mo at the default 10k rps throttle
    ],
    relations: [provisionedCost],
  },

  'lb.alb': {
    type: 'lb.alb',
    ports: [
      { name: 'in', dir: 'in', accepts: ['http'] },
      { name: 'out', dir: 'out', speaks: ['http'] },
    ],
    config: [
      { key: k.throughput, value: 50000, unit: 'req/s', est: true },
      { key: k.latency, value: 2, unit: 'ms', est: true }, // est.
      { key: k.availability, value: 0.9999, unit: 'ratio', source: 'https://aws.amazon.com/elasticloadbalancing/sla/' }, // ALB SLA 99.99% (Multi-AZ)
      unitCostConfig(0.0005, 'USD/(req/s)·month'), // managed AWS ALB (est.): ~$25/mo at the default 50k rps ceiling
    ],
    relations: [provisionedCost],
  },

  // NOTE: the single 0.25 vCPU task (desiredCount 1, no autoscaling) is NOT a separate component — it is
  // the canonical demand-sized `compute.fargate` (common.ts) CONFIGURED as a one-task fleet
  // (`maxUnits: 1`, est. concurrency/duration/availability). Redefining the type here previously shadowed
  // the sized fleet across the app (see memory `catalog-fargate-conflict`); content is data, so the case
  // lives as instance config in fargate.e2e.test, not as a second manifest.

  // Aurora Postgres cluster (writer t3.medium + 1 reader): connection-bound, cluster availability.
  'db.aurora': {
    type: 'db.aurora',
    // The Aurora cluster WRITER endpoint: reads off it are strongly consistent (read-your-writes off the primary).
    // (The separate reader endpoint would be `eventual`; this single `in` is the writer endpoint.)
    ports: [{ name: 'in', dir: 'in', accepts: ['postgresql'], guarantees: writerGuarantees }],
    config: [
      { key: k.concurrency, value: 200, unit: '1', est: true }, // est. max_connections for a t3.medium Aurora PG
      { key: k.perRequestDuration, value: 20, unit: 'ms', est: true },
      { key: k.latency, value: 20, unit: 'ms', est: true },
      AURORA_AVAILABILITY.config, // deploymentMode (default Multi-AZ); availability = sourced RDS SLA per mode
      unitCostConfig(0.9, 'USD/conn·month'), // managed AWS Aurora (est.): ~$180/mo at the default 200 connections (t3.medium)
    ],
    // cost = connections × base, THEN the deployment surcharge: Aurora Multi-AZ = writer + reader, each billed
    // per instance (task-77) — the reader is not free, so Multi-AZ ≈ 2× the single-instance price.
    relations: [{ key: k.throughput, reads: [k.concurrency, k.perRequestDuration], expr: 'concurrency / (perRequestDuration / 1000)' }, AURORA_AVAILABILITY.relation, withDeploymentCost(costPer(k.concurrency))],
  },
}));
