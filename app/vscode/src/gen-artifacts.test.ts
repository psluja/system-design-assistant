import { it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildDesignDocText } from './design-doc-host';

// ARTIFACT GENERATOR (design-doc-v2 R3, refreshed 2026-07-03). Regenerates the two committed HTML deliverables from
// the REAL surface: `buildDesignDocText(text, 'html')` is the exact function the VS Code `generate_doc`/design-doc
// command runs (and the twin of the MCP `generate_doc { format: 'html' }` tool — both build ONE DesignDocInput and
// call `renderDesignDocHtml`). We drive it with the real example `examples/ecommerce-production.sda.json`, so the
// artifacts are a faithful capture of what a user gets, not a synthetic fixture.
//
// GATED behind `SDA_GEN_ARTIFACTS` so the normal suite never writes to the repo. Regenerate with:
//   $env:SDA_GEN_ARTIFACTS="1"; pnpm --filter sda-vscode exec vitest run gen-artifacts
//
// DETERMINISM: the real surface mints `generatedAt` from `new Date()` (the timestamp is a surface concern, not the
// model). For a STABLE committed artifact we pin that one minted field to a fixed date after rendering — the only
// non-deterministic byte — so re-running yields identical files and the two artifacts are byte-identical.
const PINNED_GENERATED_AT = '2026-07-03T09:00:00Z';

it.runIf(process.env.SDA_GEN_ARTIFACTS)('regenerates the ecommerce design-doc artifacts (html)', () => {
  const example = new URL('../../../examples/ecommerce-production.sda.json', import.meta.url);
  const text = readFileSync(example, 'utf8');

  const gen = buildDesignDocText(text, 'html');
  if (gen === null) throw new Error('ecommerce example did not build/evaluate — cannot generate the artifact');

  // Pin the single minted timestamp (an ISO string) so the committed artifact is reproducible. The register/charts
  // are already a pure function of the model, so this is the only churny byte.
  const html = gen.text.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, PINNED_GENERATED_AT);

  for (const name of ['final-acceptance-design-doc.html', 'sample-generated-design-doc.html']) {
    const target = new URL(`../../../docs/design/${name}`, import.meta.url);
    writeFileSync(target, html, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`wrote ${target.pathname} (${Buffer.byteLength(html, 'utf8')} bytes)`);
  }
});
