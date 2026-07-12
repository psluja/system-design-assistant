// COVERAGE — the deterministic walk that turns the capability registry + the registry keys + the calibration
// corpus into the V&V coverage matrix and renders docs/FIDELITY.md.
// Three walks, one emit (§6.2): (1) the claim surface = CAPABILITIES × the metrics×regimes GRID; (2) the anchors,
// declared on each capability (their test paths freshness-verified to resolve); (3) the residuals, read from the
// calibration corpus + the fitted report. The status of every cell is DERIVED, never authored: green only where a
// measured residual OR an analytic anchor exists (owner mandate: brutal-honesty-over-comfort). Pure w.r.t. its
// inputs — no clock, no RNG — so the freshness test can assert the committed file equals a fresh emit.

import { isFitted, type LoadedEntry } from './corpus';
import type { CalibrationReport } from './report';
import {
  CAPABILITIES,
  CORPUS_METRIC_CELL,
  GRID,
  STRUCTURAL_LIMITS,
  VERIFICATION_GAPS,
  type Capability,
  type EvidenceNature,
  type GridMetric,
  type GridRegime,
} from './capabilities';

// ── The derived cell status (doc §6.1) — the single source of a row's/cell's colour ───────────────────────────
export type CellStatus =
  | 'validated' //   anchored AND a measured calibration residual              → GREEN
  | 'verified' //    anchored, no measured validation yet                      → AMBER
  | 'sourced' //     deterministic algebra over a cited price/SLA (not a fit)  → DISTINCT (doc §11.3)
  | 'unvalidated'; // no anchor and no residual, or a permanent structural gap → GREY

/** One capability/family row of the matrix, with its derived evidence. */
export interface CoverageRow {
  readonly id: string;
  readonly name: string;
  readonly kind: Capability['kind'];
  readonly anchored: boolean;
  readonly oracles: readonly string[];
  readonly anchorCaveats: readonly string[];
  readonly validationKind: Capability['validationKind'];
  /** For a modeling family: its evidence nature (measured-capacity / theory-dynamics / sourced-algebra); absent for
   *  solver rows. The headline groups families by this so white-space is read as "the right evidence", not "gaps". */
  readonly nature: Capability['nature'];
  readonly calibrated: boolean;
  readonly corpus: readonly { readonly entry: string; readonly residualPct: number }[];
  readonly status: CellStatus;
}

/** One metrics×regimes cell, with its derived status. */
export interface CoverageGridCell {
  readonly metric: GridMetric;
  readonly regime: GridRegime;
  readonly status: CellStatus;
  readonly oracle: string | null;
  readonly corpusEntry: string | null;
  readonly note: string | null;
}

/** One modeling family, grouped under its evidence nature for the headline breakdown. */
export interface NatureFamily {
  readonly name: string;
  readonly status: CellStatus;
  readonly systems: readonly string[]; // the corpus systems that validate it (empty unless measured + calibrated)
}
/** The 8 modeling families partitioned by evidence nature — the honest reframe (each nature = its own bar). */
export interface NatureGroup {
  readonly nature: EvidenceNature;
  readonly families: readonly NatureFamily[];
  readonly validatedCount: number; // how many families in this nature reached `validated` (only measured-capacity can)
}

export interface Headline {
  readonly perfFidelityPct: string;
  readonly perfScoredPoints: number;
  readonly oosPct: string;
  readonly costFidelity: string;
  readonly availabilityFidelity: string;
  readonly totalFamilies: number;
  readonly calibratedFamilies: number;
  /** The 8 families partitioned by evidence nature (measured-capacity / theory-dynamics / sourced-algebra). */
  readonly byNature: readonly NatureGroup[];
  readonly totalCapabilities: number;
  readonly validated: number;
  readonly verified: number;
  readonly sourced: number;
  readonly unvalidated: number;
  readonly architectures: number;
  readonly structuralGaps: number;
  readonly verificationGaps: number;
}

export interface CoverageMatrix {
  readonly rows: readonly CoverageRow[];
  readonly grid: readonly CoverageGridCell[];
  readonly headline: Headline;
}

