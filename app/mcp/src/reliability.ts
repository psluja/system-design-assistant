import { NodeId, type Key } from '@sda/engine-core';
import type { Studio } from '@sda/core';
import { requestFlows, reliabilityAdvice, recommendDrTier, localOwnAvailability, AVAILABILITY_TIERS, DR_TIERS, RELIABILITY_SOURCES, keys } from '@sda/content';
import type { ToolDef } from './tools';
import { fail, json, obj, READS } from './tool-kit';

// The reliability advisor as an MCP tool — turns the engine's COMPUTED availability (a series product of hard
// dependencies) into the AWS Well-Architected reading + the DOCUMENTED remedy. Every figure it returns is
// sourced (RELIABILITY_SOURCES); the suggestion is AWS guidance, not opinion (doc-10 reliability gap).

export function buildReliabilityTools(studio: Studio): ToolDef[] {
  return [
    {
      name: 'reliability',
      description:
        'Reliability advice grounded in the AWS Well-Architected Reliability pillar (sourced, never opinion). Per request flow: the computed end-to-end availability (series product of hard dependencies), the AWS nines tier it meets (+ max downtime/yr + the workload class), and — given an availability `target` (ratio) — the AWS-documented remedy (independent redundancy in another AZ; the nines-add math) naming the weakest hard dependency. Given `rpoSeconds`+`rtoSeconds`, also recommends the DR tier (Backup&Restore → Pilot Light → Warm Standby → Multi-site). This is availability/DR advice, NOT a provisioning knob — optimize cannot raise nines; use this. e.g. {target:0.9999} or {rpoSeconds:60, rtoSeconds:300}',
      inputSchema: obj({ target: { type: 'number' }, rpoSeconds: { type: 'number' }, rtoSeconds: { type: 'number' } }),
      annotations: READS,
      run: (a) => {
        const ev = studio.evaluate();
        if (!ev.ok) return fail('design has build errors — resolve those first');
        const proj = studio.project();
        const av: Key = keys.availability;
        const value = (id: string, k: Key): number | undefined => ev.value.value(NodeId(id), k);

        // Each component's OWN availability (not the cumulative product) — to name the weakest hard dependency.
        // The PRODUCT-inverse decomposition lives in @sda/content (shared with the web design-doc), so this
        // advisor never re-derives the domain math and can't drift from the engine's aggregation.
        const ownMap = localOwnAvailability(value, proj.instances, proj.wires);

        const target = a.target !== undefined ? Number(a.target) : undefined;
        const flows = requestFlows(proj.instances, proj.wires, value).map((f) => {
          const achieved = value(f.terminal, av) ?? 1;
          let weakest: { node: string; availability: number } | undefined;
          for (const id of f.ids) {
            const own = ownMap[id];
            if (own !== undefined && (weakest === undefined || own < weakest.availability)) weakest = { node: id, availability: own };
          }
          return { sourceNode: f.source, terminal: f.terminal, ...reliabilityAdvice(achieved, target, weakest) };
        });

        const recommendedDrTier =
          a.rpoSeconds !== undefined && a.rtoSeconds !== undefined ? recommendDrTier(Number(a.rpoSeconds), Number(a.rtoSeconds)) : undefined;

        return json({ flows, ...(recommendedDrTier !== undefined ? { recommendedDrTier } : {}), availabilityTiers: AVAILABILITY_TIERS, drTiers: DR_TIERS, sources: RELIABILITY_SOURCES });
      },
    },
  ];
}
