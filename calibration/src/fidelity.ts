// THE `fidelity` COMMAND (doc: verification-and-validation.html §7, Phase 1). Deterministic, no AI, no clock, no
// RNG: load the corpus, run the deterministic fit (DES OFF — the fast fit-only lane, doc §10), build the coverage
// matrix, and write the generated docs/FIDELITY.md. A freshness test (fidelity.test.ts) then asserts the committed
// file equals this emit, exactly as scripts/generate-catalogs.test.ts guards the algorithm catalog.
//
//   pnpm fidelity           # regenerate docs/FIDELITY.md and print the honest headline

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { calibrationRoot, loadCorpus } from './corpus';
import { buildReport } from './report';
import { buildCoverage, renderFidelity } from './coverage';

/** The repository root (calibration/ is one package under it) — where docs/ lives. */
export const repoRoot = (): string => resolve(calibrationRoot(), '..');
/** The committed generated report path. */
export const fidelityPath = (): string => join(repoRoot(), 'docs', 'FIDELITY.md');

function main(): void {
  const entries = loadCorpus();
  const report = buildReport(entries, false); // DES off: the fast, fully-deterministic fit-only lane
  const matrix = buildCoverage(entries, report);

  writeFileSync(fidelityPath(), renderFidelity(matrix, report) + '\n', 'utf8');

  const h = matrix.headline;
  console.log('SDA fidelity — the honest V&V coverage state\n');
  console.log(`Performance fidelity (fitted): ${h.perfFidelityPct} over ${h.perfScoredPoints} scored points (out-of-sample ${h.oosPct})`);
  console.log(`Cost fidelity: ${h.costFidelity}`);
  console.log(`Availability fidelity: ${h.availabilityFidelity}`);
  console.log(`Modeling behaviors (${h.totalFamilies}) by nature: ${h.byNature.map((g) => `${g.families.length} ${g.nature}`).join(' · ')}`);
  console.log(`Capabilities (${h.totalCapabilities}): ${h.validated} validated · ${h.verified} verified · ${h.sourced} sourced · ${h.unvalidated} no-anchor`);
  console.log(`Corpus: ${h.architectures} architectures · gaps: ${h.structuralGaps} structural + ${h.verificationGaps} verification`);
  console.log('\nWrote docs/FIDELITY.md');
}

// CLI entry only — import-safe so the barrel (index.ts) and the freshness test can import the path helpers
// without triggering a write (the generate-catalogs.mjs idiom).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
