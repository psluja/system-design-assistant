// THE `calibrate` COMMAND (Job 2 + 6). Deterministic, no AI per iteration: load the corpus, run the whole
// harness (predict → compare → fit → residual → leave-one-out), write CALIBRATION-REPORT.md + the review-only
// PROPOSED-DEFAULTS.json, and print a summary. `--check` additionally guards the pinned fidelity baseline and exits
// non-zero on a regression, so CI can gate fidelity the way the solver oracle gates solver agreement.
//
//   pnpm calibrate           # write the report + proposed defaults, print the summary
//   pnpm calibrate:check     # the above, then fail if any residual regressed beyond tolerance

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { calibrationRoot, loadCorpus } from './corpus';
import { buildReport, proposedDefaults, renderReport } from './report';
import { checkAgainstBaseline, TOLERANCE_PCT } from './baseline';

const pct = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`; // signed error
const mag = (x: number): string => (Number.isFinite(x) ? `${x.toFixed(1)}%` : 'n/a'); // unsigned magnitude
const val = (x: number, unit: string): string => (!Number.isFinite(x) ? 'n/a' : unit.trim() === '%' ? x.toFixed(2) : Math.round(x).toLocaleString('en-US'));

function main(): void {
  const check = process.argv.slice(2).includes('--check');
  const root = calibrationRoot();
  const entries = loadCorpus(root);
  const report = buildReport(entries);

  writeFileSync(join(root, 'CALIBRATION-REPORT.md'), renderReport(report) + '\n', 'utf8');
  writeFileSync(join(root, 'PROPOSED-DEFAULTS.json'), proposedDefaults(report) + '\n', 'utf8');

  // ── summary to stdout ──────────────────────────────────────────────────────────────────────────────────────
  console.log('SDA calibration — deterministic fit over ' + entries.length + ' corpus entries\n');

  console.log('Fitted tunables (RECOMMENDED, not applied):');
  for (const r of report.recommendations) console.log(`  ${r.selector}.${r.key}: ships ${r.catalogDefault} ${r.unit} -> fitted ${Number(r.fitted.toPrecision(4))} ${r.unit}`);
  console.log('');

  console.log('Per-entry residual (out-of-box -> fitted):');
  for (const er of report.fit.residuals) {
    if (er.points.length === 0) { console.log(`  ${er.name}: no scored points (measured unknown)`); continue; }
    for (const p of er.points) console.log(`  ${er.name} [${p.metric}]: measured ${val(p.measured, p.unit)} ${p.unit} | default ${val(p.predictedDefault, p.unit)} (${pct(p.errorDefaultPct)}) -> fitted ${val(p.predictedFitted, p.unit)} (${pct(p.errorFittedPct)})`);
    console.log(`    residual (RMS): ${mag(er.rmsFittedPct)}`);
  }
  console.log('');

  console.log(`Aggregate post-fit error (RMS): ${mag(report.fit.objective * 100)}`);
  console.log('Leave-one-out generalization:');
  for (const l of report.loo) {
    const summary = l.errors.length > 0 ? l.errors.map((e) => `${e.metric} ${pct(e.errorPct)}`).join(', ') : 'no scored points';
    console.log(`  hold out ${l.heldOut}: ${summary}  ${l.constrained ? '[out-of-sample]' : '[disjoint fallback]'}`);
  }
  console.log('');

  console.log('Wrote calibration/CALIBRATION-REPORT.md and calibration/PROPOSED-DEFAULTS.json');

  if (check) {
    const violations = checkAgainstBaseline(report);
    if (violations.length > 0) {
      console.error(`\nFIDELITY REGRESSION (tolerance ${TOLERANCE_PCT} pp):`);
      for (const v of violations) console.error(`  ${v.what}: baseline ${v.baseline.toFixed(2)}% -> now ${v.actual.toFixed(2)}%`);
      process.exit(1);
    }
    console.log('\n--check: all residuals within baseline tolerance.');
  }
}

main();