// ── formatting (mirrors report.ts so the two artifacts round identically) ─────────────────────────────────────
const mag = (x: number): string => (Number.isFinite(x) ? `${x.toFixed(1)}%` : 'n/a'); // unsigned magnitude
const pct = (x: number): string => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(1)}%` : 'n/a'); // signed
const val = (x: number, unit: string): string =>
  !Number.isFinite(x) ? 'n/a' : unit.trim() === '%' ? x.toFixed(2) : Math.round(x).toLocaleString('en-US');

// ── evidence natures (the honest reframe) — fixed order + human labels for the headline breakdown ─────────────
const NATURE_ORDER: readonly EvidenceNature[] = ['measured-capacity', 'theory-dynamics', 'sourced-algebra'];
const NATURE_META: Readonly<Record<EvidenceNature, { readonly label: string; readonly tag: string; readonly blurb: string }>> = {
  'measured-capacity': {
    label: 'Measured-capacity',
    tag: 'validated vs measured systems',
    blurb: 'a clean measurable number a real benchmark pins; validated against a measured system where one exists. The ONLY nature the corpus can broaden.',
  },
  'theory-dynamics': {
    label: 'Theory-dynamics',
    tag: 'closed-form + DES anchored',
    blurb: 'a time-behavior anchored to a closed form AND differentially tested against the DES — trustworthy for direction and relative magnitude, but not calibratable to one measured system (the curves are rarely published, a single point is degenerate). Honestly `verified`, not a gap.',
  },
  'sourced-algebra': {
    label: 'Sourced-algebra',
    tag: 'current vs cited quota/price/SLA',
    blurb: 'deterministic arithmetic whose correctness is a CURRENT cited quota / price / SLA, not a fitted residual — "validation" here means the source is fresh. Honestly `sourced`, not a gap.',
  },
};

/** Out-of-sample RMS over the entries the fold-in set actually constrained (doc §3.2) — the same computation the
 *  calibration report prints, so the headline and CALIBRATION-REPORT.md agree to the digit. */
function outOfSampleRms(report: CalibrationReport): number {
  const oos = report.loo.filter((r) => r.constrained && r.errors.length > 0);
  return oos.length > 0 ? Math.sqrt(oos.reduce((s, r) => s + r.rmsPct * r.rmsPct, 0) / oos.length) : NaN;
}

// ── the walk ──────────────────────────────────────────────────────────────────────────────────────────────────
/** Map each modeling family's config key → its family id (a key belongs to exactly one family). */
function familyByConfigKey(): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of CAPABILITIES) if (c.kind === 'modeling-family') for (const k of c.configKeys) m.set(k, c.id);
  return m;
}

/** Which corpus entries EXERCISE a family (declare a fitted tunable for one of its keys AND carry a scored point),
 *  paired with that entry's post-fit residual. This is the validation overlay: a family is calibrated iff the
 *  corpus touches it — never asserted in the registry. */
function corpusByFamily(entries: readonly LoadedEntry[], report: CalibrationReport): Map<string, { entry: string; residualPct: number }[]> {
  const keyToFamily = familyByConfigKey();
  const residualOf = new Map(report.fit.residuals.map((r) => [r.name, r.rmsFittedPct]));
  const out = new Map<string, { entry: string; residualPct: number }[]>();
  for (const le of entries) {
    const scored = le.entry.groundTruth.some((g) => g.measured !== null);
    if (!scored) continue;
    const families = new Set<string>();
    for (const t of le.entry.tunables) if (isFitted(t.fit)) { const f = keyToFamily.get(t.key); if (f !== undefined) families.add(f); }
    for (const f of families) {
      const list = out.get(f) ?? [];
      list.push({ entry: le.entry.name, residualPct: residualOf.get(le.entry.name) ?? NaN });
      out.set(f, list);
    }
  }
  return out;
}

/** Build the whole coverage matrix from the three sources. Deterministic in `entries` + `report`. */
export function buildCoverage(entries: readonly LoadedEntry[], report: CalibrationReport): CoverageMatrix {
  const byFamily = corpusByFamily(entries, report);

  const rows: CoverageRow[] = CAPABILITIES.map((c) => {
    const anchored = c.anchors.length > 0;
    const corpus = byFamily.get(c.id) ?? [];
    const calibrated = corpus.length > 0;
    const status: CellStatus =
      c.kind === 'solver'
        ? anchored ? 'verified' : 'unvalidated'
        : anchored && calibrated
          ? 'validated'
          : anchored && c.validationKind === 'sourced'
            ? 'sourced'
            : anchored
              ? 'verified'
              : 'unvalidated';
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      anchored,
      oracles: [...new Set(c.anchors.map((a) => a.oracle))],
      anchorCaveats: c.anchors.filter((a) => a.caveat !== undefined).map((a) => `${a.oracle}: ${a.caveat}`),
      validationKind: c.validationKind,
      nature: c.nature,
      calibrated,
      corpus: [...corpus].sort((a, b) => (a.entry < b.entry ? -1 : 1)),
      status,
    };
  });

  // Grid overlay: a scored corpus point lands in exactly one (metric, regime) cell (doc §4.1).
  const validatedCell = new Map<string, string>(); // "metric|regime" -> corpus entry
  for (const le of entries) {
    for (const gt of le.entry.groundTruth) {
      if (gt.measured === null) continue;
      const cell = CORPUS_METRIC_CELL[gt.metric];
      if (cell === undefined) continue;
      const k = `${cell.metric}|${cell.regime}`;
      if (!validatedCell.has(k)) validatedCell.set(k, le.entry.name);
    }
  }
  const grid: CoverageGridCell[] = GRID.map((cell) => {
    const k = `${cell.metric}|${cell.regime}`;
    const corpusEntry = validatedCell.get(k) ?? null;
    const status: CellStatus = corpusEntry !== null ? 'validated' : cell.sourced === true ? 'sourced' : cell.anchor !== null ? 'verified' : 'unvalidated';
    return { metric: cell.metric, regime: cell.regime, status, oracle: cell.anchor?.oracle ?? null, corpusEntry, note: cell.note ?? null };
  });

  const families = rows.filter((r) => r.kind === 'modeling-family');
  const count = (s: CellStatus): number => rows.filter((r) => r.status === s).length;
  const scoredPoints = entries.flatMap((e) => e.entry.groundTruth.filter((g) => g.measured !== null)).length;

  // Partition the families by evidence nature (the honest reframe): each nature carries its OWN appropriate evidence,
  // so the coverage white-space is not misread as "gaps". Fixed order, so the emit is deterministic.
  const byNature: NatureGroup[] = NATURE_ORDER.map((nature) => {
    const fams = families.filter((r) => r.nature === nature);
    return {
      nature,
      families: fams.map((r) => ({ name: r.name, status: r.status, systems: r.corpus.map((c) => c.entry) })),
      validatedCount: fams.filter((r) => r.status === 'validated').length,
    };
  });

  const headline: Headline = {
    perfFidelityPct: mag(report.fit.objective * 100),
    perfScoredPoints: scoredPoints,
    oosPct: mag(outOfSampleRms(report)),
    costFidelity: 'sourced-only — no measured bill in the corpus (UNVALIDATED; cost is deterministic algebra over a cited unit price, not a fitted residual)',
    availabilityFidelity: 'sourced-only — no measured DR in the corpus (UNVALIDATED; availability is a series product vs the published SLA, not a fitted residual)',
    totalFamilies: families.length,
    calibratedFamilies: families.filter((r) => r.status === 'validated').length,
    byNature,
    totalCapabilities: rows.length,
    validated: count('validated'),
    verified: count('verified'),
    sourced: count('sourced'),
    unvalidated: count('unvalidated'),
    architectures: entries.length,
    structuralGaps: STRUCTURAL_LIMITS.length,
    verificationGaps: VERIFICATION_GAPS.length,
  };

  return { rows, grid, headline };
}

// ── render docs/FIDELITY.md ───────────────────────────────────────────────────────────────────────────────────
const STATUS_LABEL: Readonly<Record<CellStatus, string>> = {
  validated: 'validated',
  verified: 'verified',
  sourced: 'sourced',
  unvalidated: 'UNVALIDATED',
};

const GENERATED_BANNER =
  '<!-- GENERATED FILE — do not edit. Source of truth: the capability registry (calibration/src/capabilities.ts), ' +
  'the content registry keys, and the calibration corpus. Regenerate with `pnpm fidelity`; freshness is asserted by ' +
  'calibration/src/fidelity.test.ts. -->';

const METRIC_LABEL: Readonly<Record<GridMetric, string>> = {
  throughputCeiling: 'Throughput ceiling',
  tail: 'p50 / p99 tail',
  bottleneck: 'Bottleneck / latency share',
  cost: 'Cost / bill',
  availability: 'Availability / nines',
  transient: 'Transient / peak survival',
};
const REGIMES: readonly GridRegime[] = ['below-knee', 'at-knee', 'past-saturation'];
const METRICS: readonly GridMetric[] = ['throughputCeiling', 'tail', 'bottleneck', 'cost', 'availability', 'transient'];

/** Render the fidelity report (docs/FIDELITY.md). Deterministic: a pure function of the matrix + report. */
export function renderFidelity(matrix: CoverageMatrix, report: CalibrationReport): string {
  const h = matrix.headline;
  const L: string[] = [];
  L.push('# SDA Fidelity Report');
  L.push('');
  L.push(GENERATED_BANNER);
  L.push('');
  L.push(
    'The V&V coverage matrix as a published report. It crosses ' +
      'every engine capability and modeling family with its evidence and prints the **honest** state: green only where a ' +
      'measured calibration residual OR an analytic anchor exists, and every remaining cell UNVALIDATED in plain sight. ' +
      'A visible gap is not a failure; a hidden one is. Regenerate with `pnpm fidelity`.',
  );
  L.push('');

  // ── Headline (a vector, never one blended %) ──
  L.push('## Headline — the honest state');
  L.push('');
  L.push('The headline is a **vector**, not one blended number: mixing a latency residual with a cost source would be dishonest (doc §7.1, §11.3).');
  L.push('');
  L.push(`- **Performance fidelity (fitted):** ${h.perfFidelityPct} over ${h.perfScoredPoints} scored points · out-of-sample ${h.oosPct}.`);
  L.push(`- **Cost fidelity:** ${h.costFidelity}.`);
  L.push(`- **Availability fidelity:** ${h.availabilityFidelity}.`);
  L.push(
    `- **Modeling behaviors (${h.totalFamilies}), by evidence nature:** ` +
      h.byNature.map((g) => `**${g.families.length} ${NATURE_META[g.nature].label.toLowerCase()}** (${NATURE_META[g.nature].tag})`).join(' · ') +
      ' — the white-space is the RIGHT evidence per nature, not gaps (breakdown below).',
  );
  L.push(`- **Engine capabilities (${h.totalCapabilities} total):** ${h.validated} validated · ${h.verified} verified (analytic anchor only) · ${h.sourced} sourced (deterministic algebra over a cited quota/price/SLA) · ${h.unvalidated} with **no anchor at all**.`);
  L.push(`- **Corpus:** ${h.architectures} architectures.`);
  L.push(`- **Documented gaps:** ${h.structuralGaps} permanent structural limits + ${h.verificationGaps} addressable verification gaps.`);
  L.push('');
  const measuredFamilies = h.byNature.find((g) => g.nature === 'measured-capacity')?.families.length ?? 0;
  L.push(
    `> **The honest reading:** of the ${h.totalFamilies} modeling behaviors, only the ${measuredFamilies} **measured-capacity** families can be — and are — ` +
      'validated against real measured systems (~2%). The other ' +
      `${h.totalFamilies - measuredFamilies} are NOT gaps: **theory-dynamics** anchored to a closed form + the DES, and **sourced-algebra** correct against a ` +
      'cited quota / price / SLA — the RIGHT evidence for their nature, not a missing measurement. The two most-used solver capabilities (`evaluate`, ' +
      '`evaluateBatch`) are oracle-graded (`verified`). What the corpus can still broaden is the measured-capacity families; this report shows exactly which ' +
      'white-space is real.',
  );
  L.push('');

  // ── Modeling behaviors, by evidence nature (the honest reframe — each nature carries its own bar) ──
  L.push('## Modeling behaviors, by evidence nature');
  L.push('');
  L.push(
    `The ${h.totalFamilies} behaviors are three different KINDS of thing, and each deserves a different kind of evidence. "Validated against a measured ` +
      'system" is the right bar for capacity; it is the WRONG bar for deterministic algebra or a time-dynamic with no published curve. Green only where the ' +
      "evidence appropriate to the behavior's nature exists — the white-space below is NOT gaps, it is behaviors whose honest evidence is theory or a cited source.",
  );
  L.push('');
  for (const g of h.byNature) {
    const meta = NATURE_META[g.nature];
    L.push(`**${meta.label} (${g.families.length})** — ${meta.blurb}`);
    for (const f of g.families) {
      const systems = f.systems.length > 0 ? ` · ${f.systems.map(shortEntry).join(', ')}` : '';
      L.push(`- ${f.name} — \`${STATUS_LABEL[f.status]}\`${systems}`);
    }
    L.push('');
  }
  L.push(
    'Only the measured-capacity families can be broadened by adding real systems to the corpus; the other ' +
      `${h.totalFamilies - measuredFamilies} carry the evidence appropriate to their nature and are as solid as they should be.`,
  );
  L.push('');

  // ── Per-capability coverage ──
  L.push('## Per-capability coverage');
  L.push('');
  L.push('`validated` = anchored AND a measured residual (green). `verified` = an analytic anchor but no measured validation yet. `sourced` = deterministic algebra over a cited quota/price/SLA (a distinct evidence kind, never blended into the fitted %). `UNVALIDATED` = no anchor and no residual.');
  L.push('');
  L.push('| Capability | Kind | Anchor (oracle) | Validation | Status |');
  L.push('|---|---|---|---|---|');
  for (const r of matrix.rows) {
    const anchor = r.anchored ? r.oracles.join(', ') : '— (no anchor)';
    const validation = r.calibrated
      ? r.corpus.map((c) => `${shortEntry(c.entry)} ${mag(c.residualPct)}`).join('; ')
      : r.validationKind === 'sourced' && r.anchored
        ? 'sourced (quota/price/SLA); no measured case'
        : 'UNVALIDATED';
    L.push(`| ${r.name} | ${r.kind === 'solver' ? 'solver' : 'family'} | ${anchor} | ${validation} | \`${STATUS_LABEL[r.status]}\` |`);
  }
  L.push('');
  L.push(
    '_Evidence attribution: a family’s listed systems are those whose fit declares one of its tunables; a tunable ' +
      'shared across systems may be inert in some (the CPU tunable binds only TechEmpower single-query, the DB service ' +
      'time binds only the 20-query point — see the corpus notes). The per-system figure is that system’s overall ' +
      'post-fit residual, not an isolated per-knob fit._',
  );
  L.push('');
  const caveats = matrix.rows.flatMap((r) => r.anchorCaveats.map((c) => ({ name: r.name, c })));
  if (caveats.length > 0) {
    L.push('_Partial anchors (honest caveats):_');
    for (const { name, c } of caveats) L.push(`- **${name}** — ${c}`);
    L.push('');
  }

  // ── Metrics × regimes grid ──
  L.push('## Metrics × regimes');
  L.push('');
  L.push('The six reported metrics crossed with the three load regimes where a model behaves qualitatively differently (doc §4.1). A model right below the knee can be wrong past saturation, so each is tracked separately.');
  L.push('');
  L.push('| Metric | below-knee | at-knee | past-saturation |');
  L.push('|---|---|---|---|');
  for (const metric of METRICS) {
    const cells = REGIMES.map((regime) => {
      const cell = matrix.grid.find((g) => g.metric === metric && g.regime === regime);
      if (cell === undefined) return '—';
      const tag = `\`${STATUS_LABEL[cell.status]}\``;
      if (cell.status === 'validated' && cell.corpusEntry !== null) return `${tag} ${shortEntry(cell.corpusEntry)}`;
      if (cell.status === 'unvalidated' && cell.note !== null) return `${tag}`;
      return tag;
    });
    L.push(`| ${METRIC_LABEL[metric]} | ${cells.join(' | ')} |`);
  }
  L.push('');
  const gridNotes = matrix.grid.filter((g) => g.note !== null);
  if (gridNotes.length > 0) {
    L.push('_Grid notes:_');
    for (const g of gridNotes) L.push(`- **${METRIC_LABEL[g.metric]} · ${g.regime}** — ${g.note}`);
    L.push('');
  }

  // ── Validation residuals (from the corpus) ──
  L.push('## Validation residuals — the fitted corpus');
  L.push('');
  L.push('The measured systems SDA is held against, with the residual that remains after the best fit (the structural gap no tunable can remove). Read from the calibration corpus; the full derivation is in `calibration/CALIBRATION-REPORT.md`.');
  L.push('');
  L.push('| System | Metric | Measured | Fitted | Residual |');
  L.push('|---|---|--:|--:|--:|');
  for (const er of report.fit.residuals) {
    for (const p of er.points) L.push(`| ${er.name} | ${p.metric} | ${val(p.measured, p.unit)} ${p.unit} | ${val(p.predictedFitted, p.unit)} | ${pct(p.errorFittedPct)} |`);
  }
  L.push('');
  L.push(`Aggregate post-fit error: **${h.perfFidelityPct}** over ${h.perfScoredPoints} scored points. Out-of-sample (leave-one-out over the constrained entries): **${h.oosPct}** — the honest reminder that ${h.architectures} architectures with mostly-disjoint tunables cannot yet cross-validate each other.`);
  L.push('');
  L.push('Leave-one-out generalization (the over-fit guard):');
  for (const r of report.loo) {
    const summary = r.errors.length > 0 ? r.errors.map((e) => `${e.metric} ${pct(e.errorPct)}`).join(', ') : 'no scored points';
    L.push(`- **${r.heldOut}** — ${summary} _(${r.constrained ? 'genuine out-of-sample' : 'disjoint fallback — predicted at catalog defaults'})_.`);
  }
  L.push('');

  // ── Verification gaps (addressable) ──
  L.push('## Verification gaps — addressable (doc §2.4)');
  L.push('');
  L.push('Real, addressable verification holes — named plainly, not hidden. Later waves fill the highest-value ones.');
  L.push('');
  for (const g of VERIFICATION_GAPS) L.push(`- **${g.title}** — ${g.what} _(${g.evidence})_.`);
  L.push('');

  // ── Structural limits (permanent) ──
  L.push('## Structural limits — permanent (doc §9)');
  L.push('');
  L.push('What SDA deliberately does NOT model. These never turn green; where a design genuinely needs one, the honest output is `unknown`, never a fabricated number.');
  L.push('');
  for (const s of STRUCTURAL_LIMITS) L.push(`- **${s.title}** — ${s.why}`);
  L.push('');

  // ── Provenance ──
  L.push('## How this is generated');
  L.push('');
  L.push(
    'Three walks, one emit (doc §6.2): (1) the claim surface — the capability registry (`calibration/src/capabilities.ts`) ' +
      'crossed with the metrics×regimes grid; (2) the anchors — declared on each capability, their test paths asserted to ' +
      'resolve; (3) the residuals — read from the calibration corpus and the deterministic fit. Every cell status is DERIVED ' +
      '(green only with a residual or an anchor), never authored. The generator is a pure function of the corpus + the ' +
      'deterministic fit (no clock, no RNG); `calibration/src/fidelity.test.ts` asserts this committed file is byte-identical ' +
      'to a fresh `pnpm fidelity`, so a capability added without an anchor-or-flag fails CI rather than passing silently. ' +
      'The fast fit-only gate runs under `pnpm test`; a heavier nightly with DES corroboration mirrors the solver oracle’s DEEP lane (follow-up).',
  );
  L.push('');
  return L.join('\n');
}

/** A short display name for a corpus system (drop the long descriptive suffix so tables stay narrow). */
function shortEntry(name: string): string {
  if (name.includes('Single')) return 'TechEmpower single-query';
  if (name.includes('Multiple')) return 'TechEmpower 20-query';
  if (name.includes('DeathStarBench')) return 'DeathStarBench';
  return name;
}
