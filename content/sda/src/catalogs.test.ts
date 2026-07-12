import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { allCatalogs } from './protocols';

// Catalog integrity guard. The app/MCP merge the catalogs with object spread, so a type defined in two
// catalogs silently shadows (last-spread wins) — exactly the bug where the demand-sized `compute.fargate`
// got hidden by the ALB-case one (memory `catalog-fargate-conflict`). These checks fail loudly instead.

describe('catalog integrity', () => {
  it('every manifest is keyed by its own type', () => {
    for (const catalog of allCatalogs) {
      for (const [key, manifest] of Object.entries(catalog)) {
        expect(manifest.type, `catalog key "${key}" ≠ manifest.type "${manifest.type}"`).toBe(key);
      }
    }
  });

  it('no component type is defined in more than one catalog (no silent shadowing on merge)', () => {
    const seen = new Map<string, number>();
    for (const catalog of allCatalogs) for (const type of Object.keys(catalog)) seen.set(type, (seen.get(type) ?? 0) + 1);
    const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([type]) => type);
    expect(duplicates, `types defined in >1 catalog: ${duplicates.join(', ')}`).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// PRICING-IDENTITY LINT. The owner's provenance rule: a COST must state its PRICING IDENTITY, so a reader can
// tell whether e.g. `search.elasticsearch` prices a SELF-MANAGED EC2 cluster or the AWS OpenSearch MANAGED service
// ("to powinno być wiadome"). A bare `unitCostConfig(0.036, 'USD/(query/s)·month')` is silent about that. The
// numbers are pure DATA; the identity + rate basis ride ALONGSIDE them as the manifest's DESCRIPTION — the
// same discipline as `ManifestConfig.source`/`est`, but for the cost model's provenance, which the register does
// not carry today.
//
// THE ONE-FORM RULE (mechanical, enforced here): every `unitCostConfig(<price>, …)` CALL SITE in a catalog file
// carries a SAME-LINE `//` comment that names BOTH
//   1. the OPERATIONAL identity — `managed` (a cloud provider runs + bills it) vs `self-managed` (you run it on
//      your own EC2/VM/pods), the managed-vs-self-managed axis the owner could not tell apart; AND
//   2. the RATE BASIS — `est.` (an honest estimate), `sourced`/a URL (a documented price), or `list`/`on-demand`/
//      `pay-per-use`/`illustrative` (how the rate is billed), the list-vs-committed axis.
// A new priced component that omits either fails LOUDLY here, the moment it is added — the cost can never again be
// an unlabelled magic number. (Egress prices use `egress()` in behaviors.ts, which already carries a sourced
// `egressUsdPerGb` — a different, already-provenanced helper, so it is out of this lint's scope.)
describe('pricing-identity lint (every unitCost states managed-vs-self-managed + rate basis)', () => {
  // The catalog source files (data-only manifest modules). Read as TEXT: the identity lives in the DESCRIPTION
  // comment beside the call, which is not recoverable from the compiled manifest object.
  const CATALOG_FILES = ['catalog.ts', 'common.ts', 'voice.ts', 'fargate.ts'] as const;
  // A CALL site (a numeric price after the paren) — NOT the helper's definition in behaviors.ts nor an import.
  const CALL = /unitCostConfig\(\s*[\d.]/;
  const IDENTITY = /self-managed|managed/i; // "self-managed" also satisfies the managed-vs-self axis explicitly
  // Plain substrings (no \b): "est." ends in a period, which a trailing \b would refuse to match before ")".
  const BASIS = /est\.|sourced|list|on-demand|pay-per-use|illustrative|https?:\/\//i;

  let total = 0;
  for (const file of CATALOG_FILES) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!CALL.test(line)) return;
      total++;
      const commentAt = line.indexOf('//');
      const comment = commentAt >= 0 ? line.slice(commentAt) : '';
      const where = `${file}:${i + 1}: ${line.trim()}`;
      it(`states its pricing identity — ${where}`, () => {
        expect(commentAt, `no same-line // comment naming the pricing identity — ${where}`).toBeGreaterThanOrEqual(0);
        expect(IDENTITY.test(comment), `comment does not name managed vs self-managed — ${where}`).toBe(true);
        expect(BASIS.test(comment), `comment does not name the rate basis (est./sourced/list/…) — ${where}`).toBe(true);
      });
    });
  }

  // Guard against a regex that silently matches NOTHING (a vacuously-green lint): the catalog has dozens of priced
  // components, so far fewer than 30 call sites means the scanner broke, not that the catalog shrank.
  it('scans every priced component (the lint is not vacuously green)', () => {
    expect(total, 'the unitCostConfig scanner matched too few call sites — did the regex or file list drift?').toBeGreaterThanOrEqual(30);
  });
});
