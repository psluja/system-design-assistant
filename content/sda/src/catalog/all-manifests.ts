import type { Manifest } from '../vocabulary/manifest';
import { manifests } from './catalog';
import { commonManifests } from './common';
import { voiceManifests } from './voice';
import { fargateManifests } from './fargate';

/**
 * The COMPLETE seed catalog — every built-in component across all four catalog files, merged into one map. It is
 * the single source every surface (the web app, the MCP tools, the tests) should place components from, so adding
 * a new catalog file is a ONE-line change HERE, not an edit to ~15 duplicated `{ ...manifests, ...common, … }`
 * union sites (OCP: extending content must not force edits in the app). Later catalogs win on a key collision —
 * the same precedence the hand-written unions had.
 */
export const allManifests: Readonly<Record<string, Manifest>> = {
  ...manifests,
  ...commonManifests,
  ...voiceManifests,
  ...fargateManifests,
};
