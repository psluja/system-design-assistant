import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, manifests, commonManifests } from '@sda/content';
import { buildTools, type ToolDef, type ToolResult } from './tools';
import { buildReliabilityTools } from './reliability';

const catalog = { ...manifests, ...commonManifests };
const run = (set: ToolDef[], name: string, a: Record<string, unknown> = {}): ToolResult => {
  const t = set.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t.run(a);
};

describe('reliability MCP tool — sourced AWS advice on the live design', () => {
  it('names the single-AZ DB as weakest, and Multi-AZ RAISES availability (verified, sourced RDS SLAs)', () => {
    const s = new Studio(registry, catalog);
    const tools = buildTools(s);
    const reli = buildReliabilityTools(s);
    run(tools, 'apply_design', { instances: [{ id: 'client', type: 'client.web', config: { throughput: 100 } }, { id: 'svc', type: 'compute.service' }, { id: 'db', type: 'db.postgres' }], wires: [['client', 'svc'], ['svc', 'db', 'db']] });

    const at = (target: number) =>
      JSON.parse(run(reli, 'reliability', { target }).text) as { flows: Array<{ achieved: number; achievedTier: string; meetsTarget: boolean; remedy?: string }>; sources: Record<string, string> };

    // single-AZ RDS = 99.5% (sourced) ⇒ the DB is the weakest hard dependency and the target is missed.
    run(tools, 'set_config', { node: 'db', key: 'deploymentMode', value: 0 });
    const single = at(0.9999);
    expect(single.flows[0]!.meetsTarget).toBe(false);
    expect(single.flows[0]!.remedy).toContain('Availability Zone'); // the AWS-documented remedy
    expect(single.flows[0]!.remedy).toContain('db'); // names the weakest dependency
    expect(single.sources.availability).toContain('docs.aws.amazon.com');
    const aSingle = single.flows[0]!.achieved;

    // Multi-AZ RDS = 99.95% (sourced) ⇒ availability RISES — a verified numeric change, not just advice.
    run(tools, 'set_config', { node: 'db', key: 'deploymentMode', value: 1 });
    expect(at(0.9999).flows[0]!.achieved).toBeGreaterThan(aSingle);
  });

  it('recommends a DR tier from an RTO/RPO requirement', () => {
    const s = new Studio(registry, catalog);
    const tools = buildTools(s);
    const reli = buildReliabilityTools(s);
    run(tools, 'apply_design', { instances: [{ id: 'a', type: 'client.web' }, { id: 'b', type: 'db.postgres' }], wires: [['a', 'b']] });
    const out = JSON.parse(run(reli, 'reliability', { rpoSeconds: 3600, rtoSeconds: 3600 }).text) as { recommendedDrTier?: { name: string } };
    expect(out.recommendedDrTier?.name).toBe('Pilot Light');
  });
});
